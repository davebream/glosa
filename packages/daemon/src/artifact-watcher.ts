// SPDX-License-Identifier: Apache-2.0
// Shared, bounded artifact watching. Chokidar never receives a recursive workspace root: the
// canonical matcher performs the only tree walk, then each approved directory is watched at depth
// zero. One registry instance belongs to the daemon and fans events out to every SSE subscriber.
import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { watch, type ChokidarOptions, type FSWatcher } from "chokidar";
import { classifyArtifactPath, sourceSha256 } from "./artifact-render.ts";
import {
  buildWatchIgnored,
  diffSnapshots,
  loadMatcherConfig,
  resolveTrackedFiles,
  type CrossingEvent,
  type ResolveMatchedFilesResult,
} from "./matcher.ts";
import {
  workspaceBusPath,
  workspaceRegistrationId,
  workspaceTracking,
  workspaceWorktree,
  type WorkspaceTarget,
} from "./workspace.ts";

export const DEFAULT_MAX_ARTIFACT_WATCH_ENTRIES = 4_096;
const RECONCILE_DEBOUNCE_MS = 50;

type WatchMode = "directories" | "files" | "disabled";

export type ArtifactWatcherEvent =
  | {
      type: "artifact";
      data: { path: string; class: "R" | "F"; source_sha256: string };
    }
  | {
      type: "artifact_index";
      data: { changes: CrossingEvent[] };
    };

export interface ArtifactWatcherRegistryOptions {
  maxWatchEntries?: number;
  warn?: (message: string) => void;
  watchFactory?: (paths: string[], options: ChokidarOptions) => FSWatcher;
}

interface WatchState {
  workspace: WorkspaceTarget;
  id: string;
  listeners: Set<(event: ArtifactWatcherEvent) => void>;
  snapshot: ResolveMatchedFilesResult;
  watcher: FSWatcher | null;
  watchedTargets: Set<string>;
  mode: WatchMode;
  generation: number;
  pendingPaths: Set<string>;
  reconcileTimer: ReturnType<typeof setTimeout> | null;
  transitioning: boolean;
  warned: Set<string>;
}

function toRelPosixPath(root: string, absPath: string): string {
  return relative(root, absPath).split(sep).join("/").normalize("NFC");
}

function boundedTargets(workspace: WorkspaceTarget): string[] {
  const root = workspaceWorktree(workspace);
  const tracking = workspaceTracking(workspace);
  if (tracking.mode !== "bounded") return [];
  return tracking.paths.map((path) => join(root, ...path.split("/")));
}

export class ArtifactWatcherRegistry {
  private readonly states = new Map<string, WatchState>();
  private readonly maxWatchEntries: number;
  private readonly warn: (message: string) => void;
  private readonly watchFactory: (paths: string[], options: ChokidarOptions) => FSWatcher;

  constructor(options: ArtifactWatcherRegistryOptions = {}) {
    this.maxWatchEntries = options.maxWatchEntries ?? DEFAULT_MAX_ARTIFACT_WATCH_ENTRIES;
    this.warn = options.warn ?? (() => {});
    this.watchFactory = options.watchFactory ?? ((paths, watchOptions) => watch(paths, watchOptions));
  }

  subscribe(workspace: WorkspaceTarget, listener: (event: ArtifactWatcherEvent) => void): () => void {
    const id = workspaceRegistrationId(workspace);
    let state = this.states.get(id);
    if (!state) {
      state = {
        workspace,
        id,
        listeners: new Set(),
        snapshot: resolveTrackedFiles(workspace),
        watcher: null,
        watchedTargets: new Set(),
        mode: "disabled",
        generation: 0,
        pendingPaths: new Set(),
        reconcileTimer: null,
        transitioning: false,
        warned: new Set(),
      };
      state.listeners.add(listener);
      this.states.set(id, state);
      this.startWatcher(state, false);
    } else {
      state.listeners.add(listener);
    }

    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      const current = this.states.get(id);
      if (!current) return;
      current.listeners.delete(listener);
      if (current.listeners.size === 0) void this.closeState(current);
    };
  }

  /** Test/diagnostic surface: exposes only the bounded mode, never filesystem paths. */
  modeFor(workspace: WorkspaceTarget): WatchMode | null {
    return this.states.get(workspaceRegistrationId(workspace))?.mode ?? null;
  }

  async evict(workspace: WorkspaceTarget): Promise<void> {
    const state = this.findState(workspace);
    if (state) await this.closeState(state);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.states.values()].map((state) => this.closeState(state)));
  }

  private findState(workspace: WorkspaceTarget): WatchState | undefined {
    return this.states.get(workspaceRegistrationId(workspace));
  }

  private warnOnce(state: WatchState, code: string, message: string): void {
    if (state.warned.has(code)) return;
    state.warned.add(code);
    this.warn(`artifact watcher ${state.id}: ${message}`);
  }

  private chooseMode(state: WatchState, forceFiles: boolean): { mode: WatchMode; targets: string[] } {
    const tracking = workspaceTracking(state.workspace);
    if (tracking.mode === "bounded") {
      const targets = boundedTargets(state.workspace);
      if (targets.length > this.maxWatchEntries) return { mode: "disabled", targets: [] };
      return { mode: "files", targets };
    }

    const fileTargets = state.snapshot.tracked.map((file) => file.rawPath);
    const estimatedEntries = state.snapshot.directories.length + fileTargets.length;
    if (!forceFiles && estimatedEntries <= this.maxWatchEntries) {
      return { mode: "directories", targets: state.snapshot.directories.map((directory) => directory.rawPath) };
    }
    if (fileTargets.length <= this.maxWatchEntries) return { mode: "files", targets: fileTargets };
    return { mode: "disabled", targets: [] };
  }

  private startWatcher(state: WatchState, forceFiles: boolean): void {
    const selected = this.chooseMode(state, forceFiles);
    state.mode = selected.mode;
    state.watchedTargets = new Set(selected.targets);

    if (selected.mode === "disabled") {
      this.warnOnce(
        state,
        "disabled",
        `live updates disabled because ${state.snapshot.tracked.length} tracked artifacts exceed the ${this.maxWatchEntries}-entry safety budget`,
      );
      return;
    }

    if (
      selected.mode === "files" &&
      workspaceTracking(state.workspace).mode === "matcher" &&
      state.snapshot.directories.length + state.snapshot.tracked.length > this.maxWatchEntries
    ) {
      this.warnOnce(
        state,
        "file-fallback",
        `new-artifact discovery disabled because the safe directory scope exceeds the ${this.maxWatchEntries}-entry safety budget`,
      );
    }

    const root = workspaceWorktree(state.workspace);
    const generation = ++state.generation;
    const watcher = this.watchFactory(selected.targets, {
      ignoreInitial: true,
      followSymlinks: false,
      ...(selected.mode === "directories"
        ? {
            depth: 0,
            ignored: buildWatchIgnored(root, loadMatcherConfig(root, workspaceBusPath(state.workspace))),
          }
        : {}),
    });
    state.watcher = watcher;

    const onFsEvent = (absPath: string) => {
      if (state.generation !== generation || state.mode === "disabled") return;
      state.pendingPaths.add(toRelPosixPath(root, absPath));
      this.scheduleReconcile(state);
    };
    watcher
      .on("add", onFsEvent)
      .on("change", onFsEvent)
      .on("unlink", onFsEvent)
      .on("addDir", onFsEvent)
      .on("unlinkDir", onFsEvent)
      .on("error", () => {
        if (state.generation === generation) void this.handleWatcherError(state);
      });
  }

  private scheduleReconcile(state: WatchState): void {
    if (state.reconcileTimer) return;
    state.reconcileTimer = setTimeout(() => {
      state.reconcileTimer = null;
      void this.reconcile(state);
    }, RECONCILE_DEBOUNCE_MS);
    state.reconcileTimer.unref?.();
  }

  private async reconcile(state: WatchState): Promise<void> {
    if (!this.states.has(state.id) || state.transitioning) return;
    const changedPaths = new Set(state.pendingPaths);
    state.pendingPaths.clear();

    const previous = state.snapshot;
    const next = resolveTrackedFiles(state.workspace);
    const crossings = diffSnapshots(previous, next);
    state.snapshot = next;

    if (state.mode === "directories") {
      const estimatedEntries = next.directories.length + next.tracked.length;
      if (estimatedEntries > this.maxWatchEntries) {
        await this.replaceWatcher(state, true);
      } else {
        const nextTargets = new Set(next.directories.map((directory) => directory.rawPath));
        const additions = [...nextTargets].filter((path) => !state.watchedTargets.has(path));
        const removals = [...state.watchedTargets].filter((path) => !nextTargets.has(path));
        if (additions.length > 0) state.watcher?.add(additions);
        if (removals.length > 0) await state.watcher?.unwatch(removals);
        state.watchedTargets = nextTargets;
      }
    }

    const pathsLeavingScope = crossings
      .filter((crossing) => crossing.type === "file_untracked")
      .map((crossing) => previous.tracked.find((file) => file.path === crossing.path)?.rawPath)
      .filter((path): path is string => path !== undefined);
    if (pathsLeavingScope.length > 0) {
      await state.watcher?.unwatch(pathsLeavingScope);
      for (const path of pathsLeavingScope) state.watchedTargets.delete(path);
    }

    if (crossings.length > 0) {
      this.notify(state, { type: "artifact_index", data: { changes: crossings } });
      for (const crossing of crossings) {
        if (crossing.type === "file_tracked") changedPaths.add(crossing.path);
      }
    }

    for (const file of next.tracked) {
      if (!changedPaths.has(file.path)) continue;
      try {
        this.notify(state, {
          type: "artifact",
          data: {
            path: file.path,
            class: classifyArtifactPath(file.path),
            source_sha256: sourceSha256(readFileSync(file.rawPath)),
          },
        });
      } catch {
        // Raced with another atomic save/unlink. The next filesystem event or reconnect snapshot
        // re-establishes truth; this advisory live notification is safe to omit.
      }
    }
  }

  private async handleWatcherError(state: WatchState): Promise<void> {
    if (state.transitioning || !this.states.has(state.id)) return;
    this.warnOnce(state, "watch-error", "filesystem watch failed; downgrading live-update scope");
    if (state.mode === "directories") await this.replaceWatcher(state, true);
    else await this.replaceWatcher(state, false, true);
  }

  private async replaceWatcher(state: WatchState, forceFiles: boolean, forceDisabled = false): Promise<void> {
    if (state.transitioning) return;
    state.transitioning = true;
    const previous = state.watcher;
    state.watcher = null;
    state.generation += 1;
    if (previous) await previous.close().catch(() => {});
    state.watchedTargets.clear();
    state.mode = "disabled";
    state.transitioning = false;
    if (!this.states.has(state.id) || state.listeners.size === 0 || forceDisabled) {
      return;
    }
    this.startWatcher(state, forceFiles);
  }

  private notify(state: WatchState, event: ArtifactWatcherEvent): void {
    for (const listener of state.listeners) {
      try {
        listener(event);
      } catch {
        // One stale browser subscriber must not break delivery to the others.
      }
    }
  }

  private async closeState(state: WatchState): Promise<void> {
    if (this.states.get(state.id) !== state) return;
    this.states.delete(state.id);
    if (state.reconcileTimer) clearTimeout(state.reconcileTimer);
    state.reconcileTimer = null;
    state.pendingPaths.clear();
    state.listeners.clear();
    state.generation += 1;
    const watcher = state.watcher;
    state.watcher = null;
    state.mode = "disabled";
    if (watcher) await watcher.close().catch(() => {});
  }
}

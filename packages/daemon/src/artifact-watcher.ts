// SPDX-License-Identifier: Apache-2.0
// Shared, bounded artifact watching. Chokidar never receives a recursive workspace root: the
// canonical matcher performs the only tree walk, then each approved directory is watched at depth
// zero. One registry instance belongs to the daemon and fans events out to every SSE subscriber.
//
// DAEMON-LIFETIME, NOT SUBSCRIPTION-SCOPED (#153). A watcher used to exist only while
// `GET /w/:slug/stream` had a listener, which was right when its only job was pushing live
// artifact events at an open browser tab. It now also produces `external_edit` entries, and #153's
// headline workflow is an external editor plus an agent with NO glosa tab open — so a producer
// that needs a browser attached would never fire for the case it exists to serve. `ensureWatched`
// therefore starts a listener-less watcher for a registered workspace, and only a subscription-
// created state is torn down when its last listener leaves.
//
// That decoupling creates a new unbounded axis, and it is a DIFFERENT one from the pre-existing
// cap: `DEFAULT_MAX_ARTIFACT_WATCH_ENTRIES` bounds `targets.length` inside ONE `WatchState` and
// aggregates nothing across workspaces. Browser-scoped watching was bounded by how many tabs were
// open; daemon-lifetime watching makes the WATCHER COUNT scale with how many workspaces are
// registered. `DEFAULT_MAX_WATCHED_WORKSPACES` below bounds that axis, with its own constant, its
// own warning, and its own downgrade.
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

/** Per-workspace path budget: how many entries ONE `WatchState` may hand chokidar. Says nothing
 * about how many workspaces are watched — see `DEFAULT_MAX_WATCHED_WORKSPACES`. */
export const DEFAULT_MAX_ARTIFACT_WATCH_ENTRIES = 4_096;

/** Cross-workspace budget: how many live watchers may exist at once, across every workspace.
 *
 * A separate claim from the per-workspace cap above, and it has to be: that one is a ceiling on
 * paths WITHIN a state, so N workspaces could each sit under it while together holding N × 4096
 * watch entries. While watching was scoped to an SSE subscription, open browser tabs were the de
 * facto bound; daemon-lifetime watching removes that, so the count needs a stated ceiling of its
 * own. #151's stream budget cannot supply one — it is not code yet, and after this change watching
 * is decoupled from streams by definition.
 *
 * 64 is chosen against the topology glosa targets: one person's machine, a handful of writing
 * workspaces open at once. A daemon holding more than 64 registered workspaces is far outside it,
 * and the honest failure there is degraded live updates rather than a daemon that exhausts file
 * descriptors and takes every workspace down with it.
 *
 * DOWNGRADE: past the ceiling a workspace simply gets no watcher — no live artifact SSE events and
 * no live `external_edit` capture. Its drift is not lost, only late: the next reconcile's offline
 * catch-up still commits it and step 5b still reports it. One warning names the constant. */
export const DEFAULT_MAX_WATCHED_WORKSPACES = 64;

const RECONCILE_DEBOUNCE_MS = 50;

/** How long a tracked artifact must go untouched before its change is captured as one
 * `external_edit` (#153's settled 2 seconds).
 *
 * Emphatically NOT `RECONCILE_DEBOUNCE_MS`, which answers a different question: 50 ms is long
 * enough to stop re-walking the matcher once per filesystem event, i.e. "which files match now".
 * This one answers "has the person stopped saving", and has to absorb two things at once — an
 * atomic save's own churn (write a temp file, rename over the target, milliseconds apart, which
 * chokidar reports as several events for one logical save) and an editor's autosave cadence, where
 * a typing burst produces a save every second or so. Two seconds of quiet covers both; one entry
 * per burst is what "a Typora save produces ONE coalesced external_edit" means. */
export const EXTERNAL_EDIT_QUIET_WINDOW_MS = 2_000;

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
  maxWatchedWorkspaces?: number;
  warn?: (message: string) => void;
  watchFactory?: (paths: string[], options: ChokidarOptions) => FSWatcher;
  /** The quiet-window capture (#153). Injected rather than imported so this module keeps knowing
   * nothing about `WorkspaceBus` or shadow git — it reports that a workspace went quiet after a
   * change and lets the composition root decide what that means. Absent (its default) leaves the
   * watcher a pure chokidar→SSE fan-out, which is what every pre-#153 test expects. */
  captureExternalEdit?: (workspace: WorkspaceTarget) => Promise<unknown>;
  quietWindowMs?: number;
}

interface WatchState {
  workspace: WorkspaceTarget;
  id: string;
  listeners: Set<(event: ArtifactWatcherEvent) => void>;
  /** Started by `ensureWatched` for a registered workspace rather than by an SSE subscription, so
   * the last listener leaving must NOT tear it down — that is the whole point of #153's amendment. */
  daemonLifetime: boolean;
  snapshot: ResolveMatchedFilesResult;
  watcher: FSWatcher | null;
  watchedTargets: Set<string>;
  mode: WatchMode;
  generation: number;
  pendingPaths: Set<string>;
  reconcileTimer: ReturnType<typeof setTimeout> | null;
  /** The 2-second `external_edit` window. Its OWN field, and `closeState` must clear it: eviction
   * is already wired into `onHardRemove` and `sealAdoptionSources` (`lifecycle/daemon.ts`), and a
   * timer with no cancellation path would fire against a hard-removed or sealed workspace after
   * its watcher is gone. */
  quietWindowTimer: ReturnType<typeof setTimeout> | null;
  capturing: boolean;
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
  private readonly maxWatchedWorkspaces: number;
  private readonly warn: (message: string) => void;
  private readonly watchFactory: (paths: string[], options: ChokidarOptions) => FSWatcher;
  private readonly captureExternalEdit?: (workspace: WorkspaceTarget) => Promise<unknown>;
  private readonly quietWindowMs: number;
  private budgetWarned = false;

  constructor(options: ArtifactWatcherRegistryOptions = {}) {
    this.maxWatchEntries = options.maxWatchEntries ?? DEFAULT_MAX_ARTIFACT_WATCH_ENTRIES;
    this.maxWatchedWorkspaces = options.maxWatchedWorkspaces ?? DEFAULT_MAX_WATCHED_WORKSPACES;
    this.warn = options.warn ?? (() => {});
    this.watchFactory = options.watchFactory ?? ((paths, watchOptions) => watch(paths, watchOptions));
    this.captureExternalEdit = options.captureExternalEdit;
    this.quietWindowMs = options.quietWindowMs ?? EXTERNAL_EDIT_QUIET_WINDOW_MS;
  }

  /** Starts a daemon-lifetime watcher for a registered workspace, with no subscriber and no
   * browser involved (#153). Idempotent: an existing state — however it was created — is promoted
   * to daemon-lifetime and reused, so a session heartbeat's repeated registration costs one map
   * lookup rather than a fresh matcher walk. */
  ensureWatched(workspace: WorkspaceTarget): void {
    const id = workspaceRegistrationId(workspace);
    const existing = this.states.get(id);
    if (existing) {
      existing.daemonLifetime = true;
      return;
    }
    const state = this.openState(workspace, id, true);
    if (state) this.startWatcher(state, false);
  }

  subscribe(workspace: WorkspaceTarget, listener: (event: ArtifactWatcherEvent) => void): () => void {
    const id = workspaceRegistrationId(workspace);
    let state = this.states.get(id);
    if (!state) {
      // Subject to the same cross-workspace ceiling as `ensureWatched`: a bound that any caller
      // could step around would not be a bound. Refused here means this stream serves journal
      // events without live artifact pushes, which is the same degradation `mode: "disabled"`
      // already produces for a workspace over the per-workspace path budget.
      const opened = this.openState(workspace, id, false);
      if (!opened) return () => {};
      state = opened;
      state.listeners.add(listener);
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
      if (current.listeners.size === 0 && !current.daemonLifetime) void this.closeState(current);
    };
  }

  private openState(workspace: WorkspaceTarget, id: string, daemonLifetime: boolean): WatchState | null {
    if (this.states.size >= this.maxWatchedWorkspaces) {
      if (!this.budgetWarned) {
        this.budgetWarned = true;
        this.warn(
          `artifact watcher: not watching ${id} — ${this.states.size} workspaces are already watched, the ` +
            `${this.maxWatchedWorkspaces}-workspace safety budget. Live updates and live external-edit capture are ` +
            `off for further workspaces; their changes are still captured by offline catch-up on the next reconcile`,
        );
      }
      return null;
    }
    const state: WatchState = {
      workspace,
      id,
      listeners: new Set(),
      daemonLifetime,
      snapshot: resolveTrackedFiles(workspace),
      watcher: null,
      watchedTargets: new Set(),
      mode: "disabled",
      generation: 0,
      pendingPaths: new Set(),
      reconcileTimer: null,
      quietWindowTimer: null,
      capturing: false,
      transitioning: false,
      warned: new Set(),
    };
    this.states.set(id, state);
    return state;
  }

  /** Test/diagnostic surface: exposes only the bounded mode, never filesystem paths. */
  modeFor(workspace: WorkspaceTarget): WatchMode | null {
    return this.states.get(workspaceRegistrationId(workspace))?.mode ?? null;
  }

  /** Live watchers across every workspace — the quantity `DEFAULT_MAX_WATCHED_WORKSPACES` bounds.
   * Deliberately NOT watch entries within one workspace, which is the other cap's business. */
  watchedWorkspaceCount(): number {
    return this.states.size;
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

  /** TRAILING debounce that RESTARTS on every change, unlike `scheduleReconcile` above, which
   * keeps the first timer it set. The difference is deliberate and is what "coalesced" means here:
   * the matcher rescan wants to run promptly and at most every 50 ms, whereas this must not fire
   * until the saving has actually stopped. Three saves a few hundred milliseconds apart restart
   * the window twice and produce ONE capture; a first-timer-wins debounce would fire mid-burst and
   * produce two entries for one editing session. */
  private scheduleQuietWindow(state: WatchState): void {
    if (!this.captureExternalEdit) return;
    if (state.quietWindowTimer) clearTimeout(state.quietWindowTimer);
    state.quietWindowTimer = setTimeout(() => {
      state.quietWindowTimer = null;
      void this.runQuietWindowCapture(state);
    }, this.quietWindowMs);
    state.quietWindowTimer.unref?.();
  }

  private async runQuietWindowCapture(state: WatchState): Promise<void> {
    // Evicted between the last change and the timer firing (`glosa forget`, adoption sealing, GC
    // hard-remove) — the capture must not write to a workspace this registry no longer holds. The
    // bus refuses a sealed one on its own (`assertWritable`); this is the earlier, cheaper check.
    if (this.states.get(state.id) !== state || !this.captureExternalEdit) return;
    if (state.capturing) return; // one capture at a time per workspace; the next change reschedules
    state.capturing = true;
    try {
      await this.captureExternalEdit(state.workspace);
    } catch (error) {
      // A sealed/forgotten workspace, a broken git toolchain, a permission problem. Live capture
      // is best-effort by design: the drift is still on disk, and reconcile's offline catch-up
      // plus its step-5b scan report it on the next start. Never destabilize the singleton daemon.
      this.warnOnce(state, "capture-failed", `external-edit capture failed: ${String(error)}`);
    } finally {
      state.capturing = false;
    }
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

    let trackedChanged = false;
    for (const file of next.tracked) {
      if (!changedPaths.has(file.path)) continue;
      trackedChanged = true;
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

    // A crossing counts as a change even with no tracked path in `changedPaths`: a DELETED
    // artifact leaves the tracked list entirely, so the loop above can never see it, and a
    // deletion is drift the checkpoint stages (via `trackedUnion`) and must report. The window is
    // (re)started from here rather than from the raw filesystem event so it is keyed to real
    // tracked-artifact changes, never to churn under an ignored directory.
    if (trackedChanged || crossings.length > 0) this.scheduleQuietWindow(state);
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
    // A daemon-lifetime state legitimately has no listeners and must still be rebuilt after a
    // downgrade — otherwise the first watcher error would silently retire live external-edit
    // capture for every workspace with no browser attached, which is most of them.
    if (!this.states.has(state.id) || (state.listeners.size === 0 && !state.daemonLifetime) || forceDisabled) {
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
    // The quiet-window timer needs its own cancellation, not just its own field: eviction is wired
    // into `onHardRemove` and `sealAdoptionSources` (`lifecycle/daemon.ts`), and a surviving timer
    // would fire a shadow-git commit and an inbox write against a workspace that has just been
    // hard-removed from the index or sealed for adoption/forget.
    if (state.quietWindowTimer) clearTimeout(state.quietWindowTimer);
    state.quietWindowTimer = null;
    state.daemonLifetime = false;
    state.pendingPaths.clear();
    state.listeners.clear();
    state.generation += 1;
    const watcher = state.watcher;
    state.watcher = null;
    state.mode = "disabled";
    if (watcher) await watcher.close().catch(() => {});
  }
}

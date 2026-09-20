// SPDX-License-Identifier: Apache-2.0
// Shared, bounded artifact watching. A directory workspace is watched with ONE native recursive
// `fs.watch` on its root (FSEvents on macOS), and every event is filtered through the canonical
// matcher before it can cost anything; a loose-file workspace watches only its files' directories.
// The canonical matcher still performs the only tree walk. One registry instance belongs to the
// daemon and fans events out to every SSE subscriber.
//
// WHY NOT CHOKIDAR (#91, and the restart failure fixed alongside this). chokidar opens one
// `fs.watch` per watched FILE, even at depth zero, and Bun's per-file `fs.watch` on macOS gets
// slower faster than the watch count grows: 1,600 watches took 26.5 s to open and 10.7 s to close,
// with the event loop blocked throughout (Node: 31 ms / 3 ms). A daemon warming up 8 workspaces of
// 300 files did not answer its handshake for about 80 s. A recursive watch is one kernel stream per
// root however large the tree: 70 roots over 21,000 files opened in 59 ms and closed in 45 ms, and
// 20,000 writes churning `node_modules` under one cost 16 MB and at most 84 ms of loop time. What
// #91 forbade was chokidar walking a recursive root and opening a watch per file inside it; this
// opens none, and excluded subtrees are dropped by path before any work is scheduled.
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
import { existsSync, type FSWatcher, lstatSync, readFileSync, type Stats, watch } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
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

/** Per-workspace budget on TRACKED ARTIFACTS: how many files the matcher walk may resolve for one
 * live watcher. Every relevant change re-runs that walk, so this bounds the work a change costs,
 * not a number of filesystem watches — a recursive watch is one handle however many files it
 * covers. Past it, the workspace gets no live updates and its changes are captured by offline
 * catch-up. Says nothing about how many workspaces are watched — see
 * `DEFAULT_MAX_WATCHED_WORKSPACES`.
 *
 * There used to be a third bound, 8,192 watch entries summed across every workspace, because each
 * chokidar entry was a real per-file watch and 64 workspaces x 4,096 of them exhausted a machine's
 * memory in alpha.19. With one watch per workspace that sum no longer measures anything a machine
 * runs out of, and it was refusing live updates to small workspaces by warm-up order (#219). */
export const DEFAULT_MAX_TRACKED_ARTIFACTS = 4_096;

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
 * the filesystem reports as several events for one logical save) and an editor's autosave cadence, where
 * a typing burst produces a save every second or so. Two seconds of quiet covers both; one entry
 * per burst is what "a Typora save produces ONE coalesced external_edit" means. */
export const EXTERNAL_EDIT_QUIET_WINDOW_MS = 2_000;

/** `tree`: one recursive watch on a directory workspace's root. `files`: a bounded (loose-file)
 * workspace, watched through its files' parent directories. */
type WatchMode = "tree" | "files" | "disabled";

/** One live filesystem watch for one workspace, as the registry sees it. */
export interface WorkspaceWatch {
  close(): void;
}

export interface WorkspaceWatchRequest {
  mode: "tree" | "files";
  /** The workspace work-tree root. `tree` watches it recursively. */
  root: string;
  /** `files` only: the exact files to report; their parent directories are what is watched. */
  files: string[];
  /** An absolute path that may have changed. Advisory: the registry re-resolves from disk. */
  onChange(absPath: string): void;
  onError(error: unknown): void;
}

export type WorkspaceWatchFactory = (request: WorkspaceWatchRequest) => WorkspaceWatch;

/** The production watch: Bun's native `fs.watch`.
 *
 * Bun delivers a recursive watcher the events of any OTHER watched root whose path merely starts
 * with the same characters — the watcher on `…/notes` also receives `…/notes2/a.md` as `2/a.md`
 * (Bun 1.4.2; a trailing slash does not help). Such an event is recognisable: the path does not
 * exist under this root but does exist when appended to it as a string. It is dropped. A deleted
 * file in the sibling cannot be told apart that way and passes through, which costs one rescan
 * that finds nothing. */
export function nativeWorkspaceWatch(request: WorkspaceWatchRequest): WorkspaceWatch {
  const watchers: FSWatcher[] = [];
  const close = () => {
    for (const watcher of watchers.splice(0)) {
      try {
        watcher.close();
      } catch {
        // already closed
      }
    }
  };
  try {
    if (request.mode === "tree") {
      const root = request.root;
      const watcher = watch(root, { recursive: true }, (_event, filename) => {
        if (filename === null || filename === undefined) return request.onChange(root);
        const rel = String(filename);
        const absPath = join(root, rel);
        if (!existsSync(absPath) && existsSync(root + rel)) return;
        request.onChange(absPath);
      });
      watcher.on("error", (error) => request.onError(error));
      watchers.push(watcher);
    } else {
      const targets = new Set(request.files);
      for (const directory of new Set(request.files.map((file) => dirname(file)))) {
        const watcher = watch(directory, (_event, filename) => {
          if (filename === null || filename === undefined) {
            for (const file of targets) if (dirname(file) === directory) request.onChange(file);
            return;
          }
          const absPath = join(directory, String(filename));
          if (targets.has(absPath)) request.onChange(absPath);
        });
        watcher.on("error", (error) => request.onError(error));
        watchers.push(watcher);
      }
    }
  } catch (error) {
    close();
    throw error;
  }
  return { close };
}

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
  maxTrackedArtifacts?: number;
  maxWatchedWorkspaces?: number;
  warn?: (message: string) => void;
  watchFactory?: WorkspaceWatchFactory;
  /** The quiet-window capture (#153). Injected rather than imported so this module keeps knowing
   * nothing about `WorkspaceBus` or shadow git — it reports that a workspace went quiet after a
   * change and lets the composition root decide what that means. Absent (its default) leaves the
   * watcher a pure filesystem→SSE fan-out, which is what every pre-#153 test expects. */
  captureExternalEdit?: (workspace: WorkspaceTarget) => Promise<unknown>;
  quietWindowMs?: number;
  /** Complete initial walks may be asynchronous in production so registration never blocks the
   * daemon event loop. Tests may omit this to retain immediate deterministic setup. */
  initialResolveTrackedFiles?: (
    workspace: WorkspaceTarget,
    options: { limit: number },
  ) => ResolveMatchedFilesResult | Promise<ResolveMatchedFilesResult>;
}

interface WatchState {
  workspace: WorkspaceTarget;
  id: string;
  listeners: Set<(event: ArtifactWatcherEvent) => void>;
  /** Started by `ensureWatched` for a registered workspace rather than by an SSE subscription, so
   * the last listener leaving must NOT tear it down — that is the whole point of #153's amendment. */
  daemonLifetime: boolean;
  snapshot: ResolveMatchedFilesResult;
  watcher: WorkspaceWatch | null;
  mode: WatchMode;
  /** Path-only matcher filter for `tree` events: excluded subtrees and files the matcher would
   * never track are dropped before they schedule a walk. */
  ignored: ((absPath: string) => boolean) | null;
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
  /** Matcher walks run for filesystem events; see `reconcileCount`. */
  reconciles: number;
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
  private readonly maxTrackedArtifacts: number;
  private readonly maxWatchedWorkspaces: number;
  private readonly warn: (message: string) => void;
  private readonly watchFactory: WorkspaceWatchFactory;
  private readonly captureExternalEdit?: (workspace: WorkspaceTarget) => Promise<unknown>;
  private readonly quietWindowMs: number;
  private readonly initialResolveTrackedFiles: NonNullable<
    ArtifactWatcherRegistryOptions["initialResolveTrackedFiles"]
  >;
  private budgetWarned = false;

  constructor(options: ArtifactWatcherRegistryOptions = {}) {
    this.maxTrackedArtifacts = options.maxTrackedArtifacts ?? DEFAULT_MAX_TRACKED_ARTIFACTS;
    this.maxWatchedWorkspaces = options.maxWatchedWorkspaces ?? DEFAULT_MAX_WATCHED_WORKSPACES;
    this.warn = options.warn ?? (() => {});
    this.watchFactory = options.watchFactory ?? nativeWorkspaceWatch;
    this.captureExternalEdit = options.captureExternalEdit;
    this.quietWindowMs = options.quietWindowMs ?? EXTERNAL_EDIT_QUIET_WINDOW_MS;
    this.initialResolveTrackedFiles = options.initialResolveTrackedFiles ?? resolveTrackedFiles;
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
    if (state) this.initializeState(state);
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
      this.initializeState(state);
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
      snapshot: { tracked: [], oversize: [], directories: [], skippedSymlinks: [], truncated: false },
      watcher: null,
      mode: "disabled",
      ignored: null,
      generation: 0,
      pendingPaths: new Set(),
      reconcileTimer: null,
      quietWindowTimer: null,
      capturing: false,
      transitioning: false,
      reconciles: 0,
      warned: new Set(),
    };
    this.states.set(id, state);
    return state;
  }

  private initializeState(state: WatchState): void {
    let result: ResolveMatchedFilesResult | Promise<ResolveMatchedFilesResult>;
    try {
      result = this.initialResolveTrackedFiles(state.workspace, { limit: this.maxTrackedArtifacts });
    } catch (error) {
      this.warnOnce(state, "initial-scan-failed", `initial matcher scan failed: ${String(error)}`);
      return;
    }

    if (!(result instanceof Promise)) {
      state.snapshot = result;
      this.startWatcher(state);
      return;
    }

    void result.then(
      (snapshot) => {
        if (this.states.get(state.id) !== state) return;
        state.snapshot = snapshot;
        this.startWatcher(state);
      },
      (error) => {
        if (this.states.get(state.id) !== state) return;
        this.warnOnce(state, "initial-scan-failed", `initial matcher scan failed: ${String(error)}`);
      },
    );
  }

  /** Test/diagnostic surface: exposes only the bounded mode, never filesystem paths. */
  modeFor(workspace: WorkspaceTarget): WatchMode | null {
    return this.states.get(workspaceRegistrationId(workspace))?.mode ?? null;
  }

  /** Test/diagnostic surface: how many matcher walks filesystem events have cost this workspace.
   * The filter in front of them is otherwise unobservable — an excluded change that did reach a
   * walk would still produce no artifact event, only the walk. */
  reconcileCount(workspace: WorkspaceTarget): number {
    return this.states.get(workspaceRegistrationId(workspace))?.reconciles ?? 0;
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

  /** Retires every watch state for a process that is about to exit, WITHOUT closing the
   * filesystem watches themselves: timers, listeners and pending paths are dropped and every
   * state stops reacting, but no `watcher.close()` runs. The kernel releases the handles when the
   * process ends.
   *
   * Closing them is what made a daemon restart fail. Bun's per-file `fs.watch` on macOS closes
   * synchronously and its cost grows faster than the watch count (1,600 watches took 10.7 s to
   * close in one blocking stretch; Node took 3 ms). chokidar holds one per watched file, so a
   * daemon near the watch-entry budget sat in `closeAll()` for 30 s or more, holding its lock
   * with its event loop frozen: neither the drain deadline nor the hard-exit timer could fire,
   * and the client replacing it gave up after 5 s. Only for exit: a live daemon that stops
   * watching one workspace still closes it, or it would leak the handles. */
  abandonAll(): void {
    for (const state of [...this.states.values()]) this.detachState(state);
  }

  private findState(workspace: WorkspaceTarget): WatchState | undefined {
    return this.states.get(workspaceRegistrationId(workspace));
  }

  private warnOnce(state: WatchState, code: string, message: string): void {
    if (state.warned.has(code)) return;
    state.warned.add(code);
    this.warn(`artifact watcher ${state.id}: ${message}`);
  }

  private chooseMode(state: WatchState): WatchMode {
    const tracking = workspaceTracking(state.workspace);
    if (tracking.mode === "bounded") {
      return boundedTargets(state.workspace).length > this.maxTrackedArtifacts ? "disabled" : "files";
    }
    // A truncated snapshot is a prefix, not a tree: the walk stopped because the workspace is
    // already past the per-workspace ceiling. That is exactly the answer `disabled` encodes, and
    // deciding it here is what keeps the walk from having to finish to find out.
    return state.snapshot.truncated ? "disabled" : "tree";
  }

  private startWatcher(state: WatchState): void {
    const mode = this.chooseMode(state);
    state.mode = mode;
    if (mode === "disabled") {
      this.warnOnce(
        state,
        "disabled",
        `live updates disabled because the workspace has more than ${this.maxTrackedArtifacts} tracked artifacts, the per-workspace safety budget`,
      );
      return;
    }

    const root = workspaceWorktree(state.workspace);
    const generation = ++state.generation;
    if (mode === "tree") {
      const matches = buildWatchIgnored(root, loadMatcherConfig(root, workspaceBusPath(state.workspace)), {
        ignoreOversize: false,
      });
      state.ignored = (absPath) => {
        let stats: Stats | undefined;
        try {
          stats = lstatSync(absPath);
        } catch {
          // Gone: a deletion, or a directory removed with its contents. Only the path can decide.
        }
        return matches(absPath, stats);
      };
    } else {
      state.ignored = null;
    }

    const onChange = (absPath: string) => {
      if (state.generation !== generation || state.mode === "disabled") return;
      if (state.ignored?.(absPath)) return;
      state.pendingPaths.add(toRelPosixPath(root, absPath));
      this.scheduleReconcile(state);
    };
    const onError = () => {
      if (state.generation === generation) this.handleWatcherError(state);
    };
    try {
      state.watcher = this.watchFactory({ mode, root, files: boundedTargets(state.workspace), onChange, onError });
    } catch {
      state.watcher = null;
      this.handleWatcherError(state);
    }
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
    state.reconciles += 1;

    const previous = state.snapshot;
    const next = resolveTrackedFiles(state.workspace, { limit: this.maxTrackedArtifacts });
    const crossings = diffSnapshots(previous, next);
    state.snapshot = next;

    // Grown past the per-workspace budget since the watch started: stop paying a truncated walk for
    // every change. The crossings this reconcile found are still delivered below.
    if (state.mode === "tree" && next.truncated) this.retireWatcher(state, "disabled");

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

  /** A watch that reports an error is closed and restarted once; a second error leaves the
   * workspace without live updates (offline catch-up still captures its changes). */
  private handleWatcherError(state: WatchState): void {
    if (!this.states.has(state.id) || state.transitioning) return;
    const firstError = !state.warned.has("watch-error");
    this.warnOnce(state, "watch-error", "filesystem watch failed; restarting it once");
    this.retireWatcher(state, "disabled");
    if (!firstError) return;
    // A daemon-lifetime state legitimately has no listeners and must still be rebuilt — otherwise
    // the first watcher error would silently retire live external-edit capture for every workspace
    // with no browser attached, which is most of them.
    if (state.listeners.size === 0 && !state.daemonLifetime) return;
    this.startWatcher(state);
  }

  private retireWatcher(state: WatchState, mode: WatchMode): void {
    state.transitioning = true;
    const previous = state.watcher;
    state.watcher = null;
    state.generation += 1;
    state.mode = mode;
    try {
      previous?.close();
    } catch {
      // already closed
    }
    state.transitioning = false;
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
    try {
      this.detachState(state)?.close();
    } catch {
      // already closed
    }
  }

  /** Everything `closeState` does except closing the watch: returns the watcher so the caller
   * decides whether to close it (see `abandonAll`). Null when the state was already retired. */
  private detachState(state: WatchState): WorkspaceWatch | null {
    if (this.states.get(state.id) !== state) return null;
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
    return watcher;
  }
}

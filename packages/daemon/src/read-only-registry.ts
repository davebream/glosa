// SPDX-License-Identifier: Apache-2.0
// Desk-lifetime metadata and invalidations, independent of document watching/capture.
import { existsSync, watch, type FSWatcher } from "node:fs";
import { assertInstallUnchanged } from "./lifecycle/install-guard.ts";
import { buildMatcherPredicates, loadMatcherConfig } from "./matcher.ts";
import { ReadOnlyError, type ReadOnlyListing } from "./read-only-files.ts";
import { workspaceBusPath, workspaceRegistrationId, workspaceWorktree, type WorkspaceTarget } from "./workspace.ts";
type State = {
  listeners: Set<() => void>;
  watcher?: FSWatcher;
  configWatcher?: FSWatcher;
  warning?: string;
  timer?: ReturnType<typeof setTimeout>;
  scans: Map<boolean, Promise<ReadOnlyListing>>;
  pending: Map<boolean, Promise<ReadOnlyListing>>;
  epoch: number;
  abort: AbortController;
  touched: number;
  freshUntil: number;
};
export class ReadOnlyRegistry {
  private readonly states = new Map<string, State>();
  private state(workspace: WorkspaceTarget) {
    const key = workspaceRegistrationId(workspace);
    let state = this.states.get(key);
    if (!state) {
      // Bound unobserved HTTP caches; live desks retain their own state until disconnect.
      for (const [id, candidate] of this.states)
        if (!candidate.listeners.size && !candidate.pending.size && Date.now() - candidate.touched > 1000) {
          candidate.abort.abort();
          this.states.delete(id);
        }
      if (this.states.size >= 64) throw new ReadOnlyError(503, "Too many folders are open. Close one and retry.");
      state = {
        listeners: new Set(),
        scans: new Map(),
        pending: new Map(),
        epoch: 0,
        abort: new AbortController(),
        touched: Date.now(),
        freshUntil: 0,
      };
      this.states.set(key, state);
    }
    return state;
  }
  invalidate(workspace: WorkspaceTarget) {
    const state = this.states.get(workspaceRegistrationId(workspace));
    if (!state) return;
    state.scans.clear();
    state.epoch++;
    for (const listener of state.listeners) {
      try {
        listener();
      } catch {
        /* isolate disconnected observers */
      }
    }
  }
  async list(workspace: WorkspaceTarget, showIgnored: boolean): Promise<ReadOnlyListing> {
    const state = this.state(workspace);
    // Refresh on HTTP reads too: watcher delivery is best effort, never an authorization source.
    if (Date.now() > state.freshUntil) state.scans.clear();
    state.touched = Date.now();
    let result = state.pending.get(showIgnored) ?? state.scans.get(showIgnored);
    if (!result) {
      const epoch = state.epoch;
      state.freshUntil = Date.now() + 1000;
      result = this.scan(workspace, showIgnored, state.abort.signal);
      state.pending.set(showIgnored, result);
      void result.then(
        () => {
          state.pending.delete(showIgnored);
          if (state.epoch === epoch) state.scans.set(showIgnored, result!);
          // An event can arrive while every desk is awaiting this same in-flight scan.
          // Notify once more after it settles, so that the last change cannot be missed.
          else if (state.listeners.size) queueMicrotask(() => this.invalidate(workspace));
        },
        () => state.pending.delete(showIgnored),
      );
    }
    const listing = await result;
    return state.warning
      ? { ...listing, warning: [listing.warning, state.warning].filter(Boolean).join(" ") }
      : listing;
  }
  private scan(workspace: WorkspaceTarget, showIgnored: boolean, signal: AbortSignal): Promise<ReadOnlyListing> {
    return new Promise((resolve, reject) => {
      let worker: Worker | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let done = false;
      const finish = (result: ReadOnlyListing | Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", aborted);
        worker?.terminate();
        if (result instanceof Error) reject(result);
        else resolve(result);
      };
      const aborted = () => finish(new ReadOnlyError(503, "File listing was interrupted. Retry to refresh."));
      try {
        assertInstallUnchanged("the read-only file worker");
        worker = new Worker(new URL("./read-only-worker.ts", import.meta.url).href);
        worker.onmessage = ({ data }) => finish(data.error ? new Error(data.error) : data.result);
        worker.onerror = (event) => finish(new Error(event.message));
        timer = setTimeout(
          () => finish(new ReadOnlyError(503, "Listing this folder took too long. Exclude large folders and retry.")),
          30_000,
        );
        signal.addEventListener("abort", aborted, { once: true });
        if (signal.aborted) aborted();
        else worker.postMessage({ workspace, showIgnored });
      } catch (error) {
        finish(error as Error);
      }
    });
  }
  subscribe(workspace: WorkspaceTarget, listener: () => void) {
    const state = this.state(workspace);
    state.listeners.add(listener);
    if (!state.watcher) {
      try {
        const root = workspaceWorktree(workspace);
        let policy = buildMatcherPredicates(loadMatcherConfig(root, workspaceBusPath(workspace)));
        const changed = (_event: string, filename: string | Buffer | null) => {
          const path = filename?.toString().replaceAll("\\", "/") ?? "";
          // Configuration is the sole exception to excluded workspace-state events.
          if (
            path &&
            path !== ".glosa/config.json" &&
            (path
              .split("/")
              .some(
                (part, i, parts) => part.toLowerCase() === ".git" || (i < parts.length - 1 && part.startsWith(".")),
              ) ||
              policy.isExcluded(path))
          )
            return;
          if (path === ".glosa/config.json") {
            try {
              policy = buildMatcherPredicates(loadMatcherConfig(root, workspaceBusPath(workspace)));
            } catch {
              /* listing reports invalid configuration */
            }
          }
          state.scans.clear();
          state.epoch++;
          // Leading debounce bounds work even during a continuous write stream.
          state.timer ??= setTimeout(() => {
            state.timer = undefined;
            this.invalidate(workspace);
          }, 250);
        };
        state.watcher = watch(root, { recursive: true }, changed);
        const failed = () => {
          state.warning = "Live file updates are unavailable. Reopen this folder to retry.";
          this.invalidate(workspace);
        };
        state.watcher.on("error", failed);
        const bus = workspaceBusPath(workspace);
        if (existsSync(bus)) {
          state.configWatcher = watch(bus, (_event, name) => {
            if (name?.toString() === "config.json") changed("change", ".glosa/config.json");
          });
          state.configWatcher.on("error", failed);
        }
      } catch {
        state.warning = "Live file updates could not start. Reopen this folder to retry.";
      }
    }
    // Closes the initial list-to-subscribe gap, including reconnects.
    queueMicrotask(() => {
      if (state.listeners.has(listener)) this.invalidate(workspace);
    });
    return () => {
      state.listeners.delete(listener);
      if (!state.listeners.size) {
        clearTimeout(state.timer);
        state.watcher?.close();
        state.configWatcher?.close();
        state.abort.abort();
        this.states.delete(workspaceRegistrationId(workspace));
      }
    };
  }
}

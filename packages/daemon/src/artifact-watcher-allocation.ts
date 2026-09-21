// SPDX-License-Identifier: Apache-2.0
// Daemon-owned policy for the bounded artifact watcher registry (#219). The watcher itself stays
// session-agnostic: this coordinator translates generic workspace/session state into one complete,
// deterministic allocation and hands only the selected registrations to it.
import { existsSync } from "node:fs";
import type { ArtifactWatcherRegistry } from "./artifact-watcher.ts";
import type { SessionRegistry } from "./registry/session-registry.ts";
import type { WorkspaceEntry, WorkspaceIndex } from "./registry/workspace-index.ts";
import { isHomeOrAncestor } from "./registry/workspace-root.ts";
import { workspaceWorktree } from "./workspace.ts";

export interface ArtifactWatcherAllocationOptions {
  workspaceIndex: WorkspaceIndex;
  sessionRegistry: SessionRegistry;
  watcherRegistry: ArtifactWatcherRegistry;
  userHomeDir: string;
  pathExists?: (path: string) => boolean;
  now?: () => Date;
  warn?: (message: string) => void;
}

interface RankedWorkspace {
  entry: WorkspaceEntry;
  live: boolean;
}

/**
 * Allocation order is deliberately small and explainable:
 *
 *   live session -> newest durable `last_seen` -> registration id
 *
 * The final key makes equal timestamps independent of JSON object/insertion order. Stars are not
 * part of this policy; they remain a navigation feature. Rebalancing is coalesced because one
 * session registration also refreshes its workspace index row and therefore raises both callbacks.
 */
export class ArtifactWatcherAllocation {
  private readonly workspaceIndex: WorkspaceIndex;
  private readonly sessionRegistry: SessionRegistry;
  private readonly watcherRegistry: ArtifactWatcherRegistry;
  private readonly userHomeDir: string;
  private readonly pathExists: (path: string) => boolean;
  private readonly now: () => Date;
  private readonly warn: (message: string) => void;
  private requested = false;
  private stopped = false;
  private running: Promise<void> | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: ArtifactWatcherAllocationOptions) {
    this.workspaceIndex = options.workspaceIndex;
    this.sessionRegistry = options.sessionRegistry;
    this.watcherRegistry = options.watcherRegistry;
    this.userHomeDir = options.userHomeDir;
    this.pathExists = options.pathExists ?? existsSync;
    this.now = options.now ?? (() => new Date());
    this.warn = options.warn ?? (() => {});
  }

  /** Cheap callback target for index/session mutations. Never performs allocation inside their
   * mutexes; the microtask runs after the producer has published its complete state. */
  requestRebalance(): void {
    if (this.stopped) return;
    this.requested = true;
    queueMicrotask(() => {
      if (this.stopped || this.running) return;
      void this.start().catch((error: unknown) => {
        this.warn(`artifact watcher allocation failed: ${String(error)}`);
      });
    });
  }

  /** Awaitable startup/test entrypoint. Construction itself opens nothing, preserving daemon
   * readiness; production calls this only after both listeners and the handshake are live. */
  rebalance(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.requested = true;
    return this.running ?? this.start();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.requested = false;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    try {
      await this.running;
    } catch {
      // The caller is about to close/abandon every watcher. A prior logged allocation failure must
      // not prevent resource shutdown.
    }
  }

  private start(): Promise<void> {
    const run = this.drain().finally(() => {
      if (this.running === run) this.running = null;
      if (this.requested && !this.stopped) this.requestRebalance();
    });
    this.running = run;
    return run;
  }

  private async drain(): Promise<void> {
    while (this.requested && !this.stopped) {
      this.requested = false;
      await this.applyCurrentAllocation();
    }
  }

  private async applyCurrentAllocation(): Promise<void> {
    const ranked: RankedWorkspace[] = this.workspaceIndex
      .list({ presentOnly: true })
      .filter((entry) => this.eligible(entry))
      .map((entry) => ({
        entry,
        live: this.sessionRegistry.forWorkspaceOwnedBy(entry.registration_id, entry.canonical_path).length > 0,
      }))
      .sort((a, b) => {
        if (a.live !== b.live) return a.live ? -1 : 1;
        const recent = b.entry.last_seen.localeCompare(a.entry.last_seen);
        return recent !== 0 ? recent : a.entry.registration_id.localeCompare(b.entry.registration_id);
      });

    const limit = this.watcherRegistry.watchedWorkspaceLimit();
    await this.watcherRegistry.applyAllocation(
      ranked.slice(0, limit).map(({ entry }) => entry),
      ranked.slice(limit).map(({ entry }) => entry),
    );
    this.scheduleNextLeaseExpiry();
  }

  private eligible(entry: WorkspaceEntry): boolean {
    if ((entry.lifecycle?.state ?? "active") !== "active") return false;
    const root = workspaceWorktree(entry);
    return this.pathExists(root) && !isHomeOrAncestor(root, this.userHomeDir);
  }

  /** Liveness is time-derived, so no session mutation occurs at the instant a lease becomes stale.
   * One unref'd timer for the nearest expiry supplies that missing edge without polling or egress.
   * If a heartbeat extended the lease meanwhile, this harmless early wake computes the new one. */
  private scheduleNextLeaseExpiry(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    if (this.stopped) return;

    const now = this.now().getTime();
    const next = this.sessionRegistry
      .list()
      .map((session) => Date.parse(session.lease_expiry))
      .filter((expiry) => Number.isFinite(expiry) && expiry > now)
      .sort((a, b) => a - b)[0];
    if (next === undefined) return;

    const delay = Math.min(2_147_483_647, Math.max(1, next - now + 1));
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null;
      this.requestRebalance();
    }, delay);
    this.expiryTimer.unref?.();
  }
}

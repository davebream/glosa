// SPDX-License-Identifier: Apache-2.0
// Daemon-lifetime claim expiry (issue #155 Q2). Claims expire lazily wherever they are met — a new
// claim over the same paths, a resolve, a human save, a startup reconcile — but a claim nobody
// meets again would otherwise outlive its holder by as long as nobody looks. This is the timer that
// looks: every 30 s it asks each OPEN bus to expire what is due, by TTL or because the holder
// session went stale. It never opens a bus (an unopened workspace has no live claim worth a git
// spawn; reconcile expires TTL-lapsed ones the moment it is opened) and it owns no policy of its
// own — the bus decides, this only supplies the clock and the session registry's view of liveness.
import type { WorkspaceBusRegistry } from "./bus/workspace-bus-registry.ts";
import type { SessionRegistry } from "./registry/session-registry.ts";
import type { WorkspaceIndex } from "./registry/workspace-index.ts";

/** One sweep per interval. Also the bound `CLAIM_RENEW_GRACE_MS` is stated against: a resolve that
 * reaches the mutex later than this after its claim's TTL gets the answer a sweep would already
 * have given it. */
export const CLAIM_SWEEP_INTERVAL_MS = 30_000;

export interface ClaimSweeperOptions {
  workspaceIndex: Pick<WorkspaceIndex, "list">;
  busRegistry: Pick<WorkspaceBusRegistry, "has" | "get">;
  sessionRegistry: Pick<SessionRegistry, "liveness" | "get">;
  now?: () => Date;
  /** Injectable scheduler, the `SessionRegistry.scheduleRefresh` shape: returns a cancel. */
  schedule?: (tick: () => void, intervalMs: number) => () => void;
  warn?: (message: string) => void;
}

export class ClaimSweeper {
  private readonly workspaceIndex: ClaimSweeperOptions["workspaceIndex"];
  private readonly busRegistry: ClaimSweeperOptions["busRegistry"];
  private readonly sessionRegistry: ClaimSweeperOptions["sessionRegistry"];
  private readonly now: () => Date;
  private readonly schedule: NonNullable<ClaimSweeperOptions["schedule"]>;
  private readonly warn: (message: string) => void;
  private cancel: (() => void) | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;

  constructor(options: ClaimSweeperOptions) {
    this.workspaceIndex = options.workspaceIndex;
    this.busRegistry = options.busRegistry;
    this.sessionRegistry = options.sessionRegistry;
    this.now = options.now ?? (() => new Date());
    this.warn = options.warn ?? (() => {});
    this.schedule =
      options.schedule ??
      ((tick, intervalMs) => {
        const timer = setInterval(tick, intervalMs);
        timer.unref?.();
        return () => clearInterval(timer);
      });
  }

  start(): void {
    if (this.stopped || this.cancel) return;
    this.cancel = this.schedule(() => {
      // A slow sweep (many buses, a slow disk) never overlaps the next one.
      if (this.running || this.stopped) return;
      void this.tick();
    }, CLAIM_SWEEP_INTERVAL_MS);
  }

  /** One pass. Awaitable so tests and shutdown can observe completion. */
  tick(): Promise<void> {
    if (this.running) return this.running;
    const run = this.sweep().finally(() => {
      if (this.running === run) this.running = null;
    });
    this.running = run;
    return run;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.cancel?.();
    this.cancel = null;
    try {
      await this.running;
    } catch {
      // Shutdown proceeds regardless; a failed sweep was already reported.
    }
  }

  private async sweep(): Promise<void> {
    const now = this.now();
    const staleSince = (sessionId: string): Date | null => {
      if (this.sessionRegistry.liveness(sessionId) !== "stale") return null;
      // Unregistered is also "stale" to the registry, but there is no heartbeat to have missed —
      // such a holder is bounded by the TTL alone.
      const record = this.sessionRegistry.get(sessionId);
      return record ? new Date(record.lease_expiry) : null;
    };
    for (const entry of this.workspaceIndex.list({ presentOnly: true })) {
      if (this.stopped) return;
      if (!this.busRegistry.has(entry)) continue;
      try {
        await this.busRegistry.get(entry).sweepExpiredClaims(now, staleSince);
      } catch (error) {
        // One workspace's broken shadow repo must not stop the others being swept.
        this.warn(`claim sweep failed for ${entry.canonical_path}: ${String(error)}`);
      }
    }
  }
}

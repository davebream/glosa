// @glosa/daemon — WorkspaceBus: the live, in-process facade over one workspace's file bus. Ties
// together the pieces the other modules in this directory keep deliberately separate:
//   - a long-lived JournalWriter (one fd held for the life of the bus, A4 §F04)
//   - the per-workspace mutex slot from a shared KeyedMutex (cross-cutting invariant: daemon is
//     the sole writer, serialized per workspace)
//   - the "inbox file atomically first, then entry_created" ordering that module 4 (inbox.ts)
//     requires but can't enforce by itself, since it spans both inbox.ts and journal.ts.
// This is what the HTTP layer (later tasks) and this task's concurrency tests call.
import { JournalWriter, appendEvent, type EventBy, type JournalEvent } from "./journal.ts";
import { writeInboxEntryOnce } from "./inbox.ts";
import { journalPath, workspaceBusDir } from "./paths.ts";
import { applyEvent, createEmptyState, defaultReducer, type DerivedState, type Reducer } from "./replay.ts";
import { reconcileWorkspace, type ReconcileResult } from "./reconcile.ts";
import { KeyedMutex } from "./mutex.ts";
import { ulid as defaultUlid } from "./ulid.ts";
import {
  APPLY_LEASE_TTL_MS,
  isLeaseExpired,
  leaseHeldError,
  leaseSessionMismatchError,
  noActiveLeaseError,
} from "./lease.ts";
import { checkpoint, initShadowRepo, reclaimIndexLock } from "../git/shadow.ts";
import { mkdirSync } from "node:fs";

// P2.4 — LOAD-BEARING, NOT JUST FOR THE JOURNAL: nothing here stops two WorkspaceBus instances
// (or a WorkspaceBus + a standalone `reconcileWorkspace(root, ...)` call, e.g. from a health-check
// endpoint or a cron) from being opened/run for the same canonical root at once. Each would hold
// its own fd, its own in-memory `state` (including `state.applyLease` — see applyBegin/
// resolveEntry above), AND its own `KeyedMutex` unless one is explicitly shared via
// `WorkspaceBusDeps.mutex`. Since P2.3, that's no longer just a journal-interleaving risk: two
// unsynchronized writers can each independently believe no lease is active, both pass the
// LEASE_HELD check, and both run `checkpoint()` concurrently against the SAME shadow-git repo —
// a real `index.lock` race, not the reclaim-a-stale-lock case `reclaimIndexLock` is built for
// (that assumes exactly one live operator; two live operators is the situation it can't recover
// from). **P2.4 closes this**: `./workspace-bus-registry.ts` provides the process-wide
// `WorkspaceBusRegistry` (+ its default-instance `getWorkspaceBus(root)`) that guarantees "one
// WorkspaceBus per canonical root, one shared mutex" by construction — every caller, including
// reconcile-at-startup and any future request handler, MUST go through it (or otherwise share the
// same instance/mutex) for a given root. Constructing `new WorkspaceBus(root, ...)` directly
// outside that registry for a root that might already be open elsewhere in the process is still
// the correctness bug described above; the registry is what makes "elsewhere in the process"
// impossible instead of just documented.
export interface WorkspaceBusDeps {
  /** Shared across every WorkspaceBus in the daemon process so different workspaces never share
   * a mutex slot, but the same workspace (opened twice) does. Defaults to a private one, which is
   * fine for a single WorkspaceBus but wrong if the daemon opens the same workspace root twice —
   * callers doing that must pass a shared instance. */
  mutex?: KeyedMutex<string>;
  ulid?: () => string;
  now?: () => Date;
  reducer?: Reducer;
}

export class WorkspaceBus {
  readonly root: string;
  state: DerivedState = createEmptyState();

  private readonly writer: JournalWriter;
  private readonly mutex: KeyedMutex<string>;
  private readonly ulidFn: () => string;
  private readonly nowFn: () => Date;
  private readonly reducer: Reducer;

  constructor(workspaceRoot: string, deps: WorkspaceBusDeps = {}) {
    this.root = workspaceRoot;
    mkdirSync(workspaceBusDir(workspaceRoot), { recursive: true });
    this.writer = new JournalWriter(journalPath(workspaceRoot));
    this.mutex = deps.mutex ?? new KeyedMutex<string>();
    this.ulidFn = deps.ulid ?? defaultUlid;
    this.nowFn = deps.now ?? (() => new Date());
    this.reducer = deps.reducer ?? defaultReducer;
  }

  /** Runs the startup reconcile sequence (its own short-lived writer) and adopts the resulting
   * derived state as this bus's baseline. Call once before serving live writes. */
  reconcile(): Promise<ReconcileResult> {
    return this.mutex.runExclusive(this.root, async () => {
      const result = await reconcileWorkspace(this.root, { ulid: this.ulidFn, now: this.nowFn, reducer: this.reducer });
      this.state = result.state;
      return result;
    });
  }

  /** Inbox file atomically first, then `entry_created` — the load-bearing order from A4 §F04.
   * Both steps run inside the same mutex critical section as every other write to this
   * workspace, so a concurrent transition/delivery call can never observe a half-created entry. */
  createEntry(id: string, payload: unknown, fields: Partial<Pick<JournalEvent, "by" | "idem" | "detail">> = {}): Promise<void> {
    return this.mutex.runExclusive(this.root, () => {
      writeInboxEntryOnce(this.root, id, payload);
      const event: JournalEvent = {
        v: 1,
        event_id: this.ulidFn(),
        at: this.nowFn().toISOString(),
        entry: id,
        event: "entry_created",
        by: fields.by ?? "daemon",
        ...(fields.idem !== undefined ? { idem: fields.idem } : {}),
        ...(fields.detail !== undefined ? { detail: fields.detail } : {}),
      };
      appendEvent(this.writer, event);
      applyEvent(this.state, event, this.reducer);
    });
  }

  /** Appends a `transition_committed{to}` event. Passing the same `idem` across retried calls
   * makes a repeat a no-op on replay — see replay.ts. */
  commitTransition(entryId: string, to: string, opts: { by?: EventBy; idem?: string } = {}): Promise<void> {
    return this.mutex.runExclusive(this.root, () => {
      const event: JournalEvent = {
        v: 1,
        event_id: this.ulidFn(),
        at: this.nowFn().toISOString(),
        entry: entryId,
        event: "transition_committed",
        by: opts.by ?? "daemon",
        ...(opts.idem !== undefined ? { idem: opts.idem } : {}),
        detail: { to },
      };
      appendEvent(this.writer, event);
      applyEvent(this.state, event, this.reducer);
    });
  }

  /** `delivery_attempt` never changes status (separate axis, A5 §F23) and may skip the per-write
   * fsync — loss here is only a redundant re-nudge. */
  recordDeliveryAttempt(entryId: string, opts: { by?: EventBy } = {}): Promise<void> {
    return this.mutex.runExclusive(this.root, () => {
      const event: JournalEvent = {
        v: 1,
        event_id: this.ulidFn(),
        at: this.nowFn().toISOString(),
        entry: entryId,
        event: "delivery_attempt",
        by: opts.by ?? "daemon",
      };
      appendEvent(this.writer, event, { fsync: false });
      applyEvent(this.state, event, this.reducer);
    });
  }

  /** `apply-begin` (A4 §F05): under this workspace's ONE git+journal mutex (the same slot every
   * other write to this workspace goes through, so a checkpoint here can never race a concurrent
   * journal append) — reject `LEASE_HELD` if a lease is already active and not expired (2nd
   * apply-begin never queues); else checkpoint the CURRENT state (attributed `unknown` — whatever
   * drifted before this lease started isn't this session's doing) as `pre_sha`, then append
   * `apply_begin` recording it plus a 15-minute expiry. */
  applyBegin(entry: string, sessionId: string): Promise<{ leaseId: string; preSha: string }> {
    return this.mutex.runExclusive(this.root, async () => {
      reclaimIndexLock(this.root, { writer: this.writer, ulid: this.ulidFn, now: this.nowFn });
      await initShadowRepo(this.root, { writer: this.writer, ulid: this.ulidFn, now: this.nowFn });

      const active = this.state.applyLease;
      if (active && !isLeaseExpired(active, this.nowFn())) throw leaseHeldError(active.leaseId);

      const preSha = await checkpoint(this.root, { attribution: "unknown", kind: "pre_apply", entry });

      const leaseId = this.ulidFn();
      const now = this.nowFn();
      const expiresAt = new Date(now.getTime() + APPLY_LEASE_TTL_MS).toISOString();
      const event: JournalEvent = {
        v: 1,
        event_id: this.ulidFn(),
        at: now.toISOString(),
        entry,
        event: "apply_begin",
        by: `session:${sessionId}`,
        detail: { lease_id: leaseId, entry, session: sessionId, pre_sha: preSha, expires_at: expiresAt },
      };
      appendEvent(this.writer, event);
      applyEvent(this.state, event, this.reducer);
      return { leaseId, preSha };
    });
  }

  /** `resolve` (A4 §F05): checkpoint the post-apply state as `post_sha` — the proven
   * `pre_sha..post_sha` interval is what gets attributed `session:<sessionId>` (both shas ride in
   * the trailers/journal detail, so the proof is inspectable later via `diffShas`). Requires an
   * active lease for `entry` held by THIS `sessionId` — the lease is the proof, so the
   * attribution comes from `lease.session` (what `applyBegin` recorded), never the caller-supplied
   * `sessionId` directly: without the match check, any caller could resolve someone else's open
   * lease and have the edit attributed to themselves, which is exactly the forgery §F05 exists to
   * prevent. A mismatched `sessionId` throws `LEASE_SESSION_MISMATCH` rather than falsely
   * attributing anything. Guarded (first-terminal-wins, illegal-from-status) transition rules
   * belong to P2.5's fuller reducer — this appends the events `resolve` is defined to produce and
   * lets the minimal reducer fold them. */
  resolveEntry(
    entry: string,
    outcome: "applied" | "rejected" | "stale",
    sessionId: string,
  ): Promise<{ leaseId: string; postSha: string }> {
    return this.mutex.runExclusive(this.root, async () => {
      reclaimIndexLock(this.root, { writer: this.writer, ulid: this.ulidFn, now: this.nowFn });

      const lease = this.state.applyLease;
      if (!lease || lease.entry !== entry) throw noActiveLeaseError(entry);
      if (lease.session !== sessionId) throw leaseSessionMismatchError(entry, lease.session, sessionId);

      // Attribution comes from the LEASE's own recorded session (the proven identity), not the
      // `sessionId` parameter — they're equal here (just checked above), but using `lease.session`
      // keeps the attributed value tied to what `applyBegin` actually proved, not to whatever this
      // call happened to be invoked with.
      const attributedSession = lease.session;
      const postSha = await checkpoint(this.root, {
        attribution: `session:${attributedSession}`,
        kind: "post_apply",
        entry,
        lease: lease.leaseId,
      });

      const now = this.nowFn();
      const endEvent: JournalEvent = {
        v: 1,
        event_id: this.ulidFn(),
        at: now.toISOString(),
        entry,
        event: "apply_end",
        by: `session:${attributedSession}`,
        detail: { lease_id: lease.leaseId, post_sha: postSha },
      };
      appendEvent(this.writer, endEvent);
      applyEvent(this.state, endEvent, this.reducer);

      const to = outcome === "applied" ? "resolved" : outcome;
      const transitionEvent: JournalEvent = {
        v: 1,
        event_id: this.ulidFn(),
        at: now.toISOString(),
        entry,
        event: "transition_committed",
        by: `session:${attributedSession}`,
        detail: { to, outcome },
      };
      appendEvent(this.writer, transitionEvent);
      applyEvent(this.state, transitionEvent, this.reducer);

      return { leaseId: lease.leaseId, postSha };
    });
  }

  /** Routed through the mutex so any write already in flight for this workspace finishes first —
   * `close()` then makes the writer terminal (see `JournalWriter#fd`'s `closed` guard), so a
   * write racing in from AFTER this call throws instead of silently reopening the fd. */
  close(): Promise<void> {
    return this.mutex.runExclusive(this.root, () => {
      this.writer.close();
    });
  }
}

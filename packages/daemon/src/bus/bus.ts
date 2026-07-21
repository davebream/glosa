// SPDX-License-Identifier: Apache-2.0
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
import { applyEvent, createEmptyState, type DerivedState, type Reducer } from "./replay.ts";
import {
  isTerminal,
  lifecycleReducer,
  type DeliveryAttemptRecord,
  type DeliveryOutcome,
  type DeliveryReason,
  type DeliveryVia,
} from "./lifecycle.ts";
import { reconcileWorkspace, type ReconcileResult } from "./reconcile.ts";
import { countJournalLines } from "./tail.ts";
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
  // P3.1 review fix: tracks whether THIS INSTANCE has reconciled — deliberately an instance field,
  // not something a caller tracks externally keyed by root string. A root string survives a
  // WorkspaceBusRegistry evict()+reopen (WorkspaceIndex hard-remove → onHardRemove → evict → a
  // later getWorkspaceBus(root) constructs a brand-new WorkspaceBus); an external "have I
  // reconciled root X" cache would then wrongly believe the NEW instance is already reconciled
  // and skip its journal replay/self-heal/offline-catchup forever. Living on the instance means a
  // fresh instance is un-reconciled by construction — no external bookkeeping to keep in sync.
  private reconciledOnce = false;

  // P3.2 — the SSE cursor space (A1 §8.1): `nextSequence` is the physical journal-line offset
  // this bus's NEXT append will claim. Seeded from `countJournalLines` at the end of every
  // `reconcile()` (never incrementally carried across reconciles) — that's what keeps a
  // restarted daemon's sequence numbers identical to the crashed one's, since both derive purely
  // from the same on-disk bytes (A1 §8.2 case 4). `listeners` is the in-process pub/sub the
  // `/w/:slug/stream` route subscribes to for live push — safe with no file-watching because a
  // WorkspaceBus is the SOLE writer for its root (P2.4's registry invariant).
  private nextSequence = 0;
  private readonly listeners = new Set<(payload: { cursor: number; event: JournalEvent }) => void>();

  constructor(workspaceRoot: string, deps: WorkspaceBusDeps = {}) {
    this.root = workspaceRoot;
    mkdirSync(workspaceBusDir(workspaceRoot), { recursive: true });
    this.writer = new JournalWriter(journalPath(workspaceRoot));
    this.mutex = deps.mutex ?? new KeyedMutex<string>();
    this.ulidFn = deps.ulid ?? defaultUlid;
    this.nowFn = deps.now ?? (() => new Date());
    // P2.5: the guarded lifecycle reducer is WorkspaceBus's default — this is the real
    // production path (HTTP/CLI never fold bare journal bytes themselves). `replay.ts`'s own
    // minimal `defaultReducer` stays the fallback for direct, lower-level `foldEvents`/
    // `replayJournal`/`reconcileWorkspace` callers (e.g. its own test suite) that never go
    // through a WorkspaceBus at all.
    this.reducer = deps.reducer ?? lifecycleReducer;
  }

  /** Runs `reconcile()` at most once per instance — a no-op (resolves `undefined`, no mutex taken)
   * on every call after the first. This is the call callers that just want "make sure this bus's
   * state reflects the journal before I read/write it" should use instead of bare `reconcile()`;
   * bare `reconcile()` stays available for a caller that legitimately wants to force a fresh
   * reconcile pass (e.g. a test). The flag is claimed SYNCHRONOUSLY before the first `await`, so
   * two calls racing in back-to-back can't both kick off a reconcile. If the underlying
   * `reconcile()` throws (e.g. `initShadowRepo` hits a permission error or disk full), the flag is
   * reset so the NEXT `reconcileOnce()` call gets a genuine retry instead of silently believing
   * this instance already reconciled and serving un-reconciled state forever. */
  reconcileOnce(): Promise<ReconcileResult | undefined> {
    if (this.reconciledOnce) return Promise.resolve(undefined);
    this.reconciledOnce = true;
    return this.reconcile().catch((err) => {
      this.reconciledOnce = false;
      throw err;
    });
  }

  /** Runs the startup reconcile sequence (its own short-lived writer) and adopts the resulting
   * derived state as this bus's baseline. Call once before serving live writes. */
  reconcile(): Promise<ReconcileResult> {
    return this.mutex.runExclusive(this.root, async () => {
      const result = await reconcileWorkspace(this.root, { ulid: this.ulidFn, now: this.nowFn, reducer: this.reducer });
      this.state = result.state;
      // Re-derived from the file, not incremented — reconcile's own writer may have just
      // appended fresh `line_quarantined`/self-heal events, so only a fresh physical count is
      // guaranteed to match reality (see the field docstring above).
      this.nextSequence = countJournalLines(this.root);
      return result;
    });
  }

  /** Registers a listener for every event THIS bus appends from now on (P3.2), delivered
   * synchronously — same call stack as the appending write, inside that write's mutex critical
   * section — with the exact physical journal-line sequence number the append just claimed.
   * Returns an unsubscribe function.
   *
   * Callers that need "current cursor, then subscribe from here forward, miss nothing" MUST read
   * `currentCursor()` and call `subscribe()` back-to-back with NO `await` between them: both are
   * synchronous, and JS's single-threaded execution means no write's continuation (even one
   * already "in flight" awaiting e.g. `checkpoint()`) can run in that gap — see stream.ts's
   * `createJournalStreamResponse` for the call site this protects. */
  subscribe(listener: (payload: { cursor: number; event: JournalEvent }) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** The sequence number of the last physical journal line that exists right now, or `-1` if the
   * journal is empty ("nothing to catch up on, everything from here forward is live"). Doubles as
   * the A1 §8.2 first-connect snapshot's `id`, and as `readJournalEventsSince`'s `sinceSeq`
   * sentinel for "return everything" when passed straight through. */
  currentCursor(): number {
    return this.nextSequence - 1;
  }

  /** Test/diagnostic-only: how many live subscribers this bus currently has. Lets a test prove a
   * disconnected SSE client's `unsubscribe()` actually ran (no lingering listener) without this
   * class exposing its `listeners` set directly. */
  listenerCount(): number {
    return this.listeners.size;
  }

  /** Notifies every subscriber with the sequence number `event` just claimed. Re-derives
   * `nextSequence` from the file on EVERY call rather than incrementing in memory — deliberately,
   * not just defensively: `applyBegin`/`resolveEntry` call into git/shadow.ts helpers
   * (`initShadowRepo`'s `baseline_checkpoint`, `reclaimIndexLock`'s `git_index_lock_reclaimed`)
   * that append journal lines through this SAME `this.writer` WITHOUT going through this class's
   * own `applyEvent`/`notify` at all (by design — those events aren't part of the entry lifecycle
   * this class otherwise fully owns). An incrementally-tracked counter would silently fall behind
   * the true physical line count the moment one of those fires, corrupting every cursor after it.
   * A fresh recount right before computing `event`'s own cursor is what keeps this correct
   * regardless of what else touched the file since the last notify — the extra `readFileSync` is
   * paid on the write path, which is already doing real fsync'd disk I/O, so it isn't the cost
   * that matters here; correctness is. */
  private notify(event: JournalEvent): void {
    this.nextSequence = countJournalLines(this.root);
    const cursor = this.nextSequence - 1; // the physical line `event` itself just became
    // Each listener runs in its own try/catch (review fix): the append + state mutation this
    // notify() follows has ALREADY durably succeeded by this point, so a throwing listener must
    // never propagate out of here — unguarded, it would (a) reject the WRITE CALLER's own promise
    // for an event that was actually persisted fine (e.g. an SSE stream's dead controller would
    // 500 `POST .../annotations` even though the annotation was saved), and (b) since `for...of`
    // over a `Set` stops at the first throw, silently skip notifying every listener registered
    // AFTER the failing one — real event loss for other live SSE connections on this workspace,
    // not just the one that misbehaved. Log-and-continue keeps every write's own promise clean
    // and every sibling listener isolated from one bad one.
    for (const listener of this.listeners) {
      try {
        listener({ cursor, event });
      } catch (err) {
        console.error(`WorkspaceBus(${this.root}): a stream listener threw on notify — continuing`, err);
      }
    }
  }

  /** Inbox file atomically first, then `entry_created` — the load-bearing order from A4 §F04.
   * Both steps run inside the same mutex critical section as every other write to this
   * workspace, so a concurrent transition/delivery call can never observe a half-created entry.
   *
   * `payload.kind` (R3: `human_edit`|`annotation`|`attention_request`) is mirrored into the
   * `entry_created` event's own `detail.kind` — the fold only ever sees journal EVENTS, never the
   * inbox file, so `lifecycleReducer` (P2.5) needs its own copy of the kind to pick the right
   * transition table (attention vs. common). `fields.detail`, if given, is applied on top and wins
   * on any overlapping key, `kind` included. */
  createEntry(id: string, payload: unknown, fields: Partial<Pick<JournalEvent, "by" | "idem" | "detail">> = {}): Promise<void> {
    return this.mutex.runExclusive(this.root, () => {
      writeInboxEntryOnce(this.root, id, payload);
      const payloadKind =
        payload !== null && typeof payload === "object" && typeof (payload as Record<string, unknown>).kind === "string"
          ? ((payload as Record<string, unknown>).kind as string)
          : undefined;
      const detail: Record<string, unknown> | undefined =
        payloadKind !== undefined || fields.detail !== undefined
          ? { ...(payloadKind !== undefined ? { kind: payloadKind } : {}), ...(fields.detail ?? {}) }
          : undefined;
      const event: JournalEvent = {
        v: 1,
        event_id: this.ulidFn(),
        at: this.nowFn().toISOString(),
        entry: id,
        event: "entry_created",
        by: fields.by ?? "daemon",
        ...(fields.idem !== undefined ? { idem: fields.idem } : {}),
        ...(detail !== undefined ? { detail } : {}),
      };
      appendEvent(this.writer, event);
      applyEvent(this.state, event, this.reducer);
      this.notify(event);
    });
  }

  /** Appends a `transition_committed{to}` event. Passing the same `idem` across retried calls
   * makes a repeat a no-op on replay — see replay.ts.
   *
   * `opts.note` (P5.1, CLI `resolve --note`) rides along in `detail` purely as an inspectable
   * audit string — it is NEVER consulted by `applyGuardedTransition`'s guard table, so it has no
   * effect on whether the transition is legal. This is also how the CLI's `resolve <id> deferred`
   * is implemented: `deferred` is not a recognized `to` value in EITHER guard table in
   * lifecycle.ts (verified, not assumed — there is no COMMON_GUARDS/ATTENTION_GUARDS entry for
   * it), so `applyGuardedTransition` folds this event as a no-op on `status` — the entry's
   * derived state genuinely doesn't move, which is exactly A6 §F26's "deferred = re-surface, not
   * terminal." The event still lands durably in the journal as an honest audit record ("session X
   * explicitly deferred a decision on this entry at time T"), without requiring a new terminal
   * value or lease-closing side effect neither this task nor A5 §F23 specifies. */
  commitTransition(entryId: string, to: string, opts: { by?: EventBy; idem?: string; note?: string } = {}): Promise<void> {
    return this.mutex.runExclusive(this.root, () => {
      const event: JournalEvent = {
        v: 1,
        event_id: this.ulidFn(),
        at: this.nowFn().toISOString(),
        entry: entryId,
        event: "transition_committed",
        by: opts.by ?? "daemon",
        ...(opts.idem !== undefined ? { idem: opts.idem } : {}),
        detail: { to, ...(opts.note !== undefined ? { note: opts.note } : {}) },
      };
      appendEvent(this.writer, event);
      applyEvent(this.state, event, this.reducer);
      this.notify(event);
    });
  }

  /** `delivery_attempt` never changes status (separate axis, A5 §F23) and may skip the per-write
   * fsync — loss here is only a redundant re-nudge. The A5 §F23 attempt shape (`via`/`session`/
   * `outcome`/`reason`/`error?`) rides in `detail`, which is what `lifecycleReducer` reads into
   * each entry's `deliveryAttempts` list. `via`/`outcome`/`reason` are typed to A5 §F23's fixed
   * vocabulary (`lifecycle.ts`'s `DeliveryVia`/`DeliveryOutcome`/`DeliveryReason`) — a caller
   * cannot accidentally journal an out-of-spec value like `"delivered"` or a free-text reason. */
  recordDeliveryAttempt(
    entryId: string,
    opts: {
      by?: EventBy;
      via?: DeliveryVia;
      session?: string;
      outcome?: DeliveryOutcome;
      reason?: DeliveryReason;
      error?: string;
    } = {},
  ): Promise<void> {
    return this.mutex.runExclusive(this.root, () => this.recordDeliveryAttemptLocked(entryId, opts));
  }

  /** The unlocked body `recordDeliveryAttempt` wraps in its own mutex critical section — pulled
   * out so `drainCandidates` (below) can call it from WITHIN an ALREADY-held critical section
   * without deadlocking (`KeyedMutex.runExclusive` is not reentrant — a nested call for the same
   * root would wait on itself forever). Never call this directly outside a critical section this
   * class already holds for `this.root`. */
  private recordDeliveryAttemptLocked(
    entryId: string,
    opts: {
      by?: EventBy;
      via?: DeliveryVia;
      session?: string;
      outcome?: DeliveryOutcome;
      reason?: DeliveryReason;
      error?: string;
    },
  ): void {
    const { by, ...detail } = opts;
    const hasDetail = Object.values(detail).some((v) => v !== undefined);
    const event: JournalEvent = {
      v: 1,
      event_id: this.ulidFn(),
      at: this.nowFn().toISOString(),
      entry: entryId,
      event: "delivery_attempt",
      by: by ?? "daemon",
      ...(hasDetail ? { detail } : {}),
    };
    appendEvent(this.writer, event, { fsync: false });
    applyEvent(this.state, event, this.reducer);
    this.notify(event);
  }

  /** The A5 §F23 turn-boundary/watcher drain, done ATOMICALLY: selects eligible entries AND
   * records each one's `delivery_attempt` in the SAME mutex critical section (P4.3 concurrency
   * review fix #7 — an earlier revision selected candidates in the HTTP route, outside any lock,
   * so two concurrent drains on one workspace could both select and record against the exact
   * same entries; moving both steps in here, under `this.mutex`, is what makes "select" and
   * "record" a single indivisible operation two racing callers can't interleave). Eligible =
   * non-terminal AND not yet SUCCESSFULLY delivered — an entry whose only prior attempts are all
   * `outcome:"failed"` stays eligible (it gets re-drained, `reason:"re_nudge"`, never
   * permanently excluded by a transport failure); an entry that already has a
   * `"presented"`/`"transport_accepted"` attempt on record is excluded, since it doesn't need
   * re-surfacing. Returns the drained entries' ids/kind/status for the caller to build its own
   * additionalContext/reminder text. */
  drainCandidates(limit: number, opts: { via: DeliveryVia; session: string }): Promise<{ id: string; kind: string; status: string }[]> {
    return this.mutex.runExclusive(this.root, () => {
      const candidates = Object.entries(this.state.entries)
        .filter(([, e]) => {
          const kind = e.kind === "attention" ? "attention" : "common";
          if (isTerminal(kind, e.status)) return false;
          const attempts = Array.isArray(e.deliveryAttempts) ? (e.deliveryAttempts as DeliveryAttemptRecord[]) : [];
          const alreadyDelivered = attempts.some((a) => a.outcome === "presented" || a.outcome === "transport_accepted");
          return !alreadyDelivered;
        })
        .slice(0, limit);

      for (const [id, entryState] of candidates) {
        const attempts = Array.isArray(entryState.deliveryAttempts) ? entryState.deliveryAttempts : [];
        const reason: DeliveryReason = attempts.length > 0 ? "re_nudge" : "initial";
        this.recordDeliveryAttemptLocked(id, { via: opts.via, session: opts.session, outcome: "presented", reason });
      }

      return candidates.map(([id, e]) => ({ id, kind: typeof e.kind === "string" ? e.kind : "common", status: e.status }));
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
      this.notify(event);
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
   * belong to P2.5's `lifecycleReducer` — this just appends the events `resolve` is defined to
   * produce and lets whichever reducer this bus is running fold them. */
  resolveEntry(
    entry: string,
    outcome: "applied" | "rejected" | "stale",
    sessionId: string,
    opts: { note?: string } = {},
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
      this.notify(endEvent);

      const to = outcome; // A5 §F23 conformance: common terminals are literally applied|rejected|stale
      const transitionEvent: JournalEvent = {
        v: 1,
        event_id: this.ulidFn(),
        at: now.toISOString(),
        entry,
        event: "transition_committed",
        by: `session:${attributedSession}`,
        detail: { to, outcome, ...(opts.note !== undefined ? { note: opts.note } : {}) },
      };
      appendEvent(this.writer, transitionEvent);
      applyEvent(this.state, transitionEvent, this.reducer);
      this.notify(transitionEvent);

      return { leaseId: lease.leaseId, postSha };
    });
  }

  /** `PUT /w/:slug/artifacts/:path`'s checkpoint (P3.3 addition, A4 §F05's "human by
   * construction" rule): checkpoints whatever is currently on disk as a `human`-attributed
   * commit — no lease is involved, because this is a write glosa's OWN editor performed directly
   * (not proxied through an agent session, so there's no `session:<id>` to attribute it to and
   * none needed — the honest answer is simply `human`). Caller MUST have already written the file
   * to disk (via `writeArtifactAtomic`) BEFORE calling this: `checkpoint()` stages whatever's
   * currently on disk, it doesn't take content as an argument. Mirrors `applyBegin`'s own
   * reclaim-lock + ensure-shadow-repo-exists preamble since this can be the very first git
   * operation for a workspace that has never had a lease.
   *
   * `kind` defaults to `human_edit` (the `PUT /w/:slug/artifacts/:path` save flow this method was
   * built for) — `POST /w/:slug/restore` (P3.5, A6 §F31) reuses this same "human by construction,
   * no lease involved" checkpoint but passes `kind: "restore"` so the timeline can tell a restore
   * apart from an ordinary editor save without inventing a second near-identical method. */
  humanEditCheckpoint(kind = "human_edit"): Promise<string> {
    return this.mutex.runExclusive(this.root, async () => {
      reclaimIndexLock(this.root, { writer: this.writer, ulid: this.ulidFn, now: this.nowFn });
      await initShadowRepo(this.root, { writer: this.writer, ulid: this.ulidFn, now: this.nowFn });
      return checkpoint(this.root, { attribution: "human", kind });
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

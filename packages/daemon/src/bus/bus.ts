// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — WorkspaceBus: the live, in-process facade over one workspace's file bus. Ties
// together the pieces the other modules in this directory keep deliberately separate:
//   - a long-lived JournalWriter (one fd held for the life of the bus, A4 §F04)
//   - the per-workspace mutex slot from a shared KeyedMutex (cross-cutting invariant: daemon is
//     the sole writer, serialized per workspace)
//   - the "inbox file atomically first, then entry_created" ordering that module 4 (inbox.ts)
//     requires but can't enforce by itself, since it spans both inbox.ts and journal.ts.
// This is what the HTTP layer (later tasks) and this task's concurrency tests call.

import { mkdirSync } from "node:fs";
import type { DeliverableEntry } from "../agent-provider/interface.ts";
import { MAX_BATCH_PRESENTATION_BYTES, MAX_DELIVERY_ENTRIES } from "../delivery/presentation.ts";
import { checkpoint, headSha, initShadowRepo, reclaimIndexLock, runGit, safePathspec } from "../git/shadow.ts";
import { type WorkspaceTarget, workspaceRegistrationId, workspaceWorktree } from "../workspace.ts";
import { readInboxEntry, writeInboxEntryOnce } from "./inbox.ts";
import { appendEvent, type EventBy, type JournalEvent, JournalWriter } from "./journal.ts";
import {
  APPLY_LEASE_TTL_MS,
  isLeaseExpired,
  leaseExpiredError,
  leaseHeldError,
  leaseSessionMismatchError,
  noActiveLeaseError,
} from "./lease.ts";
import {
  type DeliveryAttemptRecord,
  type DeliveryOutcome,
  type DeliveryReason,
  type DeliveryVia,
  isTerminal,
  lifecycleReducer,
} from "./lifecycle.ts";
import { KeyedMutex } from "./mutex.ts";
import { journalPath, workspaceBusDir } from "./paths.ts";
import { type ReconcileResult, reconcileWorkspace } from "./reconcile.ts";
import { applyEvent, type ApplyLeaseState, createEmptyState, type DerivedState, type Reducer } from "./replay.ts";
import { countJournalLines } from "./tail.ts";
import { ulid as defaultUlid } from "./ulid.ts";

const DELIVERY_RESERVATION_TTL_MS = 30_000;

interface DeliveryReservation {
  entries: string[];
  via: DeliveryVia;
  session: string;
  expiresAt: number;
}

export interface PreparedDelivery {
  delivery_id: string | null;
  drained: DeliverableEntry[];
  count: number;
  has_more: boolean;
}

export interface StandardAttentionVerdict {
  outcome: "done" | "approved" | "changes_requested";
  response?: string;
}

export interface ApprovalVerdict {
  outcome: "approved";
  target_path: string;
  revision_id: string;
  completed_at: string;
}

export type AttentionVerdict = StandardAttentionVerdict | ApprovalVerdict;

export interface AttentionRequestPayload {
  kind: "attention_request";
  message?: string;
  action: string;
  path?: string;
  target_path?: string;
  approval_mode?: true;
}

export class ApprovalConflictError extends Error {
  readonly code = "APPROVAL_CONFLICT";

  constructor(readonly targetPath: string) {
    super(`an approval request is already active for ${targetPath}`);
  }
}

/** R9's "at most one non-terminal approval request per workspace/path" is proven by READING the
 * candidate entries' immutable inbox payloads — the journal event carries only `detail.kind`, so
 * `target_path`/`approval_mode` are only knowable from the file (A4 §F04). When a candidate's
 * payload cannot be read, the scan has neither proven a conflict nor proven there is none, and
 * those are different answers that must not collapse into the same one.
 *
 * Distinct from `ApprovalConflictError` on purpose, in the same spirit as `LEASE_EXPIRED` vs
 * `NO_ACTIVE_LEASE` (A4 §F05) and `INDEX_LOCK_NOT_OWNED` (A4 §F21): reporting a definite conflict
 * we cannot demonstrate would send the caller after an "existing request" that may not exist, and
 * whose payload is unreadable anyway — so the advertised remedy (finish that approval) could be
 * impossible to carry out. This error says only what is true — uniqueness is unprovable right now
 * — and names the entries responsible so the remedy is actionable: make those payloads readable
 * again, or drive them terminal through the journal (`glosa resolve`), after which they stop
 * being candidates. Reconcile is deliberately NOT offered as the fix: its step-3 self-heal
 * repairs a file with no `entry_created`, never an `entry_created` whose file is damaged. */
export class ApprovalUniquenessUnprovableError extends Error {
  readonly code = "APPROVAL_UNIQUENESS_UNPROVABLE";

  constructor(
    readonly targetPath: string,
    readonly entries: readonly string[],
  ) {
    super(
      `cannot prove ${targetPath} has no open approval request: inbox entr${entries.length === 1 ? "y" : "ies"} ` +
        `${entries.join(", ")} could not be read — restore the payload(s) or resolve the entr${
          entries.length === 1 ? "y" : "ies"
        } so they leave the non-terminal set, then retry`,
    );
  }
}

export class WorkspaceAdoptedError extends Error {
  constructor(readonly targetRegistrationId: string) {
    super(`workspace has been adopted by ${targetRegistrationId}`);
  }
}

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
  readonly workspace: WorkspaceTarget;
  state: DerivedState = createEmptyState();

  private readonly writer: JournalWriter;
  private readonly mutex: KeyedMutex<string>;
  private readonly ulidFn: () => string;
  private readonly nowFn: () => Date;
  private readonly reducer: Reducer;
  private readonly mutexKey: string;
  // P3.1 review fix: tracks whether THIS INSTANCE has reconciled — deliberately an instance field,
  // not something a caller tracks externally keyed by root string. A root string survives a
  // WorkspaceBusRegistry evict()+reopen (WorkspaceIndex hard-remove → onHardRemove → evict → a
  // later getWorkspaceBus(root) constructs a brand-new WorkspaceBus); an external "have I
  // reconciled root X" cache would then wrongly believe the NEW instance is already reconciled
  // and skip its journal replay/self-heal/offline-catchup forever. Living on the instance means a
  // fresh instance is un-reconciled by construction — no external bookkeeping to keep in sync.
  private reconciledOnce = false;
  private readonly deliveryReservations = new Map<string, DeliveryReservation>();

  // P3.2 — the SSE cursor space (A1 §8.1): `nextSequence` is the physical journal-line offset
  // this bus's NEXT append will claim. Seeded from `countJournalLines` at the end of every
  // `reconcile()` (never incrementally carried across reconciles) — that's what keeps a
  // restarted daemon's sequence numbers identical to the crashed one's, since both derive purely
  // from the same on-disk bytes (A1 §8.2 case 4). `listeners` is the in-process pub/sub the
  // `/w/:slug/stream` route subscribes to for live push — safe with no file-watching because a
  // WorkspaceBus is the SOLE writer for its root (P2.4's registry invariant).
  private nextSequence = 0;
  private readonly listeners = new Set<(payload: { cursor: number; event: JournalEvent }) => void>();

  private assertWritable(): void {
    if (this.state.adoptionSeal) throw new WorkspaceAdoptedError(this.state.adoptionSeal.targetRegistrationId);
  }

  constructor(workspaceRoot: WorkspaceTarget, deps: WorkspaceBusDeps = {}) {
    this.workspace = workspaceRoot;
    this.root = workspaceWorktree(workspaceRoot);
    this.mutexKey = workspaceRegistrationId(workspaceRoot);
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
    return this.mutex.runExclusive(this.mutexKey, async () => {
      const result = await reconcileWorkspace(this.workspace, {
        ulid: this.ulidFn,
        now: this.nowFn,
        reducer: this.reducer,
      });
      this.state = result.state;
      // Re-derived from the file, not incremented — reconcile's own writer may have just
      // appended fresh `line_quarantined`/self-heal events, so only a fresh physical count is
      // guaranteed to match reality (see the field docstring above).
      this.nextSequence = countJournalLines(this.workspace);
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
    this.nextSequence = countJournalLines(this.workspace);
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
  createEntry(
    id: string,
    payload: unknown,
    fields: Partial<Pick<JournalEvent, "by" | "idem" | "detail">> = {},
  ): Promise<void> {
    return this.mutex.runExclusive(this.mutexKey, () => this.createEntryLocked(id, payload, fields));
  }

  /** Creates an attention request while enforcing approval-mode uniqueness in the same critical
   * section as the immutable inbox write. The check cannot race another request for this
   * workspace: both the scan and createEntryLocked() share the workspace mutex.
   *
   * The scan produces one of THREE answers, and the middle one is the whole point (R9: "at most
   * one non-terminal approval request may exist for that workspace/path"):
   *   - a candidate's payload proves a same-path approval is open      -> ApprovalConflictError
   *   - some candidate's payload could not be read at all              -> unprovable, fail closed
   *   - every candidate was read and positively ruled out              -> create
   *
   * `readInboxEntry` collapses "missing", "unparseable" and "EACCES" all into `null` (its own
   * contract: never throws). Reading that `null` as "not a match" would be a fail-OPEN on the
   * exact invariant this block exists to hold — one truncated, half-written or unreadable entry
   * file would make a live approval invisible and let a second one be created for the same path.
   * Absence of evidence is not evidence of absence, the same reasoning `reclaimIndexLock` applies
   * to a missing daemon lock (A4 §F21): a refused request is recoverable, a broken invariant is
   * not. So an unreadable candidate goes on `unprovable` rather than being skipped.
   *
   * A PROVEN conflict outranks an unprovable one, so the loop finishes (or breaks on the proof)
   * before deciding: a fact must never lose to a maybe just because the maybe was scanned first.
   * The scan also collects EVERY unreadable candidate instead of throwing on the first, so one
   * failed request tells the operator about all of the damage at once.
   *
   * Deliberately no try/catch: `readInboxEntry` cannot throw, and everything after it is property
   * access on a value already narrowed to a plain object — so nothing here has a failure that
   * warrants swallowing, and a throw that does escape is a programming error which must surface
   * rather than be silently re-read as "no conflict" (the class of bug being fixed here). */
  createAttentionRequest(id: string, payload: AttentionRequestPayload): Promise<void> {
    return this.mutex.runExclusive(this.mutexKey, () => {
      if (payload.approval_mode === true && payload.target_path) {
        const unprovable: string[] = [];
        let proven = false;
        for (const [entryId, state] of Object.entries(this.state.entries)) {
          if (state.kind !== "attention" || isTerminal("attention", state.status)) continue;
          const existing = readInboxEntry(this.workspace, entryId);
          // A non-object body (scalar, array, JSON `null`) is not an inbox payload this daemon
          // ever wrote — inbox files are write-once, so any deviation is corruption, and a
          // corrupted body cannot rule out what the entry originally was.
          if (existing === null || typeof existing !== "object" || Array.isArray(existing)) {
            unprovable.push(entryId);
            continue;
          }
          const record = existing as Record<string, unknown>;
          if (record.approval_mode === true && record.target_path === payload.target_path) {
            proven = true;
            break;
          }
        }
        if (proven) throw new ApprovalConflictError(payload.target_path);
        if (unprovable.length > 0) throw new ApprovalUniquenessUnprovableError(payload.target_path, unprovable);
      }
      this.createEntryLocked(id, payload);
    });
  }

  private createEntryLocked(
    id: string,
    payload: unknown,
    fields: Partial<Pick<JournalEvent, "by" | "idem" | "detail">> = {},
  ): void {
    this.assertWritable();
    writeInboxEntryOnce(this.workspace, id, payload);
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
  }

  /** Creates an active alias for a non-terminal source entry. The source payload is copied
   * byte-for-byte by the coordinator; its original journal remains the historical truth. */
  adoptEntry(id: string, payload: unknown, detail: Record<string, unknown>, idem: string): Promise<void> {
    return this.mutex.runExclusive(this.mutexKey, () => {
      this.assertWritable();
      writeInboxEntryOnce(this.workspace, id, payload);
      const event: JournalEvent = {
        v: 1,
        event_id: this.ulidFn(),
        at: this.nowFn().toISOString(),
        entry: id,
        event: "entry_adopted",
        by: "daemon",
        idem,
        detail: { ...detail },
      };
      appendEvent(this.writer, event);
      applyEvent(this.state, event, this.reducer);
      this.notify(event);
    });
  }

  attachLineage(detail: Record<string, unknown>, idem: string): Promise<void> {
    return this.mutex.runExclusive(this.mutexKey, () => {
      this.assertWritable();
      const event: JournalEvent = {
        v: 1,
        event_id: this.ulidFn(),
        at: this.nowFn().toISOString(),
        event: "lineage_attached",
        by: "daemon",
        idem,
        detail,
      };
      appendEvent(this.writer, event);
      applyEvent(this.state, event, this.reducer);
      this.notify(event);
    });
  }

  /** Sealing is itself a journalled state transition. It is intentionally checked inside the
   * same lock as apply-begin so a lease can never appear between the coordinator's check and the
   * source becoming read-only. */
  sealForAdoption(adoptionId: string, targetRegistrationId: string): Promise<void> {
    return this.mutex.runExclusive(this.mutexKey, () => this.sealForAdoptionLocked(adoptionId, targetRegistrationId));
  }

  /** The registry holds every source mutex before calling this. Keep the lease predicate here so
   * adoption uses the bus clock (including deterministic test clocks), not process wall time. */
  activeApplyLeaseIdForAdoptionLocked(): string | null {
    const active = this.state.applyLease;
    return active && !isLeaseExpired(active, this.nowFn()) ? active.leaseId : null;
  }

  /** Called by `WorkspaceBusRegistry#sealForAdoption` while its shared keyed mutex already holds
   * this registration. Kept public only to make the total lock ordering explicit at the one
   * cross-workspace call site. */
  sealForAdoptionLocked(adoptionId: string, targetRegistrationId: string): void {
    if (this.state.adoptionSeal) {
      if (this.state.adoptionSeal.adoptionId === adoptionId) return;
      throw new WorkspaceAdoptedError(this.state.adoptionSeal.targetRegistrationId);
    }
    const activeLeaseId = this.activeApplyLeaseIdForAdoptionLocked();
    if (activeLeaseId) throw leaseHeldError(activeLeaseId);
    const event: JournalEvent = {
      v: 1,
      event_id: this.ulidFn(),
      at: this.nowFn().toISOString(),
      event: "adoption_sealed",
      by: "daemon",
      idem: `adoption-seal:${adoptionId}`,
      detail: { adoption_id: adoptionId, target_registration_id: targetRegistrationId },
    };
    appendEvent(this.writer, event);
    applyEvent(this.state, event, this.reducer);
    this.notify(event);
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
  commitTransition(
    entryId: string,
    to: string,
    opts: { by?: EventBy; idem?: string; note?: string; detail?: Record<string, unknown> } = {},
  ): Promise<void> {
    return this.mutex.runExclusive(this.mutexKey, () => {
      this.assertWritable();
      const event: JournalEvent = {
        v: 1,
        event_id: this.ulidFn(),
        at: this.nowFn().toISOString(),
        entry: entryId,
        event: "transition_committed",
        by: opts.by ?? "daemon",
        ...(opts.idem !== undefined ? { idem: opts.idem } : {}),
        detail: { to, ...(opts.note !== undefined ? { note: opts.note } : {}), ...(opts.detail ?? {}) },
      };
      appendEvent(this.writer, event);
      applyEvent(this.state, event, this.reducer);
      this.notify(event);
    });
  }

  /** Marks an attention request as seen without letting concurrent/retried UI calls skip a
   * lifecycle edge. `open` first becomes `delivered`; terminal entries are stable no-ops. */
  markAttentionSeen(entryId: string): Promise<{ status: string; detail: Record<string, unknown> | null }> {
    return this.mutex.runExclusive(this.mutexKey, () => {
      this.assertWritable();
      const state = this.state.entries[entryId];
      if (!state || state.kind !== "attention") throw new Error("unknown attention request");
      if (state.status === "open") this.appendAttentionTransitionLocked(entryId, "delivered", { by: "daemon" });
      if (this.state.entries[entryId]?.status === "delivered")
        this.appendAttentionTransitionLocked(entryId, "seen", { by: "human" });
      const final = this.state.entries[entryId] as typeof state;
      return { status: final.status, detail: (final.detail as Record<string, unknown> | undefined) ?? null };
    });
  }

  /** Completes an attention request through every required intermediate state in one workspace
   * mutex section. A retry after `done` returns the original detail and appends nothing. */
  completeAttention(
    entryId: string,
    detail?: AttentionVerdict,
  ): Promise<{ status: string; detail: Record<string, unknown> | null }> {
    return this.mutex.runExclusive(this.mutexKey, () => {
      this.assertWritable();
      const state = this.state.entries[entryId];
      if (!state || state.kind !== "attention") throw new Error("unknown attention request");
      if (state.status === "done") {
        return { status: state.status, detail: (state.detail as Record<string, unknown> | undefined) ?? null };
      }
      if (!detail) throw new Error("attention verdict is required");
      if (isTerminal("attention", state.status)) throw new Error(`attention request is already ${state.status}`);
      if (state.status === "open") this.appendAttentionTransitionLocked(entryId, "delivered", { by: "daemon" });
      if (this.state.entries[entryId]?.status === "delivered")
        this.appendAttentionTransitionLocked(entryId, "seen", { by: "human" });
      this.appendAttentionTransitionLocked(entryId, "done", {
        by: "human",
        detail: { ...detail },
      });
      const final = this.state.entries[entryId] as typeof state;
      return { status: final.status, detail: (final.detail as Record<string, unknown> | undefined) ?? null };
    });
  }

  private appendAttentionTransitionLocked(
    entryId: string,
    to: string,
    opts: { by: EventBy; detail?: Record<string, unknown> },
  ): void {
    const event: JournalEvent = {
      v: 1,
      event_id: this.ulidFn(),
      at: this.nowFn().toISOString(),
      entry: entryId,
      event: "attention_committed",
      by: opts.by,
      detail: { to, ...(opts.detail ?? {}) },
    };
    appendEvent(this.writer, event);
    applyEvent(this.state, event, this.reducer);
    this.notify(event);
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
      idem?: string;
      fsync?: boolean;
      via?: DeliveryVia;
      session?: string;
      outcome?: DeliveryOutcome;
      reason?: DeliveryReason;
      error?: string;
    } = {},
  ): Promise<void> {
    return this.mutex.runExclusive(this.mutexKey, () => {
      this.assertWritable();
      this.recordDeliveryAttemptLocked(entryId, opts);
    });
  }

  /** The unlocked body `recordDeliveryAttempt` wraps in its own mutex critical section — pulled
   * out so delivery prepare/ack can call it from WITHIN an ALREADY-held critical section
   * without deadlocking (`KeyedMutex.runExclusive` is not reentrant — a nested call for the same
   * root would wait on itself forever). Never call this directly outside a critical section this
   * class already holds for `this.root`. */
  private recordDeliveryAttemptLocked(
    entryId: string,
    opts: {
      by?: EventBy;
      idem?: string;
      fsync?: boolean;
      via?: DeliveryVia;
      session?: string;
      outcome?: DeliveryOutcome;
      reason?: DeliveryReason;
      error?: string;
    },
  ): void {
    const { by, idem, fsync, ...detail } = opts;
    const hasDetail = Object.values(detail).some((v) => v !== undefined);
    const event: JournalEvent = {
      v: 1,
      event_id: this.ulidFn(),
      at: this.nowFn().toISOString(),
      entry: entryId,
      event: "delivery_attempt",
      by: by ?? "daemon",
      ...(idem !== undefined ? { idem } : {}),
      ...(hasDetail ? { detail } : {}),
    };
    appendEvent(this.writer, event, { fsync: fsync ?? false });
    applyEvent(this.state, event, this.reducer);
    this.notify(event);
  }

  private pruneDeliveryReservationsLocked(): void {
    const now = this.nowFn().getTime();
    for (const [token, reservation] of this.deliveryReservations) {
      if (reservation.expiresAt <= now) this.deliveryReservations.delete(token);
    }
  }

  /** Selects and formats entries under the workspace mutex, without claiming that the caller has
   * surfaced them. A later acknowledgement records the actual transport outcome. */
  prepareDelivery(
    limit: number,
    opts: { via: DeliveryVia; session: string; entryId?: string },
    build: (id: string, payload: unknown, status: string) => DeliverableEntry | null | Promise<DeliverableEntry | null>,
  ): Promise<PreparedDelivery> {
    return this.mutex.runExclusive(this.mutexKey, async () => {
      this.assertWritable();
      this.pruneDeliveryReservationsLocked();
      const reserved = new Set(
        Array.from(this.deliveryReservations.values()).flatMap((reservation) => reservation.entries),
      );
      const eligible = Object.entries(this.state.entries).filter(([id, entry]) => {
        if (opts.entryId && id !== opts.entryId) return false;
        if (reserved.has(id)) return false;
        const kind =
          entry.kind === "attention" ? "attention" : entry.kind === "conversation" ? "conversation" : "common";
        if (isTerminal(kind, entry.status)) return false;
        const payload = readInboxEntry(this.workspace, id);
        if (payload && typeof payload === "object") {
          const target = (payload as Record<string, unknown>).target_session_id;
          if (typeof target === "string" && target !== opts.session) return false;
        }
        const attempts = Array.isArray(entry.deliveryAttempts)
          ? (entry.deliveryAttempts as DeliveryAttemptRecord[])
          : [];
        // `transport_accepted` only proves that a channel/watcher accepted the payload, not that
        // it reached agent context. Only a post-output `presented` acknowledgement suppresses the
        // turn-boundary/MCP safety-net drain permanently.
        return !attempts.some((attempt) => attempt.outcome === "presented");
      });

      const presentations: DeliverableEntry[] = [];
      let batchBytes = 0;
      for (const [id, entry] of eligible) {
        if (presentations.length >= Math.min(Math.max(1, limit), MAX_DELIVERY_ENTRIES)) break;
        let presentation: DeliverableEntry | null = null;
        try {
          presentation = await build(id, readInboxEntry(this.workspace, id), entry.status);
        } catch (error) {
          const attempts = Array.isArray(entry.deliveryAttempts) ? entry.deliveryAttempts : [];
          this.recordDeliveryAttemptLocked(id, {
            via: opts.via,
            session: opts.session,
            outcome: "failed",
            reason: attempts.length > 0 ? "re_nudge" : "initial",
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        if (!presentation) {
          const attempts = Array.isArray(entry.deliveryAttempts) ? entry.deliveryAttempts : [];
          this.recordDeliveryAttemptLocked(id, {
            via: opts.via,
            session: opts.session,
            outcome: "failed",
            reason: attempts.length > 0 ? "re_nudge" : "initial",
            error: "entry_payload_not_actionable",
          });
          continue;
        }
        const presentationBytes = presentation.bytes;
        const separatorBytes = presentations.length > 0 ? Buffer.byteLength("\n\n---\n\n", "utf8") : 0;
        if (batchBytes + separatorBytes + presentationBytes > MAX_BATCH_PRESENTATION_BYTES) break;
        presentations.push(presentation);
        batchBytes += separatorBytes + presentationBytes;
      }

      const deliveryId = presentations.length > 0 ? this.ulidFn() : null;
      if (deliveryId) {
        this.deliveryReservations.set(deliveryId, {
          entries: presentations.map((presentation) => presentation.id),
          via: opts.via,
          session: opts.session,
          expiresAt: this.nowFn().getTime() + DELIVERY_RESERVATION_TTL_MS,
        });
      }
      return {
        delivery_id: deliveryId,
        drained: presentations,
        count: presentations.length,
        has_more: eligible.length > presentations.length,
      };
    });
  }

  acknowledgeDelivery(deliveryId: string, outcome: "presented" | "failed", error?: string): Promise<boolean> {
    return this.mutex.runExclusive(this.mutexKey, () => {
      this.assertWritable();
      this.pruneDeliveryReservationsLocked();
      const reservation = this.deliveryReservations.get(deliveryId);
      if (!reservation) return false;
      this.deliveryReservations.delete(deliveryId);
      for (const id of reservation.entries) {
        const attempts = this.state.entries[id]?.deliveryAttempts;
        const payload = readInboxEntry(this.workspace, id);
        const isConversation =
          payload !== null &&
          typeof payload === "object" &&
          (payload as Record<string, unknown>).kind === "conversation_message";
        this.recordDeliveryAttemptLocked(id, {
          via: reservation.via,
          session: reservation.session,
          outcome,
          reason: Array.isArray(attempts) && attempts.length > 0 ? "re_nudge" : "initial",
          ...(isConversation
            ? {
                fsync: true,
                idem: `conversation:${id}:attempt:${outcome}`,
              }
            : {}),
          ...(error ? { error } : {}),
        });
        if (isConversation && outcome === "presented" && this.state.entries[id]?.status !== "delivered") {
          const event: JournalEvent = {
            v: 1,
            event_id: this.ulidFn(),
            at: this.nowFn().toISOString(),
            entry: id,
            event: "transition_committed",
            by: "daemon",
            idem: `conversation:${id}:delivered`,
            detail: { to: "delivered" },
          };
          appendEvent(this.writer, event);
          applyEvent(this.state, event, this.reducer);
          this.notify(event);
        }
      }
      return true;
    });
  }

  /** Direct acknowledgement for a session-targeted conversation message. Channel transports do
   * not use the hook reservation token, so they acknowledge the immutable entry itself. */
  acknowledgeConversationMessage(
    entryId: string,
    opts: { session: string; via: DeliveryVia; outcome: "transport_accepted" | "presented" | "failed"; error?: string },
  ): Promise<boolean> {
    return this.mutex.runExclusive(this.mutexKey, () => {
      this.assertWritable();
      const payload = readInboxEntry(this.workspace, entryId);
      if (!payload || typeof payload !== "object") return false;
      const record = payload as Record<string, unknown>;
      if (record.kind !== "conversation_message" || record.target_session_id !== opts.session) return false;
      const entry = this.state.entries[entryId];
      if (!entry) return false;
      if (entry.status === "delivered") return true;
      const attempts = Array.isArray(entry.deliveryAttempts) ? entry.deliveryAttempts : [];
      const latest = attempts.at(-1);
      const sameChannelAttempt =
        latest?.via === opts.via && latest?.session === opts.session && latest?.outcome === "transport_accepted";
      this.recordDeliveryAttemptLocked(entryId, {
        fsync: true,
        idem: `conversation:${entryId}:attempt:${opts.outcome}`,
        via: opts.via,
        session: opts.session,
        outcome: opts.outcome,
        reason: sameChannelAttempt ? (latest.reason ?? "initial") : attempts.length > 0 ? "re_nudge" : "initial",
        ...(opts.error ? { error: opts.error } : {}),
      });
      if (opts.outcome === "presented" && this.state.entries[entryId]?.status !== "delivered") {
        const event: JournalEvent = {
          v: 1,
          event_id: this.ulidFn(),
          at: this.nowFn().toISOString(),
          entry: entryId,
          event: "transition_committed",
          by: "daemon",
          idem: `conversation:${entryId}:delivered`,
          detail: { to: "delivered" },
        };
        appendEvent(this.writer, event);
        applyEvent(this.state, event, this.reducer);
        this.notify(event);
      }
      return true;
    });
  }

  readEntry(id: string): { payload: unknown; status: string } | null {
    const state = this.state.entries[id];
    if (!state) return null;
    return { payload: readInboxEntry(this.workspace, id), status: state.status };
  }

  /** The ONE way a lease dies without a `resolve` having proven anything, shared by `applyBegin`
   * and `resolveEntry` so both provably do the same thing (A4 §F04 reconcile step 4 —
   * "apply_begin w/o apply_end & expired -> apply_expired, interval->unknown" — and §F05's
   * "Lease expiry -> apply_expired, diff->unknown").
   *
   * Reconcile implements exactly this at STARTUP, but startup is the one moment a long-lived
   * daemon never reaches: a session can stall past the 15-minute TTL while the daemon stays up
   * for days, so without an inline path the journal would hold an `apply_begin` no event ever
   * closes, and the interval since `pre_sha` would keep accumulating drift no lease covers.
   *
   * Event first, then checkpoint — the same order reconcile uses (step 4 appends `apply_expired`,
   * step 5 captures the drift as `unknown`): the journal records that the lease is dead BEFORE
   * anything is committed under it, so a crash between the two recovers to "lease already
   * expired, drift not yet captured", which reconcile's own step 5 then finishes. The reverse
   * order would recover to "commit exists, lease still nominally open" — a window in which the
   * next `resolve` could sweep an already-unknown-attributed commit into a session's diff. */
  private async expireLeaseLocked(lease: ApplyLeaseState): Promise<string> {
    const event: JournalEvent = {
      v: 1,
      event_id: this.ulidFn(),
      at: this.nowFn().toISOString(),
      entry: lease.entry,
      event: "apply_expired",
      by: "daemon", // never `session:<id>` — a lease that expired proved nothing for its holder
      detail: { lease_id: lease.leaseId },
    };
    appendEvent(this.writer, event);
    applyEvent(this.state, event, this.reducer);
    this.notify(event);

    // Captures whatever happened since `pre_sha` so nothing is silently lost — as `unknown`,
    // which is what A4 §F05 says an interval with no live lease over it is. Idempotent when
    // nothing actually drifted (`checkpoint` returns HEAD without committing).
    return checkpoint(this.workspace, {
      attribution: "unknown",
      kind: "apply_expired",
      entry: lease.entry,
      lease: lease.leaseId,
    });
  }

  /** `apply-begin` (A4 §F05): under this workspace's ONE git+journal mutex (the same slot every
   * other write to this workspace goes through, so a checkpoint here can never race a concurrent
   * journal append) — reject `LEASE_HELD` if a lease is already active and not expired (2nd
   * apply-begin never queues); if one is on record but EXPIRED, close it out honestly first
   * (`expireLeaseLocked`) rather than silently overwriting `state.applyLease` and leaving its
   * `apply_begin` dangling in the journal forever; then checkpoint the CURRENT state (attributed
   * `unknown` — whatever drifted before this lease started isn't this session's doing) as
   * `pre_sha`, and append `apply_begin` recording it plus a 15-minute expiry. */
  applyBegin(entry: string, sessionId: string): Promise<{ leaseId: string; preSha: string }> {
    return this.mutex.runExclusive(this.mutexKey, async () => {
      this.assertWritable();
      reclaimIndexLock(this.workspace, { writer: this.writer, ulid: this.ulidFn, now: this.nowFn });
      await initShadowRepo(this.workspace, { writer: this.writer, ulid: this.ulidFn, now: this.nowFn });

      const active = this.state.applyLease;
      if (active) {
        if (!isLeaseExpired(active, this.nowFn())) throw leaseHeldError(active.leaseId);
        await this.expireLeaseLocked(active);
      }

      const preSha = await checkpoint(this.workspace, { attribution: "unknown", kind: "pre_apply", entry });

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
   * attributing anything. A lease past its TTL throws `LEASE_EXPIRED` for the same reason, after
   * closing it out as `unknown` (see `expireLeaseLocked`). Guarded (first-terminal-wins,
   * illegal-from-status) transition rules belong to P2.5's `lifecycleReducer` — this just appends
   * the events `resolve` is defined to produce and lets whichever reducer this bus is running
   * fold them. */
  resolveEntry(
    entry: string,
    outcome: "applied" | "rejected" | "stale",
    sessionId: string,
    opts: { note?: string } = {},
  ): Promise<{ leaseId: string; postSha: string }> {
    return this.mutex.runExclusive(this.mutexKey, async () => {
      this.assertWritable();
      reclaimIndexLock(this.workspace, { writer: this.writer, ulid: this.ulidFn, now: this.nowFn });

      const lease = this.state.applyLease;
      if (!lease || lease.entry !== entry) throw noActiveLeaseError(entry);
      if (lease.session !== sessionId) throw leaseSessionMismatchError(entry, lease.session, sessionId);
      // The TTL is what BOUNDS the proof (A4 §F05). Past `expires_at` the pre..post diff no
      // longer describes "what this session did under a live lease" — it describes everything
      // that reached the worktree since `pre_sha`, including however many hours of drift arrived
      // by some other route while the session was stalled. Attributing that to `lease.session`
      // would be exactly the forged provenance §F05 exists to prevent, so close the lease out as
      // `unknown` and make the caller re-open a provable window. Deliberately AFTER the session
      // check: a caller that doesn't hold this lease never gets to drive someone else's lease to
      // expiry — the holder's own next `resolve`, the next `applyBegin`, or reconcile step 4 all
      // reach the same place, so nothing is lost by refusing a non-holder first.
      if (isLeaseExpired(lease, this.nowFn())) {
        await this.expireLeaseLocked(lease);
        throw leaseExpiredError(entry, lease.leaseId, lease.expiresAt);
      }

      // Attribution comes from the LEASE's own recorded session (the proven identity), not the
      // `sessionId` parameter — they're equal here (just checked above), but using `lease.session`
      // keeps the attributed value tied to what `applyBegin` actually proved, not to whatever this
      // call happened to be invoked with.
      const attributedSession = lease.session;
      const postSha = await checkpoint(this.workspace, {
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

  /** Serializes a glosa editor save/restore with its path-scoped shadow-git checkpoints and the
   * immutable `human_edit` inbox entry derived from the resulting unified diff. Holding the same
   * workspace mutex across before -> mutate -> checkpoint -> diff -> entry creation prevents an
   * unrelated filesystem change from being folded into this human-attributed edit. */
  captureHumanEdit(
    entryId: string,
    path: string,
    mutate: () => void,
    editKind: "edit" | "restore" = "edit",
  ): Promise<{ checkpoint_before: string; checkpoint_after: string } | null> {
    return this.mutex.runExclusive(this.mutexKey, async () => {
      this.assertWritable();
      reclaimIndexLock(this.workspace, { writer: this.writer, ulid: this.ulidFn, now: this.nowFn });
      await initShadowRepo(this.workspace, { writer: this.writer, ulid: this.ulidFn, now: this.nowFn });
      const before = await headSha(this.workspace);
      mutate();
      const after = await checkpoint(this.workspace, {
        attribution: "human",
        kind: editKind === "restore" ? "restore" : "human_edit",
        entry: entryId,
        paths: [path],
      });
      if (before === after) return null;
      const diff = (await runGit(this.workspace, ["diff", "-M", before, after, "--", safePathspec(path)])).stdout;
      this.createEntryLocked(entryId, {
        kind: "human_edit",
        edit_kind: editKind,
        checkpoint_before: before,
        checkpoint_after: after,
        files: [{ path, diff, diff_bytes: Buffer.byteLength(diff, "utf8") }],
      });
      return { checkpoint_before: before, checkpoint_after: after };
    });
  }

  humanEditCheckpoint(kind = "human_edit"): Promise<string> {
    return this.mutex.runExclusive(this.mutexKey, async () => {
      this.assertWritable();
      reclaimIndexLock(this.workspace, { writer: this.writer, ulid: this.ulidFn, now: this.nowFn });
      await initShadowRepo(this.workspace, { writer: this.writer, ulid: this.ulidFn, now: this.nowFn });
      return checkpoint(this.workspace, { attribution: "human", kind });
    });
  }

  /** Routed through the mutex so any write already in flight for this workspace finishes first —
   * `close()` then makes the writer terminal (see `JournalWriter#fd`'s `closed` guard), so a
   * write racing in from AFTER this call throws instead of silently reopening the fd. */
  close(): Promise<void> {
    return this.mutex.runExclusive(this.mutexKey, () => {
      this.writer.close();
    });
  }
}

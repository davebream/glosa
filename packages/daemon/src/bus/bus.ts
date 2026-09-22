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
import {
  assertShadowOwner,
  checkpoint,
  commitsTouching,
  headSha,
  initShadowRepo,
  inspectShadowRepo,
  isAncestorOrEqual,
  isPathDirty,
  type RepairShadowDeps,
  reclaimIndexLock,
  repairShadowBaseline,
  runGit,
  type ShadowHealth,
  ShadowHistoryError,
  safePathspec,
} from "../git/shadow.ts";
import { type WorkspaceTarget, workspaceRegistrationId, workspaceWorktree } from "../workspace.ts";
import {
  artifactPathOfResource,
  artifactResource,
  type Claim,
  type ClaimHolderSnapshot,
  type ClaimMode,
  entryIdOfResource,
  entryResource,
  holderBy,
  holderSnapshot,
  isClaimExpired,
  maxFenceOver,
  type Tombstone,
  type TombstoneReason,
  tombstoneFor,
} from "./claims.ts";
import { EXTERNAL_EDIT_CHECKPOINT_KIND, externalEditDetail, isExternalEditEntry } from "./external-edit.ts";
import { externalEditPayloads } from "./external-edit-capture.ts";
import { readInboxEntry, writeInboxEntryOnce } from "./inbox.ts";
import { appendEvent, type EventBy, type JournalEvent, JournalWriter } from "./journal.ts";
import {
  CLAIM_RENEW_GRACE_MS,
  claimHeldError,
  claimLimitError,
  claimTombstoneError,
  driftUnderLeaseError,
  EXCLUSIVE_CLAIM_TTL_MS,
  entryResolvedError,
  invalidResourceError,
  isLeaseExpired,
  leaseHeldError,
  MAX_CLAIMS_PER_SESSION,
  MAX_CLAIMS_PER_WORKSPACE,
  noClaimError,
  noSuchClaimError,
  PRESENCE_CLAIM_TTL_MS,
  unknownEntryError,
} from "./lease.ts";
import {
  type DeliveryAttemptRecord,
  type DeliveryOutcome,
  type DeliveryReason,
  type DeliveryVia,
  entryKindOf,
  isTerminal,
  lifecycleReducer,
} from "./lifecycle.ts";
import { KeyedMutex } from "./mutex.ts";
import { journalPath, quarantinePath, workspaceBusDir } from "./paths.ts";
import { peekJournal } from "./peek.ts";
import { type ReconcileOptions, type ReconcileResult, reconcileWorkspace, truncateTornTail } from "./reconcile.ts";
import { applyEvent, createEmptyState, type DerivedEntryState, type DerivedState, type Reducer } from "./replay.ts";
import { countJournalLines } from "./tail.ts";
import { ulid as defaultUlid } from "./ulid.ts";
import type { WorkspaceBusWriteCheckpointObserver } from "./write-checkpoint.ts";

const DELIVERY_RESERVATION_TTL_MS = 30_000;

interface DeliveryReservation {
  entries: string[];
  via: DeliveryVia;
  session: string;
  expiresAt: number;
}

/** What one quiet-window capture did. `suppressed` names WHY no entry was created despite a
 * commit landing, so a caller (and a test) can tell "glosa's own write, correctly silent" apart
 * from "nothing happened". */
export interface ExternalEditCapture {
  committed: boolean;
  suppressed: "apply_lease" | null;
  entries: string[];
}

export interface PreparedDelivery {
  delivery_id: string | null;
  drained: DeliverableEntry[];
  count: number;
  has_more: boolean;
}

/** A read-only delivery candidate used to merge several workspace journals before any entry is
 * reserved. `journal_order` is local to this workspace; `created_at` comes from the durable
 * entry-created/adopted journal event rather than inbox metadata or process memory. */
export interface PlannedDeliveryEntry {
  id: string;
  created_at: string;
  journal_order: number;
  presentation: DeliverableEntry | null;
}

export interface PlannedDelivery {
  entries: PlannedDeliveryEntry[];
  has_more: boolean;
}

export interface StandardAttentionVerdict {
  outcome: "done" | "approved" | "changes_requested";
  response?: string;
  /** The option the human picked, when the request offered any. Always accompanied by whatever
   * they typed: glosa's escape hatch is unconditional, so `chose` narrows an answer, never
   * replaces it. */
  chose?: string;
}

export interface ApprovalVerdict {
  outcome: "approved";
  target_path: string;
  revision_id: string;
  completed_at: string;
}

export type AttentionVerdict = StandardAttentionVerdict | ApprovalVerdict;

/** The passage an attention request points at, in the same W3C-ish shape annotations use
 * (`packages/spa/src/annotate.js` builds it, `anchoring.ts` resolves it). A request without one
 * concerns the whole artifact — that is `glosa request-review`'s existing shape, not a new case.
 *
 * `position` is deliberately absent: a session quotes SOURCE text it just wrote and has no view
 * of the rendered container's UTF-16 offsets, so an offset here would be a guess. The quote is
 * the whole anchor. */
export interface AttentionTarget {
  quote: { exact: string; prefix?: string; suffix?: string };
}

export interface AttentionRequestPayload {
  kind: "attention_request";
  message?: string;
  action: string;
  path?: string;
  target_path?: string;
  approval_mode?: true;
  /** Session-supplied display name ("api-refactor"). CLAIMED, never verified — the daemon stores
   * it verbatim and the SPA must render it as a claim beside the provider identity, which is the
   * only half a session binding actually proves (invariant 3). */
  agent_label?: string;
  target?: AttentionTarget;
  /** Session-supplied answer options. glosa always offers free text alongside them; a session
   * cannot close the human's vocabulary. */
  answer_options?: string[];
}

export class ApprovalConflictError extends Error {
  readonly code = "APPROVAL_CONFLICT";

  constructor(readonly targetPath: string) {
    super(`an approval request is already active for ${targetPath}`);
  }
}

/** R9's "at most one non-terminal approval request per workspace/path" is proven from additive
 * `entry_created.detail` facts for new entries. Legacy events without those facts fall back to
 * their immutable inbox payloads; when such a payload cannot be read, the scan has neither proven
 * a conflict nor proven there is none, and those are different answers that must not collapse.
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

/** Mirrors `WorkspaceAdoptedError` for the identical shape of problem: a durable, permanent
 * bus-level write-lock (issue #156's `forget_sealed`) that every mutator must respect regardless
 * of what an in-memory caller believed a moment earlier. */
export class WorkspaceForgottenError extends Error {
  constructor() {
    super("workspace is being permanently deleted (glosa forget) and no longer accepts writes");
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
/** What `WorkspaceBus.claim` hands back. `fence` is `null` only when renewing a legacy
 * apply-lease folded forward from before fencing existed. */
export interface ClaimResult {
  claimId: string;
  fence: number | null;
  expiresAt: string;
  paths: string[];
  preSha?: string;
  renewed: boolean;
}

/** The artifact paths an immutable inbox payload names: `artifact_path` (annotations),
 * `target_path`/`path` (attention requests, external edits), `files[].path` (human edits). */
function pathsOfPayload(payload: unknown): string[] {
  if (typeof payload !== "object" || payload === null) return [];
  const record = payload as Record<string, unknown>;
  const paths = new Set<string>();
  for (const key of ["artifact_path", "target_path", "path"]) {
    const value = record[key];
    if (typeof value === "string" && isConfinedRelativePath(value)) paths.add(value);
  }
  if (Array.isArray(record.files)) {
    for (const file of record.files) {
      const path = (file as { path?: unknown } | null)?.path;
      if (typeof path === "string" && isConfinedRelativePath(path)) paths.add(path);
    }
  }
  return [...paths];
}

/** Workspace-relative, no escape, no absolute root, no empty segment. The route layer validates
 * too; this is the bus refusing to let a bad string reach a checkpoint pathspec regardless. */
function isConfinedRelativePath(path: string): boolean {
  if (path.length === 0 || path.startsWith("/") || path.includes("\0")) return false;
  return path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

/** Whether two claims (or a claim and a request) cover overlapping ground. Shared resources
 * collide outright; otherwise paths decide, and an EMPTY path set on either side means "the whole
 * workspace" — its checkpoints are unscoped, so it overlaps everything. */
function claimsCollide(
  claim: Pick<Claim, "resources" | "paths">,
  request: { resources: readonly string[]; paths: readonly string[] },
): boolean {
  if (claim.resources.some((resource) => request.resources.includes(resource))) return true;
  if (claim.paths.length === 0 || request.paths.length === 0) return true;
  return claim.paths.some((path) => request.paths.includes(path));
}

function firstEntryOf(claim: Claim): string | undefined {
  return claim.resources.map(entryIdOfResource).find((id): id is string => id !== null);
}

async function anyPathDirty(workspace: WorkspaceTarget, paths: readonly string[]): Promise<boolean> {
  for (const path of paths) if (await isPathDirty(workspace, path)) return true;
  return false;
}

export interface WorkspaceBusDeps {
  /** Shared across every WorkspaceBus in the daemon process so different workspaces never share
   * a mutex slot, but the same workspace (opened twice) does. Defaults to a private one, which is
   * fine for a single WorkspaceBus but wrong if the daemon opens the same workspace root twice —
   * callers doing that must pass a shared instance. */
  mutex?: KeyedMutex<string>;
  ulid?: () => string;
  now?: () => Date;
  reducer?: Reducer;
  /** Explicit composition seam for subprocess durability tests. Production omits it. */
  writeCheckpoint?: WorkspaceBusWriteCheckpointObserver;
  /** Production offloads complete matcher walks; omitted in unit tests for deterministic sync. */
  resolveTrackedFilesAsync?: ReconcileOptions["resolveTrackedFilesAsync"];
  resolveTrackedFilesSync?: ReconcileOptions["resolveTrackedFilesSync"];
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
  private readonly writeCheckpoint?: WorkspaceBusWriteCheckpointObserver;
  private readonly resolveTrackedFilesAsync?: ReconcileOptions["resolveTrackedFilesAsync"];
  private readonly resolveTrackedFilesSync?: ReconcileOptions["resolveTrackedFilesSync"];
  private readonly mutexKey: string;
  // P3.1 review fix: tracks whether THIS INSTANCE has reconciled — deliberately an instance field,
  // not something a caller tracks externally keyed by root string. A root string survives a
  // WorkspaceBusRegistry evict()+reopen (WorkspaceIndex hard-remove → onHardRemove → evict → a
  // later getWorkspaceBus(root) constructs a brand-new WorkspaceBus); an external "have I
  // reconciled root X" cache would then wrongly believe the NEW instance is already reconciled
  // and skip its journal replay/self-heal/offline-catchup forever. Living on the instance means a
  // fresh instance is un-reconciled by construction — no external bookkeeping to keep in sync.
  private reconciledOnce = false;
  /** Hydration is THREE states, not two (review round 4). `reconciledOnce` is claimed synchronously
   * before `reconcile()` is awaited, so it means "a reconcile has STARTED" — reading it as
   * "hydrated" let a concurrent watch skip its own fold, queue behind that reconcile, and then
   * answer from default empty state if it failed. `reconcileSettled` is the only flag that means
   * the derived state actually reflects the journal. */
  private reconcileSettled = false;
  private reconcileInFlight: Promise<unknown> | null = null;
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
  // #153 Part 2 (W3): a held watch's "workspace eviction/forget/close" abort source. Fires exactly
  // once, from `close()` — the same call `WorkspaceBusRegistry.evict`/`.close` make on a hard
  // remove or an explicit reopen, and the one `glosa forget`'s `onHardRemove` wiring reaches. A
  // held watch on THIS instance combines `closeSignal()` into its abort set so a workspace that
  // disappears out from under it ends the hold instead of leaving it subscribed to a bus nothing
  // will ever notify again.
  private readonly closeController = new AbortController();

  private assertWritable(): void {
    if (this.state.adoptionSeal) throw new WorkspaceAdoptedError(this.state.adoptionSeal.targetRegistrationId);
    if (this.state.forgetSeal) throw new WorkspaceForgottenError();
  }

  /** Explicit repair shares the journal/lease/watcher lock. Lifecycle validation must run
   * AFTER acquiring it: parent adoption can mark this source under a different coordinator key. */
  repairBaseline(validateLocked: () => void, afterStep?: RepairShadowDeps["afterStep"]): Promise<ShadowHealth> {
    return this.mutex.runExclusive(this.mutexKey, async () => {
      validateLocked();
      assertShadowOwner();
      this.state = peekJournal(this.workspace).state;
      this.assertWritable();
      if (this.state.applyLease && !isLeaseExpired(this.state.applyLease, this.nowFn())) {
        throw leaseHeldError(this.state.applyLease.leaseId);
      }
      const health = await inspectShadowRepo(this.workspace);
      if (health.state === "healthy")
        throw Object.assign(new Error("Shadow history is already healthy; no baseline was replaced."), {
          code: "SHADOW_ALREADY_HEALTHY",
        });
      if (health.state === "invalid-head") throw new ShadowHistoryError(health);
      truncateTornTail({
        journalPath: journalPath(this.workspace),
        quarantinePath: quarantinePath(this.workspace),
        writer: this.writer,
        ulid: this.ulidFn,
        now: this.nowFn,
      });
      const result = await repairShadowBaseline(this.workspace, {
        writer: this.writer,
        ulid: this.ulidFn,
        now: this.nowFn,
        afterStep,
      });
      this.state = peekJournal(this.workspace).state;
      this.nextSequence = countJournalLines(journalPath(this.workspace));
      return result;
    });
  }

  constructor(workspaceRoot: WorkspaceTarget, deps: WorkspaceBusDeps = {}) {
    this.workspace = workspaceRoot;
    this.root = workspaceWorktree(workspaceRoot);
    this.mutexKey = workspaceRegistrationId(workspaceRoot);
    mkdirSync(workspaceBusDir(workspaceRoot), { recursive: true });
    this.writeCheckpoint = deps.writeCheckpoint;
    this.resolveTrackedFilesAsync = deps.resolveTrackedFilesAsync;
    this.resolveTrackedFilesSync = deps.resolveTrackedFilesSync;
    this.writer = new JournalWriter(journalPath(workspaceRoot), this.writeCheckpoint);
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
    const running = this.reconcile()
      .then((result) => {
        this.reconcileSettled = true;
        return result;
      })
      .catch((err) => {
        this.reconciledOnce = false;
        throw err;
      })
      .finally(() => {
        this.reconcileInFlight = null;
      });
    // Held so a concurrent reader can WAIT for this pass rather than racing it. Its rejection is
    // observed by `hydrateForRead`'s own catch as well as by this caller, so a failing reconcile
    // never surfaces as an unhandled rejection just because a reader also looked at it.
    this.reconcileInFlight = running;
    return running;
  }

  /** Whether THIS instance has folded its journal yet. The read-only watch route checks it rather
   * than assuming a route order put a reconcile ahead of it: buses do not survive a restart, and a
   * binding can reach a fresh instance through revival after eviction, or
   * through a bind whose own hydration failed. An unreconciled instance serves empty derived state
   * that is indistinguishable from "nothing to report" — see `resolveBusForRead`. */
  hasReconciled(): boolean {
    return this.reconcileSettled;
  }

  /** Folds the journal into this instance's derived state WITHOUT writing anything — no self-heal,
   * no lease expiry, no drift commit, no catch-up. The read-only half of what `reconcile()` does.
   *
   * This is what lets `GET /w/:slug/watch` answer correctly off an instance nobody has reconciled
   * yet (review round 3, F-8): buses do not survive a restart, and a binding can reach a fresh one
   * through revival after eviction, or through an attach whose own best-effort hydration
   * failed. Without this the watch would serve EMPTY derived state, which a caller cannot tell
   * apart from "nothing to report" — a silent wrong answer.
   *
   * What it deliberately does NOT do is offline catch-up, because that writes. Drift that landed
   * while the daemon was down is reported when a session attaches (`session-binding` and a
   * binding-carrying `register` both reconcile), not by this call.
   *
   * Pinned at this level rather than through HTTP, because the paths that DO reach a cold bus are
   * awkward to drive from a request: a bus evicted by GC or `glosa forget` while its binding
   * survives, and an attach whose best-effort hydration threw. Both are real; neither is a route a
   * test can simply call. `A9` opens a fresh bus over an existing
   * journal, proves the entry is returned and the journal bytes are unchanged, and proves a FAILING
   * in-flight reconcile is waited for and then folded past rather than answered empty.
   *
   * What stays absent, deliberately: drift that a failed attach reconcile never committed. Folding
   * the journal cannot invent entries for it, so it appears at the next successful writer
   * reconciliation. The read is honest about the journal and promises no catch-up it has not run. */
  async hydrateForRead(): Promise<void> {
    if (this.reconcileSettled) return;
    // In flight: wait for it rather than folding underneath it. If it FAILS, fall through and fold,
    // because a failed reconcile leaves the default empty state behind — the silent-empty answer
    // this method exists to prevent.
    if (this.reconcileInFlight) {
      await this.reconcileInFlight.catch(() => {});
      if (this.reconcileSettled) return;
    }
    // Under the workspace mutex, so the fold cannot interleave with a writer mutating the same
    // fields, and re-checked inside because a reconcile may have settled while this queued.
    await this.mutex.runExclusive(this.mutexKey, () => {
      if (this.reconcileSettled) return;
      this.state = peekJournal(this.workspace).state;
      this.nextSequence = countJournalLines(journalPath(this.workspace));
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
        resolveTrackedFilesAsync: this.resolveTrackedFilesAsync,
        resolveTrackedFilesSync: this.resolveTrackedFilesSync,
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

  /** Test-only: the very mutex this bus serialises its writes on, so a test can OCCUPY it and make
   * the queue-wait window real instead of hoping for a timing coincidence. Exposed because the
   * defect it pins — authority re-read after the queue wait rather than before it — is invisible
   * unless something is actually holding the lock. */
  mutexForTest(): KeyedMutex<string> {
    return this.mutex;
  }

  /** Test/diagnostic-only: how many live subscribers this bus currently has. Lets a test prove a
   * disconnected SSE client's `unsubscribe()` actually ran (no lingering listener) without this
   * class exposing its `listeners` set directly. */
  listenerCount(): number {
    return this.listeners.size;
  }

  /** See the field docstring above — fires once, from `close()`. */
  closeSignal(): AbortSignal {
    return this.closeController.signal;
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
   * transition table (attention vs. common). `fields.detail` may add unrelated metadata, but the
   * payload remains authoritative for reserved identity keys: `kind`, and for attention requests
   * `approval_mode`/`target_path`. */
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
   *   - journal state (or a legacy payload) proves a same-path approval -> ApprovalConflictError
   *   - a legacy candidate's payload could not be read                  -> unprovable, fail closed
   *   - journal state / readable legacy payload rules out every entry   -> create
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

          // New entry_created events explicitly record `approval_mode` for every attention
          // request and `target_path` for approvals. Those journal-derived facts are sufficient:
          // false rules the candidate out, while true + a target proves either conflict or a
          // different artifact. Missing/incomplete facts identify an N-1 event and retain W21's
          // fail-closed inbox fallback below.
          if (state.approval_mode === false) continue;
          if (state.approval_mode === true && typeof state.target_path === "string") {
            if (state.target_path === payload.target_path) {
              proven = true;
              break;
            }
            continue;
          }

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
    writeInboxEntryOnce(this.workspace, id, payload, this.writeCheckpoint);
    const payloadRecord =
      payload !== null && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : undefined;
    const payloadKind = typeof payloadRecord?.kind === "string" ? payloadRecord.kind : undefined;
    const detail: Record<string, unknown> | undefined =
      payloadKind !== undefined || fields.detail !== undefined ? { ...(fields.detail ?? {}) } : undefined;
    // `kind` selects the fold's transition table; `payload_kind` is the immutable payload's own
    // kind, recorded under one key by all three producers of an entry (here, `adoptEntry`, and
    // reconcile's `selfHealInbox`) so a read-only fold can tell an `external_edit` from an
    // `annotation` without reopening the inbox file. They happen to be equal on this path and are
    // NOT the same fact — on the adoption path `kind` is the lifecycle kind.
    if (detail && payloadKind !== undefined) detail.kind = payloadKind;
    if (detail && payloadKind !== undefined) detail.payload_kind = payloadKind;
    if (detail && payloadKind === "attention_request") {
      const approvalMode = payloadRecord?.approval_mode === true;
      detail.approval_mode = approvalMode;
      if (approvalMode && typeof payloadRecord.target_path === "string") detail.target_path = payloadRecord.target_path;
      else delete detail.target_path;
    }
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
      writeInboxEntryOnce(this.workspace, id, payload, this.writeCheckpoint);
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

  /** `glosa forget`'s own atomic commit point (issue #156): checked inside the SAME lock as
   * `apply-begin`/every other mutator, exactly like `sealForAdoptionLocked` above, so a lease can
   * never appear between the caller's preflight check and this bus becoming permanently
   * read-only. Throws `LEASE_HELD` (mirroring adoption's identical refusal) when an unexpired
   * apply-lease is active — sealing over one would silently strand its proven pre..post interval
   * mid-flight, the exact honest-provenance violation A4 §F05 exists to prevent. Idempotent:
   * sealing an already-forget-sealed bus is a no-op, so a resumed `glosa forget` that reaches this
   * again (it won't — the caller skips it on resume — but a defensive caller might) never double
   * appends. */
  sealForForget(): Promise<void> {
    return this.mutex.runExclusive(this.mutexKey, () => this.sealForForgetLocked());
  }

  private sealForForgetLocked(): void {
    if (this.state.forgetSeal) return;
    const activeLeaseId = this.activeApplyLeaseIdForAdoptionLocked();
    if (activeLeaseId) throw leaseHeldError(activeLeaseId);
    const event: JournalEvent = {
      v: 1,
      event_id: this.ulidFn(),
      at: this.nowFn().toISOString(),
      event: "forget_sealed",
      by: "daemon",
      idem: `forget-seal:${this.mutexKey}`,
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

  /** A session takes back its own open question (issue #310): the human cancelled the call, so
   * nobody is listening for the answer any more and the card would otherwise sit in the margin
   * offering "Send answer" to no one. Terminal `expired`, attributed to the session that asked —
   * a session's own claim, not a lease-proven fact, exactly as `resolve … deferred`'s `by`.
   *
   * First-terminal-wins: on an already-terminal entry this appends NOTHING and reports
   * `withdrawn:false`, so a human answer that raced the cancellation keeps the answer. */
  withdrawAttention(
    entryId: string,
    session: string,
  ): Promise<{ status: string; detail: Record<string, unknown> | null; withdrawn: boolean }> {
    return this.mutex.runExclusive(this.mutexKey, () => {
      this.assertWritable();
      const state = this.state.entries[entryId];
      if (!state || state.kind !== "attention") throw new Error("unknown attention request");
      if (isTerminal("attention", state.status)) {
        return {
          status: state.status,
          detail: (state.detail as Record<string, unknown> | undefined) ?? null,
          withdrawn: false,
        };
      }
      // `withdrawn` is the key `withdrawAnnotation` already writes on its own terminal, so a later
      // reader has one vocabulary for "taken back" rather than one per entry kind.
      this.appendAttentionTransitionLocked(entryId, "expired", {
        by: `session:${session}`,
        detail: { withdrawn: true },
      });
      const final = this.state.entries[entryId] as typeof state;
      return {
        status: final.status,
        detail: (final.detail as Record<string, unknown> | undefined) ?? null,
        withdrawn: true,
      };
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

  private eligibleDeliveryEntriesLocked(opts: {
    session: string;
    entryId?: string;
    excludeEntryIds?: ReadonlySet<string>;
  }): Array<[string, DerivedState["entries"][string], unknown]> {
    const reserved = new Set(
      Array.from(this.deliveryReservations.values()).flatMap((reservation) => reservation.entries),
    );
    const eligible: Array<[string, DerivedState["entries"][string], unknown]> = [];
    for (const [id, entry] of Object.entries(this.state.entries)) {
      if (opts.entryId && id !== opts.entryId) continue;
      if (opts.excludeEntryIds?.has(id)) continue;
      if (reserved.has(id)) continue;
      const kind = entry.kind === "attention" ? "attention" : entry.kind === "conversation" ? "conversation" : "common";
      if (isTerminal(kind, entry.status)) continue;
      // NOT DELIVERABLE BY ORDINARY DELIVERY (#153): an `external_edit` reports that a file
      // changed on disk with nothing to attribute it to. There is no action for a session to take
      // on it — it cannot be "applied", and the change is already in the artifact — so it is
      // excluded from this gate rather than
      // left to fail presentation, which would journal a `delivery_attempt{outcome:"failed"}` on
      // every drain for an entry that was never meant to be offered. This is the single gate
      // feeding BOTH `previewDelivery` and `prepareDelivery` (A5 §F23), so one exclusion covers
      // both; a fold added later is outside this method's reach.
      if (isExternalEditEntry(entry)) continue;
      const payload = readInboxEntry(this.workspace, id);
      if (payload && typeof payload === "object") {
        const target = (payload as Record<string, unknown>).target_session_id;
        if (typeof target === "string" && target !== opts.session) continue;
      }
      const attempts = Array.isArray(entry.deliveryAttempts) ? (entry.deliveryAttempts as DeliveryAttemptRecord[]) : [];
      // `transport_accepted` only proves that a push transport (monitor or codex_app_server)
      // accepted the payload, not that it reached agent context. Only a post-output `presented`
      // acknowledgement suppresses the MCP-pull safety-net drain permanently.
      if (attempts.some((attempt) => attempt.outcome === "presented")) continue;
      eligible.push([id, entry, payload]);
    }
    return eligible;
  }

  /** Plans at most eight locally-oldest eligible presentations under this workspace's mutex but
   * does not reserve, discard, or append anything. A cross-workspace coordinator can therefore
   * compute one global order/cap first, then reserve the exact selected ids. A concurrent drain
   * between these two phases is detected by the exact-id prepare returning no item; callers must
   * roll back every reservation they already acquired rather than substitute another entry. */
  previewDelivery(
    limit: number,
    opts: { session: string; entryId?: string; excludeEntryIds?: ReadonlySet<string> },
    build: (id: string, payload: unknown, status: string) => DeliverableEntry | null | Promise<DeliverableEntry | null>,
  ): Promise<PlannedDelivery> {
    return this.mutex.runExclusive(this.mutexKey, async () => {
      this.assertWritable();
      this.pruneDeliveryReservationsLocked();
      const { createdAt, entryOrder } = peekJournal(this.workspace);
      const planned: PlannedDeliveryEntry[] = [];
      const eligible = this.eligibleDeliveryEntriesLocked(opts);
      for (const [id, entry, payload] of eligible) {
        planned.push({
          id,
          created_at: createdAt.get(id) ?? "9999-12-31T23:59:59.999Z",
          journal_order: entryOrder.get(id) ?? Number.MAX_SAFE_INTEGER,
          presentation: await build(id, payload, entry.status),
        });
        if (planned.length >= Math.min(Math.max(1, limit), MAX_DELIVERY_ENTRIES)) break;
      }
      return { entries: planned, has_more: eligible.length > planned.length };
    });
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
      const eligible = this.eligibleDeliveryEntriesLocked(opts);

      const presentations: DeliverableEntry[] = [];
      let batchBytes = 0;
      for (const [id, entry, payload] of eligible) {
        if (presentations.length >= Math.min(Math.max(1, limit), MAX_DELIVERY_ENTRIES)) break;
        let presentation: DeliverableEntry | null = null;
        try {
          presentation = await build(id, payload, entry.status);
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

  /** Releases an unacknowledged reservation without appending a delivery attempt. Composite
   * preparation uses this on every already-prepared constituent if a later exact-id reservation
   * fails or the freshly rebuilt presentation no longer fits the global cap. */
  cancelDelivery(deliveryId: string): Promise<boolean> {
    return this.mutex.runExclusive(this.mutexKey, () => {
      this.pruneDeliveryReservationsLocked();
      return this.deliveryReservations.delete(deliveryId);
    });
  }

  readEntry(id: string): { payload: unknown; status: string } | null {
    const state = this.state.entries[id];
    if (!state) return null;
    return { payload: readInboxEntry(this.workspace, id), status: state.status };
  }

  // -------------------------------------------------------------------------------------------
  // Claims (issue #155, A4 §F05). One exclusive claim per resource replaces the one apply-lease
  // per workspace. Every method here runs under this workspace's ONE git+journal mutex, so the
  // decision ("may this session take / resolve this?") and the write it licenses are atomic —
  // a refusal can never be overtaken by a concurrent grant between the check and the append.
  // -------------------------------------------------------------------------------------------

  private appendClaimEventLocked(event: JournalEvent): void {
    appendEvent(this.writer, event);
    applyEvent(this.state, event, this.reducer);
    this.notify(event);
  }

  /** The workspace-relative paths an entry is about, read from its immutable payload (and the
   * journal-derived `target_path` approvals carry). An entry that names no path yields `[]`, and
   * an empty path set means "the whole workspace" everywhere below — its checkpoints are
   * unscoped, so it must be treated as covering every file. */
  private entryPathsLocked(entryId: string): string[] {
    const paths = new Set<string>();
    const derived = this.state.entries[entryId];
    if (typeof derived?.target_path === "string") paths.add(derived.target_path);
    for (const path of pathsOfPayload(readInboxEntry(this.workspace, entryId))) paths.add(path);
    return [...paths].sort();
  }

  /** Validates `resources` and returns them deduplicated plus the normalized path set they cover.
   * An `entry:` resource must name an entry this workspace owns (a claim over a foreign id proves
   * nothing and would still block real work — see `unknownEntryError`). */
  private normalizeClaimRequestLocked(resources: readonly string[]): { resources: string[]; paths: string[] } {
    const unique = [...new Set(resources)];
    if (unique.length === 0) throw invalidResourceError("");
    const paths = new Set<string>();
    let wholeWorkspace = false;
    for (const resource of unique) {
      const entryId = entryIdOfResource(resource);
      if (entryId !== null) {
        if (!this.state.entries[entryId]) throw unknownEntryError(entryId);
        const entryPaths = this.entryPathsLocked(entryId);
        if (entryPaths.length === 0) wholeWorkspace = true;
        for (const path of entryPaths) paths.add(path);
        continue;
      }
      const path = artifactPathOfResource(resource);
      if (path === null || !isConfinedRelativePath(path)) throw invalidResourceError(resource);
      paths.add(path);
    }
    // One pathless entry makes the whole claim whole-workspace: its checkpoints cannot be scoped,
    // so listing the other paths would understate what it covers.
    return { resources: unique, paths: wholeWorkspace ? [] : [...paths].sort() };
  }

  /** Every claim the fold still holds, exclusive and presence, deduplicated by id. Includes
   * TTL-lapsed claims — callers decide what lapsed means for them. */
  private heldClaimsLocked(): Claim[] {
    const seen = new Set<string>();
    const held: Claim[] = [];
    for (const slot of Object.values(this.state.claims)) {
      for (const claim of [slot.exclusive, ...slot.presence]) {
        if (!claim || seen.has(claim.claim_id)) continue;
        seen.add(claim.claim_id);
        held.push(claim);
      }
    }
    return held;
  }

  private heldClaimByIdLocked(claimId: string): Claim | null {
    return this.heldClaimsLocked().find((claim) => claim.claim_id === claimId) ?? null;
  }

  /** The other session's exclusive claim that `request` would collide with, if any. Collision is
   * decided over PATHS, not resource strings — two entries against the same artifact are not
   * disjoint — and an empty path set on either side covers everything. `includeLapsed` keeps a
   * TTL-lapsed claim in view for the resolve ladder, where a non-holder must never be the one to
   * drive another session's claim to expiry. */
  private blockingClaimLocked(
    sessionId: string,
    request: { resources: readonly string[]; paths: readonly string[] },
    now: Date,
    includeLapsed = false,
  ): Claim | null {
    for (const claim of this.heldClaimsLocked()) {
      if (claim.mode !== "exclusive" || claim.holder_session === sessionId) continue;
      if (!includeLapsed && isClaimExpired(claim, now)) continue;
      if (claimsCollide(claim, request)) return claim;
    }
    return null;
  }

  /** `claim_expired` first, then an `unknown` checkpoint scoped to the claim's paths, then one
   * `external_edit` entry per changed file — so the interval a claim died without proving is on
   * record, attributed to nobody, and the NEXT agent to look sees the bytes the holder left
   * behind (issue #155 REQ-7). Event first for the same reason the old lease expiry did it: a
   * crash between the two recovers to "claim already dead, drift not yet captured", which the
   * watcher or offline catch-up then finishes; the reverse order would recover to "commit exists,
   * claim still nominally open", and the holder's next resolve could sweep an unknown commit into
   * its own interval. */
  private async expireClaimLocked(claim: Claim, reason: "ttl" | "holder_stale"): Promise<string> {
    const entry = firstEntryOf(claim);
    this.appendClaimEventLocked({
      v: 1,
      event_id: this.ulidFn(),
      at: this.nowFn().toISOString(),
      ...(entry ? { entry } : {}),
      event: "claim_expired",
      by: "daemon", // never `session:<id>` — a claim that expired proved nothing for its holder
      detail: { claim_id: claim.claim_id, holder_session: claim.holder_session, reason },
    });
    return this.captureAbandonedIntervalLocked(claim, "claim_expired");
  }

  /** Commits whatever the holder of a claim that ended WITHOUT a resolve left on disk, as
   * `unknown`, and reports it as `external_edit` entries. Presence claims cover no interval, so
   * there is nothing to capture for them. */
  private async captureAbandonedIntervalLocked(
    claim: Claim,
    kind: "claim_expired" | "claim_released",
  ): Promise<string> {
    const since = await headSha(this.workspace);
    if (claim.mode !== "exclusive") return since;
    const entry = firstEntryOf(claim);
    const until = await checkpoint(this.workspace, {
      attribution: "unknown",
      kind,
      ...(entry ? { entry } : {}),
      lease: claim.claim_id,
      ...(claim.paths.length > 0 ? { paths: claim.paths } : {}),
    });
    if (until === since) return until;
    const payloads = await externalEditPayloads(this.workspace, since, until, "live", this.nowFn().toISOString());
    for (const payload of payloads) {
      this.createEntryLocked(this.ulidFn(), payload, { by: "watcher", detail: externalEditDetail(payload) });
    }
    return until;
  }

  /** Ends a live claim without a resolve. `by: "human"` is the human-wins override (issue #155
   * REQ-6): it needs no session and cannot be refused. Either way the interval since `pre_sha` is
   * no longer provable for the holder, so it is captured as `unknown`. */
  private async releaseClaimLocked(claim: Claim, by: "human" | "session", reason: TombstoneReason): Promise<void> {
    const entry = firstEntryOf(claim);
    this.appendClaimEventLocked({
      v: 1,
      event_id: this.ulidFn(),
      at: this.nowFn().toISOString(),
      ...(entry ? { entry } : {}),
      event: "claim_released",
      by: by === "human" ? "human" : holderBy(claim),
      detail: { claim_id: claim.claim_id, by, reason, holder_session: claim.holder_session },
    });
    await this.captureAbandonedIntervalLocked(claim, "claim_released");
  }

  private renewClaimLocked(claim: Claim, ttlMs: number, now: Date): string {
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    const entry = firstEntryOf(claim);
    this.appendClaimEventLocked({
      v: 1,
      event_id: this.ulidFn(),
      at: now.toISOString(),
      ...(entry ? { entry } : {}),
      event: "claim_renewed",
      by: holderBy(claim),
      detail: { claim_id: claim.claim_id, expires_at: expiresAt },
    });
    return expiresAt;
  }

  /** Takes (or renews) a claim. Order matters, and every step before the append is refusable
   * without side effects beyond `git_index_lock_reclaimed`:
   *   1. the caller's own claim already covering these resources → renew it, fence unchanged
   *      (REQ-3: re-claiming your own resource is never a conflict);
   *   2. claims touching this request whose TTL has lapsed are closed out honestly first, so the
   *      new holder never silently inherits — or supersedes — a dead interval;
   *   3. another session's exclusive claim over any of these paths → `CLAIM_HELD`, holder inline;
   *   4. bounds;
   *   5. for an exclusive claim, drift already on the claimed paths is reported as
   *      `external_edit`, then `pre_sha` is checkpointed scoped to exactly those paths. */
  private async claimLocked(
    resources: readonly string[],
    mode: ClaimMode,
    sessionId: string,
    principal: string,
    ttlMs?: number,
  ): Promise<ClaimResult> {
    const request = this.normalizeClaimRequestLocked(resources);
    const now = this.nowFn();
    const cap = mode === "presence" ? PRESENCE_CLAIM_TTL_MS : EXCLUSIVE_CLAIM_TTL_MS;
    const ttl = Math.min(Math.max(1, Math.floor(ttlMs ?? cap)), cap);

    const own = this.heldClaimsLocked().find(
      (claim) =>
        claim.holder_session === sessionId &&
        claim.mode === mode &&
        request.resources.every((resource) => claim.resources.includes(resource)),
    );
    if (own) {
      const expiresAt = this.renewClaimLocked(own, ttl, now);
      return {
        claimId: own.claim_id,
        fence: own.fence,
        expiresAt,
        paths: own.paths,
        ...(own.pre_sha ? { preSha: own.pre_sha } : {}),
        renewed: true,
      };
    }

    for (const lapsed of this.heldClaimsLocked()) {
      if (lapsed.holder_session === sessionId || !isClaimExpired(lapsed, now)) continue;
      if (claimsCollide(lapsed, request)) await this.expireClaimLocked(lapsed, "ttl");
    }

    if (mode === "exclusive") {
      const blocker = this.blockingClaimLocked(sessionId, request, now);
      if (blocker) throw claimHeldError(holderSnapshot(blocker));
      // The caller's own exclusive claim occupying one of these resource slots, without covering
      // them all, would be displaced in the fold by the new one. Refused rather than silently
      // superseded: release it, then claim the full set.
      const overlapping = this.heldClaimsLocked().find(
        (claim) =>
          claim.holder_session === sessionId &&
          claim.mode === "exclusive" &&
          claim.resources.some((resource) => request.resources.includes(resource)),
      );
      if (overlapping) throw claimHeldError(holderSnapshot(overlapping));
    }

    const live = this.heldClaimsLocked().filter((claim) => !isClaimExpired(claim, now));
    if (live.filter((claim) => claim.holder_session === sessionId).length >= MAX_CLAIMS_PER_SESSION) {
      throw claimLimitError("session", MAX_CLAIMS_PER_SESSION);
    }
    if (live.length >= MAX_CLAIMS_PER_WORKSPACE) throw claimLimitError("workspace", MAX_CLAIMS_PER_WORKSPACE);

    const claimId = this.ulidFn();
    const entry = request.resources.map(entryIdOfResource).find((id): id is string => id !== null);
    let preSha: string | undefined;
    if (mode === "exclusive") {
      if (request.paths.length > 0 && (await anyPathDirty(this.workspace, request.paths))) {
        await this.captureExternalEditLocked({ paths: request.paths });
      }
      preSha = await checkpoint(this.workspace, {
        attribution: "unknown", // whatever drifted before this claim started isn't this session's doing
        kind: "pre_apply",
        ...(entry ? { entry } : {}),
        lease: claimId,
        ...(request.paths.length > 0 ? { paths: request.paths } : {}),
      });
    }

    // Read, never re-derived: the next fence is strictly greater than any this resource has ever
    // issued, and the number the holder is handed is the number the journal records.
    const fence = 1 + maxFenceOver(this.state.claims, request.resources);
    const since = this.nowFn().toISOString();
    const expiresAt = new Date(now.getTime() + ttl).toISOString();
    this.appendClaimEventLocked({
      v: 1,
      event_id: this.ulidFn(),
      at: since,
      ...(entry ? { entry } : {}),
      event: "claim_taken",
      by: `session:${sessionId}`,
      detail: {
        claim_id: claimId,
        resources: request.resources,
        paths: request.paths,
        mode,
        session: sessionId,
        principal,
        fence,
        since,
        expires_at: expiresAt,
        ...(preSha ? { pre_sha: preSha } : {}),
      },
    });
    return { claimId, fence, expiresAt, paths: request.paths, ...(preSha ? { preSha } : {}), renewed: false };
  }

  /** Takes an `exclusive` or `presence` claim over `resources` (issue #155). Presence claims never
   * block anyone and take no checkpoint; exclusive claims are disjoint over paths and open the
   * interval a later `resolveEntry` proves. */
  claim(
    resources: readonly string[],
    mode: ClaimMode,
    sessionId: string,
    principal: string,
    opts: { ttlMs?: number } = {},
  ): Promise<ClaimResult> {
    return this.mutex.runExclusive(this.mutexKey, async () => {
      this.assertWritable();
      reclaimIndexLock(this.workspace, { writer: this.writer, ulid: this.ulidFn, now: this.nowFn });
      await initShadowRepo(this.workspace, { writer: this.writer, ulid: this.ulidFn, now: this.nowFn });
      return this.claimLocked(resources, mode, sessionId, principal, opts.ttlMs);
    });
  }

  /** Extends the caller's own claim by its mode's TTL from now. The fence does not move — a
   * refreshed lock keeps its token (RFC 4918 §6.6). */
  renew(claimId: string, sessionId: string): Promise<{ claimId: string; fence: number | null; expiresAt: string }> {
    return this.mutex.runExclusive(this.mutexKey, () => {
      this.assertWritable();
      const claim = this.heldClaimByIdLocked(claimId);
      if (!claim) {
        const tombstone = tombstoneFor(this.state.claims, claimId);
        throw tombstone ? claimTombstoneError(tombstone) : noSuchClaimError(claimId);
      }
      if (claim.holder_session !== sessionId) throw claimHeldError(holderSnapshot(claim));
      const now = this.nowFn();
      const ttl = claim.mode === "presence" ? PRESENCE_CLAIM_TTL_MS : EXCLUSIVE_CLAIM_TTL_MS;
      return { claimId, fence: claim.fence, expiresAt: this.renewClaimLocked(claim, ttl, now) };
    });
  }

  /** Ends a claim. `by: "session"` must be the holder; `by: "human"` is the human-wins override
   * and is never refused. Releasing a claim that is already gone is a no-op that says so
   * (`released: false`), so a retried release never errors. */
  release(
    claimId: string,
    by: "human" | "session",
    sessionId?: string,
  ): Promise<{ released: boolean; claim: ClaimHolderSnapshot | null }> {
    return this.mutex.runExclusive(this.mutexKey, async () => {
      this.assertWritable();
      const claim = this.heldClaimByIdLocked(claimId);
      if (!claim) return { released: false, claim: null };
      if (by === "session" && claim.holder_session !== sessionId) throw claimHeldError(holderSnapshot(claim));
      reclaimIndexLock(this.workspace, { writer: this.writer, ulid: this.ulidFn, now: this.nowFn });
      await initShadowRepo(this.workspace, { writer: this.writer, ulid: this.ulidFn, now: this.nowFn });
      await this.releaseClaimLocked(claim, by, by === "human" ? "released_by_human" : "released_by_holder");
      return { released: true, claim: holderSnapshot(claim) };
    });
  }

  /** Live claims and the most recent tombstone per resource, optionally narrowed to claims
   * covering `path`. A snapshot of fold state, taken under the mutex so it never observes a
   * half-applied claim. */
  listClaims(path?: string): Promise<{ claims: Claim[]; tombstones: Array<Tombstone & { resource: string }> }> {
    return this.mutex.runExclusive(this.mutexKey, () => {
      const now = this.nowFn();
      const matches = (claim: Claim): boolean =>
        path === undefined ||
        claim.paths.length === 0 ||
        claim.paths.includes(path) ||
        claim.resources.includes(artifactResource(path));
      const claims = this.heldClaimsLocked().filter((claim) => !isClaimExpired(claim, now) && matches(claim));
      const tombstones: Array<Tombstone & { resource: string }> = [];
      for (const [resource, slot] of Object.entries(this.state.claims)) {
        if (!slot.last) continue;
        if (path !== undefined && resource !== artifactResource(path)) {
          const entryId = entryIdOfResource(resource);
          if (entryId === null || !this.entryPathsLocked(entryId).includes(path)) continue;
        }
        tombstones.push({ ...slot.last, resource });
      }
      return { claims: structuredClone(claims), tombstones };
    });
  }

  /** `apply-begin` (A4 §F05), kept as an alias: an exclusive claim over `entry:<id>`, whose path
   * set comes from the entry itself. `leaseId` is the claim id. A second call from the SAME
   * session renews rather than conflicting; another session's call answers `CLAIM_HELD` naming
   * the holder. */
  applyBegin(
    entry: string,
    sessionId: string,
    principal = "unknown",
  ): Promise<{ leaseId: string; preSha: string; fence: number | null; expiresAt: string; renewed: boolean }> {
    return this.mutex.runExclusive(this.mutexKey, async () => {
      this.assertWritable();
      reclaimIndexLock(this.workspace, { writer: this.writer, ulid: this.ulidFn, now: this.nowFn });
      await initShadowRepo(this.workspace, { writer: this.writer, ulid: this.ulidFn, now: this.nowFn });
      const result = await this.claimLocked([entryResource(entry)], "exclusive", sessionId, principal);
      return {
        leaseId: result.claimId,
        preSha: result.preSha ?? "",
        fence: result.fence,
        expiresAt: result.expiresAt,
        renewed: result.renewed,
      };
    });
  }

  /** The shared terminal guard (issue #155 Q4) for every path that closes an entry — resolve,
   * dismiss, defer, withdraw. Answers, in order: unknown entry → `UNKNOWN_ENTRY`; terminal and
   * closed by THIS actor with THIS outcome → a replay the caller should answer with the original
   * result; terminal otherwise → `ENTRY_RESOLVED` naming who closed it. Full `by` strings are
   * compared, so `session:A` never replays `session:AB`'s resolve. Legacy terminal entries that
   * predate `terminalBy` fall back to the proven interval's `by`. */
  guardTerminalLocked(
    entryId: string,
    by: EventBy,
    to: string,
  ): { replay: true; entry: DerivedEntryState } | { replay: false; entry: DerivedEntryState } {
    const entry = this.state.entries[entryId];
    if (!entry) throw unknownEntryError(entryId);
    if (!isTerminal(entryKindOf(entry), entry.status)) return { replay: false, entry };
    const terminalBy = entry.terminalBy ?? entry.appliedInterval?.by ?? null;
    if (terminalBy === by && entry.status === to) return { replay: true, entry };
    throw entryResolvedError(entryId, terminalBy, entry.status);
  }

  /** `resolve` (A4 §F05, issue #155): the refusal ladder, evaluated in full under the mutex
   * BEFORE any checkpoint — a refusal appends nothing and commits nothing (the one exception is
   * `git_index_lock_reclaimed`, and lazy expiry of the caller's own dead claim at rung 3′):
   *
   *   0. unknown entry                                   → UNKNOWN_ENTRY
   *   1. terminal, closed by me with this outcome         → replay the original result
   *   2. terminal otherwise                              → ENTRY_RESOLVED{terminal_by, status}
   *   3. my claim is gone (or my fence is stale)          → CLAIM_REVOKED|EXPIRED|SUPERSEDED
   *   3′ my claim's TTL lapsed but nothing closed it yet  → renew and proceed, within one sweeper
   *      interval; past that, expire it here and answer CLAIM_EXPIRED
   *   4. another session holds this entry's paths         → CLAIM_HELD{holder…}
   *   5. no claim of mine                                 → NO_CLAIM
   *   6. proceed: `post_apply` checkpoint scoped to the claim's paths, then `apply_end` + the
   *      transition. A commit inside pre..post that touched the claimed paths and is neither the
   *      holder's own nor this claim's makes the interval `unknown`; the entry still closes.
   *
   * Attribution always comes from the CLAIM's recorded holder, never from `sessionId` — they are
   * equal by the time rung 6 runs, but the proof is what the claim recorded. */
  resolveEntry(
    entry: string,
    outcome: "applied" | "rejected" | "stale",
    sessionId: string,
    opts: { note?: string; fence?: number } = {},
  ): Promise<{ leaseId: string; postSha: string; fence: number | null; replayed: boolean }> {
    return this.mutex.runExclusive(this.mutexKey, async () => {
      this.assertWritable();
      reclaimIndexLock(this.workspace, { writer: this.writer, ulid: this.ulidFn, now: this.nowFn });

      // Rungs 0–2.
      const me: EventBy = `session:${sessionId}`;
      const guard = this.guardTerminalLocked(entry, me, outcome);
      if (guard.replay) {
        const interval = guard.entry.appliedInterval;
        return {
          leaseId: interval?.claim_id ?? "",
          postSha: interval?.post_sha ?? "",
          fence: null,
          replayed: true,
        };
      }

      const now = this.nowFn();
      const resource = entryResource(entry);
      const request = { resources: [resource], paths: this.entryPathsLocked(entry) };
      const slot = this.state.claims[resource];
      const mine =
        (slot?.exclusive?.holder_session === sessionId ? slot.exclusive : null) ??
        this.heldClaimsLocked().find(
          (claim) =>
            claim.mode === "exclusive" &&
            claim.holder_session === sessionId &&
            request.paths.length > 0 &&
            claim.paths.length > 0 &&
            request.paths.every((path) => claim.paths.includes(path)),
        ) ??
        null;

      // Rung 3: the caller's claim is over. The tombstone says why, and that is what the caller
      // needs — a human took the file, the clock ran out, or someone else took the resource.
      const tombstone = slot?.last ?? null;
      if (!mine) {
        if (
          tombstone &&
          (tombstone.holder_session === sessionId || (opts.fence !== undefined && tombstone.fence === opts.fence))
        ) {
          throw claimTombstoneError(tombstone);
        }
      } else if (opts.fence !== undefined && mine.fence !== null && opts.fence !== mine.fence) {
        // A token from an earlier claim of mine that has since ended.
        throw tombstone ? claimTombstoneError(tombstone) : noClaimError(entry);
      }

      // Rung 3′.
      if (mine && isClaimExpired(mine, now)) {
        const lapsedMs = now.getTime() - new Date(mine.expires_at).getTime();
        if (lapsedMs > CLAIM_RENEW_GRACE_MS) {
          await initShadowRepo(this.workspace, { writer: this.writer, ulid: this.ulidFn, now: this.nowFn });
          await this.expireClaimLocked(mine, "ttl");
          const ended = tombstoneFor(this.state.claims, mine.claim_id);
          throw ended ? claimTombstoneError(ended) : noClaimError(entry);
        }
        this.renewClaimLocked(mine, EXCLUSIVE_CLAIM_TTL_MS, now);
      }

      if (!mine) {
        // Rung 4. A lapsed-but-unclosed claim still counts here: a caller that does not hold a
        // claim never gets to drive someone else's to expiry — the holder's own resolve, a new
        // claim over the same paths, the sweeper, or reconcile all reach the same place.
        const blocker = this.blockingClaimLocked(sessionId, request, now, true);
        if (blocker) throw claimHeldError(holderSnapshot(blocker));
        // Rung 5.
        throw noClaimError(entry);
      }

      // Rung 6.
      const claim = mine;
      const scoped = claim.paths.length > 0 ? { paths: claim.paths } : {};
      const postSha = await checkpoint(this.workspace, {
        attribution: holderBy(claim),
        kind: "post_apply",
        entry,
        lease: claim.claim_id,
        ...scoped,
      });
      const preSha = claim.pre_sha ?? "";
      const foreign = preSha
        ? (await commitsTouching(this.workspace, preSha, postSha, claim.paths)).filter(
            (commit) => commit.attribution !== holderBy(claim) && commit.lease !== claim.claim_id,
          )
        : [];

      const at = this.nowFn().toISOString();
      this.appendClaimEventLocked({
        v: 1,
        event_id: this.ulidFn(),
        at,
        entry,
        event: "apply_end",
        by: holderBy(claim),
        // BOTH ends of the interval, plus the claim that proves it. `apply_end` is the event that
        // declares the proven `pre_sha..post_sha` diff (F05), so recording only one half left
        // every consumer — including the reader offered "undo what the session just applied",
        // whose rollback target IS `pre_sha` — unable to compute the thing it describes. It is
        // not recoverable from the checkpoint graph either: `checkpoint()` is idempotent, so a
        // claim taken against a clean worktree writes no `pre_apply` commit at all.
        detail: {
          lease_id: claim.claim_id,
          claim_id: claim.claim_id,
          fence: claim.fence,
          paths: claim.paths,
          pre_sha: preSha,
          post_sha: postSha,
          interval_attribution: foreign.length > 0 ? "unknown" : "session",
          ...(foreign.length > 0 ? { reason: "foreign-commit-in-interval" } : {}),
        },
      });
      this.appendClaimEventLocked({
        v: 1,
        event_id: this.ulidFn(),
        at,
        entry,
        event: "transition_committed",
        by: holderBy(claim),
        detail: { to: outcome, outcome, ...(opts.note !== undefined ? { note: opts.note } : {}) },
      });

      return { leaseId: claim.claim_id, postSha, fence: claim.fence, replayed: false };
    });
  }

  /** Serializes a glosa editor save/restore with its path-scoped shadow-git checkpoints and the
   * immutable `human_edit` inbox entry derived from the resulting unified diff. Holding the same
   * workspace mutex across before -> mutate -> checkpoint -> diff -> entry creation prevents an
   * unrelated filesystem change from being folded into this human-attributed edit.
   *
   * #182 R5's honest pre-save boundary: BEFORE `mutate()`, this captures any drift already on
   * disk for `path` exactly as the watcher's own quiet window would — an `unknown`-attributed
   * checkpoint plus `external_edit` entries, via the same `captureExternalEditLocked` this
   * method's public sibling uses — so `before` (this human edit's diff base) already contains
   * that drift and the diff this commits contains only what `mutate()` itself changed. Without
   * this, a Keep-mine save that legitimately carries disk's bytes into its own write would still
   * misattribute those bytes to the human, because `before` was captured too early to have them.
   *
   * An active apply lease is the one case this cannot pre-capture honestly (that interval is the
   * lease's own `resolveEntry`'s to prove, A4 §F05) — refuse rather than fold it into `human`
   * (`driftUnderLeaseError`) when `path` actually has pending drift; no drift under a lease still
   * saves exactly as before this existed. */
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
      const activeLease = this.state.applyLease;
      if (activeLease) {
        if (isLeaseExpired(activeLease, this.nowFn())) {
          // Same closing-out `applyBegin` already does for a dangling expired lease — nothing
          // left to refuse over once its own interval is honestly checkpointed as `unknown`.
          const lapsed = this.heldClaimByIdLocked(activeLease.leaseId);
          if (lapsed) await this.expireClaimLocked(lapsed, "ttl");
          await this.captureExternalEditLocked();
        } else if (await isPathDirty(this.workspace, path)) {
          throw driftUnderLeaseError(path, activeLease.leaseId);
        }
      } else {
        await this.captureExternalEditLocked();
      }
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

  /** The daemon-lifetime artifact watcher's quiet-window capture (#153): a tracked artifact
   * changed on disk and nothing glosa did accounts for it, so commit the drift and say so.
   *
   * GOES THROUGH THE SAME WRITE PRIMITIVE AS EVERY OTHER WRITER, deliberately: this workspace's
   * mutex (so the checkpoint can never race a concurrent journal append or another checkpoint on
   * the same shadow repo) plus `assertWritable`'s `adoptionSeal`/`forgetSeal` refusal — a
   * workspace sealed for adoption or moments from `glosa forget` deletion must not gain a fresh
   * entry because a file changed underneath it. `captureHumanEdit` is the reference caller for
   * this exact shape.
   *
   * ORDERING, AND WHY IT IS THIS WAY ROUND. The entry has to name the commit it reports, so the
   * commit is first and a crash in that window loses the entry — permanently, because
   * `checkpoint()` is idempotent (A4 §F21) and no later checkpoint ever sees that diff again. The
   * repair is named and lives in reconcile: `unreportedDriftCommits` compares the last emitted
   * `until_checkpoint` against the current shadow HEAD, and shadow history retains the commit
   * either way. Nothing here is a read path — this MUTATES shadow git and the journal, and is only
   * ever called from the watcher's timer, never from a GET.
   *
   * TWO SUPPRESSIONS, both of them A4 §F05's rule rather than an invention here:
   *   - AN ACTIVE APPLY LEASE. The interval belongs to that lease's own `resolveEntry`, and this
   *     defers COMPLETELY — no checkpoint, no entry, no git spawned — which is the same decision
   *     `offlineCatchUp` (reconcile.ts step 5a) already makes, for the same reason it states
   *     there: `checkpoint()` is idempotent, so committing the in-flight edit here as
   *     `Glosa-Attribution: unknown` would leave `resolveEntry`'s own later checkpoint with
   *     nothing new to stage, returning THAT SAME sha as `post_sha` — and the journal would then
   *     record `session:<id>` for a commit whose trailer says `unknown`. Measured, not theorized:
   *     an earlier revision of this method did commit under a lease (A4 §F05's "save-burst
   *     checkpoints during a lease still commit (full history)"), and the lease-attribution test
   *     in `test/bus/external-edit.test.ts` failed with exactly that `unknown`. The appendix's
   *     "full history" wording cannot be honoured by a producer that shares the same idempotent
   *     checkpoint as the lease without breaking R3's governing attribution guarantee, so the
   *     guarantee wins and A4 §F05's watcher bullet is corrected to match offline catch-up.
   *   - A GLOSA EDITOR-API SAVE. `captureHumanEdit` holds this same mutex across mutate ->
   *     checkpoint, so by the time this runs there is nothing left to stage, `checkpoint()`
   *     returns the same sha, and the "no drift" branch below exits. Editor writes are `human` by
   *     construction and are not double-reported. That suppression is structural, not a check. */
  captureExternalEdit(): Promise<ExternalEditCapture> {
    return this.mutex.runExclusive(this.mutexKey, async () => {
      this.assertWritable();
      // Before any git is spawned, and before the index lock is touched: a lease-held workspace is
      // not this producer's business at all.
      if (this.state.applyLease) return { committed: false, suppressed: "apply_lease" as const, entries: [] };

      reclaimIndexLock(this.workspace, { writer: this.writer, ulid: this.ulidFn, now: this.nowFn });
      await initShadowRepo(this.workspace, { writer: this.writer, ulid: this.ulidFn, now: this.nowFn });
      return this.captureExternalEditLocked();
    });
  }

  /** The body of `captureExternalEdit`, minus the mutex acquisition and the lease check —
   * `captureHumanEdit`'s own pre-save boundary (#182 R5) calls this directly from INSIDE its
   * already-held critical section (`runExclusive` is not reentrant; a second acquisition of the
   * same key here would deadlock against itself), after making its own lease decision. Callers
   * are responsible for `assertWritable`/`reclaimIndexLock`/`initShadowRepo` having already run —
   * both current callers are already past that point when they reach here. */
  private async captureExternalEditLocked(opts: { paths?: readonly string[] } = {}): Promise<ExternalEditCapture> {
    const since = await headSha(this.workspace);
    const until = await checkpoint(this.workspace, {
      attribution: "unknown", // A4 §F05: everything the daemon cannot prove, never falsely `human`
      kind: EXTERNAL_EDIT_CHECKPOINT_KIND,
      // Scoped staging is scoped committing (`checkpoint` resets the index to HEAD first), so the
      // payloads below — read from this commit's own diff — can only name these paths.
      ...(opts.paths && opts.paths.length > 0 ? { paths: [...opts.paths] } : {}),
    });
    if (until === since) return { committed: false, suppressed: null, entries: [] };

    const payloads = await externalEditPayloads(this.workspace, since, until, "live", this.nowFn().toISOString());
    const entries: string[] = [];
    for (const payload of payloads) {
      const id = this.ulidFn();
      this.createEntryLocked(id, payload, { by: "watcher", detail: externalEditDetail(payload) });
      entries.push(id);
    }
    return { committed: true, suppressed: null, entries };
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
      this.closeController.abort();
    });
  }

  /** Records that a provider-neutral session stream entry reached agent context. Unlike a drain
   * acknowledgement this path has no reservation token: the in-band entry id printed by the
   * monitor or injected by the Codex attachment is the durable identity returned through MCP. */
  acknowledgePushedEntry(
    entryId: string,
    opts: {
      session: string;
      via: "monitor" | "codex_app_server";
      outcome: "presented" | "failed";
      error?: string;
    },
  ): Promise<boolean> {
    return this.mutex.runExclusive(this.mutexKey, () => {
      this.assertWritable();
      const payload = readInboxEntry(this.workspace, entryId);
      if (!payload || typeof payload !== "object") return false;
      const record = payload as Record<string, unknown>;
      if (record.kind === "external_edit") return false;
      if (record.kind === "conversation_message" && record.target_session_id !== opts.session) return false;
      const entry = this.state.entries[entryId];
      if (!entry) return false;
      const attempts = Array.isArray(entry.deliveryAttempts) ? entry.deliveryAttempts : [];
      const latest = attempts.at(-1);
      if (latest?.via === opts.via && latest?.session === opts.session && latest?.outcome === opts.outcome) return true;
      if (
        !attempts.some(
          (attempt) =>
            attempt.via === opts.via && attempt.session === opts.session && attempt.outcome === "transport_accepted",
        )
      ) {
        return false;
      }
      this.recordDeliveryAttemptLocked(entryId, {
        fsync: true,
        idem: `${opts.via}:${opts.session}:${entryId}:${opts.outcome}`,
        via: opts.via,
        session: opts.session,
        outcome: opts.outcome,
        reason: attempts.length > 0 ? "re_nudge" : "initial",
        ...(opts.error ? { error: opts.error } : {}),
      });
      if (
        record.kind === "conversation_message" &&
        opts.outcome === "presented" &&
        this.state.entries[entryId]?.status !== "delivered"
      ) {
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

  // -----------------------------------------------------------------------------------------
  // #153 Part 2 — `glosa_watch`: a per-session, held read over `external_edit` entries. Reuses
  // the kind's existing exclusion from `eligibleDeliveryEntriesLocked` (a watch is a SEPARATE
  // selection, never that method) and its existing presentation builder; adds nothing but a
  // per-session "already presented via watch" fold and a safe cursor watermark (W1).
  // -----------------------------------------------------------------------------------------

  private wasPresentedViaWatchLocked(entry: DerivedState["entries"][string], session: string): boolean {
    const attempts = Array.isArray(entry.deliveryAttempts) ? (entry.deliveryAttempts as DeliveryAttemptRecord[]) : [];
    return attempts.some(
      (attempt) => attempt.via === "watch" && attempt.session === session && attempt.outcome === "presented",
    );
  }

  /** Every non-terminal `external_edit` entry in scope, oldest journal order first — REGARDLESS of
   * whether this session has already had it presented via watch. `previewWatchLocked` needs the
   * full set (not just this session's still-pending ones) to compute W1's safe watermark: a
   * checkpoint counts as fully accounted for only when EVERY in-scope entry it produced is either
   * already presented to this session or included in the current response, and an entry already
   * presented is invisible to the "pending" filter by construction. */
  private inScopeExternalEditEntriesLocked(path: string | undefined): Array<{
    id: string;
    entry: DerivedState["entries"][string];
    payload: Record<string, unknown>;
    untilCheckpoint: string;
  }> {
    const { entryOrder } = peekJournal(this.workspace);
    const ids = Object.keys(this.state.entries).sort(
      (a, b) => (entryOrder.get(a) ?? Number.MAX_SAFE_INTEGER) - (entryOrder.get(b) ?? Number.MAX_SAFE_INTEGER),
    );
    const out: Array<{
      id: string;
      entry: DerivedState["entries"][string];
      payload: Record<string, unknown>;
      untilCheckpoint: string;
    }> = [];
    for (const id of ids) {
      const entry = this.state.entries[id]!;
      if (!isExternalEditEntry(entry)) continue;
      if (isTerminal("common", entry.status)) continue; // W2: dismissed is never eligible
      const payload = readInboxEntry(this.workspace, id);
      if (!payload || typeof payload !== "object") continue;
      const record = payload as Record<string, unknown>;
      if (path !== undefined && record.path !== path) continue;
      const untilCheckpoint = typeof record.until_checkpoint === "string" ? record.until_checkpoint : "";
      if (!untilCheckpoint) continue;
      out.push({ id, entry, payload: record, untilCheckpoint });
    }
    return out;
  }

  /** The read half of `glosa_watch` (W4: the GET this backs never writes). Groups in-scope
   * `external_edit` entries by `until_checkpoint` — contiguous by construction, since
   * `captureExternalEdit` creates every entry from one capture inside one mutex critical section —
   * and returns at most `MAX_DELIVERY_ENTRIES` unpresented-to-`session` ones, oldest first, plus a
   * SAFE `latest_checkpoint` watermark (W1): the newest checkpoint whose every in-scope entry is
   * either already presented to `session` or included in THIS response. A response never advances
   * the watermark past a checkpoint it only partially returns. */
  previewWatch(
    opts: { session: string; path?: string; since?: string },
    build: (id: string, payload: unknown, status: string) => DeliverableEntry | null | Promise<DeliverableEntry | null>,
  ): Promise<{ entries: DeliverableEntry[]; has_more: boolean; latest_checkpoint: string | null }> {
    return this.mutex.runExclusive(this.mutexKey, async () => {
      const candidates = this.inScopeExternalEditEntriesLocked(opts.path);
      const groups: (typeof candidates)[] = [];
      for (const candidate of candidates) {
        const last = groups.at(-1);
        if (last && last[0]!.untilCheckpoint === candidate.untilCheckpoint) last.push(candidate);
        else groups.push([candidate]);
      }

      const sinceCache = new Map<string, boolean>();
      const excludedBySince = async (untilCheckpoint: string): Promise<boolean> => {
        if (opts.since === undefined) return false;
        const cached = sinceCache.get(untilCheckpoint);
        if (cached !== undefined) return cached;
        const result = await isAncestorOrEqual(this.workspace, untilCheckpoint, opts.since);
        const excluded = result === "ancestor";
        sinceCache.set(untilCheckpoint, excluded);
        return excluded;
      };
      // "accounted for": already presented to THIS session via watch, excluded by `since`, or
      // about to be returned in this very response — the three ways an in-scope entry stops being
      // this response's problem. Computed once per entry and reused by both the selection pass and
      // the watermark pass below so they can never disagree about the same entry.
      const accountedFor = async (candidate: (typeof candidates)[number]): Promise<boolean> =>
        this.wasPresentedViaWatchLocked(candidate.entry, opts.session) ||
        (await excludedBySince(candidate.untilCheckpoint));

      const selected: typeof candidates = [];
      const built = new Map<string, DeliverableEntry>();
      let batchBytes = 0;
      for (const candidate of candidates) {
        if (await accountedFor(candidate)) continue;
        if (selected.length >= MAX_DELIVERY_ENTRIES) break;
        const presentation = await build(candidate.id, candidate.payload, candidate.entry.status);
        if (!presentation) continue; // malformed payload — never eligible, never blocks the watermark
        const separatorBytes = selected.length > 0 ? Buffer.byteLength("\n\n---\n\n", "utf8") : 0;
        if (batchBytes + separatorBytes + presentation.bytes > MAX_BATCH_PRESENTATION_BYTES) break;
        selected.push(candidate);
        built.set(candidate.id, presentation);
        batchBytes += separatorBytes + presentation.bytes;
      }

      let hasMore = false;
      let watermark: string | null = opts.since ?? null;
      let watermarkStillAdvancing = true;
      for (const group of groups) {
        let groupComplete = true;
        for (const candidate of group) {
          if (built.has(candidate.id)) continue;
          if (await accountedFor(candidate)) continue;
          groupComplete = false;
          hasMore = true;
        }
        if (watermarkStillAdvancing) {
          if (groupComplete) watermark = group[0]!.untilCheckpoint;
          else watermarkStillAdvancing = false;
        }
      }

      return {
        entries: selected.map((candidate) => built.get(candidate.id)!),
        has_more: hasMore,
        latest_checkpoint: watermark,
      };
    });
  }

  /** `POST /api/sessions/:id/watch/transport-ack` (W4): records that the HTTP body of a watch
   * response reached the client, for exactly the ids that response actually named. Refuses any id
   * that is not, right now, an `external_edit` entry — the same fail-closed shape
   * `acknowledgePushedEntry` uses for its own kind refusal. Idempotent per (session, entry): a
   * retried ack is a no-op success, not a duplicate journal line. */
  recordWatchTransportAccepted(
    session: string,
    entryIds: readonly string[],
    stillAuthorised?: () => boolean,
  ): Promise<{ accepted: string[]; authorityLost?: true }> {
    return this.mutex.runExclusive(this.mutexKey, () => {
      this.assertWritable();
      // Checked HERE, inside the lock that guards the append, not by the caller before it (review
      // round 4). `runExclusive` is an asynchronous queue: a caller that validated its binding and
      // then awaited this method can have lost it while queued, and the append would still land.
      if (stillAuthorised && !stillAuthorised()) return { accepted: [], authorityLost: true as const };
      const accepted: string[] = [];
      for (const entryId of entryIds) {
        const entry = this.state.entries[entryId];
        if (!entry || !isExternalEditEntry(entry)) continue;
        const attempts = Array.isArray(entry.deliveryAttempts) ? entry.deliveryAttempts : [];
        if (attempts.some((a) => a.via === "watch" && a.session === session && a.outcome === "transport_accepted")) {
          accepted.push(entryId);
          continue;
        }
        this.recordDeliveryAttemptLocked(entryId, {
          idem: `watch:${session}:${entryId}:transport_accepted`,
          via: "watch",
          session,
          outcome: "transport_accepted",
          reason: attempts.length > 0 ? "re_nudge" : "initial",
        });
        accepted.push(entryId);
      }
      return { accepted };
    });
  }

  /** `POST /api/sessions/:id/watch/ack` (W4): records `presented`/`failed` after the MCP response
   * reaches stdout (`DeliveryAwareTransport`). Refuses any id this session's watch never recorded
   * `transport_accepted` for — the same "no attempt without a proven transport step first" rule
   * `eligibleDeliveryEntriesLocked`'s `presented`-suppression assumes for every other `via`. */
  recordWatchPresented(
    session: string,
    entryIds: readonly string[],
    outcome: "presented" | "failed",
    error?: string,
    stillAuthorised?: () => boolean,
  ): Promise<{ accepted: string[]; authorityLost?: true }> {
    return this.mutex.runExclusive(this.mutexKey, () => {
      this.assertWritable();
      // Same boundary as `recordWatchTransportAccepted`: authority is only meaningful if it is
      // re-read after the queue wait, inside the lock that guards the append.
      if (stillAuthorised && !stillAuthorised()) return { accepted: [], authorityLost: true as const };
      const accepted: string[] = [];
      for (const entryId of entryIds) {
        const entry = this.state.entries[entryId];
        if (!entry || !isExternalEditEntry(entry)) continue;
        const attempts = Array.isArray(entry.deliveryAttempts) ? entry.deliveryAttempts : [];
        const hasTransportAccepted = attempts.some(
          (a) => a.via === "watch" && a.session === session && a.outcome === "transport_accepted",
        );
        if (!hasTransportAccepted) continue;
        this.recordDeliveryAttemptLocked(entryId, {
          fsync: true,
          idem: `watch:${session}:${entryId}:${outcome}`,
          via: "watch",
          session,
          outcome,
          reason: "re_nudge",
          ...(error ? { error } : {}),
        });
        accepted.push(entryId);
      }
      return { accepted };
    });
  }
}

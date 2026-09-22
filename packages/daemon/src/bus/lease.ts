// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — apply-lease pure helpers (A4 §F05). The orchestration itself (append
// apply_begin/apply_end under the workspace's git+journal mutex, drive a shadow-git checkpoint)
// lives on WorkspaceBus (bus.ts), which already holds the mutex/writer/ulid/clock this needs —
// this module only carries the bits that don't need any of that: the TTL constant, the
// expiry check, and the typed "someone already holds the lease" error.
import type { ClaimHolderSnapshot, Tombstone, TombstoneReason } from "./claims.ts";
import type { EventBy } from "./journal.ts";
import type { ApplyLeaseState } from "./replay.ts";

export const APPLY_LEASE_TTL_MS = 15 * 60 * 1000; // 15 minutes (A4 §F05)

/** A lease with a past `expiresAt` is treated as gone for the purpose of "is one active right
 * now". Reconcile step 4 closes out a dangling one at daemon STARTUP, but a daemon that stays up
 * for days never reaches it — so `WorkspaceBus.applyBegin` and `WorkspaceBus.resolveEntry` share
 * this same predicate and close the lease out inline (see `WorkspaceBus#expireLeaseLocked`).
 * Every consumer of a lease must consult this: the TTL is precisely what bounds the window a
 * lease can PROVE (A4 §F05), so a consumer that skips it is attributing unproven time. */
export function isLeaseExpired(lease: ApplyLeaseState, now: Date): boolean {
  return new Date(lease.expiresAt).getTime() <= now.getTime();
}

export interface LeaseHeldError extends Error {
  code: "LEASE_HELD";
  activeLeaseId: string;
}

/** A 2nd `apply-begin` while one is already active never queues (A4 §F05) — it fails loudly so
 * the caller retries later, rather than silently blocking behind the mutex indefinitely. */
export function leaseHeldError(activeLeaseId: string): LeaseHeldError {
  const err = new Error(
    `an apply-lease is already active (lease_id=${activeLeaseId}) — resolve it or wait for it to expire before starting another`,
  ) as LeaseHeldError;
  err.code = "LEASE_HELD";
  err.activeLeaseId = activeLeaseId;
  return err;
}

export interface UnknownEntryError extends Error {
  code: "UNKNOWN_ENTRY";
}

export interface NoActiveLeaseError extends Error {
  code: "NO_ACTIVE_LEASE";
}

export interface LeaseSessionMismatchError extends Error {
  code: "LEASE_SESSION_MISMATCH";
  entry: string;
  leaseSession: string;
  callerSession: string;
}

export interface LeaseExpiredError extends Error {
  code: "LEASE_EXPIRED";
  entry: string;
  leaseId: string;
  expiresAt: string;
}

/** The lease's TTL is what BOUNDS the interval it can prove (A4 §F05: "Lease expiry ->
 * apply_expired, diff->unknown"). Past `expires_at` there is no proof left, so a `resolve` that
 * arrives late cannot be attributed to its holder no matter how genuine the caller is — the
 * pre..post diff by then also spans however many hours of drift arrived from elsewhere while the
 * session was stalled. Distinct from `NO_ACTIVE_LEASE` on purpose: the caller did everything
 * right and simply needs to re-run `apply-begin` to open a fresh, provable window, and the
 * message has to say so. */
export function leaseExpiredError(entry: string, leaseId: string, expiresAt: string): LeaseExpiredError {
  const err = new Error(
    `resolve(${entry}): the apply-lease (lease_id=${leaseId}) expired at ${expiresAt} — its interval can no longer be proven and was recorded as unknown; re-run apply-begin and resolve again`,
  ) as LeaseExpiredError;
  err.code = "LEASE_EXPIRED";
  err.entry = entry;
  err.leaseId = leaseId;
  err.expiresAt = expiresAt;
  return err;
}

export interface DriftUnderLeaseError extends Error {
  code: "DRIFT_UNDER_LEASE";
  path: string;
  leaseId: string;
}

/** #182 R5: `captureHumanEdit`'s honest pre-save boundary refuses rather than guesses when an
 * active apply-lease holds the workspace AND `path` already has uncommitted drift. The interval
 * belongs to the lease's own `resolveEntry` (A4 §F05) — checkpointing it here as `unknown` would
 * leave `resolveEntry`'s later checkpoint with nothing new to stage (idempotency, A4 §F21),
 * exactly the double-report `captureExternalEdit`'s own lease suppression already avoids for the
 * watcher. Attributing the interval to the human instead — the alternative if this refusal did
 * not exist — is the one thing #182 R5 exists to prevent. */
export function driftUnderLeaseError(path: string, leaseId: string): DriftUnderLeaseError {
  const err = new Error(
    `save refused: ${path} has uncommitted drift and an apply-lease (lease_id=${leaseId}) is active — that interval belongs to the lease, not to this save; resolve or wait out the lease and try again`,
  ) as DriftUnderLeaseError;
  err.code = "DRIFT_UNDER_LEASE";
  err.path = path;
  err.leaseId = leaseId;
  return err;
}

/** The lease IS the proof (A4 §F05) — a lease for `entry` held by session A resolved by a caller
 * claiming to be session B would attribute A's edit to B, which is exactly the forgery honest
 * provenance exists to prevent. Never falls back to trusting the caller's `sessionId` for
 * attribution; this must be checked before any checkpoint/journal write happens. */
export function leaseSessionMismatchError(
  entry: string,
  leaseSession: string,
  callerSession: string,
): LeaseSessionMismatchError {
  const err = new Error(
    `resolve(${entry}): lease is held by session:${leaseSession}, not session:${callerSession} — refusing to attribute this resolve to a caller that isn't the lease holder`,
  ) as LeaseSessionMismatchError;
  err.code = "LEASE_SESSION_MISMATCH";
  err.entry = entry;
  err.leaseSession = leaseSession;
  err.callerSession = callerSession;
  return err;
}

/** An `apply-begin` naming an entry this workspace has never seen. F05's lease is the ONLY thing
 * that attributes a change to a session, so a lease over an entry this workspace does not own is a
 * lease that proves nothing: it checkpoints this workspace, hands back a `pre_sha` pointing into
 * it, and attributes whatever happens next to a session acting on somebody else's entry.
 *
 * It also consumes the single per-workspace lease slot ("exactly ONE active apply-lease/workspace"),
 * so a mistyped id — or a command run from the wrong directory before `--workspace` existed —
 * silently locks a real workspace out of its own applies for the full TTL. Refuse before either
 * side effect happens. */
export function unknownEntryError(entry: string): UnknownEntryError {
  const err = new Error(
    `apply-begin(${entry}): this workspace has no such inbox entry — check --workspace`,
  ) as UnknownEntryError;
  err.code = "UNKNOWN_ENTRY";
  return err;
}

/** `resolveEntry` needs a matching `apply_begin` to prove the pre..post interval — without one
 * there is nothing to attribute to a session, so this fails loudly rather than falsely attributing
 * (the honest-provenance invariant applies to error paths too, not just the happy path). */
export function noActiveLeaseError(entry: string): NoActiveLeaseError {
  const err = new Error(`resolve(${entry}): no active apply-lease for this entry`) as NoActiveLeaseError;
  err.code = "NO_ACTIVE_LEASE";
  return err;
}

// ---------------------------------------------------------------------------------------------
// Issue #155 — claims. The lease's one-per-workspace slot becomes one exclusive claim per
// resource, so the errors change shape with it: every refusal now names WHO, not just that
// something was refused. These land beside the lease errors above rather than replacing them; the
// lease surface is deleted only once nothing reads it (task 11).
// ---------------------------------------------------------------------------------------------

/** 15 minutes, unchanged from the apply-lease it generalizes (A4 §F05). This is the bound on what
 * a claim can PROVE, which is why it stays long: shortening it would not make conflicts rarer, it
 * would make honestly-attributed intervals rarer. */
export const EXCLUSIVE_CLAIM_TTL_MS = 15 * 60 * 1000;

/** A presence claim blocks nobody, so it costs nothing to let it lapse sooner — 5 minutes keeps
 * "someone is looking at this" from lingering on a screen long after they closed the tab. */
export const PRESENCE_CLAIM_TTL_MS = 5 * 60 * 1000;

/** A claim also dies when its holder does. The session registry's own lease is 60 s; doubling it
 * before a claim is taken away means a session that merely missed one heartbeat keeps working,
 * while one that actually went away stops holding a resource for the rest of the TTL (Chubby's
 * grace period, adapted). */
export const HOLDER_STALE_GRACE_MS = 120_000;

/** Bounds, not authorization (A3 is unchanged — any bearer may claim anything). They exist so one
 * looping caller cannot make the fold, the sweeper, or a presentation payload unbounded. */
export const MAX_CLAIMS_PER_SESSION = 32;
export const MAX_CLAIMS_PER_WORKSPACE = 256;

export interface ClaimHeldError extends Error {
  code: "CLAIM_HELD";
  claim: ClaimHolderSnapshot;
}

/** The refusal REQ-5 exists for: a second session gets the holder INLINE, so it can decide to wait,
 * pick something else, or tell its human who to go ask — instead of the opaque `LEASE_HELD` that
 * named only an id it had no way to resolve. */
export function claimHeldError(claim: ClaimHolderSnapshot): ClaimHeldError {
  const err = new Error(
    `session:${claim.holder_session} holds an ${claim.mode} claim (claim_id=${claim.claim_id}) since ${claim.since}, until ${claim.expires_at}`,
  ) as ClaimHeldError;
  err.code = "CLAIM_HELD";
  err.claim = claim;
  return err;
}

export type ClaimGoneCode = "CLAIM_REVOKED" | "CLAIM_EXPIRED" | "CLAIM_SUPERSEDED";

export interface ClaimGoneError extends Error {
  code: ClaimGoneCode;
  tombstone: Tombstone;
}

const GONE_CODE_BY_REASON: Readonly<Record<TombstoneReason, ClaimGoneCode>> = {
  released_by_human: "CLAIM_REVOKED",
  released_by_holder: "CLAIM_REVOKED",
  expired_ttl: "CLAIM_EXPIRED",
  expired_holder_stale: "CLAIM_EXPIRED",
  superseded: "CLAIM_SUPERSEDED",
  resolved: "CLAIM_SUPERSEDED",
};

/** A caller arriving with a fence below the resource's current one is holding a token for a claim
 * that is already over. WHY it is over decides what the caller should do next — a human took the
 * file (stop and re-read it), the claim timed out (re-claim and redo), someone else took the
 * resource (go find out who) — so the tombstone's reason picks the code rather than one generic
 * "stale fence". */
export function claimTombstoneError(tombstone: Tombstone): ClaimGoneError {
  const code = GONE_CODE_BY_REASON[tombstone.reason] ?? "CLAIM_EXPIRED";
  const err = new Error(
    `claim ${tombstone.claim_id} (session:${tombstone.holder_session}) ended at ${tombstone.ended_at}: ${tombstone.reason}`,
  ) as ClaimGoneError;
  err.code = code;
  err.tombstone = tombstone;
  return err;
}

export interface EntryResolvedError extends Error {
  code: "ENTRY_RESOLVED";
  entry: string;
  terminalBy: EventBy | null;
  status: string;
}

/** Today a second `resolve` on an already-terminal entry answers `200` for a transition the fold
 * discards — and takes a `post_apply` checkpoint on the way, crediting the loser for an interval
 * nothing will ever read. A caller that is told `200` learns nothing and moves on believing it
 * applied the change. This is the refusal that replaces that silence, and it is raised BEFORE any
 * checkpoint, which is the half that actually matters. */
export function entryResolvedError(entry: string, terminalBy: EventBy | null, status: string): EntryResolvedError {
  const err = new Error(
    `resolve(${entry}): already ${status}${terminalBy ? ` by ${terminalBy}` : ""} — this entry is closed`,
  ) as EntryResolvedError;
  err.code = "ENTRY_RESOLVED";
  err.entry = entry;
  err.terminalBy = terminalBy;
  err.status = status;
  return err;
}

export interface NoClaimError extends Error {
  code: "NO_CLAIM";
  entry: string;
}

/** The claim IS the proof of the pre..post interval (A4 §F05). Resolving without one leaves
 * nothing to attribute, so this fails loudly rather than attributing to whoever asked — the
 * honest-provenance invariant applies to the error paths too. */
export function noClaimError(entry: string): NoClaimError {
  const err = new Error(
    `resolve(${entry}): you hold no claim on this entry — claim it first so the interval can be attributed`,
  ) as NoClaimError;
  err.code = "NO_CLAIM";
  err.entry = entry;
  return err;
}

export interface ClaimLimitError extends Error {
  code: "CLAIM_LIMIT";
  scope: "session" | "workspace";
  limit: number;
}

export function claimLimitError(scope: "session" | "workspace", limit: number): ClaimLimitError {
  const err = new Error(
    `claim refused: this ${scope} already holds the maximum of ${limit} live claims`,
  ) as ClaimLimitError;
  err.code = "CLAIM_LIMIT";
  err.scope = scope;
  err.limit = limit;
  return err;
}

export interface SourceChangedError extends Error {
  code: "SOURCE_CHANGED";
  path: string;
}

/** The honest end of "the human wins". The save went through, and then the bytes on disk turned
 * out not to be the bytes it wrote — somebody else's write landed inside the same instant. There
 * is no truthful `human` checkpoint to take for that state, so the disk is captured as `unknown`
 * and the caller is sent back through the Keep-mine / Take-disk / Compare choice it already knows
 * how to run, rather than being told a save succeeded that no longer describes the file. */
export function sourceChangedError(path: string): SourceChangedError {
  const err = new Error(
    `save(${path}): the file changed underneath this write — the bytes on disk are not the bytes just written`,
  ) as SourceChangedError;
  err.code = "SOURCE_CHANGED";
  err.path = path;
  return err;
}

/** A resolve that reaches the mutex after its claim's TTL lapsed, but before anything closed the
 * claim, renews it and proceeds (issue #155 Q2) — the case this exists for is a resolve that was
 * QUEUED behind the mutex while the clock ran out. The bound is one sweeper interval: past it, the
 * sweeper would already have expired the claim, so the resolve gets exactly the answer it would
 * have got had the timer fired on schedule. That keeps the outcome independent of timer jitter,
 * a suspended laptop, or a test with no sweeper at all — and it keeps hours of stalled-session
 * drift from ever being credited to the session that stalled. */
export const CLAIM_RENEW_GRACE_MS = 30_000;

export interface InvalidResourceError extends Error {
  code: "INVALID_RESOURCE";
  resource: string;
}

/** A resource string is `entry:<id>` or `artifact:<workspace-relative path>`. Anything else — an
 * absolute path, a `..` escape, an unknown prefix — is refused before it can reach a checkpoint
 * pathspec. */
export function invalidResourceError(resource: string): InvalidResourceError {
  const err = new Error(
    `claim refused: ${JSON.stringify(resource)} is not an entry:<id> or artifact:<workspace-relative path> resource`,
  ) as InvalidResourceError;
  err.code = "INVALID_RESOURCE";
  err.resource = resource;
  return err;
}

export interface NoSuchClaimError extends Error {
  code: "NO_SUCH_CLAIM";
  claimId: string;
}

export function noSuchClaimError(claimId: string): NoSuchClaimError {
  const err = new Error(`no claim ${claimId} is on record in this workspace`) as NoSuchClaimError;
  err.code = "NO_SUCH_CLAIM";
  err.claimId = claimId;
  return err;
}

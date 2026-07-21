// @glosa/daemon — apply-lease pure helpers (A4 §F05). The orchestration itself (append
// apply_begin/apply_end under the workspace's git+journal mutex, drive a shadow-git checkpoint)
// lives on WorkspaceBus (bus.ts), which already holds the mutex/writer/ulid/clock this needs —
// this module only carries the bits that don't need any of that: the TTL constant, the
// expiry check, and the typed "someone already holds the lease" error.
import type { ApplyLeaseState } from "./replay.ts";

export const APPLY_LEASE_TTL_MS = 15 * 60 * 1000; // 15 minutes (A4 §F05)

/** A lease with a past `expiresAt` is treated as gone for the purpose of "is one active right
 * now" — reconcile step 4 is what actually closes it out with an `apply_expired` event; this is
 * just the predicate both that step and `applyBegin`'s admission check share. */
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

export interface NoActiveLeaseError extends Error {
  code: "NO_ACTIVE_LEASE";
}

export interface LeaseSessionMismatchError extends Error {
  code: "LEASE_SESSION_MISMATCH";
  entry: string;
  leaseSession: string;
  callerSession: string;
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

/** `resolveEntry` needs a matching `apply_begin` to prove the pre..post interval — without one
 * there is nothing to attribute to a session, so this fails loudly rather than falsely attributing
 * (the honest-provenance invariant applies to error paths too, not just the happy path). */
export function noActiveLeaseError(entry: string): NoActiveLeaseError {
  const err = new Error(`resolve(${entry}): no active apply-lease for this entry`) as NoActiveLeaseError;
  err.code = "NO_ACTIVE_LEASE";
  return err;
}

// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — the O_EXCL lockfile fallback (A4 "Registry-write serialization"). Used ONLY
// when a hook needs to mutate registry state (`workspaces.json`, or a per-workspace
// `.glosa/.registry.lock`-guarded file) and the daemon is unreachable — the primary path is
// always "serialize through the daemon"; this is the pre-daemon escape hatch, never a
// substitute. `withSessionLease` semantics from a known prior-art O_EXCL lease implementation,
// generalized to an arbitrary lock file path (this isn't guarding any external tool's own session
// dir, it's guarding glosa's own registry files) — with ONE deliberate deviation from that prior
// art, the reclaim rule, which is stricter here because glosa's guarded critical section is a full
// registry read-modify-write rather than a short session-file touch (see `isReclaimable`):
//   - openSync(lockPath, "wx") IS the CAS.
//   - Lock record: {token, pid, hostname, acquiredAt, expiresAt} — UNCHANGED on disk, so a future
//     hook reads exactly the same five fields. What changed is how `expiresAt` is INTERPRETED on
//     the same host; see `isReclaimable`. A hook implementing this algorithm must mirror that rule,
//     or it will steal leases this daemon considers held.
//   - EEXIST -> inspect the holder: unparseable/empty -> treat as live/unknown, retry (never
//     stolen); reclaimable (same-host pid provably dead, or abandoned past the grace, or a
//     foreign-host record past its TTL) -> reclaim (unlink + re-openSync(wx)) and loop; anything
//     else -> bounded retries then fail.
//   - Re-entrant: a process-local Map<lockPath, token> lets a nested call for a lock this
//     process already holds run directly, no re-acquire/release.
//   - The RMW itself (load -> modify -> temp -> fsync -> rename) runs ENTIRELY inside `fn` —
//     this module only brackets it; it never touches the guarded file's own content.
//   - `fn` is SYNCHRONOUS by contract: release runs the instant `fn()` returns, so an async `fn`
//     would release while its own writes were still in flight. That is also why there is no
//     heartbeat renewing `expiresAt` — a timer can never fire while a synchronous `fn` owns the
//     only thread, so liveness, not a timer, is what keeps the lease (`isReclaimable`).
//   - On return, ownership is re-proven. `fn` succeeding but the record no longer being ours means
//     its read-modify-write may have raced a second writer, so the result is NOT returned as a
//     success — it throws LEASE_STOLEN.
//
// P4.3: nothing yet CALLS `withFileLease` in production (the hook-side fallback caller doesn't
// exist), and correspondingly `WorkspaceIndex.persist()` (workspace-index.ts) does NOT currently
// acquire this same lease around its own daemon-side writes — the two writers don't coordinate.
// That's safe only as long as the fallback has zero real callers. The task that wires the
// hook-side caller (glosa init / hooks) MUST make both writers share this exact lease (same
// `fallbackWorkspacesLockPath`), or the daemon and a fallback-writing hook can race a real
// temp->fsync->rename against each other. See the matching note on `persist()` in
// workspace-index.ts.
import { closeSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { hostname as osHostname } from "node:os";
import { type WriteSync, writeAllSync } from "../bus/io.ts";

export const FALLBACK_LEASE_TTL_MS = 30_000;
/** How long past `expiresAt` a lease whose holder still LOOKS alive is kept before it is reclaimed
 * anyway. Liveness proves something about the process, not about the lease, and two cases defeat
 * it: a pid recycled onto an unrelated process, and a holder whose best-effort release failed while
 * it kept running. Without this ceiling either one wedges every registry write for that process's
 * whole lifetime. 10 minutes is two orders of magnitude above the slowest plausible guarded RMW
 * (a `workspaces.json` load -> modify -> temp -> fsync -> rename, milliseconds even on a stalled
 * disk) and far below "a user waits on this" — during the window contenders fail loudly in ~100ms
 * rather than blocking, so the cost of the ceiling being generous is an error message, not a hang. */
export const FALLBACK_ABANDON_GRACE_MS = 600_000;
const ACQUIRE_RETRIES = 5;
const ACQUIRE_BACKOFF_MS = 20;

/** Test seam and TTL knob for the future hook-side caller. Both default to production values;
 * `write` exists only so the fault suite can force the short `write(2)` no real filesystem
 * produces on demand (same seam `WorkspaceIndex` exposes for `persist()`). */
export interface FallbackLeaseOptions {
  ttlMs?: number;
  write?: WriteSync;
}

export interface FallbackLeaseRecord {
  token: string;
  pid: number;
  hostname: string;
  acquiredAt: string;
  expiresAt: number;
}

export interface FallbackLeaseContendedError extends Error {
  code: "LEASE_CONTENDED";
}

/** Raised when `fn` completed but the lock record was no longer ours by the time it returned. The
 * guarded read-modify-write may have interleaved with a second writer's, so its result cannot be
 * reported as a durable success — the caller must re-read and retry. */
export interface FallbackLeaseStolenError extends Error {
  code: "LEASE_STOLEN";
}

function leaseContendedError(lockPath: string, detail: string): FallbackLeaseContendedError {
  const err = new Error(`fallback lease for ${lockPath} is held by another writer: ${detail}`) as FallbackLeaseContendedError;
  err.code = "LEASE_CONTENDED";
  return err;
}

function leaseStolenError(lockPath: string): FallbackLeaseStolenError {
  const err = new Error(
    `fallback lease for ${lockPath} was lost while its critical section was still running; the guarded write may have raced another writer and must be re-read and retried`,
  ) as FallbackLeaseStolenError;
  err.code = "LEASE_STOLEN";
  return err;
}

// lockPath -> token this process currently holds. Presence means a nested call for the SAME
// lockPath runs fn directly, no re-acquire/release — mirrors the same prior art's held-leases map.
const heldLeases = new Map<string, string>();

function sleepSync(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  const arr = new Int32Array(sab);
  Atomics.wait(arr, 0, 0, ms);
}

function readRecord(lockPath: string): FallbackLeaseRecord | null | undefined {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; // vanished (released/reclaimed)
    return null; // unexpected read error — treat as unparseable/live, never stolen
  }
  if (raw.trim() === "") return null;
  try {
    const parsed = JSON.parse(raw) as Partial<FallbackLeaseRecord>;
    if (
      typeof parsed.token !== "string" ||
      typeof parsed.pid !== "number" ||
      typeof parsed.hostname !== "string" ||
      typeof parsed.acquiredAt !== "string" ||
      typeof parsed.expiresAt !== "number"
    ) {
      return null;
    }
    return parsed as FallbackLeaseRecord;
  } catch {
    return null;
  }
}

/** no throw -> alive; ESRCH -> dead (reclaimable); EPERM (alive under another uid) or anything
 * else -> treat as alive, never reclaim on a check we can't actually prove. */
function isPidDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** The ONE place a lease can be taken from a holder that never released it — so the one place a
 * lost update can be manufactured. A4 "Registry-write serialization" calls the TTL a *staleness
 * backstop*, not a deadline, and that distinction is load-bearing: the guarded RMW (load -> modify
 * -> temp -> fsync -> rename) runs entirely inside `fn`, is never renewed while it runs, and on a
 * loaded machine or a stalled fsync can outlive any TTL we pick. Reclaiming on `expiresAt < now`
 * alone therefore hands the lease to a second writer while the first is still mid-write; both then
 * rename over the guarded file, last rename wins, and the loser's registration is gone with no
 * error raised anywhere (its own release correctly declines to unlink a lock it no longer owns).
 *
 * So on the same host — the only topology A4 supports ("Preconditions: ... single host") —
 * `kill(pid, 0)` is a PROOF of liveness and outranks the TTL's guess:
 *   - provably dead (ESRCH) -> reclaim now, TTL irrelevant. A crashed holder is the case the
 *     fallback lease actually has to survive, and this answers it faster than any TTL could.
 *   - alive, or unprovable (EPERM etc.) -> keep until FALLBACK_ABANDON_GRACE_MS past expiry.
 *     Contenders take bounded retries and then fail loudly, which is A4's prescribed posture for
 *     the fallback path ("FAIL LOUDLY, never do unsynchronized writes"), and is strictly better
 *     than corrupting the registry quietly. The grace bounds the two cases liveness cannot
 *     distinguish — see FALLBACK_ABANDON_GRACE_MS.
 * A foreign-host record gives no liveness signal at all, so there the TTL remains the only rule. */
function isReclaimable(record: FallbackLeaseRecord, now: number): boolean {
  if (record.hostname !== osHostname()) return record.expiresAt < now;
  if (isPidDead(record.pid)) return true;
  return now > record.expiresAt + FALLBACK_ABANDON_GRACE_MS;
}

/** Proves the on-disk record is still the one we wrote and, only then, unlinks it. Returns false
 * when ownership cannot be PROVEN — vanished, unparseable, or someone else's token — in which case
 * the file is left strictly alone: unlinking a lease we do not hold is the very steal this module
 * exists to prevent. */
function releaseIfOurs(lockPath: string, token: string): boolean {
  const onDisk = readRecord(lockPath);
  if (!onDisk || onDisk.token !== token) return false;
  try {
    unlinkSync(lockPath);
  } catch {
    // Best-effort: the record WAS provably ours, so this is a released lease either way; a lock
    // file we failed to unlink is reclaimed by the next contender once our pid is gone.
  }
  return true;
}

function acquireAndRun<T>(lockPath: string, fn: () => T, ttlMs: number, write: WriteSync | undefined): T {
  const token = randomUUID();
  let retriesLeft = ACQUIRE_RETRIES;

  for (;;) {
    let fd: number;
    try {
      fd = openSync(lockPath, "wx");
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw e; // e.g. a read-only fs — fail closed, not a contention case

      const record = readRecord(lockPath);
      if (record === undefined) continue; // peer released/reclaimed between our EEXIST and this read

      if (record === null) {
        if (retriesLeft <= 0) throw leaseContendedError(lockPath, "unknown holder (unparseable record)");
        retriesLeft--;
        sleepSync(ACQUIRE_BACKOFF_MS);
        continue;
      }

      const now = Date.now();
      if (isReclaimable(record, now)) {
        try {
          unlinkSync(lockPath);
        } catch (unlinkErr) {
          if ((unlinkErr as NodeJS.ErrnoException).code !== "ENOENT") {
            // unexpected unlink failure — fall through to retry the create loop regardless
          }
        }
        continue; // structurally identical to a fresh acquire — exactly one racing reclaimer wins
      }

      if (retriesLeft <= 0) throw leaseContendedError(lockPath, `pid ${record.pid}@${record.hostname}`);
      retriesLeft--;
      sleepSync(ACQUIRE_BACKOFF_MS);
      continue;
    }

    try {
      const now = Date.now();
      const record: FallbackLeaseRecord = {
        token,
        pid: process.pid,
        hostname: osHostname(),
        acquiredAt: new Date(now).toISOString(),
        expiresAt: now + ttlMs,
      };
      // A4 §F04 — "writeSync may write fewer bytes": a bare single write leaves a truncated record,
      // which readRecord then classifies as an unknown holder. Every contender burns its whole
      // retry budget and fails against a record we truncated ourselves. Same offset-advancing loop
      // journal.ts / inbox.ts / workspace-index.ts already use.
      writeAllSync(fd, Buffer.from(JSON.stringify(record), "utf8"), write);
    } finally {
      closeSync(fd);
    }

    heldLeases.set(lockPath, token);
    let result: T;
    try {
      result = fn();
    } catch (fnErr) {
      // fn's own failure is the more informative one, so it propagates even if the lease was lost
      // too — release stays best-effort on this path exactly as before.
      releaseIfOurs(lockPath, token);
      throw fnErr;
    } finally {
      heldLeases.delete(lockPath);
    }

    // fn SUCCEEDED, so returning its value asserts that its read-modify-write ran under a held
    // lease. `isReclaimable` closes the steal window we can reason about, but not the two we
    // cannot (a recycled pid on this host, a foreign host past its TTL), so ownership is re-proven
    // rather than assumed. Losing it means the guarded write may have interleaved with someone
    // else's — reporting success would be exactly the silent lost update this fix is about.
    if (!releaseIfOurs(lockPath, token)) throw leaseStolenError(lockPath);
    return result;
  }
}

/** Runs `fn` under an exclusive, re-entrant advisory lease on `lockPath`. Used ONLY for the
 * pre-daemon fallback: a hook that must mutate registry state while the daemon is unreachable
 * takes this lease, does its full read-modify-write inside `fn`, and releases — never a bare
 * unsynchronized write to the guarded file.
 *
 * Throws `LEASE_CONTENDED` when the lease could not be acquired inside the retry budget, and
 * `LEASE_STOLEN` when `fn` completed but the lease was no longer ours by then — the second means
 * the guarded write may not have landed, so the caller must re-read and retry rather than treat
 * `fn`'s work as done. `fn` MUST be synchronous: the lease is released the moment it returns. */
export function withFileLease<T>(lockPath: string, fn: () => T, options: FallbackLeaseOptions = {}): T {
  if (heldLeases.has(lockPath)) return fn(); // already held by this process — run directly
  return acquireAndRun(lockPath, fn, options.ttlMs ?? FALLBACK_LEASE_TTL_MS, options.write);
}

// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — the O_EXCL lockfile fallback (A4 "Registry-write serialization"). Used ONLY
// when a hook needs to mutate registry state (`workspaces.json`, or a per-workspace
// `.glosa/.registry.lock`-guarded file) and the daemon is unreachable — the primary path is
// always "serialize through the daemon"; this is the pre-daemon escape hatch, never a
// substitute. EXACT `withSessionLease` semantics from a known prior-art O_EXCL lease
// implementation, generalized to an arbitrary lock file path (this isn't guarding any external
// tool's own session dir, it's guarding glosa's own registry files):
//   - openSync(lockPath, "wx") IS the CAS.
//   - Lock record: {token, pid, hostname, acquiredAt, expiresAt}.
//   - EEXIST -> inspect the holder: unparseable/empty -> treat as live/unknown, retry (never
//     stolen); live -> bounded retries then fail; stale (TTL expired, or same-host pid
//     provably dead via ESRCH) -> reclaim (unlink + re-openSync(wx)) and loop.
//   - Re-entrant: a process-local Map<lockPath, token> lets a nested call for a lock this
//     process already holds run directly, no re-acquire/release.
//   - The RMW itself (load -> modify -> temp -> fsync -> rename) runs ENTIRELY inside `fn` —
//     this module only brackets it; it never touches the guarded file's own content.
//
// P4.3: nothing yet CALLS `withFileLease` in production (the hook-side fallback caller doesn't
// exist), and correspondingly `WorkspaceIndex.persist()` (workspace-index.ts) does NOT currently
// acquire this same lease around its own daemon-side writes — the two writers don't coordinate.
// That's safe only as long as the fallback has zero real callers. The task that wires the
// hook-side caller (glosa init / hooks) MUST make both writers share this exact lease (same
// `fallbackWorkspacesLockPath`), or the daemon and a fallback-writing hook can race a real
// temp->fsync->rename against each other. See the matching note on `persist()` in
// workspace-index.ts.
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { hostname as osHostname } from "node:os";

export const FALLBACK_LEASE_TTL_MS = 30_000;
const ACQUIRE_RETRIES = 5;
const ACQUIRE_BACKOFF_MS = 20;

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

function leaseContendedError(lockPath: string, detail: string): FallbackLeaseContendedError {
  const err = new Error(`fallback lease for ${lockPath} is held by another writer: ${detail}`) as FallbackLeaseContendedError;
  err.code = "LEASE_CONTENDED";
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

function isStale(record: FallbackLeaseRecord, now: number): boolean {
  if (record.expiresAt < now) return true;
  if (record.hostname === osHostname()) return isPidDead(record.pid);
  return false; // different host: TTL is the only signal we have
}

function acquireAndRun<T>(lockPath: string, fn: () => T, ttlMs: number): T {
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
      if (isStale(record, now)) {
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
      writeSync(fd, JSON.stringify(record));
    } finally {
      closeSync(fd);
    }

    heldLeases.set(lockPath, token);
    try {
      return fn();
    } finally {
      heldLeases.delete(lockPath);
      try {
        const onDisk = readRecord(lockPath);
        if (onDisk && onDisk.token === token) unlinkSync(lockPath);
      } catch {
        // release is best-effort — never rethrow over fn's own result/exception
      }
    }
  }
}

/** Runs `fn` under an exclusive, re-entrant advisory lease on `lockPath`. Used ONLY for the
 * pre-daemon fallback: a hook that must mutate registry state while the daemon is unreachable
 * takes this lease, does its full read-modify-write inside `fn`, and releases — never a bare
 * unsynchronized write to the guarded file. */
export function withFileLease<T>(lockPath: string, fn: () => T, ttlMs = FALLBACK_LEASE_TTL_MS): T {
  if (heldLeases.has(lockPath)) return fn(); // already held by this process — run directly
  return acquireAndRun(lockPath, fn, ttlMs);
}

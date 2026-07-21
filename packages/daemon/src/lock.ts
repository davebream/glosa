// @glosa/daemon — `~/.glosa/daemon.lock` read/write. See docs/appendices/A5-daemon-architecture.md
// §F13. Write is `openSync(path, "wx")` (O_EXCL) so bind-then-lock is the CAS that guarantees
// exactly one daemon wins a concurrent boot race; reclaim follows the same reclaim-stale-lock
// pattern as prior art this design draws on.
import { closeSync, fsyncSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";

export interface DaemonLock {
  instance_id: string;
  pid: number;
  port: number;
  protocol_version: string;
  started_at: string;
  host: string;
  bun: string;
}

function isDaemonLockShape(value: unknown): value is DaemonLock {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.instance_id === "string" &&
    typeof v.pid === "number" &&
    typeof v.port === "number" &&
    typeof v.protocol_version === "string" &&
    typeof v.started_at === "string" &&
    typeof v.host === "string" &&
    typeof v.bun === "string"
  );
}

/** Parses lock file contents. Returns null on any malformed/unparseable input — never throws. */
export function parseLock(raw: string): DaemonLock | null {
  try {
    const parsed = JSON.parse(raw);
    return isDaemonLockShape(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Reads + parses the lock file. Missing file and unparseable contents both return null — the
 * caller treats both as "no usable lock" (A5 §F13 stale definition covers both). */
export function readLock(path: string): DaemonLock | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  return parseLock(raw);
}

/** true if a process with this pid exists (owned by us or not) — EPERM still means "alive". */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** O_EXCL create + write + fsync. Throws with `code === "EEXIST"` if the lock already exists —
 * that's the CAS signal callers branch on, not an error to swallow here. */
export function writeLockExclusive(path: string, lock: DaemonLock): void {
  const fd = openSync(path, "wx");
  try {
    writeSync(fd, Buffer.from(JSON.stringify(lock), "utf8"));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** unlink + re-create (A5 §F13 `reclaimStaleLock`). Can itself throw EEXIST if another process
 * wins the create in the gap between unlink and create — callers treat that as "retry failed". */
export function reclaimStaleLock(path: string, lock: DaemonLock): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  writeLockExclusive(path, lock);
}

/** Unlink the lock only if it is still ours (guards against deleting a lock some other
 * instance has since reclaimed — A5 §F13 shutdown guard). */
export function removeLockIfOwned(path: string, instanceId: string): void {
  const current = readLock(path);
  if (current && current.instance_id === instanceId) {
    try {
      unlinkSync(path);
    } catch {
      // already gone — fine, shutdown is idempotent
    }
  }
}

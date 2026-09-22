// SPDX-License-Identifier: Apache-2.0
// One `glosa monitor` per Claude Code session (issue #306).
//
// Three things now start a monitor for one session: the plugin's `always` entry, its
// `on-skill-invoke:glosa-connect` entry, and the `glosa-connect` skill's own Monitor-tool
// fallback. Without a guard that is three processes racing for one registry slot, and the daemon
// resolves that race by DISPLACING the incumbent (`SessionPushRegistry.register` keys on session
// id alone). The loser parks and probes forever, and the winner's empty `accepted` set re-emits
// any entry that was transport-accepted but not yet `presented` — so the same `[glosa <id>]` line
// reaches the session twice. `packages/daemon/test/monitor.test.ts` proves exactly that.
//
// WHY `flock(2)` AND NOT THE DAEMON'S PID-FILE LOCK. `reclaimStaleLock` is `unlink` then create,
// and its own comment concedes the window; that is safe for the daemon only because the daemon's
// real compare-and-swap is the port bind, not the file. A monitor binds nothing, so copying that
// pattern would import the race without the arbiter: A unlinks, A creates, B unlinks A's FRESH
// lock, B creates, and both processes believe they own the session. `isPidAlive` narrows that
// window; it cannot close it. With `flock` there is nothing to judge stale, because the kernel
// drops a dead holder's lock — SIGKILL included — so "is the holder alive" is never asked.
//
// Two macOS specifics this depends on:
//   - `flock` attaches to the OPEN FILE DESCRIPTION, so closing some unrelated fd on the same
//     path does not release it. POSIX record locks (`fcntl` F_SETLK) have the opposite, famously
//     surprising behaviour. That is why this must be `flock` specifically, not merely "a lock".
//   - errno is read through `__error()`, because a failed `flock` and an unsupported filesystem
//     are the same return value and must be told apart.
import { dlopen, FFIType, read } from "bun:ffi";
import { closeSync, ftruncateSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { monitorLockDir, monitorLockPath } from "../../../daemon/src/lifecycle/home.ts";

/** `LOCK_EX | LOCK_SH`-free exclusive, non-blocking: 2 | 4 on Darwin. */
export const LOCK_EX_NB = 6;
/** Darwin's `EWOULDBLOCK`/`EAGAIN`. The ONLY errno that means "someone else holds it". */
export const EWOULDBLOCK = 35;

export type MonitorLockOutcome =
  /** This process owns the session. `release` is best-effort; process exit is the real release. */
  | { held: true; release: () => void }
  /** A live monitor already owns this session. Exit 0 — losing is the designed common case. */
  | { held: false; reason: "already-held"; holder: MonitorLockBody | null }
  /** The guard could not run. RUN ANYWAY — see `acquireMonitorLock`. */
  | { held: false; reason: "unavailable"; detail: string };

export interface MonitorLockBody {
  pid: number;
  session_id: string;
  started_at: string;
}

let libSystem: {
  symbols: { flock: (fd: number, operation: number) => number; __error: () => number };
} | null = null;

function system(): typeof libSystem {
  if (libSystem === null) {
    libSystem = dlopen("libSystem.B.dylib", {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      __error: { args: [], returns: FFIType.ptr },
    }) as unknown as typeof libSystem;
  }
  return libSystem;
}

function errno(): number {
  try {
    return read.i32(system()!.symbols.__error(), 0);
  } catch {
    return 0;
  }
}

/** Best-effort read of whoever holds it, for a diagnostic line and for `doctor`. Never throws:
 * a truncated or half-written body is a normal observation, not a failure. */
export function readMonitorLock(home: string, sessionId: string): MonitorLockBody | null {
  try {
    const raw = readFileSync(monitorLockPath(home, sessionId), "utf8");
    const parsed = JSON.parse(raw) as Partial<MonitorLockBody>;
    return typeof parsed.pid === "number" && typeof parsed.session_id === "string"
      ? { pid: parsed.pid, session_id: parsed.session_id, started_at: String(parsed.started_at ?? "") }
      : null;
  } catch {
    return null;
  }
}

/**
 * Take the session's monitor slot, or report why not.
 *
 * FAILING OPEN IS LOAD-BEARING. Only a literal `EWOULDBLOCK` may stop a monitor. On a filesystem
 * where `flock` is unsupported, or if the FFI binding itself fails, reading "nonzero" as "someone
 * else holds it" would make EVERY monitor exit and take push offline entirely. This guard is an
 * optimization over a system that already tolerates two monitors — badly, through park and
 * supersede, but it tolerates them. A bug in the guard must never be worse than no guard.
 */
export function acquireMonitorLock(home: string, sessionId: string): MonitorLockOutcome {
  const path = monitorLockPath(home, sessionId);
  let fd: number;
  try {
    // Mode is set at creation and never repaired: this directory is the monitor's own, and a
    // monitor does not repair state it did not create.
    mkdirSync(monitorLockDir(home), { recursive: true, mode: 0o700 });
    // "a+" so a losing process never truncates the winner's body out from under it.
    fd = openSync(path, "a+");
  } catch (err) {
    return { held: false, reason: "unavailable", detail: `cannot open ${path}: ${(err as Error).message}` };
  }

  let rc: number;
  try {
    rc = system()!.symbols.flock(fd, LOCK_EX_NB);
  } catch (err) {
    closeSync(fd);
    return { held: false, reason: "unavailable", detail: `flock unavailable: ${(err as Error).message}` };
  }

  if (rc !== 0) {
    const code = errno();
    closeSync(fd);
    if (code === EWOULDBLOCK) {
      return { held: false, reason: "already-held", holder: readMonitorLock(home, sessionId) };
    }
    return { held: false, reason: "unavailable", detail: `flock failed with errno ${code}` };
  }

  // Won. The body is diagnostic only — nothing reads it to decide ownership, because the kernel
  // already decided. `doctor` reads it to distinguish "a monitor process exists but holds no push
  // stream" from "no monitor at all", which nothing else can currently tell apart.
  try {
    const body: MonitorLockBody = { pid: process.pid, session_id: sessionId, started_at: new Date().toISOString() };
    ftruncateSync(fd, 0);
    // "a+" always writes at end-of-file, and the truncate just made that 0.
    writeSync(fd, `${JSON.stringify(body)}\n`);
  } catch {
    // The lock is held either way; a body we could not write costs a diagnostic, not correctness.
  }

  // The fd is deliberately NOT closed on the success path: the lock lives exactly as long as this
  // open file description, which is exactly as long as the process.
  return { held: true, release: () => closeSync(fd) };
}

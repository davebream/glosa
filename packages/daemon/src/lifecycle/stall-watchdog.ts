// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — the stall watchdog (issue #139). A daemon whose event loop stops running keeps
// its listening socket and loses every way it had of noticing or of getting out: no fetch handler
// answers, no `setInterval` fires, and a queued SIGTERM is never dispatched to its JS handler, so
// the daemon that A5 §F13 says stops gracefully on SIGTERM simply does not. In the report that
// state took every glosa client on the machine down until a human found the PID and sent SIGKILL.
//
// A watchdog cannot live on the thread it is watching, so this one is a Worker: its own event loop
// keeps running while the main thread is stuck, and it watches a heartbeat counter in a
// SharedArrayBuffer that only the main thread increments. Past the stall threshold it releases the
// ownership lock — so a replacement daemon can take the port — and SIGKILLs the process, because
// SIGKILL is the one signal a wedged process cannot fail to act on. That is exactly the recovery a
// human performs by hand today, minus the twenty minutes of everything being down.
import { logPath } from "./home.ts";

/** How often the main thread proves it is still running. Frequent enough that the watchdog's own
 * arithmetic is never the imprecise part, cheap enough to be invisible. */
const HEARTBEAT_INTERVAL_MS = 250;

/** Default stall threshold. Two orders of magnitude above any synchronous work the daemon actually
 * does (a journal append + fsync is sub-millisecond) and well past every client's own patience —
 * hooks give up after 3s, CLI and MCP clients after 12s — so by the time this fires, the daemon
 * has already stopped being useful to anyone and holding the port only prevents its replacement. */
export const DEFAULT_STALL_WATCHDOG_MS = 30_000;

export interface StallWatchdogOptions {
  home: string;
  lockFile: string;
  instanceId: string;
  /** Where a start failure is reported. A missing safety net must be visible in the same log the
   * user is told to read, not inferred from its silence. */
  log?: (line: string) => void;
  /** Overrides only for tests; production reads the real process identity and the env. */
  pid?: number;
  stallMs?: number;
}

export interface StallWatchdog {
  /** Stops heartbeating and terminates the worker. Idempotent. */
  stop(): void;
}

/** `GLOSA_STALL_WATCHDOG_MS`: a positive integer sets the threshold, `0` disables the watchdog
 * entirely, and anything unparseable falls back to the default rather than silently disabling a
 * safety net (a typo must never be the thing that turns this off). */
export function resolveStallMs(raw: string | undefined, fallback = DEFAULT_STALL_WATCHDOG_MS): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) return fallback;
  return parsed;
}

/**
 * Starts the watchdog for a daemon that has ALREADY won its lock — `instanceId` is the proof, and
 * the worker unlinks the lock only when it still names this instance, so a watchdog can never
 * delete a record its successor has since written.
 *
 * Returns null when the watchdog is disabled or could not start. A daemon that cannot start its
 * watchdog still serves; losing the safety net is not a reason to refuse to run.
 */
export function startStallWatchdog(options: StallWatchdogOptions): StallWatchdog | null {
  const stallMs = options.stallMs ?? resolveStallMs(Bun.env.GLOSA_STALL_WATCHDOG_MS);
  if (stallMs <= 0) return null;

  const heartbeat = new SharedArrayBuffer(4);
  const counter = new Int32Array(heartbeat);
  let worker: Worker;
  try {
    worker = new Worker(new URL("./stall-watchdog-worker.ts", import.meta.url).href);
  } catch (error) {
    options.log?.(`${options.instanceId} stall watchdog did not start: ${(error as Error).message}`);
    return null;
  }
  worker.postMessage({
    heartbeat,
    pid: options.pid ?? process.pid,
    lockFile: options.lockFile,
    instanceId: options.instanceId,
    logFile: logPath(options.home),
    stallMs,
    intervalMs: HEARTBEAT_INTERVAL_MS,
  });
  // Neither handle may keep the process alive on its own: the listeners decide how long the daemon
  // lives, and a watchdog that outlived them would hold a finished process open.
  // Bun's Worker supports `unref()`; the DOM `Worker` type it structurally matches does not declare
  // it, and an optional call is the honest shape — a runtime without it just keeps a ref'd worker,
  // which the explicit `stop()` below still terminates.
  (worker as Worker & { unref?: () => void }).unref?.();
  const timer = setInterval(() => Atomics.add(counter, 0, 1), HEARTBEAT_INTERVAL_MS);
  timer.unref();

  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      worker.terminate();
    },
  };
}

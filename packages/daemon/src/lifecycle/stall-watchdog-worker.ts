// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — the watching half of the stall watchdog (see stall-watchdog.ts). Runs on its own
// thread precisely so it keeps running when the daemon's main thread does not.
import { appendFileSync, unlinkSync } from "node:fs";
import { readLock } from "./lock.ts";

interface WatchdogStart {
  heartbeat: SharedArrayBuffer;
  pid: number;
  lockFile: string;
  instanceId: string;
  logFile: string;
  stallMs: number;
  intervalMs: number;
}

function log(logFile: string, line: string): void {
  try {
    appendFileSync(logFile, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    // Best-effort, exactly as on the main thread: a watchdog that cannot log must still act.
  }
}

/** Unlinks the ownership lock only while it still names this instance — the same ownership guard
 * `removeLockIfOwned` applies, repeated here because this thread must not import anything that
 * could depend on main-thread state. Releasing it before the kill is what lets the next client
 * spawn a replacement instead of meeting a lock whose PID has just vanished. */
function releaseLock(lockFile: string, instanceId: string): boolean {
  const current = readLock(lockFile);
  if (!current || current.instance_id !== instanceId) return false;
  try {
    unlinkSync(lockFile);
    return true;
  } catch {
    return false;
  }
}

self.onmessage = (event: MessageEvent<WatchdogStart>) => {
  const { heartbeat, pid, lockFile, instanceId, logFile, stallMs, intervalMs } = event.data;
  const counter = new Int32Array(heartbeat);
  let lastSeen = Atomics.load(counter, 0);
  let lastChangedAt = Date.now();
  let fired = false;

  setInterval(
    () => {
      if (fired) return;
      const current = Atomics.load(counter, 0);
      if (current !== lastSeen) {
        lastSeen = current;
        lastChangedAt = Date.now();
        return;
      }
      const stalledFor = Date.now() - lastChangedAt;
      if (stalledFor < stallMs) return;

      fired = true;
      const released = releaseLock(lockFile, instanceId);
      log(
        logFile,
        `${instanceId} event loop has not run for ${stalledFor}ms — the daemon is wedged and cannot ` +
          `shut itself down; ${released ? "released" : "did not hold"} the ownership lock and is ` +
          "ending this process with SIGKILL so the next glosa command can start a replacement",
      );
      // Not SIGTERM: the handler that would answer it lives on the thread that has stopped running.
      process.kill(pid, "SIGKILL");
    },
    Math.max(intervalMs, Math.floor(stallMs / 8)),
  );
};

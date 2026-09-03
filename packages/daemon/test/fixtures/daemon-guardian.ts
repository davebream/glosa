// SPDX-License-Identifier: Apache-2.0
// Test-only guardian: its one isolated daemon home is fixed in argv before the spawn returns, and
// the owning test process keeps stdin open. Unexpected EOF means the owner died before its async
// cleanup hooks ran.
import { lockPath } from "../../src/lifecycle/home.ts";
import { readLock } from "../../src/lifecycle/lock.ts";

const home = process.argv[2];
if (!home) throw new Error("daemon guardian requires an isolated home path");

process.on("SIGINT", () => {});
process.on("SIGHUP", () => {});

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function matchingHandshake(home: string) {
  const lock = readLock(lockPath(home));
  if (!lock) return null;
  try {
    const response = await fetch(`http://127.0.0.1:${lock.port}/api/handshake`, {
      signal: AbortSignal.timeout(500),
    });
    if (!response.ok) return null;
    const handshake = (await response.json()) as { pid?: unknown; instance_id?: unknown };
    return handshake.pid === lock.pid && handshake.instance_id === lock.instance_id ? lock : null;
  } catch {
    return null;
  }
}

async function waitUntil(predicate: () => boolean, deadlineMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < deadlineMs) {
    if (predicate()) return true;
    await Bun.sleep(25);
  }
  return predicate();
}

async function reap(home: string): Promise<void> {
  // The owner can die in the short interval between spawning and lock publication. Wait for the
  // same readiness budget as the test helper before concluding there is no child to reap.
  const startedAt = Date.now();
  let owned = await matchingHandshake(home);
  while (!owned && Date.now() - startedAt < 15_000) {
    await Bun.sleep(25);
    owned = await matchingHandshake(home);
  }
  if (!owned) return;

  try {
    process.kill(owned.pid, "SIGTERM");
  } catch {
    return;
  }
  if (await waitUntil(() => !pidIsAlive(owned.pid), 5_000)) return;

  // Re-prove both ownership records before escalating; never signal a reused or unrelated PID.
  const stillOwned = await matchingHandshake(home);
  if (!stillOwned || stillOwned.pid !== owned.pid || stillOwned.instance_id !== owned.instance_id) return;
  try {
    process.kill(owned.pid, "SIGKILL");
  } catch {
    // already dead
  }
  await waitUntil(() => !pidIsAlive(owned.pid), 5_000);
}

for await (const _chunk of Bun.stdin.stream()) {
  // Only pipe liveness matters. Normal cleanup terminates this guardian after proving the daemon
  // and lock are gone; unexpected owner death closes the pipe and reaches reap().
}

await reap(home);

// SPDX-License-Identifier: Apache-2.0
// Test-only guardian: the owning test process keeps stdin open and registers isolated daemon
// homes before spawning. Unexpected EOF means the owner died before its async cleanup hooks ran.
import { lockPath } from "../../src/home.ts";
import { readLock } from "../../src/lock.ts";

const watched = new Set<string>();

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

let pending = "";
for await (const chunk of Bun.stdin.stream()) {
  pending += Buffer.from(chunk).toString("utf8");
  let newline = pending.indexOf("\n");
  while (newline >= 0) {
    const line = pending.slice(0, newline);
    pending = pending.slice(newline + 1);
    try {
      const command = JSON.parse(line) as { op?: unknown; home?: unknown };
      if (typeof command.home === "string") {
        if (command.op === "watch") watched.add(command.home);
        if (command.op === "unwatch") watched.delete(command.home);
      }
    } catch {
      // A malformed test-control line grants no authority to signal anything.
    }
    newline = pending.indexOf("\n");
  }
}

await Promise.all([...watched].map(reap));

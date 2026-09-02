// SPDX-License-Identifier: Apache-2.0
// Fixture executed as a separate OS PROCESS by lockfile-fallback.test.ts — a holder whose critical
// section is still running long after its own `expiresAt` has passed. Acquires the fallback lease
// on argv[2], writes "holding" to the marker file at argv[3], blocks the thread for argv[4] ms (a
// busy-wait, because that is exactly what a stalled `fsync`/`rename` inside a real read-modify-write
// looks like from the outside: one process, no yields, nothing renewing the lease), then writes
// "done" and releases. The test drives the clock by rewinding the on-disk `expiresAt` rather than
// waiting out a real TTL, so the holder needs no knobs and this fixture stays signature-stable.
import { writeFileSync } from "node:fs";
import { withFileLease } from "../../../src/registry/lockfile-fallback.ts";

const [, , lockPath, markerPath, holdArg] = process.argv;
if (!lockPath || !markerPath || !holdArg) {
  throw new Error("usage: slow-holder.ts <lockPath> <markerPath> <holdMs>");
}
const holdMs = Number(holdArg);

withFileLease(lockPath, () => {
  writeFileSync(markerPath, "holding");
  const until = Date.now() + holdMs;
  while (Date.now() < until) {
    // busy-wait — a blocking critical section, never renewed while it runs
  }
  writeFileSync(markerPath, "done");
});

// SPDX-License-Identifier: Apache-2.0
// Fixture executed as a separate OS PROCESS by lockfile-fallback.test.ts's cross-process suite —
// proves `withFileLease` serializes real concurrent processes, not just concurrent in-process
// promises (which JS's single-threaded event loop makes trivially safe on its own). Acquires the
// fallback lease on argv[2] `times` (argv[4]) times and, entirely inside each lease, does a full
// read-modify-write increment of the JSON counter at argv[3]. A lost update (two processes both
// reading the same "current" value before either writes) shows up as a final count lower than
// `processes * times` — that's what the test asserts against.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { withFileLease } from "../../../src/registry/lockfile-fallback.ts";

const [, , lockPath, counterPath, timesArg] = process.argv;
if (!lockPath || !counterPath || !timesArg) {
  throw new Error("usage: fallback-writer.ts <lockPath> <counterPath> <times>");
}
const times = Number(timesArg);

interface Counter {
  count: number;
}

for (let i = 0; i < times; i++) {
  // Heavy 5-process contention over a bounded (5-retry) acquire budget can transiently exceed it
  // even though every writer eventually succeeds — retry on LEASE_CONTENDED rather than treating
  // it as a real failure; this fixture is proving "no lost update," not "acquire never contends."
  for (;;) {
    try {
      withFileLease(lockPath, () => {
        const current: number = existsSync(counterPath) ? (JSON.parse(readFileSync(counterPath, "utf8")) as Counter).count : 0;
        // Hold the lease across a tiny synchronous delay — widens the race window a real
        // unsynchronized read-modify-write would lose, without slowing the test down noticeably.
        const start = Date.now();
        while (Date.now() - start < 2) {
          // busy-wait
        }
        writeFileSync(counterPath, JSON.stringify({ count: current + 1 } satisfies Counter));
      });
      break;
    } catch (err) {
      if ((err as { code?: string }).code !== "LEASE_CONTENDED") throw err;
    }
  }
}

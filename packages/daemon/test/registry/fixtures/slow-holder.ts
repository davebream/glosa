// SPDX-License-Identifier: Apache-2.0
// A synchronous critical section stays blocked until the parent has tested live-holder exclusion.
// Blocking on stdin models a stalled filesystem operation without burning CPU or renewing a lease.
import { readSync, writeFileSync } from "node:fs";
import { withFileLease } from "../../../src/registry/lockfile-fallback.ts";

const [, , lockPath, markerPath] = process.argv;
if (!lockPath || !markerPath) throw new Error("usage: slow-holder.ts <lockPath> <markerPath>");
withFileLease(lockPath, () => {
  writeFileSync(markerPath, "holding");
  const release = Buffer.alloc(1);
  if (readSync(0, release, 0, 1, null) !== 1 || release[0] !== 1)
    throw new Error("parent ended without releasing holder");
  writeFileSync(markerPath, "done");
});

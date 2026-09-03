// SPDX-License-Identifier: Apache-2.0
//
// Runs the T8 deterministic acceptance gate — the suites `docs/requirements.md` §5 names as
// mandatory, and nothing else. Membership lives in `scripts/acceptance-suites.ts`; this file
// only prints it and hands it to Bun.
//
// Paths are passed `./`-prefixed on purpose. Bun treats a bare argument as a name *filter*,
// so a renamed or deleted suite would match nothing and the run would still exit 0 — the
// exact silent rot this gate exists to prevent. A `./`-prefixed argument is treated as a
// path, and Bun exits non-zero when it does not resolve.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  ACCEPTANCE_SUITES,
  acceptanceFiles,
  GATE_GUARD_FILE,
  REQUIRED_SUITES,
  SUITE_CLAUSES,
} from "./acceptance-suites.ts";

const root = resolve(import.meta.dir, "..");
const files = acceptanceFiles();

console.log("T8 deterministic acceptance gate — docs/requirements.md §5\n");
for (const suite of REQUIRED_SUITES) {
  console.log(`  ${suite} — ${SUITE_CLAUSES[suite]}`);
  for (const file of ACCEPTANCE_SUITES[suite]) {
    console.log(`      ${file}`);
  }
}
console.log(`  gate guard\n      ${GATE_GUARD_FILE}`);
console.log(`\n${files.length} files across ${REQUIRED_SUITES.length} named suites.\n`);

const missing = files.filter((file) => !existsSync(resolve(root, file)));
if (missing.length > 0) {
  console.error("Acceptance membership is stale — these files no longer exist:");
  for (const file of missing) console.error(`  ${file}`);
  console.error("\nFix scripts/acceptance-suites.ts and test/acceptance/T8-GATE.md together.");
  process.exit(1);
}

const child = Bun.spawnSync({
  cmd: ["bun", "test", ...files.map((file) => `./${file}`)],
  cwd: root,
  stdio: ["inherit", "inherit", "inherit"],
});

process.exit(child.exitCode ?? 1);

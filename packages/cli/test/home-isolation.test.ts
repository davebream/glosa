// SPDX-License-Identifier: Apache-2.0
// Regression guard: `bun test` must not pass or fail based on the DEVELOPER's own `~/.glosa`.
//
// `scoped-init.ts`'s `rootsFor()` (A6 §F26) defaults `glosaHome` to `$GLOSA_HOME ?? ~/.glosa`, so
// any CLI test that reaches the install-roots surface without pinning `GLOSA_HOME` reads the real
// user-scope ownership manifest — and takes a `.lock` beside it. A machine whose `~/.glosa/
// init-manifest.json` recorded a user-scope `codex` install therefore made the cross-scope
// duplicate guard fire inside CLI init tests and exit 2, turning a green suite red on that
// machine only.
//
// packages/daemon/test/helpers.ts:1-4 already states this standard for the daemon suites
// ("nothing here ever touches a real `~/.glosa`"). This test makes it enforceable for the CLI
// suites rather than conventional.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
// This file is excluded from its own scan: the patterns below appear here as regex literals and
// as prose, which is a match on the text without being a call into the surface.
const SELF = "home-isolation.test.ts";

/** Every entry point whose default path resolves `rootsFor()`'s `glosaHome`, plus the `init`
 * subcommand of the CLI boundary itself, which reaches all of them and has no seam of its own. */
const ROOT_REACHING: readonly RegExp[] = [
  /\brunScopedInit\s*\(/,
  /\brunScopedUninstall\s*\(/,
  /\bdetectInstallProviders\s*\(/,
  /\bscopedManifestPaths\s*\(/,
  /\bcheckScopedManifestDrift\s*\(/,
  /\brun\s*\(\s*\[\s*"init"/,
];
/** The one sanctioned isolation: `packages/cli/test/home.ts`'s per-test temp `GLOSA_HOME`. */
const ISOLATED = /\buseTempHome\s*\(\s*\)/;

function cliTestFiles(): string[] {
  return readdirSync(TEST_DIR, { recursive: true })
    .map(String)
    .filter((name) => name.endsWith(".test.ts") && name !== SELF)
    .sort();
}

function reachesInstallRoots(name: string): boolean {
  const source = readFileSync(join(TEST_DIR, name), "utf8");
  return ROOT_REACHING.some((pattern) => pattern.test(source));
}

describe("CLI test home isolation", () => {
  test("no CLI test reaches glosa's install roots without a temp GLOSA_HOME", () => {
    const violations = cliTestFiles().filter(
      (name) => reachesInstallRoots(name) && !ISOLATED.test(readFileSync(join(TEST_DIR, name), "utf8")),
    );
    expect(violations).toEqual([]);
  });

  // A guard whose detector matches nothing passes forever. Pin the detector to the suites that
  // genuinely reach the surface, so deleting a pattern disarms this file loudly instead of silently.
  test("the detector still recognises the suites that reach the install roots", () => {
    const reaching = cliTestFiles().filter(reachesInstallRoots);
    expect(reaching).toContain("index-init.test.ts");
    expect(reaching).toContain("init.test.ts");
  });
});

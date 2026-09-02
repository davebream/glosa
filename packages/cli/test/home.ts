// SPDX-License-Identifier: Apache-2.0
// Test-only `GLOSA_HOME` isolation for the CLI suites. `scoped-init.ts`'s `rootsFor()` (A6 §F26)
// resolves the user-scope ownership manifest at `$GLOSA_HOME ?? ~/.glosa`, so a CLI test that
// leaves `GLOSA_HOME` unset reads the developer's own install state — and takes a `.lock` beside
// it. Nothing here ever touches a real `~/.glosa`, matching the standard already stated in
// packages/daemon/test/helpers.ts:1-4.
//
// `GLOSA_HOME` rather than `HOME` is the seam because Bun's `os.homedir()` does NOT follow a
// mutated `process.env.HOME`, so redirecting `HOME` would silently isolate nothing.
import { afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** The real user-scope glosa root, captured at module load — before any test redirects it. Tests
 * assert against it to prove their temp home is a genuine redirect and not a coincidence. */
export const REAL_GLOSA_HOME = process.env.GLOSA_HOME ?? join(homedir(), ".glosa");

let current: string | null = null;

/** The temp `GLOSA_HOME` owned by the running test. */
export function tempGlosaHome(): string {
  if (current === null) throw new Error("tempGlosaHome() is only valid inside a useTempHome() suite");
  return current;
}

/**
 * Point `GLOSA_HOME` at a fresh temp directory for every test in the calling file, and restore the
 * previous value afterwards. The save-and-restore is unconditional — matching
 * packages/daemon/test/lifecycle.test.ts:268-304 — because a real run may legitimately have
 * inherited a `GLOSA_HOME` that later suites in the same process still depend on.
 */
export function useTempHome(): void {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.GLOSA_HOME;
    current = mkdtempSync(join(tmpdir(), "glosa-cli-home-"));
    process.env.GLOSA_HOME = current;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.GLOSA_HOME;
    else process.env.GLOSA_HOME = saved;
    if (current !== null) rmSync(current, { recursive: true, force: true });
    current = null;
  });
}

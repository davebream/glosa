// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import rootPackage from "../package.json" with { type: "json" };

const root = resolve(import.meta.dir, "..");
const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");

/** The condition every expensive `ci` step carries. Resolved once, in one step, from the
 * paths filter plus the always-run-on-main and force-dispatch escapes. */
const GATE = "if: env.RUN_FULL == 'true'";

/** Every step a documentation-only diff is allowed to skip. Named exhaustively so that adding a
 * new expensive step without gating it — or gating one on something other than GATE — fails here
 * rather than quietly costing three minutes on every markdown typo. */
const GATED_STEPS = [
  "Set up Bun",
  "Install dependencies",
  "Lint full repository",
  "Typecheck",
  "Acceptance suites (T8 deterministic gate)",
  "Test (first pass)",
  "Test (second pass)",
  "Audit production dependency licenses",
  "Inspect and smoke-test npm tarball",
];

describe("repository quality gates", () => {
  test("lint checks the full repository in local and CI runs", () => {
    expect(rootPackage.scripts.lint).toBe("biome lint . --no-errors-on-unmatched");

    // This guards lint's SCOPE, not how often it runs: CI must invoke the full-repository
    // script rather than a narrowed or --staged variant. The optional `if:` line between the
    // name and the run keeps that assertion from breaking every time the step is re-gated.
    expect(ci).toMatch(/- name: Lint full repository\n(?:\s+if: .+\n)?\s+run: bun run lint\n/);
  });

  test("the non-writing format check runs last in the main check workflow", () => {
    expect(rootPackage.scripts["format:check"]).toBe("biome format .");
    expect(rootPackage.scripts.check.split(" && ").at(-1)).toBe("bun run format:check");
  });

  test("every expensive CI step is gated on the one documented condition", () => {
    for (const name of GATED_STEPS) {
      expect(ci).toContain(`- name: ${name}\n        ${GATE}\n`);
    }
  });

  test("the gate is step-level, never workflow-level", () => {
    // `ci` and `security` are required status checks on main. A workflow skipped by a paths
    // filter never reports a check at all, so branch protection would wait forever and no PR
    // could merge. The job must always run and skip its own steps instead.
    expect(ci).not.toMatch(/^\s*paths(-ignore)?:/m);
    expect(ci).toMatch(/^ {2}ci:\n {4}name: ci$/m);
    expect(ci).toMatch(/^ {2}security:\n {4}name: security$/m);
  });

  test("secret and dependency scanning is never gated", () => {
    // A markdown file is a plausible place to paste a token by accident, so the security job
    // must see every diff — including, and especially, a documentation-only one.
    const security = ci.slice(ci.indexOf("\n  security:"));
    expect(security).toContain("gitleaks");
    expect(security).toContain("osv-scanner");
    expect(security).not.toContain("RUN_FULL");
    expect(security).not.toMatch(/^\s+if:/m);
  });

  test("the documentation filter excludes only inert paths and fails closed", () => {
    // An allowlist of inert paths, never a denylist of code paths: anything unanticipated must
    // run the full suite rather than silently skip it. `**` is what makes it an allowlist.
    expect(ci).toContain("- '**'\n");
    for (const excluded of ["- '!**/*.md'", "- '!docs/assets/**'", "- '!LICENSE'", "- '!.github/ISSUE_TEMPLATE/**'"]) {
      expect(ci).toContain(excluded);
    }

    // Load-bearing: under the default quantifier a `!pattern` entry is evaluated as its own
    // positive match rather than as an exclusion, so the filter would resolve true for every
    // diff and the gate would silently do nothing.
    expect(ci).toContain('predicate-quantifier: "some-with-excludes"');

    // Changing CI must always run CI, so the workflow directory is never excluded.
    expect(ci).not.toContain("!.github/workflows");
  });
});

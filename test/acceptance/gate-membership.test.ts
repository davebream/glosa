// SPDX-License-Identifier: Apache-2.0
//
// The T8 gate is only as honest as its membership list. This guard makes a suite impossible
// to drop, rename away, or document wrongly without a red test:
//
//   - every suite named in docs/requirements.md §5 exists in the mapping and is non-empty;
//   - every mapped file exists on disk;
//   - the mapping and the table in T8-GATE.md agree, path for path;
//   - package.json actually wires `test:acceptance` to the runner that reads the mapping.
//
// A renamed suite therefore fails here *and* fails the runner. It never just vanishes.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import rootPackage from "../../package.json" with { type: "json" };
import {
  ACCEPTANCE_SUITES,
  acceptanceFiles,
  GATE_GUARD_FILE,
  REQUIRED_SUITES,
  SUITE_CLAUSES,
  type SuiteName,
} from "../../scripts/acceptance-suites.ts";

const root = resolve(import.meta.dir, "../..");
const gateDoc = readFileSync(join(root, "test/acceptance/T8-GATE.md"), "utf8");

/** Parses the `| suite | file |` membership table out of T8-GATE.md. */
function documentedMembership(): Map<string, string[]> {
  const rows = gateDoc
    .split("\n")
    .map((line) => /^\|\s*`([a-z-]+)`\s*\|\s*`([^`]+\.test\.ts)`\s*\|$/.exec(line.trim()))
    .filter((match): match is RegExpExecArray => match !== null);
  const documented = new Map<string, string[]>();
  for (const [, suite, file] of rows) {
    const existing = documented.get(suite as string);
    if (existing) existing.push(file as string);
    else documented.set(suite as string, [file as string]);
  }
  return documented;
}

describe("T8 acceptance gate membership", () => {
  test("every suite named in requirements.md §5 is mapped and non-empty", () => {
    expect([...REQUIRED_SUITES]).toEqual([
      "fault",
      "concurrency",
      "delivery",
      "security",
      "anchor",
      "transcript",
      "explicit-binding-topology",
    ]);
    for (const suite of REQUIRED_SUITES) {
      expect(ACCEPTANCE_SUITES[suite].length, suite).toBeGreaterThan(0);
      expect(SUITE_CLAUSES[suite]?.length, suite).toBeGreaterThan(0);
    }
  });

  test("every mapped file exists on disk", () => {
    for (const file of acceptanceFiles()) {
      expect(existsSync(join(root, file)), file).toBe(true);
    }
  });

  test("the gate runs each file exactly once", () => {
    const files = acceptanceFiles();
    expect(new Set(files).size).toBe(files.length);
    expect(files.at(-1)).toBe(GATE_GUARD_FILE);
  });

  test("T8-GATE.md documents exactly what the runner runs", () => {
    const documented = documentedMembership();
    expect([...documented.keys()].sort()).toEqual([...REQUIRED_SUITES].sort());
    for (const suite of REQUIRED_SUITES) {
      expect(documented.get(suite)?.sort(), suite).toEqual([...ACCEPTANCE_SUITES[suite]].sort());
    }
  });

  test("T8-GATE.md quotes the requirement clause each suite discharges", () => {
    for (const suite of REQUIRED_SUITES) {
      expect(gateDoc.includes(SUITE_CLAUSES[suite as SuiteName]), suite).toBe(true);
    }
  });

  test("the deterministic gate runs the acceptance script, not only bare `bun test`", () => {
    expect(rootPackage.scripts["test:acceptance"]).toBe("bun run scripts/test-acceptance.ts");
    for (const step of [
      "bun run typecheck",
      "bun run test:acceptance",
      "bun test",
      "bun run audit:licenses",
      "bun run package:check",
    ]) {
      expect(gateDoc.includes(step), step).toBe(true);
    }
  });

  test("CI runs the same gate the document describes", () => {
    for (const workflow of [".github/workflows/ci.yml", ".github/workflows/release.yml"]) {
      const yaml = readFileSync(join(root, workflow), "utf8");
      expect(yaml.includes("bun run test:acceptance"), workflow).toBe(true);
    }
  });
});

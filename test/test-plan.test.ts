// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildPlan,
  changedPaths,
  classifyChanges,
  discoverTests,
  gitEnvironment,
  expectedJobs,
  validatePartitions,
  validateResults,
} from "../scripts/test-plan.ts";
import baseline from "../scripts/test-timings.json";

// #317: the baseline is a REVIEWED artifact — T8-GATE.md requires refreshing it from successful
// same-runtime CI JUnit durations, comparing several runs, and never updating it automatically. So
// this does not regenerate anything; it makes the drift visible, because the planner degrades
// silently. An unmeasured file is scheduled at the documented one-second estimate, which for a file
// that really costs thirty seconds quietly unbalances the shard it lands in.
//
// A RATCHET, not a target. These numbers may only go DOWN, by refreshing the baseline per
// T8-GATE.md. A rise means the suite grew away from the file again and the partitions are drifting.
test("#317 the timings baseline still covers the suite it schedules", () => {
  const inventory = discoverTests();
  const recorded = new Set(Object.keys(baseline.files));
  const unmeasured = inventory.filter((file) => !recorded.has(file));
  const vanished = [...recorded].filter((file) => !inventory.includes(file));

  expect(inventory.length, "an empty inventory would make every count below vacuously fine").toBeGreaterThan(100);
  // 51, not 50, because #207 adds `test/acceptance/daemon-identity-socket.test.ts` and this
  // repository has no CI duration for a file that does not exist yet. The alternative — writing a
  // locally measured number into `scripts/test-timings.json` — is worse: that artifact is defined
  // as "refreshed from successful same-runtime CI JUnit suite durations, comparing multiple runs"
  // (T8-GATE.md §1), so a hand-entered value would lower this count while making the artifact
  // less true, which is exactly the drift the guard exists to surface. Raising the budget keeps
  // the drift visible. The next baseline refresh should bring it back below 50.
  expect(
    unmeasured.length,
    `files with no recorded duration, scheduled at the 1s estimate: ${unmeasured.join(", ")}`,
  ).toBeLessThanOrEqual(51);
  expect(
    vanished.length,
    `recorded durations for files that no longer exist: ${vanished.join(", ")}`,
  ).toBeLessThanOrEqual(11);
});

test("coverage partitions are a complete disjoint union of the discovered inventory", () => {
  const files = discoverTests();
  const plan = buildPlan(files);
  validatePartitions(files, [plan.acceptance, plan["remaining-1"], plan["remaining-2"]]);
  expect(files.length).toBeGreaterThan(150);
});
test("omission, duplication, stale acceptance membership and empty partitions fail closed", () => {
  expect(() => validatePartitions(["a", "b"], [["a"]])).toThrow("Omitted");
  expect(() => validatePartitions(["a", "b"], [["a"], ["a", "b"]])).toThrow("Duplicate");
  expect(() => validatePartitions(["a"], [["a"], []])).toThrow("Empty");
  expect(() => buildPlan(["a", "b", "c"], ["missing"])).toThrow("Unknown");
});
test("balancing is deterministic and gives unseen tests a one-second estimate", () => {
  const plan = buildPlan(["gate", "a", "b", "new"], ["gate"], { a: 5, b: 3 });
  expect(plan["remaining-1"]).toEqual(["a"]);
  expect(plan["remaining-2"]).toEqual(["b", "new"]);
  expect(() => buildPlan(["gate", "a", "b"], ["gate"], { a: -1 })).toThrow("Invalid duration");
});
test("new tests are discovered without a manifest edit; ignored scratch and generated files stay out", () => {
  const root = mkdtempSync(join(tmpdir(), "glosa-inventory-"));
  try {
    expect(Bun.spawnSync(["git", "init", root], { env: gitEnvironment() }).exitCode).toBe(0);
    writeFileSync(join(root, ".gitignore"), "scratch/\n");
    for (const file of [
      "new.test.ts",
      "module.test.mjs",
      "suite/types.spec.cts",
      "suite/new_spec.ts",
      "scratch/no.test.ts",
      ".context/no.test.ts",
      "dist/no.test.ts",
      "node_modules/no.test.ts",
    ]) {
      mkdirSync(join(root, file, ".."), { recursive: true });
      writeFileSync(join(root, file), "");
    }
    expect(discoverTests(root)).toEqual([
      "module.test.mjs",
      "new.test.ts",
      "suite/new_spec.ts",
      "suite/types.spec.cts",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("documentation consumers run for root/corpus/gate/docs changes; fixtures and mixed changes run everything", () => {
  for (const path of [
    "README.md",
    "AGENTS.md",
    "docs/requirements.md",
    "test/acceptance/T8-GATE.md",
    "docs/assets/example.png",
    "LICENSE",
    ".github/ISSUE_TEMPLATE/bug.yml",
  ])
    expect(classifyChanges("pull_request", [path])).toBe("docs");
  for (const paths of [
    ["packages/spa/test/fixtures/example.md"],
    ["README.md", "package.json"],
    [".github/workflows/ci.yml"],
    [".gitignore"],
    ["old.test.ts", "docs/new.md"],
    [],
  ])
    expect(classifyChanges("pull_request", paths)).toBe("full");
  expect(classifyChanges("pull_request", null)).toBe("full");
  expect(classifyChanges("pull_request", ["README.md"], true)).toBe("full");
  for (const event of ["push", "workflow_dispatch", "unknown"])
    expect(classifyChanges(event, ["README.md"])).toBe("full");
});
test("every failed, cancelled, missing or unexpectedly skipped dependency blocks the aggregate", () => {
  for (const profile of ["docs", "full"] as const)
    for (const whole of profile === "docs" ? [false] : [false, true]) {
      const results = Object.fromEntries(
        Object.entries(expectedJobs(profile, whole)).map(([key, result]) => [key, { result }]),
      );
      expect(() => validateResults(profile, String(whole), results)).not.toThrow();
      for (const [key, value] of Object.entries(results)) {
        for (const result of ["failure", "cancelled", value.result === "success" ? "skipped" : "success"])
          expect(() => validateResults(profile, String(whole), { ...results, [key]: { result } })).toThrow(key);
        const missing = { ...results };
        delete missing[key];
        expect(() => validateResults(profile, String(whole), missing)).toThrow(key);
      }
    }
  expect(() => validateResults("", "", {})).toThrow("preparation");
  expect(() => validateResults("docs", "true", {})).toThrow("preparation");
});

test("real git diffs retain renamed and deleted paths; unavailable bases fail closed", () => {
  const root = mkdtempSync(join(tmpdir(), "glosa-diff-"));
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], {
      cwd: root,
      env: gitEnvironment(),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    return result.stdout.toString().trim();
  };
  try {
    git("init");
    writeFileSync(join(root, "old.test.ts"), "original source");
    writeFileSync(join(root, "deleted.md"), "deleted document");
    git("add", ".");
    git("commit", "-m", "fixture baseline");
    const base = git("rev-parse", "HEAD");
    renameSync(join(root, "old.test.ts"), join(root, "README.md"));
    rmSync(join(root, "deleted.md"));
    git("add", ".");
    git("commit", "-m", "fixture rename and delete");
    expect(changedPaths(base, root)?.sort()).toEqual(["README.md", "deleted.md", "old.test.ts"]);
    expect(classifyChanges("pull_request", changedPaths(base, root))).toBe("full");
    expect(changedPaths("0".repeat(40), root)).toBeNull();
    expect(changedPaths("--bad", root)).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Git hooks cannot redirect fixture operations through ambient repository selectors", () => {
  const root = mkdtempSync(join(tmpdir(), "glosa-hook-isolation-"));
  const victim = join(root, "victim");
  const fixture = join(root, "fixture");
  try {
    expect(Bun.spawnSync(["git", "init", victim], { env: gitEnvironment() }).exitCode).toBe(0);
    const env = gitEnvironment({
      ...process.env,
      GIT_DIR: join(victim, ".git"),
      GIT_WORK_TREE: victim,
      GIT_INDEX_FILE: join(victim, ".git/index"),
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.bare",
      GIT_CONFIG_VALUE_0: "true",
    });
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_WORK_TREE).toBeUndefined();
    expect(env.GIT_CONFIG_COUNT).toBeUndefined();
    expect(Bun.spawnSync(["git", "init", fixture], { env }).exitCode).toBe(0);
    writeFileSync(join(fixture, "isolated.test.ts"), "");
    expect(discoverTests(fixture)).toEqual(["isolated.test.ts"]);
    const state = Bun.spawnSync(["git", "-C", victim, "rev-parse", "--is-bare-repository"], {
      env: gitEnvironment(),
      stdout: "pipe",
    });
    expect(state.stdout.toString().trim()).toBe("false");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

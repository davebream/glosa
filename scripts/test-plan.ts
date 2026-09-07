// SPDX-License-Identifier: Apache-2.0
import { appendFileSync, existsSync, realpathSync } from "node:fs";
import { resolve, relative } from "node:path";
import { acceptanceFiles } from "./acceptance-suites.ts";
import baseline from "./test-timings.json";

export const ROOT = resolve(import.meta.dir, "..");
export const DOC_FILES = [
  "packages/spa/test/rich-editor.test.ts",
  "test/acceptance/gate-membership.test.ts",
  "test/quality-gates.test.ts",
  "test/oss-release.test.ts",
];
export const STABILITY_FILES = [
  "packages/daemon/test/lifecycle.test.ts",
  "packages/daemon/test/helpers.test.ts",
  "packages/daemon/test/registry/lockfile-fallback.test.ts",
];
export type Profile = "acceptance" | "remaining-1" | "remaining-2" | "docs" | "stability" | "full";
export type ChangeProfile = "docs" | "full";
export type Plan = Record<Profile, string[]>;

/** Hooks export repository selectors; cwd alone does not isolate a Git subprocess. */
export function gitEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(base).filter(([key]) => !key.startsWith("GIT_") && key !== "ANTHROPIC_API_KEY"),
    ),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function git(args: string[], root: string): string {
  const child = Bun.spawnSync(["git", ...args], { cwd: root, env: gitEnvironment(), stdout: "pipe", stderr: "pipe" });
  if (child.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${child.stderr.toString()}`);
  return child.stdout.toString();
}

export function changedPaths(base: string, root = ROOT): string[] | null {
  if (!/^[a-f0-9]{40}$/.test(base)) return null;
  try {
    // Disable rename folding so neither side of a rename can disappear from classification.
    return git(["diff", "--name-only", "--no-renames", "-z", `${base}...HEAD`], root)
      .split("\0")
      .filter(Boolean);
  } catch {
    return null;
  }
}

/** Git's index + nonignored working files includes new tests without scanning scratch directories. */
export function discoverTests(root = ROOT): string[] {
  return [...new Set(git(["ls-files", "-c", "-o", "--exclude-standard", "-z"], root).split("\0"))]
    .filter((path) => /[._](test|spec)\.(?:[jt]sx?|[cm][jt]s)$/.test(path))
    .filter(
      (path) =>
        !path
          .split("/")
          .some((part) => part.startsWith(".") || ["node_modules", "dist", "build", "graphify-out"].includes(part)),
    )
    .sort();
}

export function validatePartitions(inventory: string[], partitions: string[][]): void {
  if (inventory.length === 0 || new Set(inventory).size !== inventory.length) throw new Error("Invalid test inventory");
  const seen = new Set<string>();
  for (const files of partitions) {
    if (files.length === 0) throw new Error("Empty required test partition");
    for (const file of files) {
      if (!inventory.includes(file)) throw new Error(`Unknown test in partition: ${file}`);
      if (seen.has(file)) throw new Error(`Duplicate test assignment: ${file}`);
      seen.add(file);
    }
  }
  const missing = inventory.filter((file) => !seen.has(file));
  if (missing.length) throw new Error(`Omitted tests: ${missing.join(", ")}`);
}

export function buildPlan(
  inventory = discoverTests(),
  acceptance = acceptanceFiles(),
  timings: Record<string, number> = baseline.files,
): Plan {
  const groups: [string[], string[]] = [[], []];
  const totals = [0, 0];
  const weight = (file: string) => {
    const value = timings[file] ?? 1;
    if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid duration for ${file}`);
    return value;
  };
  const remaining = inventory.filter((file) => !acceptance.includes(file));
  remaining.sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : a > b ? 1 : 0));
  for (const file of remaining) {
    const index = totals[0]! <= totals[1]! ? 0 : 1;
    groups[index].push(file);
    totals[index]! += weight(file);
  }
  validatePartitions(inventory, [acceptance, ...groups]);
  return {
    acceptance,
    "remaining-1": groups[0],
    "remaining-2": groups[1],
    docs: [...DOC_FILES],
    stability: [...STABILITY_FILES],
    full: inventory,
  };
}

export function checkedFiles(profile: string, root = ROOT): string[] {
  const plan = buildPlan(discoverTests(root));
  if (!Object.hasOwn(plan, profile)) throw new Error(`Unsupported test profile: ${profile}`);
  const files = plan[profile as Profile];
  if (!files.length || new Set(files).size !== files.length) throw new Error("Empty or duplicate selection");
  for (const file of files) {
    const path = resolve(root, file);
    if (!existsSync(path) || relative(root, realpathSync(path)).startsWith(".."))
      throw new Error(`Missing or unconfined test: ${file}`);
    if (!plan.full.includes(file)) throw new Error(`Selected file is outside test inventory: ${file}`);
  }
  return files;
}

export function classifyChanges(event: string, paths: string[] | null, forced = false): ChangeProfile {
  if (event !== "pull_request" || forced || !paths?.length) return "full";
  const docs = (path: string) =>
    /^[^/]+\.md$/.test(path) ||
    /^docs\/.*\.md$/.test(path) ||
    path.startsWith("docs/assets/") ||
    path === "test/acceptance/T8-GATE.md" ||
    path === "LICENSE" ||
    path.startsWith(".github/ISSUE_TEMPLATE/");
  return paths.every(docs) ? "docs" : "full";
}

export function expectedJobs(profile: ChangeProfile, whole: boolean): Record<string, string> {
  return {
    prepare: "success",
    quality: "success",
    docs: profile === "docs" ? "success" : "skipped",
    tests: profile === "full" ? "success" : "skipped",
    stability: profile === "full" ? "success" : "skipped",
    full: whole ? "success" : "skipped",
  };
}
export function validateResults(profile: string, whole: string, results: Record<string, { result: string }>): void {
  if (
    !["docs", "full"].includes(profile) ||
    !["true", "false"].includes(whole) ||
    (profile === "docs" && whole === "true")
  )
    throw new Error("Missing or invalid preparation outputs");
  for (const [job, expected] of Object.entries(expectedJobs(profile as ChangeProfile, whole === "true"))) {
    if (results[job]?.result !== expected)
      throw new Error(`${job}: expected ${expected}, received ${results[job]?.result ?? "missing"}`);
  }
}

if (import.meta.main) {
  const command = process.argv[2];
  if (command === "prepare") {
    let paths: string[] | null = null;
    const event = process.env.GITHUB_EVENT_NAME ?? "unknown";
    const base = process.env.TEST_DIFF_BASE ?? "";
    if (event === "pull_request") paths = changedPaths(base);
    const profile = classifyChanges(event, paths, process.env.TEST_FORCE_FULL === "true");
    const whole = event !== "pull_request";
    const repetitions = process.env.TEST_STABILITY_REPETITIONS || "2";
    if (!["2", "10"].includes(repetitions)) throw new Error("Stability repetitions must be 2 or 10");
    console.log(JSON.stringify({ profile, whole, repetitions, partitions: buildPlan() }, null, 2));
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(process.env.GITHUB_OUTPUT, `profile=${profile}\nwhole=${whole}\nrepetitions=${repetitions}\n`);
  } else if (command === "aggregate") {
    validateResults(
      process.env.TEST_PROFILE ?? "",
      process.env.TEST_WHOLE ?? "",
      JSON.parse(process.env.TEST_RESULTS ?? "{}"),
    );
  } else {
    throw new Error("Usage: test-plan.ts prepare|aggregate");
  }
}

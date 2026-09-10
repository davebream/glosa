// SPDX-License-Identifier: Apache-2.0
// issue #146 — the static guard for the workspace-root boundary.
//
// WHAT THIS PROVES, AND WHAT IT DOES NOT. Independent review named four ways to reach around a
// lexical scan, each defeated by a more elaborate spelling than the last, and a fifth exists for
// any check written here: source scanning cannot decide "no module reimplements this walk". So the
// claim is bounded deliberately.
//
//   Enforced by the COMPILER, not by this file: `rawEnclosingGitRoot` is not exported, so no other
//   module can call it. That is the real guarantee, and it is a compile error rather than a test.
//
//   Enforced EXACTLY here: nothing outside the policy module names the walker or `isGitRepoRoot`.
//   Both scans are exact because neither identifier has a legitimate consumer elsewhere.
//
//   NOT attempted: catching a walk written from scratch. A scan for the `.git` marker lived here
//   for five review rounds and was wrong in a different way each round — a whole-file exemption, an
//   occurrence budget, a substring subtraction that deleted every match. Each repair was real, and
//   every one of those defects was in the scan rather than in the boundary. It recognised one
//   spelling of a walk, not the walk, so an intentional bypass always passed and only the claim got
//   larger. Deleted on review's recommendation: a smaller true claim beats a bigger one that keeps
//   needing repair. A reimplemented walk is a matter for code review.
//
// The acceptance criterion this discharges is therefore "a caller cannot reach the unbounded walk
// by inattention", not "cannot by intent". The contract states it the same way. `rawEnclosingGitRoot`
// (workspace-root.ts) is the raw upward walk with no boundary: on a machine whose home is a git
// checkout, it reaches `$HOME` for anything with no nearer repository, and every policy-bearing
// export in that module (`enclosingGitRootWithin`, `workspaceRootFor`) applies the boundary before
// answering. This test is the executable form of "no shipping module can reach around the policy":
// an earlier revision of this fix claimed that unexporting the walker from the daemon's barrel was
// enough, but `workspace-index.ts` already imported it directly from its own module — a barrel
// omission does not stop a same-package direct import. `rawEnclosingGitRoot` not being `export`ed
// already makes that a compile error; this test is a fast, explicit, independently-failing
// assertion of the same fact, scanning source text rather than relying on `tsc` alone.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const WORKSPACE_ROOT_FILE = join(REPO_ROOT, "packages/daemon/src/registry/workspace-root.ts");
const GUARDED_NAME = "rawEnclosingGitRoot";

/** Every shipping (non-test, non-vendored) `.ts` source file under each package's `src/` dir. */
function shippingSourceFiles(): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(join(REPO_ROOT, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const srcDir = join(REPO_ROOT, "packages", entry.name, "src");
    let names: string[];
    try {
      names = readdirSync(srcDir, { recursive: true }) as string[];
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".ts") && !name.endsWith(".tsx")) continue;
      files.push(join(srcDir, name));
    }
  }
  return files;
}

describe("static import guard — the private workspace-root walker (issue #146)", () => {
  test("workspace-root.ts itself does not export the raw walker, under any name", () => {
    const source = readFileSync(WORKSPACE_ROOT_FILE, "utf8");
    const OPEN_PAREN = String.fromCharCode(40);
    expect(source).toContain(`function ${GUARDED_NAME}${OPEN_PAREN}`);
    expect(source).not.toMatch(new RegExp(`export\\s+function\\s+${GUARDED_NAME}\\b`));
    // An independent review found the declaration form alone insufficient: `export { rawEnclosingGitRoot
    // as anythingElse }` re-exports the walker without ever writing `export function`, and an alias
    // import on the other side then passes the token scan below. Every `export` list in this module
    // is checked for the guarded name instead of only its declaration.
    for (const clause of source.matchAll(/export\s*\{([^}]*)\}/g)) expect(clause[1]).not.toContain(GUARDED_NAME);
  });

  test("no shipping module reaches the repository predicate the walk is built from", () => {
    // A third bypass, found by review: `isGitRepoRoot` was exported publicly, and a module could
    // combine it with a `dirname` loop to rebuild the walk — an implementation containing neither
    // the walker's name nor the `.git` marker, so every other check here passed it. It has no
    // shipping consumer at all, so this is exact rather than a heuristic: the predicate belongs to
    // the policy module and nothing else may name it.
    const PREDICATE = "isGitRepoRoot";
    const offenders: string[] = [];
    for (const file of shippingSourceFiles()) {
      if (file === WORKSPACE_ROOT_FILE) continue;
      const relativePath = relative(REPO_ROOT, file).split(sep).join("/");
      if (readFileSync(file, "utf8").includes(PREDICATE)) offenders.push(relativePath);
    }
    expect(offenders).toEqual([]);
  });

  test("no other shipping module imports or references the raw walker", () => {
    const offenders: string[] = [];
    for (const file of shippingSourceFiles()) {
      if (file === WORKSPACE_ROOT_FILE) continue;
      const source = readFileSync(file, "utf8");
      if (source.includes(GUARDED_NAME)) offenders.push(relative(REPO_ROOT, file).split(sep).join("/"));
    }
    expect(offenders).toEqual([]);
  });
});

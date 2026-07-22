// SPDX-License-Identifier: Apache-2.0
// Structural release blocker: integrations register through ContentAdapter at runtime; the core
// neither ships integration packages nor imports code from an external adapter tree.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...listFilesRecursive(full));
    else out.push(full);
  }
  return out;
}

describe("invariant #1 — generic core, integrations outside glosa", () => {
  test("daemon and SPA sources never import an external packages/adapters tree", () => {
    const offenders = [join(REPO_ROOT, "packages/daemon/src"), join(REPO_ROOT, "packages/spa/src")]
      .flatMap(listFilesRecursive)
      .filter((file) => /(?:from\s+|import\s*\()["'][^"']*packages\/adapters/.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });

  test("no integration package ships in the monorepo", () => {
    expect(existsSync(join(REPO_ROOT, "packages/adapters"))).toBe(false);
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
    expect(pkg.workspaces.some((glob: string) => glob.includes("adapters"))).toBe(false);
  });
});

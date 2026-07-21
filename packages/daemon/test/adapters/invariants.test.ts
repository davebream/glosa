// P6.1 release-blocker acceptance (CLAUDE.md invariant #1: generic core, ZERO domain knowledge) —
// grep-enforced, not just documented: no `jethro`/`sermon`/`format-sermon` identifier may appear
// anywhere under packages/daemon or packages/spa, and the jethro package stub P6.1 superseded
// must be gone, not merely unreferenced.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const SELF_PATH = fileURLToPath(import.meta.url); // this file necessarily names the forbidden terms itself

// Case-insensitive, word-ish boundaries so this also catches `Jethro`, `SERMON_`, `formatSermon`,
// etc. — not just the exact lowercase-hyphenated spelling.
const FORBIDDEN_TERMS = [/jethro/i, /sermon/i, /format-sermon/i];

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listFilesRecursive(full));
    else out.push(full);
  }
  return out;
}

describe("invariant #1 — generic core, zero domain knowledge (grep-enforced)", () => {
  test("no jethro/sermon/format-sermon identifier anywhere under packages/daemon/src or packages/daemon/test", () => {
    const roots = [join(REPO_ROOT, "packages/daemon/src"), join(REPO_ROOT, "packages/daemon/test")];
    const offenders: string[] = [];
    for (const root of roots) {
      for (const file of listFilesRecursive(root)) {
        if (file === SELF_PATH) continue;
        const content = readFileSync(file, "utf8");
        for (const term of FORBIDDEN_TERMS) {
          if (term.test(content)) offenders.push(`${file} matches ${term}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("no jethro/sermon/format-sermon identifier anywhere under packages/spa/src or packages/spa/test", () => {
    const roots = [join(REPO_ROOT, "packages/spa/src"), join(REPO_ROOT, "packages/spa/test")];
    const offenders: string[] = [];
    for (const root of roots) {
      for (const file of listFilesRecursive(root)) {
        const content = readFileSync(file, "utf8");
        for (const term of FORBIDDEN_TERMS) {
          if (term.test(content)) offenders.push(`${file} matches ${term}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("packages/adapters/jethro is deleted, not just empty", () => {
    expect(existsSync(join(REPO_ROOT, "packages/adapters"))).toBe(false);
  });

  test("root package.json workspace globs no longer include packages/adapters/*", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
    expect(pkg.workspaces).not.toContain("packages/adapters/*");
    expect(pkg.workspaces.some((g: string) => g.includes("adapters"))).toBe(false);
  });
});

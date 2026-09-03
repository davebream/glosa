// SPDX-License-Identifier: Apache-2.0
// Structural backstop for requirements.md §4: every CLI child spawn must make its environment
// explicit. Behavior tests cover the three real dependency seams that scrub ANTHROPIC_API_KEY;
// this catches a future bare Bun.spawn/Bun.spawnSync call before it silently inherits ambient auth.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

test("every CLI Bun child spawn declares an explicit environment", () => {
  const sourceRoot = join(import.meta.dir, "../src");
  const violations: string[] = [];

  for (const file of sourceFiles(sourceRoot)) {
    const source = readFileSync(file, "utf8");
    const starts = [...source.matchAll(/\bBun\.spawn(?:Sync)?\s*\(/g)];
    const inlineCalls = [...source.matchAll(/\bBun\.spawn(?:Sync)?\s*\(\s*\{([\s\S]*?)\}\s*\);/g)];

    if (starts.length !== inlineCalls.length) {
      violations.push(`${relative(sourceRoot, file)}: spawn options must be an inline object`);
      continue;
    }
    for (const call of inlineCalls) {
      if (/\benv\s*[,}]/.test(call[1] ?? "")) continue;
      const line = source.slice(0, call.index).split("\n").length;
      violations.push(`${relative(sourceRoot, file)}:${line}`);
    }
  }

  expect(violations).toEqual([]);
});

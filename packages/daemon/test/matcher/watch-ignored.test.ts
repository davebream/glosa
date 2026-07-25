// SPDX-License-Identifier: Apache-2.0
// The chokidar `ignored` predicate the artifact watcher (stream.ts) uses must share the walk's
// canonical include/exclude scope: excluded subtrees (`.glosa`, `node_modules`, `.git`, dotdirs)
// are never watched or descended into, surviving directories ARE descended into, and only
// glosa-supported artifact files are watched. Proven with real on-disk paths + real lstat so the
// dir-vs-file branches match what chokidar actually passes.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { buildWatchIgnored } from "../../src/matcher.ts";
import { cleanupWorkspace, freshWorkspace, makeDir, writeFile } from "./helpers.ts";

let root: string;
beforeEach(() => {
  root = freshWorkspace();
});
afterEach(() => {
  cleanupWorkspace(root);
});

/** Mirrors how stream.ts calls it: absolute path + the real lstat chokidar would have. */
function ignored(rel: string): boolean {
  const abs = join(root, rel);
  return buildWatchIgnored(root)(abs, lstatSync(abs));
}

test("the watched root itself is never ignored", () => {
  expect(buildWatchIgnored(root)(root, lstatSync(root))).toBe(false);
});

test("excluded subtrees (node_modules, .git, .glosa, dotdirs) are pruned — dir and its contents", () => {
  makeDir(root, "node_modules/pkg");
  writeFile(root, "node_modules/pkg/readme.md", "x");
  makeDir(root, ".git");
  writeFile(root, ".git/COMMIT_EDITMSG", "x");
  makeDir(root, ".glosa");
  writeFile(root, ".glosa/shadow.md", "x");
  makeDir(root, ".github");
  writeFile(root, ".github/notes.md", "x");

  expect(ignored("node_modules")).toBe(true);
  expect(ignored("node_modules/pkg/readme.md")).toBe(true);
  expect(ignored(".git")).toBe(true);
  expect(ignored(".git/COMMIT_EDITMSG")).toBe(true);
  expect(ignored(".glosa")).toBe(true);
  expect(ignored(".glosa/shadow.md")).toBe(true);
  expect(ignored(".github")).toBe(true);
});

test("a surviving directory is descended into (not ignored), so nested artifacts are reachable", () => {
  makeDir(root, "docs/sub");
  writeFile(root, "docs/sub/guide.md", "x");

  expect(ignored("docs")).toBe(false);
  expect(ignored("docs/sub")).toBe(false);
  expect(ignored("docs/sub/guide.md")).toBe(false);
});

test("surviving files: supported artifact extensions watched, everything else ignored", () => {
  writeFile(root, "keep.md", "x");
  writeFile(root, "page.html", "x");
  writeFile(root, "notes.txt", "x");
  writeFile(root, "code.ts", "x");
  writeFile(root, "package.json", "x");

  expect(ignored("keep.md")).toBe(false);
  expect(ignored("page.html")).toBe(false);
  expect(ignored("notes.txt")).toBe(false);
  expect(ignored("code.ts")).toBe(true);
  expect(ignored("package.json")).toBe(true);
});

test("not-yet-stat'd entries (stats undefined) are not ignored — chokidar descends and re-decides", () => {
  const pred = buildWatchIgnored(root);
  // A directory chokidar hasn't stat'd yet must still be descended into.
  expect(pred(join(root, "docs"), undefined)).toBe(false);
  // But an excluded subtree is pruned by path alone, even without stats.
  expect(pred(join(root, "node_modules"), undefined)).toBe(true);
});

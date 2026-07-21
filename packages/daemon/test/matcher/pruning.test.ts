// P2.2 — directory pruning. The walk must NOT descend into a subtree that an exclude of the form
// `P/**` swallows whole (node_modules, .glosa, dotdirs). Proven behaviorally: a symlink placed
// INSIDE a pruned dir is never discovered (it would show up in skippedSymlinks if we descended),
// while an identical symlink at the root IS discovered — so the difference isolates "did we
// descend?" from "do we detect symlinks at all?".
import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { resolveMatchedFiles } from "../../src/matcher.ts";
import { cleanupWorkspace, freshWorkspace, makeDir, makeSymlink, writeFile } from "./helpers.ts";

let root: string;
beforeEach(() => {
  root = freshWorkspace();
});
afterEach(() => {
  cleanupWorkspace(root);
});

test("a symlink inside an excluded subtree (node_modules) is never discovered — proves no descent", () => {
  writeFile(root, "keep.md", "x");
  const nmDir = makeDir(root, "node_modules/pkg");
  writeFile(root, "target.md", "x");
  makeSymlink(join(root, "target.md"), join(nmDir, "link.md"));

  const res = resolveMatchedFiles(root);
  expect(res.tracked.map((f) => f.path)).toEqual(["keep.md", "target.md"]);
  // If the walk had descended into node_modules, this symlink would appear here.
  expect(res.skippedSymlinks).toEqual([]);
});

test("control: an identical symlink at the ROOT is discovered (proves we do detect symlinks)", () => {
  writeFile(root, "target.md", "x");
  makeSymlink(join(root, "target.md"), join(root, "link.md"));

  const res = resolveMatchedFiles(root);
  expect(res.skippedSymlinks).toEqual(["link.md"]);
});

test(".glosa/ subtree is pruned — a symlink inside it is not discovered", () => {
  makeDir(root, ".glosa");
  writeFile(root, "target.md", "x");
  makeSymlink(join(root, "target.md"), join(root, ".glosa", "sneaky.md"));

  const res = resolveMatchedFiles(root);
  expect(res.skippedSymlinks).toEqual([]);
});

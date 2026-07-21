// SPDX-License-Identifier: Apache-2.0
// P2.2 — symlink handling (the security-relevant conformance, A4 §F20 / closes F24). Symlinks are
// lstat'd (never followed): neither matched as files nor descended into as directories, and their
// target is never touched — proved below with broken/unreadable targets that would throw if the
// walker ever dereferenced them.
import { chmodSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_MATCHER_CONFIG, resolveMatchedFiles } from "../../src/matcher.ts";
import { cleanupWorkspace, freshWorkspace, makeDir, makeSymlink, writeFile } from "./helpers.ts";

describe("resolveMatchedFiles — symlinks", () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    root = freshWorkspace();
    outside = freshWorkspace();
  });

  afterEach(() => {
    cleanupWorkspace(root);
    cleanupWorkspace(outside);
  });

  test("symlinked FILE pointing at an in-root .md → not matched, listed in skippedSymlinks", () => {
    const target = writeFile(root, "real.md", "hi");
    makeSymlink(target, `${root}/link.md`);

    const result = resolveMatchedFiles(root, DEFAULT_MATCHER_CONFIG);
    expect(result.tracked.map((f) => f.path)).toEqual(["real.md"]); // the real file, not the link
    expect(result.skippedSymlinks).toEqual(["link.md"]);
  });

  test("symlinked DIR → not descended into; a .md 'inside' via the symlink is not tracked", () => {
    const realDir = makeDir(root, "real-dir");
    writeFile(root, "real-dir/inner.md", "hi");
    makeSymlink(realDir, `${root}/link-dir`);

    const result = resolveMatchedFiles(root, DEFAULT_MATCHER_CONFIG);
    expect(result.tracked.map((f) => f.path)).toEqual(["real-dir/inner.md"]);
    expect(result.skippedSymlinks).toEqual(["link-dir"]);
    // the file is not reachable a second time via the symlinked path
    expect(result.tracked.some((f) => f.path.startsWith("link-dir/"))).toBe(false);
  });

  test("symlink to a path OUTSIDE root, that exists → not matched/followed, target content never tracked", () => {
    writeFile(outside, "secret.md", "should never surface");
    makeSymlink(`${outside}/secret.md`, `${root}/escape.md`);

    const result = resolveMatchedFiles(root, DEFAULT_MATCHER_CONFIG);
    expect(result.tracked).toEqual([]);
    expect(result.skippedSymlinks).toEqual(["escape.md"]);
  });

  test("symlink to a path OUTSIDE root that is unreadable → resolveMatchedFiles never throws (target never opened)", () => {
    const secretPath = writeFile(outside, "locked.md", "top secret");
    chmodSync(secretPath, 0o000);
    makeSymlink(secretPath, `${root}/escape2.md`);

    try {
      expect(() => resolveMatchedFiles(root, DEFAULT_MATCHER_CONFIG)).not.toThrow();
      const result = resolveMatchedFiles(root, DEFAULT_MATCHER_CONFIG);
      expect(result.tracked).toEqual([]);
      expect(result.skippedSymlinks).toEqual(["escape2.md"]);
    } finally {
      chmodSync(secretPath, 0o644); // restore so cleanupWorkspace can delete it
    }
  });

  test("broken symlink (target does not exist at all) → not matched, listed as skipped, never throws", () => {
    makeSymlink(`${root}/does-not-exist-anywhere.md`, `${root}/broken.md`);

    const result = resolveMatchedFiles(root, DEFAULT_MATCHER_CONFIG);
    expect(result.tracked).toEqual([]);
    expect(result.skippedSymlinks).toEqual(["broken.md"]);
  });
});

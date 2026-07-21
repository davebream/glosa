// SPDX-License-Identifier: Apache-2.0
// P2.2 — size-threshold boundary (A4 §F20): strictly-over maxFileBytes is oversize; exactly-at is
// still tracked.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolveMatchedFiles } from "../../src/matcher.ts";
import { cleanupWorkspace, freshWorkspace, writeFile } from "./helpers.ts";

const MAX_FILE_BYTES = 64; // small threshold so the tests don't have to write real megabytes

function configWithThreshold(maxFileBytes: number) {
  return {
    artifacts: {
      include: ["**/*.md"],
      exclude: [],
      maxFileBytes,
      followSymlinks: false,
    },
  };
}

describe("resolveMatchedFiles — size threshold", () => {
  let root: string;

  beforeEach(() => {
    root = freshWorkspace();
  });

  afterEach(() => {
    cleanupWorkspace(root);
  });

  test("a small file is tracked", () => {
    writeFile(root, "small.md", 10);
    const result = resolveMatchedFiles(root, configWithThreshold(MAX_FILE_BYTES));
    expect(result.tracked.map((f) => f.path)).toEqual(["small.md"]);
    expect(result.oversize).toEqual([]);
  });

  test("a file of exactly maxFileBytes is tracked, not oversize", () => {
    writeFile(root, "exact.md", MAX_FILE_BYTES);
    const result = resolveMatchedFiles(root, configWithThreshold(MAX_FILE_BYTES));
    expect(result.tracked.map((f) => f.path)).toEqual(["exact.md"]);
    expect(result.oversize).toEqual([]);
  });

  test("a file of maxFileBytes + 1 byte is oversize, not tracked", () => {
    writeFile(root, "over.md", MAX_FILE_BYTES + 1);
    const result = resolveMatchedFiles(root, configWithThreshold(MAX_FILE_BYTES));
    expect(result.tracked).toEqual([]);
    expect(result.oversize.map((f) => f.path)).toEqual(["over.md"]);
  });

  test("the real 2 MiB default threshold: exactly 2 MiB tracked, 2 MiB + 1 byte oversize", () => {
    const twoMiB = 2 * 1024 * 1024;
    writeFile(root, "big-exact.md", twoMiB);
    writeFile(root, "big-over.md", twoMiB + 1);
    const result = resolveMatchedFiles(root, configWithThreshold(twoMiB));
    expect(result.tracked.map((f) => f.path)).toEqual(["big-exact.md"]);
    expect(result.oversize.map((f) => f.path)).toEqual(["big-over.md"]);
  });
});

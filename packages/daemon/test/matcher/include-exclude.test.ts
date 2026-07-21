// P2.2 — include/exclude conformance (A4 §F20). Exclude beats include; dot-dirs, node_modules,
// and .glosa itself are never tracked even when the file inside them would otherwise match.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_MATCHER_CONFIG, resolveMatchedFiles } from "../../src/matcher.ts";
import { cleanupWorkspace, freshWorkspace, writeFile } from "./helpers.ts";

describe("resolveMatchedFiles — include/exclude", () => {
  let root: string;

  beforeEach(() => {
    root = freshWorkspace();
  });

  afterEach(() => {
    cleanupWorkspace(root);
  });

  function trackedPaths(): string[] {
    return resolveMatchedFiles(root, DEFAULT_MATCHER_CONFIG).tracked.map((f) => f.path);
  }

  test("default extensions (.md/.html/.txt) are tracked", () => {
    writeFile(root, "notes.md", "hi");
    writeFile(root, "page.html", "<p>hi</p>");
    writeFile(root, "log.txt", "hi");
    expect(trackedPaths().sort()).toEqual(["log.txt", "notes.md", "page.html"]);
  });

  test("non-matching extensions (.js/.png) are not tracked", () => {
    writeFile(root, "script.js", "console.log(1)");
    writeFile(root, "image.png", "not really a png");
    expect(trackedPaths()).toEqual([]);
  });

  test("a file under node_modules/ is excluded even though it's .md", () => {
    writeFile(root, "node_modules/pkg/README.md", "hi");
    expect(trackedPaths()).toEqual([]);
  });

  test("a file under .glosa/ is excluded even though it's .md", () => {
    writeFile(root, ".glosa/journal-notes.md", "hi");
    expect(trackedPaths()).toEqual([]);
  });

  test("a file under a dotdir (.foo/) is excluded even though it's .md", () => {
    writeFile(root, ".foo/notes.md", "hi");
    expect(trackedPaths()).toEqual([]);
  });

  test("exclude wins: a .md inside node_modules is NOT tracked (not just deprioritized)", () => {
    writeFile(root, "node_modules/x.md", "hi");
    writeFile(root, "real.md", "hi");
    expect(trackedPaths()).toEqual(["real.md"]);
  });

  test("nested matching files under an ordinary subdirectory are tracked", () => {
    writeFile(root, "a/b/c/deep.md", "hi");
    expect(trackedPaths()).toEqual(["a/b/c/deep.md"]);
  });
});

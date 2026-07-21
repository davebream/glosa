// SPDX-License-Identifier: Apache-2.0
// P2.2 — deterministic byte-sort on the NFC `path` (A4 §F20). The three consumers (watcher,
// sidebar, git-pathspec staging, wired in later tasks) all depend on identical ordering across
// runs and across hosts — that only holds if the sort is byte-order on the UTF-8 encoding, NOT a
// locale-aware collation (which varies by host locale and would silently desync the consumers on
// a machine configured differently from the one that wrote the fixture).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolveMatchedFiles } from "../../src/matcher.ts";
import { cleanupWorkspace, freshWorkspace, writeFile } from "./helpers.ts";

const CONFIG = {
  artifacts: { include: ["**/*.md"], exclude: [], maxFileBytes: 2 * 1024 * 1024, followSymlinks: false },
};

describe("resolveMatchedFiles — deterministic ordering", () => {
  let root: string;

  beforeEach(() => {
    root = freshWorkspace();
  });

  afterEach(() => {
    cleanupWorkspace(root);
  });

  test("two runs over the same tree produce identical ordering", () => {
    for (const name of ["c.md", "a.md", "b.md", "Banana.md", "apple.md"]) writeFile(root, name, "x");
    const first = resolveMatchedFiles(root, CONFIG).tracked.map((f) => f.path);
    const second = resolveMatchedFiles(root, CONFIG).tracked.map((f) => f.path);
    expect(second).toEqual(first);
  });

  test("case ordering is byte order (uppercase before lowercase), not locale order", () => {
    writeFile(root, "Banana.md", "x");
    writeFile(root, "apple.md", "x");

    const result = resolveMatchedFiles(root, CONFIG);
    const paths = result.tracked.map((f) => f.path);

    // Byte order: 'B' is 0x42, 'a' is 0x61 — "Banana.md" sorts first.
    expect(paths).toEqual(["Banana.md", "apple.md"]);

    // Prove this genuinely diverges from locale collation (most locales sort case-insensitively,
    // "apple" before "Banana") — if the matcher ever regresses to `.sort()` with a locale-aware
    // comparator, this assertion is what would catch it.
    const localeOrder = [...paths].sort((a, b) => a.localeCompare(b));
    expect(localeOrder).not.toEqual(paths);
    expect(localeOrder).toEqual(["apple.md", "Banana.md"]);
  });

  test("accented characters sort by raw UTF-8 byte value, not by locale-collated proximity to their base letter", () => {
    writeFile(root, "cafz.md", "x");
    // "é" (U+00E9) encodes in UTF-8 as 0xC3 0xA9 — its first byte (0xC3) is greater than "z"
    // (0x7A), so byte order puts "café.md" AFTER "cafz.md". Locale collation typically treats "é"
    // as adjacent to "e" and would sort "café" before "cafz".
    const eAcute = String.fromCodePoint(0x00e9);
    writeFile(root, `caf${eAcute}.md`, "x");

    const paths = resolveMatchedFiles(root, CONFIG).tracked.map((f) => f.path);
    expect(paths).toEqual(["cafz.md", `caf${eAcute}.md`]);
  });
});

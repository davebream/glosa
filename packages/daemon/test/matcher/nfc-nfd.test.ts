// P2.2 — the APFS NFC/NFD gotcha (A4 §F20). macOS APFS is normalization-insensitive but not
// normalization-preserving: a filename written with combining-character (NFD) bytes can come back
// from readdir() in NFD form even though the user "typed" the NFC (precomposed) form. `path` must
// always be the NFC comparison key (so globs written against precomposed characters still match,
// and so the same logical name always sorts/dedupes the same way); `rawPath` must stay whatever
// the filesystem actually reports, since that's the only form guaranteed to open the file.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_MATCHER_CONFIG, resolveMatchedFiles } from "../../src/matcher.ts";
import { cleanupWorkspace, freshWorkspace, writeFile } from "./helpers.ts";

// Built from String.fromCodePoint, not a typed literal accented character — a literal in this
// source file is whatever bytes the editor/tool happened to save it as, which isn't a reliable
// way to pin down which Unicode normalization form is actually under test.
//   NFC_NAME: "c" + o-with-acute (U+00F3, precomposed) + "rka.md"
//   NFD_NAME: "c" + "o" (U+006F) + U+0301 COMBINING ACUTE ACCENT + "rka.md" — the decomposed form
//   APFS can hand back from readdir() even for a file "typed" with the precomposed character.
const O_ACUTE_PRECOMPOSED = String.fromCodePoint(0x00f3);
const O_PLAIN = String.fromCodePoint(0x006f);
const COMBINING_ACUTE = String.fromCodePoint(0x0301);
const NFC_NAME = `c${O_ACUTE_PRECOMPOSED}rka.md`;
const NFD_NAME = `c${O_PLAIN}${COMBINING_ACUTE}rka.md`;

describe("resolveMatchedFiles — NFC/NFD normalization", () => {
  let root: string;

  beforeEach(() => {
    root = freshWorkspace();
  });

  afterEach(() => {
    cleanupWorkspace(root);
  });

  test("sanity: NFC_NAME and NFD_NAME are different byte sequences that normalize to the same string", () => {
    expect(NFC_NAME).not.toBe(NFD_NAME);
    expect(NFC_NAME.normalize("NFC")).toBe(NFC_NAME);
    expect(NFD_NAME.normalize("NFC")).toBe(NFC_NAME);
  });

  test("a file written with NFD bytes reports an NFC `path`, and a real on-disk `rawPath`", () => {
    writeFile(root, NFD_NAME, "content");

    const result = resolveMatchedFiles(root, DEFAULT_MATCHER_CONFIG);
    expect(result.tracked).toHaveLength(1);
    const file = result.tracked[0]!;

    expect(file.path).toBe(NFC_NAME); // comparison key is always NFC
    expect(file.path.normalize("NFC")).toBe(file.path); // idempotent — already normalized

    // rawPath must be the bytes that actually open the file, whatever form the OS reports.
    expect(readFileSync(file.rawPath, "utf8")).toBe("content");
  });

  test("an NFC-form include glob still matches a file whose on-disk name is NFD", () => {
    writeFile(root, NFD_NAME, "content");
    // **/*.md matching against the NFC path (not the raw NFD bytes) is exactly what makes this
    // work — a matcher run against raw bytes would be at the mercy of which normalization form
    // the filesystem happened to hand back.
    const result = resolveMatchedFiles(root, DEFAULT_MATCHER_CONFIG);
    expect(result.tracked.map((f) => f.path)).toContain(NFC_NAME);
  });
});

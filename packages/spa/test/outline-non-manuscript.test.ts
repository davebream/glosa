// SPDX-License-Identifier: Apache-2.0
// @glosa/spa — issue #175: the outline must not offer a document metadata header's own `key:
// value` lines, or a `%%`-fenced authoring comment's headings, as navigation destinations. Both
// are non-manuscript regions Read/Review also hide (see artifact-render-non-manuscript.test.ts);
// this file pins the SAME boundary read off the raw source, which is all `collectSourceHeadings`
// has to work with (Edit's source face has no rendered DOM — see outline.js's own header comment).
//
// Kept in its own file (rather than folded into outline.test.ts) so this issue's coverage is one
// unit to add to a REQUIRED_SUITES entry (see scripts/acceptance-suites.ts).
import { describe, expect, test } from "bun:test";
import { collectSourceHeadings } from "../src/markdown-parser.js";

describe("collectSourceHeadings excludes a document metadata header (#175)", () => {
  test("a leading `---` header's own lines are never offered as a heading", () => {
    const source = "---\ntitle: Test\nstatus: draft\n---\n\n# Real Heading\n\nBody.\n";
    const headings = collectSourceHeadings(source);
    expect(headings.map((h) => h.text)).toEqual(["Real Heading"]);
    // Coordinate identity: the surviving heading's line/offset must be unaffected by skipping the
    // header — it is the header's OWN setext-lookback misreading being removed, not a renumbering.
    expect(headings[0]).toEqual({ level: 1, text: "Real Heading", line: 5, offset: 35 });
  });

  test("a header NOT at the document start is not recognised — parity with the rich editor's guard 1", () => {
    const source = "Body.\n\n---\ntitle: T\n---\n\n# Real\n";
    const headings = collectSourceHeadings(source);
    // UNCHANGED BY THIS FIX, and pinned so a later reader does not "fix" it: a mid-document `---`
    // pair is a genuine thematic break + setext heading, both in this outline's own reading and in
    // the rich editor's parse (its "a header-shaped block after a paragraph" case, guard 1) and the
    // daemon's render. Only the DOCUMENT-START form is metadata; this row proves the new recognizer
    // does not widen past that guard and swallow a construct it must not touch.
    expect(headings.map((h) => h.text)).toEqual(["title: T", "Real"]);
  });
});

describe("collectSourceHeadings excludes a `%%`-fenced authoring comment (#175)", () => {
  test("headings inside a comment block are never offered, headings around it are", () => {
    const source = "# Real Heading\n\n%%\n# Private heading\nsecret note\n%%\n\n## After\n";
    const headings = collectSourceHeadings(source);
    expect(headings.map((h) => h.text)).toEqual(["Real Heading", "After"]);
    // The heading after the comment must land at its own true line/offset — the skip must advance
    // by exactly the comment's own byte span, not an approximation.
    const after = headings[1]!;
    expect(after.line).toBe(7);
    expect(source.slice(after.offset, after.offset + "## After".length)).toBe("## After");
  });

  test("an unmatched `%%` is not a comment — headings after it are still read normally", () => {
    const source = "%%\n\n# Still a heading\n";
    expect(collectSourceHeadings(source).map((h) => h.text)).toEqual(["Still a heading"]);
  });

  test("a `%%` inside a fenced code block does not open a comment — the fence's own exclusion still applies", () => {
    const source = "# Before\n\n```\n%%\n# not a heading\n%%\n```\n\n# After\n";
    expect(collectSourceHeadings(source).map((h) => h.text)).toEqual(["Before", "After"]);
  });

  test("two separate comment blocks are both excluded", () => {
    const source = "# A\n\n%%\n# hidden one\n%%\n\n# B\n\n%%\n# hidden two\n%%\n\n# C\n";
    expect(collectSourceHeadings(source).map((h) => h.text)).toEqual(["A", "B", "C"]);
  });
});

describe("shared token outline boundaries (#175)", () => {
  test("CRLF metadata and nested comments preserve the surviving source offset", () => {
    const source = "---\r\ntitle: T\r\n---\r\n\r\n- %%\r\n  # Hidden\r\n  %%\r\n\r\n# Visible\r\n";
    expect(collectSourceHeadings(source)).toEqual([
      { level: 1, text: "Visible", line: 8, offset: source.indexOf("# Visible") },
    ]);
  });
  test("inline comments disappear from heading labels while code and escaped markers stay literal", () => {
    const source = "# Public %% private %% title\n\n## `%% code %%` and \\%\\% literal\n";
    expect(collectSourceHeadings(source).map((h) => h.text)).toEqual(["Public title", "%% code %% and %% literal"]);
  });
  test("nested fenced code is never a heading and ordinary nested headings remain destinations", () => {
    const source = "- item\n  ```md\n  # Hidden\n  ```\n\n> ## Quoted\n\n- ### Listed\n";
    expect(collectSourceHeadings(source).map((h) => h.text)).toEqual(["Quoted", "Listed"]);
  });
});

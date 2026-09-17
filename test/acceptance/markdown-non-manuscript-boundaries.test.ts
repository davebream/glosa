// SPDX-License-Identifier: Apache-2.0
// #175: structural ranges from the actual renderer and editor tokenizers, not inferred HTML.
import { describe, expect, test } from "bun:test";
import { renderMarkdown, renderMarkdownLayout } from "../../packages/daemon/src/artifact-render.ts";
import { collectSourceHeadings } from "../../packages/spa/src/markdown-parser.js";
import { blockLayout, editorMarkdownLayout } from "../../packages/spa/src/rich-editor.js";

const SOURCE =
  "---\ntitle: T\n---\n\n# Public %% private %% title\n\n%%\n# Hidden\n%%\n\n- item\n  > %%\n  > nested\n  > %%\n\nAfter.\n";
const EXPECTED = [
  { type: "metadata", startLine: 0, endLine: 3, level: 0 },
  { type: "heading", startLine: 4, endLine: 5, level: 0 },
  { type: "comment", startLine: 6, endLine: 9, level: 0 },
  { type: "bullet_list", startLine: 10, endLine: 15, level: 0 },
  { type: "list_item", startLine: 10, endLine: 15, level: 1 },
  { type: "paragraph", startLine: 10, endLine: 11, level: 2 },
  { type: "blockquote", startLine: 11, endLine: 14, level: 2 },
  { type: "comment", startLine: 11, endLine: 14, level: 3 },
  { type: "paragraph", startLine: 15, endLine: 16, level: 0 },
];

describe("non-manuscript structural boundaries (#175)", () => {
  for (const eol of ["\n", "\r\n"]) {
    test(`renderer and editor retain the expected nested ranges for ${JSON.stringify(eol)}`, () => {
      const source = SOURCE.replaceAll("\n", eol);
      expect(renderMarkdownLayout(source)).toEqual(EXPECTED);
      expect(editorMarkdownLayout(source)).toEqual(EXPECTED);
      const lineOf = (offset: number) => source.slice(0, offset).split("\n").length - 1;
      expect(
        blockLayout(source).blocks.map((span: { start: number; end: number }) => [
          lineOf(span.start),
          lineOf(span.end) + 1,
        ]),
      ).toEqual([
        [0, 3],
        [4, 5],
        [6, 9],
        [10, 14],
        [15, 16],
      ]);
      expect(collectSourceHeadings(source)).toEqual([
        { level: 1, text: "Public title", line: 4, offset: source.indexOf("# Public") },
      ]);
      const html = renderMarkdown(source);
      expect(html).not.toContain("private");
      expect(html).not.toContain("Hidden");
      expect(html).not.toContain("nested");
      expect(html).toContain('data-line="15"');
    });
  }

  test("table types AGREE, structurally and at every nesting level (#270)", () => {
    // THIS TEST USED TO PIN THE OPPOSITE. It was called "table types diverge at equal top-level
    // ranges" and asserted that the editor saw a table as a single `paragraph` while the renderer
    // saw a `table` with its rows — the two sides were built from different markdown-it presets
    // (default vs `commonmark`), and the divergence was recorded here as expected behaviour.
    //
    // #270 made both construct from one shared configuration, so the layouts are now identical.
    // Asserted as EQUALITY between the two rather than as two separate expected arrays: that is the
    // property worth holding, and writing it this way means a future change which re-narrows either
    // side fails here whichever side it narrows.
    const source = "| a | b |\n|---|---|\n| 1 | 2 |\n\nAfter.\n";
    const expected = [
      { type: "table", startLine: 0, endLine: 3, level: 0 },
      { type: "thead", startLine: 0, endLine: 1, level: 1 },
      { type: "tr", startLine: 0, endLine: 1, level: 2 },
      { type: "tbody", startLine: 2, endLine: 3, level: 1 },
      { type: "tr", startLine: 2, endLine: 3, level: 2 },
      { type: "paragraph", startLine: 4, endLine: 5, level: 0 },
    ];
    expect(renderMarkdownLayout(source)).toEqual(expected);
    expect(editorMarkdownLayout(source)).toEqual(expected);
    // Stated again as a direct comparison, so that a future edit which updates one expected array
    // and forgets the other cannot leave the two sides disagreeing while both assertions pass.
    expect(editorMarkdownLayout(source)).toEqual(renderMarkdownLayout(source));
  });

  test("strikethrough agrees between the renderer and the editor (#270)", () => {
    // The other construct the `commonmark` preset dropped. Cheaper than tables and just as capable
    // of reintroducing the split, so it gets its own row here.
    const source = "Some ~~struck~~ text.\n";
    expect(editorMarkdownLayout(source)).toEqual(renderMarkdownLayout(source));
    expect(renderMarkdown(source)).toContain("<s>");
  });

  test("an unclosed nested comment cannot capture a delimiter outside its container", () => {
    const source = "- %%\n  private?\n\n# Visible\n\n%%\n";
    expect(renderMarkdownLayout(source).some((row) => row.type === "comment")).toBe(false);
    expect(editorMarkdownLayout(source)).toEqual(renderMarkdownLayout(source));
    expect(collectSourceHeadings(source).map((row) => row.text)).toEqual(["Visible"]);
    expect(renderMarkdown(source)).toContain("private?");
  });
});

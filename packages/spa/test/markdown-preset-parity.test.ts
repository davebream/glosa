// SPDX-License-Identifier: Apache-2.0
// #270 — the reader's renderer and the editor's parser must describe the same document.
//
// Before this, the daemon built `new MarkdownIt({ html: false, linkify: false })` (the DEFAULT
// preset) and the browser built the `commonmark` preset, which omits the `table` block rule and
// the `strikethrough` inline rule. A pipe table was a `<table>` for a reader and a paragraph of
// literal pipe characters for the editor. Sharing `installNonManuscriptRules` did not help: the
// presets underneath it disagreed.
//
// These tests hold the two sides together from OPPOSITE directions — one asserts the reader's HTML
// contains the construct, the other asserts the editor's tree contains the matching node — so a
// future change that quietly re-narrows either side turns one of them red.
import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "../../daemon/src/artifact-render.ts";
import { MARKDOWN_OPTIONS, MARKDOWN_PRESET } from "../src/markdown-non-manuscript.js";
import { blockLayout, editorSchema, parseMarkdown, runIsModelled, serializeMarkdown } from "../src/rich-editor.js";

const TABLE = "| a | b |\n|---|---|\n| 1 | 2 |";
const STRUCK = "Some ~~struck~~ text.";

/** The shape this file needs from a ProseMirror node; `rich-editor.js` is JavaScript, so its
 *  exports arrive untyped and annotating the callbacks here is what keeps `tsc` honest. */
type PmNode = { type: { name: string }; marks: { type: { name: string } }[] };

/** Every top-level node type in `markdown`, in document order. */
function topLevelTypes(markdown: string): string[] {
  const types: string[] = [];
  parseMarkdown(markdown).forEach((node: PmNode) => {
    types.push(node.type.name);
  });
  return types;
}

/** Every top-level node of `markdown`, for the modelled-inventory check. */
function topLevelNodes(markdown: string): PmNode[] {
  const nodes: PmNode[] = [];
  parseMarkdown(markdown).forEach((node: PmNode) => {
    nodes.push(node);
  });
  return nodes;
}

describe("#270 — one tokenizer configuration for both renderers", () => {
  test("the shared configuration is the default preset, which is the one that carries tables", () => {
    // Pinned as its own assertion so a change to the preset is a deliberate act with a red test
    // beside it, rather than something discovered later through a table that stopped rendering.
    expect(MARKDOWN_PRESET).toBe("default");
    expect(MARKDOWN_OPTIONS).toEqual({ html: false, linkify: false });
  });

  test("a table is a table on both sides", () => {
    // `<table` rather than `<table>`: the daemon stamps `data-line` onto the opening tag, so the
    // bare form never appears. That stamp is asserted in its own test below.
    expect(renderMarkdown(TABLE)).toContain("<table");
    expect(topLevelTypes(TABLE)).toEqual(["table"]);
  });

  test("strikethrough is a mark on both sides", () => {
    expect(renderMarkdown(STRUCK)).toContain("<s>");
    const marks: string[] = [];
    parseMarkdown(STRUCK).descendants((node: PmNode) => {
      for (const mark of node.marks) marks.push(mark.type.name);
    });
    expect(marks).toContain("strikethrough");
  });

  test("the editor schema can represent everything the renderer shows", () => {
    // The direction that matters: a construct the reader is shown but the editor cannot hold is the
    // whole defect. `table` parsing to a `paragraph` would satisfy "both sides produced something"
    // while reproducing exactly the bug, so this asserts the NODE TYPE, not merely that it parsed.
    for (const name of ["table", "table_row", "table_cell", "table_header"]) {
      expect(Object.keys(editorSchema.nodes)).toContain(name);
    }
    expect(Object.keys(editorSchema.marks)).toContain("strikethrough");
  });

  test("a table is one top-level block with one source span", () => {
    // What lets an untouched table be copied through verbatim by the splice contract. If a table
    // ever parsed as several top-level blocks, `blockLayout` and the document tree would disagree
    // on the block count and the splice would write the wrong bytes.
    const source = `# Title\n\n${TABLE}\n\nAfter.\n`;
    const { blocks } = blockLayout(source) as { blocks: { start: number; end: number }[] };
    expect(blocks).toHaveLength(3);
    const table = blocks[1];
    if (!table) throw new Error("expected a second top-level block");
    expect(source.slice(table.start, table.end)).toBe(TABLE);
    expect(topLevelTypes(source)).toEqual(["heading", "table", "paragraph"]);
  });

  test("a table round-trips byte-identically", () => {
    // Parse and re-serialize with no restoration in between: this is the serializer's own fidelity,
    // not the restoration's. A table that costs bytes here costs them on every save that touches
    // the block it sits in.
    const source = `# Title\n\n${TABLE}\n\n${STRUCK}`;
    expect(serializeMarkdown(parseMarkdown(source))).toBe(source);
  });

  test("a table with a short row round-trips without dropping a cell", () => {
    // The column count comes from the widest row rather than the first, so a malformed source table
    // is padded rather than truncated. Asserted through a reparse: the written table must describe
    // the same tree, which a dropped cell would not.
    const ragged = "| a | b | c |\n|---|---|---|\n| 1 | 2 |";
    const doc = parseMarkdown(ragged);
    expect(parseMarkdown(serializeMarkdown(doc)).eq(doc)).toBe(true);
  });

  test("tables and strikethrough are modelled, so editing one does not report collateral", () => {
    // If these were outside the modelled inventory, every edit to a block containing a table would
    // route down the verbatim path and prompt the writer about markup they did not touch.
    expect(runIsModelled(topLevelNodes(`${TABLE}\n\n${STRUCK}`))).toBe(true);
  });

  test("the daemon still stamps data-line on a table, so anchoring reaches it", () => {
    // Tables were always rendered by the daemon; what is new is that the editor can hold them. The
    // anchor ladder must not have been disturbed on the way.
    expect(renderMarkdown(TABLE)).toContain('data-line="0"');
  });
});

describe("#270 — the vendored bundle exports what per-block editing needs", () => {
  test("Plugin, PluginKey, Decoration, DecorationSet and TextSelection are importable", async () => {
    // Bundled but not re-exported before #270. Named here rather than left to the first consumer so
    // that a future re-bundle which drops one fails in this file instead of in a feature.
    const pm = await import("../src/vendor/prosemirror.js");
    for (const name of ["Plugin", "PluginKey", "Decoration", "DecorationSet", "TextSelection", "tableNodes"]) {
      expect(pm).toHaveProperty(name);
    }
  });
});

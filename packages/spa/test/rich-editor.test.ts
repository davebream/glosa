// SPDX-License-Identifier: Apache-2.0
// @glosa/spa — rich-editor markdown fidelity: the vendored prosemirror-markdown parse→serialize
// pipeline is what the rich face persists through, so its round-trip behavior IS the save
// contract. These tests are DOM-free (parser/serializer/state never touch a document); the
// EditorView half is exercised in a real browser (mountRichEditor falls back to the source
// textarea in DOMs that can't host a ProseMirror view — viewer.test.ts covers that wiring).
import { describe, expect, test } from "bun:test";
import { EditorState } from "../src/vendor/prosemirror.js";
import { parseMarkdown, serializeMarkdown } from "../src/rich-editor.js";

const roundtrip = (md: string) => serializeMarkdown(parseMarkdown(md));

describe("prosemirror-markdown round-trip (the rich face's save contract)", () => {
  test("headings, emphasis, lists, blockquote, and inline code survive a parse→serialize cycle", () => {
    const md = [
      "# Title",
      "",
      "A paragraph with **bold**, *italic*, and `code`.",
      "",
      "> A quoted line.",
      "",
      "- first",
      "- second",
      "",
      "1. one",
      "2. two",
      "",
      "## Section",
      "",
      "Closing paragraph.",
    ].join("\n");
    expect(roundtrip(md).trim()).toBe(md);
  });

  test("a fenced code block keeps its content and fence", () => {
    const md = "```\nconst x = 1;\n```";
    expect(roundtrip(md).trim()).toBe(md);
  });

  test("links keep their targets", () => {
    const md = "A [link](https://example.com) here.";
    expect(roundtrip(md).trim()).toBe(md);
  });

  test("EditorState builds from a parsed markdown doc (DOM-free)", () => {
    const doc = parseMarkdown("# Hi\n\nBody.");
    // The vendored bundle is untyped (minified single-name types); assert through `any`.
    const state = EditorState.create({ doc }) as any;
    expect(state.doc.firstChild?.type.name).toBe("heading");
  });
});

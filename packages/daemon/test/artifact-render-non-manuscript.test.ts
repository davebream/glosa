// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — issue #175: Read/Review must not render a document's own metadata header (the
// `---`-fenced block already carried verbatim by the rich editor's `glosa_raw` node, see
// rich-editor.js) or a `%%`-fenced authoring comment as manuscript. Both are declarative,
// dialect-neutral CORE syntax (docs/decisions.md "A construct the schema cannot model is carried
// verbatim..." and its #175 follow-up) — not knowledge of any external tool's naming for them.
//
// `renderMarkdown` is the ONE render path Read, Review and the anchor corpus all consume
// (artifact-render.ts's own header comment), so a fix here is a fix for both viewers at once.
import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "../src/artifact-render.ts";

describe("renderMarkdown hides a document metadata header (#175)", () => {
  test("a leading `---` metadata header produces no visible manuscript", () => {
    const source = "---\ntitle: Test\nstatus: draft\n---\n\n# Real Heading\n\nBody.\n";
    const html = renderMarkdown(source);
    expect(html).not.toContain("title: Test");
    expect(html).not.toContain("status: draft");
    // Today's bug: it renders as an `<h2>` (thematic break + setext heading). Neither the escaped
    // nor the raw form of that markup may survive as visible manuscript.
    expect(html).not.toMatch(/<h[1-6][^>]*>\s*title: Test/);
    expect(html).toContain('<h1 data-line="5">Real Heading</h1>');
    expect(html).toContain('<p data-line="7">Body.</p>');
  });

  test("a header NOT at the document start still renders as an ordinary thematic break + heading", () => {
    // Guard parity with the rich editor's own rule (AC "guard 1"): the header construct is
    // recognised only before any block content, so a mid-document `---` stays a thematic break.
    const source = "Body.\n\n---\ntitle: T\n---\n\nMore.\n";
    const html = renderMarkdown(source);
    expect(html).toContain("<hr>");
    expect(html).toContain("title: T");
  });
});

describe("renderMarkdown hides a `%%`-fenced authoring comment (#175)", () => {
  test("a block comment, and everything inside it, produces no visible manuscript", () => {
    const source = "# Real Heading\n\n%%\n# Private heading\nsecret note\n%%\n\nBody.\n";
    const html = renderMarkdown(source);
    expect(html).not.toContain("Private heading");
    expect(html).not.toContain("secret note");
    expect(html).not.toContain("%%");
    expect(html).toContain('<h1 data-line="0">Real Heading</h1>');
    expect(html).toContain('<p data-line="7">Body.</p>');
  });

  test("an unmatched `%%` (no closing fence) is not a comment — it renders literally", () => {
    const source = "Body.\n\n%%\n\nMore.\n";
    const html = renderMarkdown(source);
    expect(html).toContain("%%");
  });

  test("a backslash-escaped `\\%\\%` is literal text, never a comment delimiter", () => {
    const source = "\\%\\%\n\nMore.\n";
    const html = renderMarkdown(source);
    // CommonMark's own generic backslash-escape (any ASCII punctuation, `%` included) resolves
    // `\%` to a literal `%` at the inline stage — the block rule never sees an escaped fence
    // because it compares the RAW line text, which is `\%\%`, not `%%`.
    expect(html).toContain("%%");
    expect(html).toContain("More.");
  });

  test("a `%%` inside a fenced code block is literal code, never a comment delimiter", () => {
    const source = "```\n%%\nnot a comment\n%%\n```\n";
    const html = renderMarkdown(source);
    expect(html).toContain("not a comment");
    expect(html).toContain("%%");
  });

  test("two separate comment blocks in one document are both hidden, and text between them survives", () => {
    const source = "%%\nfirst secret\n%%\n\nVisible middle.\n\n%%\nsecond secret\n%%\n";
    const html = renderMarkdown(source);
    expect(html).not.toContain("first secret");
    expect(html).not.toContain("second secret");
    expect(html).toContain("Visible middle.");
  });
});

describe("renderMarkdown hides an inline `%% ... %%` comment sharing a line with visible prose (#175)", () => {
  test("an inline pair inside a paragraph is removed; the surrounding prose survives", () => {
    const html = renderMarkdown("Body %% private inline %% visible.\n");
    expect(html).not.toContain("private inline");
    expect(html).toContain("Body");
    expect(html).toContain("visible.");
  });

  test("an inline pair inside a heading is removed; the heading's own visible words survive", () => {
    const html = renderMarkdown("# Public %% secret %% title\n");
    expect(html).not.toContain("secret");
    expect(html).toContain("Public");
    expect(html).toContain("title");
  });

  test("a soft line break INSIDE one inline pair is still hidden end to end", () => {
    // "including soft line breaks within one inline block" (repair-task.md): the pair spans two
    // source lines joined into one paragraph, with no blank line between them.
    const html = renderMarkdown("Body %% secret line one\nsecret line two %% visible.\n");
    expect(html).not.toContain("secret line one");
    expect(html).not.toContain("secret line two");
    expect(html).toContain("Body");
    expect(html).toContain("visible.");
  });

  test("an unmatched inline `%%` (no closing pair before the block ends) is literal", () => {
    const html = renderMarkdown("Body %% never closes.\n");
    expect(html).toContain("Body %% never closes.");
  });

  test("an escaped inline delimiter never opens or closes a pair", () => {
    const html = renderMarkdown("Body \\%\\% still visible \\%\\% here.\n");
    expect(html).toContain("Body %% still visible %% here.");
  });

  test("a `%%` inside an inline code span is literal code, never an inline delimiter", () => {
    const html = renderMarkdown("Use `%% not hidden %%` literally.\n");
    expect(html).toContain("%% not hidden %%");
  });

  test("two inline pairs in one paragraph are both hidden independently", () => {
    const html = renderMarkdown("A %% one %% B %% two %% C\n");
    expect(html).not.toContain("one");
    expect(html).not.toContain("two");
    expect(html).toContain("A");
    expect(html).toContain("B");
    expect(html).toContain("C");
  });
});

describe("renderMarkdown agrees on CRLF and container-nested non-manuscript regions (#175)", () => {
  test("a CRLF metadata header is hidden exactly like its LF form", () => {
    const html = renderMarkdown("---\r\ntitle: T\r\n---\r\n\r\n# Real\r\n");
    expect(html).not.toContain("title: T");
    expect(html).toContain("Real");
  });

  test("a CRLF block comment is hidden exactly like its LF form", () => {
    const html = renderMarkdown("# Real\r\n\r\n%%\r\nsecret\r\n%%\r\n\r\nBody.\r\n");
    expect(html).not.toContain("secret");
    expect(html).toContain("Real");
    expect(html).toContain("Body.");
  });

  test("a comment-only list item is hidden; a sibling item's own text survives", () => {
    const html = renderMarkdown("- %%\n  secret\n  %%\n- visible\n");
    expect(html).not.toContain("secret");
    expect(html).toContain("visible");
  });

  test("a comment-only blockquote is hidden; text beside it survives", () => {
    const html = renderMarkdown("Before.\n\n> %%\n> secret\n> %%\n\nAfter.\n");
    expect(html).not.toContain("secret");
    expect(html).toContain("Before.");
    expect(html).toContain("After.");
  });
});

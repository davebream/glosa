// SPDX-License-Identifier: Apache-2.0
// @glosa/spa — rich-editor markdown fidelity. What the rich face persists through IS the save
// contract, so these tests are the acceptance suite for it (`editor-roundtrip` in the T8 gate).
//
// The bar is not "the file still parses". It is that a save re-serializes ONLY the blocks whose
// tree the writer changed and copies every other block's bytes verbatim, because everything this
// rewrites reaches the agent as a `human_edit` and an invented edit is indistinguishable from a
// real one. Where re-serializing an EDITED block would still cost bytes nobody touched, the splice
// reports collateral rather than writing it.
//
// DOM-free (parser/serializer/splice never touch a document); the EditorView half is exercised in
// a real browser, and the save wiring around it in review-surface.test.ts.
import { describe, expect, test } from "bun:test";
import { EditorState } from "../src/vendor/prosemirror.js";
import { parseMarkdown, serializeMarkdown, spliceMarkdown } from "../src/rich-editor.js";

const roundtrip = (md: string) => serializeMarkdown(parseMarkdown(md));

/** What the rich face would write for `source` after the writer's edits turned it into `edited`. */
const save = (source: string, edited: string) => spliceMarkdown(source, parseMarkdown(source), parseMarkdown(edited));

/** The reported bug's file: every construct CommonMark has no node for, in one document. */
const FIXTURE = [
  "---",
  "title: Test",
  "status: draft",
  "---",
  "",
  "> [!info] A callout",
  "> with a second line.",
  "",
  "A paragraph with a deliberate single newline",
  "in the middle of it, and *[bracketed emphasis]* inline.",
  "",
  "%%",
  "A comment block.",
  "Second line of the comment.",
  "%%",
  "",
].join("\n");

describe("prosemirror-markdown round-trip (what the serializer alone can carry)", () => {
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

  test("the serializer alone still mangles the reported fixture — which is why saves splice", () => {
    // Pinned deliberately: this is the defect (#143) stated as a test. The splice is what stands
    // between this output and the file on disk, and Phase 1 (#164) is what removes it entirely.
    const mangled = roundtrip(FIXTURE);
    expect(mangled).toContain("## title: Test\nstatus: draft"); // frontmatter → a setext heading
    expect(mangled).toContain("\\[!info\\]"); // the callout marker escaped
    expect(mangled).toContain("*\\[bracketed emphasis\\]*"); // brackets escaped in ordinary prose
  });

  test("a soft line break survives the serializer", () => {
    // The one loss in #143 that no round trip undoes: a joined line cannot be split again from the
    // file afterwards. So it has to survive the serializer, not merely be reported by the guard.
    expect(roundtrip("one line\ntwo line")).toBe("one line\ntwo line");
    expect(roundtrip("> one\n> two")).toBe("> one\n> two"); // re-prefixed inside a blockquote
    expect(roundtrip("- one\n  two")).toBe("- one\n  two"); // re-indented inside a list item
    // A setext heading spanning lines is where a soft break would be lost if this were carried by
    // a new inline node: `heading` admits `(text | image)*` only, so the node would not build and
    // the block would vanish, taking the whole file down the whole-document rewrite path.
    expect(roundtrip("one\ntwo\n===")).toBe("# one\ntwo");
  });

  test("the `%%` block and the callout's second line now survive on their own", () => {
    // Both were listed in the report as structural damage; both turn out to have been nothing but
    // collapsed soft breaks. What is left in each is the bracket escaping, which is a separate fix.
    expect(roundtrip(FIXTURE)).toContain("%%\nA comment block.\nSecond line of the comment.\n%%");
    expect(roundtrip(FIXTURE)).toContain("A callout\n> with a second line.");
  });

  test("EditorState builds from a parsed markdown doc (DOM-free)", () => {
    const doc = parseMarkdown("# Hi\n\nBody.");
    // The vendored bundle is untyped (minified single-name types); assert through `any`.
    const state = EditorState.create({ doc }) as any;
    expect(state.doc.firstChild?.type.name).toBe("heading");
  });
});

describe("a save the writer did not make is byte-identical", () => {
  const unchanged = [
    ["the reported fixture", FIXTURE],
    ["a file with no trailing newline", "# T\n\nBody."],
    ["runs of blank lines between blocks", "# T\n\n\n\nAlpha.\n\n\nBeta.\n"],
    ["leading blank lines", "\n\n# T\n\nAlpha.\n"],
    ["CRLF line endings", "# A\r\n\r\nBeta.\r\n"],
    ["a link reference definition between blocks", "See [r].\n\n[r]: https://example.com\n\nAfter.\n"],
    ["an empty file", ""],
    ["a file of nothing but blank lines", "\n\n\n"],
    ["nested lists and a fence", "- a\n  - b\n\n```js\nconst x = 1;\n```\n\nAfter.\n"],
    ["a table CommonMark does not model", "| a | b |\n|---|---|\n| 1 | 2 |\n\nAfter.\n"],
    ["raw HTML", "<div>\nraw\n</div>\n\nAfter.\n"],
  ] as const;

  for (const [what, source] of unchanged) {
    test(`opening and saving ${what} touches nothing`, () => {
      const result = save(source, source);
      expect(result.markdown).toBe(source);
      expect(result.degraded).toBe(false);
      expect(result.collateral).toEqual([]);
    });
  }
});

describe("an edited block is the only block that moves", () => {
  test("the reported fixture: one changed word leaves frontmatter, callout, and %% untouched", () => {
    const edited = FIXTURE.replace("deliberate", "DELIBERATE");
    const { markdown } = save(FIXTURE, edited);

    expect(markdown.startsWith("---\ntitle: Test\nstatus: draft\n---\n")).toBe(true);
    expect(markdown).toContain("> [!info] A callout\n> with a second line.");
    expect(markdown.endsWith("%%\nA comment block.\nSecond line of the comment.\n%%\n")).toBe(true);
    expect(markdown).toContain("DELIBERATE");
    // The one region that did move is the edited block, and the cost of moving it was declared
    // rather than slipped in: its brackets are escaped and its soft break joined, both reported.
    const report = save(FIXTURE, edited);
    expect(report.collateral).toHaveLength(1);
    expect(report.collateral[0]?.original).toContain("*[bracketed emphasis]*");
    expect(markdown.split("\n").filter((line: string) => line.includes("\\[")).length).toBe(1);
  });

  test("editing a block the serializer can carry reproduces the source edit byte for byte", () => {
    const source = "# Title\n\nFirst paragraph.\n\n- a\n- b\n\nLast one.\n";
    const edited = source.replace("First", "Second");
    const result = save(source, edited);
    expect(result.markdown).toBe(edited);
    expect(result.collateral).toEqual([]);
    expect(result.degraded).toBe(false);
  });

  test("a one-block edit differs from the source in exactly one run of lines (one hunk)", () => {
    const source = "# Title\n\nAlpha here.\n\nBeta here.\n\nGamma here.\n";
    const { markdown } = save(source, source.replace("Beta", "Delta"));
    const before = source.split("\n");
    const after = markdown.split("\n");
    expect(after.length).toBe(before.length);

    let first = 0;
    while (first < before.length && before[first] === after[first]) first += 1;
    let last = before.length - 1;
    while (last > first && before[last] === after[last]) last -= 1;
    // Everything between the first and last differing line must itself differ: one contiguous run,
    // which is what makes the resulting `human_edit` entry a single hunk.
    for (let i = first; i <= last; i += 1) expect(after[i]).not.toBe(before[i]);
    expect(first).toBe(4);
    expect(last).toBe(4);
  });
});

describe("blocks added, removed, and moved", () => {
  const cases = [
    ["append a paragraph at the end", "One.\n\nTwo.\n", "One.\n\nTwo.\n\nThree.\n"],
    ["append after a list", "- a\n- b\n", "- a\n- b\n\nThree.\n"],
    ["append to a file with no trailing newline", "Alpha.", "Alpha.\n\nBeta."],
    ["insert at the start", "# A\n", "New.\n\n# A\n"],
    ["insert in the middle", "# A\n\nB.\n", "# A\n\nNew.\n\nB.\n"],
    ["delete the middle block", "One.\n\nTwo.\n\nThree.\n", "One.\n\nThree.\n"],
    ["delete the first block", "One.\n\nTwo.\n\nThree.\n", "Two.\n\nThree.\n"],
    ["delete the last block", "One.\n\nTwo.\n\nThree.\n", "One.\n\nTwo.\n"],
    ["move a block", "A one.\n\nB two.\n\nC three.\n", "A one.\n\nC three.\n\nB two.\n"],
    ["split one paragraph into two", "Alpha and beta.\n", "Alpha.\n\nBeta.\n"],
    ["merge two paragraphs into one", "Alpha.\n\nBeta.\n", "Alpha and beta.\n"],
  ] as const;

  for (const [what, source, edited] of cases) {
    test(`${what} writes exactly the edited document`, () => {
      const result = save(source, edited);
      expect(result.markdown).toBe(edited);
      expect(result.degraded).toBe(false);
    });
  }

  test("a moved block keeps its own source spelling and reports nothing to consent to", () => {
    // `Node.eq` cannot tell `_emph_` from `*emph*`, so a move that re-serialized would restyle a
    // block nobody edited — and, being an insertion, would slip past the collateral check.
    const source = "# H\n\n_emph_ here.\n\nTail.\n";
    const result = save(source, "# H\n\nTail.\n\n_emph_ here.\n");
    expect(result.markdown).toBe("# H\n\nTail.\n\n_emph_ here.\n");
    expect(result.collateral).toEqual([]);
  });

  test("two look-alike blocks reordered stay on the diagonal instead of swapping spellings", () => {
    // `*x*` and `_x_` are one node to the matcher. Whatever it pairs, no byte may move.
    const source = "*x*\n\n_x_\n\nEnd.\n";
    const result = save(source, source);
    expect(result.markdown).toBe(source);
  });
});

describe("collateral is reported, never written silently", () => {
  test("editing inside a callout reports what re-serializing that block would cost", () => {
    const source = "> [!info] A callout\n> with a second line.\n\nAfter.\n";
    const result = save(source, source.replace("callout", "CALLOUT"));
    expect(result.collateral).toHaveLength(1);
    expect(result.collateral[0]?.original).toBe("> [!info] A callout\n> with a second line.");
    expect(result.collateral[0]?.faithful).toContain("\\[!info\\]");
    expect(result.markdown.endsWith("\n\nAfter.\n")).toBe(true); // the rest still untouched
  });

  test("editing a block the serializer carries faithfully reports nothing", () => {
    const source = "Alpha here.\n\nBeta here.\n";
    expect(save(source, "Alpha there.\n\nBeta here.\n").collateral).toEqual([]);
  });

  test("deleting an oddly-spelled block is not collateral — the block is gone", () => {
    const source = "_x_ here.\n\nBeta.\n";
    const result = save(source, "Beta.\n");
    expect(result.markdown).toBe("Beta.\n");
    expect(result.collateral).toEqual([]);
  });
});

describe("when the splice cannot vouch for itself it says so", () => {
  test("a lone CR refuses to splice rather than slide every block offset", () => {
    const source = "Alpha.\rBeta.\r";
    const result = save(source, "Alpha.\rGamma.\r");
    expect(result.degraded).toBe("line-endings");
    expect(result.collateral).toEqual([]);
  });

  test("a spliced file that does not parse back to the edited document degrades", () => {
    // The safety net, driven directly: an edited document the splice cannot reproduce must fall
    // back to a whole-document write and flag it, not write bytes it cannot vouch for.
    const source = "Alpha.\n";
    const doc = parseMarkdown(source);
    const mismatched = parseMarkdown("Alpha.\n\nBeta.\n\nGamma.\n");
    // Hand the splice a baseline document that disagrees with the source's block count.
    const result = spliceMarkdown(source, mismatched, mismatched);
    expect(result.degraded).toBe("block-mismatch");
    expect(result.markdown).toBe(serializeMarkdown(mismatched));
    expect(save(source, source).degraded).toBe(false); // the honest baseline still splices
    expect(doc.childCount).toBe(1);
  });
});

describe("a blank file", () => {
  test("typing into an empty file writes just what was typed", () => {
    expect(save("", "Hello.\n").markdown).toBe("Hello.");
  });

  test("typing into a file of blank lines keeps the blank lines", () => {
    expect(save("\n\n", "Hello.\n").markdown).toBe("\n\nHello.");
  });

  test("emptying a file keeps the bytes that were never part of a block", () => {
    // The file's trailing newline lives outside every block span, so deleting the only paragraph
    // deletes the paragraph — not the byte after it.
    const result = save("Alpha.\n", "");
    expect(result.markdown).toBe("\n");
    expect(result.degraded).toBe(false);
  });
});

describe("the serializer stops escaping what the file left bare (REQ-1, #174)", () => {
  // The two SAFETY tests come first on purpose. Without them an implementation that simply never
  // escapes anything passes every other test in this block — a worse bug than the one being fixed,
  // because it corrupts a document silently instead of merely respelling it.

  test("SAFETY: an escaped emphasis marker the file really contains stays escaped", () => {
    const source = "This is \\*not emphasis\\* here.\n";
    const result = save(source, source.replace("here", "there"));
    expect(result.markdown).toBe("This is \\*not emphasis\\* there.\n");
    expect(result.degraded).toBe(false);
  });

  test("SAFETY: an escaped link the file really contains stays escaped", () => {
    const source = "Not a \\[link\\](https://x.example) here.\n";
    const result = save(source, source.replace("here", "there"));
    expect(result.markdown).toBe("Not a \\[link\\](https://x.example) there.\n");
    expect(result.degraded).toBe(false);
  });

  test("editing a word inside a callout writes the callout marker unescaped", () => {
    const source = "> [!info] A callout\n> with a second line.\n";
    const result = save(source, source.replace("callout", "CALLOUT"));
    expect(result.markdown).toBe("> [!info] A CALLOUT\n> with a second line.\n");
    expect(result.degraded).toBe(false);
  });

  test("editing a word in the fixture's bracketed-emphasis paragraph keeps the brackets bare", () => {
    const { markdown } = save(FIXTURE, FIXTURE.replace("deliberate", "DELIBERATE"));
    expect(markdown).toContain("and *[bracketed emphasis]* inline.");
    expect(markdown).not.toContain("\\[");
  });

  test("a newly typed paragraph containing `[note]` is written unescaped", () => {
    // The pure-insertion path: a block that owns no original bytes, so there is nothing to restore
    // its spelling from. This is the case the de-escape relaxation exists for on its own.
    const source = "Alpha.\n";
    const result = save(source, "Alpha.\n\nSee [note] for details.\n");
    expect(result.markdown).toBe("Alpha.\n\nSee [note] for details.\n");
    expect(result.degraded).toBe(false);
  });

  test("SAFETY: a newly typed escaped emphasis marker stays escaped", () => {
    // The two SAFETY tests above drive the edited-block path, which owns its source bytes: a
    // relaxation that dropped too much there is recoverable from the spelling the file already
    // had. A pure insertion owns none, so the relaxation's own verification is the only thing
    // standing between an over-eager implementation and a document that means something new.
    const result = save("Alpha.\n", "Alpha.\n\nThis is \\*not emphasis\\* here.\n");
    expect(result.markdown).toBe("Alpha.\n\nThis is \\*not emphasis\\* here.\n");
    expect(result.degraded).toBe(false);
  });

  test("editing a word leaves a `~` and a bare `*` in the same block unescaped", () => {
    // Pins the whole character class rather than the brackets alone. `~/.claude` is a live
    // spelling in this repo's own AGENTS.md, and a relaxation narrowed to brackets writes it back
    // as `\~/.claude` while passing every other test in this file.
    const source = "Paths like ~/.claude live here, and x*y too.\n";
    const result = save(source, source.replace("live", "LIVE"));
    expect(result.markdown).toBe("Paths like ~/.claude LIVE here, and x*y too.\n");
    expect(result.degraded).toBe(false);
  });
});

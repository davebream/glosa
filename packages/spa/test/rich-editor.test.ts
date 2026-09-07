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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EditorState, Schema, markdownSchema } from "../src/vendor/prosemirror.js";
import {
  MODELLED_MARK_TYPES,
  MODELLED_NODE_TYPES,
  blockLayout,
  collateralFor,
  parseMarkdown,
  runIsModelled,
  runsOverlap,
  serializeMarkdown,
  serializeNodesFaithfully,
  spliceMarkdown,
} from "../src/rich-editor.js";

const roundtrip = (md: string) => serializeMarkdown(parseMarkdown(md));

/** What the rich face would write for `source` after the writer's edits turned it into `edited`. */
const save = (source: string, edited: string) => spliceMarkdown(source, parseMarkdown(source), parseMarkdown(edited));

/** WHY A COUNT OVER THE CORPUS CAN GO RED WITHOUT ANYTHING HAVING REGRESSED — attached as the failure
 *  message of every such count, so the explanation arrives with the red rather than waiting in a
 *  comment somebody has to go and find.
 *
 *  The nine documents are read LIVE from the working tree, not from a frozen fixture. That is
 *  deliberate: REQ-8's direction is only checkable against the repository's real content. The price
 *  is that the totals below are a property of the documents as they stand today, and three sibling
 *  tasks in this same epic append to two of them. */
const CORPUS_COUNT_NOTE = [
  "This is a COUNT OVER THE NINE HAND-WRITTEN DOCUMENTS IN THE REPOSITORY ROOT, read live from the",
  "working tree rather than from a fixture, so editing any of the nine moves it. CHANGELOG.md and",
  "docs/decisions.md take appends from T1, T4 and T5 in this same epic: whichever of those merges",
  "second sees this red through no fault of its own, and the final total depends on the merge order.",
  "",
  "A MOVED DENOMINATOR WITH UNCHANGED NUMERATORS IS BOOKKEEPING, NOT A REGRESSION. Re-baseline the",
  "total, then confirm the numerators did not move with it:",
  "  - metric 1's per-cause map still totals 40,",
  "  - metric 2 still reports 3 dishonest writes,",
  "  - metric 3 still reports 0 missed and 0 false alarms.",
  "If all three hold, the corpus grew and nothing about the serializer changed. Re-baselining means",
  "the constant AND the test names that carry the same totals.",
  "",
  "A MOVED NUMERATOR IS THE REAL SIGNAL: investigate it, never re-baseline it.",
].join("\n");

/** The note above, plus what this particular count is. */
const countNote = (what: string) => `${CORPUS_COUNT_NOTE}\n\nTHIS COUNT: ${what}`;

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
    // Pinned deliberately: this is the defect (#143) stated as a test, and the splice is what stands
    // between this output and the file on disk. #174 removed ONE HALF of it — the serializer no
    // longer invents escapes the source did not have — so the two bracket assertions below are
    // INVERTED, never deleted: a reviewer seeing a deleted gate assertion cannot tell an intentional
    // inversion from a suppressed failure. The other half, front matter collapsing into a setext
    // heading, is still #143's and stays pinned here as a defect until T5 lands.
    const mangled = roundtrip(FIXTURE);
    expect(mangled).toContain("## title: Test\nstatus: draft"); // frontmatter → a setext heading (#143's half)
    // Inverted by #174, was `toContain("\\[!info\\]")`. It now proves the stronger thing the weaker
    // assertion cannot: not one escape anywhere in the output, so no construct in the fixture picks
    // up a backslash the file did not already carry.
    expect(mangled).not.toContain("\\[");
    // Inverted by #174, was `toContain("*\\[bracketed emphasis\\]*")`. Brackets in ordinary prose now
    // come back spelled exactly as the file spelled them.
    expect(mangled).toContain("*[bracketed emphasis]*");
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
    // collapsed soft breaks. The bracket escaping that used to remain in each was that separate fix,
    // and #174 is it — see the inverted assertions above. What the serializer alone still costs this
    // fixture is front matter, which is #143's.
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
    // The one region that did move is the edited block, and after #174 moving it costs nothing:
    // the block goes back in the file's own spelling with only the writer's word changed, so there
    // is nothing left to declare. All three assertions below are INVERTED, never deleted — a
    // reviewer seeing a deleted gate assertion cannot tell an intentional inversion from a
    // suppressed failure.
    const report = save(FIXTURE, edited);
    // Inverted by #174, was `toHaveLength(1)`. The edited paragraph is a fixed point now, so the
    // writer is asked to consent to nothing.
    expect(report.collateral).toHaveLength(0);
    // Inverted by #174, was an assertion about `collateral[0].original`. With nothing reported, the
    // WRITTEN bytes are what carries the claim: the bracketed span survives the edit verbatim.
    expect(markdown).toContain("*[bracketed emphasis]*");
    // Inverted by #174, was `.toBe(1)`. No line of the written file carries an escape the source
    // did not have.
    expect(markdown.split("\n").filter((line: string) => line.includes("\\[")).length).toBe(0);
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
  test("editing inside a callout costs nothing to report — the block goes back as it was", () => {
    // Named "… reports what re-serializing that block would cost" until #174, which made the callout
    // marker a fixed point. The three assertions below are INVERTED, never deleted: a reviewer
    // seeing a deleted gate assertion cannot tell an intentional inversion from a suppressed
    // failure. This suite's positive control for the guard — the one fixture that still HAS to
    // report — is the setext heading in "the collateral guard, re-posed".
    const source = "> [!info] A callout\n> with a second line.\n\nAfter.\n";
    const result = save(source, source.replace("callout", "CALLOUT"));
    // Inverted by #174, was `toHaveLength(1)`. The callout blockquote is a fixed point now.
    expect(result.collateral).toHaveLength(0);
    // Inverted by #174, was an assertion about `collateral[0].original`. With nothing reported, the
    // WRITTEN bytes carry the proof: the source's own spelling, the writer's word, and nothing else.
    expect(result.markdown).toBe("> [!info] A CALLOUT\n> with a second line.\n\nAfter.\n");
    // Inverted by #174, was `collateral[0].faithful` containing `\[!info\]`. That premise is gone,
    // so this becomes the positive case: no escape reaches the file at all.
    expect(result.markdown).not.toContain("\\[");
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

describe("the block layout carries the document's reference context", () => {
  // A reference link whose definition is out of scope parses to plain text, so a candidate
  // spelling for one edited block cannot be verified on its own — `## [Unreleased]` means
  // something different alone than it means in the file. The definitions come off the tokenizer
  // pass `blockLayout` already makes, so nothing new parses the source a second time.
  const source = "See [r].\n\n[r]: https://example.com\n\nAfter.\n";

  test("the block spans are what they have always been", () => {
    // The regression guard for the span half. The definition produces neither a token nor a node,
    // so it falls in the gap between the two paragraphs and each still bounds its own bytes.
    const { blocks } = blockLayout(source);
    expect(blocks.map(({ start, end }) => source.slice(start, end))).toEqual(["See [r].", "After."]);
  });

  test("the reference definitions come back as text a candidate can be parsed with", () => {
    const { referenceSuffix } = blockLayout(source);
    // Appendable with nothing added at the call site, and a blank line ahead of the definitions so
    // they cannot be absorbed into whatever the candidate ends with.
    expect(referenceSuffix.startsWith("\n\n")).toBe(true);

    const alone = parseMarkdown("See [r].");
    const inContext = parseMarkdown(`See [r].${referenceSuffix}`);
    // Alone the brackets are literal text; with the definitions in scope they are a link to the
    // target the source defined. This difference is the whole reason the context has to travel.
    expect(alone.firstChild?.child(0).marks).toEqual([]);
    expect(inContext.firstChild?.child(1).marks[0]?.attrs.href).toBe("https://example.com");
    // And appending them adds no node of its own, which is what makes it safe to append at all.
    expect(inContext.childCount).toBe(alone.childCount);
  });

  test("a document that defines no references reports none", () => {
    expect(blockLayout("# T\n\nBody.\n").referenceSuffix).toBe("");
  });

  test("every definition comes back, spelled so it defines exactly what it defined", () => {
    // Two definitions, one carrying every escape that can reach a stored title, and a label the
    // renderer has to normalize. The cases above exercise one definition, no title, no escapes.
    const source =
      "Links: [one] and [Two  Ref].\n\n" +
      '[one]: /p?x=&amp;amp;y "He said \\"go\\" \\\\ &amp;amp;"\n' +
      "[Two  Ref]: /second\n";
    const candidate = "Links: [one] and [Two  Ref].";
    const { referenceSuffix } = blockLayout(source);
    const inContext = parseMarkdown(candidate + referenceSuffix);
    expect(inContext.childCount).toBe(parseMarkdown(candidate).childCount);
    expect(inContext.firstChild?.eq(parseMarkdown(source).firstChild)).toBe(true);
  });
});

describe("what a candidate spelling is checked against", () => {
  test("the fixture round trip drops the bracket escapes and still writes the front matter", () => {
    // The relative baseline, stated as a test. `serializeMarkdown` holds no source bytes, so the
    // only thing it can ask is whether dropping the escapes changes what its OWN output means.
    // Judged absolutely — against the document it was handed — the answer would be no for a reason
    // that has nothing to do with escaping: the fixture's YAML front matter parses to a thematic
    // break plus a setext heading, so this document never round-trips at all and an absolute check
    // would refuse every relaxation on exactly the documents that need one.
    const mangled = roundtrip(FIXTURE);
    expect(mangled).not.toContain("\\[");
    expect(mangled).toContain("*[bracketed emphasis]*");
    // Still mangled where #143's opaque blocks are, which is T5's half and is pinned above at the
    // `## title: Test` assertion. Restated here so the relaxation cannot be read as having fixed it.
    expect(mangled).toContain("## title: Test\nstatus: draft");
  });

  test("an escaped bracket whose bare form collides with a reference definition stays escaped", () => {
    // The verification parse reads a candidate in the document's reference context, and this is the
    // input that proves it must. `See [r] there.` on its own is plain text, so a check made in
    // isolation accepts dropping the escapes the file really spelled; back in the document `[r]` is
    // a link, the splice's reparse net rejects the save, and the whole-document fallback writes a
    // file with no definition in it — a line the writer never touched, silently deleted.
    //
    // No document in this repository contains a `\[`, so the measurement harness cannot reach this
    // class of input and only this test stands between it and a regression.
    const source = "See \\[r\\] here.\n\n[r]: https://example.com\n\nAfter.\n";
    const result = save(source, source.replace("here", "there"));
    expect(result.markdown).toBe(source.replace("here", "there"));
    expect(result.degraded).toBe(false);
  });

  test("a definition whose target contains an entity is re-emitted so it still targets that", () => {
    // Pins ESCAPED_IN_DESTINATION on its own. markdown-it stores an href DECODED, so re-emitting it
    // raw would let the file's `&amp;amp;` come back meaning `&`. Empty that set and this test fails
    // while the title test below still passes: the definition no longer round-trips, the guard in
    // `referenceDefinitions` drops it rather than emit a binding that means something else, and
    // `[a]` stops resolving. The corpus cannot pin this — its 18 definitions carry no `&`.
    const source = "Link [a] here.\n\n[a]: /p?x=&amp;amp;y\n";
    const { referenceSuffix } = blockLayout(source);
    const link = parseMarkdown(`Link [a] here.${referenceSuffix}`).firstChild?.child(1);
    expect(link?.marks[0]?.attrs.href).toBe("/p?x=&amp;y");
  });

  test("a definition carrying a title is re-emitted so it still carries that title", () => {
    // Pins ESCAPED_IN_TITLE on its own — the destination here holds none of the three characters
    // the other set escapes, so emptying that one leaves this passing. A title is stored decoded
    // too, and it is delimited by the quote it contains: written back raw, the first `"` ends it.
    // The corpus cannot pin this either — not one of its definitions carries a title.
    const source = 'Link [b] here.\n\n[b]: /plain "He said \\"go\\" \\\\ here"\n';
    const { referenceSuffix } = blockLayout(source);
    const link = parseMarkdown(`Link [b] here.${referenceSuffix}`).firstChild?.child(1);
    expect(link?.marks[0]?.attrs.title).toBe('He said "go" \\ here');
    expect(link?.marks[0]?.attrs.href).toBe("/plain");
  });
});

describe("an edited block is written back in the spelling the file already had (REQ-2/3/4, #174)", () => {
  // Each case is a SAVE, not a round trip: what reaches disk is what matters, and the source bytes
  // the restoration works from only exist on the save path. The writer's own word is the one run
  // that cannot be put back — restoring it would change the tree, and the verification refuses.

  test("REQ-2: character references survive an edit elsewhere in the block", () => {
    // markdown-it decodes entities at parse, so the tree carries `&`, U+00A0 and `<`. Written from
    // the tree alone the file would silently lose all three spellings.
    const source = "Use &nbsp; and &amp; and &lt; here.\n";
    const result = save(source, source.replace("here", "there"));
    expect(result.markdown).toBe("Use &nbsp; and &amp; and &lt; there.\n");
    expect(result.degraded).toBe(false);
  });

  test("REQ-3: a reference-form link is written back in reference form, not inlined", () => {
    const source = [
      "## [Unreleased] pending items",
      "",
      "Body paragraph.",
      "",
      "[Unreleased]: https://example.com/compare",
      "",
    ].join("\n");
    const result = save(source, source.replace("pending", "PENDING"));
    expect(result.markdown).toBe(source.replace("pending", "PENDING"));
    expect(result.degraded).toBe(false);
    // The target appears exactly once in the file — in the definition it was already in. Written
    // from the tree alone the heading reads `## [Unreleased](https://example.com/compare) …`.
    expect(result.markdown.split("https://example.com/compare")).toHaveLength(2);
  });

  test("REQ-4: a continuation line keeps the indent only the source has", () => {
    // markdown-it strips leading whitespace from a paragraph's continuation lines, so the indent
    // exists nowhere but in the file. Re-serializing the block writes the lines flush left.
    const source = '<picture>\n  <source srcset="hero.webp">\n</picture>\nFallback text here.\n';
    const result = save(source, source.replace("here", "there"));
    expect(result.markdown).toBe(source.replace("here", "there"));
    expect(result.degraded).toBe(false);
  });

  test("REQ-4: an indented blockquote marker is not normalised", () => {
    const source = " > alpha here\n > beta line\n";
    const result = save(source, source.replace("alpha", "ALPHA"));
    expect(result.markdown).toBe(" > ALPHA here\n > beta line\n");
    expect(result.degraded).toBe(false);
  });

  test("AMD-2a: a line break inside an inline code span survives an edit in the same block", () => {
    // AMD-2a, and the one class here that is UNRECOVERABLE CONTENT LOSS rather than a respelling:
    // CommonMark turns a line ending inside a code span into a space at parse, so once the save has
    // written `git   add` the break the writer typed is gone from the file and no round trip can
    // put it back. Both spellings mean the same code span, so the restoration may put it back. It
    // needs the break and the indent beside it to land in ONE run, which they do — measured, under
    // both the whitespace-run tokenizer and a per-character one; see RESTORE_TOKEN in rich-editor.js
    // for why the run token is kept anyway and why this case is not the reason.
    const source = "Run `git\n  add` first and then stop.\n";
    const result = save(source, source.replace("stop", "STOP"));
    expect(result.markdown).toBe("Run `git\n  add` first and then STOP.\n");
    expect(result.degraded).toBe(false);
  });

  test("AMD-2b: a tight list is not re-emitted loose when a sibling item is edited", () => {
    // AMD-2b. The serializer writes a blank line between the paragraph and the fence inside the
    // second item, which turns the list loose on reparse — a structural change to a list the writer
    // only edited one word of.
    const source = "- alpha here\n- beta here\n  ```js\n  const x = 1;\n  ```\n- gamma here\n";
    const result = save(source, source.replace("gamma", "GAMMA"));
    expect(result.markdown).toBe(source.replace("gamma", "GAMMA"));
    expect(result.degraded).toBe(false);
  });

  test("REQ-3: the edited word repeated inside the destination does not drag the destination into its run", () => {
    // The corpus's own hardest case, and the one that pins the diff's DIAGONAL TIE-BREAK. Writing
    // the destination out inline puts a second `alpha` in the serializer's output. Several token
    // alignments tie at the same number of matches; one of them matches the FILE's `alpha` against
    // that copy inside the destination, which lands the writer's edited word and the inlined
    // destination in a single run — and a run is all-or-nothing, so neither is ever put back and
    // the save writes a 37-token URL into a heading. Measured over CHANGELOG.md's 18 reference-link
    // headings: 13 of them restore under the diagonal tie-break and none of them without it.
    const source = [
      "## [0.1.0-alpha.12] - 2026-09-04",
      "",
      "Some body.",
      "",
      "[0.1.0-alpha.12]: https://example.com/compare/v0.1.0-alpha.11...v0.1.0-alpha.12",
      "",
    ].join("\n");
    // The writer edits the word INSIDE the label. The definition still resolves, because a label
    // and a definition are both looked up case-folded.
    const result = save(source, source.replace("[0.1.0-alpha.12] -", "[0.1.0-ALPHA.12] -"));
    expect(result.markdown).toBe(source.replace("[0.1.0-alpha.12] -", "[0.1.0-ALPHA.12] -"));
    expect(result.degraded).toBe(false);
    expect(result.markdown.split("https://example.com/compare")).toHaveLength(2);
  });

  test("an escape the file did not need is still the file's, so the relaxation runs BEFORE the restoration", () => {
    // Pins the ORDER of the two mechanisms, which is otherwise invisible. `\\~` is not load-bearing
    // — `~` alone means the same thing — so the relaxation is free to drop it, and the file spelled
    // it anyway. Relaxation first, restoration second: the escape goes, then the source puts it
    // back, and the file keeps what it said. The other way round the restoration puts it back and
    // the relaxation then drops it again, verifying happily, and the save writes `~/.claude` — a
    // spelling that is neither the serializer's nor the file's, in a block the writer only changed
    // one word of. Measured on `\\~` and on `` \\` ``; a load-bearing `\\_` survives either order,
    // which is why this fixture is the one that pins it.
    const source = "Paths like \\~/.claude live here.\n";
    const result = save(source, source.replace("live", "LIVE"));
    expect(result.markdown).toBe("Paths like \\~/.claude LIVE here.\n");
    expect(result.degraded).toBe(false);
  });

  test("REQ-6: a block holding a literal bracket, an entity and a reference link moves only at the edit", () => {
    const source = "Note [see r] plus a literal [bracket] and &amp; here.\n\n[see r]: https://example.com\n";
    const edited = source.replace("literal", "LITERAL");
    const result = save(source, edited);
    expect(result.markdown).toBe(edited);
    expect(result.degraded).toBe(false);
    // Stated as the requirement states it: the written bytes differ from the source at the writer's
    // word and nowhere else.
    // Stated the way the requirement states it: the written bytes differ from the source at the
    // writer's word and at no other offset in the file.
    expect(result.markdown.length).toBe(source.length);
    const differing: number[] = [];
    for (let i = 0; i < source.length; i += 1) if (source[i] !== result.markdown[i]) differing.push(i);
    const word = source.indexOf("literal");
    expect(differing).toEqual([word, word + 1, word + 2, word + 3, word + 4, word + 5, word + 6]);
  });
});

describe("REQ-7: a re-serialized block always means what the writer's tree means", () => {
  // The absolute predicate, driven directly over every fixture this file uses. `serializeNodes` is
  // wrapped, never edited, so this is the wrapper's whole contract: whatever it returns for a run
  // of nodes parses — in the document's own reference context — back to exactly that run.
  //
  // THIS TEST PINS THE ABSOLUTE/RELATIVE SPLIT (carried obligation OB-2). Swap the per-block
  // baseline to the relative one (`parseMarkdown(raw)`) and the tight-list-with-a-fence fixture
  // fails: that block does not round-trip through the serializer, so a relative baseline is the
  // LOOSE list and refuses the restoration that puts the tight one back. Absolute per block is what
  // lets a lossy block's source be restored in full.
  const fixtures: [string, string][] = [
    ["the reported fixture", FIXTURE],
    ["entities", "Use &nbsp; and &amp; and &lt; here.\n"],
    ["a reference heading", "## [Unreleased] pending items\n\nBody.\n\n[Unreleased]: https://example.com/compare\n"],
    ["an indented continuation line", '<picture>\n  <source srcset="hero.webp">\n</picture>\nFallback text here.\n'],
    ["an indented blockquote marker", " > alpha here\n > beta line\n"],
    ["a break inside a code span", "Run `git\n  add` first and then stop.\n"],
    ["a tight list holding a fence", "- alpha here\n- beta here\n  ```js\n  const x = 1;\n  ```\n- gamma here\n"],
    ["an escaped bracket colliding with a definition", "See \\[r\\] here.\n\n[r]: https://example.com\n\nAfter.\n"],
    ["escapes that are load-bearing", "This is \\*not emphasis\\* here.\n"],
    ["nested lists and a fence", "- a\n  - b\n\n```js\nconst x = 1;\n```\n\nAfter.\n"],
    ["a table CommonMark does not model", "| a | b |\n|---|---|\n| 1 | 2 |\n\nAfter.\n"],
    ["CRLF line endings", "# A\r\n\r\nBeta.\r\n"],
  ];

  for (const [what, source] of fixtures) {
    test(`every block of ${what} reparses to the node it was written from`, () => {
      const { blocks, referenceSuffix } = blockLayout(source);
      const doc = parseMarkdown(source);
      expect(blocks.length).toBe(doc.childCount);
      for (const [index, span] of blocks.entries()) {
        const node = doc.child(index);
        const written = serializeNodesFaithfully([node], referenceSuffix, source.slice(span.start, span.end));
        const reparsed = parseMarkdown(written + referenceSuffix);
        expect(reparsed.childCount).toBe(1);
        expect(reparsed.firstChild?.eq(node)).toBe(true);
        // Stronger, and the reason the write is honest at all: handed a block's own bytes back, the
        // wrapper returns those bytes. Nothing the writer did not change can move.
        expect(written).toBe(source.slice(span.start, span.end));
      }
    });
  }
});

describe("the restoration's size guard", () => {
  // Mirrors MAX_RESTORE_CELLS in rich-editor.js. Duplicated deliberately: a test that read the
  // constant would pass however the constant moved.
  const budget = 12_000_000;
  const tokens = (text: string) => (text.match(/\w+|\s+|[^\w\s]/g) ?? []).length;

  test("the budget is where this file says it is, checked from both sides", () => {
    // The corpus below cannot pin the constant on its own: its two largest blocks are serializer
    // fixed points, so skipping their restoration returns the same bytes and is invisible. The
    // largest block the corpus HAS to restore is 2.5M cells, which leaves everything between 2.5M
    // and 12M unchecked. These two paragraphs close that gap by straddling the budget — each is a
    // long run of words with one `&amp;` in it, so it is not a fixed point and restoring it is
    // observable, and they differ only in length.
    const under = `${"alpha ".repeat(1700)}&amp; end.`;
    const over = `${"alpha ".repeat(1760)}&amp; end.`;
    const cells = (body: string) =>
      (tokens(serializeNodesFaithfully([parseMarkdown(body).child(0)], "")) + 1) * (tokens(body) + 1);
    expect(cells(under)).toBeLessThan(budget);
    expect(cells(over)).toBeGreaterThan(budget);

    // Under the budget the source spelling comes back...
    expect(serializeNodesFaithfully([parseMarkdown(under).child(0)], "", under)).toBe(under);
    // ...and over it the restoration is skipped and the serializer's own bytes are written, which is
    // exactly what this file did before the restoration existed: the entity comes back decoded, the
    // collateral guard still reports it, nothing is corrupted.
    const written = serializeNodesFaithfully([parseMarkdown(over).child(0)], "", over);
    expect(written).not.toBe(over);
    expect(written).toBe(serializeNodesFaithfully([parseMarkdown(over).child(0)], ""));
  });

  test("no block in this repository's nine hand-written documents comes near the budget", () => {
    // The guard degrades to the serializer's own output, which is safe but turns the fix off for
    // that block. So the threshold has to stay checkable against real content rather than assumed:
    // this measures the matrix the restoration would actually fill — the M1 output's tokens against
    // the source's — for every top-level block of the corpus REQ-8 is recorded over.
    const root = join(import.meta.dir, "../../..");
    const documents = [
      "README.md",
      "AGENTS.md",
      "DESIGN.md",
      "CONTRIBUTING.md",
      "ROADMAP.md",
      "PRODUCT.md",
      "CHANGELOG.md",
      "docs/requirements.md",
      "docs/decisions.md",
    ];
    let worst = 0;
    let blockCount = 0;
    let unrestored = 0;
    for (const name of documents) {
      const source = readFileSync(join(root, name), "utf8");
      const { blocks, referenceSuffix } = blockLayout(source);
      const doc = parseMarkdown(source);
      expect(blocks.length).toBe(doc.childCount);
      for (const [index, span] of blocks.entries()) {
        const body = source.slice(span.start, span.end);
        const node = doc.child(index);
        // Called WITHOUT source bytes this is the de-escape relaxation alone — the same string the
        // restoration diffs against the source, so this is the real matrix, not a proxy for it.
        const relaxed = serializeNodesFaithfully([node], referenceSuffix);
        worst = Math.max(worst, (tokens(relaxed) + 1) * (tokens(body) + 1));
        blockCount += 1;
        if (serializeNodesFaithfully([node], referenceSuffix, body) !== body) unrestored += 1;
      }
    }
    // The same corpus as the harness below, counted the same way, so it moves for the same reasons
    // and is re-baselined in the same edit; see the BLOCKS note there.
    expect(
      blockCount,
      countNote(
        "the corpus block total, the same number the REQ-8 harness below pins as BLOCKS. Re-baseline both together.",
      ),
    ).toBe(433);
    // Measured here: 5,103,081 cells, in the 6051-byte `### Fixed` list under `## [Unreleased]` in
    // CHANGELOG.md. That list is ONE top-level block and every changelog entry any task appends
    // makes it bigger, so it grows monotonically and #143 will grow it again. The budget was 6M
    // against a 3,598,609-cell worst block in docs/requirements.md; merging #179, #180 and #181
    // moved the worst block to CHANGELOG.md and left no headroom, which is exactly what this
    // assertion exists to catch. Widened to 12M rather than relaxing the 1.5x margin: over budget
    // the restoration silently stops running for that block, and this is not a keystroke path —
    // `getSave()` has three user-action call sites and the measured cost was 19ms at 3.6M cells.
    // Asserted with headroom rather than bare inequality, so a document growing towards the budget
    // turns this red while there is still room to widen it — before it silently turns the fix off
    // for that block.
    expect(worst * 1.5).toBeLessThan(budget);
    // And the property the whole restoration rests on: handed a block's own bytes back, every block
    // in the corpus comes back as those bytes. Nothing the writer did not change can move.
    expect(unrestored).toBe(0);
  });
});

describe("the collateral guard, re-posed (REQ-6, #174)", () => {
  // WHY THIS BLOCK EXISTS AT ALL. The restoration above puts a lossy block's source spelling back,
  // which means the old guard's question — "does re-serializing the ORIGINAL block reproduce its
  // bytes?" — no longer answers the question a writer needs answered before consenting to a save.
  // The guard now asks: does the write still differ from the file at a place the SERIALIZER caused,
  // rather than a place the writer's edit caused?
  //
  // The setext fixture below is this file's POSITIVE CONTROL, and it is the only one. Every other
  // collateral assertion here asserts an EMPTY array, so an implementation that simply deleted the
  // guard would pass all of them. If a future improvement to the restoration search makes this
  // fixture honest, re-point the control at a fixture that is still dishonest — never delete it.
  const SETEXT = "Title words\n===\n";

  test("the control: an edit the restoration cannot undo is reported, with what it costs", () => {
    // The heading spans two lines in the file and one in the serializer's output, so restoring the
    // source over the writer's own word is the one thing that cannot verify — the `\n===` and the
    // edited word land in a single run, and a run is all-or-nothing. The bytes go out anyway; the
    // writer is asked first. That is the whole contract.
    const result = save(SETEXT, "Title WORDS\n===\n");
    expect(result.markdown).toBe("# Title WORDS\n");
    expect(result.degraded).toBe(false); // the collateral path, NOT the whole-document reparse net
    expect(result.collateral).toHaveLength(1);
    expect(result.collateral[0]?.original).toBe("Title words\n===");
    expect(result.collateral[0]?.faithful).toBe("# Title words");
    expect(result.collateral[0]?.written).toBe("# Title WORDS");
  });

  test("no false alarm: an edit the restoration DID undo reports nothing", () => {
    // All three respell under the serializer alone and all three come back exactly, so the write
    // differs from the file at the writer's word and nowhere else. A guard that still fired here
    // would ask for consent to a save that costs nothing, every time, on most of a real document.
    const callout = "> [!info] A callout\n> with a second line.\n\nAfter.\n";
    expect(save(callout, callout.replace("callout", "CALLOUT")).collateral).toEqual([]);

    const entities = "Use &nbsp; and &amp; and &lt; here.\n";
    expect(save(entities, entities.replace("here", "there")).collateral).toEqual([]);

    const plain = "Alpha here.\n\nBeta here.\n";
    expect(save(plain, plain.replace("Alpha", "Delta")).collateral).toEqual([]);
  });

  test("no missed loss: an unedited lossy block stays byte-identical and stays quiet", () => {
    // The block the control fires on, saved WITHOUT an edit. It never reaches the guard — the
    // pairing copies its bytes — and it must not be made noisy for a save that changed nothing.
    const result = save(SETEXT, SETEXT);
    expect(result.markdown).toBe(SETEXT);
    expect(result.collateral).toEqual([]);
    expect(result.degraded).toBe(false);
  });

  test("the join is TOUCHING, not strict: two zero-width runs at one offset overlap", () => {
    // THE DISCRIMINATOR, and it has to be a direct test. The control above fires under a strict
    // join too — its `\n===` deletion has non-zero source extent — so every other assertion in this
    // file passes with `<` in place of `<=`. What `<` loses is the pure INSERTION: zero-width on the
    // source side, and two zero-width runs at one offset never intersect. That is all 18 of
    // CHANGELOG.md's reference-link headings, REQ-3's largest residual cause, silently unguarded.
    const at = (b0: number, b1: number) => ({ a0: 0, a1: 0, b0, b1 });
    expect(runsOverlap(at(6, 6), at(6, 6))).toBe(true); // two pure insertions at the same offset
    expect(runsOverlap(at(3, 7), at(7, 9))).toBe(true); // a ranged run abutting the next run's start
    expect(runsOverlap(at(3, 7), at(7, 7))).toBe(true); // an insertion abutting a ranged run's end
    expect(runsOverlap(at(7, 7), at(3, 7))).toBe(true); // and the same pair the other way round
    expect(runsOverlap(at(3, 7), at(5, 9))).toBe(true); // genuinely intersecting
    expect(runsOverlap(at(0, 2), at(3, 5))).toBe(false); // separated by a token
    expect(runsOverlap(at(4, 4), at(6, 6))).toBe(false); // two insertions at different offsets
  });

  test("the ablation: break the restoration and the guard comes back on", () => {
    // THE ANTI-TAUTOLOGY RATCHET. The first design of this guard routed `faithful` through the
    // restoration and left the condition alone, which makes `faithful !== source` true by
    // construction for all 418 blocks of the corpus: it could not fire for any input. This test is
    // what a repeat of that fails on — with the restoration off the write really is dishonest, so
    // the guard MUST fire.
    //
    // "Restoration disabled" is not a mode the module can be put into. It is what the wrapper
    // already does when called WITHOUT source bytes — M1 only, exactly the pure-insertion path — so
    // the ablation is an omitted argument and there is deliberately no flag, toggle or option that
    // turns the fix off in a write path whose whole purpose is not writing bytes nobody typed.
    const source = "## [Unreleased] pending items\n\n[Unreleased]: https://example.com/compare\n";
    const { blocks, referenceSuffix } = blockLayout(source);
    const body = "## [Unreleased] pending items";
    expect(blocks.map(({ start, end }) => source.slice(start, end))).toEqual([body]); // the definition is not a block
    const original = parseMarkdown(source).child(0);
    const edited = parseMarkdown(source.replace("pending", "PENDING")).child(0);

    const ablated = serializeNodesFaithfully([edited], referenceSuffix);
    expect(ablated).toContain("(https://example.com/compare)"); // the definition really is inlined
    // The block's ONLY serializer infidelity is that insertion, which is zero-width on the source
    // side. A strict join returns nothing here; this is the systemic half of the test above.
    expect(collateralFor([original], referenceSuffix, ablated, body)).toHaveLength(1);

    // And with the restoration on, the reference form comes back and there is nothing to consent to.
    const written = serializeNodesFaithfully([edited], referenceSuffix, body);
    expect(written).toBe(body.replace("pending", "PENDING"));
    expect(collateralFor([original], referenceSuffix, written, body)).toEqual([]);
  });
});

describe("the REQ-8 measurement harness (AC-4) — four metrics over the nine hand-written documents", () => {
  // WHY THIS IS COMMITTED. REQ-8 asks that the serializer fixed-point rate be "recorded so the
  // direction is checkable", and a sentence of prose in CHANGELOG.md cannot keep a direction
  // checkable. This is the record: four numbers measured over this repository's own documents, run
  // as a test inside the gate suite T2 already owns — not a new suite, which contracts.md C9 forbids
  // because minting one forces an edit to docs/requirements.md, the authoritative build input.
  //
  // Each metric exists to keep the one above it honest:
  //   1. Serializer fixed points — REQ-8's literal metric. Ratchets downward.
  //   2. Dishonest writes        — a quieter dialog is only an improvement if the WRITES got better.
  //   3. Guard fidelity          — a guard is only a guard if it still fires. Two configurations.
  //   4. The known blind spot    — recorded, NOT ratcheted, so metric 3's zero is never read as a
  //                                completeness claim about the guard.
  //
  // HISTORY of metric 1: 174/418 Phase 0 · 40/418 as reported post-#173 · 43/418 re-measured at
  // `d965ffb` · 40/418 after this task's code · 40/433 after its documentation and the merge of #179/#180/#181, which added four
  // blocks to `docs/decisions.md`. Compare numerators across that last step, never rates.
  //
  // T5 (#143) MUST RE-BASELINE ALL FOUR (contracts.md C9). An opaque front-matter node changes the
  // block population, so the denominator moves and every count below moves with it.
  //
  // THE GENERATOR IS PINNED HERE, AND ITS DEFINITION IS PART OF EVERY NUMBER IN METRICS 2 AND 3
  // (metric 4 carries its own fixed fixtures, precisely because no such generator can reach that
  // class): `EDITED_WORD` below — the first run of five or more lowercase letters in the block's own bytes,
  // upper-cased. It is deliberately WIDE. A narrower generator that skipped any word adjacent to `-`
  // or `.` never edited a single reference-link heading, which is the exact class where the two
  // overlap joins disagree; that narrower one is where the design's figures of 317 edits and 34
  // ablated firings come from. This one reaches all 18 reference-link blocks, `## [Unreleased]`
  // included (via `nreleased`), so it makes 375 edits and its ablated row reads 35 rather than 34.
  // The design's ratios and its residual set reproduce exactly; only the denominators differ, and
  // they differ because this generator is strictly wider. Compare like with like before concluding a
  // number moved. Metric 1 does not depend on the generator at all, which is why it reproduces the
  // design's numerator of 40 to the block.
  const documents = [
    "README.md",
    "AGENTS.md",
    "DESIGN.md",
    "CONTRIBUTING.md",
    "ROADMAP.md",
    "PRODUCT.md",
    "CHANGELOG.md",
    "docs/requirements.md",
    "docs/decisions.md",
  ];
  const EDITED_WORD = /[a-z]{5,}/;
  const root = join(import.meta.dir, "../../..");

  /** Asserted on its own, so a document gaining or losing a block is VISIBLE rather than silently
   *  shifting every ratchet below it. It did exactly that here: 418 at `d965ffb`, 422 once #174's
   *  own documentation edits landed, the four being the `docs/decisions.md` entry recording this
   *  task's route selection. A DENOMINATOR MOVE IS NOT A RESULT — every numerator below is
   *  unchanged, and that is what makes this one readable as bookkeeping rather than as drift.
   *
   *  IT WILL MOVE AGAIN, and not because of anything the serializer did. The corpus is read live
   *  from the working tree, and T1, T4 and T5 all append to `CHANGELOG.md` and `docs/decisions.md`
   *  in this same epic — so this number depends on which of them has merged, and in what order.
   *  Re-baselining it is a one-line edit; the check that makes that edit safe is that the numerators
   *  below did not move with it (per-cause map totalling 40, 3 dishonest writes, 0 missed and 0
   *  false alarms). `CORPUS_COUNT_NOTE` says the same thing on the failure itself. */
  const BLOCKS = 433;

  /** Every top-level block of the corpus, with the bytes and the reference context it was read in. */
  const corpus = () => {
    const all = [];
    for (const name of documents) {
      const source = readFileSync(join(root, name), "utf8");
      const { blocks, referenceSuffix } = blockLayout(source);
      const doc = parseMarkdown(source);
      expect(blocks.length).toBe(doc.childCount);
      for (const [index, span] of blocks.entries()) {
        const body = source.slice(span.start, span.end);
        all.push({ name, index, source, span, doc, referenceSuffix, body, node: doc.child(index) });
      }
    }
    return all;
  };

  /** Names the construct at which a re-serialization first stops matching the file. Metric 1 asserts
   *  this breakdown rather than only a total, so a red test says WHICH construct regressed. */
  const firstDifference = (was: string, now: string) => {
    let i = 0;
    while (i < was.length && i < now.length && was[i] === now[i]) i += 1;
    const source = was.slice(i);
    const written = now.slice(i);
    if (was[i - 1] === "]" && written.startsWith("(")) return "link reference definition inlined";
    if (written.startsWith("\n") && !source.startsWith("\n")) return "tight list re-emitted loose";
    if (source.startsWith("\n") && !written.startsWith("\n")) return "soft break inside a code span collapsed";
    if (was[i - 1] === "\n" && source.startsWith(" ") && !written.startsWith(" "))
      return "continuation-line indent dropped";
    if (i === 0 && source.startsWith(" ") && written.startsWith(">")) return "indented blockquote marker normalised";
    if (source.startsWith("&")) return "HTML entity decoded";
    if (i === 0 && written.startsWith("## ")) return "front matter → setext heading";
    // Deliberately returned rather than thrown: an unrecognised cause IS the regression report, and
    // it has to reach the assertion as data instead of as an exception that hides the other 39.
    return `unclassified: ${JSON.stringify(source.slice(0, 24))} → ${JSON.stringify(written.slice(0, 24))}`;
  };

  test("metric 1 — 40 of 433 blocks still cost bytes re-serialized, with no restoration", () => {
    const byCause: Record<string, number> = {};
    let blockCount = 0;
    for (const { body, node, referenceSuffix } of corpus()) {
      blockCount += 1;
      // NO SOURCE ARGUMENT, deliberately. This is REQ-8's literal metric and the only one comparable
      // across the project's history, and computing it without the restoration is precisely what
      // stops it being "improved" by making the restoration stronger rather than the serializer
      // more faithful. M1 alone: the de-escape relaxation, in the document's reference context.
      const written = serializeNodesFaithfully([node], referenceSuffix);
      if (written === body) continue;
      const cause = firstDifference(body, written);
      byCause[cause] = (byCause[cause] ?? 0) + 1;
    }
    const misses = Object.values(byCause).reduce((total, n) => total + n, 0);

    expect(
      blockCount,
      countNote("the corpus block total. It is the DENOMINATOR; `misses` and `byCause` are the numerators."),
    ).toBe(BLOCKS);
    // REQ-8's direction, stated as its own assertion. It survives a future author deciding the
    // per-cause record below is too brittle and relaxing it.
    expect(misses).toBeLessThanOrEqual(40);
    // And the record beside it. These are the design's own 43 causes measured at `d965ffb`, minus
    // the 3 bracket/backslash-escaping blocks M1 removed — which is the whole of 43 → 40. A genuine
    // improvement turns this red; lower the numbers deliberately rather than loosening the shape.
    expect(
      byCause,
      countNote(
        "the per-cause record, a NUMERATOR totalling 40. A move here is not bookkeeping: either the serializer changed, or a document gained a block that is itself lossy. Establish which before touching these numbers.",
      ),
    ).toEqual({
      "link reference definition inlined": 18,
      "continuation-line indent dropped": 6,
      "soft break inside a code span collapsed": 5,
      "indented blockquote marker normalised": 5,
      "tight list re-emitted loose": 4,
      "HTML entity decoded": 1,
      "front matter → setext heading": 1, // #143's, not this task's
    });
  });

  test("metrics 2 and 3 — 3 dishonest writes of 385; the guard fires on those 3 and, ablated, on 35", () => {
    // METRIC 2 is the ground truth — "the save wrote more than the writer's word" — and METRIC 3 is
    // the guard's verdict checked against it, in TWO configurations. The second is the ratchet: with
    // the restoration off the writes really are dishonest, 35 of them, and the guard must catch
    // every one. A re-run of the first design of this guard, which routed `faithful` through the
    // restoration, scores 0 fired and 35 missed here. The ablation is an OMITTED ARGUMENT — the
    // wrapper called without source bytes is M1 only, exactly what the pure-insertion path does —
    // never a flag, and no flag exists to set.
    //
    // A NON-ZERO `missed` IS NOT A NUMBER TO RECORD. It means the guard is unsound. The likeliest
    // cause by far is the overlap join: with `<` in place of `<=` the ablated row scores 17 fired
    // and 18 missed, those 18 being CHANGELOG.md's reference-link headings, whose only infidelity is
    // a pure insertion and therefore zero-width on the source side.
    //
    // ZERO MISSED IS A PROPERTY OF THIS EDIT DISTRIBUTION, NOT A COMPLETENESS PROOF ABOUT THE GUARD.
    // Stated as the design states it: the guard detects serializer infidelity carried from the
    // block's ORIGINAL bytes, and is blind — as today's guard is — to infidelity in content the
    // writer freshly typed. `D` is built from the original nodes, so freshly typed markup is outside
    // its reach, and a `word` → `WORD` generator can never surface that class. Metric 4 below
    // records it as its own figure so this zero cannot be read as covering it.
    const tally = { edits: 0, shipped: { dishonest: 0, fired: 0 }, ablated: { dishonest: 0, fired: 0 } };
    const missed: string[] = [];
    const falseAlarms: string[] = [];
    const residual: string[] = [];

    for (const { name, index, source, span, doc, referenceSuffix, body, node } of corpus()) {
      const word = EDITED_WORD.exec(body);
      if (!word) continue;
      const [found] = word;
      const editedBody = body.slice(0, word.index) + found.toUpperCase() + body.slice(word.index + found.length);
      // Reparsed as part of the whole document, so the edited node is read in the same context the
      // save would read it in rather than in an isolation that can mean something else.
      const editedDoc = parseMarkdown(source.slice(0, span.start) + editedBody + source.slice(span.end));
      expect(editedDoc.childCount).toBe(doc.childCount); // the generator never restructures
      const edited = [editedDoc.child(index)];
      tally.edits += 1;

      for (const [configuration, written] of [
        ["shipped", serializeNodesFaithfully(edited, referenceSuffix, body)],
        ["ablated", serializeNodesFaithfully(edited, referenceSuffix)],
      ] as const) {
        // Ground truth: an honest save writes the source with exactly the writer's word changed.
        const dishonest = written !== editedBody;
        const fired = collateralFor([node], referenceSuffix, written, body).length > 0;
        const row = tally[configuration];
        if (dishonest) row.dishonest += 1;
        if (fired) row.fired += 1;
        if (dishonest && !fired) missed.push(`${configuration} ${name} block ${index}`);
        if (!dishonest && fired) falseAlarms.push(`${configuration} ${name} block ${index}`);
        if (dishonest && configuration === "shipped") residual.push(`${name} block ${index}`);
      }
    }

    // Printed rather than counted, because a regression here is a list of places, not a number.
    expect(missed).toEqual([]);
    expect(falseAlarms).toEqual([]);
    // The three the restoration cannot reach: DESIGN.md's front matter is T5's (REQ-11), the
    // requirements block is the blank-line-before-a-fence case (the AMD-2b follow-up), and README's
    // is a `&nbsp;·&nbsp;` pair that restores per-character rather than per run.
    expect(
      residual,
      countNote(
        "which blocks the restoration cannot reach, named by POSITION in a live document. A block inserted above one of these shifts its index without changing which block it is, so compare the file names and the causes before reading a change here as a regression.",
      ),
    ).toEqual(["README.md block 6", "DESIGN.md block 1", "docs/requirements.md block 30"]);
    expect(
      tally,
      countNote(
        "`edits` is a DENOMINATOR — how many synthetic edits the generator produced over the live corpus — and it moves with the documents exactly as BLOCKS does. `dishonest` and `fired` are the numerators: they must stay 3/3 shipped and 35/35 ablated whatever `edits` becomes.",
      ),
    ).toEqual({
      edits: 385,
      shipped: { dishonest: 3, fired: 3 },
      ablated: { dishonest: 35, fired: 35 },
    });
  });

  test("metric 4 — the blind spot: 3 writes that are dishonest and silent, recorded, NOT ratcheted", () => {
    // THIS METRIC IS A BOUNDARY, NOT A TARGET, and it is here so metric 3's `missed: 0` is never
    // read as completeness. Every case below is markup the writer FRESHLY TYPED: `D` is built from
    // the block's original nodes, so it is empty at that region and the guard cannot fire under any
    // join. NONE OF THE THREE IS A REGRESSION — `D` empty is equivalent to `faithful === replaced`,
    // so the guard this task replaced is exactly as silent on all three, and #174 makes none worse.
    // Fixing them is not in this issue's scope, which asks about editing blocks that CONTAIN these
    // constructs. Improving a row here is welcome and means editing this record, not relaxing it.
    const typed = [
      {
        what: "a reference label the document defines",
        source: "Alpha here.\n\n[home]: https://example.com/a/very/long/target/path\n",
        edited: "Alpha [home] here.\n\n[home]: https://example.com/a/very/long/target/path\n",
        // REQ-3's own defect, from the other side: the label resolves, so the serializer writes the
        // inline form the writer did not type.
        writes:
          "Alpha [home](https://example.com/a/very/long/target/path) here.\n\n[home]: https://example.com/a/very/long/target/path\n",
      },
      {
        what: "an entity",
        source: "Alpha here.\n",
        edited: "Alpha &amp; here.\n",
        writes: "Alpha & here.\n", // REQ-2's own defect: the entity is decoded on the way out.
      },
      {
        what: "a bracket beside a load-bearing escape",
        source: "Alpha \\*lit\\* here.\n",
        edited: "Alpha \\*lit\\* [note] here.\n",
        // M1 is all-or-nothing over a run, so the one escape the block genuinely needs keeps them
        // all, and the freshly typed bracket is escaped with them.
        writes: "Alpha \\*lit\\* \\[note\\] here.\n",
      },
    ];

    const silent: string[] = [];
    for (const { what, source, edited, writes } of typed) {
      const result = save(source, edited);
      expect(result.markdown).toBe(writes); // what the file actually receives
      expect(result.markdown).not.toBe(edited); // ...which is not what the writer typed
      expect(result.degraded).toBe(false);
      if (result.collateral.length === 0) silent.push(what);
    }
    expect(silent).toEqual([
      "a reference label the document defines",
      "an entity",
      "a bracket beside a load-bearing escape",
    ]);
  });
});

describe("the per-node-type opt-out — nothing outside the modelled inventory is ever rewritten", () => {
  // contracts.md C1.2, and the one part of #174 whose failure mode lands on somebody else. T5 (#143)
  // gives front matter an OPAQUE node whose serialization IS its literal source bytes; a de-escape
  // or an entity re-encoding over those bytes corrupts them. Nothing in this task's own wave can
  // produce such a node, so an implementation that whitelists nothing and rewrites the whole
  // serialized string unconditionally passes every OTHER test in this file and is still a contract
  // violation. That is why this cannot wait for T5: by the time a raw node exists to exercise it,
  // the wrapper it has to survive has already shipped.
  //
  // T5's node genuinely cannot be built here — `serializeNodes()` composes its doc from the
  // CommonMark schema, which refuses a foreign type outright ("Invalid content for node doc"), and
  // the serializer has no handler for one either. So the stand-in sits where the CommonMark
  // serializer will not DISPATCH on it: `code_block`'s handler reads `node.textContent` and never
  // renders its children by type. The run therefore serializes normally while carrying a type name
  // the inventory does not have, which is the property under test.
  const opaqueSchema = new Schema({
    nodes: { doc: { content: "block+" }, text: { group: "inline" }, glosa_raw: { group: "block", content: "text*" } },
    marks: { glosa_verbatim: {} },
  });
  const opaqueNode = opaqueSchema.node("glosa_raw", null, opaqueSchema.text("verbatim"));
  const bracketed = markdownSchema.node("paragraph", null, markdownSchema.text("See [r] here."));
  const opaqueBlock = markdownSchema.nodes.code_block.create(null, opaqueNode);
  /** What the serializer alone writes for `[bracketed, opaqueBlock]` — brackets escaped, as it
   * escapes them everywhere. Every assertion below is against these exact bytes. */
  const RAW = "See \\[r\\] here.\n\n```\nverbatim\n```";

  test("a run carrying a node type the schema does not have is written raw, byte for byte", () => {
    // The literal contract: no de-escaping, no restoration, no reparse — the serializer's own bytes.
    // Stated as an assertion about the WRAPPER because that is the call the splice makes; note that
    // the absolute predicate inside it refuses this run too (it compares against nodes the parser
    // could never build), so this pins the behavior rather than isolating the opt-out. The
    // whole-document case below is where the opt-out is the only thing holding the line.
    expect(serializeNodesFaithfully([bracketed, opaqueBlock], "", RAW)).toBe(RAW);
    expect(serializeNodesFaithfully([bracketed, opaqueBlock], "")).toBe(RAW);
  });

  test("a whole document containing one is written raw too — here the opt-out IS the only guard", () => {
    // `serializeMarkdown`'s baseline is RELATIVE: what the serializer's own output parses to. That
    // baseline is closed under the CommonMark schema whatever the document holds, so both sides of
    // the comparison agree and the relaxation is ACCEPTED over the opaque block's verbatim bytes.
    // Remove the opt-out and this document is written `See [r] here.` — the escapes dropped from a
    // run that was never vouched for. This is the assertion that fails under an unconditional
    // rewrite, and it is the reason the opt-out sits on this path as well as on the wrapper.
    expect(serializeMarkdown(markdownSchema.node("doc", null, [bracketed, opaqueBlock]))).toBe(RAW);
    // The control that keeps the assertion above honest: the very same paragraph, in a document the
    // inventory covers, IS relaxed. So the opt-out is what stopped it, not a serializer that never
    // escaped anything in the first place.
    expect(serializeMarkdown(markdownSchema.node("doc", null, [bracketed]))).toBe("See [r] here.");
  });

  test("an unmodelled node is refused at any depth, and a modelled document is not", () => {
    expect(runIsModelled([bracketed])).toBe(true);
    expect(runIsModelled([opaqueBlock])).toBe(false);
    // Buried two levels down rather than at the top: the walk has to reach it, because
    // `serializeNodes()` renders the whole subtree and its bytes reach the string being rewritten.
    const buried = markdownSchema.node(
      "blockquote",
      null,
      markdownSchema.node("bullet_list", null, markdownSchema.node("list_item", null, opaqueBlock)),
    );
    expect(runIsModelled([buried])).toBe(false);
    // Deny by default: nothing here recognises `glosa_raw`, and that is the whole answer. Adding a
    // node type to a schema later must not opt it in behind anybody's back.
    expect(MODELLED_NODE_TYPES).not.toContain("glosa_raw");
  });

  test("a mark type outside the inventory is refused too, at any depth", () => {
    // `descendants` walks NODES. A walk that stops there looks correct and checks half the
    // inventory — this is the assertion that fails if the marks are never asked about.
    const struck = markdownSchema.text("struck", [opaqueSchema.marks.glosa_verbatim.create()]);
    const deep = markdownSchema.node(
      "blockquote",
      null,
      markdownSchema.node(
        "bullet_list",
        null,
        markdownSchema.node("list_item", null, markdownSchema.node("paragraph", null, struck)),
      ),
    );
    expect(runIsModelled([deep])).toBe(false);
    // The same shape carrying a mark the inventory DOES have is fine, so it is the mark type that
    // decided it and not the nesting.
    const emphasised = markdownSchema.text("struck", [markdownSchema.marks.em.create()]);
    const ordinary = markdownSchema.node(
      "blockquote",
      null,
      markdownSchema.node(
        "bullet_list",
        null,
        markdownSchema.node("list_item", null, markdownSchema.node("paragraph", null, emphasised)),
      ),
    );
    expect(runIsModelled([ordinary])).toBe(true);
  });

  test("the inventory is the CommonMark schema's own, in both directions", () => {
    // Held against `markdownSchema` — the VENDORED CommonMark schema, which does not move — rather
    // than against whatever schema `serializeNodes()` builds its doc from, because T5 replaces that
    // with a derived one. A name the schema has and the list lacks would drop ordinary documents
    // onto the raw path silently; a name in the list the schema does not have is dead weight that
    // would tell T5's reader the wrong thing. Neither is visible from any other test here.
    expect([...MODELLED_NODE_TYPES].sort()).toEqual(Object.keys(markdownSchema.nodes).sort());
    expect([...MODELLED_MARK_TYPES].sort()).toEqual(Object.keys(markdownSchema.marks).sort());
  });
});

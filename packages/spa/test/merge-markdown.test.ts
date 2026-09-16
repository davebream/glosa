// SPDX-License-Identifier: Apache-2.0
// @glosa/spa — the pure three-way merge behind Keep mine (#182). Table-driven, exact-byte tests:
// every case asserts the FULL written text, not just presence/absence of a substring, because a
// merge that gets the right words in the wrong place is exactly the failure mode R3 exists to
// catch. Every case is evaluated and asserted together (`results.map(...)` then one `expect`),
// per L-issue-140-3/the lesson on loop-of-expect: a single early failure must not hide the rest.
import { describe, expect, test } from "bun:test";
import { threeWayMerge } from "../src/merge-markdown.js";
import { spliceMarkdown, parseMarkdown } from "../src/rich-editor.js";

const NO_REPORT = { collateral: [], degraded: false };

describe("threeWayMerge — table-driven, exact bytes", () => {
  const cases = [
    {
      name: "1: writer edits A, disk edits B — both survive",
      base: "# Title\n\nParagraph A original.\n\nParagraph B original.\n",
      mine: "# Title\n\nParagraph A EDITED BY WRITER.\n\nParagraph B original.\n",
      theirs: "# Title\n\nParagraph A original.\n\nParagraph B changed on disk.\n",
      text: "# Title\n\nParagraph A EDITED BY WRITER.\n\nParagraph B changed on disk.\n",
      conflicts: 0,
    },
    {
      name: "2: disk inserts paragraph C",
      base: "# Title\n\nParagraph A original.\n\nParagraph B original.\n",
      mine: "# Title\n\nParagraph A EDITED BY WRITER.\n\nParagraph B original.\n",
      theirs: "# Title\n\nParagraph A original.\n\nParagraph B original.\n\nParagraph C new.\n",
      text: "# Title\n\nParagraph A EDITED BY WRITER.\n\nParagraph B original.\n\nParagraph C new.\n",
      conflicts: 0,
    },
    {
      name: "3: disk deletes B",
      base: "# Title\n\nParagraph A original.\n\nParagraph B original.\n",
      mine: "# Title\n\nParagraph A EDITED BY WRITER.\n\nParagraph B original.\n",
      theirs: "# Title\n\nParagraph A original.\n",
      text: "# Title\n\nParagraph A EDITED BY WRITER.\n",
      conflicts: 0,
    },
    {
      name: "4: disk changes a --- header value",
      base: "---\nstatus: draft\n---\n\nBody paragraph original.\n",
      mine: "---\nstatus: draft\n---\n\nBody paragraph EDITED.\n",
      theirs: "---\nstatus: final\n---\n\nBody paragraph original.\n",
      text: "---\nstatus: final\n---\n\nBody paragraph EDITED.\n",
      conflicts: 0,
    },
    {
      name: "5: disk edits an own-line %% comment",
      base: "Paragraph one.\n\n%%\nold note\n%%\n\nParagraph two.\n",
      mine: "Paragraph one EDITED.\n\n%%\nold note\n%%\n\nParagraph two.\n",
      theirs: "Paragraph one.\n\n%%\nnew note\n%%\n\nParagraph two.\n",
      text: "Paragraph one EDITED.\n\n%%\nnew note\n%%\n\nParagraph two.\n",
      conflicts: 0,
    },
    {
      name: "6: both edit A differently — conflict, mine wins",
      base: "# Title\n\nParagraph A original.\n\nParagraph B.\n",
      mine: "# Title\n\nParagraph A MINE.\n\nParagraph B.\n",
      theirs: "# Title\n\nParagraph A THEIRS.\n\nParagraph B.\n",
      text: "# Title\n\nParagraph A MINE.\n\nParagraph B.\n",
      conflicts: 1,
    },
    {
      name: "7: both make the same edit — no conflict",
      base: "# Title\n\nParagraph A original.\n\nParagraph B.\n",
      mine: "# Title\n\nParagraph A SAME EDIT.\n\nParagraph B.\n",
      theirs: "# Title\n\nParagraph A SAME EDIT.\n\nParagraph B.\n",
      text: "# Title\n\nParagraph A SAME EDIT.\n\nParagraph B.\n",
      conflicts: 0,
    },
    {
      name: "8: both insert at the same position — conflict",
      base: "# Title\n\nParagraph A.\n",
      mine: "# Title\n\nParagraph A.\n\nMine's new paragraph.\n",
      theirs: "# Title\n\nParagraph A.\n\nTheirs' new paragraph.\n",
      text: "# Title\n\nParagraph A.\n\nMine's new paragraph.\n",
      conflicts: 1,
    },
    {
      name: "9: unprovable identity — conflict",
      base: "# Title\n\nSame text.\n\nSame text.\n",
      mine: "# Title\n\nSame text.\n\nSame text EDITED.\n",
      theirs: "# Title\n\nSame text EDITED ON DISK.\n\nSame text.\n",
      text: "# Title\n\nSame text.\n\nSame text EDITED.\n",
      conflicts: null, // base unavailable path: unprovable identity refuses the whole merge.
    },
  ];

  test("every table case, evaluated and asserted together", () => {
    const results = cases.map((c) => ({ name: c.name, expected: c, actual: threeWayMerge(c.base, c.mine, c.theirs) }));
    for (const { name, expected, actual } of results) {
      expect([name, actual.text]).toEqual([name, expected.text]);
      if (expected.conflicts !== null) expect([name, actual.conflicts.length]).toEqual([name, expected.conflicts]);
      expect([name, actual.baseAvailable]).toEqual([name, expected.conflicts === null ? false : true]);
    }
  });

  test("10: missing base — every differing block conflicts, mine wins, nothing of theirs merged silently", () => {
    const mine = "# Title\n\nParagraph A MINE.\n\nParagraph B.\n";
    const theirs = "# Title\n\nParagraph A THEIRS.\n\nParagraph B changed on disk too.\n";
    const result = threeWayMerge(null, mine, theirs);
    expect(result.text).toBe(mine);
    expect(result.baseAvailable).toBe(false);
    expect(result.conflicts.length).toBeGreaterThan(0);
    expect(result.merged).toEqual([]);
  });

  test("F-9: missing base reports ONE conflict per differing block, by exact identity — not one whole-document conflict", () => {
    const mine = "# Title\n\nParagraph A MINE.\n\nParagraph B MINE.\n";
    const theirs = "# Title\n\nParagraph A THEIRS.\n\nParagraph B THEIRS.\n";
    const result = threeWayMerge(null, mine, theirs);
    expect(result.text).toBe(mine);
    expect(result.baseAvailable).toBe(false);
    // The heading is identical on both sides and must NOT appear as a conflict — D3 conflicts
    // every DIFFERING block, not every block in the document.
    expect(result.conflicts).toEqual([
      { index: 1, mine: "Paragraph A MINE.", theirs: "Paragraph A THEIRS." },
      { index: 2, mine: "Paragraph B MINE.", theirs: "Paragraph B THEIRS." },
    ]);
  });

  test("F-9: missing base with a block only one side has still conflicts positionally, by index", () => {
    const mine = "Paragraph A MINE.\n\nParagraph B MINE.\n";
    const theirs = "Paragraph A MINE.\n\nParagraph B THEIRS.\n\nParagraph C only on disk.\n";
    const result = threeWayMerge(null, mine, theirs);
    expect(result.text).toBe(mine);
    // Restated in review round 6: the per-block identities are unchanged, and are now asserted
    // apart from the source regions between and around the blocks, which the same path also
    // reports (a differing region can hold real Markdown, so discarding it silently is the loss
    // this criterion forbids). Filtering by `region` keeps each claim separate instead of
    // widening one list until it stops saying anything.
    expect(result.conflicts.filter((conflict) => !(conflict as { region?: string }).region)).toEqual([
      { index: 1, mine: "Paragraph B MINE.", theirs: "Paragraph B THEIRS." },
      { index: 2, mine: null, theirs: "Paragraph C only on disk." },
    ]);
    expect(
      result.conflicts
        .filter((conflict) => (conflict as { region?: string }).region)
        .map((conflict) => (conflict as { region?: string }).region),
    ).toEqual(["separator", "trailing"]);
  });

  test("a sha-mismatched base is refused as a base — same path as missing (D3)", () => {
    // The pane's job is verifying sha256(base) === baselineSha and passing null on mismatch; this
    // pins that threeWayMerge(null, ...) is exactly the refusal path a caller falls back to.
    const mine = "Mine's paragraph.\n";
    const theirs = "Disk's paragraph.\n";
    const viaNull = threeWayMerge(null, mine, theirs);
    expect(viaNull.baseAvailable).toBe(false);
    expect(viaNull.text).toBe(mine);
  });
});

describe("threeWayMerge — R2 byte-aware classification (non-canonical spelling survives)", () => {
  const cases = [
    {
      name: "alternate list marker (mine, source face) beside an unrelated disk edit",
      base: "# Title\n\n- item one\n- item two\n\nParagraph B.\n",
      mine: "# Title\n\n* item one\n* item two\n\nParagraph B.\n",
      theirs: "# Title\n\n- item one\n- item two\n\nParagraph B changed on disk.\n",
      text: "# Title\n\n* item one\n* item two\n\nParagraph B changed on disk.\n",
    },
    {
      name: "emphasis spelling (mine, source face) beside an unrelated disk edit",
      base: "# Title\n\nSome *emphasis* text.\n\nParagraph B.\n",
      mine: "# Title\n\nSome _emphasis_ text.\n\nParagraph B.\n",
      theirs: "# Title\n\nSome *emphasis* text.\n\nParagraph B changed on disk.\n",
      text: "# Title\n\nSome _emphasis_ text.\n\nParagraph B changed on disk.\n",
    },
    {
      // F-7, restated in review round 4: mine's edited block keeps its own bytes exactly (the merge
      // never touches a block's content). The document's trailing region is a separate region, and
      // it is classified base-relatively like any other: MINE left it as base had it (CRLF) while
      // THEIRS converted the whole file to LF, so that region is a theirs-only change and theirs'
      // bytes win there. The earlier expectation gave the trailing bytes to whichever side owned
      // the last block, which is what let a side that never touched a region overwrite one that
      // did — the loss this criterion exists to prevent, in the other direction.
      name: "mixed line endings inside mine's untouched block, beside an unrelated disk edit",
      base: "# Title\r\n\r\nParagraph A.\r\n\r\nParagraph B.\r\n",
      mine: "# Title\r\n\r\nParagraph A.\r\n\r\nParagraph B EDITED.\r\n",
      theirs: "# Title\n\nParagraph A changed on disk.\n\nParagraph B.\n",
      text: "# Title\n\nParagraph A changed on disk.\n\nParagraph B EDITED.\n",
    },
    {
      // F-7: the BETWEEN-block bytes are a region too, classified exactly like a block — a
      // mine-only blank-line change (typed in the source face) survives beside an unrelated,
      // genuinely disk-only block edit, rather than every gap collapsing to a literal "\n\n".
      name: "a mine-only blank-line change survives beside an unrelated disk edit",
      base: "Paragraph A.\n\nParagraph B.\n",
      mine: "Paragraph A.\n\n\nParagraph B.\n",
      theirs: "Paragraph A changed on disk.\n\nParagraph B.\n",
      text: "Paragraph A changed on disk.\n\n\nParagraph B.\n",
    },
    {
      // F-7: a link reference definition produces no block token at all (markdown-it swallows it
      // into the gap between the blocks around it), so a mine-only reference definition — added
      // in the source face — has to be preserved as inter-block bytes, not discarded as if it
      // were merely the literal separator.
      name: "a mine-only reference definition survives beside an unrelated disk edit",
      base: "See [home] there.\n\n[home]: https://example.com/a\n\nParagraph B.\n",
      mine: "See [home] there.\n\n[home]: https://example.com/a\n[extra]: https://example.com/b\n\nParagraph B.\n",
      theirs: "See [home] there.\n\n[home]: https://example.com/a\n\nParagraph B changed on disk.\n",
      text: "See [home] there.\n\n[home]: https://example.com/a\n[extra]: https://example.com/b\n\nParagraph B changed on disk.\n",
    },
  ];

  test("every R2 case, evaluated and asserted together", () => {
    const results = cases.map((c) => ({
      name: c.name,
      expected: c.text,
      actual: threeWayMerge(c.base, c.mine, c.theirs),
    }));
    for (const { name, expected, actual } of results) expect([name, actual.text]).toEqual([name, expected]);
  });
});

describe("threeWayMerge — R3 base-indexed identity (delete+edit, move+edit)", () => {
  test("theirs deletes a block mine edited — conflict, mine's edit is kept at mine's anchored position", () => {
    const base = "# Title\n\nParagraph A.\n\nParagraph B.\n";
    const mine = "# Title\n\nParagraph A.\n\nParagraph B EDITED.\n";
    const theirs = "# Title\n\nParagraph A.\n";
    const result = threeWayMerge(base, mine, theirs);
    expect(result.text).toBe("# Title\n\nParagraph A.\n\nParagraph B EDITED.\n");
    expect(result.conflicts.length).toBe(1);
    expect(result.conflicts[0]?.theirs).toBeNull();
  });

  test("F-6: an asymmetric multi-member run — mine changes A alone while theirs replaces the wider run A+B — B still survives, unowned by either side's group", () => {
    const base = "# Title\n\nParagraph A.\n\nParagraph B.\n\nParagraph C.\n";
    const mine = "# Title\n\nParagraph A EDITED.\n\nParagraph B.\n\nParagraph C.\n";
    // theirs restructures A and B into one new paragraph — neither base block has a tree-equal
    // counterpart on theirs' side, so theirs' OWN run spans both, wider than mine's (mine only
    // touched A; B is untouched-by-mine, "kept" in mine's own alignment).
    const theirs = "# Title\n\nA and B merged into one paragraph on disk.\n\nParagraph C.\n";
    const result = threeWayMerge(base, mine, theirs);
    // The bug this pins: independently-iterated per-side groupings would mark theirs' A+B run
    // "already emitted" at A (where mine's conflict already won), then silently suppress B at
    // its own index — B must survive as mine's own, untouched-by-mine, unchanged content.
    expect(result.text).toBe("# Title\n\nParagraph A EDITED.\n\nParagraph B.\n\nParagraph C.\n");
    expect(result.conflicts).toEqual([
      { index: 1, mine: "Paragraph A EDITED.\n\nParagraph B.", theirs: "A and B merged into one paragraph on disk." },
    ]);
  });

  test("mine deletes a block theirs edited — conflict, mine's deletion stands", () => {
    const base = "# Title\n\nParagraph A.\n\nParagraph B.\n";
    const mine = "# Title\n\nParagraph A.\n";
    const theirs = "# Title\n\nParagraph A.\n\nParagraph B changed on disk.\n";
    const result = threeWayMerge(base, mine, theirs);
    expect(result.text).toBe("# Title\n\nParagraph A.\n");
    expect(result.conflicts.length).toBe(1);
  });

  test(
    "F-6: a proven theirs move + mine edit — mine's edited block lands at theirs' MOVED position, " +
      "not its base position",
    () => {
      const base = "# Title\n\nParagraph A.\n\nParagraph B.\n\nParagraph C.\n";
      const mine = "# Title\n\nParagraph A.\n\nParagraph B EDITED.\n\nParagraph C.\n";
      // theirs reorders C before A; no content changes, a pure move.
      const theirs = "# Title\n\nParagraph C.\n\nParagraph A.\n\nParagraph B.\n";
      const result = threeWayMerge(base, mine, theirs);
      // Content correctness: mine's edit to B and theirs' (identical) C and A all appear once —
      // nothing duplicated, nothing dropped.
      expect(result.text).toContain("Paragraph B EDITED.");
      expect(result.text.match(/Paragraph C\./g)?.length).toBe(1);
      expect(result.text.match(/Paragraph A\./g)?.length).toBe(1);
      // R3: assembly follows THEIRS' order, so C's proven move to the front carries through, and
      // mine's edit to B stays exactly where theirs still has B (right after A).
      expect(result.text).toBe("# Title\n\nParagraph C.\n\nParagraph A.\n\nParagraph B EDITED.\n");
    },
  );
});

describe("threeWayMerge — F-7: sole-block deletion does not leave the deleted side's framing behind", () => {
  test("theirs deletes the only block, mine never touched it — deletion honored, output is empty (not theirs' leftover framing)", () => {
    const base = "Only paragraph.\n";
    const mine = "Only paragraph.\n";
    const theirs = "";
    const result = threeWayMerge(base, mine, theirs);
    expect(result.text).toBe("");
  });

  test("theirs deletes the only block, mine edited it — conflict, mine wins outright, with MINE's own framing (not theirs' now-empty one)", () => {
    const base = "Only paragraph.\n";
    const mine = "Only paragraph EDITED.\n";
    const theirs = "";
    const result = threeWayMerge(base, mine, theirs);
    expect(result.text).toBe("Only paragraph EDITED.\n");
    expect(result.conflicts).toEqual([{ index: 0, mine: "Only paragraph EDITED.", theirs: null }]);
  });

  test("both sides delete the only block — output is empty", () => {
    const base = "Only paragraph.\n";
    const result = threeWayMerge(base, "", "");
    expect(result.text).toBe("");
  });

  test("mine deletes the only block, theirs edited it — conflict, mine's deletion stands, output is empty", () => {
    const base = "Only paragraph.\n";
    const mine = "";
    const theirs = "Only paragraph changed on disk.\n";
    const result = threeWayMerge(base, mine, theirs);
    expect(result.text).toBe("");
  });
});

describe("threeWayMerge — R4 collateral pass-through (#186 consent survives the merge)", () => {
  test("mine's own splice report rides through the merge result untouched", () => {
    const base = "# Title\n\nParagraph A.\n\nParagraph B.\n";
    const mine = "# Title\n\nParagraph A EDITED.\n\nParagraph B.\n";
    const theirs = "# Title\n\nParagraph A.\n\nParagraph B changed.\n";
    const report = { collateral: [{ original: "x", faithful: "y", written: "y" }], degraded: false };
    const result = threeWayMerge(base, mine, theirs, report);
    expect(result.collateral).toBe(report.collateral);
    expect(result.degraded).toBe(false);
  });

  test("ablation: dropping the report (calling without it) loses the collateral consent signal", () => {
    const base = "# Title\n\nParagraph A.\n\nParagraph B.\n";
    const mine = "# Title\n\nParagraph A EDITED.\n\nParagraph B.\n";
    const theirs = "# Title\n\nParagraph A.\n\nParagraph B changed.\n";
    const report = { collateral: [{ original: "x", faithful: "y", written: "y" }], degraded: false };
    const withReport = threeWayMerge(base, mine, theirs, report);
    const withoutReport = threeWayMerge(base, mine, theirs);
    expect(withReport.collateral.length).toBeGreaterThan(0);
    expect(withoutReport.collateral.length).toBe(0);
  });
});

describe("threeWayMerge — ablation: today's rebaseOnto loses the disk-only change (#182's own regression)", () => {
  test("case 1 (writer edits A, disk edits B) survives under the three-way merge but not under rebaseOnto", () => {
    const base = "# Title\n\nParagraph A original.\n\nParagraph B original.\n";
    const mine = "# Title\n\nParagraph A EDITED BY WRITER.\n\nParagraph B original.\n";
    const theirs = "# Title\n\nParagraph A original.\n\nParagraph B changed on disk.\n";

    const merged = threeWayMerge(base, mine, theirs);
    expect(merged.text).toContain("Paragraph B changed on disk.");

    // #181's shape: treat `theirs` as the "original" and the writer's live doc as the "edited"
    // one — this is exactly what `rebaseOnto` does, and exactly what #182 reports losing.
    const rebased = spliceMarkdown(theirs, parseMarkdown(theirs), parseMarkdown(mine));
    expect(rebased.markdown).not.toContain("Paragraph B changed on disk.");
    expect(rebased.markdown).toBe(mine);
  });
});

describe("threeWayMerge — review round 2: separators and duplicates the assembler must not lose", () => {
  test("F-7: a boundary next to an insertion cannot be attributed, so a non-plain separator is reported rather than normalized", () => {
    // Mine widens the gap after A to two blank lines; theirs inserts a block further down, which
    // is what makes the boundary unattributable. The merge may fall back to the plain separator,
    // but it must SAY so — silently normalizing mine's bytes is the loss R2 forbids.
    const base = "# Title\n\nParagraph A.\n\nParagraph B.\n";
    const mine = "# Title\n\nParagraph A.\n\n\nParagraph B.\n";
    const theirs = "# Title\n\nParagraph A.\n\nParagraph B.\n\nParagraph C added on disk.\n";

    const merged = threeWayMerge(base, mine, theirs);
    const isSeparator = (entry: unknown) => (entry as { region?: string }).region === "separator";
    const separatorConflicts = merged.conflicts.filter(isSeparator);
    expect({
      keptTheirsInsertion: merged.text.includes("Paragraph C added on disk."),
      reportedSeparator: separatorConflicts.length > 0,
      silentlyNormalized: !merged.text.includes("Paragraph A.\n\n\n") && separatorConflicts.length === 0,
    }).toEqual({ keptTheirsInsertion: true, reportedSeparator: true, silentlyNormalized: false });
  });

  test("F-7: a document whose separators are all plain blank lines reports no separator conflict", () => {
    const base = "# Title\n\nParagraph A.\n\nParagraph B.\n";
    const mine = "# Title\n\nParagraph A EDITED.\n\nParagraph B.\n";
    const theirs = "# Title\n\nParagraph A.\n\nParagraph B.\n\nParagraph C added on disk.\n";

    const merged = threeWayMerge(base, mine, theirs);
    expect(merged.conflicts.filter((entry) => (entry as { region?: string }).region === "separator")).toEqual([]);
  });

  test("F-6: a duplicated block that theirs moves keeps one copy per occurrence, none invented or dropped", () => {
    // Two byte-identical blocks make structural identity ambiguous; theirs moves the tail block
    // above them. Whatever the assembler decides, the merged document must still contain exactly
    // two copies of the duplicate and one of every other block.
    const base = "# Title\n\nSame line.\n\nSame line.\n\nTail block.\n";
    const mine = "# Title\n\nSame line.\n\nSame line.\n\nTail block EDITED BY WRITER.\n";
    const theirs = "# Title\n\nTail block.\n\nSame line.\n\nSame line.\n";

    const merged = threeWayMerge(base, mine, theirs);
    // Exact bytes, not a set of properties: an assembler that kept the writer's edit but ignored
    // the disk-side move would still have two duplicates and one title, and would still pass a
    // count-shaped assertion. The moved position is the thing under test, so the whole document
    // is pinned — theirs' order, carrying mine's edit at the block theirs moved.
    expect(merged.text).toBe("# Title\n\nTail block EDITED BY WRITER.\n\nSame line.\n\nSame line.\n");
    expect(merged.conflicts).toEqual([]);
  });
});

describe("threeWayMerge — review round 3: document-edge framing is reported when it cannot be carried", () => {
  test("F-7: mine's leading blank line survives beside a disk-only edit to the block that follows it", () => {
    // Mine changes only the framing before the first block; theirs rewrites that block. These are
    // independently mergeable changes to two different regions, so BOTH survive: theirs' block
    // text and mine's leading bytes. Restated in review round 4 — an earlier revision let the
    // block's winner carry the framing and merely reported mine's loss, which R2 does not allow
    // when the two changes do not actually collide.
    const base = "# Title\n\nParagraph A.\n";
    const mine = "\n# Title\n\nParagraph A.\n";
    const theirs = "# Title\n\nParagraph A changed on disk.\n";

    const merged = threeWayMerge(base, mine, theirs);
    expect(merged.text).toBe("\n# Title\n\nParagraph A changed on disk.\n");
    expect(merged.conflicts).toEqual([]);
  });

  test("F-7: framing neither side changed is carried unchanged, with nothing reported", () => {
    const base = "# Title\n\nParagraph A.\n";
    const mine = "# Title\n\nParagraph A, edited by the writer.\n";
    const theirs = "# Title\n\nParagraph A.\n\nParagraph B added on disk.\n";

    const merged = threeWayMerge(base, mine, theirs);
    expect(
      merged.conflicts.filter((entry) => ["leading", "trailing"].includes((entry as { region?: string }).region ?? "")),
    ).toEqual([]);
  });
});

describe("threeWayMerge — review round 5: a total deletion still reports the edge bytes it cannot carry", () => {
  test("mine deletes every block while theirs changed the leading edge — empty output, and the loss is reported", () => {
    const merged = threeWayMerge("Only.\n", "", "\nOnly.\n");
    expect(merged.text).toBe("");
    // Compared as JSON so the assertion pins the exact entry without depending on how TypeScript
    // infers the union of conflict shapes this JavaScript module can return.
    expect(merged.conflicts.map((conflict) => JSON.stringify(conflict))).toEqual([
      JSON.stringify({ index: null, region: "leading", mine: null, theirs: "\n" }),
    ]);
  });

  test("both sides delete everything and neither touched an edge — empty output, nothing reported", () => {
    const merged = threeWayMerge("Only.\n", "", "");
    expect({ text: merged.text, conflicts: merged.conflicts }).toEqual({ text: "", conflicts: [] });
  });
});

describe("threeWayMerge — review round 7: a side holding only unparsed source is not silently dropped", () => {
  test("mine's changed link-reference definition has no block counterpart, so the loss is reported", () => {
    // markdown-it parses a lone reference definition as no block at all, so mine has nothing the
    // aligner can place. Theirs added a real paragraph and wins the document. Mine's deliberate
    // change to that definition cannot be carried — it must not vanish unmentioned.
    const base = "[ref]: https://a.example\n";
    const mine = "[ref]: https://mine.example\n";
    const theirs = "[ref]: https://a.example\n\nA new paragraph on disk.\n";

    const merged = threeWayMerge(base, mine, theirs);
    expect(merged.text).toBe(theirs);
    // Restated in review round 8: the entry records what was LOST, not a conflict mine wins —
    // mine is exactly the side that did not survive here — and it is reported only because these
    // bytes are genuinely absent from the result.
    expect(merged.conflicts.map((conflict) => JSON.stringify(conflict))).toEqual([
      JSON.stringify({ index: null, region: "document", side: "mine", carried: false, dropped: mine }),
    ]);
  });

  test("an unchanged blockless side reports nothing", () => {
    const base = "[ref]: https://a.example\n";
    const theirs = "[ref]: https://a.example\n\nA new paragraph on disk.\n";
    expect(threeWayMerge(base, base, theirs).conflicts).toEqual([]);
  });
});

describe("threeWayMerge — review round 8: the blockless report fires only on a real loss", () => {
  test("no report when the block-bearing side already carries the same change", () => {
    // Mine is a lone reference definition it changed; theirs made the SAME change and also added a
    // block. Mine's bytes are in the result, so nothing was lost and nothing is reported.
    const base = "[ref]: https://a.example\n";
    const mine = "[ref]: https://mine.example\n";
    const theirs = "[ref]: https://mine.example\n\nA new paragraph on disk.\n";

    const merged = threeWayMerge(base, mine, theirs);
    expect({ carriesMine: merged.text.includes("https://mine.example"), conflicts: merged.conflicts }).toEqual({
      carriesMine: true,
      conflicts: [],
    });
  });
});

describe("threeWayMerge — review round 9: carriage is positional, and a deletion is not exempt", () => {
  test("a coincidental occurrence elsewhere does not count as carrying the bytes", () => {
    // Mine is a lone reference definition. Theirs keeps base's definition and adds a paragraph that
    // happens to quote mine's text in the middle of the document. Mine's region is NOT at an edge
    // of the result, so it was not carried and the loss must still be reported.
    const base = "[ref]: https://a.example\n";
    const mine = "[ref]: https://mine.example\n";
    const theirs = "[ref]: https://a.example\n\nSee [ref]: https://mine.example for context.\n\nTail.\n";

    const merged = threeWayMerge(base, mine, theirs);
    expect(merged.conflicts.map((conflict) => (conflict as { carried?: unknown }).carried === false)).toEqual([true]);
  });

  test("a deletion is accounted for by the block conflict, not a second time as a raw-region loss", () => {
    // Mine deleted the only block to whitespace while theirs edited it: a conflict mine wins, so
    // the result is empty. A deletion is decided by the runs and reported as a block conflict when
    // it loses, so the raw-region accounting must not report it a second time — that accounting is
    // for a side still holding source no block parse claims.
    const base = "Only.\n";
    const mine = "   \n";
    const theirs = "Only, changed on disk.\n";

    const merged = threeWayMerge(base, mine, theirs);
    expect({
      text: merged.text,
      lost: merged.conflicts.filter((conflict) => (conflict as { carried?: unknown }).carried === false).length,
      blockConflicts: merged.conflicts.filter((conflict) => !(conflict as { region?: string }).region).length,
    }).toEqual({ text: "", lost: 0, blockConflicts: 1 });
  });
});

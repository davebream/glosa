// SPDX-License-Identifier: Apache-2.0
// #271 — the pure half of per-block editing: which bytes a run owns, and what replacing them does.
//
// Held against real spans from `blockLayout()` rather than hand-written offsets. Hand-written
// offsets would pass while disagreeing with the tokenizer that actually produces them, which is the
// exact class of defect this file exists to catch: a run whose span is one byte off writes the
// writer's paragraph over a neighbouring one.
import { describe, expect, test } from "bun:test";
import { blockLayout } from "../src/rich-editor.js";
import { offsetRemapper, runAtLine, runsFrom, spliceRun, widenToNext, widenToPrevious } from "../src/run-spans.js";

const SOURCE = "# Title\n\nFirst paragraph.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nLast paragraph.\n";

const runsOf = (source: string) => runsFrom(source, blockLayout(source).blocks as { start: number; end: number }[]);
const textOf = (source: string, run: { start: number; end: number }) => source.slice(run.start, run.end);

describe("run spans (#271)", () => {
  test("every top-level block becomes one run, carrying the line it starts on", () => {
    const runs = runsOf(SOURCE);
    expect(runs.map((run) => run.line)).toEqual([0, 2, 4, 8]);
    expect(runs.map((run) => textOf(SOURCE, run))).toEqual([
      "# Title",
      "First paragraph.",
      "| a | b |\n|---|---|\n| 1 | 2 |",
      "Last paragraph.",
    ]);
  });

  test("the line is the one the renderer stamps, so a run can be found from a clicked element", () => {
    // `data-line` is `token.map[0]`, which is where the block's span begins. This is the whole
    // bridge between the DOM and the bytes; if it drifts, a click opens an editor over the wrong
    // block and the save writes there.
    const runs = runsOf(SOURCE);
    expect(textOf(SOURCE, runAtLine(runs, 4)!)).toBe("| a | b |\n|---|---|\n| 1 | 2 |");
    expect(textOf(SOURCE, runAtLine(runs, 0)!)).toBe("# Title");
  });

  test("a line no top-level block starts on has no run", () => {
    // Null is a real answer. Line 5 is the table's delimiter row — inside a block, not the head of
    // one — and opening an editor there would mean editing bytes the click did not name.
    expect(runAtLine(runsOf(SOURCE), 5)).toBeNull();
    expect(runAtLine(runsOf(SOURCE), 999)).toBeNull();
  });

  test("front matter produces a span even though it produces no element", () => {
    // Which is why runs are matched by LINE and not by ordinal position against the DOM: the
    // renderer hides front matter, so the first rendered element is the second run.
    const source = "---\ntitle: T\n---\n\n# Heading\n\nBody.\n";
    const runs = runsOf(source);
    expect(runs).toHaveLength(3);
    expect(textOf(source, runs[0]!)).toBe("---\ntitle: T\n---");
    expect(textOf(source, runAtLine(runs, 4)!)).toBe("# Heading");
  });

  test("splicing a run rewrites its bytes and nothing else", () => {
    const runs = runsOf(SOURCE);
    const spliced = spliceRun(SOURCE, runAtLine(runs, 2)!, "Edited paragraph.");
    expect(spliced).toBe("# Title\n\nEdited paragraph.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nLast paragraph.\n");
    // Stated as byte equality on the untouched remainder rather than only on the whole result, so a
    // failure says WHICH side moved.
    expect(spliced.slice(0, runAtLine(runs, 2)!.start)).toBe(SOURCE.slice(0, runAtLine(runs, 2)!.start));
    expect(spliced.endsWith("\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nLast paragraph.\n")).toBe(true);
  });

  test("a run can grow into several blocks, which is what Enter and paste produce", () => {
    const runs = runsOf(SOURCE);
    const spliced = spliceRun(SOURCE, runAtLine(runs, 2)!, "One.\n\nTwo.\n\nThree.");
    // Re-measured from the spliced source: the document now has two more top-level blocks, and each
    // has its own span. Nothing had to know in advance that one block would become three.
    expect(runsOf(spliced)).toHaveLength(6);
    expect(runsOf(spliced).map((run) => textOf(spliced, run))).toContain("Two.");
  });

  test("widening takes in the block above, for Backspace at the head of a run", () => {
    const runs = runsOf(SOURCE);
    const widened = widenToPrevious(runs, runAtLine(runs, 2)!);
    expect(textOf(SOURCE, widened)).toBe("# Title\n\nFirst paragraph.");
    expect(widened.line).toBe(0);
  });

  test("widening at the top of the document is a no-op, not an error", () => {
    const runs = runsOf(SOURCE);
    const first = runAtLine(runs, 0)!;
    expect(widenToPrevious(runs, first)).toEqual(first);
  });

  test("widening takes in the block below, for Delete at the end of a run", () => {
    const runs = runsOf(SOURCE);
    const widened = widenToNext(runs, runAtLine(runs, 0)!);
    expect(textOf(SOURCE, widened)).toBe("# Title\n\nFirst paragraph.");
  });

  test("widening at the foot of the document is a no-op", () => {
    const runs = runsOf(SOURCE);
    const last = runs[runs.length - 1]!;
    expect(widenToNext(runs, last)).toEqual(last);
  });

  test("offsets before a splice hold, offsets after it move by the delta", () => {
    // What the margin needs: an annotation anchored below an edited paragraph must still point at
    // its own words afterwards.
    const runs = runsOf(SOURCE);
    const run = runAtLine(runs, 2)!;
    const remap = offsetRemapper(run, "Much longer replacement text here.");
    const delta = "Much longer replacement text here.".length - (run.end - run.start);
    expect(remap(0)).toBe(0);
    expect(remap(run.start)).toBe(run.start);
    expect(remap(run.end)).toBe(run.end + delta);
    expect(remap(SOURCE.length)).toBe(SOURCE.length + delta);
  });

  test("an offset inside the replaced run remaps to null rather than to a plausible number", () => {
    // The bytes it pointed at may not exist any more. Returning a number here would let an
    // annotation silently re-anchor onto whatever now sits at that offset, which is the dishonest
    // outcome the "Lost its place" state exists to make visible instead.
    const runs = runsOf(SOURCE);
    const run = runAtLine(runs, 2)!;
    expect(offsetRemapper(run, "x")(run.start + 1)).toBeNull();
  });

  test("a remapped offset still points at the same text", () => {
    // The property the delta arithmetic is for, asserted on the actual characters rather than on
    // the arithmetic — an off-by-one in `offsetRemapper` would satisfy the numeric assertions above
    // and fail here.
    const runs = runsOf(SOURCE);
    const run = runAtLine(runs, 2)!;
    const last = runs[runs.length - 1]!;
    const replacement = "Short.";
    const spliced = spliceRun(SOURCE, run, replacement);
    const moved = offsetRemapper(run, replacement)(last.start)!;
    expect(spliced.slice(moved, moved + "Last paragraph.".length)).toBe("Last paragraph.");
  });
});

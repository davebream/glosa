// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import {
  agentIdentity,
  agentRequestSummary,
  bandPath,
  isQuestion,
  lineBoxes,
  locateQuote,
  openQuestions,
  requestsForArtifact,
  selectArrivals,
} from "../src/agent-request.js";

const RENDERED =
  "The argument rests on the premise that readers already accept the frame. " +
  "Later we return to the premise that readers already accept the frame, and test it.";

describe("locateQuote — source→rendered, prove it or give up", () => {
  test("plain prose the session quoted verbatim resolves to its exact offsets", () => {
    const found = locateQuote(RENDERED, { exact: "readers already accept the frame. Later" });
    expect(found).not.toBeNull();
    expect(RENDERED.slice(found!.start, found!.end)).toBe("readers already accept the frame. Later");
  });

  test("inline markdown the renderer stripped still resolves", () => {
    // The session quotes what it WROTE; the reader sees what was rendered.
    const found = locateQuote(RENDERED, { exact: "the **premise** that readers already accept the frame. Later" });
    expect(found).not.toBeNull();
    expect(RENDERED.slice(found!.start, found!.end)).toBe("the premise that readers already accept the frame. Later");
  });

  test("a link resolves to its label, which is all the reader can see", () => {
    const text = "See the style guide for details.";
    const found = locateQuote(text, { exact: "the [style guide](./style.md) for" });
    expect(found).not.toBeNull();
    expect(text.slice(found!.start, found!.end)).toBe("the style guide for");
  });

  test("a source hard-wrap resolves against the single rendered space", () => {
    const found = locateQuote(RENDERED, { exact: "the premise\nthat readers already accept the frame. Later" });
    expect(found).not.toBeNull();
    expect(RENDERED.slice(found!.start, found!.end)).toBe("the premise that readers already accept the frame. Later");
  });

  test("AMBIGUOUS: a quote occurring twice with no context returns null, never a guess", () => {
    // This is the load-bearing case. Underlining the wrong paragraph is worse than underlining
    // nothing, so an anchor that cannot be proven unique is not an anchor.
    expect(locateQuote(RENDERED, { exact: "the premise that readers already accept the frame" })).toBeNull();
  });

  test("the same ambiguous quote resolves once its suffix tells the two apart", () => {
    const found = locateQuote(RENDERED, {
      exact: "the premise that readers already accept the frame",
      suffix: ", and test it.",
    });
    expect(found).not.toBeNull();
    // The SECOND occurrence — the one the suffix identifies.
    expect(found!.start).toBeGreaterThan(RENDERED.indexOf("Later"));
  });

  test("its prefix works the same way, picking the first occurrence", () => {
    const found = locateQuote(RENDERED, {
      exact: "the premise that readers already accept the frame",
      prefix: "The argument rests on ",
    });
    expect(found).not.toBeNull();
    expect(found!.start).toBeLessThan(RENDERED.indexOf("Later"));
  });

  test("text the artifact no longer contains is orphaned, not approximated", () => {
    expect(locateQuote(RENDERED, { exact: "a sentence that was deleted last week" })).toBeNull();
  });

  test("a degenerate quote is null rather than a zero-width range at position 0", () => {
    expect(locateQuote(RENDERED, { exact: "" })).toBeNull();
    expect(locateQuote(RENDERED, null as never)).toBeNull();
  });
});

describe("requestsForArtifact", () => {
  const entries = [
    { id: "b", created_at: "2026-09-05T10:00:02Z", target_path: "notes.md" },
    { id: "a", created_at: "2026-09-05T10:00:01Z", target_path: "notes.md" },
    { id: "other", created_at: "2026-09-05T10:00:00Z", target_path: "elsewhere.md" },
    { id: "approval", created_at: "2026-09-05T09:00:00Z", target_path: "notes.md", approval_mode: true },
  ];

  test("keeps this artifact's requests, oldest first", () => {
    expect(requestsForArtifact(entries, "notes.md").map((entry: { id: string }) => entry.id)).toEqual(["a", "b"]);
  });

  test("excludes approval requests — the approval strip already owns those", () => {
    expect(requestsForArtifact(entries, "notes.md").some((entry: { id: string }) => entry.id === "approval")).toBe(
      false,
    );
  });

  test("no open artifact means no cards, not every card", () => {
    expect(requestsForArtifact(entries, null)).toEqual([]);
  });
});

describe("agentRequestSummary — count what the margin actually holds", () => {
  test("uses singular labels for one question or one pointer", () => {
    expect(agentRequestSummary([{ message: "Is this clear?" }])).toBe("1 question");
    expect(agentRequestSummary([{ message: null }])).toBe("1 pointer");
  });

  test("pluralizes each request kind independently", () => {
    expect(agentRequestSummary([{ message: "First?" }, { message: "Second?" }])).toBe("2 questions");
    expect(agentRequestSummary([{}, { message: "" }])).toBe("2 pointers");
  });

  test("puts questions before pointers and omits zero counts", () => {
    expect(agentRequestSummary([{ message: null }, { message: "Is this clear?" }, {}])).toBe("1 question · 2 pointers");
  });

  test("an empty request list has no label", () => {
    expect(agentRequestSummary([])).toBe("");
  });
});

describe("selectArrivals — what is new, which is announced and never jumped to (#308)", () => {
  const ask = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    created_at: `2026-09-05T10:00:0${id.slice(-1)}Z`,
    target_path: "notes.md",
    message: "Is argument X covered enough?",
    ...over,
  });

  test("the first inbox read is not news — questions waiting overnight are not arrivals", () => {
    expect(selectArrivals(new Set(), [ask("a"), ask("b")], { firstLoad: true })).toEqual([]);
  });

  test("a request already seen is a refresh, not an arrival", () => {
    expect(selectArrivals(new Set(["a"]), [ask("a")])).toEqual([]);
  });

  test("a genuinely new question is an arrival", () => {
    expect(selectArrivals(new Set(["a"]), [ask("a"), ask("b")]).map((e: { id: string }) => e.id)).toEqual(["b"]);
  });

  test("several arriving at once all count, oldest first", () => {
    expect(selectArrivals(new Set(), [ask("c"), ask("b")]).map((e: { id: string }) => e.id)).toEqual(["b", "c"]);
  });

  test("a pointer is an arrival too — its mark draws in, it just never earns a notice", () => {
    expect(selectArrivals(new Set(), [ask("a", { message: null })]).map((e: { id: string }) => e.id)).toEqual(["a"]);
  });

  test("an approval request is the approval strip's business, not the margin's", () => {
    expect(selectArrivals(new Set(), [ask("a", { approval_mode: true })])).toEqual([]);
  });
});

describe("openQuestions — who is offered first", () => {
  const entry = (id: string, at: string, over: Record<string, unknown> = {}) => ({
    id,
    created_at: at,
    message: "?",
    ...over,
  });

  test("oldest first: the session that has waited longest is offered first", () => {
    const got = openQuestions([entry("late", "2026-09-05T10:00:09Z"), entry("early", "2026-09-05T10:00:01Z")]);
    expect(got.map((e: { id: string }) => e.id)).toEqual(["early", "late"]);
  });

  test("pointers and approval requests are not questions", () => {
    const got = openQuestions([
      entry("p", "2026-09-05T10:00:01Z", { message: null }),
      entry("a", "2026-09-05T10:00:02Z", { approval_mode: true }),
      entry("q", "2026-09-05T10:00:03Z"),
    ]);
    expect(got.map((e: { id: string }) => e.id)).toEqual(["q"]);
    expect(isQuestion({ message: "" })).toBe(false);
  });
});

describe("the band — a passage outlined the way a selection is shaped", () => {
  const rect = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });

  test("inline boxes on one line fold into one line box", () => {
    // "The **premise** holds" is three rects on one rendered line.
    const lines = lineBoxes([rect(10, 100, 40, 120), rect(40, 98, 90, 121), rect(90, 100, 130, 120)]);
    expect(lines).toEqual([{ left: 10, right: 130, top: 98, bottom: 121 }]);
  });

  test("zero-width rects at a wrap are ignored rather than starting a phantom line", () => {
    const lines = lineBoxes([rect(10, 100, 200, 120), rect(200, 100, 200, 120), rect(0, 130, 90, 150)]);
    expect(lines.length).toBe(2);
  });

  test("lines come back top to bottom whatever order the engine reported them in", () => {
    const lines = lineBoxes([rect(0, 130, 90, 150), rect(50, 100, 200, 120)]);
    expect(lines.map((l) => l.top)).toEqual([100, 130]);
  });

  test("one line is a plain rectangle around the words, not the column", () => {
    const d = bandPath([rect(50, 100, 120, 120)], { left: 0, right: 400 }, { padX: 0, padY: 0 });
    expect(d).toBe("M50,100H120V120H50Z");
  });

  test("several lines step: start mid-line, span the column, stop mid-line", () => {
    const lines = [rect(150, 100, 380, 120), rect(0, 130, 400, 150), rect(0, 160, 90, 180)];
    const d = bandPath(lines, { left: 0, right: 400 }, { padX: 0, padY: 0 });
    // from the first word, right to the column edge, down to the last line, in to the last word,
    // along the bottom, up the left edge to under the first line, back in to the first word
    expect(d).toBe("M150,100H400V160H90V180H0V120H150Z");
  });

  test("nothing located draws nothing", () => {
    expect(bandPath([], { left: 0, right: 400 })).toBeNull();
  });
});

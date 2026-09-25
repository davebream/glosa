// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import {
  agentIdentity,
  agentRequestSummary,
  bracketPath,
  isQuestion,
  lineBoxes,
  locateQuote,
  mergeSpans,
  openQuestions,
  requestsForArtifact,
  selectArrivals,
  stackTabs,
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

describe("a session's mark — a bracket beside the block, a tab at the words' line", () => {
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

  test("blocks apart keep a bracket each; blocks that overlap or touch share one", () => {
    // Two requests in one paragraph (same span), one in the next paragraph after a gap, and one
    // whose words run on into that next paragraph (touching it).
    const spans = [
      { top: 100, bottom: 200 },
      { top: 300, bottom: 360 },
      { top: 100, bottom: 200 },
      { top: 360, bottom: 420 },
    ];
    expect(mergeSpans(spans)).toEqual([
      { top: 100, bottom: 200, members: [0, 2] },
      { top: 300, bottom: 420, members: [1, 3] },
    ]);
  });

  test("a span with no height, or no geometry at all, draws no bracket", () => {
    expect(
      mergeSpans([
        { top: 50, bottom: 50 },
        { top: Number.NaN, bottom: 10 },
      ]),
    ).toEqual([]);
  });

  test("the bracket is a [ with its ticks turned toward the text", () => {
    expect(bracketPath(100, 180, 40)).toBe("M46,100H40V180H46");
    expect(bracketPath(100, 180, 40, { tick: 4 })).toBe("M44,100H40V180H44");
  });

  test("nothing to span draws nothing", () => {
    expect(bracketPath(100, 100, 40)).toBeNull();
    expect(bracketPath(100, Number.NaN, 40)).toBeNull();
  });

  test("tabs whose words start on the same line are pushed apart, and keep the order given", () => {
    // Two tabs on one line and a third just below them: the second is pushed under the first, and
    // that push carries on into the third. Given out of order on purpose: the result keeps the
    // caller's order rather than coming back sorted.
    expect(stackTabs([130, 100, 100])).toEqual([148, 100, 124]);
  });

  test("tabs already apart stay level with their lines", () => {
    expect(stackTabs([100, 160], { size: 20, gap: 4 })).toEqual([100, 160]);
  });
});

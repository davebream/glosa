// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import { agentIdentity, locateQuote, requestsForArtifact, selectRequestToReveal } from "../src/agent-request.js";

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

describe("selectRequestToReveal — the one thing that moves the reader unasked", () => {
  const ask = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    created_at: `2026-09-05T10:00:0${id.slice(-1)}Z`,
    target_path: "notes.md",
    message: "Is argument X covered enough?",
    ...over,
  });

  test("the first inbox read never jumps — opening onto overnight questions is not an arrival", () => {
    expect(selectRequestToReveal(new Set(), [ask("a"), ask("b")], { firstLoad: true })).toBeNull();
  });

  test("a request already seen is a refresh, not an arrival", () => {
    expect(selectRequestToReveal(new Set(["a"]), [ask("a")])).toBeNull();
  });

  test("a genuinely new question is the one to reveal", () => {
    expect(selectRequestToReveal(new Set(["a"]), [ask("a"), ask("b")])?.id).toBe("b");
  });

  test("several arriving at once yield ONE jump, the oldest — two jumps is not twice as helpful", () => {
    expect(selectRequestToReveal(new Set(), [ask("c"), ask("b")])?.id).toBe("b");
  });

  test("a pointer with no question never moves the reader — it earns a mark, not their place", () => {
    expect(selectRequestToReveal(new Set(), [ask("a", { message: null })])).toBeNull();
  });

  test("an approval request is the approval strip's business, not the margin's", () => {
    expect(selectRequestToReveal(new Set(), [ask("a", { approval_mode: true })])).toBeNull();
  });
});

describe("agentIdentity — proven and claimed never merge", () => {
  test("a session label is returned as a separate claimed half", () => {
    expect(agentIdentity({ agent_label: "api-refactor" }, { providerName: "Claude Code" })).toEqual({
      provider: "Claude Code",
      claimed: "api-refactor",
    });
  });

  test("no label leaves claimed null rather than inventing a name", () => {
    expect(agentIdentity({}, { providerName: "Claude Code" }).claimed).toBeNull();
  });

  test("a whitespace-only label is no label", () => {
    expect(agentIdentity({ agent_label: "   " }, { providerName: "Claude Code" }).claimed).toBeNull();
  });
});

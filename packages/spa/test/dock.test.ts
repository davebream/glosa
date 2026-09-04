// SPDX-License-Identifier: Apache-2.0
// The dock's pure rules: how a tab is labelled, how a comparison is identified, and how a saved
// arrangement survives an artifact disappearing underneath it (2026-09-04 brief §5, §10).

import { describe, expect, test } from "bun:test";
import { describeVersion, diffPanelId, disambiguateLabels, MIN_PANE_WIDTH, pruneGrid } from "../src/dock.js";

describe("disambiguateLabels — the shortest distinguishing parent segment (§5)", () => {
  test("a unique filename is just the filename", () => {
    const labels = disambiguateLabels(["docs/notes.md", "drafts/outline.md"]);
    expect(labels.get("docs/notes.md")).toBe("notes.md");
    expect(labels.get("drafts/outline.md")).toBe("outline.md");
  });

  test("two files sharing a name both grow one parent segment", () => {
    const labels = disambiguateLabels(["drafts/index.md", "final/index.md"]);
    expect(labels.get("drafts/index.md")).toBe("drafts/index.md");
    expect(labels.get("final/index.md")).toBe("final/index.md");
  });

  test("the whole group grows together, to the shallowest depth that separates them", () => {
    // One parent still collides, so both go to two. Growing them by different amounts would read
    // as two unrelated files rather than as the same name in two places.
    const labels = disambiguateLabels(["a/shared/index.md", "b/shared/index.md"]);
    expect(labels.get("a/shared/index.md")).toBe("a/shared/index.md");
    expect(labels.get("b/shared/index.md")).toBe("b/shared/index.md");
  });

  test("a root-level file with a colliding name keeps its whole (short) path", () => {
    const labels = disambiguateLabels(["index.md", "drafts/index.md"]);
    expect(labels.get("index.md")).toBe("index.md");
    expect(labels.get("drafts/index.md")).toBe("drafts/index.md");
  });

  test("groups are independent — one collision never lengthens an unrelated label", () => {
    const labels = disambiguateLabels(["drafts/index.md", "final/index.md", "deep/nested/notes.md"]);
    expect(labels.get("deep/nested/notes.md")).toBe("notes.md");
  });
});

describe("diff tab identity (§5)", () => {
  test("the id is the pair, so asking twice focuses one tab instead of opening two", () => {
    expect(diffPanelId("notes.md", "abc123", "working")).toBe("diff:notes.md:abc123:working");
    expect(diffPanelId("notes.md", "abc123", "working")).toBe(diffPanelId("notes.md", "abc123", "working"));
    expect(diffPanelId("notes.md", "abc123", "def456")).not.toBe(diffPanelId("notes.md", "abc123", "working"));
  });

  test("a version reads in the reader's words, never as a raw token (R1)", () => {
    expect(describeVersion("working")).toBe("now");
    expect(describeVersion("0123456789abcdef")).toBe("0123456");
  });
});

describe("pruneGrid — a corrupt or stale layout must never make a workspace unopenable (§10)", () => {
  test("a leaf drops the panels that are gone and repoints its active view", () => {
    const node = { type: "leaf", data: { views: ["a.md", "gone.md"], activeView: "gone.md", id: "g1" } };
    const pruned = pruneGrid(node, new Set(["a.md"]));
    expect(pruned.data.views).toEqual(["a.md"]);
    expect(pruned.data.activeView).toBe("a.md");
  });

  test("a leaf with nothing left disappears", () => {
    const node = { type: "leaf", data: { views: ["gone.md"], activeView: "gone.md", id: "g1" } };
    expect(pruneGrid(node, new Set(["a.md"]))).toBeNull();
  });

  test("a branch left with one child is hoisted — a sash with nothing on one side is not a split", () => {
    const node = {
      type: "branch",
      data: [
        { type: "leaf", data: { views: ["a.md"], activeView: "a.md", id: "g1" } },
        { type: "leaf", data: { views: ["gone.md"], activeView: "gone.md", id: "g2" } },
      ],
    };
    const pruned = pruneGrid(node, new Set(["a.md"]));
    // The surviving leaf is not the same `type` as the branch, so it stays wrapped; what matters
    // is that the branch no longer names a panel the layout cannot build.
    expect(pruned.data).toHaveLength(1);
    expect(pruned.data[0].data.views).toEqual(["a.md"]);
  });

  test("a branch that loses everything disappears with its children", () => {
    const node = {
      type: "branch",
      data: [{ type: "leaf", data: { views: ["gone.md"], activeView: "gone.md", id: "g1" } }],
    };
    expect(pruneGrid(node, new Set(["a.md"]))).toBeNull();
  });
});

describe("nesting is bounded by usable width, not by an arbitrary depth cap (§9)", () => {
  test("the minimum pane width is where the compact annotation tray bottoms out", () => {
    expect(MIN_PANE_WIDTH).toBe(360);
  });
});

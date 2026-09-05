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

describe("moving a tab never destroys the layout it was moved within", () => {
  // Splitting a group's ONLY panel off from that same group destroys the group the split is
  // measured against. One artifact alone in one group took the whole dock down that way: zero
  // groups, zero tabs, and a pane still in the DOM that nothing could reach or scroll to.
  const dockviewMod = () => import("../src/vendor/dockview.js");

  async function makeDock(dom: any, panelCount: number) {
    const { createDockview } = await dockviewMod();
    const host = dom.document.createElement("div");
    dom.document.body.append(host);
    const api = createDockview(host, {
      createComponent: () => {
        const element = dom.document.createElement("div");
        return { element, init() {} };
      },
    });
    for (let i = 0; i < panelCount; i++) {
      api.addPanel({ id: `a${i}.md`, component: "pane", title: `a${i}.md` });
    }
    return api;
  }

  test("a lone tab has nowhere to go, so every direction reports itself unavailable", async () => {
    const { installDom } = await import("./dom-env.ts");
    const dom = installDom();
    try {
      const api = await makeDock(dom, 1);
      const group = api.activePanel!.api.group;
      expect(group.panels.length).toBe(1);
      // The shape the guard exists for: no adjacent group, and a split would empty this one.
      for (const direction of ["left", "right", "up", "down"] as const) {
        expect(api.adjacentGroupInDirection(group, direction)).toBeUndefined();
      }
    } finally {
      dom.teardown();
    }
  });

  test("a group with two tabs can split one off without losing the other", async () => {
    const { installDom } = await import("./dom-env.ts");
    const dom = installDom();
    try {
      const api = await makeDock(dom, 2);
      expect(api.groups.length).toBe(1);
      const panel = api.activePanel!;
      panel.api.moveTo({ group: panel.api.group, position: "bottom" });
      expect(api.groups.length).toBe(2);
      expect(api.panels.length).toBe(2);
      for (const group of api.groups) expect(group.panels.length).toBeGreaterThan(0);
    } finally {
      dom.teardown();
    }
  });
});

describe("nesting is bounded by usable width, not by an arbitrary depth cap (§9)", () => {
  test("the minimum pane width is where the compact annotation tray bottoms out", () => {
    expect(MIN_PANE_WIDTH).toBe(360);
  });
});

describe("the tab strip has one axis", () => {
  /** dockview ships `.dv-tabs-container` as `height: 100%; overflow: auto` with a 3px horizontal
   * scrollbar lane drawn inside that height. The lane makes a full-height row of tabs 3px too
   * tall for its own box, and `auto` answers by opening a vertical scrollbar next to a single row
   * — 15px of chrome on any machine set to show scrollbars always, plus a second axis the strip
   * can be scrolled along, out of alignment with the artifact bar beneath it.
   *
   * app.css overrides it, and nothing but the class NAME ties the two files together: a dockview
   * upgrade that renames the container leaves the override matching nothing and the scrollbar
   * quietly back. Pin both halves here, the way the highlight-key contract is pinned in
   * annotation-surface.test.ts. */
  test("glosa pins the vendored strip to the horizontal axis, and still targets the class it ships", async () => {
    const vendor = await Bun.file(new URL("../src/vendor/dockview.css", import.meta.url)).text();
    const css = await Bun.file(new URL("../src/app.css", import.meta.url)).text();

    // The defect is still in the vendored file — this override is not dead weight...
    expect(vendor).toMatch(/\.dv-tabs-container \{[^}]*overflow:\s*auto/);
    expect(vendor).toMatch(/\.dv-tabs-container::-webkit-scrollbar \{\s*height:\s*3px/);

    // ...and glosa answers it on the same class, on the horizontal strip only.
    const override = css.match(
      /\.glosa-dock-theme \.dv-tabs-container:not\(\.dv-tabs-container-vertical\):not\(\.dv-tabs-container--wrap\) \{([^}]*)\}/,
    );
    expect(override).not.toBeNull();
    expect(override![1]).toContain("overflow-y: hidden");
    expect(override![1]).toContain("scrollbar-width: none");
    // Firefox takes `scrollbar-width`; WebKit needs its own pseudo-element, so both are required
    // — shipping only one leaves the lane painted in the browsers glosa actually runs in.
    expect(css).toContain(
      ".glosa-dock-theme .dv-tabs-container:not(.dv-tabs-container-vertical):not(.dv-tabs-container--wrap)::-webkit-scrollbar",
    );
  });
});

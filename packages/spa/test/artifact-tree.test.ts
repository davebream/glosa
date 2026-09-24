// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ancestorDirectoryIds,
  buildArtifactTree,
  createArtifactTreeNavigator,
  flattenVisibleTree,
} from "../src/artifact-tree.js";
import { installDom, type DomEnv } from "./dom-env.ts";

describe("artifact tree model", () => {
  test("groups path segments and orders folders first, then files, by name", () => {
    const root = buildArtifactTree([
      { path: "03_review.md", class: "R" },
      { path: "drafts/02_body.md", class: "R" },
      { path: "01_brief.md", class: "R" },
      { path: "Notes/z.md", class: "R" },
      { path: "10_appendix.md", class: "R" },
      { path: "drafts/01_opening.md", class: "R" },
    ]);

    expect(root.children.map((node) => node.name)).toEqual([
      "drafts",
      "Notes",
      "01_brief.md",
      "03_review.md",
      "10_appendix.md",
    ]);
    const drafts = root.children[0]!;
    expect(drafts.kind).toBe("directory");
    if (drafts.kind === "directory") {
      expect(drafts.children.map((node) => node.name)).toEqual(["01_opening.md", "02_body.md"]);
    }
  });

  test("flattens only expanded branches and derives stable ancestor IDs", () => {
    const root = buildArtifactTree([{ path: "drafts/notes/a.md" }, { path: "drafts/b.md" }, { path: "root.md" }]);

    expect(flattenVisibleTree(root, new Set()).map(({ node }) => node.name)).toEqual(["drafts", "root.md"]);
    expect(flattenVisibleTree(root, new Set(["d:drafts"])).map(({ node }) => node.name)).toEqual([
      "drafts",
      "notes",
      "b.md",
      "root.md",
    ]);
    expect(ancestorDirectoryIds("drafts/notes/a.md")).toEqual(["d:drafts", "d:drafts/notes"]);
  });
});

describe("artifact tree navigator", () => {
  let dom: DomEnv;

  beforeEach(() => {
    dom = installDom();
  });

  afterEach(() => {
    dom.teardown();
  });

  test("expands folders, opens files, and exposes the WAI-ARIA tree structure", () => {
    const container = dom.document.createElement("ul");
    dom.document.body.append(container);
    const opened: string[] = [];
    const navigator = createArtifactTreeNavigator(container as unknown as HTMLElement, {
      storage: null,
      onOpen: (path) => opened.push(path),
    });

    navigator.setWorkspace("ws");
    navigator.setArtifacts([
      { path: "notes.md", class: "R" },
      { path: "drafts/a.md", class: "R" },
      { path: "drafts/deep/b.md", class: "R" },
    ]);

    expect(container.getAttribute("role")).toBe("tree");
    expect(container.querySelectorAll('[role="treeitem"]')).toHaveLength(2);
    const drafts = container.querySelector('[data-node-id="d:drafts"]')!;
    expect(drafts.getAttribute("aria-expanded")).toBe("false");
    (drafts.querySelector(".glosa-tree-row") as any).click();
    expect(container.querySelectorAll('[role="treeitem"]')).toHaveLength(4);
    expect(container.querySelector('[data-node-id="d:drafts"]')!.getAttribute("aria-expanded")).toBe("true");

    (container.querySelector('[data-node-id="f:drafts/a.md"] > .glosa-tree-row') as any).click();
    expect(opened).toEqual(["drafts/a.md"]);
    navigator.destroy();
  });

  test("auto-reveals the current file and implements arrow-key tree navigation", () => {
    const container = dom.document.createElement("ul");
    dom.document.body.append(container);
    const navigator = createArtifactTreeNavigator(container as unknown as HTMLElement, {
      storage: null,
      onOpen: () => {},
    });
    navigator.setWorkspace("ws");
    navigator.setArtifacts([
      { path: "drafts/deep/current.md", class: "R" },
      { path: "root.md", class: "R" },
    ]);
    navigator.setCurrent("drafts/deep/current.md");

    const current = container.querySelector('[data-node-id="f:drafts/deep/current.md"]')!;
    expect(current.getAttribute("aria-current")).toBe("page");
    expect(current.getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector('[data-node-id="d:drafts"]')!.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector('[data-node-id="d:drafts/deep"]')!.getAttribute("aria-expanded")).toBe("true");

    const drafts = container.querySelector('[data-node-id="d:drafts"]') as any;
    drafts.focus();
    drafts.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(dom.document.activeElement?.getAttribute("data-node-id")).toBe("d:drafts/deep");
    (dom.document.activeElement as any).dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
    );
    expect(dom.document.activeElement?.getAttribute("data-node-id")).toBe("d:drafts/deep");
    expect(dom.document.activeElement?.getAttribute("aria-expanded")).toBe("false");
    (dom.document.activeElement as any).dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
    );
    expect(dom.document.activeElement?.getAttribute("data-node-id")).toBe("d:drafts");
    navigator.destroy();
  });
});

// A name the tree does not split still ends in an ellipsis when it overflows: the label is a flex
// row, and `text-overflow` only works on the head span, never on a flex row's bare text. Measured
// in a browser after the split landed: `sibling-writer-rule-preregistration.md` cut mid-glyph.
// A name with no hyphen stays whole in the head; the hyphen travels with the tail.
describe("long names in the tree", () => {
  test("every label carries its name in a head span; a split name adds the tail after the last hyphen", () => {
    const dom = installDom();
    try {
      const container = dom.document.createElement("ul");
      dom.document.body.append(container);
      const navigator = createArtifactTreeNavigator(container as unknown as HTMLElement, {
        storage: null,
        onOpen: () => {},
      });
      navigator.setWorkspace("ws");
      navigator.setArtifacts([
        { path: "sibling-writer-rule-preregistration.md", class: "R" },
        { path: "underfive-competitive-research.md", class: "R" },
        { path: "validation.md", class: "R" },
      ]);
      const labels = Array.from(container.querySelectorAll(".glosa-tree-label")).map((label) => ({
        text: label.textContent,
        head: label.querySelector(".glosa-tree-label-head")?.textContent ?? null,
        tail: label.querySelector(".glosa-tree-label-tail")?.textContent ?? null,
      }));
      expect(labels).toEqual([
        { text: "sibling-writer-rule-preregistration.md", head: "sibling-writer-rule", tail: "-preregistration.md" },
        { text: "underfive-competitive-research.md", head: "underfive-competitive", tail: "-research.md" },
        { text: "validation.md", head: "validation.md", tail: null },
      ]);
      navigator.destroy();
    } finally {
      dom.teardown();
    }
  });
});

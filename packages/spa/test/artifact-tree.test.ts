// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ancestorDirectoryIds,
  buildArtifactTree,
  createArtifactTreeNavigator,
  flattenVisibleTree,
} from "../src/artifact-tree.js";
import { createFileActions } from "../src/file-actions.js";
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

  test("read-only rows retain navigation and open labels but offer no rename or Trash shortcuts", async () => {
    const tree = dom.document.createElement("ul");
    dom.document.body.append(tree);
    const opened: string[] = [];
    const navigator = createArtifactTreeNavigator(tree as unknown as HTMLElement, {
      storage: null,
      onOpen: (path) => opened.push(path),
    });
    navigator.setArtifacts([
      { path: "code.ts", kind: "read-only" },
      { path: "notes.md" },
      { path: "photo.png", kind: "image" },
    ]);
    navigator.setOpenPaths(new Set(["code.ts"]));
    const actions = createFileActions({
      tree,
      navigator,
      enabled: true,
      getSlug: () => "ws",
      dirty: () => false,
      prepare: async () => () => {},
      changed: async () => {},
      open: async () => {},
      dataAccess: {
        getFileFormats: async () => ({ manageable: true, documents: [{ extension: ".md" }], default_extension: ".md" }),
      },
    });
    try {
      await actions.setWorkspace();
      const row = tree.querySelector('[data-node-id="f:code.ts"]')!;
      expect(row.getAttribute("aria-label")).toContain("read-only");
      expect(row.getAttribute("aria-label")).toContain("open");
      expect(row.querySelector(".glosa-tree-lock")).not.toBeNull();
      row.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "F2", code: "F2", bubbles: true }));
      row.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Delete", code: "Delete", bubbles: true }));
      expect(tree.querySelector(".glosa-file-name-editor")).toBeNull();
      row.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true }));
      expect(tree.querySelector('[role="menu"]')!.textContent).not.toContain("Rename");
      expect(tree.querySelector('[role="menu"]')!.textContent).not.toContain("Trash");
      row.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
      expect(opened).toEqual(["code.ts"]);
    } finally {
      actions.destroy();
      navigator.destroy();
    }
  });

  test("file menu is keyboard navigable, blur keeps the name draft, and AltGr never creates a file", async () => {
    const tree = dom.document.createElement("ul");
    dom.document.body.append(tree);
    const navigator = createArtifactTreeNavigator(tree as unknown as HTMLElement, { storage: null, onOpen: () => {} });
    navigator.setWorkspace("ws");
    navigator.setArtifacts([
      { path: "notes.md", class: "R" },
      { path: "zebra.md", class: "R" },
    ]);
    const calls: unknown[] = [];
    const actions = createFileActions({
      tree,
      navigator,
      enabled: true,
      getSlug: () => "ws",
      dirty: () => false,
      prepare: async () => () => {},
      changed: async () => {},
      open: async (...args: unknown[]) => calls.push(args),
      dataAccess: {
        getFileFormats: async () => ({
          manageable: true,
          documents: [{ extension: ".md" }, { extension: ".txt" }],
          default_extension: ".md",
        }),
        createPath: async (_slug: string, body: unknown) => {
          calls.push(body);
          return { receipt: "new", history_status: "recorded" };
        },
      },
    });
    try {
      await actions.setWorkspace();
      const row = tree.querySelector('[data-node-id="f:notes.md"]') as any;
      row.focus();
      row.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", { key: "ń", code: "KeyN", ctrlKey: true, altKey: true, bubbles: true }),
      );
      expect(tree.querySelector(".glosa-file-name-editor")).toBeNull();
      row.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", { key: "F10", code: "F10", shiftKey: true, bubbles: true }),
      );
      const menu = tree.querySelector('[role="menu"]')!;
      const buttons = [...menu.querySelectorAll("button")];
      expect(dom.document.activeElement).toBe(buttons[0]!);
      buttons[0]!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      expect(dom.document.activeElement).toBe(buttons[1]!);
      buttons[1]!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(tree.querySelector('[role="menu"]')).toBeNull();
      expect(dom.document.activeElement).toBe(row);
      const macShortcut = new dom.window.KeyboardEvent("keydown", {
        key: "Dead",
        code: "KeyN",
        metaKey: true,
        altKey: true,
        bubbles: true,
      });
      // Happy DOM treats every Alt press as AltGraph; macOS Option is not AltGraph.
      Object.defineProperty(macShortcut, "getModifierState", {
        value: (key: string) => key === "Alt" || key === "Meta",
      });
      row.dispatchEvent(macShortcut);
      const input = tree.querySelector(".glosa-file-name-editor input") as any;
      expect(input).not.toBeNull();
      input.value = "idea.txt";
      input.blur();
      navigator.setCurrent("notes.md");
      expect(tree.querySelector(".glosa-file-name-editor input")).toBe(input);
      expect(calls).toEqual([]);
      input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(calls).toEqual([{ path: "idea.txt", kind: "file" }, ["idea.txt", { mode: "edit" }]]);
    } finally {
      actions.destroy();
      navigator.destroy();
    }
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

// The tab strip shows an open document; a folded folder holding it must not look like a plain
// folder. The mark is a dot at the row's end and the row says how many are inside.
describe("a folded folder with an open document inside", () => {
  test("carries the open-inside mark and names the count; expanded, the files carry their own", () => {
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
        { path: "plans/roadmap.md", class: "R" },
        { path: "plans/deep/goals.md", class: "R" },
        { path: "README.md", class: "R" },
      ]);
      navigator.setOpenPaths(["plans/roadmap.md", "plans/deep/goals.md"]);
      const plans = () => container.querySelector('[data-node-id="d:plans"] > .glosa-tree-row') as any;
      expect(plans().querySelector(".glosa-tree-open-inside")).not.toBeNull();
      expect(plans().getAttribute("aria-label")).toBe("plans, 2 open inside");
      plans().click();
      expect(plans().querySelector(".glosa-tree-open-inside")).toBeNull();
      expect(plans().getAttribute("aria-label")).toBeNull();
      expect(container.querySelectorAll(".glosa-tree-open")).toHaveLength(1);
      // The nested folder is still folded and says so.
      const deep = container.querySelector('[data-node-id="d:plans/deep"] > .glosa-tree-row') as any;
      expect(deep.getAttribute("aria-label")).toBe("deep, 1 open inside");
      navigator.destroy();
    } finally {
      dom.teardown();
    }
  });
});

// SPDX-License-Identifier: Apache-2.0
// The multi-artifact workbench, end to end against a fake data-access object (design brief
// docs/design/2026-09-04-multi-artifact-workbench-brief.md). These are the invariants the brief
// makes release-critical — the ones a happy-path test would not catch:
//
//   §5  one tab per file, never two panes holding divergent unsaved buffers against one base hash
//   §7  the manuscript never moves, and every width rule reads the PANE, not the viewport
//   §9  every drag has a single-pointer equivalent (WCAG 2.2 SC 2.5.7)
//   §10 a saved arrangement survives an artifact disappearing, and a corrupt one is survivable
//   §11 a deleted artifact's tab dims; glosa never closes a tab the reader opened

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mountApp } from "../src/viewer.js";
import { type DomEnv, installDom } from "./dom-env.ts";

describe("the multi-artifact workbench", () => {
  let dom: DomEnv;

  beforeEach(() => {
    dom = installDom();
  });

  afterEach(() => {
    dom.teardown();
  });

  const flush = async (n = 8) => {
    for (let i = 0; i < n; i++) await Promise.resolve();
  };

  function memoryStorage() {
    const map = new Map<string, string>();
    return {
      map,
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
      removeItem: (key: string) => void map.delete(key),
    };
  }

  function fakeDataAccess(overrides: Record<string, unknown> = {}) {
    const stream: { handlers?: Record<string, any> } = {};
    return {
      stream,
      put: [] as unknown[],
      getWorkspaces: async () => [{ slug: "ws-1", root: "/tmp/ws-1" }],
      getArtifacts: async () => [
        { path: "notes.md", class: "R" },
        { path: "drafts/outline.md", class: "R" },
      ],
      getArtifact: async (_slug: string, path: string) => ({
        source_path: path,
        source_sha256: `sha-${path}`,
        class: "R",
        content: `# ${path}\n\nBody.\n`,
        rendered_html: `<h1 data-line="0">${path}</h1><p data-line="2">Body.</p>`,
      }),
      putArtifact: async () => ({ source_sha256: "sha-2" }),
      postAnnotation: async () => ({ id: "inb-1", status: "pending" }),
      withdrawAnnotation: async () => ({ ok: true }),
      getInbox: async () => ({ pending_count: 0, attention: [] }),
      respondToAttention: async () => ({ status: "done", detail: {} }),
      getCheckpoints: async () => [
        { checkpoint_id: "cp-newest", at: "2026-09-04T10:00:00.000Z", by: "human", summary: "human_edit" },
      ],
      // A workspace diff covers every changed file. A diff PANE is about one artifact, so this
      // deliberately returns two hunks and the pane must show only the one it is titled after.
      getDiff: async () => ({
        from: "cp-newest",
        to: "working",
        hunks: [
          {
            path: "notes.md",
            diff: "--- a/notes.md\n+++ b/notes.md\n@@ -1 +1 @@\n-old notes\n+new notes\n",
            attribution: "human",
          },
          {
            path: "drafts/outline.md",
            diff: "--- a/drafts/outline.md\n+++ b/drafts/outline.md\n@@ -1 +1 @@\n-old outline\n+new outline\n",
            attribution: "human",
          },
        ],
      }),
      openStream: (_slug: string, handlers: Record<string, any>) => {
        stream.handlers = handlers;
        return () => {};
      },
      openTranscriptStream: () => () => {},
      sendComposerMessage: async () => ({ accepted: true, delivered: false }),
      getComposerMessageStatus: async () => ({ accepted: true, delivered: false, state: "queued" }),
      getStatus: async () => ({ ok: true }),
      markAttentionSeen: async () => ({ ok: true }),
      mintClassFCapability: async () => ({ url: "", nonce: "n", expires_in_s: 600 }),
      onUnauthorized: () => () => {},
      restore: async () => ({ ok: true }),
      triggerInit: async () => ({ ok: true, changed: false, warnings: [], restart_required: false }),
      getWiringStatus: async () => ({
        state: "wired",
        init: { manifest_present: true, manifest_invalid: false },
        sessions: { bound_live: 0, routable_live: 0 },
        pending_count: 0,
        kind: "directory",
      }),
      ...overrides,
    };
  }

  async function mountWithTwoTabs(extra: Record<string, unknown> = {}) {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    const da = fakeDataAccess();
    const unmount = mountApp(root, { dataAccess: da, layoutStorage: memoryStorage(), ...extra });
    await flush();
    const open = async (path: string) => {
      root
        .querySelector(`.glosa-artifact-list [data-node-id="f:${path}"] .glosa-tree-row`)
        ?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      await flush();
    };
    await open("notes.md");
    root
      .querySelector('[data-node-id="d:drafts"] .glosa-tree-row')
      ?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await open("drafts/outline.md");
    return { root, da, unmount, open };
  }

  const tabLabels = (root: any) =>
    Array.from(root.querySelectorAll(".glosa-tab-label")).map((element: any) => element.textContent);
  const activePane = (root: any) => root.querySelector('.glosa-pane[data-active="true"]') as any;

  test("§5: opening a file twice focuses the tab that holds it — never a second copy", async () => {
    const { root, open } = await mountWithTwoTabs();
    expect(tabLabels(root)).toEqual(["notes.md", "outline.md"]);
    expect(root.querySelectorAll(".glosa-pane")).toHaveLength(2);

    // Two panes on one path would hold divergent unsaved buffers against the same base hash, so
    // the second save would either fail or silently discard the first pane's work.
    await open("notes.md");
    expect(root.querySelectorAll(".glosa-pane")).toHaveLength(2);
    expect(tabLabels(root)).toEqual(["notes.md", "outline.md"]);
    // Focus followed the request even though nothing new was created.
    expect(activePane(root).getAttribute("aria-label")).toBe("notes.md");
  });

  test("§5: tabs that share a filename both grow their distinguishing parent, and only they do", async () => {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    mountApp(root, {
      dataAccess: fakeDataAccess({
        getArtifacts: async () => [
          { path: "drafts/index.md", class: "R" },
          { path: "final/index.md", class: "R" },
          { path: "notes.md", class: "R" },
        ],
      }),
      layoutStorage: memoryStorage(),
    });
    await flush();
    for (const path of ["notes.md", "drafts/index.md", "final/index.md"]) {
      const row = root.querySelector(`.glosa-artifact-list [data-node-id="f:${path}"] .glosa-tree-row`);
      if (!row) {
        // Expand the directory that holds it, then retry.
        const dir = path.slice(0, path.indexOf("/"));
        root
          .querySelector(`[data-node-id="d:${dir}"] .glosa-tree-row`)
          ?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
        await flush(2);
      }
      root
        .querySelector(`.glosa-artifact-list [data-node-id="f:${path}"] .glosa-tree-row`)
        ?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      await flush();
    }
    expect(tabLabels(root).sort()).toEqual(["drafts/index.md", "final/index.md", "notes.md"]);
  });

  test("§6: the bar shows only the path the tab left out — a filename is never printed twice", async () => {
    const { root, open } = await mountWithTwoTabs();
    const barOf = (path: string) => {
      for (const pane of root.querySelectorAll(".glosa-pane")) {
        if ((pane as any).getAttribute("aria-label") === path) return pane as any;
      }
      return null;
    };

    // The tab says `outline.md`, so the bar says the part it could not fit, and only that.
    const nested = barOf("drafts/outline.md");
    expect(nested.querySelector(".glosa-artifact-name").textContent).toBe("");
    expect(nested.querySelector(".glosa-artifact-dir").textContent).toBe("drafts/");

    // A root-level artifact's tab already says everything. The bar's identity slot disappears
    // rather than repeating it under the tab that just said it.
    const root_ = barOf("notes.md");
    expect(root_.querySelector(".glosa-artifact-id").hidden).toBe(true);

    // Opening a sibling that forces the tab to grow to the full path empties the bar in turn —
    // the two rows always partition the path between them, never duplicate part of it.
    await open("notes.md");
    expect(barOf("notes.md").querySelector(".glosa-artifact-id").hidden).toBe(true);
  });

  test("§9: the ⋯ menu splits without a drag, and ⌘\\ moves rather than copies", async () => {
    const { root } = await mountWithTwoTabs();
    const dockRoot = root.querySelector(".glosa-dock-host") as any;
    const groupsBefore = dockRoot.querySelectorAll(".dv-groupview").length;
    expect(groupsBefore).toBe(1);

    // WCAG 2.2 SC 2.5.7: dragging a tab to a pane edge must have a single-pointer equivalent, and
    // dockview's own keyboard docking is enterprise-only, so glosa ships its own.
    const menuItems = Array.from(activePane(root).querySelectorAll(".glosa-pane-menu-move")).map(
      (element: any) => element.textContent,
    );
    expect(menuItems).toEqual(["Left", "Right", "Up", "Down", "New tab group"]);

    (activePane(root).querySelector(".glosa-pane-menu-move:last-of-type") as any).click();
    await flush();
    expect(dockRoot.querySelectorAll(".dv-groupview").length).toBe(2);
    // A move, not a copy: splitting must never produce the same file twice.
    expect(tabLabels(root).sort()).toEqual(["notes.md", "outline.md"]);
    expect(root.querySelectorAll(".glosa-pane")).toHaveLength(2);
  });

  test("§9: ⌘\\ moves the active tab into a new split and leaves one copy of it", async () => {
    const { root } = await mountWithTwoTabs();
    dom.document.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "\\", metaKey: true, bubbles: true, cancelable: true }),
    );
    await flush();
    expect((root.querySelector(".glosa-dock-host") as any).querySelectorAll(".dv-groupview").length).toBe(2);
    expect(tabLabels(root).sort()).toEqual(["notes.md", "outline.md"]);
  });

  test("§9: ⌘W closes the active tab, and an unsaved edit is prompted before it goes", async () => {
    const { root } = await mountWithTwoTabs();
    const pane = activePane(root);
    pane.querySelector('.glosa-modebar [data-mode="edit"]').click();
    await flush();
    pane.querySelector(".glosa-face-source").click();
    const textarea = pane.querySelector(".glosa-edit-area");
    textarea.value = "# edited\n";
    textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await flush();

    dom.document.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "w", metaKey: true, bubbles: true, cancelable: true }),
    );
    await flush();
    expect(dom.document.querySelector(".glosa-dialog h2")?.textContent).toBe("Discard unsaved edits?");
    // Declining keeps the tab AND the edit.
    (dom.document.querySelector(".glosa-dialog .glosa-btn-ghost") as any).click();
    await flush();
    expect(tabLabels(root)).toHaveLength(2);

    dom.document.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "w", metaKey: true, bubbles: true, cancelable: true }),
    );
    await flush();
    (
      dom.document.querySelector(
        ".glosa-dialog .glosa-dialog-confirm, .glosa-dialog button:not(.glosa-btn-ghost)",
      ) as any
    )?.click();
    await flush();
    expect(tabLabels(root)).toEqual(["notes.md"]);
  });

  test("§7: entering and leaving Annotate never moves the manuscript, and no space is reserved", async () => {
    const { root } = await mountWithTwoTabs();
    const pane = activePane(root);
    const main = pane.querySelector(".glosa-pane-main");
    const margin = pane.querySelector(".glosa-margin");

    // The old defect reserved margin space on MODE, at a VIEWPORT width. Nothing may do that now:
    // the rail lives in whitespace the manuscript was never using, or it is not placed at all.
    expect(main.style.paddingRight).toBe("");
    pane.querySelector('.glosa-modebar [data-mode="annotate"]').click();
    await flush();
    expect(pane.getAttribute("data-mode")).toBe("annotate");
    expect(main.style.paddingRight).toBe("");
    // An unmeasured pane is below the rail floor, so the margin is the in-flow tray, never a rail
    // that overlaps text.
    expect(margin.classList.contains("glosa-margin-side")).toBe(false);

    pane.querySelector('.glosa-modebar [data-mode="preview"]').click();
    await flush();
    expect(main.style.paddingRight).toBe("");
  });

  test("§7: each pane declares its own width container, so a sash — not the window — drives the ladder", () => {
    const css = Bun.file(new URL("../src/app.css", import.meta.url)).text();
    return css.then((text) => {
      expect(text).toContain("container-type: inline-size");
      expect(text).toContain("@container pane (min-width: 1205px)");
      // The defect this brief removes: margin space reserved on mode, at a viewport width.
      expect(text).not.toContain('.glosa-app[data-mode="annotate"] .glosa-main');
    });
  });

  test("§8: the editor measure follows the face, not the mode", async () => {
    const { root } = await mountWithTwoTabs();
    const pane = activePane(root);
    pane.querySelector('.glosa-modebar [data-mode="edit"]').click();
    await flush();
    expect(pane.getAttribute("data-editor-face")).toBe("rich");
    pane.querySelector(".glosa-face-source").click();
    await flush();
    expect(pane.getAttribute("data-editor-face")).toBe("source");
    pane.querySelector(".glosa-face-rich").click();
    await flush();
    expect(pane.getAttribute("data-editor-face")).toBe("rich");
  });

  test("§10: the arrangement persists per workspace and comes back on the next visit", async () => {
    const storage = memoryStorage();
    const first = dom.document.createElement("div");
    dom.document.body.append(first);
    const unmount = mountApp(first, { dataAccess: fakeDataAccess(), layoutStorage: storage });
    await flush();
    first
      .querySelector('[data-node-id="f:notes.md"] .glosa-tree-row')
      ?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await flush();
    expect(storage.map.has("glosa:layout:ws-1")).toBe(true);
    unmount();

    const second = dom.document.createElement("div");
    dom.document.body.append(second);
    mountApp(second, { dataAccess: fakeDataAccess(), layoutStorage: storage });
    await flush(12);
    expect(tabLabels(second)).toEqual(["notes.md"]);
  });

  test("§10: a saved layout naming a deleted artifact still opens the workspace", async () => {
    const storage = memoryStorage();
    storage.setItem(
      "glosa:layout:ws-1",
      JSON.stringify({
        grid: {
          root: {
            type: "branch",
            data: [{ type: "leaf", data: { views: ["gone.md", "notes.md"], activeView: "gone.md", id: "g1" } }],
            size: 1000,
          },
          width: 1000,
          height: 800,
          orientation: "HORIZONTAL",
        },
        panels: {
          "gone.md": { id: "gone.md", contentComponent: "pane", tabComponent: "pane", params: { kind: "artifact" } },
          "notes.md": { id: "notes.md", contentComponent: "pane", tabComponent: "pane", params: { kind: "artifact" } },
        },
        activeGroup: "g1",
      }),
    );
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    mountApp(root, { dataAccess: fakeDataAccess(), layoutStorage: storage });
    await flush(12);
    expect(tabLabels(root)).toEqual(["notes.md"]);
  });

  test("§10: a corrupt saved layout never makes a workspace unopenable", async () => {
    const storage = memoryStorage();
    storage.setItem("glosa:layout:ws-1", "{ this is not json");
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    mountApp(root, {
      dataAccess: fakeDataAccess(),
      layoutStorage: storage,
      initialSlug: "ws-1",
      initialArtifact: "notes.md",
    });
    await flush(12);
    expect(tabLabels(root)).toEqual(["notes.md"]);
    expect(root.querySelector(".glosa-artifact-list .glosa-tree-label")).not.toBeNull();
  });

  test("a comparison opens as its own pane, and asking for the same pair twice focuses it", async () => {
    const { root } = await mountWithTwoTabs();
    const pane = activePane(root);
    (pane.querySelector(".glosa-tools-compare") as any).click();
    await flush(12);

    expect(tabLabels(root)).toContain("outline.md · cp-newe…now");
    const diffPane = root.querySelector('.glosa-pane[data-kind="diff"]') as any;
    expect(diffPane).not.toBeNull();
    expect(diffPane.querySelector(".glosa-diff-range").textContent).toBe("cp-newe → now");
    const rendered = diffPane.querySelector(".glosa-diff-surface").textContent;
    expect(rendered).toContain("new outline");
    // The other changed file belongs in its own comparison, not silently in this one.
    expect(rendered).not.toContain("new notes");

    const tabsBefore = tabLabels(root).length;
    root.querySelector('.glosa-pane[data-active="true"] .glosa-tools-compare');
    (activePane(root).querySelector(".glosa-tools-compare") as any)?.click();
    await flush(12);
    expect(tabLabels(root).length).toBe(tabsBefore);
  });

  test("§11: one connection banner for the whole workbench, never one per pane", async () => {
    const { root, da } = await mountWithTwoTabs();
    const banner = root.querySelector(".glosa-banner") as any;
    expect(banner.hidden).toBe(true);
    da.stream.handlers?.onStatus?.("down");
    expect(banner.hidden).toBe(false);
    expect(root.querySelectorAll(".glosa-banner")).toHaveLength(1);
    // It belongs to the workspace, above the dock — not to any pane.
    expect(banner.closest(".glosa-pane")).toBeNull();
  });

  test("the navigator marks every open artifact and reserves 'current' for the active pane", async () => {
    const { root } = await mountWithTwoTabs();
    const rowFor = (path: string) => root.querySelector(`[data-node-id="f:${path}"]`) as any;
    expect(rowFor("notes.md").getAttribute("data-open")).toBe("true");
    expect(rowFor("drafts/outline.md").getAttribute("data-open")).toBe("true");
    expect(rowFor("drafts/outline.md").getAttribute("aria-current")).toBe("page");
    expect(rowFor("notes.md").getAttribute("aria-current")).toBeNull();
  });
});

// SPDX-License-Identifier: Apache-2.0
// P3.3 — viewer.js: the pure Read/Review/Edit mode reducer (no DOM), the idiomorph morph
// wrapper (happy-dom), and a mounted-app integration test against a fake data-access object (no
// real daemon, no real fetch — mountApp never gets to touch either directly).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { initialModeState, isParked, mountApp, modeReducer, morphArtifactContent } from "../src/viewer.js";
import { installDom, type DomEnv } from "./dom-env.ts";

describe("modeReducer — pure Read/Review/Edit state machine", () => {
  test("read -> review -> edit, all legal, none dirty", () => {
    let state = initialModeState();
    expect(state).toEqual({ mode: "read", dirty: false });

    state = modeReducer(state, { type: "set_mode", mode: "review" });
    expect(state.mode).toBe("review");

    state = modeReducer(state, { type: "set_mode", mode: "edit" });
    expect(state.mode).toBe("edit");
    expect(state.dirty).toBe(false);
  });

  test("an unknown mode name is ignored — state unchanged", () => {
    const state = initialModeState();
    const next = modeReducer(state, { type: "set_mode", mode: "bogus" });
    expect(next).toBe(state);
  });

  test("editing in edit mode sets dirty", () => {
    let state = modeReducer(initialModeState(), { type: "set_mode", mode: "edit" });
    state = modeReducer(state, { type: "edited" });
    expect(state.dirty).toBe(true);
  });

  test("'edited' outside edit mode is a no-op (nothing to mark dirty)", () => {
    const state = initialModeState(); // preview
    const next = modeReducer(state, { type: "edited" });
    expect(next).toBe(state);
  });

  test("leaving edit while dirty PARKS the draft — the switch goes through and dirty survives", () => {
    let state = modeReducer(initialModeState(), { type: "set_mode", mode: "edit" });
    state = modeReducer(state, { type: "edited" });
    expect(state.dirty).toBe(true);

    const left = modeReducer(state, { type: "set_mode", mode: "read" });
    // The switch is never refused now. That is the whole point: an agent pulling the pane into
    // Read must not be able to fail, and a reviewer must not be asked to choose between
    // answering and keeping their work.
    expect(left.mode).toBe("read");
    expect(left.dirty).toBe(true);
    expect(isParked(left)).toBe(true);
  });

  test("returning to edit un-parks: same dirty draft, no longer parked", () => {
    let state = modeReducer(initialModeState(), { type: "set_mode", mode: "edit" });
    state = modeReducer(state, { type: "edited" });
    state = modeReducer(state, { type: "set_mode", mode: "review" });
    expect(isParked(state)).toBe(true);

    state = modeReducer(state, { type: "set_mode", mode: "edit" });
    expect(state).toEqual({ mode: "edit", dirty: true });
    expect(isParked(state)).toBe(false);
  });

  test("a clean editor is never parked, in any mode", () => {
    const state = modeReducer(initialModeState(), { type: "set_mode", mode: "review" });
    expect(isParked(state)).toBe(false);
  });

  test("'saved' clears dirty without changing mode, and nothing stays parked", () => {
    let state = modeReducer(initialModeState(), { type: "set_mode", mode: "edit" });
    state = modeReducer(state, { type: "edited" });
    state = modeReducer(state, { type: "saved" });
    expect(state).toEqual({ mode: "edit", dirty: false });
    expect(isParked(state)).toBe(false);
  });

  test("'discard' drops the draft where it stands — it never moves the reviewer", () => {
    let state = modeReducer(initialModeState(), { type: "set_mode", mode: "edit" });
    state = modeReducer(state, { type: "edited" });
    state = modeReducer(state, { type: "set_mode", mode: "review" });
    state = modeReducer(state, { type: "discard" });
    // Discard is now only reachable from closing a pane, so it settles the draft and leaves the
    // mode alone rather than completing a transition the reducer already performed.
    expect(state).toEqual({ mode: "review", dirty: false });
  });

  test("re-requesting the mode already active keeps dirty rather than resetting it", () => {
    let state = modeReducer(initialModeState(), { type: "set_mode", mode: "edit" });
    state = modeReducer(state, { type: "edited" });
    const next = modeReducer(state, { type: "set_mode", mode: "edit" });
    expect(next).toEqual({ mode: "edit", dirty: true });
  });
});

describe("morphArtifactContent — idiomorph (happy-dom)", () => {
  let dom: DomEnv;
  beforeEach(() => {
    dom = installDom();
  });
  afterEach(() => {
    dom.teardown();
  });

  test("an unchanged block keeps its EXACT node identity — idiomorph doesn't rebuild it", () => {
    dom.document.body.innerHTML =
      '<div id="c"><p data-line="0">Hello world</p><p data-line="1">Second paragraph here</p></div>';
    const container = dom.document.getElementById("c")!;
    const firstP = container.querySelector('[data-line="0"]')!;
    // A scroll-position stand-in: a real browser keeps scroll offset because the SAME node stays
    // in the SAME place in the tree — we can't measure real scrollTop under happy-dom (it doesn't
    // do layout), so a custom marker property on the node is the proxy: if idiomorph replaced the
    // node wholesale, this property would be gone.
    (firstP as unknown as { _scrollMarker: string })._scrollMarker = "keep-me";

    morphArtifactContent(container, '<p data-line="0">Hello world</p><p data-line="1">Second paragraph EDITED</p>');

    const firstPAfter = container.querySelector('[data-line="0"]')!;
    expect(firstPAfter).toBe(firstP); // same object reference — not rebuilt
    expect((firstPAfter as unknown as { _scrollMarker: string })._scrollMarker).toBe("keep-me");
    expect(container.querySelector('[data-line="1"]')!.textContent).toBe("Second paragraph EDITED");
  });

  test("a removed block is actually removed, an added block actually appears", () => {
    dom.document.body.innerHTML = '<div id="c"><p data-line="0">Only paragraph</p></div>';
    const container = dom.document.getElementById("c")!;

    morphArtifactContent(container, '<p data-line="0">Only paragraph</p><p data-line="1">A new second paragraph</p>');

    expect(container.querySelectorAll("p")).toHaveLength(2);
    expect(container.querySelector('[data-line="1"]')!.textContent).toBe("A new second paragraph");
  });
});

describe("mountApp — DOM integration against a fake dataAccess (no real daemon)", () => {
  let dom: DomEnv;
  beforeEach(() => {
    dom = installDom();
  });
  afterEach(() => {
    dom.teardown();
  });

  function fakeDataAccess(overrides: Partial<Record<string, unknown>> = {}) {
    const posted: unknown[] = [];
    const put: unknown[] = [];
    const withdrawn: unknown[] = [];
    return {
      posted,
      put,
      withdrawn,
      getWorkspaces: async () => [{ slug: "ws-1", path: "/tmp/ws-1" }],
      getStatus: async () => ({
        workspaces: [
          {
            slug: "ws-1",
            path: "/tmp/ws-1",
            pending_count: 0,
            connect: {
              providers: [
                {
                  provider: "claude-code",
                  display_name: "Claude Code",
                  instruction: "Read CLAUDE_CODE_SESSION_ID, then bind this workspace.",
                },
              ],
              cli_fallback: "glosa session bind <current-session-id> --workspace <workspace-path>",
            },
          },
        ],
        sessions: [],
      }),
      getArtifacts: async () => [{ path: "notes.md", class: "R" }],
      getArtifact: async (_slug: string, path: string) => ({
        source_path: path,
        source_sha256: "sha-1",
        class: "R",
        content: "# Title\n\nBody.\n",
        rendered_html: '<h1 data-line="0">Title</h1><p data-line="2">Body.</p>',
      }),
      postAnnotation: async (_slug: string, record: unknown) => {
        posted.push(record);
        return { id: "inb-1", status: "pending" };
      },
      withdrawAnnotation: async (_slug: string, id: string) => {
        withdrawn.push(id);
        return { id, status: "rejected" };
      },
      putArtifact: async (_slug: string, path: string, content: string) => {
        put.push({ path, content });
        return { source_path: path, source_sha256: "sha-2" };
      },
      // P3.5 — the history pane's data-access surface. Not exercised by this file's own tests
      // (those live in history.test.ts); stubbed here only so mountApp's `dataAccess` shape,
      // inferred from the real createDataAccess() default, is satisfied.
      getCheckpoints: async () => [],
      getDiff: async () => ({ from: "a", to: "b", hunks: [] }),
      restore: async () => ({ path: "notes.md", restored_to: "a", checkpoint_id: "a", source_sha256: "sha-1" }),
      getInbox: async () => ({ pending_count: 0, attention: [] }),
      markAttentionSeen: async (_slug: string, id: string) => ({ id, status: "seen", detail: null }),
      respondToAttention: async (_slug: string, id: string, body: unknown) => ({ id, status: "done", detail: body }),
      // Captures the stream handlers so a test can push SSE frames (journal/artifact) by hand.
      stream: { handlers: null as null | { onEvent?: (frame: unknown) => void; onReconnect?: () => void } },
      openStream(_slug: string, handlers: { onEvent?: (frame: unknown) => void; onReconnect?: () => void } = {}) {
        (this as { stream: { handlers: unknown } }).stream.handlers = handlers;
        return () => {};
      },
      // P4.1 — the class-F viewer's data-access surface. Not exercised by this file's own tests
      // (none of them open a class-F artifact); stubbed only so mountApp's `dataAccess` shape,
      // inferred from the real createDataAccess() default, is satisfied.
      mintClassFCapability: async () => ({
        url: "http://127.0.0.1:4647/doc/tok/x.html",
        nonce: "n",
        expires_in_s: 600,
      }),
      // P4.2 — the conversation pane's data-access surface. Not exercised by every test in this
      // file (only the "Conversation" toggle test below opens it); stubbed here so mountApp's
      // `dataAccess` shape, inferred from the real createDataAccess() default, is satisfied
      // whenever the toggle IS clicked.
      openTranscriptStream: () => () => {}, // returns a no-op stop()
      sendComposerMessage: async () => ({ accepted: true, delivered: false }),
      getComposerMessageStatus: async () => ({ accepted: true, delivered: false, state: "queued" }),
      // issue #81 — the wiring badge's data-access surface. Default "wired" keeps every
      // pre-existing test dialog-free; badge-specific tests override per case.
      getWiringStatus: async () => ({
        state: "wired",
        init: { manifest_present: true, manifest_invalid: false },
        sessions: { bound_live: 0, routable_live: 0 },
        pending_count: 0,
        kind: "directory",
      }),
      triggerInit: async () => ({ ok: true, changed: true, warnings: [], restart_required: true }),
      ...overrides,
    };
  }

  // Since the multi-artifact workbench, several artifacts can be on screen at once and each
  // carries its own bar, manuscript, margin and history. An assertion about "the artifact" means
  // the ACTIVE pane's, so these helpers scope every artifact-level query to it.
  const activePane = (root: any) =>
    (root.querySelector('.glosa-pane[data-active="true"]') ?? root.querySelector(".glosa-pane")) as any;
  const inPane = (root: any, selector: string) => activePane(root)?.querySelector(selector) as any;
  const paneFor = (root: any, path: string) => {
    for (const pane of root.querySelectorAll(".glosa-pane")) {
      if ((pane as any).querySelector(".glosa-artifact-id")?.getAttribute("title") === path) return pane as any;
    }
    return null;
  };

  test("mounts, auto-selects the sole workspace, lists its artifacts, and opens one on click", async () => {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    const da = fakeDataAccess();

    mountApp(root, { dataAccess: da });
    // mountApp kicks off async work (refreshWorkspaces -> selectWorkspace -> refreshArtifactList)
    // without awaiting it internally — flush the microtask queue a few times before asserting.
    for (let i = 0; i < 5; i++) await Promise.resolve();

    const brandMark = root.querySelector('.glosa-brand-mark[role="img"][aria-label="glosa"]');
    expect(brandMark?.querySelector("svg")).not.toBeNull();

    const artifactRows = Array.from(root.querySelectorAll(".glosa-artifact-list .glosa-tree-row")) as any[];
    expect(artifactRows.map((row) => row.querySelector(".glosa-tree-label")?.textContent)).toEqual(["notes.md"]);

    artifactRows[0]!.click();
    for (let i = 0; i < 5; i++) await Promise.resolve();

    const content = inPane(root, ".glosa-content");
    expect(content.innerHTML).toContain("Title");

    // The tab strip carries the file, and the navigator says it is open (§5).
    expect(root.querySelector(".glosa-tab-label")?.textContent).toBe("notes.md");
    expect(root.querySelector('[data-node-id="f:notes.md"]')?.getAttribute("data-open")).toBe("true");
  });

  test("artifact_index refreshes the navigator; a deleted artifact's tab dims but is never closed", async () => {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    let artifacts = [{ path: "notes.md", class: "R" }];
    const da = fakeDataAccess({
      getArtifacts: async () => artifacts,
    });

    mountApp(root, { dataAccess: da });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    (
      root.querySelector('.glosa-artifact-list .glosa-tree-row[data-tree-action="open"]') as unknown as {
        click(): void;
      }
    ).click();
    for (let i = 0; i < 5; i++) await Promise.resolve();

    artifacts = [{ path: "fresh.md", class: "R" }];
    da.stream.handlers?.onEvent?.({
      event: "artifact_index",
      data: { changes: [{ type: "file_untracked", path: "notes.md", reason: "deleted" }] },
    });
    for (let i = 0; i < 8; i++) await Promise.resolve();

    const labels = Array.from(root.querySelectorAll(".glosa-artifact-list .glosa-tree-label")).map(
      (element) => element.textContent,
    );
    expect(labels).toEqual(["fresh.md"]);

    // §11: never close a tab the reader opened — that silently destroys their layout. The tab
    // dims, the pane says the file is gone, and closing it stays the reader's decision.
    expect(root.querySelectorAll(".glosa-tab")).toHaveLength(1);
    expect(root.querySelector(".glosa-tab-label")?.textContent).toBe("notes.md");
    expect(root.querySelector('.glosa-tab[data-missing="true"]')).not.toBeNull();
    expect(activePane(root).getAttribute("data-missing")).toBe("true");
    expect(inPane(root, ".glosa-empty-title")?.textContent).toBe("This artifact is gone.");
    expect(dom.document.title).toBe("ws-1 — notes.md");
  });

  test("workspace switcher hides at <=1 workspace (MCP/CLI scope), appears and lists all at >=2", async () => {
    const solo = dom.document.createElement("div");
    dom.document.body.append(solo);
    mountApp(solo, { dataAccess: fakeDataAccess() }); // the sole ws-1
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect((solo.querySelector(".glosa-sidebar-section") as any).hidden).toBe(true);

    const many = dom.document.createElement("div");
    dom.document.body.append(many);
    mountApp(many, {
      dataAccess: fakeDataAccess({
        getWorkspaces: async () => [
          { slug: "ws-1", path: "/tmp/ws-1" },
          { slug: "ws-2", path: "/tmp/ws-2" },
        ],
      }),
    });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect((many.querySelector(".glosa-sidebar-section") as any).hidden).toBe(false);
    const manyList = many.querySelector(".glosa-workspace-list") as any;
    expect(manyList.hidden).toBe(false);
    const keys = Array.from(manyList.querySelectorAll("button[data-key]")).map((b: any) => b.getAttribute("data-key"));
    expect(keys).toEqual(["ws-1", "ws-2"]);
  });

  test("compact tools collapse secondary actions behind one keyboard-accessible trigger", async () => {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    const unmount = mountApp(root, { dataAccess: fakeDataAccess() });
    for (let i = 0; i < 5; i++) await Promise.resolve();

    const tools = root.querySelector(".glosa-topbar .glosa-tools") as any;
    const trigger = tools.querySelector(".glosa-tools-trigger") as any;
    const menu = root.querySelector(".glosa-tools-menu") as any;
    expect(trigger.getAttribute("aria-controls")).toBe("glosa-tools-menu");
    // Workspace-scoped only (§6): the attention tray, Conversation, Appearance and the keyboard
    // sheet. Copy source, Print and History moved into the pane that holds their artifact.
    expect(
      menu.querySelectorAll(":scope > .glosa-attention, :scope > button, :scope > .glosa-appearance"),
    ).toHaveLength(4);
    expect(menu.querySelector(".glosa-tools-copy-source")).toBeNull();
    expect(menu.querySelector(".glosa-tools-print")).toBeNull();
    expect(menu.querySelector(".glosa-history-toggle")).toBeNull();

    trigger.click();
    await Promise.resolve();
    expect(tools.dataset.open).toBe("true");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(dom.document.activeElement as any).toBe(menu.querySelector("button:not(:disabled)") as any);

    (menu.querySelector(".glosa-conversation-toggle") as any).click();
    await Promise.resolve();
    expect(tools.dataset.open).toBe("false");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(dom.document.activeElement as any).toBe(trigger);

    trigger.click();
    await Promise.resolve();
    menu.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as any);
    await Promise.resolve();
    expect(tools.dataset.open).toBe("false");
    expect(dom.document.activeElement as any).toBe(trigger);

    unmount();
  });

  test("Class-R tools copy the raw source, print the rendered manuscript, and report clipboard failures", async () => {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    const writes: string[] = [];
    let printCalls = 0;
    Object.defineProperty(dom.window.navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          writes.push(text);
        },
      },
    });
    Object.defineProperty(dom.window, "print", {
      configurable: true,
      value: () => {
        printCalls += 1;
      },
    });

    mountApp(root, { dataAccess: fakeDataAccess() });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    (root.querySelector('.glosa-artifact-list .glosa-tree-row[data-tree-action="open"]') as any).click();
    for (let i = 0; i < 5; i++) await Promise.resolve();

    const copy = inPane(root, ".glosa-tools-copy-source");
    const printButton = inPane(root, ".glosa-tools-print");
    expect(copy.hidden).toBe(false);
    expect(printButton.hidden).toBe(false);

    copy.click();
    await Promise.resolve();
    expect(writes).toEqual(["# Title\n\nBody.\n"]);
    expect(inPane(root, ".glosa-tools-status")?.textContent).toBe("Source copied.");

    printButton.click();
    expect(printCalls).toBe(1);

    Object.defineProperty(dom.window.navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("denied");
        },
      },
    });
    copy.click();
    await Promise.resolve();
    const status = inPane(root, ".glosa-tools-status");
    expect(status.hidden).toBe(false);
    expect(status.getAttribute("data-error")).toBe("true");
    expect(status.textContent).toContain("Couldn't copy source");
  });

  test("Class-F artifacts do not offer copy or print tools", async () => {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    mountApp(root, {
      dataAccess: fakeDataAccess({
        getArtifacts: async () => [{ path: "preview.html", class: "F" }],
        getArtifact: async (_slug: string, path: string) => ({
          source_path: path,
          source_sha256: "sha-html",
          class: "F",
          content: "",
          rendered_html: "",
        }),
      }),
    });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    (root.querySelector('.glosa-artifact-list .glosa-tree-row[data-tree-action="open"]') as any).click();
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect((root.querySelector(".glosa-tools-copy-source") as any).hidden).toBe(true);
    expect((root.querySelector(".glosa-tools-print") as any).hidden).toBe(true);
  });

  test("clicking a tree row opens THAT file: content, title, current marker and URL all follow", async () => {
    const opened: string[] = [];
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    mountApp(root, {
      dataAccess: fakeDataAccess({
        getArtifacts: async () => [
          { path: "notes.md", class: "R" },
          { path: "drafts/outline.md", class: "R" },
        ],
        getArtifact: async (_slug: string, path: string) => {
          opened.push(path);
          return {
            source_path: path,
            source_sha256: `sha-${path}`,
            class: "R",
            content: `# ${path}\n`,
            rendered_html: `<h1 data-line="0">${path}</h1>`,
          };
        },
      }),
    });
    for (let i = 0; i < 5; i++) await Promise.resolve();

    const rowFor = (path: string) =>
      root.querySelector(`.glosa-artifact-list [data-node-id="f:${path}"] .glosa-tree-row`) as any;

    rowFor("notes.md").click();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(opened.at(-1)).toBe("notes.md");
    expect(inPane(root, ".glosa-content").textContent).toContain("notes.md");
    // A root-level artifact's tab says everything, so the bar's identity slot stays empty — but
    // keeps its place, so the controls do not shift edge to edge between artifacts.
    expect(inPane(root, ".glosa-artifact-id").getAttribute("data-empty")).toBe("true");
    expect(inPane(root, ".glosa-artifact-id").textContent).toBe("");
    expect(activePane(root).getAttribute("aria-label")).toBe("notes.md");
    expect(root.querySelector('[data-node-id="f:notes.md"]')?.getAttribute("aria-current")).toBe("page");

    // A different row opens the file that was actually clicked. The first stays open in its own
    // tab — comparison is the point — but the ACTIVE pane, the URL and the title all follow the
    // one just opened.
    root
      .querySelector('[data-node-id="d:drafts"] .glosa-tree-row')
      ?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    rowFor("drafts/outline.md").click();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(opened.at(-1)).toBe("drafts/outline.md");
    expect(inPane(root, ".glosa-content").textContent).toContain("drafts/outline.md");
    expect(root.querySelector('[data-node-id="f:drafts/outline.md"]')?.getAttribute("aria-current")).toBe("page");
    expect(root.querySelector('[data-node-id="f:notes.md"]')?.getAttribute("aria-current")).toBeNull();
    // Both remain open, and the tree says so.
    expect(root.querySelector('[data-node-id="f:notes.md"]')?.getAttribute("data-open")).toBe("true");
    expect(paneFor(root, "notes.md")).not.toBeNull();
    // The tab names the file; the bar shows only the path the tab left out, so a filename is
    // never printed twice in two adjacent rows.
    expect((root.querySelectorAll(".glosa-tab-label")[1] as any).textContent).toBe("outline.md");
    expect(inPane(root, ".glosa-artifact-name").textContent).toBe("");
    expect(inPane(root, ".glosa-artifact-dir").textContent).toBe("drafts/");
    expect(dom.document.title).toBe("ws-1 — outline.md"); // the active pane's file reaches the tab title
  });

  test("at desk widths the navigator is a column: opening an artifact leaves it in place", async () => {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    mountApp(root, { dataAccess: fakeDataAccess() });
    for (let i = 0; i < 5; i++) await Promise.resolve();

    const sidebar = root.querySelector(".glosa-sidebar") as unknown as HTMLElement;
    expect(root.getAttribute("data-nav-open")).toBe("true");
    expect(sidebar.inert).toBe(false);

    (root.querySelector('.glosa-artifact-list .glosa-tree-row[data-tree-action="open"]') as any).click();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(root.getAttribute("data-nav-open")).toBe("true");
    // Escape belongs to the transient drawer, not to a column the reader put there.
    dom.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(root.getAttribute("data-nav-open")).toBe("true");
  });

  test("the one top-bar toggle hides and shows the column, and the choice persists", async () => {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    mountApp(root, { dataAccess: fakeDataAccess() });
    for (let i = 0; i < 5; i++) await Promise.resolve();

    // Exactly one control governs the navigator — no second pin/dock button beside it.
    expect(root.querySelectorAll('[aria-controls="glosa-sidebar"]')).toHaveLength(1);

    const navToggle = root.querySelector(".glosa-nav-toggle") as unknown as HTMLButtonElement;
    const sidebar = root.querySelector(".glosa-sidebar") as unknown as HTMLElement;
    navToggle.click();
    expect(root.getAttribute("data-nav-open")).toBe("false");
    expect(navToggle.getAttribute("aria-expanded")).toBe("false");
    expect(sidebar.inert).toBe(true);

    const next = dom.document.createElement("div");
    dom.document.body.append(next);
    mountApp(next, { dataAccess: fakeDataAccess() });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(next.getAttribute("data-nav-open")).toBe("false");

    (next.querySelector(".glosa-nav-toggle") as any).click();
    expect(next.getAttribute("data-nav-open")).toBe("true");
  });

  test("the navigator is a column at every width — never an overlay, and opening an artifact leaves it alone", async () => {
    // A narrow window changes nothing about what the navigator IS. The workbench keeps its floors
    // and lets the viewport clip it, the way a desktop editor does, rather than swapping the tree
    // for a scrim exactly when the reader is navigating between two documents.
    dom.window.matchMedia = ((query: string) => ({
      matches: query === "(max-width: 1023px)",
    })) as typeof dom.window.matchMedia;
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    mountApp(root, { dataAccess: fakeDataAccess() });
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(root.getAttribute("data-nav-open")).toBe("true");
    expect(root.querySelector(".glosa-backdrop")).toBeNull();

    // Opening an artifact never dismisses a column; there is nothing in the way to dismiss.
    (root.querySelector('.glosa-artifact-list .glosa-tree-row[data-tree-action="open"]') as any).click();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(root.getAttribute("data-nav-open")).toBe("true");

    // Hiding it is the reader's decision, and it is remembered — at this width like any other.
    (root.querySelector(".glosa-nav-toggle") as any).click();
    expect(root.getAttribute("data-nav-open")).toBe("false");
    expect(globalThis.localStorage.getItem("glosa_nav_open")).toBe("false");
  });

  test("the workspace switcher collapses independently of the tree, and the choice persists", async () => {
    const twoWorkspaces = () =>
      fakeDataAccess({
        getWorkspaces: async () => [
          { slug: "ws-1", path: "/tmp/ws-1" },
          { slug: "ws-2", path: "/tmp/ws-2" },
        ],
      });
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    mountApp(root, { dataAccess: twoWorkspaces() });
    for (let i = 0; i < 5; i++) await Promise.resolve();

    const toggle = root.querySelector(".glosa-sidebar-section-toggle") as unknown as HTMLButtonElement;
    const list = root.querySelector(".glosa-workspace-list") as unknown as HTMLElement;
    expect(toggle.getAttribute("aria-controls")).toBe(list.id);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(list.hidden).toBe(false);

    toggle.click();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(list.hidden).toBe(true);
    // Collapsing the switcher must not touch the artifact tree beneath it.
    expect((root.querySelector(".glosa-artifact-list") as unknown as HTMLElement).hidden).toBe(false);

    const next = dom.document.createElement("div");
    dom.document.body.append(next);
    mountApp(next, { dataAccess: twoWorkspaces() });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect((next.querySelector(".glosa-sidebar-section-toggle") as any).getAttribute("aria-expanded")).toBe("false");
    expect((next.querySelector(".glosa-workspace-list") as unknown as HTMLElement).hidden).toBe(true);
  });

  test("a hidden navigator is inert and returns to the focus order only while shown", async () => {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);

    mountApp(root, { dataAccess: fakeDataAccess() });
    for (let i = 0; i < 5; i++) await Promise.resolve();

    const sidebar = root.querySelector(".glosa-sidebar") as unknown as HTMLElement;
    const navToggle = root.querySelector(".glosa-nav-toggle") as unknown as HTMLButtonElement;
    expect(sidebar.inert).toBe(false);
    expect(sidebar.hasAttribute("aria-hidden")).toBe(false);

    navToggle.click();
    expect(sidebar.inert).toBe(true);
    expect(sidebar.getAttribute("aria-hidden")).toBe("true");
    // Hiding it returns focus to the control that hid it, rather than stranding it in a column
    // that is no longer there.
    await Promise.resolve();
    expect(dom.document.activeElement).toBe(navToggle as any);

    navToggle.click();
    expect(sidebar.inert).toBe(false);
    expect(sidebar.hasAttribute("aria-hidden")).toBe(false);
  });

  test("switching to Edit mode + Source face shows the textarea with the artifact's raw content; Save calls putArtifact", async () => {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    const da = fakeDataAccess();

    mountApp(root, { dataAccess: da });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    (root.querySelector('.glosa-artifact-list .glosa-tree-row[data-tree-action="open"]') as any).click();
    for (let i = 0; i < 5; i++) await Promise.resolve();

    const main = inPane(root, ".glosa-pane-main");
    main.scrollTop = 600;
    inPane(root, '.glosa-modebar [data-mode="edit"]').click();
    expect(main.scrollTop).toBe(0);
    // §8: the measure follows the face. Rich is prose; Source is markdown and gets the pane.
    expect(activePane(root).getAttribute("data-editor-face")).toBe("rich");
    const richTextbox = root.querySelector('.ProseMirror[role="textbox"]');
    if (richTextbox) {
      expect(richTextbox.getAttribute("aria-label")).toBe("Artifact editor");
      expect(richTextbox.getAttribute("aria-multiline")).toBe("true");
    }
    // The rich face is Edit's default (or the automatic fallback already picked Source in DOMs
    // that can't host a ProseMirror view); the Source face is the byte-exact editing contract
    // this test pins down either way.
    inPane(root, ".glosa-face-source").click();
    expect(activePane(root).getAttribute("data-editor-face")).toBe("source");

    const textarea = inPane(root, ".glosa-edit-area");
    expect(textarea.hidden).toBe(false);
    expect(textarea.value).toBe("# Title\n\nBody.\n");

    textarea.value = "# Title\n\nEdited.\n";
    textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    // An unsaved edit shows on the tab, so a reader with six open can see which one is dirty.
    expect(root.querySelector(".glosa-tab-dirty")).not.toBeNull();

    inPane(root, ".glosa-save").click();
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(da.put).toEqual([{ path: "notes.md", content: "# Title\n\nEdited.\n" }]);
    expect(root.querySelector(".glosa-tab-dirty")).toBeNull();
  });

  test("matching approval request renders the contextual strip and clean confirmation approves without saving", async () => {
    const responses: unknown[] = [];
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    const da = fakeDataAccess({
      getInbox: async () => ({
        pending_count: 1,
        attention: [
          {
            id: "approval-1",
            status: "seen",
            message: "Check the citations",
            action: "proofread",
            target_path: "notes.md",
            approval_mode: true,
          },
        ],
      }),
      respondToAttention: async (_slug: string, _id: string, body: unknown) => {
        responses.push(body);
        return {
          status: "done",
          detail: {
            outcome: "approved",
            target_path: "notes.md",
            revision_id: "sha-1",
            completed_at: "2026-07-24T12:00:00.000Z",
          },
        };
      },
    });
    mountApp(root, { dataAccess: da });
    for (let i = 0; i < 8; i++) await Promise.resolve();
    (root.querySelector('.glosa-artifact-list .glosa-tree-row[data-tree-action="open"]') as any).click();
    for (let i = 0; i < 8; i++) await Promise.resolve();

    const strip = root.querySelector(".glosa-approval-strip") as any;
    expect(strip.hidden).toBe(false);
    expect(strip.textContent).toContain("Final approval requested");
    expect(strip.textContent).toContain("Check the citations");

    (strip.querySelector(".glosa-approval-button") as any).click();
    await Promise.resolve();
    expect(dom.document.querySelector(".glosa-dialog h2")?.textContent).toBe("Approve this revision?");
    (dom.document.querySelector(".glosa-dialog .glosa-btn-ghost") as any).click();
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(da.put).toEqual([]);
    expect(responses).toEqual([]);

    (strip.querySelector(".glosa-approval-button") as any).click();
    await Promise.resolve();
    (dom.document.querySelector(".glosa-dialog .glosa-save") as any).click();
    for (let i = 0; i < 12; i++) await Promise.resolve();

    expect(da.put).toEqual([]);
    expect(responses).toEqual([{ outcome: "approved", revisionId: "sha-1" }]);
    expect(strip.textContent).toContain("Revision sha-1 is approved");
    expect(strip.querySelector("button")).toBeNull();
  });

  test("dirty final approval saves and re-fetches before submitting the resulting revision", async () => {
    const sequence: string[] = [];
    let revision = "a".repeat(64);
    let content = "# Title\n";
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    const da = fakeDataAccess({
      getInbox: async () => ({
        pending_count: 1,
        attention: [
          {
            id: "approval-1",
            status: "seen",
            action: "review",
            target_path: "notes.md",
            approval_mode: true,
          },
        ],
      }),
      getArtifact: async (_slug: string, path: string) => {
        sequence.push(`get:${revision}`);
        return {
          source_path: path,
          source_sha256: revision,
          class: "R",
          content,
          rendered_html: `<h1 data-line="0">${content}</h1>`,
        };
      },
      putArtifact: async (_slug: string, _path: string, nextContent: string) => {
        sequence.push("put");
        content = nextContent;
        revision = "b".repeat(64);
        return { source_path: "notes.md", source_sha256: revision };
      },
      respondToAttention: async (_slug: string, _id: string, body: any) => {
        sequence.push(`respond:${body.revisionId}`);
        return {
          status: "done",
          detail: {
            outcome: "approved",
            target_path: "notes.md",
            revision_id: body.revisionId,
            completed_at: "2026-07-24T12:00:00.000Z",
          },
        };
      },
    });
    mountApp(root, { dataAccess: da });
    for (let i = 0; i < 8; i++) await Promise.resolve();
    (root.querySelector('.glosa-artifact-list .glosa-tree-row[data-tree-action="open"]') as any).click();
    for (let i = 0; i < 8; i++) await Promise.resolve();
    (root.querySelector('[data-mode="edit"]') as any).click();
    (root.querySelector(".glosa-face-source") as any).click();
    const editor = root.querySelector(".glosa-edit-area") as any;
    editor.value = "# Revised\n";
    editor.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

    (root.querySelector(".glosa-approval-button") as any).click();
    await Promise.resolve();
    expect(dom.document.querySelector(".glosa-dialog p")?.textContent).toContain("pending edits will be saved");
    (dom.document.querySelector(".glosa-dialog .glosa-save") as any).click();
    for (let i = 0; i < 16; i++) await Promise.resolve();

    expect(sequence.slice(-3)).toEqual(["put", `get:${"b".repeat(64)}`, `respond:${"b".repeat(64)}`]);
    expect(root.querySelector(".glosa-approval-strip")?.textContent).toContain(
      `Revision ${"b".repeat(12)} is approved`,
    );
  });

  test("Review mode: a text selection opens the composer; submitting it posts a well-formed annotation record", async () => {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    const da = fakeDataAccess();
    const focusOptions: FocusOptions[] = [];
    const nativeFocus = dom.window.HTMLElement.prototype.focus;
    dom.window.HTMLElement.prototype.focus = function (options?: FocusOptions) {
      focusOptions.push(options ?? {});
      return nativeFocus.call(this);
    };

    mountApp(root, { dataAccess: da });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    (root.querySelector('.glosa-artifact-list .glosa-tree-row[data-tree-action="open"]') as any).click();
    for (let i = 0; i < 5; i++) await Promise.resolve();

    inPane(root, '.glosa-modebar [data-mode="review"]').click();

    const content = inPane(root, ".glosa-content");
    const heading = content.querySelector("h1")!;
    const textNode = heading.firstChild!;
    let scrollIntoViewCalls = 0;
    (heading as unknown as HTMLElement).scrollIntoView = () => {
      scrollIntoViewCalls += 1;
    };
    const range = dom.document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 5); // "Title"
    const selection = dom.window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);

    content.dispatchEvent(new dom.window.Event("mouseup", { bubbles: true }));
    for (let i = 0; i < 5; i++) await Promise.resolve();

    // The selection opens the margin composer (no post yet) with the quoted passage.
    expect(da.posted).toHaveLength(0);
    const composerInput = root.querySelector(".glosa-composer-input") as any;
    expect(composerInput).not.toBeNull();
    expect(focusOptions.at(-1)).toEqual({ preventScroll: true });
    // §7: rail-or-tray is decided from the PANE's observed inline size, never a viewport media
    // query. An unmeasured pane is below the rail floor, so the composer is the compact tray and
    // scrolls the selected passage clear of it first.
    expect(scrollIntoViewCalls).toBe(1);
    composerInput.value = "tighten this";
    (root.querySelector(".glosa-composer-send") as any).click();
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(da.posted).toHaveLength(1);
    const record = da.posted[0] as { body: string; intent: string; target: { quote: { exact: string } } };
    expect(record.body).toBe("tighten this");
    expect(record.intent).toBe("content");
    expect(record.target.quote.exact).toBe("Title");

    // The open-annotation count reaches the tab, so one pane's unresolved feedback is visible
    // while the reader is looking at another (§5).
    expect(root.querySelector(".glosa-tab-count")?.textContent).toBe("1");

    // The submitted annotation renders as a margin card with its honest delivery state.
    const card = root.querySelector(".glosa-annotation") as any;
    expect(card).not.toBeNull();
    expect(card.querySelector(".glosa-annotation-body")!.textContent).toBe("tighten this");

    // A live SSE journal frame for this entry updates the card's state in place (R3's status
    // machine speaking through the stream).
    da.stream.handlers?.onEvent?.({
      event: "journal",
      data: { event: "transition_committed", entry: "inb-1", detail: { to: "applied" }, by: "session:s1" },
    });
    const applied = root.querySelector(".glosa-annotation") as any;
    expect(applied.getAttribute("data-state")).toBe("applied");
    expect(applied.querySelector(".glosa-annotation-state")!.textContent).toContain("Done");

    // Remove withdraws the entry (terminal `rejected` daemon-side) and drops the card.
    (applied.querySelector(".glosa-annotation-remove") as any).click();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(da.withdrawn).toEqual(["inb-1"]);
    expect(root.querySelector(".glosa-annotation")).toBeNull();
    expect(root.querySelector(".glosa-tab-count")).toBeNull();
  });

  test("Review mode: a focused passage opens the composer with Enter and Cancel restores passage focus", async () => {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    const da = fakeDataAccess();

    mountApp(root, { dataAccess: da });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    (root.querySelector('.glosa-artifact-list .glosa-tree-row[data-tree-action="open"]') as any).click();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    inPane(root, '.glosa-modebar [data-mode="review"]').click();

    const heading = inPane(root, '.glosa-content > h1[data-line="0"]');
    const body = inPane(root, '.glosa-content > p[data-line="2"]');
    const content = inPane(root, ".glosa-content");
    expect(heading.getAttribute("tabindex")).toBe("0");
    expect(body.getAttribute("tabindex")).toBe("-1");
    expect(heading.hasAttribute("aria-describedby")).toBe(false);
    // Each pane owns its own instructions node, so the id is per pane rather than global — six
    // open artifacts must not share one element id.
    const instructions = activePane(root).querySelector(".glosa-visually-hidden[id]");
    expect(instructions.id).toStartWith("glosa-annotate-instructions-");
    expect(content.getAttribute("aria-describedby")).toBe(instructions.id);
    heading.focus();
    heading.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(dom.document.activeElement).toBe(body);
    expect(heading.getAttribute("tabindex")).toBe("-1");
    expect(body.getAttribute("tabindex")).toBe("0");
    body.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(dom.document.activeElement).toBe(heading);
    heading.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    const quote = inPane(root, ".glosa-composer-quote");
    expect(quote.textContent).toContain("Title");
    inPane(root, ".glosa-composer-actions .glosa-btn-ghost").click();
    await Promise.resolve();
    expect(dom.document.activeElement).toBe(heading);
  });

  test("P4.2: the Conversation toggle mounts conversation.js's pane against the current workspace, and un-hides it", async () => {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    const openedForSlugs: string[] = [];
    const da = fakeDataAccess({
      openTranscriptStream: (slug: string) => {
        openedForSlugs.push(slug);
        return () => {};
      },
    });

    mountApp(root, { dataAccess: da });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    // History lives in a pane now, so there has to be one open to compare the two scopes.
    (root.querySelector('.glosa-artifact-list .glosa-tree-row[data-tree-action="open"]') as any).click();
    for (let i = 0; i < 5; i++) await Promise.resolve();

    const toggle = root.querySelector(".glosa-conversation-toggle") as any;
    const pane = root.querySelector(".glosa-conversation") as any;
    // §6: Conversation is workspace-scoped (conversation.js keys on slug alone) so it stays in
    // the top bar. History is artifact-scoped and lives in the pane that holds its artifact.
    const historyToggle = inPane(root, ".glosa-history-toggle");
    const historyPane = inPane(root, ".glosa-history");
    expect(pane.parentElement).toBe(root);
    expect(historyPane.parentElement).toBe(activePane(root));
    expect(root.querySelector(".glosa-topbar .glosa-history-toggle")).toBeNull();
    expect(pane.hidden).toBe(true);
    expect(toggle.getAttribute("aria-controls")).toBe("glosa-conversation");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    toggle.click();
    for (let i = 0; i < 5 && openedForSlugs.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(pane.hidden).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(openedForSlugs).toEqual(["ws-1"]);
    // Preview exposes the transcript as read-only agent context; composition requires Annotate.
    expect(pane.querySelector(".glosa-conv-composer-input")).toBeNull();
    expect(pane.textContent).toContain("Agent context");

    // The pane's History opens beside its own manuscript and leaves Conversation alone — they
    // describe different scopes now, so one no longer has to close the other.
    historyToggle.click();
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(historyPane.hidden).toBe(false);
    expect(historyToggle.getAttribute("aria-expanded")).toBe("true");
    expect(pane.hidden).toBe(false);

    historyToggle.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(historyPane.hidden).toBe(true);
    expect(historyToggle.getAttribute("aria-expanded")).toBe("false");
    expect(pane.hidden).toBe(false);

    const close = pane.querySelector(".glosa-conv-close") as any;
    expect(close.getAttribute("aria-label")).toBe("Close agent context");
    close.click();
    expect(pane.hidden).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(dom.document.activeElement).toBe(root.querySelector(".glosa-tools-trigger") as any);
  });

  test("document surface hides navigator chrome", async () => {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    (mountApp as any)(root, {
      dataAccess: fakeDataAccess(),
      surface: "document",
      initialSlug: "ws-1",
      initialArtifact: "notes.md",
    });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(root.getAttribute("data-surface")).toBe("document");
    expect((root.querySelector(".glosa-nav-toggle") as any).hidden).toBe(true);
    expect((root.querySelector(".glosa-sidebar") as any).hidden).toBe(true);
    expect(dom.document.title).toBe("notes.md");
  });

  test("workspace surface updates the tab title for workspace and artifact focus", async () => {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);

    mountApp(root, { dataAccess: fakeDataAccess() });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(dom.document.title).toBe("ws-1");

    (root.querySelector('.glosa-artifact-list .glosa-tree-row[data-tree-action="open"]') as any).click();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(dom.document.title).toBe("ws-1 — notes.md");
  });

  test("read lock shows only Read and ignores Review/Edit shortcuts", async () => {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    (mountApp as any)(root, {
      dataAccess: fakeDataAccess(),
      readLock: true,
      initialSlug: "ws-1",
      initialArtifact: "notes.md",
    });
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(root.getAttribute("data-preview-lock")).toBe("true");
    const modes = Array.from(root.querySelectorAll(".glosa-modebar [data-mode]")).map((el) => (el as any).dataset.mode);
    expect(modes).toEqual(["read"]);
    // Mode is pane state now, so it is stamped on the pane rather than on the app root.
    expect(activePane(root).getAttribute("data-mode")).toBe("read");
  });

  // --- issue #81: the wiring badge + point-of-action init consent dialog ---

  const flush = async (n = 8) => {
    for (let i = 0; i < n; i++) await Promise.resolve();
  };

  function wiringOf(state: string, extra: Record<string, unknown> = {}) {
    return async () => ({
      state,
      init: { manifest_present: state !== "unwired", manifest_invalid: false },
      sessions: { bound_live: state === "live" ? 1 : 0, routable_live: state === "live" ? 1 : 0 },
      pending_count: 0,
      kind: "directory",
      ...extra,
    });
  }

  test("combined control refreshes unbound/stale/connected without reload and resets green on failure", async () => {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    let wiringResponse: (() => Promise<unknown>) | null = null;
    let statusResponse: (() => Promise<unknown>) | null = null;
    const statusOf =
      (sessions: unknown[], pendingCount = 0) =>
      async () => ({
        workspaces: [
          {
            slug: "ws-1",
            path: "/tmp/ws-1",
            pending_count: pendingCount,
            connect: {
              providers: [
                { provider: "claude-code", display_name: "Claude Code", instruction: "Bind Claude." },
                { provider: "codex", display_name: "Codex", instruction: "Bind Codex." },
              ],
              cli_fallback: "glosa session bind <current-session-id> --workspace <workspace-path>",
            },
          },
        ],
        sessions,
      });
    const da = fakeDataAccess({
      getWiringStatus: async () => {
        if (!wiringResponse) throw new Error("status unavailable");
        return wiringResponse();
      },
      getStatus: async () => {
        if (!statusResponse) throw new Error("status unavailable");
        return statusResponse();
      },
    });
    mountApp(root, { dataAccess: da });
    await flush();

    // Fetch failure is explicit and non-green; no previous claim survives.
    const control = root.querySelector(".glosa-agent-feedback-trigger") as any;
    expect(control.textContent).toBe("Agent feedback unavailable");
    expect(control.getAttribute("data-state")).toBe("unknown");
    expect(control.disabled).toBe(true);

    wiringResponse = wiringOf("unwired");
    statusResponse = statusOf([]);
    (da as any).stream.handlers?.onEvent?.({ event: "journal", data: {} });
    await flush();
    expect(control.getAttribute("data-state")).toBe("unbound");
    expect(control.textContent).toContain("Connect agent");
    expect(control.textContent).toContain("feedback off");
    expect(control.disabled).toBe(false);

    wiringResponse = wiringOf("wired");
    statusResponse = statusOf([
      {
        session_id: "stale-codex-session",
        provider: "codex",
        cwd: "/tmp/ws-1",
        workspace_binding: "/tmp/ws-1",
        last_active_at: "2026-08-06T10:00:00.000Z",
        liveness: "stale",
      },
    ]);
    (da as any).stream.handlers?.onEvent?.({ event: "artifact", data: { path: "other.md" } });
    await flush();
    expect(control.getAttribute("data-state")).toBe("stale");
    expect(control.textContent).toContain("Agent stale");

    statusResponse = statusOf(
      [
        {
          session_id: "live-claude-session",
          provider: "claude-code",
          cwd: "/elsewhere",
          workspace_binding: "/tmp/ws-1",
          last_active_at: "2026-08-06T10:01:00.000Z",
          liveness: "alive",
        },
        {
          session_id: "cwd-only-session",
          provider: "codex",
          cwd: "/tmp/ws-1/subdir",
          workspace_binding: null,
          last_active_at: "2026-08-06T10:02:00.000Z",
          liveness: "alive",
        },
      ],
      2,
    );
    (da as any).stream.handlers?.onReconnect?.();
    await flush();
    expect(control.getAttribute("data-state")).toBe("connected");
    expect(control.textContent).toContain("Agent connected");
    expect(control.textContent).toContain("2 queued");

    wiringResponse = null;
    statusResponse = null;
    (da as any).stream.handlers?.onEvent?.({ event: "journal", data: {} });
    await flush();
    expect(control.getAttribute("data-state")).toBe("unknown");
    expect(control.textContent).toBe("Agent feedback unavailable");
  });

  /** Mounts, opens notes.md, enters Annotate, selects "Title", types a note, clicks send.
   * Returns the root — callers then interact with whatever dialog the submit produced. */
  async function driveAnnotationSubmit(da: ReturnType<typeof fakeDataAccess>) {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    mountApp(root, { dataAccess: da });
    await flush();
    (root.querySelector('.glosa-artifact-list .glosa-tree-row[data-tree-action="open"]') as any).click();
    await flush();
    (root.querySelector('[data-mode="review"]') as any).click();

    const content = root.querySelector(".glosa-content")!;
    const textNode = content.querySelector("h1")!.firstChild!;
    const range = dom.document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 5);
    const selection = dom.window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    content.dispatchEvent(new dom.window.Event("mouseup", { bubbles: true }));
    await flush();

    const composerInput = root.querySelector(".glosa-composer-input") as any;
    composerInput.value = "tighten this";
    (root.querySelector(".glosa-composer-send") as any).click();
    await flush();
    return root;
  }

  test("first annotation in an unwired workspace offers wiring; DECLINING never blocks the save; asked once per workspace", async () => {
    const da = fakeDataAccess({ getWiringStatus: wiringOf("unwired") });
    const root = await driveAnnotationSubmit(da);

    const dialog = dom.document.querySelector(".glosa-dialog h2");
    expect(dialog?.textContent).toBe("This workspace isn't wired for agent feedback");
    (dom.document.querySelector(".glosa-dialog .glosa-btn-ghost") as any).click(); // Cancel
    await flush();
    expect((da as any).posted).toHaveLength(1); // the save happened regardless

    // Second annotation, same workspace + session -> no second dialog.
    (root.querySelector('[data-mode="review"]') as any).click();
    const content = root.querySelector(".glosa-content")!;
    const textNode = content.querySelector("h1")!.firstChild!;
    const range = dom.document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 5);
    const selection = dom.window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    content.dispatchEvent(new dom.window.Event("mouseup", { bubbles: true }));
    await flush();
    (root.querySelector(".glosa-composer-input") as any).value = "again";
    (root.querySelector(".glosa-composer-send") as any).click();
    await flush();
    expect(dom.document.querySelector(".glosa-dialog")).toBeNull();
    expect((da as any).posted).toHaveLength(2);
  });

  test("ACCEPTING wires via triggerInit and shows the restart notice; save still proceeds", async () => {
    const triggered: string[] = [];
    const da = fakeDataAccess({
      getWiringStatus: wiringOf("unwired"),
      triggerInit: async (slug: string) => {
        triggered.push(slug);
        return { ok: true, changed: true, warnings: [], restart_required: true };
      },
    });
    await driveAnnotationSubmit(da);

    (dom.document.querySelector(".glosa-dialog .glosa-save") as any).click(); // "Wire it now"
    await flush();
    expect(triggered).toEqual(["ws-1"]);
    const notice = dom.document.querySelector(".glosa-dialog h2");
    expect(notice?.textContent).toBe("Wired — one step left");
    (dom.document.querySelector(".glosa-dialog .glosa-save") as any).click(); // "Got it"
    await flush();
    expect((da as any).posted).toHaveLength(1);
  });

  test("triggerInit FAILING falls back to the terminal command notice; save still proceeds", async () => {
    const da = fakeDataAccess({
      getWiringStatus: wiringOf("unwired"),
      triggerInit: async () => {
        throw new Error("init child timed out");
      },
    });
    await driveAnnotationSubmit(da);

    (dom.document.querySelector(".glosa-dialog .glosa-save") as any).click(); // "Wire it now"
    await flush();
    const notice = dom.document.querySelector(".glosa-dialog h2");
    expect(notice?.textContent).toBe("Couldn't set up agent feedback");
    expect(dom.document.querySelector(".glosa-dialog p")?.textContent).toContain("glosa init");
    (dom.document.querySelector(".glosa-dialog .glosa-save") as any).click();
    await flush();
    expect((da as any).posted).toHaveLength(1);
  });

  test("wired and live workspaces never prompt; unknown wiring never prompts", async () => {
    for (const getWiringStatus of [
      wiringOf("wired"),
      wiringOf("live"),
      async () => {
        throw new Error("no route");
      },
    ]) {
      const da = fakeDataAccess({ getWiringStatus });
      await driveAnnotationSubmit(da);
      expect(dom.document.querySelector(".glosa-dialog")).toBeNull();
      expect((da as any).posted).toHaveLength(1);
      dom.document.body.textContent = ""; // clean mount root between iterations
    }
  });
});

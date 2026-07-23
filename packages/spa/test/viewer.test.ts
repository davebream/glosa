// SPDX-License-Identifier: Apache-2.0
// P3.3 — viewer.js: the pure Preview/Annotate/Edit mode reducer (no DOM), the idiomorph morph
// wrapper (happy-dom), and a mounted-app integration test against a fake data-access object (no
// real daemon, no real fetch — mountApp never gets to touch either directly).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { initialModeState, mountApp, modeReducer, morphArtifactContent } from "../src/viewer.js";
import { installDom, type DomEnv } from "./dom-env.ts";

describe("modeReducer — pure Preview/Annotate/Edit state machine", () => {
  test("preview -> annotate -> edit, all legal, none dirty", () => {
    let state = initialModeState();
    expect(state).toEqual({ mode: "preview", dirty: false, blocked: null });

    state = modeReducer(state, { type: "set_mode", mode: "annotate" });
    expect(state.mode).toBe("annotate");

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

  test("leaving edit mode while dirty is BLOCKED, not applied", () => {
    let state = modeReducer(initialModeState(), { type: "set_mode", mode: "edit" });
    state = modeReducer(state, { type: "edited" });
    expect(state.dirty).toBe(true);

    const blocked = modeReducer(state, { type: "set_mode", mode: "preview" });
    expect(blocked.mode).toBe("edit"); // still in edit — the switch did NOT go through
    expect(blocked.dirty).toBe(true);
    expect(blocked.blocked).toBe("preview"); // the requested mode is parked for the caller to resolve
  });

  test("'saved' clears dirty (and any parked block) without changing mode", () => {
    let state = modeReducer(initialModeState(), { type: "set_mode", mode: "edit" });
    state = modeReducer(state, { type: "edited" });
    state = modeReducer(state, { type: "saved" });
    expect(state).toEqual({ mode: "edit", dirty: false, blocked: null });
  });

  test("'discard' switches to the parked mode and clears dirty", () => {
    let state = modeReducer(initialModeState(), { type: "set_mode", mode: "edit" });
    state = modeReducer(state, { type: "edited" });
    state = modeReducer(state, { type: "set_mode", mode: "annotate" }); // blocked, parks "annotate"
    state = modeReducer(state, { type: "discard" });
    expect(state).toEqual({ mode: "annotate", dirty: false, blocked: null });
  });

  test("re-requesting edit mode while already dirty in edit mode is a no-op transition, not a block", () => {
    let state = modeReducer(initialModeState(), { type: "set_mode", mode: "edit" });
    state = modeReducer(state, { type: "edited" });
    const next = modeReducer(state, { type: "set_mode", mode: "edit" });
    expect(next).toEqual({ mode: "edit", dirty: false, blocked: null }); // set_mode always resets dirty for the mode it lands on
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

    morphArtifactContent(
      container,
      '<p data-line="0">Hello world</p><p data-line="1">Second paragraph EDITED</p>',
    );

    const firstPAfter = container.querySelector('[data-line="0"]')!;
    expect(firstPAfter).toBe(firstP); // same object reference — not rebuilt
    expect((firstPAfter as unknown as { _scrollMarker: string })._scrollMarker).toBe("keep-me");
    expect(container.querySelector('[data-line="1"]')!.textContent).toBe("Second paragraph EDITED");
  });

  test("a removed block is actually removed, an added block actually appears", () => {
    dom.document.body.innerHTML = '<div id="c"><p data-line="0">Only paragraph</p></div>';
    const container = dom.document.getElementById("c")!;

    morphArtifactContent(
      container,
      '<p data-line="0">Only paragraph</p><p data-line="1">A new second paragraph</p>',
    );

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
      mintClassFCapability: async () => ({ url: "http://127.0.0.1:4647/doc/tok/x.html", nonce: "n", expires_in_s: 600 }),
      // P4.2 — the conversation pane's data-access surface. Not exercised by every test in this
      // file (only the "Conversation" toggle test below opens it); stubbed here so mountApp's
      // `dataAccess` shape, inferred from the real createDataAccess() default, is satisfied
      // whenever the toggle IS clicked.
      openTranscriptStream: () => () => {}, // returns a no-op stop()
      sendComposerMessage: async () => ({ accepted: true, delivered: false }),
      getComposerMessageStatus: async () => ({ accepted: true, delivered: false, state: "queued" }),
      ...overrides,
    };
  }

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

    const content = root.querySelector(".glosa-content")!;
    expect(content.innerHTML).toContain("Title");
  });

  test("workspace switcher hides at <=1 workspace (MCP/CLI scope), appears and lists all at >=2", async () => {
    const solo = dom.document.createElement("div");
    dom.document.body.append(solo);
    mountApp(solo, { dataAccess: fakeDataAccess() }); // the sole ws-1
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect((solo.querySelector(".glosa-workspace-list") as any).hidden).toBe(true);

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

    const tools = root.querySelector(".glosa-tools") as any;
    const trigger = root.querySelector(".glosa-tools-trigger") as any;
    const menu = root.querySelector(".glosa-tools-menu") as any;
    expect(trigger.getAttribute("aria-controls")).toBe("glosa-tools-menu");
    expect(menu.querySelectorAll(":scope > .glosa-attention, :scope > button, :scope > .glosa-appearance")).toHaveLength(4);

    trigger.click();
    await Promise.resolve();
    expect(tools.dataset.open).toBe("true");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(dom.document.activeElement as any).toBe(menu.querySelector("button:not(:disabled)") as any);

    (menu.querySelector(".glosa-history-toggle") as any).click();
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

  test("a closed compact navigator is inert and returns to the focus order only while open", async () => {
    dom.window.matchMedia = ((query: string) => ({
      matches: query === "(max-width: 1023px)",
    })) as typeof dom.window.matchMedia;
    const root = dom.document.createElement("div");
    dom.document.body.append(root);

    mountApp(root, { dataAccess: fakeDataAccess() });
    for (let i = 0; i < 5; i++) await Promise.resolve();

    const sidebar = root.querySelector(".glosa-sidebar") as unknown as HTMLElement;
    const navToggle = root.querySelector(".glosa-nav-toggle") as unknown as HTMLButtonElement;
    const backdrop = root.querySelector(".glosa-backdrop") as unknown as HTMLElement;
    expect(sidebar.inert).toBe(true);
    expect(sidebar.getAttribute("aria-hidden")).toBe("true");

    navToggle.click();
    expect(sidebar.inert).toBe(false);
    expect(sidebar.hasAttribute("aria-hidden")).toBe(false);

    backdrop.click();
    expect(sidebar.inert).toBe(true);
    expect(sidebar.getAttribute("aria-hidden")).toBe("true");
  });

  test("switching to Edit mode + Source face shows the textarea with the artifact's raw content; Save calls putArtifact", async () => {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    const da = fakeDataAccess();

    mountApp(root, { dataAccess: da });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    (root.querySelector('.glosa-artifact-list .glosa-tree-row[data-tree-action="open"]') as any).click();
    for (let i = 0; i < 5; i++) await Promise.resolve();

    const main = root.querySelector(".glosa-main") as unknown as HTMLElement;
    main.scrollTop = 600;
    (root.querySelector('[data-mode="edit"]') as any).click();
    expect(main.scrollTop).toBe(0);
    const richTextbox = root.querySelector('.ProseMirror[role="textbox"]');
    if (richTextbox) {
      expect(richTextbox.getAttribute("aria-label")).toBe("Artifact editor");
      expect(richTextbox.getAttribute("aria-multiline")).toBe("true");
    }
    // The rich face is Edit's default (or the automatic fallback already picked Source in DOMs
    // that can't host a ProseMirror view); the Source face is the byte-exact editing contract
    // this test pins down either way.
    (root.querySelector(".glosa-face-source") as any).click();

    const textarea = root.querySelector(".glosa-edit-area") as any;
    expect(textarea.hidden).toBe(false);
    expect(textarea.value).toBe("# Title\n\nBody.\n");

    textarea.value = "# Title\n\nEdited.\n";
    textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

    (root.querySelector(".glosa-save") as any).click();
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(da.put).toEqual([{ path: "notes.md", content: "# Title\n\nEdited.\n" }]);
  });

  test("Annotate mode: a text selection opens the composer; submitting it posts a well-formed annotation record", async () => {
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

    (root.querySelector('[data-mode="annotate"]') as any).click();

    const content = root.querySelector(".glosa-content")!;
    const heading = content.querySelector("h1")!;
    const textNode = heading.firstChild!;
    const mediaQueries: string[] = [];
    let scrollIntoViewCalls = 0;
    dom.window.matchMedia = ((query: string) => {
      mediaQueries.push(query);
      return { matches: query === "(max-width: 1279px)" };
    }) as typeof dom.window.matchMedia;
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
    expect(mediaQueries).toContain("(max-width: 1279px)");
    expect(scrollIntoViewCalls).toBe(1);
    composerInput.value = "tighten this";
    (root.querySelector(".glosa-composer-send") as any).click();
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(da.posted).toHaveLength(1);
    const record = da.posted[0] as { body: string; intent: string; target: { quote: { exact: string } } };
    expect(record.body).toBe("tighten this");
    expect(record.intent).toBe("content");
    expect(record.target.quote.exact).toBe("Title");

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
  });

  test("Annotate mode: a focused passage opens the composer with Enter and Cancel restores passage focus", async () => {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    const da = fakeDataAccess();

    mountApp(root, { dataAccess: da });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    (root.querySelector('.glosa-artifact-list .glosa-tree-row[data-tree-action="open"]') as any).click();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    (root.querySelector('[data-mode="annotate"]') as any).click();

    const heading = root.querySelector('.glosa-content > h1[data-line="0"]') as any;
    const body = root.querySelector('.glosa-content > p[data-line="2"]') as any;
    const content = root.querySelector(".glosa-content") as any;
    expect(heading.getAttribute("tabindex")).toBe("0");
    expect(body.getAttribute("tabindex")).toBe("-1");
    expect(heading.hasAttribute("aria-describedby")).toBe(false);
    expect(content.getAttribute("aria-describedby")).toBe("glosa-annotate-instructions");
    heading.focus();
    heading.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(dom.document.activeElement).toBe(body);
    expect(heading.getAttribute("tabindex")).toBe("-1");
    expect(body.getAttribute("tabindex")).toBe("0");
    body.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(dom.document.activeElement).toBe(heading);
    heading.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    const quote = root.querySelector(".glosa-composer-quote") as any;
    expect(quote.textContent).toContain("Title");
    (root.querySelector(".glosa-composer-actions .glosa-btn-ghost") as any).click();
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

    const toggle = root.querySelector(".glosa-conversation-toggle") as any;
    const pane = root.querySelector(".glosa-conversation") as any;
    const historyToggle = root.querySelector(".glosa-history-toggle") as any;
    const historyPane = root.querySelector(".glosa-history") as any;
    expect(pane.parentElement).toBe(root);
    expect(historyPane.parentElement).toBe(root);
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
    // conversation.js's own mount renders its composer/status scaffolding into the pane.
    expect(pane.querySelector(".glosa-conv-composer-input")).not.toBeNull();

    historyToggle.click();
    expect(pane.hidden).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(historyPane.hidden).toBe(false);
    expect(historyToggle.getAttribute("aria-expanded")).toBe("true");

    toggle.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(historyPane.hidden).toBe(true);
    expect(historyToggle.getAttribute("aria-expanded")).toBe("false");
    expect(pane.hidden).toBe(false);

    const close = pane.querySelector(".glosa-conv-close") as any;
    expect(close.getAttribute("aria-label")).toBe("Close conversation");
    close.click();
    expect(pane.hidden).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(dom.document.activeElement).toBe(toggle);
  });
});

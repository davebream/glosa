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
    return {
      posted,
      put,
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
      putArtifact: async (_slug: string, path: string, content: string) => {
        put.push({ path, content });
        return { source_path: path, source_sha256: "sha-2" };
      },
      openStream: () => () => {}, // returns a no-op stop()
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

    const artifactButtons = Array.from(root.querySelectorAll(".glosa-artifact-list button")) as any[];
    expect(artifactButtons.map((b) => b.textContent)).toEqual(["notes.md"]);

    artifactButtons[0]!.click();
    for (let i = 0; i < 5; i++) await Promise.resolve();

    const content = root.querySelector(".glosa-content")!;
    expect(content.innerHTML).toContain("Title");
  });

  test("switching to Edit mode shows the textarea with the artifact's raw content; Save calls putArtifact", async () => {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    const da = fakeDataAccess();

    mountApp(root, { dataAccess: da });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    (root.querySelector(".glosa-artifact-list button") as any).click();
    for (let i = 0; i < 5; i++) await Promise.resolve();

    (root.querySelector('[data-mode="edit"]') as any).click();

    const textarea = root.querySelector(".glosa-edit-area") as any;
    expect(textarea.hidden).toBe(false);
    expect(textarea.value).toBe("# Title\n\nBody.\n");

    textarea.value = "# Title\n\nEdited.\n";
    textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

    (root.querySelector(".glosa-save") as any).click();
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(da.put).toEqual([{ path: "notes.md", content: "# Title\n\nEdited.\n" }]);
  });

  test("Annotate mode: a text selection + a confirmed prompt posts a well-formed annotation record", async () => {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    const da = fakeDataAccess();
    (dom.window as unknown as { prompt: () => string }).prompt = () => "tighten this";

    mountApp(root, { dataAccess: da });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    (root.querySelector(".glosa-artifact-list button") as any).click();
    for (let i = 0; i < 5; i++) await Promise.resolve();

    (root.querySelector('[data-mode="annotate"]') as any).click();

    const content = root.querySelector(".glosa-content")!;
    const heading = content.querySelector("h1")!;
    const textNode = heading.firstChild!;
    const range = dom.document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 5); // "Title"
    const selection = dom.window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);

    content.dispatchEvent(new dom.window.Event("mouseup", { bubbles: true }));
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(da.posted).toHaveLength(1);
    const record = da.posted[0] as { body: string; intent: string; target: { quote: { exact: string } } };
    expect(record.body).toBe("tighten this");
    expect(record.intent).toBe("content");
    expect(record.target.quote.exact).toBe("Title");
  });
});

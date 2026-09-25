// SPDX-License-Identifier: Apache-2.0
// P3.3 — viewer.js: the pure Read/Review/Edit mode reducer (no DOM), the idiomorph morph
// wrapper (happy-dom), and a mounted-app integration test against a fake data-access object (no
// real daemon, no real fetch — mountApp never gets to touch either directly).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { initialModeState, isParked, modeReducer, morphArtifactContent, mountApp } from "../src/viewer.js";
import { type DomEnv, installDom } from "./dom-env.ts";

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
    expect(inPane(root, ".glosa-empty-title")?.textContent).toBe("This document is gone.");
    expect(dom.document.title).toBe("notes.md — ws-1");
  });

  const settle = async () => {
    for (let i = 0; i < 40; i++) await Promise.resolve();
  };

  /** A fake with the star routes (A1 §5.21) over an in-memory store, and live workspaces that a
   * reopened star joins. */
  function starringDataAccess({
    live = [{ slug: "ws-1", path: "/tmp/ws-1", kind: "directory" }],
    starred = [] as any[],
  }: {
    live?: any[];
    starred?: any[];
  } = {}) {
    const workspaces = [...live];
    const stars = [...starred];
    const calls = { star: [] as string[], unstar: [] as string[], open: [] as string[] };
    const rowFor = (star: any) => {
      const w = workspaces.find((x) => x.path === star.path);
      return w ? { ...star, state: "open", slug: w.slug, has_attention: false } : { ...star };
    };
    const da = fakeDataAccess({
      getWorkspaces: async () => workspaces.map((w) => ({ ...w })),
      getStars: async () => stars.map(rowFor),
      starWorkspace: async (slug: string) => {
        calls.star.push(slug);
        const w = workspaces.find((x) => x.slug === slug)!;
        const star = { id: `star-${slug}`, name: w.path.split("/").pop(), path: w.path, state: "closed" };
        stars.push(star);
        return rowFor(star);
      },
      unstarWorkspace: async (id: string) => {
        calls.unstar.push(id);
        stars.splice(
          stars.findIndex((x) => x.id === id),
          1,
        );
      },
      openStar: async (id: string) => {
        calls.open.push(id);
        const star = stars.find((x) => x.id === id)!;
        const slug = `${star.name}-reopened`;
        workspaces.push({ slug, path: star.path, kind: "directory" });
        return { slug, path: star.path, kind: "directory" };
      },
    });
    return { da, calls, workspaces, stars };
  }

  test("the navigator has no workspace switcher at the top; stars wait at its foot", async () => {
    // An older daemon without star routes: no Starred section and no star to take.
    const legacy = dom.document.createElement("div");
    dom.document.body.append(legacy);
    mountApp(legacy, {
      surfaceKind: "desk",
      dataAccess: fakeDataAccess({
        getWorkspaces: async () => [
          { slug: "ws-1", path: "/tmp/ws-1" },
          { slug: "ws-2", path: "/tmp/ws-2" },
        ],
      }),
    });
    await settle();
    expect(legacy.querySelector(".glosa-workspace-list")).toBeNull();
    expect(legacy.querySelector("#glosa-workspaces-toggle")).toBeNull();
    expect((legacy.querySelector(".glosa-starred") as any).hidden).toBe(true);
    expect((legacy.querySelector(".glosa-star-toggle") as any).hidden).toBe(true);

    // Nothing starred yet: the section stays hidden, and the heading offers the first star.
    const fresh = dom.document.createElement("div");
    dom.document.body.append(fresh);
    mountApp(fresh, { dataAccess: starringDataAccess().da, surfaceKind: "desk" });
    await settle();
    const sidebar = fresh.querySelector(".glosa-sidebar") as any;
    expect(sidebar.firstElementChild.classList.contains("glosa-sidebar-scroll")).toBe(true);
    expect(sidebar.querySelector(".glosa-starred")).not.toBeNull();
    // Settings rides the foot strip beside the navigator's toggle, not a row of its own in the column.
    expect(sidebar.lastElementChild.classList.contains("glosa-starred")).toBe(true);
    const foot = fresh.querySelector(".glosa-nav-foot") as any;
    expect(foot.lastElementChild.classList.contains("glosa-sidebar-settings")).toBe(true);
    expect(foot.lastElementChild.textContent).toBe("Settings");
    expect(sidebar.querySelector(".glosa-starred").hidden).toBe(true);
    const toggle = fresh.querySelector(".glosa-sidebar-heading .glosa-star-toggle") as any;
    expect(toggle.hidden).toBe(false);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(toggle.getAttribute("aria-label")).toBe("Star ws-1");
  });

  test("starring the current workspace lists it under Starred; unstarring removes it; collapse persists", async () => {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    const { da, calls } = starringDataAccess();
    mountApp(root, { dataAccess: da, surfaceKind: "desk" });
    await settle();

    const toggle = root.querySelector(".glosa-star-toggle") as any;
    toggle.click();
    await settle();
    expect(calls.star).toEqual(["ws-1"]);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.getAttribute("aria-label")).toBe("Unstar ws-1");
    const section = root.querySelector(".glosa-starred") as any;
    expect(section.hidden).toBe(false);
    const row = root.querySelector(".glosa-starred-row") as any;
    expect(row.getAttribute("data-state")).toBe("open");
    expect(row.querySelector(".glosa-starred-name").textContent).toBe("ws-1");
    expect(row.querySelector(".glosa-starred-open").getAttribute("aria-current")).toBe("true");
    expect(row.querySelector(".glosa-starred-unstar").getAttribute("aria-label")).toBe("Unstar ws-1");

    const sectionToggle = root.querySelector("#glosa-starred-toggle") as any;
    const list = root.querySelector("#glosa-starred-list") as any;
    expect(sectionToggle.getAttribute("aria-controls")).toBe(list.id);
    sectionToggle.click();
    expect(sectionToggle.getAttribute("aria-expanded")).toBe("false");
    expect(list.hidden).toBe(true);
    expect(globalThis.localStorage.getItem("glosa_nav_starred")).toBe("false");
    sectionToggle.click();

    row.querySelector(".glosa-starred-unstar").click();
    await settle();
    expect(calls.unstar).toEqual(["star-ws-1"]);
    expect(section.hidden).toBe(true);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
  });

  test("a closed star reopens by id and becomes the current workspace; a missing one does not try", async () => {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    const { da, calls } = starringDataAccess({
      starred: [
        { id: "star-drafts", name: "drafts", path: "/tmp/drafts", state: "closed" },
        { id: "star-gone", name: "gone", path: "/tmp/gone", state: "missing" },
      ],
    });
    mountApp(root, { dataAccess: da, initialSlug: "ws-1", initialArtifact: "notes.md" });
    await settle();
    expect((root.querySelector(".glosa-topbar-name") as any).textContent).toBe("Search documents and chats");

    const rows = Array.from(root.querySelectorAll(".glosa-starred-row")) as any[];
    expect(
      rows.map((r) => [r.getAttribute("data-state"), r.querySelector(".glosa-starred-meta")?.textContent]),
    ).toEqual([
      ["closed", "Not open"],
      ["missing", "Folder not found"],
    ]);

    const gone = rows[1].querySelector(".glosa-starred-open");
    expect(gone.getAttribute("aria-disabled")).toBe("true");
    gone.click();
    await settle();
    expect(calls.open).toEqual([]);

    rows[0].querySelector(".glosa-starred-open").click();
    await settle();
    expect(calls.open).toEqual(["star-drafts"]);
    const reopened = root.querySelector('.glosa-starred-row[data-star="star-drafts"]') as any;
    expect(reopened.getAttribute("data-state")).toBe("open");
    expect(reopened.querySelector(".glosa-starred-open").getAttribute("aria-current")).toBe("true");
    expect(globalThis.localStorage.getItem("glosa_last_workspace")).toBe("drafts-reopened");
    // The bar no longer names the document of the workspace that was left.
    expect((root.querySelector(".glosa-goto-trigger") as any).title).toContain("drafts-reopened");
  });

  test("a reopen that fails says so on its row and leaves the current workspace alone", async () => {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    const { da } = starringDataAccess({
      starred: [{ id: "star-drafts", name: "drafts", path: "/tmp/drafts", state: "closed" }],
    });
    (da as any).openStar = async () => {
      throw new Error("workspace is being forgotten");
    };
    mountApp(root, { dataAccess: da });
    await settle();
    (root.querySelector(".glosa-starred-open") as any).click();
    await settle();
    const row = root.querySelector(".glosa-starred-row") as any;
    expect(row.getAttribute("data-state")).toBe("error");
    expect(row.querySelector(".glosa-starred-meta").textContent).toBe("Couldn't open");
    expect(row.querySelector(".glosa-starred-open").title).toContain("workspace is being forgotten");
    // The reason reaches people who never see a tooltip.
    expect((root.querySelector('.glosa-visually-hidden[role="status"]') as any).textContent).toBe(
      "drafts could not be opened. workspace is being forgotten",
    );
    expect(globalThis.localStorage.getItem("glosa_last_workspace")).toBe("ws-1");
  });

  test("with several live workspaces and no deep link, the page opens on the one this browser last had", async () => {
    globalThis.localStorage.setItem("glosa_last_workspace", "ws-2");
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    const opened: string[] = [];
    const { da } = starringDataAccess({
      live: [
        { slug: "ws-1", path: "/tmp/ws-1", kind: "directory", last_seen: "2026-09-17T10:00:00Z" },
        { slug: "ws-2", path: "/tmp/ws-2", kind: "directory", last_seen: "2026-09-01T10:00:00Z" },
      ],
    });
    const getArtifacts = (da as any).getArtifacts;
    (da as any).getArtifacts = async (slug: string) => {
      opened.push(slug);
      return getArtifacts(slug);
    };
    mountApp(root, { dataAccess: da });
    await settle();
    expect(opened).toEqual(["ws-2"]);

    // Forgetting that, it opens on the most recently active one instead.
    globalThis.localStorage.removeItem("glosa_last_workspace");
    const next = dom.document.createElement("div");
    dom.document.body.append(next);
    opened.length = 0;
    mountApp(next, { dataAccess: da });
    await settle();
    expect(opened).toEqual(["ws-1"]);
  });

  test("Go to lists every live workspace under @, marks stars, and switches on Enter", async () => {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    const opened: string[] = [];
    const { da } = starringDataAccess({
      live: [
        { slug: "ws-1", path: "/tmp/ws-1", kind: "directory" },
        { slug: "notes-9f", path: "/Users/example/notes", kind: "directory" },
      ],
      starred: [{ id: "star-notes", name: "notes", path: "/Users/example/notes", state: "closed" }],
    });
    const getArtifacts = (da as any).getArtifacts;
    (da as any).getArtifacts = async (slug: string) => {
      opened.push(slug);
      return getArtifacts(slug);
    };
    mountApp(root, { dataAccess: da, initialSlug: "ws-1" });
    await settle();

    (root.querySelector(".glosa-goto-trigger") as any).click();
    const input = root.querySelector(".glosa-palette-input") as any;
    input.value = "@";
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    const items = Array.from(root.querySelectorAll('.glosa-palette-item[data-kind="workspace"]')) as any[];
    expect(items.map((item) => item.querySelector(".glosa-palette-label").textContent)).toEqual(["ws-1", "notes"]);
    expect(items[0].getAttribute("aria-current")).toBe("location");
    expect(items[0].querySelector(".glosa-palette-star").innerHTML).toBe("");
    expect(items[1].querySelector(".glosa-palette-star svg")).not.toBeNull();
    expect(items[1].querySelector(".glosa-palette-meta").textContent).toBe("/Users/example");

    input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle();
    expect(opened).toEqual(["ws-1", "notes-9f"]);
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
    // Workspace-scoped only: the attention tray, Appearance and the keyboard
    // sheet. Copy source, Print and History moved into the pane that holds their artifact.
    expect(
      menu.querySelectorAll(":scope > .glosa-attention, :scope > button, :scope > .glosa-appearance"),
    ).toHaveLength(3);
    expect(menu.querySelector(".glosa-conversation-toggle")).toBeNull();
    expect(menu.querySelector(".glosa-tools-copy-source")).toBeNull();
    expect(menu.querySelector(".glosa-tools-print")).toBeNull();
    expect(menu.querySelector(".glosa-history-toggle")).toBeNull();

    trigger.click();
    await Promise.resolve();
    expect(tools.dataset.open).toBe("true");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(dom.document.activeElement as any).toBe(menu.querySelector("button:not(:disabled)") as any);

    (menu.querySelector(".glosa-shortcuts-toggle") as any).click();
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
    expect(dom.document.title).toBe("outline.md — ws-1"); // the active pane's file reaches the tab title
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
    inPane(root, ".glosa-tools-edit-source").click();
    // Edit is the same page with a caret in it: the reader keeps their place instead of being
    // sent back to the top.
    expect(main.scrollTop).toBe(600);
    // §8: the measure follows the face. Rich is prose; Source is markdown and gets the pane.
    expect(activePane(root).getAttribute("data-editor-face")).toBe("rich");
    const richTextbox = root.querySelector('.ProseMirror[role="textbox"]');
    if (richTextbox) {
      expect(richTextbox.getAttribute("aria-label")).toBe("Document editor");
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
    // #271: the byte-exact editor moved from the mode control into More.
    (root.querySelector(".glosa-tools-edit-source") as any).click();
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

    // The page opens with notes shown, so selecting text is enough; no mode switch first.
    expect(activePane(root).getAttribute("data-mode")).toBe("review");

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

  test("Review mode: the composer's intent is one radio group, and the intent picked is the one sent", async () => {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    const da = fakeDataAccess();

    mountApp(root, { dataAccess: da });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    (root.querySelector('.glosa-artifact-list .glosa-tree-row[data-tree-action="open"]') as any).click();
    for (let i = 0; i < 5; i++) await Promise.resolve();

    const content = inPane(root, ".glosa-content");
    const textNode = content.querySelector("h1")!.firstChild!;
    (content.querySelector("h1") as unknown as HTMLElement).scrollIntoView = () => {};
    const range = dom.document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 5);
    const selection = dom.window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    content.dispatchEvent(new dom.window.Event("mouseup", { bubbles: true }));
    for (let i = 0; i < 5; i++) await Promise.resolve();

    // One choice of three with one already made: a named radio group, not three toggle buttons,
    // so assistive technology hears "1 of 3, checked" and the keyboard gets one stop, not three.
    const group = root.querySelector(".glosa-composer-intents") as any;
    expect(group.getAttribute("role")).toBe("radiogroup");
    const radios = [...group.querySelectorAll("input")] as any[];
    expect(radios.map((r) => [r.type, r.value])).toEqual([
      ["radio", "content"],
      ["radio", "classification"],
      ["radio", "style"],
    ]);
    expect(new Set(radios.map((r) => r.name)).size).toBe(1);
    expect(radios.filter((r) => r.checked).map((r) => r.value)).toEqual(["content"]);
    expect(group.querySelector("button")).toBeNull();

    radios[2].click();
    expect(radios.filter((r) => r.checked).map((r) => r.value)).toEqual(["style"]);

    (root.querySelector(".glosa-composer-input") as any).value = "the list renders as one line";
    (root.querySelector(".glosa-composer-send") as any).click();
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(da.posted).toHaveLength(1);
    expect((da.posted[0] as { intent: string }).intent).toBe("style");
  });

  test("Review mode: a focused passage opens the composer with Enter and Cancel restores passage focus", async () => {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    const da = fakeDataAccess();

    mountApp(root, { dataAccess: da });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    (root.querySelector('.glosa-artifact-list .glosa-tree-row[data-tree-action="open"]') as any).click();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(activePane(root).getAttribute("data-mode")).toBe("review");

    const heading = inPane(root, '.glosa-content > h1[data-line="0"]');
    const body = inPane(root, '.glosa-content > p[data-line="2"]');
    const content = inPane(root, ".glosa-content");
    expect(heading.getAttribute("tabindex")).toBe("0");
    expect(body.getAttribute("tabindex")).toBe("-1");
    expect(heading.hasAttribute("aria-describedby")).toBe(false);
    // Each pane owns its own instructions node, so the id is per pane rather than global — six
    // open artifacts must not share one element id.
    const instructions = activePane(root).querySelector(".glosa-visually-hidden[id]");
    expect(instructions.id).toStartWith("glosa-block-instructions-");
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

  test("new chat stays local without a model catalog and Chats collapses independently", async () => {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    const created: { settings: { model: string } }[] = [];
    let discoveries = 0;
    const da = fakeDataAccess({
      getChats: async () => ({ chats: [], external: [] }),
      getAgentStatus: async () => ({
        available: true,
        profiles: [
          {
            id: "a",
            provider: "claude-code",
            label: "Personal",
            enabled: true,
            isDefault: true,
            auth: { state: "authenticated" },
          },
        ],
        capabilities: {},
      }),
      getStatus: async () => ({ workspaces: [], sessions: [] }),
      discoverAgentModels: async () => {
        discoveries++;
      },
      createChat: async (_slug: string, input: { settings: { model: string } }) => {
        created.push(input);
        return { id: "fresh" };
      },
      getChat: async () => ({
        id: "fresh",
        title: "New chat",
        provider: "claude-code",
        profileId: "a",
        revision: 1,
        configRevision: 1,
        draftRevision: 0,
        draft: "",
        draftAttachments: [],
        settings: { model: "", effort: "", permissionMode: "default" },
        turns: [],
        content: [],
        decisions: [],
      }),
      openChatStream: () => () => {},
    });
    const unmount = mountApp(root, { dataAccess: da, initialMode: "read", surfaceKind: "desk" });
    try {
      for (let i = 0; i < 30; i++) await Promise.resolve();
      (root.querySelector('[aria-label="New chat"]') as unknown as HTMLButtonElement).click();
      for (let i = 0; i < 40; i++) await Promise.resolve();
      expect(created).toHaveLength(1);
      expect(created[0]!.settings.model).toBe("");
      expect(discoveries).toBe(0);
      const toggle = root.querySelector(".glosa-chat-list-toggle") as unknown as HTMLButtonElement;
      toggle.click();
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(
        (dom.document.getElementById(toggle.getAttribute("aria-controls")!) as unknown as HTMLElement).hidden,
      ).toBe(true);
      expect(root.querySelector(".glosa-artifact-list")!.closest("[hidden]")).toBeNull();
      toggle.click();
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      const artifactsToggle = root.querySelector(".glosa-artifact-list-toggle") as unknown as HTMLButtonElement;
      artifactsToggle.click();
      expect(artifactsToggle.getAttribute("aria-expanded")).toBe("false");
      expect(root.querySelector(".glosa-artifact-list")!.closest("[hidden]")).not.toBeNull();
      expect(dom.document.getElementById(toggle.getAttribute("aria-controls")!)!.closest("[hidden]")).toBeNull();
      artifactsToggle.click();
      expect(root.querySelector(".glosa-artifact-list")!.closest("[hidden]")).toBeNull();
    } finally {
      unmount();
    }
  });

  test("sidebar limits conversations to 20 title rows, pins persist, and shared search reaches older chats and terminal sessions", async () => {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    const chats = Array.from({ length: 24 }, (_, i) => ({
      id: `chat-${i}`,
      title: `Topic ${i}`,
      provider: "claude-code",
      profileId: "a",
      pinned: false,
      configRevision: 1,
      status: "completed",
      updatedAt: new Date(2026, 0, 25 - i).toISOString(),
    }));
    const calls: any[] = [];
    const da = fakeDataAccess({
      getChats: async (_slug: string, options: any) => {
        calls.push(options);
        return {
          chats: chats.filter((c) => !options.q || c.title.includes(options.q)),
          external: [{ sessionId: "terminal-id", provider: "codex" }],
        };
      },
      getAgentStatus: async () => ({ profiles: [{ id: "a", label: "Personal" }] }),
      getStatus: async () => ({ sessions: [], workspaces: [] }),
      getChat: async (_slug: string, id: string) => chats.find((c) => c.id === id),
      changeChat: async (_slug: string, id: string, input: any) =>
        Object.assign(chats.find((c) => c.id === id)!, input),
    });
    const unmount = mountApp(root, { dataAccess: da, initialMode: "read" });
    try {
      await settle();
      expect(root.querySelectorAll(".glosa-chat-list-item")).toHaveLength(20);
      expect(root.querySelector(".glosa-chat-list-toggle")!.textContent).toBe("Chats");
      expect(root.querySelector('[placeholder="Find chats"]')).toBeNull();
      expect(root.querySelector(".glosa-chat-list-item svg")).toBeNull();
      const secondRow = root.querySelectorAll(".glosa-chat-list-row")[1]!;
      (secondRow.querySelector(".glosa-agent-menu button") as any).click();
      await settle();
      expect(root.querySelector(".glosa-chat-list-title")!.textContent).toBe("Topic 1");
      expect(chats[1]!.pinned).toBe(true);
      (root.querySelector(".glosa-goto-trigger") as any).click();
      await settle();
      expect([...root.querySelectorAll('[data-kind="chat"]')].some((n) => n.textContent?.includes("Topic 23"))).toBe(
        true,
      );
      expect([...root.querySelectorAll('[data-kind="chat"]')].some((n) => n.textContent?.includes("Codex"))).toBe(true);
      expect(calls.some((c) => c.archived === true)).toBe(true);
    } finally {
      unmount();
    }
  });

  test("chat rows and hover text stay title-only when accounts or titles change", async () => {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    let label = "Personal subscription",
      title = "Draft";
    const da = fakeDataAccess({
      getChats: async () => ({
        chats: [
          {
            id: "existing",
            title,
            provider: "claude-code",
            profileId: "profile-a",
            status: "completed",
            pendingDecisions: 2,
            updatedAt: "2026-09-23T00:00:00Z",
          },
        ],
        external: [],
      }),
      getAgentStatus: async () => ({ profiles: [{ id: "profile-a", label }] }),
      getStatus: async () => ({ workspaces: [], sessions: [] }),
    });
    const unmount = mountApp(root, { dataAccess: da, initialMode: "read" });
    async function waitForTitle(expected: string) {
      const deadline = Date.now() + 1000;
      while (root.querySelector(".glosa-chat-list-item")?.getAttribute("title") !== expected && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 0));
      expect(root.querySelector(".glosa-chat-list-item")?.getAttribute("title")).toBe(expected);
    }
    try {
      await waitForTitle(title);
      expect(root.querySelector(".glosa-chat-list-item")?.getAttribute("aria-label")).toBe("Draft");
      expect(root.querySelector(".glosa-chat-list-item")?.textContent).toBe("Draft");
      label = "Work subscription";
      title = "Revised draft";
      const refresh = [...root.querySelectorAll("button")].find((button) => button.textContent === "Refresh chats");
      (refresh as unknown as HTMLButtonElement).click();
      await waitForTitle(title);
    } finally {
      unmount();
    }
  });

  test("external sessions open as exact-session tabs while artifact history stays in its own pane", async () => {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    const opened: unknown[] = [],
      remembered: unknown[] = [];
    const da = fakeDataAccess({
      getChats: async () => ({ chats: [], external: [] }),
      getStatus: async () => ({
        workspaces: [],
        sessions: [
          { session_id: "external-a", provider: "claude-code", workspace_binding: "/tmp/ws-1", liveness: "alive" },
          { session_id: "external-b", provider: "codex", workspace_binding: "/tmp/ws-1", liveness: "alive" },
        ],
      }),
      rememberExternalChat: async (slug: string, sessionId: string) => {
        remembered.push({ slug, sessionId });
      },
      openSessionTranscript: (slug: string, sessionId: string) => {
        opened.push({ slug, sessionId });
        return () => {};
      },
    });
    const unmount = mountApp(root, { dataAccess: da, initialMode: "read" });
    for (let i = 0; i < 15; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(root.querySelector(".glosa-conversation-toggle")).toBeNull();
    expect(root.querySelectorAll(".glosa-chat-list-item")).toHaveLength(2);
    (root.querySelectorAll(".glosa-chat-list-item")[1] as unknown as HTMLButtonElement).click();
    for (let i = 0; i < 15; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(opened).toEqual([{ slug: "ws-1", sessionId: "external-b" }]);
    expect(remembered).toEqual([{ slug: "ws-1", sessionId: "external-b" }]);
    const external = root.querySelector(".glosa-external-chat");
    expect(external?.querySelector(".glosa-conv-composer-input")).not.toBeNull();
    (
      root.querySelector(
        '.glosa-artifact-list .glosa-tree-row[data-tree-action="open"]',
      ) as unknown as HTMLButtonElement
    ).click();
    for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    const historyToggle = inPane(root, ".glosa-history-toggle"),
      historyPane = inPane(root, ".glosa-history");
    historyToggle.click();
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(historyPane.hidden).toBe(false);
    expect(external?.isConnected).toBe(true);
    expect(root.querySelector(".glosa-topbar .glosa-history-toggle")).toBeNull();
    unmount();
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

  test("single-document history renders a selected comparison inline because tabs are unavailable", async () => {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    const diffCalls: unknown[] = [];
    const da = fakeDataAccess({
      getCheckpoints: async () => [
        { checkpoint_id: "c2", at: "2026-09-22T10:00:00Z", by: "human", summary: "edit" },
        { checkpoint_id: "c1", at: "2026-09-22T09:00:00Z", by: "unknown", summary: "baseline" },
      ],
      getDiff: async (_slug: string, range: unknown) => {
        diffCalls.push(range);
        return {
          from: "c2",
          to: "c1",
          hunks: [
            {
              path: "notes.md",
              attribution: "human",
              diff: "diff --git a/notes.md b/notes.md\n--- a/notes.md\n+++ b/notes.md\n@@ -1 +1 @@\n-old\n+new\n",
            },
          ],
        };
      },
    });

    (mountApp as any)(root, {
      dataAccess: da,
      surface: "document",
      initialSlug: "ws-1",
      initialArtifact: "notes.md",
    });
    for (let i = 0; i < 5; i++) await Promise.resolve();

    (inPane(root, ".glosa-history-toggle") as any).click();
    const history = inPane(root, ".glosa-history");
    for (let i = 0; i < 5 && history.querySelectorAll('input[type="checkbox"]').length < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const checkboxes = Array.from(history.querySelectorAll('input[type="checkbox"]')) as any[];
    expect(checkboxes).toHaveLength(2);
    checkboxes[0]!.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    checkboxes[1]!.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    const historyStatus = inPane(root, ".glosa-history-status");
    for (let i = 0; i < 5 && historyStatus.textContent === "Loading comparison…"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(diffCalls).toEqual([{ from: "c2", to: "c1" }]);
    expect(root.querySelectorAll('.glosa-pane[data-kind="diff"]')).toHaveLength(0);
    expect(historyStatus.textContent).toBe("Comparison ready.");
    expect(inPane(root, ".glosa-diff-pane .d2h-ins")).not.toBeNull();
  });

  test("workspace history opens a selected comparison in a diff tab", async () => {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    const da = fakeDataAccess({
      getCheckpoints: async () => [
        { checkpoint_id: "c2", at: "2026-09-22T10:00:00Z", by: "human", summary: "edit" },
        { checkpoint_id: "c1", at: "2026-09-22T09:00:00Z", by: "unknown", summary: "baseline" },
      ],
      getDiff: async () => ({ from: "c2", to: "c1", hunks: [] }),
    });

    mountApp(root, { dataAccess: da });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    (root.querySelector('.glosa-artifact-list .glosa-tree-row[data-tree-action="open"]') as any).click();
    for (let i = 0; i < 5; i++) await Promise.resolve();

    (inPane(root, ".glosa-history-toggle") as any).click();
    const artifactPane = activePane(root);
    for (let i = 0; i < 5 && artifactPane.querySelectorAll('.glosa-history input[type="checkbox"]').length < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const checkboxes = Array.from(artifactPane.querySelectorAll('.glosa-history input[type="checkbox"]')) as any[];
    expect(checkboxes).toHaveLength(2);
    checkboxes[0]!.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    checkboxes[1]!.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    for (let i = 0; i < 5 && root.querySelectorAll('.glosa-pane[data-kind="diff"]').length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(root.querySelectorAll('.glosa-pane[data-kind="diff"]')).toHaveLength(1);
    expect(artifactPane.querySelector(".glosa-history-status")?.textContent).toBe("Comparison opened in a new tab.");
  });

  test("workspace surface updates the tab title for workspace and artifact focus", async () => {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);

    mountApp(root, { dataAccess: fakeDataAccess() });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(dom.document.title).toBe("ws-1");

    (root.querySelector('.glosa-artifact-list .glosa-tree-row[data-tree-action="open"]') as any).click();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(dom.document.title).toBe("notes.md — ws-1");
  });

  test("the title is the way into Go to, and a journal apply lease pauses Edit in the open pane until it ends", async () => {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    const da = fakeDataAccess();
    mountApp(root, { dataAccess: da });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    (root.querySelector('.glosa-artifact-list .glosa-tree-row[data-tree-action="open"]') as any).click();
    for (let i = 0; i < 5; i++) await Promise.resolve();

    const trigger = root.querySelector(".glosa-goto-trigger") as any;
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    trigger.click();
    expect((root.querySelector(".glosa-palette") as any).hidden).toBe(false);
    (root.querySelector(".glosa-palette-input") as any).dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );

    // #271 moved the byte-exact editor out of the mode control and into More, so the apply-lease
    // pause is stated on that row now. The behaviour under test — a lease pauses editing and lifts
    // when it ends — is unchanged; only the element carrying it moved.
    const edit = () => inPane(root, ".glosa-tools-edit-source");
    expect(edit().disabled).toBe(false);
    da.stream.handlers?.onEvent?.({
      event: "journal",
      data: { event: "apply_begin", entry: "inb-9", detail: { lease_id: "L1", expires_at: null } },
    });
    expect(edit().disabled).toBe(true);
    da.stream.handlers?.onEvent?.({
      event: "journal",
      data: { event: "apply_end", entry: "inb-9", detail: { lease_id: "L1" } },
    });
    expect(edit().disabled).toBe(false);

    // Issue #155: apply-begin now writes `claim_taken`, not `apply_begin`. A claim over THIS file
    // pauses it; a claim over another file, or a presence claim, does not; a release lifts it.
    // Ablating the `claim_taken` arm leaves the pane editable under a live claim (red below).
    const journal = (data: Record<string, unknown>) => da.stream.handlers?.onEvent?.({ event: "journal", data });
    journal({ event: "claim_taken", detail: { claim_id: "C-other", mode: "exclusive", paths: ["essay.md"] } });
    expect(edit().disabled).toBe(false);
    journal({ event: "claim_taken", detail: { claim_id: "C-look", mode: "presence", paths: ["notes.md"] } });
    expect(edit().disabled).toBe(false);
    journal({ event: "claim_taken", detail: { claim_id: "C1", mode: "exclusive", paths: ["notes.md"] } });
    expect(edit().disabled).toBe(true);
    journal({ event: "claim_released", detail: { claim_id: "C1", by: "human" } });
    expect(edit().disabled).toBe(false);
    journal({ event: "claim_taken", detail: { claim_id: "C2", mode: "exclusive", paths: [] } });
    expect(edit().disabled).toBe(true); // no recorded paths covers the whole workspace
    journal({ event: "claim_expired", detail: { claim_id: "C2", holder_session: "A", reason: "ttl" } });
    expect(edit().disabled).toBe(false);

    // ⌘E turns Edit on, and again turns it off. OFF IS THE PLAIN PAGE, not whichever view Edit was
    // entered from: Note and Edit are two controls that turn each other off, so pressing Edit a
    // second time cannot restore a Note state the reader watched switch off when they pressed it
    // the first time. This test used to assert the opposite, under the one-toggle-plus-Done model.
    dom.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "e", metaKey: true, bubbles: true }));
    expect(activePane(root).getAttribute("data-mode")).toBe("edit");
    dom.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "e", metaKey: true, bubbles: true }));
    expect(activePane(root).getAttribute("data-mode")).toBe("read");
  });

  test("issue #155: an open workspace hydrates its claims once, names the holder on the tab and in the pause, and forgets a released claim", async () => {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    let hydrations = 0;
    const since = new Date(Date.now() - 60_000).toISOString();
    const base = fakeDataAccess();
    const da = fakeDataAccess({
      getStatus: async () => ({
        ...(await (base.getStatus as () => Promise<Record<string, unknown>>)()),
        sessions: [
          {
            session_id: "sess-A-1234567890",
            provider: "claude-code",
            workspace_binding: "/tmp/ws-1",
            liveness: "alive",
            last_active_at: new Date().toISOString(),
          },
        ],
      }),
      getClaims: async () => {
        hydrations += 1;
        return {
          claims: [
            {
              claim_id: "C1",
              resources: ["entry:inb-9"],
              artifacts: ["artifact:notes.md"],
              mode: "exclusive",
              holder_session: "sess-A-1234567890",
              holder_principal: "token:0123abcd",
              fence: 1,
              since,
              expires_at: new Date(Date.now() + 600_000).toISOString(),
            },
          ],
          tombstones: [],
        };
      },
    });
    mountApp(root, { dataAccess: da });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    (root.querySelector('.glosa-artifact-list .glosa-tree-row[data-tree-action="open"]') as any).click();
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(hydrations).toBe(1);
    const badge = root.querySelector(".glosa-tab-claim") as any;
    expect(badge).not.toBeNull();
    expect(badge.getAttribute("data-mode")).toBe("exclusive");
    // Named from the explicit binding — the provider's own word for itself — never guessed.
    expect(badge.getAttribute("aria-label")).toMatch(/^Claude Code · session sess-A-1 · editing since \d\d:\d\d$/);
    const edit = inPane(root, ".glosa-tools-edit-source");
    expect(edit.disabled).toBe(true);
    expect(edit.title).toBe("Claude Code (session sess-A-1) is applying a change. Edit when it finishes.");

    da.stream.handlers?.onEvent?.({
      event: "journal",
      data: { event: "claim_released", detail: { claim_id: "C1", by: "human", holder_session: "sess-A-1234567890" } },
    });
    expect(root.querySelector(".glosa-tab-claim")).toBeNull();
    expect(inPane(root, ".glosa-tools-edit-source").disabled).toBe(false);
  });

  test("issue #155: a badge drawn before the connection data arrives is re-described with the provider's name once it does", async () => {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    const base = fakeDataAccess();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const da = fakeDataAccess({
      getStatus: async () => {
        await gate;
        return {
          ...(await (base.getStatus as () => Promise<Record<string, unknown>>)()),
          sessions: [
            {
              session_id: "sess-A-1234567890",
              provider: "claude-code",
              workspace_binding: "/tmp/ws-1",
              liveness: "alive",
              last_active_at: new Date().toISOString(),
            },
          ],
        };
      },
      getClaims: async () => ({
        claims: [
          {
            claim_id: "C1",
            resources: ["artifact:notes.md"],
            artifacts: ["artifact:notes.md"],
            mode: "exclusive",
            holder_session: "sess-A-1234567890",
            since: new Date().toISOString(),
            expires_at: new Date(Date.now() + 600_000).toISOString(),
          },
        ],
        tombstones: [],
      }),
    });
    mountApp(root, { dataAccess: da });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    (root.querySelector('.glosa-artifact-list .glosa-tree-row[data-tree-action="open"]') as any).click();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect((root.querySelector(".glosa-tab-claim") as any).getAttribute("aria-label")).toStartWith(
      "An agent session · ",
    );

    release();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect((root.querySelector(".glosa-tab-claim") as any).getAttribute("aria-label")).toStartWith(
      "Claude Code · session sess-A-1 · editing since ",
    );
  });

  test("issue #155: a holder the connection cannot prove is 'An agent session', and a presence claim is a ring that pauses nothing", async () => {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    const da = fakeDataAccess();
    mountApp(root, { dataAccess: da });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    (root.querySelector('.glosa-artifact-list .glosa-tree-row[data-tree-action="open"]') as any).click();
    for (let i = 0; i < 5; i++) await Promise.resolve();

    da.stream.handlers?.onEvent?.({
      event: "journal",
      data: {
        event: "claim_taken",
        detail: {
          claim_id: "P1",
          mode: "presence",
          paths: ["notes.md"],
          resources: ["artifact:notes.md"],
          session: "cwd-routed-99",
          since: new Date().toISOString(),
        },
      },
    });
    const badge = root.querySelector(".glosa-tab-claim") as any;
    expect(badge.getAttribute("data-mode")).toBe("presence");
    expect(badge.getAttribute("aria-label")).toStartWith(
      "An agent session · session cwd-rout · looking at this since ",
    );
    expect(inPane(root, ".glosa-tools-edit-source").disabled).toBe(false);
  });

  test("read lock shows no Notes or Edit controls and stays on the read page", async () => {
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
    // A locked page is for reading only: no Notes toggle to open the margin, no Edit to change it.
    expect(root.querySelectorAll(".glosa-modebar [data-mode]")).toHaveLength(0);
    // Mode is pane state now, so it is stamped on the pane rather than on the app root.
    expect(activePane(root).getAttribute("data-mode")).toBe("read");
  });

  // --- issue #95 / #152: the agent-feedback badge is driven by connection state alone ---

  const flush = async (n = 8) => {
    for (let i = 0; i < n; i++) await Promise.resolve();
  };

  test("combined control refreshes unbound/stale/connected without reload and resets green on failure", async () => {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
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

    statusResponse = statusOf([]);
    (da as any).stream.handlers?.onEvent?.({ event: "journal", data: {} });
    await flush();
    expect(control.getAttribute("data-state")).toBe("unbound");
    expect(control.textContent).toContain("Connect agent");
    expect(control.textContent).not.toContain("feedback off");
    expect(control.disabled).toBe(false);

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

  test("an annotation in an unbound workspace saves without any consent dialog (#152: nothing to wire)", async () => {
    const da = fakeDataAccess();
    await driveAnnotationSubmit(da);
    expect(dom.document.querySelector(".glosa-dialog")).toBeNull();
    expect((da as any).posted).toHaveLength(1);
  });

  describe("an arriving question is announced, and never moves the reader (#308)", () => {
    /** Mounts the workspace, optionally opens the artifact as a reader would, then pushes an inbox
     * that gained one anchored question. The tray refreshes on a journal frame, which is the real
     * path — nothing here reaches past the seam the daemon actually drives. */
    async function arrive(entries: unknown[], { open = false } = {}) {
      const da = fakeDataAccess();
      const root = dom.document.createElement("div");
      dom.document.body.append(root);
      let inbox: unknown[] = [];
      (da as any).getInbox = async () => ({ pending_count: inbox.length, attention: inbox });
      const unmount = mountApp(root, { dataAccess: da });
      const settle = async () => {
        for (let i = 0; i < 12; i++) await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
        for (let i = 0; i < 12; i++) await Promise.resolve();
      };
      await settle();
      if (open) {
        (root.querySelector('.glosa-artifact-list .glosa-tree-row[data-tree-action="open"]') as any).click();
        await settle();
        // Reading, notes hidden: the state an arrival used to yank the reader out of.
        const notes = root.querySelector('.glosa-modebar [data-control="notes"]') as any;
        if (notes?.getAttribute("aria-pressed") === "true") notes.click();
        await settle();
        expect(root.querySelector(".glosa-pane")?.getAttribute("data-mode")).toBe("read");
      }

      inbox = entries;
      (da as any).stream.handlers?.onEvent?.({ event: "journal", data: { entry: "inb-1" } });
      await settle();
      return { root, unmount };
    }

    const question = {
      id: "inb-1",
      created_at: "2026-09-05T10:00:00Z",
      status: "open",
      action: "ask",
      target_path: "notes.md",
      message: "Is argument X covered enough?",
      passage: { quote: { exact: "Body." } },
      approval_mode: false,
    };

    test("a reader with the artifact open is NOT switched to Review — they are offered the way there", async () => {
      // INVERTED, not deleted. This block used to assert the opposite: that an arrival switched the
      // pane to Review and scrolled to the passage once typing paused. #308 removed the move — and
      // with it the typing-gap timer, the 15s cap and the deferred reveal that could outlive the
      // dock, none of which can misfire when nothing is ever moved.
      const { root, unmount } = await arrive([question], { open: true });
      expect(root.querySelector(".glosa-pane")?.getAttribute("data-mode")).toBe("read");
      const notice = root.querySelector(".glosa-ask-notice") as any;
      expect(notice.hidden).toBe(false);
      expect(notice.querySelector(".glosa-ask-notice-go").textContent).toBe("Go to it");
      unmount();
    });

    test("'Go to it' is what switches the pane to Review", async () => {
      const { root, unmount } = await arrive([question], { open: true });
      (root.querySelector(".glosa-ask-notice-go") as any).click();
      for (let i = 0; i < 12; i++) await Promise.resolve();
      expect(root.querySelector(".glosa-pane")?.getAttribute("data-mode")).toBe("review");
      unmount();
    });

    test("it is said out loud, and the announcement does not claim to have moved anyone", async () => {
      const { root, unmount } = await arrive([question], { open: true });
      const live = root.querySelector('.glosa-visually-hidden[role="status"]');
      expect(live?.textContent).toContain("is asking about a passage in notes.md");
      expect(live?.textContent).not.toContain("Switched");
      unmount();
    });

    test("with nothing open, nothing is opened for the reader either — the Attention tray lists it", async () => {
      // Opening the artifact here was tried and removed: at boot the inbox can land before the
      // first pane exists, and that threw a reader who asked for Read into Review on load.
      const { root, unmount } = await arrive([question]);
      expect(root.querySelector(".glosa-pane")).toBeNull();
      expect(root.querySelector('.glosa-visually-hidden[role="status"]')?.textContent).toContain("notes.md");
      unmount();
    });

    test("a bare pointer earns a mark, never an announcement, a notice or an opened artifact", async () => {
      const { root, unmount } = await arrive([{ ...question, message: null, action: "point" }]);
      expect(root.querySelector(".glosa-pane")).toBeNull();
      expect(root.querySelector('.glosa-visually-hidden[role="status"]')?.textContent ?? "").not.toContain("asking");
      unmount();
    });

    test("going to a question in an unopened artifact survives the workspace being torn down mid-open", async () => {
      // The old deferred reveal outlived the workspace: its timer fired after teardown, called
      // openArtifact on a torn-down dock, and dockview threw on a missing ResizeObserver, which Bun
      // pinned on whichever unrelated file was running. The timer is gone. What remains async is
      // "Go to it" for an artifact nobody has open, and it has to respect teardown the same way.
      const other = { ...question, id: "inb-2", target_path: "other.md" };
      const { root, unmount } = await arrive([other], { open: true });
      (root.querySelector(".glosa-ask-notice-go") as any)?.click();
      unmount();
      root.remove();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(root.querySelector(".glosa-pane")).toBeNull();
    });
  });

  describe("surface kind (decision 2026-09-25): desk and companion are different surfaces", () => {
    test("a companion surface shows the agent connection and hides chats and stars", async () => {
      const root = dom.document.createElement("div");
      dom.document.body.append(root);
      mountApp(root, {
        dataAccess: fakeDataAccess({ getChats: async () => ({ chats: [], external: [] }) }),
        surfaceKind: "companion",
      });
      for (let i = 0; i < 8; i++) await Promise.resolve();
      expect(root.getAttribute("data-kind")).toBe("companion");
      expect((root.querySelector(".glosa-agent-feedback") as any).hidden).toBe(false);
      expect((root.querySelector(".glosa-sidebar-chats") as any).hidden).toBe(true);
      expect((root.querySelector(".glosa-star-toggle") as any).hidden).toBe(true);
      expect((root.querySelector(".glosa-starred") as any).hidden).toBe(true);
    });
    test("a desk surface shows chats and stars and has no agent connection chip", async () => {
      const root = dom.document.createElement("div");
      dom.document.body.append(root);
      const { da } = starringDataAccess();
      (da as any).getChats = async () => ({ chats: [], external: [] });
      mountApp(root, { dataAccess: da, surfaceKind: "desk" });
      for (let i = 0; i < 8; i++) await Promise.resolve();
      expect(root.getAttribute("data-kind")).toBe("desk");
      expect((root.querySelector(".glosa-agent-feedback") as any).hidden).toBe(true);
      expect((root.querySelector(".glosa-sidebar-chats") as any).hidden).toBe(false);
      expect((root.querySelector(".glosa-star-toggle") as any).hidden).toBe(false);
    });
    test("with no kind in the link the surface is companion, the shape every older link carried", async () => {
      const root = dom.document.createElement("div");
      dom.document.body.append(root);
      mountApp(root, { dataAccess: fakeDataAccess() });
      for (let i = 0; i < 8; i++) await Promise.resolve();
      expect(root.getAttribute("data-kind")).toBe("companion");
    });
  });
});

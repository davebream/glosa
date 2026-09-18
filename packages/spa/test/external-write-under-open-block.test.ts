// SPDX-License-Identifier: Apache-2.0
// A session writes the file while a block is open. Mounted in Edit, which is where a page is
// writable since Note and Edit became two states that turn each other off.
//
// This is the case per-block editing created and did not cover. Before #271 an external change
// could only reach a writer who was in Edit mode, where the whole conflict apparatus lives — the
// disk-change notice, the held baseline, the `If-Match` save, the block-level merge. Once clicking
// a paragraph became the ordinary way to write, that apparatus stopped being reachable: the notice
// rendered only in Edit, and the refresh morphed the manuscript out from under the open editor,
// taking the editor and everything typed into it with no notice at all.
//
// Each test names the way the fix could be quietly wrong rather than the behaviour it covers:
//
//   * A version that kept the editor alive but let `currentArtifact` move underneath would leave
//     the open run's byte offsets pointing into a document that no longer exists. Asserted on the
//     source the pane would save, not on whether the DOM node survived.
//   * A version that took the session's frame as soon as the run closed would destroy the writer's
//     words one moment later instead of immediately — the same loss, better hidden.
//   * A version that showed the notice to everyone would nag a reader every time an agent worked.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createArtifactPane } from "../src/artifact-pane.js";
import { type DomEnv, installDom } from "./dom-env.ts";

describe("an external write while a block is open", () => {
  let dom: DomEnv;

  beforeEach(() => {
    dom = installDom();
  });

  afterEach(() => {
    dom.teardown();
  });

  const flush = async (n = 20) => {
    for (let i = 0; i < n; i++) await Promise.resolve();
  };
  const paint = async () => {
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flush();
  };
  const q = (root: any, selector: string): any => root.querySelector(selector);
  /** Wait for the observable result, not for a tick count: opening a run awaits a dynamic import
   * whose cost differs between the first call in a process and every later one. */
  const settleUntil = async (predicate: () => boolean, attempts = 50) => {
    for (let i = 0; i < attempts && !predicate(); i++) await paint();
    return predicate();
  };

  const MINE = "# Title\n\nFirst paragraph.\n\nSecond paragraph.\n";
  const MINE_HTML =
    '<h1 data-line="0">Title</h1><p data-line="2">First paragraph.</p><p data-line="4">Second paragraph.</p>';
  const THEIRS = "# Title\n\nFirst paragraph, rewritten by a session.\n\nSecond paragraph.\n";
  const THEIRS_HTML =
    '<h1 data-line="0">Title</h1><p data-line="2">First paragraph, rewritten by a session.</p><p data-line="4">Second paragraph.</p>';

  function fakeDataAccess() {
    return {
      saved: [] as string[],
      /** Flipped to stand for "a session has written the file since this pane read it". */
      moved: false,
      async getArtifact() {
        return this.moved
          ? {
              source_path: "notes.md",
              content: THEIRS,
              rendered_html: THEIRS_HTML,
              source_sha256: "sha-session",
              rendered_sha256: "r-2",
              class: "R",
            }
          : {
              source_path: "notes.md",
              content: MINE,
              rendered_html: MINE_HTML,
              source_sha256: "sha-mine",
              rendered_sha256: "r-1",
              class: "R",
            };
      },
      async getAnnotations() {
        return { annotations: [] };
      },
      async getCheckpoints() {
        return [];
      },
      async putArtifact(_slug: string, _path: string, content: string) {
        this.saved.push(content);
        return { source_sha256: "sha-written" };
      },
    };
  }

  async function mountPane(da: any, initialMode = "edit") {
    const host = dom.document.createElement("div");
    dom.document.body.append(host);
    const pane = createArtifactPane(host, {
      dataAccess: da,
      slug: "ws-1",
      path: "notes.md",
      initialMode,
      getAttentionEntries: () => [],
      refreshAttention: async () => {},
      getProviderName: () => "Claude Code",
    });
    await pane.ready;
    await paint();
    return { host, pane };
  }

  const openBlock = async (host: any, line: number) => {
    const block = q(host, `.glosa-content [data-line="${line}"]`);
    expect(block).toBeTruthy();
    block.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 }));
    await settleUntil(() => Boolean(q(host, ".glosa-run-editor")));
    return block;
  };

  /** What the writer typed, driven through the mounted editor rather than simulated: the point of
   * these tests is what survives, and text the test itself holds would survive anything. */
  const typeInto = (host: any, text: string) => {
    const surface = q(host, ".glosa-run-editor .ProseMirror");
    expect(surface).toBeTruthy();
    surface.textContent = text;
    surface.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true }));
  };

  test("the open editor survives, and the manuscript is not repainted underneath it", async () => {
    const da = fakeDataAccess();
    const { host, pane } = await mountPane(da);
    await openBlock(host, 2);

    da.moved = true;
    await pane.refreshArtifact();
    await paint();

    expect(host.querySelectorAll(".glosa-run-editor")).toHaveLength(1);
    // Stated on the TEXT rather than on the element: a version that rebuilt the page and happened
    // to leave an empty editor host behind would pass an identity check and still have thrown the
    // writer's sentence away.
    expect(q(host, '.glosa-content [data-line="4"]')?.textContent).toBe("Second paragraph.");
    expect(host.textContent).not.toContain("rewritten by a session");
  });

  test("the notice says the file moved, without the full-page editor being open", async () => {
    const da = fakeDataAccess();
    const { host, pane } = await mountPane(da);
    await openBlock(host, 2);
    typeInto(host, "First paragraph, and a thought of my own.");
    await paint();

    da.moved = true;
    await pane.refreshArtifact();
    await paint();

    const notice = q(host, ".glosa-disk-change");
    expect(notice?.hidden).toBe(false);
    // The point this has always held: the notice is reachable without the full-page source editor,
    // which is where every part of the conflict apparatus used to live. Stated against that editor
    // rather than against the mode, since Edit is now simply the page being writable.
    expect(q(host, ".glosa-edit-wrap")?.hidden).toBe(true);
    // Floating rather than in the flow, because outside Edit the manuscript is the scroller and a
    // row above it would move the reader's place — the thing this redesign exists to stop.
    expect(notice?.hasAttribute("data-floating")).toBe(true);
  });

  test("a plain reader is not told: a session writing a document nobody is editing is not an event", async () => {
    const da = fakeDataAccess();
    const { host, pane } = await mountPane(da, "read");

    da.moved = true;
    await pane.refreshArtifact();
    await paint();

    expect(q(host, ".glosa-disk-change")?.hidden).toBe(true);
    // And the page DOES take the session's version, because there is nothing of the reader's to lose.
    expect(host.textContent).toContain("rewritten by a session");
  });

  test("pressing Edit and typing nothing is not a reason to be warned about the file", async () => {
    // The case that separates "the full-page editor is open" from "the pane is in Edit". Since Edit
    // became the page being writable rather than a textarea holding a draft, keying the notice on
    // the mode would put a banner in front of every reader who pressed Edit and then read.
    const da = fakeDataAccess();
    const { host, pane } = await mountPane(da);
    expect(pane.getMode()).toBe("edit");

    da.moved = true;
    await pane.refreshArtifact();
    await paint();

    expect(q(host, ".glosa-disk-change")?.hidden).toBe(true);
  });

  test("closing the block keeps the writer's words rather than taking the session's version", async () => {
    // The loss moved one moment later is still the loss. With local edits pending, the two versions
    // meet at the save, where `If-Match` refuses a stale write — not on the page, silently.
    const da = fakeDataAccess();
    const { host, pane } = await mountPane(da);
    await openBlock(host, 2);
    typeInto(host, "First paragraph, and a thought of my own.");
    await paint();

    da.moved = true;
    await pane.refreshArtifact();
    await paint();

    q(host, ".glosa-run-editor .ProseMirror")?.dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true }));
    await settleUntil(() => host.querySelectorAll(".glosa-run-editor").length === 0);
    await paint();

    expect(host.textContent).toContain("a thought of my own");
    expect(host.textContent).not.toContain("rewritten by a session");
    expect(pane.isDirty()).toBe(true);
  });

  test("closing an untouched block does take the session's version, since nothing is at stake", async () => {
    // The accidental-click case. Holding the frame forever would leave the page showing a document
    // the file no longer contains, which is its own quiet dishonesty.
    const da = fakeDataAccess();
    const { host, pane } = await mountPane(da);
    await openBlock(host, 2);

    da.moved = true;
    await pane.refreshArtifact();
    await paint();

    q(host, ".glosa-run-editor .ProseMirror")?.dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true }));
    await settleUntil(() => host.textContent.includes("rewritten by a session"));

    expect(host.textContent).toContain("rewritten by a session");
    expect(da.saved).toEqual([]);
  });

  test("an open block with a word typed into it counts as unsaved work", async () => {
    // `refreshArtifact` only records a disk change when the pane is dirty, so this is the predicate
    // the notice hangs off. Before the fix a block editor with a sentence in it reported clean.
    const da = fakeDataAccess();
    const { host, pane } = await mountPane(da);
    await openBlock(host, 2);
    expect(pane.isDirty()).toBe(false);

    typeInto(host, "First paragraph, and a thought of my own.");
    await paint();

    expect(pane.isDirty()).toBe(true);
  });
});

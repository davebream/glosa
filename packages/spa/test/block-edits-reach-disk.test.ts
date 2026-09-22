// SPDX-License-Identifier: Apache-2.0
// A block edit is written to the file. Mounted in Edit, which is where a page is writable since
// Note and Edit became two states that turn each other off.
//
// It was not. Since #271 made a block editable by clicking it, every such edit repainted the page,
// marked the pane dirty, and was never written by anything: `closeRunEditor` scheduled the debounced
// save, and `saveCurrentArtifact({ onlyIfDirty: true })` asked a dirty test that did not include
// `workingSource` — the one kind of edit the timer existed for. The writer saw their sentence on the
// page and lost it on reload.
//
// Two tests existed around this path and neither could see it. `block-editing.test.ts` asserts that
// an unchanged click writes NOTHING, which passes just as well when nothing is ever written; and the
// suites that do assert writes drive the full-page editor, whose dirty flag the check did cover. A
// green suite meant nothing here, which is the point: this file asserts on the bytes handed to
// `putArtifact`, the only place that can tell a save from the appearance of one.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createArtifactPane } from "../src/artifact-pane.js";
import { type DomEnv, installDom } from "./dom-env.ts";

describe("a block edit reaches the file", () => {
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
  const settleUntil = async (predicate: () => boolean, attempts = 60) => {
    for (let i = 0; i < attempts && !predicate(); i++) await paint();
    return predicate();
  };
  /** Real wall-clock: the write is coalesced behind a real timer, so no amount of microtask
   * draining reaches it. A poll rather than a fixed sleep, so the test is not pinned to the delay. */
  const written = async (da: any) => {
    for (let i = 0; i < 80 && da.saved.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 50));
    return da.saved[da.saved.length - 1];
  };

  const SOURCE = "# Title\n\nFirst paragraph.\n\nSecond paragraph.\n";
  const RENDERED =
    '<h1 data-line="0">Title</h1><p data-line="2">First paragraph.</p><p data-line="4">Second paragraph.</p>';

  function fakeDataAccess() {
    return {
      saved: [] as string[],
      async getArtifact() {
        return {
          source_path: "notes.md",
          content: SOURCE,
          rendered_html: RENDERED,
          source_sha256: "sha-1",
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
        return { source_sha256: "sha-2" };
      },
    };
  }

  async function mountPane(da: any) {
    const host = dom.document.createElement("div");
    dom.document.body.append(host);
    const pane = createArtifactPane(host, {
      dataAccess: da,
      slug: "ws-1",
      path: "notes.md",
      initialMode: "edit",
      getAttentionEntries: () => [],
      refreshAttention: async () => {},
      getProviderName: () => "Claude Code",
    });
    await pane.ready;
    await paint();
    return { host, pane };
  }

  async function editBlock(host: any, line: number, text: string) {
    const block = q(host, `.glosa-content [data-line="${line}"]`);
    expect(block).toBeTruthy();
    block.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 }));
    await settleUntil(() => Boolean(q(host, ".glosa-run-editor")));
    const surface = q(host, ".glosa-run-editor .ProseMirror");
    surface.textContent = text;
    surface.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true }));
    await paint();
    surface.dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true }));
    await settleUntil(() => !q(host, ".glosa-run-editor"));
  }

  test("the writer's sentence is written, and only their block changes", async () => {
    const da = fakeDataAccess();
    const { host } = await mountPane(da);
    await editBlock(host, 2, "First paragraph, edited by a human.");

    // The whole document, so a version that wrote only the run — or wrote it into the wrong place —
    // fails here rather than passing a check that the call merely happened.
    expect(await written(da)).toBe("# Title\n\nFirst paragraph, edited by a human.\n\nSecond paragraph.\n");
  });

  test("the pane is clean afterwards, so nothing is still being held", async () => {
    const da = fakeDataAccess();
    const { host, pane } = await mountPane(da);
    await editBlock(host, 2, "First paragraph, edited by a human.");
    await written(da);
    await settleUntil(() => !pane.isDirty());
    expect(pane.isDirty()).toBe(false);
  });

  test("closing the tab writes the pending edit rather than taking it with it", async () => {
    // PINS THE OUTCOME, NOT THE MECHANISM, and says so rather than implying a guard it is not.
    // Two things currently deliver it: `destroy` flushes the pending write, and the timer it would
    // otherwise leave behind fires regardless. Ablating the flush alone therefore stays green. What
    // this holds is the property worth holding — a tab closed a second after typing does not take
    // the sentence with it — so a later change that cancels pending work on destroy without writing
    // it first fails here, which is the realistic way this would regress.
    const da = fakeDataAccess();
    const { host, pane } = await mountPane(da);
    await editBlock(host, 2, "First paragraph, edited by a human.");
    pane.destroy();
    expect(await written(da)).toBe("# Title\n\nFirst paragraph, edited by a human.\n\nSecond paragraph.\n");
  });

  // What the page says about the write, and whether anyone can read it.
  //
  // The status line held the right words all along — it was inside the Save row, which is hidden
  // whenever the full-page face is not showing. Per-block editing is the ordinary way to edit, so
  // "Saved.", every error and the conflict message all went into a hidden element, and `hidden`
  // takes a node out of the accessibility tree too, so the `aria-live` region announced none of it.
  // An assertion on `textContent` alone would have passed throughout the defect; what has to be
  // asserted is that nothing between the line and the document is hiding it.
  const readable = (node: any): boolean => {
    for (let el = node; el && el !== dom.document.body; el = el.parentElement) if (el.hidden) return false;
    return Boolean(node);
  };
  /** Real wall-clock, for the same reason `written` is: the save is behind a coalescing timer, and
   * the line is only written when that timer fires. */
  const statusSays = async (host: any, needle: string) => {
    const text = () => q(host, ".glosa-edit-status")?.textContent ?? "";
    for (let i = 0; i < 80 && !text().includes(needle); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    return q(host, ".glosa-edit-status");
  };

  test("a saved passage says so where the writer can actually see it", async () => {
    const da = fakeDataAccess();
    const { host } = await mountPane(da);
    await editBlock(host, 2, "First paragraph, edited by a human.");
    await written(da);
    const status = await statusSays(host, "Saved");
    expect(status?.textContent).toContain("Saved");
    expect(readable(status), "the save confirmation is inside a hidden element").toBe(true);
    // And it is a live region, so it is announced rather than merely present.
    expect(status.getAttribute("aria-live")).toBe("polite");
  });

  test("a write that fails says so, rather than failing silently into a hidden node", async () => {
    const da = fakeDataAccess();
    da.putArtifact = async () => {
      throw new Error("daemon is not listening");
    };
    const { host } = await mountPane(da);
    await editBlock(host, 2, "First paragraph, edited by a human.");
    const status = await statusSays(host, "Couldn't save");
    // The reason, not just the fact: a writer who cannot see WHY cannot tell a crashed daemon from
    // a file that went read-only.
    expect(status?.textContent).toContain("daemon is not listening");
    expect(readable(status), "the failure is inside a hidden element").toBe(true);
    expect(status.getAttribute("data-error")).toBe("true");
  });

  test("the line is absent while there is nothing to say, rather than sitting empty under the page", async () => {
    const { host } = await mountPane(fakeDataAccess());
    expect(readable(q(host, ".glosa-edit-status"))).toBe(false);
  });

  // Undo after the save has taken the stack.
  //
  // Every write empties `runUndo`, roughly a second after typing stops, and that is right — the
  // checkpoint pair the write captured is what reverts a saved run, and a stack that outlived its
  // source would splice against moved offsets. What was wrong is that nothing said so, so the first
  // shortcut a writer reaches for went dead mid-sentence and read as a broken key.
  const pressUndo = (host: any) =>
    q(host, ".glosa-content").dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true }),
    );

  test("Cmd-Z after a save says where undo went instead of doing nothing", async () => {
    const da = fakeDataAccess();
    const { host } = await mountPane(da);
    await editBlock(host, 2, "First paragraph, edited by a human.");
    await written(da);
    await statusSays(host, "Saved");

    pressUndo(host);
    await paint();
    const status = q(host, ".glosa-edit-status");
    expect(status?.textContent).toContain("History");
    expect(readable(status)).toBe(true);
  });

  test("Cmd-Z on a document nobody has edited says nothing, because there is nothing to say", async () => {
    // The flag earns its place here: without it the sentence would fire on any bare Cmd-Z, which is
    // noise rather than help — there is no earlier version of an untouched passage to go back to.
    const { host } = await mountPane(fakeDataAccess());
    pressUndo(host);
    await paint();
    expect(readable(q(host, ".glosa-edit-status"))).toBe(false);
  });
});

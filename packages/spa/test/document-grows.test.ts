// SPDX-License-Identifier: Apache-2.0
// Adding to a document, and moving a caret between blocks that are separate editors.
//
// Per-block editing shipped understanding only gestures that NAMED AN EXISTING BLOCK, so a document
// could be changed word by word and never grow: no append point under the last paragraph, nothing to
// click on an empty file, and a caret that stopped dead at a block's edge. That is the difference
// between a page made of editable blocks and a document.
//
// Every assertion here is on the SOURCE the pane would write, not on the DOM. A version that put a
// caret in the right place while splicing the bytes somewhere else would look correct in a
// screenshot and would be the corruption the splice contract exists to prevent.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createArtifactPane } from "../src/artifact-pane.js";
import { type DomEnv, installDom } from "./dom-env.ts";

describe("a document can grow", () => {
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

  const SOURCE = "# Title\n\nFirst paragraph.\n\nSecond paragraph.\n";
  const RENDERED =
    '<h1 data-line="0">Title</h1><p data-line="2">First paragraph.</p><p data-line="4">Second paragraph.</p>';

  function fakeDataAccess(content = SOURCE, rendered = RENDERED) {
    return {
      saved: [] as string[],
      async getArtifact() {
        return {
          source_path: "notes.md",
          content,
          rendered_html: rendered,
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
      async putArtifact(_slug: string, _path: string, next: string) {
        this.saved.push(next);
        return { source_sha256: "sha-2" };
      },
    };
  }

  async function mountPane(da: any = fakeDataAccess()) {
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
    return { host, pane, da };
  }

  const content = (host: any) => q(host, ".glosa-content");
  const editor = (host: any) => q(host, ".glosa-run-editor");

  /** A click in the page's trailing space, under the last block. happy-dom gives every element a
   * zero rect, so "below the last block" is expressed by stubbing that one rect rather than by
   * trusting a layout the test environment does not perform. */
  const clickBelowLastBlock = async (host: any) => {
    const blocks = [...content(host).querySelectorAll(":scope > [data-line]")];
    const last = blocks[blocks.length - 1];
    if (last) last.getBoundingClientRect = () => ({ bottom: 100, top: 80, left: 0, right: 0, height: 20, width: 0 });
    content(host).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, clientX: 10, clientY: 500 }));
    await settleUntil(() => Boolean(editor(host)));
  };

  const openBlock = async (host: any, line: number) => {
    const block = q(host, `.glosa-content [data-line="${line}"]`);
    expect(block).toBeTruthy();
    block.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 }));
    await settleUntil(() => Boolean(editor(host)));
    return block;
  };

  /** Async on purpose: ProseMirror reads DOM changes through a MutationObserver, so the edit is not
   * in its document until the microtask queue has drained. Blurring before that closes the run over
   * an unchanged editor, which looks exactly like a writer who typed nothing. */
  const typeInto = async (host: any, text: string) => {
    const surface = q(host, ".glosa-run-editor .ProseMirror");
    expect(surface).toBeTruthy();
    surface.textContent = text;
    surface.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true }));
    await paint();
  };

  const blur = async (host: any) => {
    q(host, ".glosa-run-editor .ProseMirror")?.dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true }));
    await settleUntil(() => !editor(host));
  };

  /** The pane writes on a debounce, so the bytes it would save are read from the data-access it
   * actually calls rather than from any accessor added for the test's convenience. */
  const savedSource = async (da: any) => {
    // Real wall-clock, because the write is on a real `setTimeout` the pane uses to coalesce a burst
    // of edits into one inbox entry. Polling microtasks never reaches it.
    for (let i = 0; i < 60 && da.saved.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 50));
    return da.saved[da.saved.length - 1];
  };

  const pressIn = async (host: any, key: string) => {
    q(host, ".glosa-run-editor .ProseMirror")?.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key, bubbles: true }),
    );
    await paint();
  };

  test("clicking under the last paragraph opens somewhere to write", async () => {
    const { host } = await mountPane();
    await clickBelowLastBlock(host);
    expect(editor(host)).toBeTruthy();
    expect(editor(host).getAttribute("data-appended")).toBe("true");
  });

  test("what gets written is a new block, with exactly the blank line that makes it one", async () => {
    const { host, da } = await mountPane();
    await clickBelowLastBlock(host);
    await typeInto(host, "A third paragraph.");
    await blur(host);
    // Asserted on the whole document: the separator is the part a version could get wrong in a way
    // that still looks right on screen, by joining the new text onto the paragraph above it.
    expect(await savedSource(da)).toBe("# Title\n\nFirst paragraph.\n\nSecond paragraph.\n\nA third paragraph.");
  });

  test("an append the writer abandons leaves the file exactly as it was", async () => {
    // The click under the last paragraph has to be free, or it is not a click but a decision.
    const { host, pane } = await mountPane();
    await clickBelowLastBlock(host);
    await blur(host);
    expect(pane.isDirty()).toBe(false);
    expect(editor(host)).toBeFalsy();
  });

  test("an empty document has somewhere to start", async () => {
    // Nothing is rendered, so there is no block to click and no trailing space below one. Without
    // this the file could never receive its first word from glosa at all.
    const { host, da } = await mountPane(fakeDataAccess("", ""));
    await clickBelowLastBlock(host);
    expect(editor(host)).toBeTruthy();
    await typeInto(host, "The first line of a new document.");
    await blur(host);
    // No leading blank line: an empty file needs no separator before its first block.
    expect(await savedSource(da)).toBe("The first line of a new document.");
  });

  test("the caret leaves a block downward instead of stopping at its edge", async () => {
    const { host } = await mountPane();
    await openBlock(host, 2);
    await pressIn(host, "ArrowDown");
    await settleUntil(() => Boolean(q(host, '.glosa-content [data-line="2"]')));
    // The editor moved: the block it was over is rendered again, and the one below it is not.
    expect(q(host, '.glosa-content [data-line="2"]')).toBeTruthy();
    expect(q(host, '.glosa-content [data-line="4"]')).toBeFalsy();
  });

  test("the caret leaves a block upward too", async () => {
    const { host } = await mountPane();
    await openBlock(host, 4);
    await pressIn(host, "ArrowUp");
    await settleUntil(() => Boolean(q(host, '.glosa-content [data-line="4"]')));
    expect(q(host, '.glosa-content [data-line="4"]')).toBeTruthy();
    expect(q(host, '.glosa-content [data-line="2"]')).toBeFalsy();
  });

  test("Backspace at the head of a paragraph joins it to the one above", async () => {
    const { host, da } = await mountPane();
    await openBlock(host, 4);
    await pressIn(host, "Backspace");
    expect(await savedSource(da)).toBe("# Title\n\nFirst paragraph.Second paragraph.\n");
  });

  test("Delete at the end of a paragraph pulls the next one up", async () => {
    // Reached by stepping UP into the paragraph first, which is what leaves the caret at its end —
    // the same way a reader gets there, and the only way this test can put it there without a
    // hook that exists for the test's benefit.
    const { host, da } = await mountPane();
    await openBlock(host, 4);
    await pressIn(host, "ArrowUp");
    await settleUntil(() => Boolean(q(host, '.glosa-content [data-line="4"]')));
    await pressIn(host, "Delete");
    expect(await savedSource(da)).toBe("# Title\n\nFirst paragraph.Second paragraph.\n");
  });

  test("Backspace at the very first character does nothing, because there is nothing above it", async () => {
    const { host, pane } = await mountPane();
    await openBlock(host, 0);
    await pressIn(host, "Backspace");
    await paint();
    expect(pane.isDirty()).toBe(false);
  });
});

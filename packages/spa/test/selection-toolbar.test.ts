// SPDX-License-Identifier: Apache-2.0
// The formatting actions, and when they are allowed to exist.
//
// A block editor deliberately wears no toolbar: the page gains a caret and nothing else, and a row
// of buttons above the paragraph is the page gaining chrome exactly where it should be gaining none.
// That left a writer with no way to make a word bold short of typing asterisks, and nothing on the
// page answering "what can I do here".
//
// So the actions are bound to the gesture that asks for them — a selection — and the tests below are
// as much about the ABSENCE as the presence. A toolbar that is merely present would satisfy "the
// controls exist" and would be the chrome the design spent two rounds removing.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mountRichEditor, selectionToolbarShows } from "../src/rich-editor.js";
import { type DomEnv, installDom } from "./dom-env.ts";

describe("the selection toolbar", () => {
  let dom: DomEnv;

  beforeEach(() => {
    dom = installDom();
  });

  afterEach(() => {
    dom.teardown();
  });

  const paint = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };

  function mount(markdown = "A paragraph with several words in it.") {
    const host = dom.document.createElement("div");
    host.className = "glosa-run-editor";
    dom.document.body.append(host);
    // happy-dom's `HTMLElement` is nominally distinct from lib.dom's — see dom-env.ts's header.
    const editor = mountRichEditor(host as any, { markdown, toolbar: false, selectionToolbar: true });
    return { host, editor };
  }

  const bar = (host: any) => host.querySelector(".glosa-selection-toolbar");
  test("nothing is painted while the writer is only typing", async () => {
    // The state a writer is in almost all the time. If the toolbar were visible here it would be the
    // fixed bar this design removed, wearing a different name.
    const { host } = mount();
    await paint();
    expect(bar(host)).toBeTruthy();
    expect(bar(host).hidden).toBe(true);
  });

  test("it carries the actions a writer reaches for mid-sentence", async () => {
    const { host } = mount();
    const names = [...bar(host).querySelectorAll("button")].map((b: any) => b.getAttribute("aria-label"));
    expect(names).toContain("Bold");
    expect(names).toContain("Italic");
    expect(names).toContain("Strikethrough");
    expect(names).toContain("Inline code");
    // And the block turns, because "add a new section" is a heading, which is the thing the writer
    // could least easily reach by typing into the middle of an existing paragraph.
    expect(names).toContain("Heading 2");
    expect(names).toContain("Bullet list");
    expect(names).toContain("Blockquote");
  });

  test("it names itself to a screen reader as what it is", async () => {
    const { host } = mount();
    expect(bar(host).getAttribute("role")).toBe("toolbar");
    expect(bar(host).getAttribute("aria-label")).toBe("Formatting");
  });

  test("the rule for showing it: a real selection, in a focused editor, and nothing else", () => {
    // The whole decision, and the only part judgeable without a browser — everything else is
    // placement, which needs layout. Both conditions matter: a collapsed caret is a writer typing,
    // and an unfocused editor is a writer who has gone elsewhere and should not be followed by a
    // floating bar.
    expect(selectionToolbarShows({ empty: false }, true)).toBe(true);
    expect(selectionToolbarShows({ empty: true }, true)).toBe(false);
    expect(selectionToolbarShows({ empty: false }, false)).toBe(false);
    expect(selectionToolbarShows({ empty: true }, false)).toBe(false);
  });

  // Reaching the actions without a pointer. Every button bound `mousedown` and nothing else, and the
  // keymap bound Bold and Italic against eleven actions — so a writer who could not use a pointer
  // could type prose and make no heading, no list, no quote and no code.
  test("every action carries a shortcut, and says what it is", async () => {
    const { host } = mount();
    const buttons = [...bar(host).querySelectorAll("button")];
    // Stated over every button rather than for a chosen few: a twelfth action added without a key
    // has to fail here, which a list of specific names would not catch.
    for (const button of buttons as any[]) {
      const name = button.getAttribute("aria-label");
      expect(button.getAttribute("aria-keyshortcuts"), `${name} announces no shortcut`).toBeTruthy();
      expect(button.title, `${name} does not teach its shortcut`).toContain("(");
    }
    const byName = (name: string) => (buttons as any[]).find((b) => b.getAttribute("aria-label") === name);
    // The two spellings, checked on one action each: the glyphs a writer reads, and the key names
    // the ARIA attribute is specified to carry.
    expect(byName("Bold").getAttribute("aria-keyshortcuts")).toBe("Meta+B");
    expect(byName("Bold").title).toBe("Bold (⌘B)");
    expect(byName("Strikethrough").getAttribute("aria-keyshortcuts")).toBe("Meta+Shift+X");
    expect(byName("Heading 2").title).toBe("Heading 2 (⌘⌥2)");
  });

  // Blockquote rather than Bold for both of these: a mark needs a real selection to change any
  // bytes, and happy-dom cannot make one. `wrapIn` acts on a bare caret and NESTS when it runs
  // twice, so "did this run, and did it run once" are both readable straight off the markdown.
  const quoteButton = (host: any) =>
    [...bar(host).querySelectorAll("button")].find((b: any) => b.getAttribute("aria-label") === "Blockquote") as any;

  test("a click with no pointer behind it applies the action, so the buttons are not mouse-only", async () => {
    const { host, editor } = mount("plain words");
    // `detail: 0` is a click with no click count: Enter or Space on a focused button, and the
    // synthetic clicks voice control and switch access send. Every button bound `mousedown` alone,
    // so this arrived and did nothing.
    quoteButton(host).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, detail: 0 }));
    await paint();
    expect(editor.getMarkdown().trim()).toBe("> plain words");
  });

  test("a real press still applies it exactly once", async () => {
    const { host, editor } = mount("plain words");
    // The full pointer sequence. `mousedown` runs it; the `click` that follows must not run it
    // again, or a writer asking for one quote gets two.
    quoteButton(host).dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true }));
    quoteButton(host).dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, detail: 1 }));
    await paint();
    expect(editor.getMarkdown().trim()).toBe("> plain words");
  });

  test("the full-page editor is unaffected — it keeps its own fixed toolbar and grows no second one", async () => {
    const host = dom.document.createElement("div");
    dom.document.body.append(host);
    mountRichEditor(host as any, { markdown: "Body.", toolbar: true });
    expect(host.querySelector(".glosa-rich-toolbar")).toBeTruthy();
    expect(host.querySelector(".glosa-selection-toolbar")).toBeFalsy();
  });
});

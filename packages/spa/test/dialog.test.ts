// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { choiceDialog, confirmDialog, noticeDialog } from "../src/dialog.js";
import { type DomEnv, installDom, installModalDialogs } from "./dom-env.ts";

describe("confirmDialog accessibility and focus lifecycle", () => {
  let dom: DomEnv;
  let restoreDialogs: () => void;

  beforeEach(() => {
    dom = installDom();
    restoreDialogs = installModalDialogs(dom);
  });

  afterEach(() => {
    restoreDialogs();
    dom.teardown();
  });

  test("names the modal, focuses Cancel for a destructive choice, and restores its opener", async () => {
    const opener = dom.document.createElement("button");
    opener.textContent = "Preview";
    dom.document.body.append(opener);
    opener.focus();

    const result = confirmDialog({
      title: "Discard unsaved edits?",
      body: "Unsaved work will be lost.",
      confirmLabel: "Discard edits",
      danger: true,
    });

    const dialog = dom.document.querySelector("dialog")!;
    const heading = dialog.querySelector("h2")!;
    const description = dialog.querySelector("p")!;
    const cancel = dialog.querySelector(".glosa-btn-ghost") as any;
    expect(dialog.getAttribute("aria-labelledby")).toBe(heading.id);
    expect(dialog.getAttribute("aria-describedby")).toBe(description.id);
    expect(dom.document.activeElement).toBe(cancel);

    cancel.click();
    expect(await result).toBe(false);
    await Promise.resolve();
    expect(dom.document.activeElement).toBe(opener);
  });

  test("noticeDialog (issue #81): single button, named modal, resolves on dismiss, restores focus", async () => {
    const opener = dom.document.createElement("button");
    opener.textContent = "Badge";
    dom.document.body.append(opener);
    opener.focus();

    const result = noticeDialog({
      title: "Wired — one step left",
      body: "Restart or /resume your Claude Code session.",
    });

    const dialog = dom.document.querySelector("dialog")!;
    const heading = dialog.querySelector("h2")!;
    expect(heading.textContent).toBe("Wired — one step left");
    expect(dialog.getAttribute("aria-labelledby")).toBe(heading.id);
    expect(dialog.querySelector(".glosa-btn-ghost")).toBeNull(); // telling, not asking — no Cancel
    const dismiss = dialog.querySelector(".glosa-save") as any;
    expect(dismiss.textContent).toBe("Got it");
    expect(dom.document.activeElement).toBe(dismiss);

    dismiss.click();
    await result; // resolves void
    await Promise.resolve();
    expect(dom.document.activeElement).toBe(opener);
    expect(dom.document.querySelector("dialog")).toBeNull();
  });
});

describe("choiceDialog — two named actions, and every way of not answering means no", () => {
  let dom: DomEnv;
  let restoreDialogs: () => void;

  beforeEach(() => {
    dom = installDom();
    restoreDialogs = installModalDialogs(dom);
  });

  afterEach(() => {
    restoreDialogs();
    dom.teardown();
  });

  const ask = () =>
    choiceDialog({
      title: "This save would change words you didn't type",
      body: "Re-writing that block changes the markup below.",
      detail: "> [!info] one\n\n    becomes\n\n> \\[!info\\] one",
      choices: [
        { id: "source", label: "Edit as source" },
        { id: "save", label: "Save anyway" },
      ],
    });

  const button = (label: string) =>
    [...dom.document.querySelectorAll("dialog button")].find((b: any) => b.textContent === label) as any;

  test("names the modal, shows the bytes verbatim, and resolves the chosen action", async () => {
    const opener = dom.document.createElement("button");
    dom.document.body.append(opener);
    opener.focus();

    const result = ask();
    const dialog = dom.document.querySelector("dialog")!;
    expect(dialog.getAttribute("aria-labelledby")).toBe(dialog.querySelector("h2")!.id);
    expect(dialog.getAttribute("aria-describedby")).toBe(dialog.querySelector("p")!.id);
    // Cancel holds focus: the reader is being warned, so the safe answer is under their hand.
    expect(dom.document.activeElement).toBe(button("Cancel"));
    const detail = dialog.querySelector(".glosa-dialog-detail") as any;
    expect(detail.textContent).toContain("\\[!info\\]");
    expect(detail.tabIndex).toBe(0); // scrollable, so reachable without a pointer

    button("Save anyway").click();
    expect(await result).toBe("save");
    await Promise.resolve();
    expect(dom.document.activeElement).toBe(opener);
    expect(dom.document.querySelector("dialog")).toBeNull();
  });

  test("the second action is its own answer, not a variant of the first", async () => {
    const result = ask();
    button("Edit as source").click();
    expect(await result).toBe("source");
  });

  test("Cancel, Esc and the backdrop all mean do nothing", async () => {
    const cancelled = ask();
    button("Cancel").click();
    expect(await cancelled).toBeNull();

    // Esc closes a native dialog with an empty returnValue, the same shape as a backdrop dismiss.
    const escaped = ask();
    (dom.document.querySelector("dialog") as any).close("");
    expect(await escaped).toBeNull();

    const dismissed = ask();
    const dialog = dom.document.querySelector("dialog")!;
    dialog.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    expect(await dismissed).toBeNull();
  });

  test("a DOM that cannot show a modal answers no rather than assuming yes", async () => {
    // A three-way question has no honest window.confirm fallback, and the caller gates a WRITE on
    // the answer — so an environment that cannot ask must not answer on the reader's behalf.
    delete (dom.window as any).HTMLDialogElement.prototype.showModal;
    expect(await ask()).toBeNull();
  });
});

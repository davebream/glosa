// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { confirmDialog, noticeDialog } from "../src/dialog.js";
import { installDom, type DomEnv } from "./dom-env.ts";

describe("confirmDialog accessibility and focus lifecycle", () => {
  let dom: DomEnv;

  beforeEach(() => {
    dom = installDom();
    const proto = (dom.window as any).HTMLDialogElement.prototype;
    proto.showModal = function () {
      this.open = true;
    };
    proto.close = function (returnValue = "") {
      this.returnValue = returnValue;
      this.open = false;
      this.dispatchEvent(new dom.window.Event("close"));
    };
  });

  afterEach(() => {
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

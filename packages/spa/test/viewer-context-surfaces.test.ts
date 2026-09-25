// SPDX-License-Identifier: Apache-2.0
// The workspace's contextual surfaces. History used to live here; it is artifact-scoped, so the
// 2026-09-04 workbench brief §6 moved it into the pane (see artifact-pane.test.ts).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createContextSurfaceController, SHORTCUTS } from "../src/viewer-context-surfaces.js";
import { createElement } from "../src/viewer-shell.js";
import { type DomEnv, installDom } from "./dom-env.ts";

describe("viewer contextual surfaces", () => {
  let dom: DomEnv;

  beforeEach(() => {
    dom = installDom();
  });

  afterEach(() => {
    dom.teardown();
  });

  function elements() {
    const conversationEl = dom.document.createElement("section");
    const shortcutsEl = dom.document.createElement("section");
    const conversationToggle = dom.document.createElement("button");
    const shortcutsToggle = dom.document.createElement("button");
    conversationEl.hidden = true;
    shortcutsEl.hidden = true;
    dom.document.body.append(conversationToggle, shortcutsToggle, conversationEl, shortcutsEl);
    return { conversationEl, shortcutsEl, conversationToggle, shortcutsToggle };
  }

  test("closing the keyboard sheet returns focus without controlling chat panels", () => {
    const controls = elements();
    let focused = 0;
    const controller = createContextSurfaceController({
      elements: controls,
      createElement,
      returnFocus: () => {
        focused++;
      },
    });
    controls.shortcutsToggle.click();
    expect(controls.shortcutsEl.hidden).toBe(false);
    expect(controls.conversationEl.hidden).toBe(true);
    (controls.shortcutsEl.querySelector("button") as unknown as HTMLButtonElement).click();
    expect(controls.shortcutsEl.hidden).toBe(true);
    expect(focused).toBe(1);
    controller.destroy();
  });

  test("destroying the context controller closes its sheet and removes its listeners", () => {
    const controls = elements();
    const controller = createContextSurfaceController({ elements: controls, createElement, returnFocus() {} });
    controls.shortcutsToggle.click();
    controller.destroy();
    controls.shortcutsToggle.click();
    expect(controls.shortcutsEl.hidden).toBe(true);
    expect(controls.shortcutsToggle.getAttribute("aria-expanded")).toBe("false");
  });

  test("the keyboard sheet documents every workbench binding, including the equivalents to dragging", () => {
    const controls = elements();
    const controller = createContextSurfaceController({
      elements: controls,
      createElement,
      returnFocus: () => {},
    });

    controls.shortcutsToggle.click();
    const rows = Array.from(controls.shortcutsEl.querySelectorAll(".glosa-shortcut-list dd")).map(
      (element) => element.textContent,
    );
    expect(rows).toHaveLength(SHORTCUTS.length);
    // WCAG 2.2 SC 2.5.7 makes a single-pointer alternative to every drag a release requirement,
    // and a binding nobody can find is not an alternative. Splitting and pane focus are listed.
    expect(rows).toContain("Move this tab into a new split");
    expect(rows).toContain("Focus the pane to the right");
    expect(rows).toContain("Next tab in this pane");
    controller.destroy();
  });
});

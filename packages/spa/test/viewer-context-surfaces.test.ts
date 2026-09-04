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

  test("a delayed conversation mount receives the current workspace and mode through injected state", async () => {
    const controls = elements();
    const dataAccess = { marker: "one shared instance" };
    let state = { slug: "workspace", mode: "preview" };
    let releaseLoader: ((mount: unknown) => void) | undefined;
    const mounted: unknown[] = [];
    const controller = createContextSurfaceController({
      dataAccess,
      elements: controls,
      getState: () => state,
      loadConversationPane: () => new Promise((resolve) => (releaseLoader = resolve)),
      createElement,
      returnFocus: () => {},
    });

    controls.conversationToggle.click();
    state = { slug: "workspace", mode: "annotate" };
    releaseLoader?.((_container: unknown, options: unknown) => {
      mounted.push(options);
      return () => {};
    });
    await Promise.resolve();

    // Preview exposes the transcript read-only; composition requires an explicit mode transition.
    expect(mounted).toHaveLength(1);
    expect(mounted[0]).toMatchObject({ dataAccess, slug: "workspace", readOnly: false });
    controller.destroy();
  });

  test("opening the keyboard sheet closes and disposes the injected conversation surface", async () => {
    const controls = elements();
    let stopped = 0;
    const controller = createContextSurfaceController({
      dataAccess: {},
      elements: controls,
      getState: () => ({ slug: "workspace", mode: "annotate" }),
      loadConversationPane: async () => () => {
        stopped += 1;
      },
      createElement,
      returnFocus: () => {},
    });

    controls.conversationToggle.click();
    await Promise.resolve();
    expect(controls.conversationEl.hidden).toBe(false);

    controls.shortcutsToggle.click();
    await Promise.resolve();
    expect(controls.conversationEl.hidden).toBe(true);
    expect(stopped).toBe(1);
    controller.destroy();
  });

  test("the keyboard sheet documents every workbench binding, including the equivalents to dragging", () => {
    const controls = elements();
    const controller = createContextSurfaceController({
      dataAccess: {},
      elements: controls,
      getState: () => ({ slug: "workspace", mode: "preview" }),
      loadConversationPane: async () => () => {},
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

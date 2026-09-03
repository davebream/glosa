// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createContextSurfaceController } from "../src/viewer-context-surfaces.js";
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
    const historyEl = dom.document.createElement("section");
    const conversationEl = dom.document.createElement("section");
    const shortcutsEl = dom.document.createElement("section");
    const historyToggle = dom.document.createElement("button");
    const conversationToggle = dom.document.createElement("button");
    const shortcutsToggle = dom.document.createElement("button");
    historyEl.hidden = true;
    conversationEl.hidden = true;
    shortcutsEl.hidden = true;
    dom.document.body.append(
      historyToggle,
      conversationToggle,
      shortcutsToggle,
      historyEl,
      conversationEl,
      shortcutsEl,
    );
    return { historyEl, conversationEl, shortcutsEl, historyToggle, conversationToggle, shortcutsToggle };
  }

  test("a delayed history mount receives the current artifact and mode through injected state", async () => {
    const controls = elements();
    const dataAccess = { marker: "one shared instance" };
    let state = { slug: "workspace", artifactPath: "old.md", mode: "preview" };
    let releaseLoader: ((mount: unknown) => void) | undefined;
    const mounted: unknown[] = [];
    const controller = createContextSurfaceController({
      dataAccess,
      elements: controls,
      getState: () => state,
      loadHistoryPane: () => new Promise((resolve) => (releaseLoader = resolve)),
      loadConversationPane: async () => () => {},
      createElement,
      returnFocus: () => {},
    });

    controls.historyToggle.click();
    state = { slug: "workspace", artifactPath: "current.md", mode: "edit" };
    releaseLoader?.((_container: unknown, options: unknown) => mounted.push(options));
    await Promise.resolve();

    expect(mounted).toHaveLength(1);
    expect(mounted[0]).toMatchObject({ dataAccess, slug: "workspace", path: "current.md", canRestore: true });
    controller.destroy();
  });

  test("opening history closes and disposes the injected conversation surface", async () => {
    const controls = elements();
    let stopped = 0;
    const controller = createContextSurfaceController({
      dataAccess: {},
      elements: controls,
      getState: () => ({ slug: "workspace", artifactPath: "notes.md", mode: "annotate" }),
      loadHistoryPane: async () => () => {},
      loadConversationPane: async () => () => {
        stopped += 1;
      },
      createElement,
      returnFocus: () => {},
    });

    controls.conversationToggle.click();
    await Promise.resolve();
    expect(controls.conversationEl.hidden).toBe(false);

    controls.historyToggle.click();
    await Promise.resolve();
    expect(controls.conversationEl.hidden).toBe(true);
    expect(stopped).toBe(1);
    controller.destroy();
  });
});

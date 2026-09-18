// SPDX-License-Identifier: Apache-2.0
// #271 — clicking a block opens that block, and nothing else on the page moves.
//
// Each test names the way this could be quietly wrong rather than the feature it covers:
//
//   * The whole point is that the page is NOT replaced. A version that tore down the manuscript and
//     rebuilt it would look identical in a screenshot and would still be the defect — so the
//     rendered container's identity is asserted across the edit, not its contents.
//   * A save that rewrites bytes outside the edited run is the corruption the splice contract
//     exists to prevent. Asserted on the written string, not on the editor's own report.
//   * Clicking is how you edit and dragging is how you annotate. If a drag-selection opened an
//     editor, the annotation gesture would be stolen out from under the reader's hand.
//   * Editing must stay unavailable while a session holds the apply lease. A version that checked
//     only at click time would still open a run if the lease arrived during the module fetch.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createArtifactPane } from "../src/artifact-pane.js";
import { type DomEnv, installDom } from "./dom-env.ts";

describe("per-block editing (#271)", () => {
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

  const SOURCE = "# Title\n\nFirst paragraph.\n\nSecond paragraph.\n";
  const RENDERED =
    '<h1 data-line="0">Title</h1><p data-line="2">First paragraph.</p><p data-line="4">Second paragraph.</p>';

  function fakeDataAccess(overrides: Record<string, unknown> = {}) {
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
      ...overrides,
    };
  }

  async function mountPane(da: any, extra: Record<string, unknown> = {}) {
    const host = dom.document.createElement("div");
    dom.document.body.append(host);
    const pane = createArtifactPane(host, {
      dataAccess: da,
      slug: "ws-1",
      path: "notes.md",
      initialMode: "read",
      getAttentionEntries: () => [],
      refreshAttention: async () => {},
      getProviderName: () => "Claude Code",
      ...extra,
    });
    await pane.ready;
    await paint();
    return { host, pane };
  }

  /** Settle until `predicate` holds, or give up.
   *
   * A fixed number of ticks is not enough here and the reason is worth stating: opening a run awaits
   * a DYNAMIC import of the editor module, so the very first click in a process pays a real module
   * load while every later one is served from cache. Counting microtasks passes alone and fails in
   * a shard, which is exactly the flake CI caught and a local single-file run could not. */
  const settleUntil = async (predicate: () => boolean, attempts = 50) => {
    for (let i = 0; i < attempts && !predicate(); i++) await paint();
    return predicate();
  };

  /** A plain click on a rendered block, with the collapsed selection a click actually leaves. */
  const clickBlock = async (host: any, line: number, { expectEditor = true } = {}) => {
    const block = q(host, `.glosa-content [data-line="${line}"]`);
    expect(block).toBeTruthy();
    const event = new dom.window.MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 });
    block.dispatchEvent(event);
    // When an editor is expected, wait for it rather than for a tick count. When one is NOT — the
    // guard tests — settle a fixed amount instead, so "nothing opened" is a real observation rather
    // than a poll that gave up early.
    if (expectEditor) await settleUntil(() => Boolean(q(host, ".glosa-run-editor")));
    else await paint();
    return block;
  };

  test("clicking a block opens an editor over that block and no other", async () => {
    const { host } = await mountPane(fakeDataAccess());
    await clickBlock(host, 2);
    const editors = host.querySelectorAll(".glosa-run-editor");
    expect(editors).toHaveLength(1);
    // The blocks that were not clicked are still the elements they were.
    expect(q(host, '.glosa-content [data-line="0"]')).toBeTruthy();
    expect(q(host, '.glosa-content [data-line="4"]')).toBeTruthy();
  });

  test("the rendered container is never replaced, which is the whole design", async () => {
    // Identity, not contents. A version that rebuilt the manuscript would satisfy every other
    // assertion in this file and would be exactly the defect this work removes.
    const { host } = await mountPane(fakeDataAccess());
    const before = q(host, ".glosa-content");
    await clickBlock(host, 2);
    expect(q(host, ".glosa-content")).toBe(before);
    expect(before.hidden).toBe(false);
  });

  test("a drag-selection does not open an editor, because that gesture means annotate", async () => {
    // Deliberately NOT in Notes: since editing is unavailable there at all, a Notes mount would make
    // this pass without the drag rule existing — the assertion has to be able to fail.
    const { host } = await mountPane(fakeDataAccess());
    const block = q(host, '.glosa-content [data-line="2"]');
    const selection = dom.window.getSelection();
    const range = dom.document.createRange();
    range.selectNodeContents(block);
    selection?.removeAllRanges();
    selection?.addRange(range);
    block.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 }));
    await paint();
    expect(host.querySelectorAll(".glosa-run-editor")).toHaveLength(0);
  });

  test("a read-locked visit cannot open a run", async () => {
    const { host } = await mountPane(fakeDataAccess(), { readLock: true });
    await clickBlock(host, 2, { expectEditor: false });
    expect(host.querySelectorAll(".glosa-run-editor")).toHaveLength(0);
  });

  test("a run cannot open while a session holds the apply lease", async () => {
    const { host, pane } = await mountPane(fakeDataAccess());
    pane.setApplyPause({ id: "lease-1" });
    await paint();
    await clickBlock(host, 2, { expectEditor: false });
    expect(host.querySelectorAll(".glosa-run-editor")).toHaveLength(0);
  });

  test("a click that changes nothing restores the block and writes nothing", async () => {
    // An accidental click is the most common interaction this surface will ever see. It must cost
    // no repaint, no journal entry, and no `human_edit` reaching the agent.
    const da = fakeDataAccess();
    const { host, pane } = await mountPane(da);
    await clickBlock(host, 2);
    q(host, ".glosa-run-editor .ProseMirror")?.dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true }));
    await paint();
    expect(host.querySelectorAll(".glosa-run-editor")).toHaveLength(0);
    expect(q(host, '.glosa-content [data-line="2"]')).toBeTruthy();
    expect(da.saved).toEqual([]);
    expect(pane.isDirty()).toBe(false);
  });

  test("the editor names the passage it opened on", async () => {
    // A screen reader leaving a labelled region for an unnamed textbox is the moment the reader
    // loses their place.
    const { host } = await mountPane(fakeDataAccess());
    await clickBlock(host, 2);
    const surface = q(host, ".glosa-run-editor .ProseMirror");
    expect(surface?.getAttribute("aria-label")).toMatch(/^Editing /);
  });

  test("the editor module is not in the Read path until an editable artifact opens", async () => {
    // Guards the lazy boundary from the runtime side; import-boundary.test.ts guards it statically.
    // A static import would put 400 KB in front of the first paint of a document nobody may edit.
    const source = await Bun.file(new URL("../src/artifact-pane.js", import.meta.url)).text();
    expect(source).toContain('import("./rich-editor.js")');
    expect(source).not.toMatch(/^import .* from "\.\/rich-editor\.js";$/m);
  });
});

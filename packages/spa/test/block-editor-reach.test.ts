// SPDX-License-Identifier: Apache-2.0
// Which blocks a click can reach, and which state of the page lets it.
//
// Two defects found in alpha.27 by using it, both invisible to every test that existed:
//
//   * A fenced code block could not be opened. Not because editing refused it — because the block
//     never carried a `data-line`, so nothing could name it. The stamp fired on `_open` tokens, and
//     markdown-it emits a fence, an indented code block, a thematic break and a raw HTML block as
//     SINGLE tokens with no closing partner. The same omission made those blocks unannotatable.
//   * Showing the notes left click-to-edit live underneath, so one gesture meant two things on the
//     same words.
//
// The first is asserted on the RENDERED HTML rather than on the token stream, because the token
// carried the attribute all along for a fence — the default renderer wrote it onto the inner
// `<code>`, and everything that resolves a passage reads the manuscript's own child, the `<pre>`.
// A token-level assertion would have passed while the page stayed unreachable.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderMarkdown } from "../../daemon/src/artifact-render.ts";
import { createArtifactPane } from "../src/artifact-pane.js";
import { type DomEnv, installDom } from "./dom-env.ts";

const SINGLE_TOKEN_BLOCKS =
  "# Title\n\nA paragraph.\n\n```js\nconst x = 1;\n```\n\n---\n\n    indented code\n\nAfter.\n";

describe("every block a reader can see, a reader can reach", () => {
  test("a fenced code block carries its line on the <pre>, not on the <code> inside it", () => {
    const html = renderMarkdown(SINGLE_TOKEN_BLOCKS);
    expect(html).toContain('<pre data-line="4">');
    // Stated as an absence too: the attribute on the inner element would satisfy a naive contains()
    // check while leaving the block unreachable from the page.
    expect(html).not.toContain("<code data-line=");
  });

  test("a thematic break and an indented code block carry theirs too", () => {
    const html = renderMarkdown(SINGLE_TOKEN_BLOCKS);
    expect(html).toContain('<hr data-line="8">');
    expect(html).toContain('<pre data-line="10">');
  });

  test("a paragraph's inline children are not stamped as blocks of their own", () => {
    // `inline` is the one token that passes every other part of the test — block-level, no closing
    // partner, and carrying its parent's map. Stamping it would put a second `data-line` inside the
    // paragraph that already has one, and a click would resolve to whichever the walk met first.
    const html = renderMarkdown("A paragraph with **bold** in it.\n");
    expect(html).toBe('<p data-line="0">A paragraph with <strong>bold</strong> in it.</p>\n');
  });
});

describe("Notes and writing are different states of the page", () => {
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
  const settleUntil = async (predicate: () => boolean, attempts = 50) => {
    for (let i = 0; i < attempts && !predicate(); i++) await paint();
    return predicate();
  };

  const SOURCE = "# Title\n\nFirst paragraph.\n\n```js\nconst x = 1;\n```\n";
  const RENDERED =
    '<h1 data-line="0">Title</h1><p data-line="2">First paragraph.</p><pre data-line="4"><code>const x = 1;\n</code></pre>';

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

  async function mountPane(initialMode = "read") {
    const host = dom.document.createElement("div");
    dom.document.body.append(host);
    const pane = createArtifactPane(host, {
      dataAccess: fakeDataAccess(),
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

  const clickBlock = async (host: any, line: number, { expectEditor = true } = {}) => {
    const block = q(host, `.glosa-content [data-line="${line}"]`);
    expect(block).toBeTruthy();
    block.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 }));
    if (expectEditor) await settleUntil(() => Boolean(q(host, ".glosa-run-editor")));
    else await paint();
    return block;
  };

  test("a code block opens like any other block", async () => {
    // This one is held against HAND-WRITTEN rendered HTML, so it does NOT guard the stamp — ablate
    // the stamp and it still passes. What it covers is the other half: that once a `<pre>` carries
    // a line, nothing further along refuses it the way it refuses a block that models nothing. The
    // stamp itself is guarded above, against the real renderer.
    const { host } = await mountPane();
    await clickBlock(host, 4);
    expect(host.querySelectorAll(".glosa-run-editor")).toHaveLength(1);
  });

  test("showing the notes takes click-to-edit away, because the same click means annotate there", async () => {
    const { host } = await mountPane("review");
    await clickBlock(host, 2, { expectEditor: false });
    expect(host.querySelectorAll(".glosa-run-editor")).toHaveLength(0);
    // And the passage is still there to be marked — the click cost the reader nothing.
    expect(q(host, '.glosa-content [data-line="2"]')?.textContent).toBe("First paragraph.");
  });

  test("showing the notes while a block is open closes it rather than leaving two live states", async () => {
    const { host, pane } = await mountPane();
    await clickBlock(host, 2);
    expect(host.querySelectorAll(".glosa-run-editor")).toHaveLength(1);

    pane.setMode("review");
    await settleUntil(() => host.querySelectorAll(".glosa-run-editor").length === 0);

    expect(host.querySelectorAll(".glosa-run-editor")).toHaveLength(0);
    expect(pane.getMode()).toBe("review");
  });

  test("opening the source editor closes the block, so one set of bytes has one writable face", async () => {
    // The two-faces bug: the source view came up in front while a block editor stayed mounted behind
    // it, still holding a span of a document the source view was about to rewrite.
    const { host, pane } = await mountPane();
    await clickBlock(host, 2);
    expect(host.querySelectorAll(".glosa-run-editor")).toHaveLength(1);

    pane.setMode("edit");
    await settleUntil(() => host.querySelectorAll(".glosa-run-editor").length === 0);

    expect(host.querySelectorAll(".glosa-run-editor")).toHaveLength(0);
    expect(pane.getMode()).toBe("edit");
  });
});

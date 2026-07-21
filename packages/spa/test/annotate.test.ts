// SPDX-License-Identifier: Apache-2.0
// P3.3 — the W3C-style annotation record builder. `buildAnnotationTarget` is pure (no DOM);
// `buildAnnotationRecordFromSelection` is the DOM-facing half, tested against a real happy-dom
// Selection/Range (see dom-env.ts for why happy-dom rather than jsdom/native).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildAnnotationRecordFromSelection, buildAnnotationTarget } from "../src/annotate.js";
import { installDom, type DomEnv } from "./dom-env.ts";

describe("buildAnnotationTarget — pure, no DOM", () => {
  const TEXT = "The quick brown fox jumps over the lazy dog. ".repeat(3); // 46 * 3 = 138 chars

  test("exact quote + position offsets are correct", () => {
    const start = TEXT.indexOf("brown fox");
    const end = start + "brown fox".length;
    const target = buildAnnotationTarget(TEXT, start, end);
    expect(target).not.toBeNull();
    expect(target!.quote.exact).toBe("brown fox");
    expect(target!.position).toEqual({ start, end });
  });

  test("prefix/suffix are exactly ±40 chars when the selection isn't near an edge", () => {
    const start = 50;
    const end = 59;
    const target = buildAnnotationTarget(TEXT, start, end)!;
    expect(target.quote.prefix).toBe(TEXT.slice(10, 50));
    expect(target.quote.prefix.length).toBe(40);
    expect(target.quote.suffix).toBe(TEXT.slice(59, 99));
    expect(target.quote.suffix.length).toBe(40);
  });

  test("near the start of the text, prefix is clamped instead of going negative", () => {
    const target = buildAnnotationTarget(TEXT, 0, 3)!;
    expect(target.quote.prefix).toBe("");
  });

  test("near the end of the text, suffix is clamped to what's left", () => {
    const end = TEXT.length;
    const start = end - 3;
    const target = buildAnnotationTarget(TEXT, start, end)!;
    expect(target.quote.suffix).toBe("");
  });

  test("chunk_id is included only when given", () => {
    expect(buildAnnotationTarget(TEXT, 0, 3, { chunkId: "chunk-004" })!.chunk_id).toBe("chunk-004");
    expect(buildAnnotationTarget(TEXT, 0, 3)!.chunk_id).toBeUndefined();
  });

  test("returns null for a collapsed (start === end) selection", () => {
    expect(buildAnnotationTarget(TEXT, 5, 5)).toBeNull();
  });

  test("returns null for an inverted (start > end) range", () => {
    expect(buildAnnotationTarget(TEXT, 10, 5)).toBeNull();
  });

  test("returns null for an out-of-range offset", () => {
    expect(buildAnnotationTarget(TEXT, 0, TEXT.length + 1)).toBeNull();
    expect(buildAnnotationTarget(TEXT, -1, 5)).toBeNull();
  });

  test("unicode-safe: a ±40 boundary landing mid-surrogate-pair is nudged, never splitting the astral character", () => {
    // U+1F600 GRINNING FACE is one astral codepoint = two UTF-16 code units.
    const emoji = "\u{1F600}";
    const padding = "x".repeat(39); // so the 40-char boundary lands exactly on the emoji's low surrogate
    const text = padding + emoji + "SELECTED" + emoji + padding;
    const start = text.indexOf("SELECTED");
    const end = start + "SELECTED".length;

    const target = buildAnnotationTarget(text, start, end)!;
    expect(target).not.toBeNull();
    // Neither prefix nor suffix contains a lone (unpaired) surrogate — round-tripping either
    // through String.fromCharCode/JSON would otherwise mangle it.
    for (const s of [target.quote.prefix, target.quote.suffix]) {
      for (let i = 0; i < s.length; i++) {
        const code = s.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff) expect(s.charCodeAt(i + 1)).toBeGreaterThanOrEqual(0xdc00); // paired
        if (code >= 0xdc00 && code <= 0xdfff) expect(s.charCodeAt(i - 1)).toBeLessThanOrEqual(0xdbff); // paired
      }
    }
  });
});

describe("buildAnnotationRecordFromSelection — DOM (happy-dom)", () => {
  let dom: DomEnv;

  beforeEach(() => {
    dom = installDom();
  });
  afterEach(() => {
    dom.teardown();
  });

  function setUpSelection(html: string, textToSelect: string) {
    dom.document.body.innerHTML = `<div id="c">${html}</div>`;
    const container = dom.document.getElementById("c")!;
    const textNode = findTextNode(container, textToSelect);
    const offset = textNode.textContent!.indexOf(textToSelect);
    const range = dom.document.createRange();
    range.setStart(textNode, offset);
    range.setEnd(textNode, offset + textToSelect.length);
    const selection = dom.window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return { container, selection };
  }

  function findTextNode(root: any, containing: string): any {
    const walker = dom.document.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
    let node = walker.nextNode();
    while (node) {
      if (node.textContent?.includes(containing)) return node;
      node = walker.nextNode();
    }
    throw new Error(`no text node containing "${containing}"`);
  }

  test("a real selection inside the rendered container produces {body, intent, target}", () => {
    const { container, selection } = setUpSelection(
      '<p data-line="0">Hello there, world</p>',
      "there",
    );

    const record = buildAnnotationRecordFromSelection(selection, container, {
      body: "tighten this",
      intent: "content",
    });

    expect(record).not.toBeNull();
    expect(record!.body).toBe("tighten this");
    expect(record!.intent).toBe("content");
    expect(record!.target.quote.exact).toBe("there");
    expect(record!.target.position).toEqual({ start: 6, end: 11 });
  });

  test("offsets are correct relative to the FULL container text, across multiple block elements", () => {
    const { container, selection } = setUpSelection(
      '<p data-line="0">First paragraph.</p><p data-line="1">Second paragraph.</p>',
      "Second",
    );
    const record = buildAnnotationRecordFromSelection(selection, container, {
      body: "x",
      intent: "content",
    });
    const fullText = "First paragraph.Second paragraph.";
    expect(container.textContent).toBe(fullText);
    expect(record!.target.position.start).toBe(fullText.indexOf("Second"));
    expect(record!.target.quote.exact).toBe("Second");
  });

  test("no selection at all → null", () => {
    dom.document.body.innerHTML = '<div id="c"><p>text</p></div>';
    const container = dom.document.getElementById("c")!;
    dom.window.getSelection().removeAllRanges();
    const record = buildAnnotationRecordFromSelection(dom.window.getSelection(), container, {
      body: "x",
      intent: "content",
    });
    expect(record).toBeNull();
  });

  test("a collapsed selection (click, no drag) → null", () => {
    dom.document.body.innerHTML = '<div id="c"><p>text</p></div>';
    const container = dom.document.getElementById("c")!;
    const textNode = findTextNode(container, "text");
    const range = dom.document.createRange();
    range.setStart(textNode, 2);
    range.setEnd(textNode, 2);
    const selection = dom.window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);

    const record = buildAnnotationRecordFromSelection(selection, container, {
      body: "x",
      intent: "content",
    });
    expect(record).toBeNull();
  });

  test("a selection made OUTSIDE the given container → null (never anchors to the wrong artifact)", () => {
    dom.document.body.innerHTML = '<div id="c"><p>inside</p></div><p id="outside">outside text</p>';
    const container = dom.document.getElementById("c")!;
    const outsideText = dom.document.getElementById("outside")!.firstChild!;
    const range = dom.document.createRange();
    range.setStart(outsideText, 0);
    range.setEnd(outsideText, 7);
    const selection = dom.window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);

    const record = buildAnnotationRecordFromSelection(selection, container, {
      body: "x",
      intent: "content",
    });
    expect(record).toBeNull();
  });
});

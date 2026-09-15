// SPDX-License-Identifier: Apache-2.0
// Passage addresses are derived labels over the rendered Markdown structure (direction contract,
// packages/spa/.impeccable/surfaces/src-app-css.md): no markup in the document, renumbered on
// every render, never an identity. These pin the numbering rules a reader would rely on.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { addressBlocks, addressForRange, topLevelBlockOf } from "../src/address.js";
import { type DomEnv, installDom } from "./dom-env.ts";

describe("passage addresses", () => {
  let dom: DomEnv;
  beforeEach(() => {
    dom = installDom();
  });
  afterEach(() => dom.teardown());

  function render(html: string) {
    const root = dom.document.createElement("div");
    root.innerHTML = html;
    return root;
  }

  test("headings number by level and blocks count from their heading", () => {
    const root = render(
      '<h1 data-line="0">T</h1><p data-line="2">a</p><h2 data-line="4">A</h2><p data-line="6">b</p><ul data-line="8"><li>c</li></ul><h2 data-line="10">B</h2><p data-line="12">d</p><h1 data-line="14">U</h1><p data-line="16">e</p>',
    );
    const labels = Array.from(addressBlocks(root).values());
    expect(labels).toEqual(["§1", "§1.1", "§1.1", "§1.1.1", "§1.1.2", "§1.2", "§1.2.1", "§2", "§2.1"]);
  });

  test("a lone leading h1 is the title: sections count from h2 and the title is §0", () => {
    const root = render(
      '<h1 data-line="0">Title</h1><p data-line="2">lead</p><h2 data-line="4">A</h2><p data-line="6">a</p><h2 data-line="8">B</h2><p data-line="10">b</p>',
    );
    expect(Array.from(addressBlocks(root).values())).toEqual(["§0", "§0.1", "§1", "§1.1", "§2", "§2.1"]);
  });

  test("a document that starts at ## reads §1, not §0.1", () => {
    const root = render(
      '<h2 data-line="0">A</h2><p data-line="2">a</p><h3 data-line="4">A.1</h3><p data-line="6">b</p>',
    );
    expect(Array.from(addressBlocks(root).values())).toEqual(["§1", "§1.1", "§1.1", "§1.1.1"]);
  });

  test("blocks before the first heading count from §0; a headless page counts paragraphs", () => {
    const root = render('<p data-line="0">intro</p><h2 data-line="2">A</h2><p data-line="4">a</p>');
    expect(Array.from(addressBlocks(root).values())).toEqual(["§0.1", "§1", "§1.1"]);
    const headless = render('<p data-line="0">a</p><blockquote data-line="2"><p>b</p></blockquote>');
    expect(Array.from(addressBlocks(headless).values())).toEqual(["¶1", "¶2"]);
  });

  test("a range inside a nested element resolves to its top-level block; outside the root it is null", () => {
    const root = render('<h2 data-line="0">A</h2><p data-line="2">one <em>two</em> three</p>');
    const em = root.querySelector("em")!;
    expect(topLevelBlockOf(root, em)).toBe(root.querySelector("p"));
    expect(addressForRange(root, { startContainer: em.firstChild })).toBe("§1.1");
    expect(addressForRange(root, { startContainer: dom.document.body })).toBeNull();
    expect(addressForRange(root, null)).toBeNull();
  });

  test("a range that starts on the root at a child offset names that child block", () => {
    const root = render('<h2 data-line="0">A</h2><p data-line="2">a</p><p data-line="4">b</p>');
    expect(addressForRange(root, { startContainer: root, startOffset: 2 })).toBe("§1.2");
    expect(addressForRange(root, { startContainer: root, startOffset: 0 })).toBe("§1");
  });

  test("a range that starts on the whitespace between blocks names the block its end sits in", () => {
    // markdown-it leaves bare "\n" text nodes between blocks, and an offset-built range whose quote
    // opens a block starts at the END of that whitespace node, not inside the block.
    const root = render('<h2 data-line="0">A</h2>\n<p data-line="2">Improve it.</p>\n<p data-line="4">b</p>');
    const gap = root.childNodes[1]!; // the "\n" after the heading
    const p = root.querySelectorAll("p")[0]!;
    expect(gap.nodeType).toBe(3);
    expect(
      addressForRange(root, { startContainer: gap, startOffset: 1, endContainer: p.firstChild, endOffset: 11 }),
    ).toBe("§1.1");
    // A range that never leaves the whitespace names nothing.
    expect(addressForRange(root, { startContainer: gap, startOffset: 0, endContainer: gap, endOffset: 1 })).toBeNull();
  });

  test("inserting a paragraph renumbers what follows: the address is a label, not an identity", () => {
    const root = render('<h2 data-line="0">A</h2><p data-line="2">a</p><p data-line="4">b</p>');
    const before = addressForRange(root, { startContainer: root.querySelectorAll("p")[1]!.firstChild });
    const inserted = dom.document.createElement("p");
    inserted.setAttribute("data-line", "3");
    inserted.textContent = "new";
    root.insertBefore(inserted, root.querySelectorAll("p")[1]!);
    const after = addressForRange(root, { startContainer: root.querySelectorAll("p")[2]!.firstChild });
    expect(before).toBe("§1.2");
    expect(after).toBe("§1.3");
  });
});

// SPDX-License-Identifier: Apache-2.0
// @glosa/spa — passage addresses. A mark needs a short name a human and a session can both say:
// "§2.3" is the third block of the second section. The address is DERIVED from the rendered
// Markdown structure every time it is asked for, so it needs no markup in the document and it is
// a display label, never an identity: insert a paragraph above and everything after it renumbers,
// while the annotation itself stays anchored to its words (the anchor is the quote and its source
// range, not this label). The daemon derives the same label when it delivers a note, from the
// document as it stands at that moment, and sends it beside the quote; nothing stores it.
//
// Sections are headings, numbered by document order within their level (1, 1.1, 1.2, 2). A block
// under a heading takes the heading's number plus its own position since that heading. Blocks
// before the first heading count from §0; a document with no headings at all counts paragraphs
// as ¶1, ¶2, … so a note on a headless page still has a name.

const HEADING = /^H[1-6]$/;

/** The top-level rendered blocks, in document order. markdown-it stamps each with `data-line`. */
function topLevelBlocks(root) {
  return Array.from(root.querySelectorAll(":scope > [data-line]"));
}

/**
 * The address of each top-level block, from the one thing the numbering reads of a block: its
 * heading level (1 to 6), or 0 for anything that is not a heading. This is the ONE numbering rule.
 * The page feeds it the rendered manuscript's top-level elements (`addressBlocks` below); the
 * daemon feeds it the same document's top-level markdown-it tokens when it delivers a note
 * (packages/daemon/src/artifact-render.ts `passageAddresses`), so the label a session is told is
 * the label the reader sees. Pure and dependency-free, so both sides load this one module.
 * @param {readonly number[]} levels heading level per block, in document order; 0 for a non-heading
 * @returns {string[]} one address per block, in the same order
 */
export function addressLabels(levels) {
  const hasHeadings = levels.some((level) => level > 0);
  // A lone leading h1 is the document's title, not its first section: sections then count from
  // h2, so the first section reads §1 and not §1.1, and the title itself is §0.
  const titleIndex = levels[0] === 1 && levels.filter((level) => level === 1).length === 1 ? 0 : -1;
  /** Section counters by heading level; a deeper heading resets everything below it. */
  const counters = [0, 0, 0, 0, 0, 0];
  let section = hasHeadings ? "0" : "";
  let sinceHeading = 0;
  return levels.map((level, index) => {
    if (index === titleIndex) return "§0";
    if (level > 0) {
      const depth = level - 1;
      counters[depth] += 1;
      for (let i = depth + 1; i < counters.length; i += 1) counters[i] = 0;
      // Levels above the first one used stay at 0 and are dropped, so a document that starts
      // at `##` reads §1, §2 rather than §0.1, §0.2.
      const parts = counters.slice(0, depth + 1);
      while (parts.length > 1 && parts[0] === 0) parts.shift();
      section = parts.join(".");
      sinceHeading = 0;
      return `§${section}`;
    }
    sinceHeading += 1;
    return hasHeadings ? `§${section}.${sinceHeading}` : `¶${sinceHeading}`;
  });
}

/**
 * The address of every top-level block, in document order. One pass, so a long document is
 * numbered once per render rather than once per mark.
 * @param {{ querySelectorAll: (selector: string) => Iterable<any> } | null} root
 * @returns {Map<any, string>} block element → address
 */
export function addressBlocks(root) {
  /** @type {Map<any, string>} */
  const out = new Map();
  if (!root) return out;
  const blocks = topLevelBlocks(root);
  const labels = addressLabels(blocks.map((b) => (HEADING.test(b.tagName) ? Number(b.tagName[1]) : 0)));
  blocks.forEach((block, index) => {
    out.set(block, labels[index]);
  });
  return out;
}

/**
 * The top-level block a node sits in, or null when it is not inside the rendered root.
 * @param {any} root
 * @param {any} node
 */
export function topLevelBlockOf(root, node) {
  let el = node && node.nodeType === 1 ? node : node?.parentElement;
  while (el && el.parentElement !== root) el = el.parentElement;
  return el && el.parentElement === root && el.hasAttribute?.("data-line") ? el : null;
}

/** The top-level block a range boundary sits in. A boundary can land in three places: inside a
 * block's text (the usual case); on the root itself with an offset into its children; or at the
 * end of one of the bare "\n" text nodes markdown-it leaves BETWEEN blocks, which is where an
 * offset-built range starts when the quoted words open a block. Only the first two name a block. */
function blockForBoundary(root, container, offset) {
  if (!container) return null;
  if (container === root) return topLevelBlockOf(root, root.childNodes[offset] ?? root.lastChild);
  if (container.parentNode === root && container.nodeType === 3) return null;
  return topLevelBlockOf(root, container);
}

/**
 * The address for a DOM Range (an anchored annotation's passage), or null when the range is not
 * in the rendered root. The END boundary is asked first: it always sits inside the block that
 * holds the quote's last word, while the start boundary of an offset-built range can sit on the
 * whitespace before the block. Cheap enough to call per mark; pass a precomputed `map` when
 * painting many.
 * @param {any} root
 * @param {{ startContainer: any, startOffset?: number, endContainer?: any, endOffset?: number } | null} range
 * @param {Map<any, string>} [map]
 */
export function addressForRange(root, range, map = addressBlocks(root)) {
  if (!root || !range) return null;
  const block =
    blockForBoundary(root, range.endContainer, range.endOffset ?? 0) ??
    blockForBoundary(root, range.startContainer, range.startOffset ?? 0);
  return block ? (map.get(block) ?? null) : null;
}

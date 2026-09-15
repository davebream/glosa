// SPDX-License-Identifier: Apache-2.0
// @glosa/spa — passage addresses. A mark needs a short name a human and a session can both say:
// "§2.3" is the third block of the second section. The address is DERIVED from the rendered
// Markdown structure every time it is asked for, so it needs no markup in the document and it is
// a display label, never an identity: insert a paragraph above and everything after it renumbers,
// while the annotation itself stays anchored to its words (the anchor is the quote and its source
// range, not this label).
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
  const hasHeadings = blocks.some((b) => HEADING.test(b.tagName));
  // A lone leading h1 is the document's title, not its first section: sections then count from
  // h2, so the first section reads §1 and not §1.1, and the title itself is §0.
  const h1s = blocks.filter((b) => b.tagName === "H1");
  const titleBlock = h1s.length === 1 && blocks[0] === h1s[0] ? h1s[0] : null;
  /** Section counters by heading level; a deeper heading resets everything below it. */
  const counters = [0, 0, 0, 0, 0, 0];
  let section = hasHeadings ? "0" : "";
  let sinceHeading = 0;
  for (const block of blocks) {
    if (block === titleBlock) {
      out.set(block, "§0");
      continue;
    }
    if (HEADING.test(block.tagName)) {
      const level = Number(block.tagName[1]) - 1;
      counters[level] += 1;
      for (let i = level + 1; i < counters.length; i += 1) counters[i] = 0;
      // Levels above the first one used stay at 0 and are dropped, so a document that starts
      // at `##` reads §1, §2 rather than §0.1, §0.2.
      const parts = counters.slice(0, level + 1);
      while (parts.length > 1 && parts[0] === 0) parts.shift();
      section = parts.join(".");
      sinceHeading = 0;
      out.set(block, `§${section}`);
      continue;
    }
    sinceHeading += 1;
    out.set(block, hasHeadings ? `§${section}.${sinceHeading}` : `¶${sinceHeading}`);
  }
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

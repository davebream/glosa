// SPDX-License-Identifier: Apache-2.0
// @ts-check
// @glosa/spa — the document's outline as data: headings out of a rendered page or markdown
// source, their depths, the reader's current section, and the jumps that take them there.
//
// This used to also paint the fore-edge rail — a column of hairlines at each pane's left inset
// that opened into a labelled outline on hover. It was withdrawn: the rail was hard to hit,
// opened on the way to the first word of a line, and knew about one document only. The pane still
// computes everything here; the Go to palette (palette.js) is where a reader now asks for it.
//
// Transport-free by construction: nothing here reads an artifact or touches data-access.

/** How far below the scroller's top edge a heading counts as "the section you are in". A heading
 * exactly at the top edge is the one you just arrived at, so the line has to sit below it. */
const CURRENT_HEADING_OFFSET = 96;
/** Air left above a jumped-to heading, so it lands as the top of a section rather than flush
 * against the pane's chrome. */
const JUMP_HEADROOM = 24;

const HEADING_SELECTOR = "h1, h2, h3, h4, h5, h6";

/**
 * @typedef {{ level: number, depth: number, text: string, address?: string | null, jump: () => void }} OutlineEntry
 */

/** Markdown source is not rendered text: a heading reads `## The **hard** part` on disk and
 * `The hard part` on the page. The panel shows one document, so both paths have to arrive at the
 * same string. Deliberately shallow — enough for emphasis, code spans, and links, which is what
 * headings actually carry. */
/** @param {unknown} raw */
export function plainHeadingText(raw) {
  return String(raw ?? "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // [label](href) and ![alt](src)
    .replace(/!?\[([^\]]*)\]\[[^\]]*\]/g, "$1") // [label][ref]
    .replace(/`+([^`]*)`+/g, "$1")
    .replace(/(\*\*\*|___)(.+?)\1/g, "$2")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(\*|_)(.+?)\1/g, "$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Headings out of a rendered artifact (Read, Review, and Edit's rich face all paint real DOM).
 *
 * @param {{ querySelectorAll: (selector: string) => Iterable<any> } | null} root
 * @returns {{ level: number, text: string, el: Element }[]}
 */
export function collectRenderedHeadings(root) {
  if (!root) return [];
  /** @type {{ level: number, text: string, el: Element }[]} */
  const found = [];
  for (const node of root.querySelectorAll(HEADING_SELECTOR)) {
    const copy = typeof node.cloneNode === "function" ? node.cloneNode(true) : node;
    if (copy !== node) for (const comment of copy.querySelectorAll(".glosa-comment-inline")) comment.remove();
    const text = String(copy.textContent ?? "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue; // an empty heading is a typo, not a destination
    found.push({ level: Number(node.tagName.slice(1)) || 1, text, el: node });
  }
  return found;
}

/**
 * Turns raw heading levels into outline depth. A document whose headings start at `##` — most
 * fragments, and every file this workspace holds that is a section of something larger — must
 * indent from its own first level, not from an absent `#`.
 *
 * @param {{ level: number }[]} headings
 * @returns {number[]} one 1-based depth per heading
 */
export function outlineDepths(headings) {
  if (!headings.length) return [];
  const top = Math.min(...headings.map((heading) => heading.level));
  /** @type {number[]} */
  const stack = [];
  return headings.map((heading) => {
    const level = Math.max(heading.level, top);
    while (stack.length && (stack[stack.length - 1] ?? 0) >= level) stack.pop();
    stack.push(level);
    return stack.length;
  });
}

/**
 * Every whitespace-separated word in the query must appear in the heading, case-insensitively and
 * in any order — `func req` finds "Functional requirements", `attention` finds "R9 — attention
 * model", `r4 delivery` finds "R4 — delivery: provider-based, cmux-free".
 *
 * Deliberately NOT a scattered-letter fuzzy match. Headings here are prose, and long: this file's
 * own outline contains "R3 — file bus: inbox, journal (=truth), provenance (detail: A4 §F04/§F05,
 * A5 §F23)". Across strings that long, a subsequence matcher finds `attn` inside "What changed
 * from v1 (orientation for anyone who read v1)" and returns it beside the heading the reader
 * actually wanted. A filter that answers with things you cannot see why it chose is worse than a
 * stricter one that never surprises you.
 *
 * Matches never reorder the list either. The outline's order IS the document, and sorting by score
 * would answer "which heading is most like what I typed" when the question was "where in this
 * document is it".
 *
 * @param {string} text
 * @param {string} query
 */
export function matchesQuery(text, query) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = text.toLowerCase();
  return needle.split(/\s+/).every((word) => haystack.includes(word));
}

/**
 * The index of the heading a reader is currently inside: the last one whose top has passed the
 * reading line. Before the first heading, nothing is current — the reader is in the preamble, and
 * claiming they are in section 1 would be a small lie told constantly.
 *
 * @param {number[]} tops heading offsets in the scroller's content, in document order
 * @param {number} scrollTop
 * @param {number} [line]
 * @returns {number} index, or -1
 */
export function currentHeadingIndex(tops, scrollTop, line = CURRENT_HEADING_OFFSET) {
  let current = -1;
  for (let index = 0; index < tops.length; index += 1) {
    if ((tops[index] ?? 0) - scrollTop <= line) current = index;
    else break;
  }
  return current;
}

const prefersReducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Pixel offsets of `offsets` character positions inside a textarea, measured through a mirror
 * element that carries the textarea's own metrics.
 *
 * A textarea gives no geometry for its own content, and `line * lineHeight` is wrong the moment a
 * paragraph wraps — which, in markdown source at a 100-character measure, is most paragraphs. The
 * mirror is the only way to get this right, so it is worth its twenty lines.
 *
 * @param {any} textarea
 * @param {number[]} offsets
 * @returns {number[]}
 */
export function measureTextareaOffsets(textarea, offsets) {
  if (!offsets.length || typeof document === "undefined") return offsets.map(() => 0);
  const computed = getComputedStyle(textarea);
  const mirror = document.createElement("div");
  for (const property of [
    "boxSizing",
    "fontFamily",
    "fontSize",
    "fontStyle",
    "fontWeight",
    "letterSpacing",
    "lineHeight",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
    "borderTopWidth",
    "borderRightWidth",
    "borderBottomWidth",
    "borderLeftWidth",
    "tabSize",
    "textIndent",
    "textTransform",
    "wordSpacing",
    "overflowWrap",
  ]) {
    /** @type {any} */ (mirror.style)[property] = /** @type {any} */ (computed)[property];
  }
  mirror.style.position = "absolute";
  mirror.style.top = "0";
  mirror.style.left = "-9999px";
  mirror.style.visibility = "hidden";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.width = `${textarea.clientWidth}px`;
  mirror.style.height = "auto";
  document.body.append(mirror);
  const marker = document.createElement("span");
  marker.textContent = "​";
  const text = textarea.value ?? "";
  const results = offsets.map((offset) => {
    mirror.textContent = text.slice(0, Math.max(0, offset));
    mirror.append(marker);
    return marker.offsetTop;
  });
  mirror.remove();
  return results;
}

/**
 * Scrolls a container so `top` lands just under its upper edge, honouring reduced motion.
 *
 * @param {any} scroller
 * @param {number} top
 */
export function scrollToOffset(scroller, top) {
  const target = Math.max(0, top - JUMP_HEADROOM);
  if (typeof scroller.scrollTo === "function") {
    scroller.scrollTo({ top: target, behavior: prefersReducedMotion() ? "auto" : "smooth" });
    return;
  }
  scroller.scrollTop = target;
}

export const OUTLINE_TUNING = {
  CURRENT_HEADING_OFFSET,
  JUMP_HEADROOM,
};

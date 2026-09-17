// SPDX-License-Identifier: Apache-2.0
// @ts-check
// @glosa/spa — where a run of top-level blocks begins and ends in the source.
//
// A RUN is a contiguous sequence of top-level blocks, usually exactly one. Per-block editing opens
// a run rather than a block because that is what keeps the boundary cases ordinary instead of
// special: pressing Enter at the end of a paragraph yields two blocks, pasting three paragraphs
// into one yields three, and pressing Backspace at the start of a block widens the run to include
// the block above it. The serializer in rich-editor.js was already written in these terms
// (`serializeNodes`, `runIsModelled`, `runsOverlap`, `collateralFor`).
//
// PURE, AND DELIBERATELY IMPORT-FREE. `blockLayout()` lives in rich-editor.js, which carries the
// vendored ProseMirror bundle, and `import-boundary.test.ts` pins that the Read/Review static graph
// cannot reach that bundle. So this module takes the spans it is given rather than computing them:
// the caller already had to be past the lazy import to have an editor to mount. Being import-free
// is also what makes every function here testable without a DOM, a daemon, or a 400 KB bundle.

/**
 * Line-start offsets for `source`, so a byte offset can be turned into a 0-based line number
 * without rescanning the document for each lookup.
 * @param {string} source
 */
function lineStarts(source) {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

/**
 * The 0-based line `offset` falls on. Binary search rather than a scan, because the caller asks
 * once per top-level block and a long document has thousands.
 * @param {number[]} starts @param {number} offset
 */
function lineAt(starts, offset) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((starts[mid] ?? 0) <= offset) low = mid;
    else high = mid - 1;
  }
  return low;
}

/**
 * @typedef {{ start: number, end: number }} Span
 * @typedef {{ start: number, end: number, index: number, line: number }} Run
 */

/**
 * Every top-level block of `source` as a run, carrying the source line it starts on.
 *
 * The line is what ties a run to the DOM: the renderer stamps `data-line="<token.map[0]>"` on every
 * block-level element, and a block's span starts on exactly that line. Matching on the line rather
 * than on ordinal position is what keeps the two in step when a document contains something the
 * renderer hides — front matter and `%%` comments produce no element but do produce a span.
 *
 * @param {string} source @param {Span[]} blocks `blockLayout(source).blocks` @returns {Run[]}
 */
export function runsFrom(source, blocks) {
  const starts = lineStarts(source);
  return blocks.map((block, index) => ({
    start: block.start,
    end: block.end,
    index,
    line: lineAt(starts, block.start),
  }));
}

/**
 * The run beginning on `line`, or null when no top-level block starts there.
 *
 * Null is a real answer, not a failure: a click can land on an element the renderer produced from
 * something that is not a top-level block of its own, and the caller's correct response is to leave
 * the page alone rather than to open an editor over the wrong bytes.
 *
 * @param {Run[]} runs @param {number} line @returns {Run | null}
 */
export function runAtLine(runs, line) {
  return runs.find((run) => run.line === line) ?? null;
}

/**
 * `source` with `run`'s bytes replaced by `markdown`.
 *
 * Every byte outside the run is copied through untouched — this function is the one place the
 * per-block path writes, and it cannot express a change beyond the span it was given.
 *
 * @param {string} source @param {Span} run @param {string} markdown
 */
export function spliceRun(source, run, markdown) {
  return source.slice(0, run.start) + markdown + source.slice(run.end);
}

/**
 * `run` widened to take in the block above it, for Backspace at the head of a run.
 *
 * Returns the run unchanged at the top of the document, so the caller does not have to special-case
 * the first block: widening past the start is simply a no-op, and the keystroke does nothing, which
 * is what it does in every editor.
 *
 * @param {Run[]} runs @param {Run} run @returns {Run}
 */
export function widenToPrevious(runs, run) {
  const previous = runs[run.index - 1];
  if (!previous) return run;
  return { start: previous.start, end: run.end, index: previous.index, line: previous.line };
}

/**
 * `run` widened to take in the block below it, for Delete at the end of a run.
 * @param {Run[]} runs @param {Run} run @returns {Run}
 */
export function widenToNext(runs, run) {
  const next = runs[run.index + 1];
  if (!next) return run;
  return { start: run.start, end: next.end, index: run.index, line: run.line };
}

/**
 * How far the document shifted at each offset after `run` was replaced by `markdown`.
 *
 * The margin, the outline and every anchored annotation hold offsets into the source. After a
 * splice, everything before the run is where it was and everything after it has moved by a fixed
 * delta, so a caller can remap an offset without reparsing. Offsets INSIDE the replaced run have no
 * honest answer — the bytes they pointed at may not exist any more — and get null rather than a
 * plausible-looking number.
 *
 * @param {Span} run @param {string} markdown @returns {(offset: number) => number | null}
 */
export function offsetRemapper(run, markdown) {
  const delta = markdown.length - (run.end - run.start);
  return (offset) => {
    if (offset <= run.start) return offset;
    if (offset >= run.end) return offset + delta;
    return null;
  };
}

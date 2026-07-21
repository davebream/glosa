// SPDX-License-Identifier: Apache-2.0
// @glosa/spa — the W3C-style annotation record builder (A1 §5.6's body shape; A5 §F10/§F11's
// normalization inputs). This module PRODUCES a record from a browser selection — it does NOT
// resolve it back to a source range; that's the anchoring resolver, P3.4's job (A5 §F10). Talks
// to the daemon through NOTHING directly — callers pass the built record to
// `dataAccess.postAnnotation` themselves (see test/import-boundary.test.ts).
const CONTEXT_CHARS = 40; // A5 §F10: "prefix/suffix ±40 rendered chars post-fold"

/** Never let a prefix/suffix window boundary land between a UTF-16 surrogate pair's two code
 * units (e.g. an astral emoji) — that would slice out an unpaired surrogate, not valid text.
 * Shrinking the window by one code unit is always safe: the ±40 context is advisory, not an
 * exact contract. */
function surrogateSafeIndex(text, index) {
  if (index > 0 && index < text.length) {
    const prev = text.charCodeAt(index - 1);
    if (prev >= 0xd800 && prev <= 0xdbff) return index - 1;
  }
  return index;
}

/**
 * Builds the `target` half of an annotation record from a plain `(start, end)` UTF-16 offset
 * pair into `fullText` — no DOM involved, so this is directly unit-testable against a fake
 * selection. `start`/`end` are the same UTF-16 code-unit space `String.prototype.slice` uses,
 * matching A5 §F10's "offsets in UTF-16 code units ... vs rendered DOM text." Returns `null` for
 * a degenerate (empty, out-of-range, or non-integer) selection rather than throwing — an empty
 * selection just isn't an annotation.
 */
export function buildAnnotationTarget(fullText, start, end, { chunkId } = {}) {
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (start < 0 || end > fullText.length || start >= end) return null;

  const exact = fullText.slice(start, end);
  const prefixStart = surrogateSafeIndex(fullText, Math.max(0, start - CONTEXT_CHARS));
  const suffixEnd = surrogateSafeIndex(fullText, Math.min(fullText.length, end + CONTEXT_CHARS));

  // Built as one literal (rather than assigning `target.chunk_id = chunkId` afterward) so a .ts
  // consumer's type inference over this plain-JS function sees `chunk_id` as part of the shape
  // from the start, optional, instead of an untracked expando property.
  return {
    quote: { exact, prefix: fullText.slice(prefixStart, start), suffix: fullText.slice(end, suffixEnd) },
    position: { start, end },
    ...(chunkId !== undefined ? { chunk_id: chunkId } : {}),
  };
}

/** Walks `container`'s text nodes in document order to translate a DOM `(node, offset)` boundary
 * — the shape `Range`/`Selection` boundaries come in — into a single UTF-16 offset into
 * `container.textContent`, the same string `buildAnnotationTarget` slices. */
function textOffsetOf(container, node, offset) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let total = 0;
  let current = walker.nextNode();
  while (current) {
    if (current === node) return total + offset;
    total += current.textContent.length;
    current = walker.nextNode();
  }
  return total; // boundary wasn't inside a text descendant of container — clamp to the end
}

/**
 * The DOM-facing half: takes a live `Selection` (`window.getSelection()`) plus the rendered
 * container it was made in, and produces the full annotation record ready for
 * `dataAccess.postAnnotation(slug, record)` — `{body, intent, target}`. Returns `null` for no/
 * collapsed selection, or a selection that isn't inside `container` at all (nothing to
 * annotate).
 */
export function buildAnnotationRecordFromSelection(selection, container, { body, intent, chunkId } = {}) {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return null;

  const fullText = container.textContent;
  const start = textOffsetOf(container, range.startContainer, range.startOffset);
  const end = textOffsetOf(container, range.endContainer, range.endOffset);
  const target = buildAnnotationTarget(fullText, start, end, { chunkId });
  if (!target) return null;

  return { body, intent, target };
}

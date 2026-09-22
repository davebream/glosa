// SPDX-License-Identifier: Apache-2.0
// @glosa/spa — the W3C-style annotation record builder (A1 §5.6's body shape; A5 §F10/§F11's
// normalization inputs), plus the fixed A5 §F10 normalization itself. This module PRODUCES a
// record from a browser selection — it does NOT resolve it back to a SOURCE range; that's the
// anchoring resolver's job in the daemon, which stays the authority at delivery time. What lives
// here alongside the builder is the pure text half of that normalization, so the page can re-find
// a note in the RENDERED text by the same rule the daemon uses (fold, then unique or nothing).
// Talks to the daemon through NOTHING directly — callers pass the built record to
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

// --- the fixed normalization (A5 §F10), ported from the daemon's resolver ---
//
// The daemon folds before it searches, so a paragraph that was only re-wrapped — a space became a
// soft break, or the reverse — still resolves there. The page did not, so a note could be
// delivered and still show "Lost its place". These three functions are the page's half of that
// rule, deliberately the same rule: NFC, whitespace runs to one space, and a match only when it
// is the only one.

const COMBINING_MARK_RE = /^\p{M}$/u;

/** NFC + whitespace-fold with no position mapping — for the search NEEDLE (the note's own stored
 * quote), which is never the thing whose offsets we report back. */
export function foldQuote(s) {
  return s.normalize("NFC").replace(/\s+/gu, " ").trim();
}

/** NFC-normalizes `s` while tracking, for every UTF-16 unit of the output, the `[start, end)` span
 * of the ORIGINAL text it came from — which `String.prototype.normalize` alone cannot give you,
 * since it isn't invertible. Each base character is clustered with its immediately following run
 * of `\p{M}` combining marks and normalized on its own, which is the composition this domain needs
 * (a base letter plus a combining accent — the Polish ó/ą/ż case). It does NOT reproduce full
 * Unicode NFC: compositions that don't route through a combining mark (Hangul jamo → syllable)
 * won't recompose. Same stated limitation as the daemon's, on purpose — the two must agree. */
function buildNfcMap(s) {
  let nfc = "";
  const origStart = [];
  const origEnd = [];
  let origPos = 0;
  let acc = "";
  let accOrigStart = 0;

  const flush = (accOrigEnd) => {
    if (acc.length === 0) return;
    const normalized = acc.normalize("NFC");
    for (let k = 0; k < normalized.length; k++) {
      origStart.push(accOrigStart);
      origEnd.push(accOrigEnd);
    }
    nfc += normalized;
    acc = "";
  };

  for (const cp of s) {
    if (acc.length > 0 && COMBINING_MARK_RE.test(cp)) {
      acc += cp;
    } else {
      flush(origPos);
      acc = cp;
      accOrigStart = origPos;
    }
    origPos += cp.length; // UTF-16 code-unit width (1, or 2 for an astral codepoint)
  }
  flush(origPos);
  return { nfc, origStart, origEnd };
}

/** Whitespace-fold on top of an already NFC-mapped string, extending the same origin tracking: a
 * run of Unicode whitespace (a newline from a soft break, a doubled space, a tab, an NBSP — `\s`
 * covers them all) collapses to one space, mapped to the span from the run's first original
 * character to its last. */
function foldMapped(nfc, origStart, origEnd) {
  let folded = "";
  const fStart = [];
  const fEnd = [];
  let i = 0;
  while (i < nfc.length) {
    if (/\s/u.test(nfc[i])) {
      const runStart = i;
      while (i < nfc.length && /\s/u.test(nfc[i])) i++;
      folded += " ";
      fStart.push(origStart[runStart] ?? 0);
      fEnd.push(origEnd[i - 1] ?? 0);
    } else {
      folded += nfc[i];
      fStart.push(origStart[i] ?? 0);
      fEnd.push(origEnd[i] ?? 0);
      i++;
    }
  }
  return { folded, fStart, fEnd };
}

/**
 * Finds `exact` in `text` under the fixed normalization, and reports the span in `text`'s OWN
 * UTF-16 offsets — the ones a DOM range needs — not the folded ones.
 *
 * Unique or nothing: a quote that folds to something occurring twice returns null, so the page
 * leaves the note unanchored rather than picking one of two passages. An empty (or whitespace-
 * only) quote is not a quote and returns null too.
 */
export function locateFoldedQuote(text, exact) {
  const needle = foldQuote(exact ?? "");
  if (needle.length === 0) return null;
  const { nfc, origStart, origEnd } = buildNfcMap(text);
  const { folded, fStart, fEnd } = foldMapped(nfc, origStart, origEnd);
  const first = folded.indexOf(needle);
  if (first === -1) return null;
  if (folded.indexOf(needle, first + 1) !== -1) return null; // ambiguous — never guess
  return { start: fStart[first] ?? 0, end: fEnd[first + needle.length - 1] ?? 0 };
}

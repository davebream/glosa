// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — the anchoring resolver (A5 §F10/§F11, R6). Maps a W3C-shaped annotation record
// (built by @glosa/spa's annotate.js, or the class-F bridge) back onto either a verified source
// range, a typed pipeline-feedback entry, or an honest "couldn't map it" — TOTAL: this module
// never throws and never guesses. "Never guesses" is the load-bearing word: every branch below
// either proves a unique location or gives up loudly (`orphaned`) or gives non-binding guidance
// (`block_range`); nothing here silently picks "probably that one."
//
// No full inline source map exists yet (deferred, per A5's cross-cutting note) — Class R anchors
// via markdown-it's `data-line` block stamps (packages/daemon/src/artifact-render.ts) plus literal/
// normalized substring search; Class F anchors via a chunk manifest supplied by the caller (the
// real manifest wiring is P4.1 — this module only implements the resolution LOGIC given one).
//
// Generic-core invariant (AGENTS.md #1): this module knows nothing about any specific pipeline or
// producer. A5's worked pipeline_feedback example uses a concrete `{adapter, component}` pair
// purely for illustration — that's not a mandate to hardcode a domain adapter's identity into the
// daemon core. Callers that DO know (a content adapter, or the route composing this resolver)
// pass `ctx.pipelineFeedback`; absent, we fall back to "unknown" rather than invent a real name.
import { createHash } from "node:crypto";
import { sourceSha256 } from "./artifact-render.ts";

export interface AnchoringQuote {
  exact: string;
  prefix: string;
  suffix: string;
}

export interface AnchoringTarget {
  chunk_id?: string;
  quote: AnchoringQuote;
  /** UTF-16 code-unit offsets into the RENDERED container's `textContent` (A5 §F10) — trusted
   * only while `ctx.capturedRenderedSha256` still matches the artifact's current rendered bytes. */
  position?: { start: number; end: number };
}

export interface AnchoringAnnotation {
  body: string;
  intent: string;
  target: AnchoringTarget;
}

export interface ChunkManifestEntry {
  chunk_id: string;
  source_start_line: number; // 0-based, inclusive
  source_end_line: number; // 0-based, inclusive
  source_sha256: string;
  transformed?: boolean; // default false
}

export interface ChunkManifest {
  manifest_version: 1;
  source_path: string;
  source_sha256: string;
  chunks: ChunkManifestEntry[];
}

export interface ClassRArtifact {
  class: "R";
  /** Path reported back in a `source_range` Resolution — the artifact's own workspace-relative path. */
  path: string;
  /** Raw source text as read from disk (before this module's own `\r\n`→`\n` normalization). */
  source: string;
  /** The `data-line`-stamped HTML this artifact was last served as (artifact-render.ts's `renderMarkdown`
   * output) — used both to scope a `position` to its enclosing block and as the "served bytes"
   * `rendered_sha256` is computed over. */
  renderedHtml: string;
}

export interface ClassFArtifact {
  class: "F";
  /** The class-F artifact's own path (the HTML). Never used as a `source_range` path — Class F
   * anchors resolve into the manifest's `source_path` (the derived-from manuscript), not the HTML. */
  path: string;
  /** The DERIVED-FROM SOURCE artifact's raw text (the manuscript `manifest.source_path` points at,
   * already resolved by the caller via the generic derived-from edge) — not the HTML body. */
  source: string;
  manifest?: ChunkManifest;
}

export type AnchoringArtifact = ClassRArtifact | ClassFArtifact;

export interface ResolveCtx {
  /** The `rendered_sha256` in effect when `annotation.target.position` was captured. Absent ⇒
   * treated as unproven ⇒ never trusted (A5 §F10: "position trusted only while rendered_sha256
   * still matches" — no proof of a match is the same as no match). */
  capturedRenderedSha256?: string;
  /** Domain identity for a `pipeline_feedback` target — supplied by the content-adapter layer,
   * which is the only layer allowed to know which real producer/pipeline this is (see file
   * header). */
  pipelineFeedback?: { adapter: string; component: string };
}

export type Resolution =
  | {
      kind: "source_range";
      path: string;
      start_line: number;
      end_line: number;
      start_col?: number;
      end_col?: number;
      matched_quote: string;
      confidence: "exact" | "normalized" | "block_range";
    }
  | {
      kind: "pipeline_feedback";
      target: { adapter: string; component: string; chunk_id: string; source_line_range: [number, number] };
      intent: string;
      body: string;
    }
  | {
      kind: "orphaned";
      reason: "hash_mismatch_no_match" | "ambiguous" | "no_source_map" | "quote_absent_not_transformed";
    };

// --- totality-facing sanitizers — the boundary between "whatever the fuzzer/network handed us"
// and the typed shapes the algorithm below is written against. Never throw; always coerce toward
// a safe default instead. ---

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Drops any UTF-16 code unit in the surrogate range (`0xD800`–`0xDFFF`) that isn't part of a
 * valid high+low pair. A real browser Selection can never hand annotate.js one of these, but this
 * module has to survive arbitrary/fuzzed network input too — and an unpaired surrogate left in a
 * search needle can `indexOf`-match mid-pair inside a real astral character, producing a "verified
 * exact" match that actually slices one. `Array.from` groups a valid pair into a single element
 * whose `codePointAt(0)` is the real (non-surrogate) codepoint; only a genuinely lone surrogate
 * still reports a codepoint inside the surrogate range, so filtering on that is exact, not a guess. */
function stripLoneSurrogates(s: string): string {
  return Array.from(s)
    .filter((ch) => {
      const cp = ch.codePointAt(0) ?? 0;
      return cp < 0xd800 || cp > 0xdfff;
    })
    .join("");
}

function asFiniteInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) ? v : undefined;
}

function clampInt(v: unknown, lo: number, hi: number): number {
  const n = asFiniteInt(v);
  if (n === undefined) return lo;
  if (hi < lo) return lo; // degenerate range (e.g. empty document) — never throw on it
  return Math.min(Math.max(n, lo), hi);
}

function sanitizeAnnotation(input: unknown): AnchoringAnnotation {
  const root = asRecord(input);
  const target = asRecord(root.target);
  const quote = asRecord(target.quote);
  const posRaw = asRecord(target.position);
  const start = asFiniteInt(posRaw.start);
  const end = asFiniteInt(posRaw.end);
  const position = start !== undefined && end !== undefined && start >= 0 && end >= start ? { start, end } : undefined;
  const chunkIdRaw = target.chunk_id;
  return {
    body: asString(root.body),
    intent: asString(root.intent),
    target: {
      ...(typeof chunkIdRaw === "string" ? { chunk_id: chunkIdRaw } : {}),
      quote: {
        exact: stripLoneSurrogates(asString(quote.exact)),
        prefix: stripLoneSurrogates(asString(quote.prefix)),
        suffix: stripLoneSurrogates(asString(quote.suffix)),
      },
      ...(position ? { position } : {}),
    },
  };
}

function sanitizeCtx(input: unknown): ResolveCtx {
  const root = asRecord(input);
  const captured = typeof root.capturedRenderedSha256 === "string" ? root.capturedRenderedSha256 : undefined;
  const pf = asRecord(root.pipelineFeedback);
  const pipelineFeedback =
    typeof pf.adapter === "string" && typeof pf.component === "string"
      ? { adapter: pf.adapter, component: pf.component }
      : undefined;
  return { ...(captured ? { capturedRenderedSha256: captured } : {}), ...(pipelineFeedback ? { pipelineFeedback } : {}) };
}

// --- fixed normalization primitives (A5 §F10, shared verbatim by Class R and Class F) ---

function normalizeSource(raw: string): string {
  return raw.replace(/\r\n/g, "\n");
}

function renderedSha256Hex(renderedHtml: string): string {
  return createHash("sha256").update(renderedHtml, "utf8").digest("hex");
}

/** NFC + whitespace-fold, no position mapping — used for the search NEEDLE (the annotation's own
 * quote text), which is never itself the thing reported back to the user. */
function foldPlain(s: string): string {
  return s.normalize("NFC").replace(/\s+/gu, " ").trim();
}

const COMBINING_MARK_RE = /^\p{M}$/u;

/** NFC-normalizes `s` while tracking, for every UTF-16 unit of the output, the `[start,end)` span
 * of the ORIGINAL text it came from — which plain `String.prototype.normalize` alone can't give
 * you (it isn't invertible). Works by clustering each base character with its immediately-
 * following run of `\p{M}` combining marks and normalizing each cluster independently, which is
 * exactly the composition this module's domain needs: a base letter + trailing combining accent
 * (the Polish ó/ą/ż/etc. case this exists for). It does NOT reproduce full Unicode NFC in
 * general — canonical compositions that don't route through a `\p{M}` combining mark (e.g. Hangul
 * jamo → syllable) won't recompose here. That's out of scope, not a bug to fix. */
function buildNfcMap(s: string): { nfc: string; origStart: number[]; origEnd: number[] } {
  const codepoints = Array.from(s);
  let nfc = "";
  const origStart: number[] = [];
  const origEnd: number[] = [];
  let origPos = 0;
  let acc = "";
  let accOrigStart = 0;

  const flush = (accOrigEnd: number) => {
    if (acc.length === 0) return;
    const normalized = acc.normalize("NFC");
    for (let k = 0; k < normalized.length; k++) {
      origStart.push(accOrigStart);
      origEnd.push(accOrigEnd);
    }
    nfc += normalized;
    acc = "";
  };

  for (const cp of codepoints) {
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

/** Whitespace-fold on top of an already NFC-mapped string, extending the same origin tracking:
 * a run of Unicode whitespace (incl. NBSP — `\s` already covers it in JS) collapses to one space,
 * mapped to the span from the run's first original character to its last. */
function foldWithMap(
  nfc: string,
  origStart: number[],
  origEnd: number[],
): { folded: string; fStart: number[]; fEnd: number[] } {
  let folded = "";
  const fStart: number[] = [];
  const fEnd: number[] = [];
  let i = 0;
  while (i < nfc.length) {
    const ch = nfc[i]!;
    if (/\s/u.test(ch)) {
      const runStart = i;
      while (i < nfc.length && /\s/u.test(nfc[i]!)) i++;
      folded += " ";
      fStart.push(origStart[runStart] ?? 0);
      fEnd.push(origEnd[i - 1] ?? 0);
    } else {
      folded += ch;
      fStart.push(origStart[i] ?? 0);
      fEnd.push(origEnd[i] ?? 0);
      i++;
    }
  }
  return { folded, fStart, fEnd };
}

/** Every occurrence of `needle` in `haystack`, overlapping matches included — the simplest correct
 * definition of "how many times does this occur" for a uniqueness check. An empty needle "occurs"
 * at every offset (finite, never an infinite loop) — in practice that only ever yields a unique
 * (length-1) result when `haystack` itself is empty, so it naturally falls through to "ambiguous"
 * everywhere else rather than needing a special case. */
function findAllOffsets(haystack: string, needle: string): number[] {
  if (needle.length === 0) {
    const out: number[] = [];
    for (let i = 0; i <= haystack.length; i++) out.push(i);
    return out;
  }
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    out.push(idx);
    from = idx + 1;
  }
  return out;
}

function computeLineStarts(sourceLines: string[]): number[] {
  const starts: number[] = [0];
  let acc = 0;
  for (let i = 0; i < sourceLines.length - 1; i++) {
    acc += (sourceLines[i]?.length ?? 0) + 1; // +1 for the `\n` this module always joins on
    starts.push(acc);
  }
  return starts;
}

function offsetToLineCol(lineStarts: number[], offset: number): { line: number; col: number } {
  let lo = 0;
  let hi = lineStarts.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((lineStarts[mid] ?? 0) <= offset) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return { line: ans, col: offset - (lineStarts[ans] ?? 0) };
}

// --- scoped substring search — the shared primitive both cascades' "EXACT then NORMALIZED" steps
// are built from (A5 §F10: Class F step 3 explicitly reuses "the Class-R EXACT→NORMALIZED search"). ---

type SearchResult =
  | { status: "unique"; absStart: number; absEnd: number; matchedText: string; confidence: "exact" | "normalized" }
  | { status: "none" }
  | { status: "ambiguous" };

function searchExact(sourceLines: string[], lineStarts: number[], l0: number, l1: number, quoteExact: string): SearchResult {
  if (l0 > l1 || l0 < 0 || l1 >= sourceLines.length) return { status: "none" };
  const text = sourceLines.slice(l0, l1 + 1).join("\n");
  const absOffset = lineStarts[l0] ?? 0;
  const offsets = findAllOffsets(text, quoteExact);
  if (offsets.length === 0) return { status: "none" };
  if (offsets.length > 1) return { status: "ambiguous" };
  const start = offsets[0]!;
  return { status: "unique", absStart: absOffset + start, absEnd: absOffset + start + quoteExact.length, matchedText: quoteExact, confidence: "exact" };
}

function searchNormalized(sourceLines: string[], lineStarts: number[], l0: number, l1: number, quoteExact: string): SearchResult {
  if (l0 > l1 || l0 < 0 || l1 >= sourceLines.length) return { status: "none" };
  const text = sourceLines.slice(l0, l1 + 1).join("\n");
  const absOffset = lineStarts[l0] ?? 0;
  const { nfc, origStart, origEnd } = buildNfcMap(text);
  const { folded, fStart, fEnd } = foldWithMap(nfc, origStart, origEnd);
  const foldedNeedle = foldPlain(quoteExact);

  const offsets = findAllOffsets(folded, foldedNeedle);
  if (offsets.length === 0) return { status: "none" };
  if (offsets.length > 1) return { status: "ambiguous" };
  const mStart = offsets[0]!;

  if (foldedNeedle.length === 0) {
    // Only reachable when `folded` itself is empty (see findAllOffsets) — a genuinely degenerate
    // empty-quote-on-empty-scope case. Resolve to a zero-width point rather than indexing past
    // the (also empty) map arrays.
    const at = absOffset;
    return { status: "unique", absStart: at, absEnd: at, matchedText: "", confidence: "normalized" };
  }
  const mEnd = mStart + foldedNeedle.length;
  const rawStart = fStart[mStart] ?? 0;
  const rawEnd = fEnd[mEnd - 1] ?? rawStart;
  return {
    status: "unique",
    absStart: absOffset + rawStart,
    absEnd: absOffset + rawEnd,
    matchedText: text.slice(rawStart, rawEnd),
    confidence: "normalized",
  };
}

function toSourceRange(path: string, lineStarts: number[], m: Extract<SearchResult, { status: "unique" }>): Resolution {
  const start = offsetToLineCol(lineStarts, m.absStart);
  const end = offsetToLineCol(lineStarts, m.absEnd);
  return {
    kind: "source_range",
    path,
    start_line: start.line,
    end_line: end.line,
    start_col: start.col,
    end_col: end.col,
    matched_quote: m.matchedText,
    confidence: m.confidence,
  };
}

// --- Class R: rendered `data-line` block scoping ---

/** Strips tags and decodes entities from markdown-it's rendered HTML, mirroring what a browser's
 * `container.textContent` would produce (A5 §F10's normalization is defined against that string —
 * the same one annotate.js reads `position` offsets from). Records, in document order, the
 * `textContent` offset at which every `data-line`-stamped open tag begins — the block-boundary
 * markers `enclosingBlock` scopes a position against. Malformed/truncated HTML (an unterminated
 * `<tag`) simply stops parsing rather than throwing — the caller only gets a shorter `text` and
 * whatever markers were found before the cutoff, still usable, never fatal. */
function extractTextAndBlocks(html: string): { text: string; markers: { offset: number; line: number }[] } {
  let text = "";
  const markers: { offset: number; line: number }[] = [];
  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      text += decodeEntities(html.slice(i));
      break;
    }
    if (lt > i) text += decodeEntities(html.slice(i, lt));
    const gt = html.indexOf(">", lt);
    if (gt === -1) break; // unterminated tag — stop; whatever we already have is total-safe to use
    const tag = html.slice(lt, gt + 1);
    if (!tag.startsWith("</")) {
      const m = /\bdata-line="(\d+)"/.exec(tag);
      if (m?.[1] !== undefined) markers.push({ offset: text.length, line: Number(m[1]) });
    }
    i = gt + 1;
  }
  return { text, markers };
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, ent: string) => {
    try {
      if (ent[0] === "#") {
        const isHex = ent[1] === "x" || ent[1] === "X";
        const code = Number.parseInt(ent.slice(isHex ? 2 : 1), isHex ? 16 : 10);
        return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
      }
      switch (ent) {
        case "amp":
          return "&";
        case "lt":
          return "<";
        case "gt":
          return ">";
        case "quot":
          return '"';
        case "apos":
          return "'";
        case "nbsp":
          return " ";
        default:
          return whole; // unknown named entity — leave verbatim rather than guess
      }
    } catch {
      return whole;
    }
  });
}

/** The largest-offset marker at or before `pos` — i.e. the innermost/most-specific stamped block
 * that contains it (markers are appended in document order by `extractTextAndBlocks`, so they are
 * already offset-ascending). `undefined` means `pos` precedes every stamped block. */
function markerAt(markers: { offset: number; line: number }[], pos: number): { offset: number; line: number } | undefined {
  let chosen: { offset: number; line: number } | undefined;
  for (const marker of markers) {
    if (marker.offset <= pos) chosen = marker;
    else break;
  }
  return chosen;
}

function enclosingBlock(
  markers: { offset: number; line: number }[],
  startPos: number,
  endPos: number,
  lastSourceLine: number,
): { l0: number; l1: number } | undefined {
  if (markers.length === 0) return undefined;
  const startMarker = markerAt(markers, startPos);
  const endMarker = markerAt(markers, endPos);
  const chosen = startMarker ?? endMarker;
  if (!chosen) return undefined;

  const l0 = Math.min(startMarker?.line ?? chosen.line, endMarker?.line ?? chosen.line);
  // The next block boundary is the first marker whose TEXT OFFSET lies past the selection's own
  // end — found by direct offset comparison over `markers` (already offset-ascending, in document
  // order). Deliberately NOT "re-derive an array index from whichever marker `markerAt` returned,
  // then look at index+1" — that indirection is exactly the kind of thing ties (a `<ul>` and its
  // first `<li>` sharing one offset) or a start/end pair landing in the wrong relative order can
  // throw off; a direct offset scan can't overshoot or undershoot the real next block regardless.
  const scanFrom = Math.max(startPos, endPos);
  let next: { offset: number; line: number } | undefined;
  for (const marker of markers) {
    if (marker.offset > scanFrom) {
      next = marker;
      break;
    }
  }
  const l1raw = next ? next.line - 1 : lastSourceLine;
  const l1 = Math.max(l0, Math.max(endMarker?.line ?? l0, l1raw));
  return { l0, l1: Math.min(l1, lastSourceLine) };
}

interface RScope {
  l0: number;
  l1: number;
  /** Whether l0/l1 came from an actual stamped block (vs. the whole-doc default) — this is what
   * step 6 of the cascade checks to decide `block_range` guidance vs. `orphaned`. */
  fromBlock: boolean;
}

function scopeForR(artifact: ClassRArtifact, target: AnchoringTarget, ctx: ResolveCtx, lastSourceLine: number): RScope {
  const wholeDoc: RScope = { l0: 0, l1: lastSourceLine, fromBlock: false };
  if (!target.position) return wholeDoc;

  // A5 §F10: "a position is trusted ONLY while rendered_sha256 still matches" — no captured hash
  // to compare against is treated the same as a stale one (no proof, no trust).
  const hashFresh = ctx.capturedRenderedSha256 !== undefined && ctx.capturedRenderedSha256 === renderedSha256Hex(artifact.renderedHtml);
  if (!hashFresh) return wholeDoc;

  const { text, markers } = extractTextAndBlocks(artifact.renderedHtml);
  const startPos = Math.min(Math.max(target.position.start, 0), text.length);
  const endPosInclusive = Math.min(Math.max(target.position.end - 1, startPos), Math.max(text.length - 1, 0));
  const block = enclosingBlock(markers, startPos, endPosInclusive, lastSourceLine);
  return block ? { ...block, fromBlock: true } : wholeDoc;
}

function resolveClassR(annotation: AnchoringAnnotation, artifact: ClassRArtifact, ctx: ResolveCtx): Resolution {
  const sourceNormalized = normalizeSource(artifact.source);
  const sourceLines = sourceNormalized.split("\n");
  const lineStarts = computeLineStarts(sourceLines);
  const lastLine = sourceLines.length - 1;
  const quoteExact = annotation.target.quote.exact;

  const scope = scopeForR(artifact, annotation.target, ctx, lastLine);

  const exactRes = searchExact(sourceLines, lineStarts, scope.l0, scope.l1, quoteExact);
  if (exactRes.status === "unique") return toSourceRange(artifact.path, lineStarts, exactRes);

  const normRes = searchNormalized(sourceLines, lineStarts, scope.l0, scope.l1, quoteExact);
  if (normRes.status === "unique") return toSourceRange(artifact.path, lineStarts, normRes);

  if (scope.fromBlock) {
    const wideRes = searchNormalized(sourceLines, lineStarts, 0, lastLine, quoteExact);
    if (wideRes.status === "unique") return toSourceRange(artifact.path, lineStarts, wideRes);
    // Step 6: a stamped block was identifiable even though no verified match was — guidance, not
    // a guess. This is also the path a rendered selection crossing **bold**/[link]/`code` markup
    // boundaries takes: its literal text never substring-matches the still-marked-up source.
    return {
      kind: "source_range",
      path: artifact.path,
      start_line: scope.l0,
      end_line: scope.l1,
      matched_quote: quoteExact,
      confidence: "block_range",
    };
  }

  // No stamped block was ever in play (no position, or a stale rendered hash) — scope was already
  // the whole document, so exactRes/normRes above already searched it in full. Class R NEVER
  // returns pipeline_feedback: it has no declared transform to route feedback through.
  const reason = exactRes.status === "ambiguous" || normRes.status === "ambiguous" ? "ambiguous" : "hash_mismatch_no_match";
  return { kind: "orphaned", reason };
}

// --- Class F: chunk-manifest scoping ---

function resolveClassF(annotation: AnchoringAnnotation, artifact: ClassFArtifact, ctx: ResolveCtx): Resolution {
  const manifest = artifact.manifest;
  const chunkId = annotation.target.chunk_id;
  const chunk = manifest && chunkId ? manifest.chunks.find((c) => c.chunk_id === chunkId) : undefined;
  if (!manifest || !chunk) return { kind: "orphaned", reason: "no_source_map" };

  const sourceNormalized = normalizeSource(artifact.source);
  const sourceLines = sourceNormalized.split("\n");
  const lineStarts = computeLineStarts(sourceLines);
  const lastLine = sourceLines.length - 1;

  const l0Declared = clampInt(chunk.source_start_line, 0, lastLine);
  const l1Declared = clampInt(chunk.source_end_line, l0Declared, lastLine);

  // Staleness (A5 §F10 step 2): trust the manifest's declared chunk line range only while both the
  // whole-document hash and the chunk's own slice hash still match what the manifest recorded —
  // same "don't trust a boundary you can't prove is current" posture Class R applies to `position`.
  // A distrusted range widens to the whole document rather than inventing a narrower guess.
  const docFresh = manifest.source_sha256 === sourceSha256(Buffer.from(sourceNormalized, "utf8"));
  const chunkSliceText = sourceLines.slice(l0Declared, l1Declared + 1).join("\n");
  const chunkFresh = docFresh && chunk.source_sha256 === sourceSha256(Buffer.from(chunkSliceText, "utf8"));
  const [l0, l1] = chunkFresh ? [l0Declared, l1Declared] : [0, lastLine];

  const transformed = chunk.transformed === true;
  if (!transformed) {
    const quoteExact = annotation.target.quote.exact;
    const exactRes = searchExact(sourceLines, lineStarts, l0, l1, quoteExact);
    if (exactRes.status === "unique") return toSourceRange(manifest.source_path, lineStarts, exactRes);
    const normRes = searchNormalized(sourceLines, lineStarts, l0, l1, quoteExact);
    if (normRes.status === "unique") return toSourceRange(manifest.source_path, lineStarts, normRes);
    // A ≥2-match miss is a DIFFERENT, more honest fact than a 0-match one — the quote IS present,
    // just not uniquely, so "absent" would be false. Mirrors Class R's exact/ambiguous split.
    if (exactRes.status === "ambiguous" || normRes.status === "ambiguous") {
      return { kind: "orphaned", reason: "ambiguous" };
    }
    // Intent does NOT rescue a verbatim chunk with no findable quote — F11's honesty rule.
    return { kind: "orphaned", reason: "quote_absent_not_transformed" };
  }

  // F11: pipeline_feedback ONLY because the producer declared this node `transformed:true` — no
  // search is even attempted; intent selects framing/recipient AFTER transformed authorizes the path.
  const ids = ctx.pipelineFeedback ?? { adapter: "unknown", component: "unknown" };
  return {
    kind: "pipeline_feedback",
    target: {
      adapter: ids.adapter,
      component: ids.component,
      chunk_id: chunk.chunk_id,
      source_line_range: [chunk.source_start_line, chunk.source_end_line],
    },
    intent: annotation.intent,
    body: annotation.body,
  };
}

// --- public entry point ---

/** Total: resolves a W3C-shaped annotation against an artifact's current content, never throwing
 * and never returning anything but a member of `Resolution`. Malformed/garbage `annotation`/
 * `artifact`/`ctx` inputs are sanitized rather than trusted; anything that still slips past that
 * and throws is caught here as a last resort and reported as `orphaned{no_source_map}` — this
 * function structurally cannot propagate an exception to its caller. */
export function resolve(annotationInput: unknown, artifactInput: unknown, ctxInput: unknown = {}): Resolution {
  try {
    const artifactRoot = asRecord(artifactInput);
    const cls = artifactRoot.class;
    if ((cls !== "R" && cls !== "F") || typeof artifactRoot.path !== "string" || typeof artifactRoot.source !== "string") {
      return { kind: "orphaned", reason: "no_source_map" };
    }
    const annotation = sanitizeAnnotation(annotationInput);
    const ctx = sanitizeCtx(ctxInput);

    if (cls === "R") {
      if (typeof artifactRoot.renderedHtml !== "string") return { kind: "orphaned", reason: "no_source_map" };
      const artifact: ClassRArtifact = { class: "R", path: artifactRoot.path, source: artifactRoot.source, renderedHtml: artifactRoot.renderedHtml };
      return resolveClassR(annotation, artifact, ctx);
    }

    const manifest = artifactRoot.manifest as ChunkManifest | undefined;
    const artifact: ClassFArtifact = { class: "F", path: artifactRoot.path, source: artifactRoot.source, ...(manifest ? { manifest } : {}) };
    return resolveClassF(annotation, artifact, ctx);
  } catch {
    return { kind: "orphaned", reason: "no_source_map" };
  }
}

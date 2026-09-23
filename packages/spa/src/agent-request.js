// SPDX-License-Identifier: Apache-2.0
// @glosa/spa — the agent's half of the Review margin.
//
// An attention request carrying a `passage` is a session pointing at words in the manuscript, and
// optionally asking about them. This module turns one into (a) a range in the rendered container
// and (b) a card. It talks to nothing: the pane passes entries in and handlers out, so every
// function here is directly testable without a daemon (see test/import-boundary.test.ts).
//
// DIRECTION MATTERS. `packages/daemon/src/anchoring.ts` resolves rendered→source, because a human
// selects rendered text. A session quotes SOURCE markdown it just wrote, so this resolver runs the
// other way: source→rendered. That asymmetry is why the quote arrives without offsets and why the
// ladder below exists at all — `**premise**` in the source is `premise` on screen.
//
// It follows the daemon resolver's law rather than its algorithm: prove a unique location, or give
// up loudly. Nothing here silently picks "probably that one".

/** Inline markdown that disappears in rendering. Deliberately not a markdown parser: this is a
 * fallback for the common inline marks, and anything it cannot flatten falls through to
 * `orphaned`, which is a correct answer. */
function flattenInlineMarkdown(text) {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // images → alt text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links → label
    .replace(/(\*\*\*|___)(.+?)\1/g, "$2")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(\*|_)(.+?)\1/g, "$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/~~(.+?)~~/g, "$1");
}

/** Folds every run of whitespace to one space and returns the map back to original indices, so a
 * match found in normalized space can be reported as a real range. `map[i]` is the index in
 * `text` that produced normalized character `i`. */
function normalizeWithMap(text) {
  let out = "";
  const map = [];
  let pendingSpace = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) {
      out += " ";
      map.push(i);
      pendingSpace = false;
    }
    out += ch;
    map.push(i);
  }
  return { normalized: out, map };
}

/** Every index at which `needle` occurs in `haystack`, capped so a pathological one-character
 * quote cannot spin. */
function allIndexesOf(haystack, needle, cap = 64) {
  const found = [];
  if (needle.length === 0) return found;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1 || found.length >= cap) return found;
    found.push(at);
    from = at + 1;
  }
}

/**
 * Locates a session's quote in rendered text.
 *
 * Returns `{start, end}` in UTF-16 offsets into `text`, or `null`. A quote that matches in several
 * places and cannot be told apart by its prefix/suffix returns `null` — an ambiguous anchor is not
 * a located one, and underlining the wrong paragraph is worse than underlining nothing.
 */
export function locateQuote(text, quote) {
  if (!quote || typeof quote.exact !== "string" || quote.exact.length === 0) return null;

  // Rung 1 — the quote is already rendered text (plain prose, the common case).
  // Rung 2 — the quote carries inline markdown the renderer removed.
  for (const candidate of [quote.exact, flattenInlineMarkdown(quote.exact)]) {
    const hits = allIndexesOf(text, candidate);
    const picked = disambiguate(text, hits, candidate.length, quote);
    if (picked) return picked;
  }

  // Rung 3 — whitespace differs: a source hard-wrap renders as one space, and a rendered block
  // may carry indentation the source never had. Match in folded space, report real offsets.
  const doc = normalizeWithMap(text);
  for (const candidate of [quote.exact, flattenInlineMarkdown(quote.exact)]) {
    const needle = normalizeWithMap(candidate).normalized;
    const hits = allIndexesOf(doc.normalized, needle);
    if (hits.length === 0) continue;
    const mapped = hits.map((at) => ({
      start: doc.map[at],
      // The map holds the index of each kept character, so the end is one past the last one.
      end: doc.map[at + needle.length - 1] + 1,
    }));
    if (mapped.length === 1) return mapped[0];
    const narrowed = narrowByContext(text, mapped, quote);
    if (narrowed) return narrowed;
  }
  return null;
}

function disambiguate(text, hits, length, quote) {
  if (hits.length === 0) return null;
  const ranges = hits.map((at) => ({ start: at, end: at + length }));
  if (ranges.length === 1) return ranges[0];
  return narrowByContext(text, ranges, quote);
}

/** Picks the one candidate whose surrounding text matches the session's prefix/suffix. Returns
 * null unless exactly one survives — two survivors is still ambiguity. */
function narrowByContext(text, ranges, quote) {
  const prefix = typeof quote.prefix === "string" ? quote.prefix.trim() : "";
  const suffix = typeof quote.suffix === "string" ? quote.suffix.trim() : "";
  if (!prefix && !suffix) return null;
  const survivors = ranges.filter((range) => {
    const before = text.slice(Math.max(0, range.start - prefix.length - 8), range.start);
    const after = text.slice(range.end, range.end + suffix.length + 8);
    return (!prefix || before.includes(prefix.slice(-24))) && (!suffix || after.includes(suffix.slice(0, 24)));
  });
  return survivors.length === 1 ? survivors[0] : null;
}

/** The requests that belong beside THIS artifact: anchored ones plus whole-artifact asks, oldest
 * first so the rail reads in the order the session asked. Approval requests are excluded — those
 * own the approval strip, and showing them twice would double-count what needs answering. */
export function requestsForArtifact(entries, artifactPath) {
  if (!artifactPath) return [];
  return (entries ?? [])
    .filter((entry) => entry.approval_mode !== true && (entry.target_path ?? entry.target) === artifactPath)
    .slice()
    .sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
}

/**
 * Names the request entries the margin actually holds. A non-empty message is the same boundary
 * the card and arrival logic use for a question; an entry without one is a pointer. Session
 * identity is deliberately absent: the request payload carries no verified requester id, and a
 * claimed label is not evidence that two entries came from the same session.
 */
export function agentRequestSummary(requests) {
  let questions = 0;
  let pointers = 0;
  for (const request of requests ?? []) {
    if (typeof request?.message === "string" && request.message.length > 0) questions += 1;
    else pointers += 1;
  }

  return [
    questions > 0 ? `${questions} ${questions === 1 ? "question" : "questions"}` : null,
    pointers > 0 ? `${pointers} ${pointers === 1 ? "pointer" : "pointers"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** A request that carries a question. A question holds its session until it is answered; a
 * pointer ("look here") does not, and the two are treated differently everywhere downstream. */
export function isQuestion(entry) {
  return (
    Boolean(entry) && entry.approval_mode !== true && typeof entry.message === "string" && entry.message.length > 0
  );
}

/** Every open question in the inbox, oldest first. The order is the order they are offered in:
 * the session that has waited longest is the one the reader is pointed to first (#308). */
export function openQuestions(entries) {
  return (entries ?? [])
    .filter(isQuestion)
    .slice()
    .sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
}

/**
 * The requests that arrived since the last look.
 *
 * This used to choose ONE request and pull the workbench to it. #308 removed that: glosa never
 * moves the reader, and an arrival now does two smaller things instead, neither of which touches
 * their place — it is announced, and its mark draws itself in once. Whether a question needs the
 * "Go to it" notice is NOT decided here: that is derived from what is open and where the reader
 * is, so questions already waiting on the first load get one too. This function only answers
 * "what is new", and the first load is by definition not news.
 *
 * @param {Set<string>} seenIds ids observed on the previous read
 * @param {Array<any>} entries the inbox as it stands now
 * @param {{ firstLoad?: boolean }} [options]
 */
export function selectArrivals(seenIds, entries, { firstLoad = false } = {}) {
  if (firstLoad) return [];
  return (entries ?? [])
    .filter((entry) => entry && !seenIds.has(entry.id) && entry.approval_mode !== true)
    .slice()
    .sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
}

/**
 * Folds a range's client rects into one box per rendered line. A tab sits level with the first.
 *
 * `Range.getClientRects()` returns a rect per inline box, so a sentence crossing a `<strong>`
 * yields three rects on one line, and some engines add a zero-width rect at a wrap. Lines are
 * told apart by their vertical centre, which survives the different heights inline boxes have.
 *
 * @param {Array<{left:number,right:number,top:number,bottom:number}>} rects
 * @returns {Array<{left:number,right:number,top:number,bottom:number}>} top to bottom
 */
export function lineBoxes(rects, tolerance = 6) {
  const lines = [];
  for (const rect of rects ?? []) {
    if (!rect || rect.right - rect.left < 0.5 || rect.bottom - rect.top < 0.5) continue;
    const mid = (rect.top + rect.bottom) / 2;
    const line = lines.find((candidate) => Math.abs(candidate.mid - mid) <= tolerance);
    if (line) {
      line.left = Math.min(line.left, rect.left);
      line.right = Math.max(line.right, rect.right);
      line.top = Math.min(line.top, rect.top);
      line.bottom = Math.max(line.bottom, rect.bottom);
    } else {
      lines.push({ mid, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
    }
  }
  return lines.sort((a, b) => a.top - b.top).map(({ left, right, top, bottom }) => ({ left, right, top, bottom }));
}

/**
 * Folds the vertical spans of a session's marks into the brackets that draw them.
 *
 * A mark is drawn at the level of the block, in the gutter, because an outline around words that
 * start and stop mid-line has only the line's leading to live in: it ran through the underline on
 * the line above and its label sat on that line's words. The block is the unit the eye returns to.
 * Two requests whose blocks overlap or touch share one bracket (a paragraph asked about twice is
 * still one paragraph); each keeps its own tab. Spans come back top to bottom, each with the
 * indexes of the requests it holds, in the order those were given.
 *
 * @param {Array<{top:number,bottom:number}>} spans one per request, in any order
 * @returns {Array<{top:number,bottom:number,members:number[]}>}
 */
export function mergeSpans(spans) {
  const order = (spans ?? [])
    .map((span, index) => ({ ...span, index }))
    .filter((span) => Number.isFinite(span.top) && Number.isFinite(span.bottom) && span.bottom > span.top)
    .sort((a, b) => a.top - b.top || a.index - b.index);
  const merged = [];
  for (const span of order) {
    const last = merged[merged.length - 1];
    if (last && span.top <= last.bottom) {
      last.bottom = Math.max(last.bottom, span.bottom);
      last.members.push(span.index);
    } else {
      merged.push({ top: span.top, bottom: span.bottom, members: [span.index] });
    }
  }
  for (const span of merged) span.members.sort((a, b) => a - b);
  return merged;
}

/**
 * The bracket beside a block, as an SVG path: `[`, with the ticks turned toward the text, so it
 * reads as a proofreader's mark in the margin rather than a stripe down the page.
 *
 * Returns `null` when there is no height to span, so a caller never paints an empty path.
 */
export function bracketPath(top, bottom, x, { tick = 6 } = {}) {
  if (![top, bottom, x].every(Number.isFinite) || bottom <= top) return null;
  const r = (n) => Math.round(n * 10) / 10;
  return `M${r(x + tick)},${r(top)}H${r(x)}V${r(bottom)}H${r(x + tick)}`;
}

/**
 * Where each tab goes on a bracket: level with the line its words start on, pushed down just far
 * enough that two tabs never overlap. Two questions that start on the same line would otherwise
 * stack into one tab the reader could not tell apart, or click past.
 *
 * @param {number[]} wanted each tab's preferred top, in any order
 * @returns {number[]} the tops to use, in the same order
 */
export function stackTabs(wanted, { size = 20, gap = 4 } = {}) {
  const out = new Array(wanted.length);
  let floor = Number.NEGATIVE_INFINITY;
  for (const { top, index } of wanted.map((top, index) => ({ top, index })).sort((a, b) => a.top - b.top)) {
    out[index] = Math.max(top, floor);
    floor = out[index] + size + gap;
  }
  return out;
}

/**
 * How a session is named on a card.
 *
 * Two halves with different standing, and the card must not blur them: the provider is derived
 * from a session binding glosa verified, while the label is a string the session sent about
 * itself. Invariant 3 forbids presenting the second as if it carried the weight of the first, so
 * they are returned separately and styled separately — never concatenated into one name.
 */
export function agentIdentity(request, { providerName = "An agent session" } = {}) {
  const label = typeof request?.agent_label === "string" ? request.agent_label.trim() : "";
  return { provider: providerName, claimed: label.length > 0 ? label : null };
}

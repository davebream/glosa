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
 * Folds a range's client rects into one box per rendered line.
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
 * The outline of a passage, as an SVG path: the shape a text selection has.
 *
 * One line is a rectangle around the words. Several lines make a stepped band — the first line
 * runs from the first word to the column's right edge, the middle lines span the column, the last
 * runs from the column's left edge to the last word. Spanning the column rather than each line's
 * ragged end is what makes it read as ONE band instead of a stack of boxes.
 *
 * Returns `null` when there is nothing to draw, so a caller never paints an empty path.
 *
 * @param {Array<{left:number,right:number,top:number,bottom:number}>} lines from `lineBoxes`
 * @param {{left:number,right:number}} column the text column the passage sits in
 */
export function bandPath(lines, column, { padX = 5, padY = 1 } = {}) {
  if (!Array.isArray(lines) || lines.length === 0) return null;
  const r = (n) => Math.round(n * 10) / 10;
  const first = lines[0];
  const last = lines[lines.length - 1];
  const top = r(first.top - padY);
  const bottom = r(last.bottom + padY);
  if (lines.length === 1) {
    return `M${r(first.left - padX)},${top}H${r(first.right + padX)}V${bottom}H${r(first.left - padX)}Z`;
  }
  const colLeft = r(Math.min(column?.left ?? first.left, ...lines.map((l) => l.left)) - padX);
  const colRight = r(Math.max(column?.right ?? first.right, ...lines.map((l) => l.right)) + padX);
  const startX = r(first.left - padX);
  const endX = r(last.right + padX);
  // Clockwise from the first word: across the top, down the right edge to the last line, in to
  // the last word, along the bottom, up the left edge to the first line, in to the first word.
  return `M${startX},${top}H${colRight}V${r(last.top)}H${endX}V${bottom}H${colLeft}V${r(first.bottom)}H${startX}Z`;
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

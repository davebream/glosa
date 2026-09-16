// SPDX-License-Identifier: Apache-2.0
// @glosa/spa — the pure three-way merge behind Keep mine (#182). `threeWayMerge(base, mine,
// theirs)` splices the writer's edited blocks and the disk's edited blocks onto their shared
// base, so a block neither side touched keeps disk's exact bytes and a block only the writer
// touched keeps the writer's exact bytes — never re-serialized, just sliced verbatim from
// whichever side's own markdown text owns it. That is what makes this safe for the source
// face's non-canonical spelling (alternate list markers, emphasis spelling, blank lines): the
// classification below is BYTE-aware (does `mine`'s block still read like `base`'s bytes?), not
// only tree-aware, so a respelling that leaves the parsed tree equal to `base` is still
// recognised as the writer's own change instead of being silently discarded.
//
// Never automatic (contract D1): this module only proposes a merge and reports what it did;
// artifact-pane.js writes the result ONLY from the writer's explicit Keep mine.
//
// The base is untrusted input, not assumed correct: callers must first verify
// `sha256(base) === baselineSha` (D2/D3) and pass `null` when it cannot be verified, in which
// case every differing block is a conflict and mine wins everywhere (D3) — nothing of theirs is
// merged silently.
//
// R3/R6: assembly follows a SINGLE base-indexed plan, in THEIRS' order — a proven disk-side move
// keeps its moved position, and a base range one side replaces as a WIDER run than the other
// side touched still surfaces both sides' independent, untouched members (see `resolveRun`) —
// rather than the two sides being classified and iterated independently in base order, which lets
// a move fall back to its pre-move slot and lets a wider run's shared bookkeeping drop content
// only one side actually touched.
//
// Talks to the daemon through NOTHING — pure text-in, text-out, same discipline as
// rich-editor.js (see test/import-boundary.test.ts).
import { blockLayout, pairUnchangedBlocks, parseMarkdown } from "./rich-editor.js";

const SEPARATOR = "\n\n";

/** `source`'s block `index`, as exact bytes — no serialization, ever. */
function blockBody(source, layout, index) {
  const block = layout.blocks[index];
  return source.slice(block.start, block.end);
}

/** `source`'s blocks `[start, end)` as one exact run of bytes, blocks and all — including
 * whatever separator bytes originally sat BETWEEN those blocks in `source`, verbatim, since this
 * is a direct substring of that side's own document. Only the boundary OUTSIDE the run (against
 * its neighbours in the final assembly) is a separate decision (see `classifyGap`). */
function groupBody(source, layout, start, end) {
  return source.slice(layout.blocks[start].start, layout.blocks[end - 1].end);
}

/**
 * Per base-block index `0..baseNodes.length`, what `other` (mine or theirs) did to it, relative
 * to `base`:
 *
 * - `kept`: `other` holds a tree-equal block SOMEWHERE (`otherIndex`) — including a proven move,
 *   for free, since `sources` already resolved that identity (see `pairUnchangedBlocks`).
 *   `changed` is true when its BYTES still differ from `base`'s (a respelling the tree can't
 *   see — R2).
 * - `changed`: a run of one or more base blocks `other` has no tree-equal counterpart for,
 *   replaced by `other`'s own run `[otherStart, otherEnd)`. `baseStart`/`baseEnd` name the base
 *   range this run covers, so a caller can find every entry sharing this group without parsing
 *   `groupKey`.
 * - `deleted`: a run `other` has no tree-equal counterpart for AND owns no replacement content.
 *
 * `ambiguous` marks a run whose replacement window (as bounded by its neighbouring `kept`
 * anchors) still contains an `other` index this SAME alignment resolved as `kept` elsewhere —
 * i.e. a moved block landing inside what would otherwise read as a plain run. D5: unprovable
 * identity for that run, treated as a conflict below rather than guessed at.
 */
function baseStatus(baseNodes, otherNodesLength, sources, baseBody, otherBody) {
  const n = baseNodes.length;
  const keptOf = new Array(n).fill(-1);
  sources.forEach((baseIndex, otherIndex) => {
    if (baseIndex !== -1) keptOf[baseIndex] = otherIndex;
  });
  const status = new Array(n).fill(null);
  for (let i = 0; i < n; i += 1) {
    if (keptOf[i] === -1) continue;
    const otherIndex = keptOf[i];
    status[i] = { type: "kept", otherIndex, changed: otherBody(otherIndex) !== baseBody(i) };
  }
  let i = 0;
  while (i < n) {
    if (status[i]) {
      i += 1;
      continue;
    }
    let end = i;
    while (end < n && !status[end]) end += 1;
    const prevOther = i > 0 && status[i - 1] ? status[i - 1].otherIndex : -1;
    const nextOther = end < n && status[end] ? status[end].otherIndex : otherNodesLength;
    const otherStart = prevOther + 1;
    const otherEnd = nextOther;
    let ambiguous = false;
    for (let k = otherStart; k < otherEnd; k += 1) if (sources[k] !== -1) ambiguous = true;
    const groupKey = `${i}-${end}`;
    const entry =
      otherEnd > otherStart
        ? { type: "changed", groupKey, baseStart: i, baseEnd: end, otherStart, otherEnd, ambiguous }
        : { type: "deleted", groupKey, baseStart: i, baseEnd: end, otherStart, otherEnd, ambiguous };
    for (let k = i; k < end; k += 1) status[k] = entry;
    i = end;
  }
  return status;
}

/** Every run of `other` blocks with no base origin at all (`sources[j] === -1`) that sits between
 * two ADJACENT kept anchors — i.e. a genuine, zero-base-length insertion, anchored on the base
 * index it was typed or inserted immediately after (`-1` for "before every base block"). A run
 * whose neighbouring kept anchors are NOT adjacent in base terms is not an insertion at all: it is
 * the replacement content for the base range between them, and `baseStatus` above already
 * accounts for it as a `changed`/`deleted` run. Counting it here too would write it twice. */
function insertionsByAnchor(otherNodesLength, sources, baseLength) {
  const byAnchor = new Map();
  let anchor = -1;
  let runStart = -1;
  const flush = (end, nextAnchor) => {
    if (runStart === -1) return;
    if (nextAnchor === anchor + 1) byAnchor.set(anchor, { start: runStart, end });
    runStart = -1;
  };
  for (let j = 0; j < otherNodesLength; j += 1) {
    if (sources[j] !== -1) {
      flush(j, sources[j]);
      anchor = sources[j];
    } else if (runStart === -1) {
      runStart = j;
    }
  }
  flush(otherNodesLength, baseLength);
  return byAnchor;
}

/** `null` for a `kept` entry (it occupies no run range of its own); `{start, end}` — the BASE
 * index range — for a `changed`/`deleted` entry. Used to grow a unified run (see
 * `buildUnifiedRuns`) to cover BOTH sides' full group extent whenever they overlap. */
function groupRangeOf(entry) {
  return entry.type === "kept" ? null : { start: entry.baseStart, end: entry.baseEnd };
}

/**
 * R3/R6: ONE partition of `0..n` into base-indexed runs, each independently resolved once — never
 * two independently-iterated per-side groupings whose shared bookkeeping can drop a member only
 * one side actually touched (the asymmetric-run bug this replaces: mine changes base block A
 * alone while theirs replaces the WIDER run A+B — of the two independent per-side groupings, base
 * block B is "kept, unchanged" for mine and inside theirs' run; resolving A and B from two
 * different groupings, marking whichever grouping "already emitted" at A, silently drops B at the
 * index where only theirs' — already-consumed — grouping would have spoken for it).
 *
 * A run here is the transitive closure of every group (on EITHER side) that overlaps a touched
 * base index: starting from one touched index, the run grows to cover the full base range of any
 * group — mine's or theirs' — that reaches into it, and then re-checks whether THAT wider range
 * now reaches into a further group, until stable. An index neither side changed becomes its own
 * trivial, untouched run of one.
 */
function buildUnifiedRuns(n, mineStatus, theirsStatus) {
  const runs = [];
  let i = 0;
  while (i < n) {
    const mineUntouched = mineStatus[i].type === "kept" && !mineStatus[i].changed;
    const theirsUntouched = theirsStatus[i].type === "kept" && !theirsStatus[i].changed;
    if (mineUntouched && theirsUntouched) {
      runs.push({ start: i, end: i + 1 });
      i += 1;
      continue;
    }
    let start = i;
    let end = i + 1;
    let grown = true;
    while (grown) {
      grown = false;
      for (let k = start; k < end; k += 1) {
        for (const g of [groupRangeOf(mineStatus[k]), groupRangeOf(theirsStatus[k])]) {
          if (!g) continue;
          if (g.start < start) {
            start = g.start;
            grown = true;
          }
          if (g.end > end) {
            end = g.end;
            grown = true;
          }
        }
      }
    }
    runs.push({ start, end });
    i = end;
  }
  return runs;
}

function hasTouched(status, run) {
  for (let k = run.start; k < run.end; k += 1) {
    if (!(status[k].type === "kept" && !status[k].changed)) return true;
  }
  return false;
}

function hasAmbiguous(status, run) {
  for (let k = run.start; k < run.end; k += 1) if (status[k].ambiguous) return true;
  return false;
}

/** `side`'s OWN reconstruction of base range `[run.start, run.end)`: an unchanged member
 * contributes its own (that side's) bytes at that block — `sourceBody`'s whole point, since a
 * `kept` entry with `changed: true` is a byte-only respelling (R2) and must NOT fall back to
 * base's bytes — a `changed`/`deleted` member contributes its own group's bytes (or nothing) ONCE
 * and the walk skips straight to that group's own `baseEnd`, so a wider run pulled in by the
 * OTHER side's group never re-visits or duplicates this side's narrower one. Returns the pieces
 * joined with the plain separator — intra-run boundaries are not this run's subject; only the
 * OUTER edges against this run's neighbours in the final assembly are (see `classifyGap`). */
function reconstructSide(status, run, sourceBody, groupTextOf) {
  const pieces = [];
  let k = run.start;
  while (k < run.end) {
    const entry = status[k];
    if (entry.type === "kept") {
      pieces.push(sourceBody(entry.otherIndex));
      k += 1;
    } else if (entry.type === "deleted") {
      k = entry.baseEnd;
    } else {
      pieces.push(groupTextOf(entry));
      k = entry.baseEnd;
    }
  }
  return pieces;
}

/**
 * Resolves one unified run to `{text, side, mergedEntry, conflictEntry}`. `side` is which side's
 * bytes `text` is made of — `"mine"`, `"theirs"`, or `"base"` (both sides agree; base's own bytes,
 * identical to both) — used only to pick the OUTER document framing when this run sits at either
 * end of the assembled output (see `threeWayMerge`'s own tail).
 *
 * D4–D6: untouched-by-both is neither merged nor conflicted, uncontested single-side changes are
 * `merged` (no fight to report), and a run either side's identity within is unprovable (D5) is
 * ALWAYS a conflict — regardless of whether the other side touched it at all, since "unprovable"
 * already means this run's own shape cannot be trusted enough to apply silently.
 */
function resolveRun(run, mineStatus, theirsStatus, mine, theirs, mineLayout, theirsLayout) {
  const mineBody = (j) => blockBody(mine, mineLayout, j);
  const theirsBody = (k) => blockBody(theirs, theirsLayout, k);
  const mineGroupText = (entry) => groupBody(mine, mineLayout, entry.otherStart, entry.otherEnd);
  const theirsGroupText = (entry) => groupBody(theirs, theirsLayout, entry.otherStart, entry.otherEnd);

  const mineTouched = hasTouched(mineStatus, run);
  const theirsTouched = hasTouched(theirsStatus, run);
  const ambiguous = hasAmbiguous(mineStatus, run) || hasAmbiguous(theirsStatus, run);

  if (!mineTouched && !theirsTouched) {
    const pieces = reconstructSide(theirsStatus, run, theirsBody, theirsGroupText);
    return { text: pieces.join(SEPARATOR), side: "base", mergedEntry: null, conflictEntry: null };
  }

  const minePieces = reconstructSide(mineStatus, run, mineBody, mineGroupText);
  if ((mineTouched && !theirsTouched) || (mineTouched && ambiguous && !theirsTouched)) {
    return {
      text: minePieces.join(SEPARATOR),
      side: "mine",
      mergedEntry: { index: run.start, kind: "mine-changed" },
      conflictEntry: null,
    };
  }
  const theirsPieces = reconstructSide(theirsStatus, run, theirsBody, theirsGroupText);
  if (!mineTouched && theirsTouched && !ambiguous) {
    return {
      text: theirsPieces.join(SEPARATOR),
      side: "theirs",
      mergedEntry: { index: run.start, kind: "theirs-changed" },
      conflictEntry: null,
    };
  }
  // Both touched, or identity within this run is unprovable (D5) — mine wins either way (D6).
  const sameEdit = !ambiguous && minePieces.join(SEPARATOR) === theirsPieces.join(SEPARATOR);
  if (sameEdit) {
    return {
      text: minePieces.join(SEPARATOR),
      side: "mine",
      mergedEntry: { index: run.start, kind: "same-edit" },
      conflictEntry: null,
    };
  }
  return {
    text: minePieces.join(SEPARATOR),
    side: "mine",
    mergedEntry: null,
    conflictEntry: {
      index: run.start,
      mine: minePieces.join(SEPARATOR),
      theirs: theirsPieces.length ? theirsPieces.join(SEPARATOR) : null,
    },
  };
}

/** The other-side index right AFTER `entry`'s own content ends — its `otherIndex` when kept
 * (wherever that landed), or the last member of its own replacement run when `changed`. `null`
 * for `deleted` (no content of its own to anchor "after" to) — the caller falls back to the plain
 * separator rather than guessing a position for bytes that no longer exist there. */
function otherIndexAfter(entry) {
  if (entry.type === "kept") return entry.otherIndex;
  if (entry.type === "changed") return entry.otherEnd - 1;
  return null;
}

/** The other-side index right BEFORE `entry`'s own content begins — symmetric to
 * `otherIndexAfter`. */
function otherIndexBefore(entry) {
  if (entry.type === "kept") return entry.otherIndex;
  if (entry.type === "changed") return entry.otherStart;
  return null;
}

/**
 * R2/R6: the gap's identity is provable only when BOTH neighbouring base blocks have OWN content
 * on this side (kept — tree-equal, wherever it landed — or changed — replaced in place) AND are
 * directly adjacent in this side's OWN sequence — nothing else (an insertion, a moved-in block, or
 * a deleted neighbour with no position of its own) sits between them. `left`/`right` are base
 * indices, `-1` meaning "before every base block" and `n` meaning "after every base block".
 * Returns `null` when the identity is unprovable — the caller falls back to the plain separator
 * rather than guessing whose gap bytes belong here.
 */
function gapBytes(status, left, right, n, source, layout, otherLength) {
  const leftOther = left === -1 ? -1 : otherIndexAfter(status[left]);
  const rightOther = right === n ? otherLength : otherIndexBefore(status[right]);
  if (leftOther === null || rightOther === null) return null;
  if (rightOther !== leftOther + 1) return null;
  const startByte = leftOther === -1 ? 0 : layout.blocks[leftOther].end;
  const endByte = rightOther === otherLength ? source.length : layout.blocks[rightOther].start;
  return source.slice(startByte, endByte);
}

/** D3: no base, or a base that failed its sha check — every block mine and theirs disagree on is
 * a conflict, mine wins everywhere, and nothing of theirs is merged silently. The safest thing a
 * merge can write without a trustworthy base is the writer's own document, unchanged.
 *
 * Reports ONE conflict PER DIFFERING BLOCK, positionally by index, rather than collapsing the
 * whole document into one conflict entry — D3 says "every block that differs" and the preview
 * (D9) needs per-block identities to list, not just a fact that something, somewhere, disagreed.
 * There is no base to align either side against here, so position is the only identity available:
 * block `k` of mine is compared against block `k` of theirs, and a block existing on only one side
 * (the two documents have different block counts) differs from "nothing" trivially. When either
 * side's own block layout disagrees with its own parse (the same scannability guard the aligned
 * path uses), identity is unprovable for the whole document and it is reported as a single
 * unprovable run — consistent with D5 rather than inventing a finer-grained comparison than the
 * bytes actually support. */
function baseUnavailableMerge(mine, theirs, mineReport) {
  const conflicts = [];
  if (mine !== theirs) {
    const mineLayout = blockLayout(mine);
    const theirsLayout = blockLayout(theirs);
    const mineNodes = parseMarkdown(mine).content.content;
    const theirsNodes = parseMarkdown(theirs).content.content;
    if (mineLayout.blocks.length === mineNodes.length && theirsLayout.blocks.length === theirsNodes.length) {
      const count = Math.max(mineLayout.blocks.length, theirsLayout.blocks.length);
      for (let index = 0; index < count; index += 1) {
        const mineText = index < mineLayout.blocks.length ? blockBody(mine, mineLayout, index) : null;
        const theirsText = index < theirsLayout.blocks.length ? blockBody(theirs, theirsLayout, index) : null;
        if (mineText !== theirsText) conflicts.push({ index, mine: mineText, theirs: theirsText });
      }
      // The regions BETWEEN and AROUND the blocks are source too — a link-reference definition or a
      // blank-line run parked there is content, not decoration. Without a base there is nothing to
      // attribute them to, so every differing region is a conflict mine wins, reported rather than
      // discarded with the rest of theirs (review round 6).
      const regionAt = (source, layout, index) => {
        if (index === 0) return layout.blocks.length ? source.slice(0, layout.blocks[0].start) : source;
        if (index > layout.blocks.length) return "";
        const start = layout.blocks[index - 1].end;
        const end = index === layout.blocks.length ? source.length : layout.blocks[index].start;
        return source.slice(start, end);
      };
      const regionCount = Math.max(mineLayout.blocks.length, theirsLayout.blocks.length) + 1;
      for (let index = 0; index < regionCount; index += 1) {
        const mineRegion = regionAt(mine, mineLayout, index);
        const theirsRegion = regionAt(theirs, theirsLayout, index);
        if (mineRegion === theirsRegion) continue;
        const region = index === 0 ? "leading" : index === regionCount - 1 ? "trailing" : "separator";
        conflicts.push({ index: index === 0 ? null : index - 1, region, mine: mineRegion, theirs: theirsRegion });
      }
    } else if (!blockLayout(mine).blocks.length && !blockLayout(theirs).blocks.length) {
      // Neither side parsed a block at all: this is one raw region, not a block whose identity
      // could not be proven (review round 7).
      conflicts.push({ index: null, region: "document", mine, theirs });
    } else {
      conflicts.push({ index: null, mine, theirs, reason: "unprovable-identity" });
    }
  }
  return {
    text: mine,
    merged: [],
    conflicts,
    baseAvailable: false,
    collateral: mineReport.collateral,
    degraded: mineReport.degraded,
  };
}

/**
 * `(base, mine, theirs) → {text, merged, conflicts, baseAvailable, collateral, degraded}`.
 *
 * `base` is the text the writer opened (`null` when unavailable or sha-mismatched — D3). `mine`
 * and `theirs` are plain markdown strings — the writer's current save text (already through the
 * rich editor's own splice if that is the live face; #186's collateral for THAT step is passed
 * through via `mineReport` rather than recomputed here, since this function never re-serializes
 * anything of mine's own) and the fresh disk bytes.
 *
 * `merged` and `conflicts` describe what happened at each surviving base run, for the preview
 * (D9): `merged` entries are `{index, kind}` for a change accepted without a fight; `conflicts`
 * entries are `{index, mine, theirs}` for a run resolved by mine winning (D6) — `theirs` is
 * `null` where the conflict was a deletion rather than a competing edit.
 *
 * Assembly follows theirs' own order (R3): every surviving run and kept block is placed at
 * theirs' resolved position (its `otherIndex`, or its group's `otherStart` for a run with no
 * tree-equal counterpart) — so a block theirs provably moved keeps its moved position even when
 * mine also edited it, and a run neither side can place in theirs' own sequence (theirs deleted
 * it) falls back to its base-anchored slot, right where its surviving neighbours put it.
 *
 * Every block this resolves is either base's own bytes, mine's own bytes, or theirs' own bytes,
 * sliced verbatim — never reassembled through the ProseMirror serializer — so nothing this
 * function does can introduce new collateral of its own; `collateral`/`degraded` in the result
 * are exactly `mineReport`'s, carried through so `keepMine` can still ask about #186 (R4).
 *
 * @param {string | null | undefined} base
 * @param {string} mine
 * @param {string} theirs
 * @param {{ collateral: Array<{ original: string, faithful: string, written: string }>, degraded: string | boolean }} [mineReport]
 */
export function threeWayMerge(base, mine, theirs, mineReport = { collateral: [], degraded: false }) {
  if (base === null || base === undefined) return baseUnavailableMerge(mine, theirs, mineReport);
  if (base === mine && base === theirs) {
    return { text: base, merged: [], conflicts: [], baseAvailable: true, collateral: [], degraded: false };
  }

  const baseDoc = parseMarkdown(base);
  const mineDoc = parseMarkdown(mine);
  const theirsDoc = parseMarkdown(theirs);

  const baseLayout = blockLayout(base);
  const mineLayout = blockLayout(mine);
  const theirsLayout = blockLayout(theirs);
  // The schema requires at least one node (an empty document parses to one empty paragraph, per
  // rich-editor.js's own `isBlankDoc`), while `blockLayout` reports zero block-level tokens for
  // blank source — a mismatch that is otherwise indistinguishable from a genuine scannability
  // failure (F-7: without this, "the only block was deleted, leaving an empty file" always fell
  // through to the base-unavailable path instead of resolving as an ordinary deletion). Treat a
  // blank side as having no nodes at all, matching its own zero-block layout.
  const isBlankDoc = (doc) => doc.childCount === 0 || (doc.childCount === 1 && doc.firstChild.content.size === 0);
  const baseNodes = isBlankDoc(baseDoc) && baseLayout.blocks.length === 0 ? [] : baseDoc.content.content;
  const mineNodes = isBlankDoc(mineDoc) && mineLayout.blocks.length === 0 ? [] : mineDoc.content.content;
  const theirsNodes = isBlankDoc(theirsDoc) && theirsLayout.blocks.length === 0 ? [] : theirsDoc.content.content;
  if (
    baseLayout.blocks.length !== baseNodes.length ||
    mineLayout.blocks.length !== mineNodes.length ||
    theirsLayout.blocks.length !== theirsNodes.length
  ) {
    return baseUnavailableMerge(mine, theirs, mineReport);
  }

  const mineAlign = pairUnchangedBlocks(baseNodes, mineNodes);
  const theirsAlign = pairUnchangedBlocks(baseNodes, theirsNodes);
  if (!mineAlign || !theirsAlign) return baseUnavailableMerge(mine, theirs, mineReport);

  const baseBody = (i) => blockBody(base, baseLayout, i);
  const mineBody = (j) => blockBody(mine, mineLayout, j);
  const theirsBody = (k) => blockBody(theirs, theirsLayout, k);

  const n = baseNodes.length;
  const mineStatus = baseStatus(baseNodes, mineNodes.length, mineAlign.sources, baseBody, mineBody);
  const theirsStatus = baseStatus(baseNodes, theirsNodes.length, theirsAlign.sources, baseBody, theirsBody);
  const mineInsertions = insertionsByAnchor(mineNodes.length, mineAlign.sources, n);
  const theirsInsertions = insertionsByAnchor(theirsNodes.length, theirsAlign.sources, n);

  const runs = buildUnifiedRuns(n, mineStatus, theirsStatus);
  const runContaining = new Array(n).fill(null);
  for (const run of runs) for (let k = run.start; k < run.end; k += 1) runContaining[k] = run;

  /** `run`'s position in THEIRS' own sequence — its first member's resolved `otherIndex` when
   * theirs kept it (tree-equal, wherever that landed — a proven move for free), or its group's
   * `otherStart` (theirs' own anchor for a run it replaced or deleted) otherwise. Integer, so it
   * sorts cleanly against every other run's and kept block's own theirs-position. */
  const theirsAnchorOfRun = (run) => {
    const first = theirsStatus[run.start];
    return first.type === "kept" ? first.otherIndex : first.otherStart;
  };

  const resolved = runs.map((run) => ({
    run,
    ...resolveRun(run, mineStatus, theirsStatus, mine, theirs, mineLayout, theirsLayout),
  }));

  const merged = [];
  const conflicts = [];
  const items = []; // {text, side, baseIndex: number|null, anchor: number}

  for (const { run, text, side, mergedEntry, conflictEntry } of resolved) {
    if (mergedEntry) merged.push(mergedEntry);
    if (conflictEntry) conflicts.push(conflictEntry);
    const isTrivialSingle = run.end - run.start === 1;
    items.push({
      text,
      side,
      baseIndex: isTrivialSingle ? run.start : null,
      anchor: theirsAnchorOfRun(run),
    });
  }

  // Insertions: anchored right after whichever run/kept-block owns their preceding base index
  // (or before everything, for anchor `-1`), and — R3/D4 — a colliding double-insertion at the
  // same base position is a conflict mine wins, reported once.
  const insertionAnchorKey = (baseAnchor) => {
    if (baseAnchor === -1) return -0.5;
    return theirsAnchorOfRun(runContaining[baseAnchor]) + 0.5;
  };
  const allAnchors = new Set([...mineInsertions.keys(), ...theirsInsertions.keys()]);
  for (const anchor of allAnchors) {
    const mineIns = mineInsertions.get(anchor);
    const theirsIns = theirsInsertions.get(anchor);
    const key = insertionAnchorKey(anchor);
    if (mineIns && theirsIns) {
      const mineText = groupBody(mine, mineLayout, mineIns.start, mineIns.end);
      const theirsText = groupBody(theirs, theirsLayout, theirsIns.start, theirsIns.end);
      conflicts.push({ index: anchor, mine: mineText, theirs: theirsText });
      items.push({ text: mineText, side: "mine", baseIndex: null, anchor: key });
    } else if (mineIns) {
      const mineText = groupBody(mine, mineLayout, mineIns.start, mineIns.end);
      merged.push({ index: anchor, kind: "mine-inserted" });
      items.push({ text: mineText, side: "mine", baseIndex: null, anchor: key });
    } else if (theirsIns) {
      const theirsText = groupBody(theirs, theirsLayout, theirsIns.start, theirsIns.end);
      merged.push({ index: anchor, kind: "theirs-inserted" });
      items.push({ text: theirsText, side: "theirs", baseIndex: null, anchor: key });
    }
  }

  // A run or insertion that resolved to NOTHING (theirs deleted it, uncontested, or a `same-edit`
  // that happened to be blank) contributes no text and must not pin a separator on either side of
  // itself — the gap decision belongs to its surviving NEIGHBOURS, whatever they turn out to be.
  const survivors = items.filter((item) => item.text !== "");
  survivors.sort((a, b) => a.anchor - b.anchor);

  const layoutOf = (side) => (side === "mine" ? mineLayout : theirsLayout);
  const sourceOf = (side) => (side === "mine" ? mine : theirs);

  /** The gap between two ADJACENT base blocks, classified like a block (R2): mine's bytes win
   * wherever mine changed the gap, theirs' win where only theirs did, base's own bytes survive
   * where neither did. `null` (fall back to the plain separator) whenever either side's identity
   * for this EXACT gap cannot be proven — a move or insertion touching this boundary. */
  const classifiedGap = (left, right) => {
    const baseGap = base.slice(
      left === -1 ? 0 : baseLayout.blocks[left].end,
      right === n ? base.length : baseLayout.blocks[right].start,
    );
    const mineGap = gapBytes(mineStatus, left, right, n, mine, mineLayout, mineNodes.length);
    const theirsGap = gapBytes(theirsStatus, left, right, n, theirs, theirsLayout, theirsNodes.length);
    if (mineGap === null || theirsGap === null) return { bytes: null, provable: false };
    if (mineGap !== baseGap && theirsGap !== baseGap && mineGap !== theirsGap)
      // Both sides rewrote the same separator differently. Mine wins, as it does for a block, but
      // the writer is told rather than left to discover it in the saved bytes (D6).
      return { bytes: mineGap, provable: true, conflict: { mine: mineGap, theirs: theirsGap } };
    if (mineGap !== baseGap) return { bytes: mineGap, provable: true };
    if (theirsGap !== baseGap) return { bytes: theirsGap, provable: true };
    return { bytes: baseGap, provable: true };
  };

  /** A document whose every separator is already the plain blank line has no separator bytes to
   * lose: falling back to `SEPARATOR` at a boundary we cannot attribute reproduces exactly what
   * each side had there. Only when some side spells a separator differently — a blank-line run, a
   * CRLF convention, a reference definition parked between blocks — does an unattributable
   * boundary risk discarding one side's bytes, and that is what must be reported rather than
   * silently normalized (R2, review round 2 F-7). */
  const separatorsAreUniform = (source, layout) => {
    for (let index = 1; index < layout.blocks.length; index += 1) {
      if (source.slice(layout.blocks[index - 1].end, layout.blocks[index].start) !== SEPARATOR) return false;
    }
    return true;
  };
  const uniformEverywhere =
    separatorsAreUniform(base, baseLayout) &&
    separatorsAreUniform(mine, mineLayout) &&
    separatorsAreUniform(theirs, theirsLayout);

  let text = "";
  for (const [index, item] of survivors.entries()) {
    if (index > 0) {
      const prev = survivors[index - 1];
      let sep = null;
      let attributable = false;
      if (prev.baseIndex !== null && item.baseIndex !== null && item.baseIndex === prev.baseIndex + 1) {
        const decision = classifiedGap(prev.baseIndex, item.baseIndex);
        attributable = decision.provable;
        if (decision.provable) {
          sep = decision.bytes;
          if (decision.conflict) {
            conflicts.push({
              index: prev.baseIndex,
              region: "separator",
              mine: decision.conflict.mine,
              theirs: decision.conflict.theirs,
            });
          }
        }
      }
      // A boundary next to a move, an insertion or a multi-member run cannot be attributed to a
      // side. Emitting the plain separator there is only safe where every separator in play is
      // already that; otherwise the fallback may drop bytes one side wrote, so it is reported as a
      // conflict instead of disappearing quietly.
      if (!attributable && !uniformEverywhere) {
        conflicts.push({ index: prev.baseIndex, region: "separator", reason: "unprovable-separator", carried: null });
      }
      text += sep ?? SEPARATOR;
    }
    text += item.text;
  }

  // Document-edge framing is a region like any other (R2, review round 4 F-7): the bytes before
  // the first block and after the last are classified base-relatively, so a side that changed them
  // keeps its bytes and a side that did not cannot overwrite them by happening to own the boundary
  // block. A side with NO blocks frames nothing and holds no opinion — `null` keeps it out of the
  // comparison instead of letting "" read as a deliberate emptying.
  const edgeBytes = (source, layout, which) => {
    if (!layout.blocks.length) return null;
    return which === "leading"
      ? source.slice(0, layout.blocks[0].start)
      : source.slice(layout.blocks[layout.blocks.length - 1].end);
  };
  const classifiedEdge = (which) => {
    const baseEdge = edgeBytes(base, baseLayout, which);
    const mineEdge = edgeBytes(mine, mineLayout, which);
    const theirsEdge = edgeBytes(theirs, theirsLayout, which);
    const mineChanged = mineEdge !== null && mineEdge !== baseEdge;
    const theirsChanged = theirsEdge !== null && theirsEdge !== baseEdge;
    if (mineChanged && theirsChanged && mineEdge !== theirsEdge) {
      conflicts.push({ index: null, region: which, mine: mineEdge, theirs: theirsEdge });
      return mineEdge;
    }
    if (mineChanged) return mineEdge;
    if (theirsChanged) return theirsEdge;
    return baseEdge ?? mineEdge ?? theirsEdge ?? "";
  };
  // With nothing surviving, the document is empty and there is nowhere for framing to live — but a
  // side that deliberately changed an edge still loses those bytes, so say so instead of dropping
  // them in silence (review round 5). With survivors, the edges are classified like any region.
  const reportLostEdge = (which) => {
    const baseEdge = edgeBytes(base, baseLayout, which);
    const mineEdge = edgeBytes(mine, mineLayout, which);
    const theirsEdge = edgeBytes(theirs, theirsLayout, which);
    const changed = [mineEdge, theirsEdge].some((edge) => edge !== null && edge !== baseEdge);
    if (changed) conflicts.push({ index: null, region: which, mine: mineEdge, theirs: theirsEdge });
  };
  let leading = "";
  let trailing = "";
  // A document with no parsed blocks at all is one raw region: there is no block for the edge
  // classification to hang off, so compare the whole text base-relatively (review round 6).
  if (!baseLayout.blocks.length && !mineLayout.blocks.length && !theirsLayout.blocks.length) {
    const mineChanged = mine !== base;
    const theirsChanged = theirs !== base;
    if (mineChanged && theirsChanged && mine !== theirs)
      conflicts.push({ index: null, region: "document", mine, theirs });
    const text = mineChanged ? mine : theirsChanged ? theirs : base;
    return {
      text,
      merged,
      conflicts,
      baseAvailable: true,
      collateral: mineReport.collateral,
      degraded: mineReport.degraded,
    };
  }
  if (survivors.length) {
    leading = classifiedEdge("leading");
    trailing = classifiedEdge("trailing");
  } else {
    reportLostEdge("leading");
    reportLostEdge("trailing");
  }

  // A side whose whole document markdown parses as no block — a lone link-reference definition —
  // has no block for the aligner to place. Its bytes are reported ONLY when they are genuinely not
  // in the result: if the other side already carries the same change, nothing was lost and there is
  // nothing to say. The entry records a LOSS (`carried: false`) rather than a conflict mine wins,
  // because mine is exactly what did not survive here (review round 8).
  const assembled = leading + text + trailing;
  for (const [side, source, layout] of [
    ["mine", mine, mineLayout],
    ["theirs", theirs, theirsLayout],
  ]) {
    // A side that deleted everything holds no bytes to account for here: whether that deletion was
    // honoured is decided by the runs, and reported as a block conflict when it was not. This
    // accounting is for a side still holding real source no block parse claims.
    if (layout.blocks.length || source === base || source.trim() === "") continue;
    // Carriage is positional — these exact bytes ARE the result or sit at one of its edges — not a
    // substring search, so a coincidental occurrence elsewhere cannot hide a real loss (round 9).
    const carried = assembled === source || assembled.startsWith(source) || assembled.endsWith(source);
    if (carried) continue;
    conflicts.push({ index: null, region: "document", side, carried: false, dropped: source });
  }

  return {
    text: assembled,
    merged,
    conflicts,
    baseAvailable: true,
    collateral: mineReport.collateral,
    degraded: mineReport.degraded,
  };
}

// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — journal "tail" reads for the SSE stream (P3.2, A1 §8). Pure file reads, no
// mutation, and deliberately separate from replay.ts's `replayJournal`: that one quarantines and
// folds into `DerivedState`, which is a different job from what the SSE cursor space needs — the
// PHYSICAL LINE OFFSET of each line in the file (A1 §8.1: "sequence number is just its 0-based
// line offset"). A malformed/quarantined interior line still occupies its own physical offset
// forever (the journal is append-only, so its raw bytes never move) — this module skips it (no
// event to emit for it) but never reuses its index for a later, valid line, so sequence numbers
// stay stable across every replay/restart.
import { existsSync, readFileSync } from "node:fs";
import { journalPath } from "./paths.ts";
import type { JournalEvent } from "./journal.ts";

/** Same trailing-newline trim as replay.ts's `replayJournal` — a clean (or already
 * torn-tail-truncated) file ends in `"\n"`, so the last `split("\n")` element is `""`; drop it
 * rather than count it as a line. */
function effectiveLines(raw: string): string[] {
  if (raw.length === 0) return [];
  const lines = raw.split("\n");
  return lines.length > 0 && lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
}

/** The physical line count of the journal file right now — the SSE cursor space itself. A fresh
 * `WorkspaceBus` seeds its own `nextSequence` counter from this exact function right after
 * `reconcile()` (bus.ts), which is what makes a restarted daemon assign the SAME sequence number
 * to the same logical next-event as the crashed one: same bytes on disk -> same line count -> same
 * next id (A1 §8.2 case 4). */
export function countJournalLines(root: string): number {
  const path = journalPath(root);
  if (!existsSync(path)) return 0;
  return effectiveLines(readFileSync(path, "utf8")).length;
}

function tryParseEvent(line: string): JournalEvent | null {
  if (line.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  if (p.v !== 1 || typeof p.event !== "string" || typeof p.event_id !== "string") return null;
  return p as unknown as JournalEvent;
}

export interface JournalTailEntry {
  sequence: number;
  event: JournalEvent;
}

/** Every well-formed event at a physical line offset strictly greater than `sinceSeq` — the SSE
 * reconnect replay (A1 §8.2 case 3, "retained", which is every case in v1 since the journal never
 * rotates). `sinceSeq = -1` (the "nothing consumed yet" sentinel — matches `WorkspaceBus.
 * currentCursor()`'s empty-journal value) returns every line in the file from offset 0. A
 * malformed line at offset i is skipped (nothing to emit) without shifting any later line's
 * sequence number — see this module's docstring.
 *
 * Review fix: a `sinceSeq` below the `-1` sentinel (e.g. a malformed/out-of-range client cursor
 * that reached here despite stream.ts's own caller-side guard) used to compute a negative start
 * index, indexing the line array with `undefined` and throwing out of `tryParseEvent`. Clamped to
 * 0 here too, defense-in-depth: this function is safe to call with ANY integer `sinceSeq`,
 * regardless of what the caller validated. */
export function readJournalEventsSince(root: string, sinceSeq: number): JournalTailEntry[] {
  const path = journalPath(root);
  if (!existsSync(path)) return [];
  const lines = effectiveLines(readFileSync(path, "utf8"));
  const out: JournalTailEntry[] = [];
  const start = Math.max(sinceSeq + 1, 0);
  for (let i = start; i < lines.length; i++) {
    const event = tryParseEvent(lines[i] as string);
    if (event) out.push({ sequence: i, event });
  }
  return out;
}

// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — passive, read-only journal folds shared by HTTP status/list handlers, the
// workspace-index GC pending-work guard, and the orphaned-home-state scanner (issue #79).
// Deliberately NOT `WorkspaceBus`/`reconcileWorkspace`: those self-heal and checkpoint (real
// writes, incl. spawning git), which would give a plain GET — or a GC pass — write side effects.
// This just parses whatever's already durably on disk and folds it with the same production
// reducer (`lifecycleReducer`); a malformed line is silently skipped here rather than
// quarantined; the durable quarantine still happens the first time any WRITE path reconciles the
// workspace for real.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkspaceTarget } from "../workspace.ts";
import type { JournalEvent } from "./journal.ts";
import { isTerminal, lifecycleReducer } from "./lifecycle.ts";
import { journalPath } from "./paths.ts";
import { createEmptyState, type DerivedState, foldEvents } from "./replay.ts";

export interface JournalPeek {
  state: DerivedState;
  createdAt: Map<string, string>;
}

/** Fold a workspace's journal read-only (empty state when no journal exists). */
export function peekJournal(root: WorkspaceTarget): JournalPeek {
  return peekJournalFile(journalPath(root));
}

/** Same fold, addressed by a raw bus directory instead of a workspace target — for callers that
 * hold only a bus path (the orphaned `~/.glosa/state/<id>` scanner, redirected-bus GC checks). */
export function peekJournalAt(busDir: string): JournalPeek {
  return peekJournalFile(join(busDir, "journal.ndjson"));
}

function peekJournalFile(path: string): JournalPeek {
  const createdAt = new Map<string, string>();
  if (!existsSync(path)) return { state: createEmptyState(), createdAt };

  const raw = readFileSync(path, "utf8");
  const events: JournalEvent[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // not this read-only peek's job to quarantine — see module docstring
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const p = parsed as Record<string, unknown>;
    if (p.v !== 1 || typeof p.event !== "string" || typeof p.event_id !== "string") continue;
    const event = p as unknown as JournalEvent;
    events.push(event);
    if (event.event === "entry_created" && typeof event.entry === "string" && !createdAt.has(event.entry)) {
      createdAt.set(event.entry, event.at);
    }
  }
  return { state: foldEvents(events, lifecycleReducer), createdAt };
}

/** Journal-derived count of non-terminal (pending) entries — the "user work still parked here"
 * signal. The journal is the single source of truth (A4); inbox `status` fields are frozen at
 * write time and never consulted. */
export function pendingCount(state: DerivedState): number {
  return Object.values(state.entries).filter((entry) => {
    const kind = entry.kind === "attention" ? "attention" : "common";
    return !isTerminal(kind, entry.status);
  }).length;
}

export function hasOpenAttention(state: DerivedState): boolean {
  return Object.values(state.entries).some((e) => e.kind === "attention" && !isTerminal("attention", e.status));
}

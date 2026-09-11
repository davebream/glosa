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
import { isExternalEditEntry } from "./external-edit.ts";
import { readInboxEntry } from "./inbox.ts";
import type { JournalEvent } from "./journal.ts";
import { isTerminal, lifecycleReducer } from "./lifecycle.ts";
import { journalPath } from "./paths.ts";
import { createEmptyState, type DerivedEntryState, type DerivedState, foldEvents } from "./replay.ts";

export interface JournalPeek {
  state: DerivedState;
  createdAt: Map<string, string>;
  /** First entry_created/entry_adopted event position, independent of timestamp validity. */
  entryOrder: Map<string, number>;
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
  const entryOrder = new Map<string, number>();
  if (!existsSync(path)) return { state: createEmptyState(), createdAt, entryOrder };

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
    if (
      (event.event === "entry_created" || event.event === "entry_adopted") &&
      typeof event.entry === "string" &&
      !entryOrder.has(event.entry)
    ) {
      entryOrder.set(event.entry, events.length - 1);
      if (typeof event.at === "string") createdAt.set(event.entry, event.at);
    }
  }
  return { state: foldEvents(events, lifecycleReducer), createdAt, entryOrder };
}

/** Every non-terminal entry, no exclusions — the shared base both counts below fold. The journal
 * is the single source of truth (A4); inbox `status` fields are frozen at write time and never
 * consulted. */
function nonTerminalEntries(state: DerivedState): DerivedEntryState[] {
  return Object.values(state.entries).filter((entry) => {
    const kind = entry.kind === "attention" ? "attention" : "common";
    return !isTerminal(kind, entry.status);
  });
}

/** RETENTION-FACING: "is any user work still parked in this workspace?" — the question deletion
 * safety asks. Consumers: `registry/workspace-index.ts`'s `hasPendingWork` (GC's hard-remove
 * guard) and `registry/orphan-scan.ts` (the stranded-home-state scanner behind `GET /api/status`).
 *
 * Counts an undismissed `external_edit`, deliberately. #153's decision that an `external_edit`
 * "nudges nobody" is about the BADGE; the same decision also promises such an entry stays pending
 * forever. Excluding it here would tell GC "nothing parked here" and tell orphan-scan "nothing to
 * report" for a workspace whose only outstanding item is exactly that — silently hiding the
 * stranding orphan-scan exists to catch, and making the persistence promise decorative. Two
 * questions, two counts; this one answers retention. */
export function retentionPendingCount(state: DerivedState): number {
  return nonTerminalEntries(state).length;
}

/** BADGE-FACING: "how many items are queued for someone to act on?" — the question the SPA's
 * agent-feedback badge and `glosa doctor`'s pending-delivery check ask. Consumers:
 * `transport/http.ts`'s `computeWiring` (`GET /w/:slug/wiring`) and its `GET /api/status`
 * per-workspace row.
 *
 * Excludes `external_edit`: it is not actionable (nothing to apply — the file already changed),
 * it is excluded from delivery eligibility, and counting it as "N queued" would promise a
 * delivery that by construction never comes.
 *
 * Attention entries need no exclusion anywhere and get none: every attention fold filters
 * `entry.kind === "attention"`, and an `external_edit`'s lifecycle kind is `common`, never that
 * string — it is structurally excluded, with no code to write and nothing to ablate. */
export function badgePendingCount(state: DerivedState): number {
  return nonTerminalEntries(state).filter((entry) => !isExternalEditEntry(entry)).length;
}

export function hasOpenAttention(state: DerivedState): boolean {
  return Object.values(state.entries).some((e) => e.kind === "attention" && !isTerminal("attention", e.status));
}

/** Journal-derived count of orphaned entries — the reverse of A4 §F04's usual gap: a durably
 * `entry_created`/`entry_adopted` entry (`peek.entryOrder`, so a lease-only vivify with no such
 * event, `lifecycle.ts:181-187`, never counts), still non-terminal, whose `.glosa/inbox/<id>.json`
 * has gone missing from under it (hand-removed, or otherwise lost — `readInboxEntry` returns
 * `null` on any read failure). Detect-and-report only, per AGENTS.md invariant 2: the journal is
 * never rewritten and no payload is synthesized to close the gap — `glosa inbox dismiss <id>` is
 * the supported human reconciliation.
 *
 * The terminal check reuses `nonTerminalEntries`' exact kind mapping (attention vs. everything else),
 * not a 3-way common/attention/conversation split: `handleWorkspaceInboxDismiss` (http.ts) uses
 * that same 2-way mapping to decide whether `dismiss` still applies to an entry, and this count
 * must agree with it — a 3-way split here could report an entry as orphaned (or clear) that
 * `dismiss` would classify differently, breaking the "count falls to zero after dismiss"
 * invariant this exists to serve. */
export function orphanedEntryCount(workspace: WorkspaceTarget, peek: JournalPeek): number {
  let count = 0;
  for (const id of peek.entryOrder.keys()) {
    const entry = peek.state.entries[id];
    if (!entry) continue; // defensive — entryOrder and the fold are populated by the same events
    const kind = entry.kind === "attention" ? "attention" : "common";
    if (isTerminal(kind, entry.status)) continue;
    if (readInboxEntry(workspace, id) !== null) continue;
    count++;
  }
  return count;
}

// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — the journal writer (A4 §F04). `.glosa/journal.ndjson` is append-only and is
// THE single source of truth; current status is never stored anywhere else, only derived by
// replaying it (replay.ts). This module owns exactly one concern: appending one event envelope
// safely — small-enough-to-fit, durably-if-lifecycle-critical, never interleaved with another
// append to the same file (interleaving is prevented by the caller holding the per-workspace
// mutex around every call, not by anything in here).
import { closeSync, existsSync, fstatSync, fsyncSync, ftruncateSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { fsyncContainingDir, writeAllSync } from "./io.ts";

export const MAX_EVENT_BYTES = 65536; // includes the trailing "\n"

/** Honest provenance carrier — never falsely "human" (A4 §F05). `session:<id>` is a proven
 * apply-lease attribution; everything the daemon can't prove stays "daemon"/"watcher"/"unknown"
 * upstream of this type (this module just carries whatever the caller supplies). */
export type EventBy = "daemon" | "watcher" | "human" | `session:${string}`;

// At least these (A4 §F04); P2.1 only ever EMITS entry_created, delivery_attempt,
// transition_committed, journal_tail_truncated, line_quarantined — the rest are reserved type
// names for later tasks (P2.3 apply-lease, P2.5 full lifecycle, P2.x checkpoints).
export type EventType =
  | "entry_created"
  | "delivery_attempt"
  | "transition_committed"
  | "attention_committed"
  | "baseline_checkpoint"
  | "auto_checkpoint"
  | "apply_begin"
  | "apply_end"
  | "apply_expired"
  | "journal_tail_truncated"
  | "line_quarantined"
  | "offline_catchup"
  | "git_index_lock_reclaimed"
  | "adoption_sealed"
  | "lineage_attached"
  | "entry_adopted";

export interface JournalEvent {
  v: 1;
  event_id: string;
  at: string;
  entry?: string;
  event: EventType;
  by: EventBy;
  /** Repeating this key across otherwise-distinct events (e.g. a retried `resolve` call) makes
   * the second one a no-op on replay — see replay.ts. */
  idem?: string;
  detail?: Record<string, unknown>;
}

// Lifecycle-critical events fsync before the append call returns success; delivery_attempt (and
// anything else not listed here) may skip the per-write fsync — loss there is only a redundant
// re-nudge, never a lost state transition (A4 §F04).
const LIFECYCLE_CRITICAL_EVENTS: ReadonlySet<EventType> = new Set([
  "entry_created",
  "transition_committed",
  "attention_committed",
  "apply_begin",
  "apply_end",
  "baseline_checkpoint",
  "adoption_sealed",
  "lineage_attached",
  "entry_adopted",
]);

export interface EventTooLargeError extends Error {
  code: "EVENT_TOO_LARGE";
  size: number;
}

function eventTooLargeError(size: number): EventTooLargeError {
  const err = new Error(
    `event serializes to ${size} bytes (incl. trailing newline), exceeds MAX_EVENT_BYTES=${MAX_EVENT_BYTES}`,
  ) as EventTooLargeError;
  err.code = "EVENT_TOO_LARGE";
  err.size = size;
  return err;
}

/** Holds a single append-mode fd open across calls (A4 §F04: "single openSync fd held at
 * start"), so repeated appends don't pay open/close overhead and can't race each other's file
 * creation. Not thread-safe on its own — callers serialize via the per-workspace mutex. */
export class JournalWriter {
  private fdValue: number | null = null;
  private closed = false;

  constructor(private readonly path: string) {}

  /** Opens (creating parent dirs + the file itself if needed) on first use; fsyncs the
   * containing directory exactly once, only when this call is the one that created the file.
   * Throws once `close()` has been called — closing is terminal, not "reopen on next use". */
  fd(): number {
    if (this.closed) throw new Error(`JournalWriter for ${this.path} is closed`);
    if (this.fdValue !== null) return this.fdValue;
    mkdirSync(dirname(this.path), { recursive: true });
    const isNew = !existsSync(this.path);
    this.fdValue = openSync(this.path, "a");
    if (isNew) fsyncContainingDir(this.path);
    return this.fdValue;
  }

  close(): void {
    this.closed = true;
    if (this.fdValue !== null) {
      fsyncSync(this.fdValue);
      closeSync(this.fdValue);
      this.fdValue = null;
    }
  }
}

export interface AppendOptions {
  /** Overrides the lifecycle-critical default. `delivery_attempt` callers may pass `false`
   * explicitly to batch/skip the per-write fsync. */
  fsync?: boolean;
}

/** Serializes `event`, rejects oversize BEFORE touching the fd (so a rejected append never
 * creates the file or mutates it — "never truncate into the journal"), then writes it with an
 * offset-advancing loop that tolerates a short `writeSync`, fsyncing before returning if the
 * event type is lifecycle-critical (or `opts.fsync` says so explicitly).
 *
 * If the write itself throws partway (e.g. a transient ENOSPC) without the process crashing, the
 * torn bytes it already wrote would otherwise sit at the journal's tail while the daemon keeps
 * running — `truncateTornTail` (reconcile.ts) only runs at startup, so that tail would never
 * self-heal mid-process, and the NEXT append would concatenate onto it with no separating
 * newline, corrupting an otherwise-fine interior line. So on any write failure, roll the fd back
 * to its pre-write size before rethrowing — the tail stays clean and the next append lands right
 * after the last complete record, as if this one never started. */
export function appendEvent(writer: JournalWriter, event: JournalEvent, opts: AppendOptions = {}): void {
  const line = JSON.stringify(event) + "\n";
  const bytes = Buffer.from(line, "utf8");
  if (bytes.byteLength > MAX_EVENT_BYTES) throw eventTooLargeError(bytes.byteLength);

  const fd = writer.fd();
  const sizeBeforeWrite = fstatSync(fd).size;
  try {
    writeAllSync(fd, bytes);
  } catch (err) {
    try {
      ftruncateSync(fd, sizeBeforeWrite);
    } catch {
      // best-effort rollback — if this also fails, the original write error is still the one
      // that surfaces below; a stuck fd is a startup-reconcile problem, not this call's to solve.
    }
    throw err;
  }

  const shouldFsync = opts.fsync ?? LIFECYCLE_CRITICAL_EVENTS.has(event.event);
  if (shouldFsync) fsyncSync(fd);
}

export function isLifecycleCritical(type: EventType): boolean {
  return LIFECYCLE_CRITICAL_EVENTS.has(type);
}

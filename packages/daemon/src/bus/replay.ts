// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — replay: the pure left-fold that turns the journal into current status (A4
// §F04). "The journal is the single source of truth" means status is NEVER stored anywhere else
// — every read of "what state is entry X in" is (conceptually) this fold over the file, memoized
// by whoever's holding the process.
//
// Two independent axes of idempotency, both required for "replay twice == byte-identical":
//   - `event_id` dedup: the exact same event object appended twice (e.g. a retried append after
//     an ack was lost) folds once.
//   - `idem` dedup: two DIFFERENT events (different event_id) that represent the same logical
//     action (e.g. `resolve` retried after a crash, each producing a fresh event_id but the same
//     caller-supplied idem key) — the second is a no-op. This is what makes "resolve re-run
//     folds to a no-op" true without the reducer itself needing to know about retries.
//
// The reducer is intentionally minimal and pluggable — P2.5 owns the full guarded lifecycle
// transition table and swaps its own reducer in via `ReplayOptions.reducer`.
//
// A bad interior line never goes away — the journal is append-only, so its raw bytes sit at the
// same offset forever. That means every replay would re-discover it and, naively, re-quarantine
// it: a fresh `line_quarantined` event and a fresh copy in the quarantine file, every single
// restart. To make that idempotent, `line_quarantined.detail.hash` carries a sha256 of the raw
// line, and each replay pre-scans for hashes already recorded by a PREVIOUS replay — a bad line
// whose hash is already known is still excluded from the fold (it's still not valid JSON) but is
// not re-announced or re-copied.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { EventType, JournalEvent } from "./journal.ts";
import { appendEvent, MAX_EVENT_BYTES, type JournalWriter } from "./journal.ts";
import { quarantineLine } from "./quarantine.ts";

export interface DerivedEntryState {
  status: string;
  [key: string]: unknown;
}

/** The one active apply-lease for a workspace, derived from the last unmatched `apply_begin`
 * (A4 §F05 — "exactly ONE active apply-lease/workspace"). `null` means no lease is outstanding.
 * `apply_end`/`apply_expired` for this `leaseId` clear it back to `null`. */
export interface ApplyLeaseState {
  leaseId: string;
  entry: string;
  session: string;
  preSha: string;
  expiresAt: string;
}

export interface DerivedState {
  entries: Record<string, DerivedEntryState>;
  applyLease: ApplyLeaseState | null;
  /** Present only after a durable `adoption_sealed`; mutators must reject rather than letting a
   * stale in-memory bus append into historical lineage. */
  adoptionSeal: { adoptionId: string; targetRegistrationId: string } | null;
  lineages: Record<string, Record<string, unknown>>;
  appliedEventIds: Set<string>;
  appliedIdemKeys: Set<string>;
  quarantineCount: number;
}

export function createEmptyState(): DerivedState {
  return {
    entries: {},
    applyLease: null,
    adoptionSeal: null,
    lineages: {},
    appliedEventIds: new Set(),
    appliedIdemKeys: new Set(),
    quarantineCount: 0,
  };
}

export type Reducer = (state: DerivedState, event: JournalEvent) => void;

/** Minimal, pluggable reducer — sufficient to prove idempotent replay, structured so P2.5 can
 * swap in the full guarded transition table without touching the fold machinery.
 * `delivery_attempt` never changes status — it's a separate axis (A5 §F23) — so it's
 * intentionally absent below, not an oversight. */
export const defaultReducer: Reducer = (state, event) => {
  switch (event.event) {
    case "entry_created": {
      if (!event.entry) return;
      if (!state.entries[event.entry]) state.entries[event.entry] = { status: "pending" };
      return;
    }
    case "transition_committed": {
      if (!event.entry) return;
      const to = event.detail?.to;
      if (typeof to !== "string") return;
      const existing = state.entries[event.entry];
      if (existing) existing.status = to;
      else state.entries[event.entry] = { status: to };
      return;
    }
    // P2.3 §F05: tracks the single outstanding apply-lease so `applyBegin` can reject a 2nd
    // concurrent lease (LEASE_HELD) and reconcile step 4 can find a dangling one to expire —
    // without either having to re-scan the raw journal themselves.
    case "apply_begin": {
      const d = event.detail;
      if (!d || typeof d.lease_id !== "string") return;
      state.applyLease = {
        leaseId: d.lease_id,
        entry: event.entry ?? "",
        session: typeof d.session === "string" ? d.session : "",
        preSha: typeof d.pre_sha === "string" ? d.pre_sha : "",
        expiresAt: typeof d.expires_at === "string" ? d.expires_at : "",
      };
      return;
    }
    case "apply_end":
    case "apply_expired": {
      const d = event.detail;
      const leaseId = d?.lease_id;
      if (state.applyLease && typeof leaseId === "string" && state.applyLease.leaseId === leaseId) {
        state.applyLease = null;
      }
      return;
    }
    case "adoption_sealed": {
      const d = event.detail;
      if (!d || typeof d.adoption_id !== "string" || typeof d.target_registration_id !== "string") return;
      state.adoptionSeal = { adoptionId: d.adoption_id, targetRegistrationId: d.target_registration_id };
      return;
    }
    case "lineage_attached": {
      const adoptionId = event.detail?.adoption_id;
      if (typeof adoptionId === "string") state.lineages[adoptionId] = event.detail ?? {};
      return;
    }
    default:
      return;
  }
};

/** Folds one event into `state` in place, honoring both dedup axes. Exported so reconcile.ts can
 * apply a just-synthesized/just-appended event to an in-memory state without a full re-read. */
export function applyEvent(state: DerivedState, event: JournalEvent, reducer: Reducer = defaultReducer): void {
  if (state.appliedEventIds.has(event.event_id)) return; // duplicate event_id -> ignore
  if (event.idem !== undefined && state.appliedIdemKeys.has(event.idem)) return; // idem already applied -> no-op

  reducer(state, event);

  state.appliedEventIds.add(event.event_id);
  if (event.idem !== undefined) state.appliedIdemKeys.add(event.idem);
}

/** Pure fold over an in-memory event array, in file order. No I/O — the impure "read the journal
 * file, quarantine bad lines" side sits in `replayJournal` below. */
export function foldEvents(events: JournalEvent[], reducer: Reducer = defaultReducer): DerivedState {
  const state = createEmptyState();
  for (const event of events) applyEvent(state, event, reducer);
  return state;
}

function isJournalEvent(value: unknown): value is JournalEvent {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.v === 1 &&
    typeof v.event_id === "string" &&
    v.event_id.length > 0 &&
    typeof v.at === "string" &&
    typeof v.event === "string" &&
    typeof v.by === "string"
  );
}

function tryParseEvent(line: string): JournalEvent | null {
  if (Buffer.byteLength(line, "utf8") + 1 > MAX_EVENT_BYTES) return null; // +1 for the trailing "\n"
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  return isJournalEvent(parsed) ? (parsed as JournalEvent) : null;
}

function hashLine(line: string): string {
  return createHash("sha256").update(line, "utf8").digest("hex");
}

/** Scans every line for existing `line_quarantined` events and collects the hashes they recorded
 * — these are lines a PREVIOUS replay already quarantined. Deliberately looks at every line, not
 * just ones that parse as bad, because a `line_quarantined` event is itself valid JSON sitting
 * later in the file (quarantine events get appended at the current tail, not at the bad line's
 * original position) — a single forward pass can't see it in time otherwise. */
function collectAlreadyQuarantinedHashes(effectiveLines: string[]): Set<string> {
  const hashes = new Set<string>();
  for (const line of effectiveLines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isJournalEvent(parsed) || parsed.event !== "line_quarantined") continue;
    const hash = parsed.detail?.hash;
    if (typeof hash === "string") hashes.add(hash);
  }
  return hashes;
}

export interface ReplayDeps {
  journalPath: string;
  quarantinePath: string;
  /** Used only to append `line_quarantined` events — the fold itself never writes. */
  writer: JournalWriter;
  ulid: () => string;
  now?: () => Date;
  reducer?: Reducer;
}

export interface ReplayResult {
  state: DerivedState;
  quarantineCount: number;
}

/** Reads the journal (already torn-tail-truncated by reconcile step 1 — this assumes a clean
 * trailing newline or an empty file), quarantining any interior line that's malformed, invalid,
 * or oversize, then folds everything that parsed. One bad line never disables the bus: it's
 * skipped and folding continues (A4 §F04). */
export function replayJournal(deps: ReplayDeps): ReplayResult {
  const raw = existsSync(deps.journalPath) ? readFileSync(deps.journalPath, "utf8") : "";
  const lines = raw.length === 0 ? [] : raw.split("\n");
  // A clean file (or one already torn-tail-truncated) ends in "\n", so the last split element is
  // "" — drop it rather than treat it as a blank line.
  const effectiveLines = lines.length > 0 && lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;

  const alreadyQuarantined = collectAlreadyQuarantinedHashes(effectiveLines);
  const events: JournalEvent[] = [];
  let quarantineCount = 0;

  for (const line of effectiveLines) {
    if (line.length === 0) continue; // tolerate a stray blank line defensively
    const parsed = tryParseEvent(line);
    if (parsed === null) {
      quarantineCount++; // a distinct bad line is present, whether or not it's new to us
      const hash = hashLine(line);
      if (!alreadyQuarantined.has(hash)) {
        quarantineLine(deps.quarantinePath, line);
        appendEvent(deps.writer, quarantinedEvent(deps, line, hash));
        alreadyQuarantined.add(hash); // guards against re-announcing it again within this same pass
      }
      continue;
    }
    events.push(parsed);
  }

  const state = foldEvents(events, deps.reducer);
  state.quarantineCount = quarantineCount;
  return { state, quarantineCount };
}

function quarantinedEvent(deps: ReplayDeps, badLine: string, hash: string): JournalEvent {
  const type: EventType = "line_quarantined";
  return {
    v: 1,
    event_id: deps.ulid(),
    at: (deps.now?.() ?? new Date()).toISOString(),
    event: type,
    by: "daemon",
    detail: { bytes: Buffer.byteLength(badLine, "utf8"), hash },
  };
}

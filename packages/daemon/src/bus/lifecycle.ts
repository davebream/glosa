// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — P2.5: the guarded inbox/attention lifecycle (A5 §F23). This is the reducer
// replay.ts's fold engine was left pluggable for; nothing in replay.ts, reconcile.ts, or the
// dedup logic in `applyEvent` changes here — only WHAT a transition event does to `status`.
//
// A5 §F23 names distinct events per
// transition (delivered/seen/resolved/done/staled/expired). P2.1 reserved, and P2.3 already
// EMITS, the generic `transition_committed{to}` (+ `attention_committed{to}`, reserved). Rather
// than add the named events, F23's names become the vocabulary of legal `to` VALUES + the guard
// table below — `transition_committed` carries common-entry transitions, `attention_committed`
// carries attention transitions. Both are routed through the SAME guard logic here, keyed off
// the entry's own recorded kind (not the event's type) — so a future caller that emits the
// "wrong" event name for an entry's kind still gets a correctly-guarded fold, it just isn't the
// convention callers are expected to follow.
//
// Terminal values conform to A5 §F23 literally: common terminals are `applied`/`rejected`/
// `stale`. (An earlier revision of this file keyed the guard table on `"resolved"`, matching an
// inconsistent remap `bus.ts`'s `resolveEntry` used to do for outcome `"applied"` — that remap is
// gone now; `resolveEntry` emits `to:` == `outcome` directly, so `applied`/`rejected`/`stale` are
// the actual, spec-conformant wire values.)
//
// Two independent axes (A5 §F23), enforced structurally, not by convention:
//   1. STATUS — a small guarded state machine per entry kind; illegal-from-current transitions,
//      and any transition attempted once an entry is terminal, are silently ignored on replay.
//   2. DELIVERY ATTEMPTS — `delivery_attempt` NEVER touches `status`. It's folded onto its own
//      list on the entry (`deliveryAttempts`), so re-nudging a `delivered` entry (or, per A5
//      §F23, even one still `pending`) records an attempt without moving the state machine.

import type { JournalEvent } from "./journal.ts";
import type { DerivedEntryState, DerivedState, Reducer } from "./replay.ts";
import { defaultReducer } from "./replay.ts";

export type EntryKind = "common" | "attention" | "conversation";

// A5 §F23's authoritative delivery_attempt vocabulary, verbatim:
// `{via:channel|asyncRewake|gate|stop|userprompt|mcp_pull, session, outcome:attempted|
// transport_accepted|presented|failed, reason:initial|re_nudge, error?}`. The single canonical
// definition — `bus.ts`'s `recordDeliveryAttempt`, `agent-provider/interface.ts`'s `DeliveryResult`,
// and every call site all import these three types from here rather than each declaring their
// own, which is what a P4.3 review caught: a provider-local `DeliveryOutcome` had drifted to
// `"delivered"|"failed"`, free text riding in `reason`, and no `via` distinguishing gate/stop/
// userprompt — none of that is a legal A5 §F23 value.
export type DeliveryVia = "channel" | "asyncRewake" | "gate" | "stop" | "userprompt" | "mcp_pull";
export type DeliveryOutcome = "attempted" | "transport_accepted" | "presented" | "failed";
export type DeliveryReason = "initial" | "re_nudge";

export interface DeliveryAttemptRecord {
  at: string;
  via?: DeliveryVia;
  session?: string;
  outcome?: DeliveryOutcome;
  reason?: DeliveryReason;
  error?: string;
}

interface GuardRule {
  /** Statuses this `to` may legally fire FROM. The sentinel `"non-terminal"` is the loose
   * "resolve" guard A5 §F23 gives `applied`/`rejected`/`stale`/`expired`: legal from ANY
   * non-terminal status (including straight off the initial one — this is the P2.3 path, a
   * resolve with no intervening `delivered`/`seen`). */
  from: readonly string[] | "non-terminal";
}

type GuardTable = Readonly<Record<string, GuardRule>>;

const COMMON_INITIAL_STATUS = "pending";
const ATTENTION_INITIAL_STATUS = "open";
const CONVERSATION_INITIAL_STATUS = "pending";

const COMMON_TERMINALS: ReadonlySet<string> = new Set(["applied", "rejected", "stale"]);
const ATTENTION_TERMINALS: ReadonlySet<string> = new Set(["done", "expired", "stale"]);
const CONVERSATION_TERMINALS: ReadonlySet<string> = new Set(["delivered", "stale"]);

// Common: pending -> delivered -> seen? -> {applied|rejected|stale}.
const COMMON_GUARDS: GuardTable = {
  delivered: { from: [COMMON_INITIAL_STATUS] },
  seen: { from: ["delivered"] },
  applied: { from: "non-terminal" },
  rejected: { from: "non-terminal" },
  stale: { from: "non-terminal" },
};

// Attention: open -> delivered -> seen -> {done|expired|stale}.
const ATTENTION_GUARDS: GuardTable = {
  delivered: { from: [ATTENTION_INITIAL_STATUS] },
  seen: { from: ["delivered"] },
  done: { from: ["seen", "delivered"] },
  expired: { from: "non-terminal" },
  stale: { from: "non-terminal" },
};

// Conversation messages are complete once a transport has proved presentation. Queueing and
// transport acceptance remain delivery-attempt facts and never advance this state machine.
const CONVERSATION_GUARDS: GuardTable = {
  delivered: { from: [CONVERSATION_INITIAL_STATUS] },
  stale: { from: "non-terminal" },
};

function terminalsFor(kind: EntryKind): ReadonlySet<string> {
  if (kind === "attention") return ATTENTION_TERMINALS;
  if (kind === "conversation") return CONVERSATION_TERMINALS;
  return COMMON_TERMINALS;
}

function guardsFor(kind: EntryKind): GuardTable {
  if (kind === "attention") return ATTENTION_GUARDS;
  if (kind === "conversation") return CONVERSATION_GUARDS;
  return COMMON_GUARDS;
}

function initialStatusFor(kind: EntryKind): string {
  if (kind === "attention") return ATTENTION_INITIAL_STATUS;
  if (kind === "conversation") return CONVERSATION_INITIAL_STATUS;
  return COMMON_INITIAL_STATUS;
}

/** Never leave a terminal state — every transition (and `entryKindOf`'s callers) gates on this
 * first. Exported so a `--wait` caller (or a test) can ask "is this entry done moving?" without
 * re-deriving the terminal set itself. */
export function isTerminal(kind: EntryKind, status: string): boolean {
  return terminalsFor(kind).has(status);
}

/** `canTransition` is the entire idempotency core: a guarded `to` applies only when the CURRENT
 * derived status is a legal `from` for it, per the table for this entry's kind. Everything else —
 * a transition attempted out of order, a duplicate resolve on an already-terminal entry, a
 * `to` value that isn't even in this kind's vocabulary — is a no-op, not an error. That's what
 * makes replaying the same illegal event twice (or replaying a journal that has one) safe. */
function canTransition(kind: EntryKind, current: string, to: string): boolean {
  if (isTerminal(kind, current)) return false; // terminal is terminal — nothing leaves it
  const rule = guardsFor(kind)[to];
  if (!rule) return false; // unrecognized `to` for this kind — ignored, never fatal
  if (rule.from === "non-terminal") return true; // already excluded terminal `current` above
  return rule.from.includes(current);
}

/** Where an entry's kind is read from (A5 §F23 lists `human_edit`/`annotation`/`attention_request`
 * as inbox payload kinds, but the fold only ever sees journal EVENTS, never the inbox file — so
 * the `entry_created` event's own `detail.kind` is the one source of truth here). Anything other
 * than the literal `"attention_request"` — including a missing `detail`, or a self-healed
 * `entry_created` synthesized by reconcile.ts's crash recovery, which never carries a kind —
 * defaults to `"common"`, the more restrictive/ordinary of the two tables. */
function entryKindFromDetail(detail: Record<string, unknown> | undefined): EntryKind {
  if (detail?.kind === "attention_request") return "attention";
  if (detail?.kind === "conversation_message") return "conversation";
  return "common";
}

function entryKindOf(entryState: DerivedEntryState): EntryKind {
  if (entryState.kind === "attention") return "attention";
  if (entryState.kind === "conversation") return "conversation";
  return "common";
}

function deliveryAttemptsOf(entryState: DerivedEntryState): DeliveryAttemptRecord[] {
  const existing = entryState.deliveryAttempts;
  if (Array.isArray(existing)) return existing as DeliveryAttemptRecord[];
  const fresh: DeliveryAttemptRecord[] = [];
  entryState.deliveryAttempts = fresh;
  return fresh;
}

function applyGuardedTransition(state: DerivedState, event: JournalEvent): void {
  if (!event.entry) return;
  const to = event.detail?.to;
  if (typeof to !== "string") return;

  const entryState = state.entries[event.entry];
  if (!entryState) {
    // No `entry_created` on record for this entry — NOT necessarily unhealthy: P2.3's
    // apply-lease flow (`WorkspaceBus.applyBegin`/`resolveEntry`) never requires routing through
    // the inbox first (its "entry" is just a label the lease/checkpoint machinery attaches to),
    // and lease.test.ts exercises exactly that: `resolveEntry` with no prior `createEntry`. With
    // no recorded current status there's no FROM to guard, but `to` itself is still checked
    // against the common vocabulary — an attention-only or nonsense `to` (e.g. `"done"`, a typo)
    // must not mint a limbo entry that's outside every table (unreachable, unterminable). Only a
    // legal common `to` value vivifies, unguarded on `from`, defaulting to the common kind (the
    // more restrictive/ordinary of the two tables — mirrors replay.ts's original minimal reducer
    // for everything that WAS a legal value).
    //
    // P4.3: if `attention_committed` ever gets a real producer that also skips `entry_created`,
    // this path will default it to "common" kind too (it can't yet tell attention from common
    // with nothing recorded) — today that's unreachable (nothing emits `attention_committed`
    // without a preceding `createEntry`), so it's left as a known gap rather than guessed at.
    if (!(to in guardsFor("common"))) return; // not a legal common transition target — no-op
    state.entries[event.entry] = { status: to, kind: "common", deliveryAttempts: [] as DeliveryAttemptRecord[] };
    return;
  }

  const kind = entryKindOf(entryState);
  if (!canTransition(kind, entryState.status, to)) return; // illegal-from OR already-terminal

  entryState.status = to;
  // The terminal (or any legally-applied) transition's own `detail` — e.g. an attention `done`'s
  // verdict — rides along on the entry so a `--wait` caller (R9) can read it off the derived
  // state without re-scanning the journal for the resolving event.
  const { to: _transitionTarget, ...publicDetail } = event.detail ?? {};
  entryState.detail = Object.keys(publicDetail).length > 0 ? publicDetail : undefined;
}

/** The full P2.5 reducer: owns `entry_created` / `delivery_attempt` / `transition_committed` /
 * `attention_committed` (the F23 entry lifecycle); everything else (`apply_begin`/`apply_end`/
 * `apply_expired`/quarantine bookkeeping/…) is P2.3's/P2.1's concern and is delegated unchanged to
 * `defaultReducer` — this reducer is a strict superset, never a regression, for anything outside
 * the entry lifecycle it owns. */
export const lifecycleReducer: Reducer = (state, event) => {
  switch (event.event) {
    case "entry_created": {
      if (!event.entry) return;
      if (state.entries[event.entry]) return; // already created — replay-safe no-op
      const kind = entryKindFromDetail(event.detail);
      state.entries[event.entry] = {
        status: initialStatusFor(kind),
        kind,
        deliveryAttempts: [] as DeliveryAttemptRecord[],
      };
      return;
    }
    case "entry_adopted": {
      if (!event.entry || state.entries[event.entry]) return;
      const d = event.detail ?? {};
      const kind = entryKindFromDetail(d);
      const status = typeof d.status === "string" ? d.status : initialStatusFor(kind);
      const attempts = Array.isArray(d.delivery_attempts) ? d.delivery_attempts : [];
      state.entries[event.entry] = {
        status,
        kind,
        // The source journal remains the audit trail; carrying the current delivery axis keeps a
        // retry after adoption from pretending an already-delivered item was never attempted.
        deliveryAttempts: attempts,
        origin: {
          source_registration_id: d.source_registration_id,
          source_entry_id: d.source_entry_id,
        },
      };
      return;
    }
    case "delivery_attempt": {
      if (!event.entry) return;
      const entryState = state.entries[event.entry];
      if (!entryState) return; // attempt for an entry we never saw created — nothing to attach it to
      const d = event.detail ?? {};
      // Cast, not validate-and-reject: replay must never treat a legacy/malformed
      // detail.via|outcome|reason (outside today's A5 §F23 vocabulary) as fatal — it's still
      // carried through verbatim for inspection, just no longer statically guaranteed to be a
      // CURRENT enum member for anything replayed from an older journal.
      deliveryAttemptsOf(entryState).push({
        at: event.at,
        via: typeof d.via === "string" ? (d.via as DeliveryAttemptRecord["via"]) : undefined,
        session: typeof d.session === "string" ? d.session : undefined,
        outcome: typeof d.outcome === "string" ? (d.outcome as DeliveryAttemptRecord["outcome"]) : undefined,
        reason: typeof d.reason === "string" ? (d.reason as DeliveryAttemptRecord["reason"]) : undefined,
        error: typeof d.error === "string" ? d.error : undefined,
      });
      // Deliberately no `entryState.status = ...` anywhere in this case — that's the whole point
      // of delivery being a separate axis (A5 §F23): re-nudging never advances the state machine.
      return;
    }
    case "transition_committed":
    case "attention_committed": {
      applyGuardedTransition(state, event);
      return;
    }
    default:
      defaultReducer(state, event);
      return;
  }
};

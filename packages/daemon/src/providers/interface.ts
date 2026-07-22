// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — R7's AgentProvider interface (a first-class v1 deliverable, not a Claude-only
// concern): the seam every hook/MCP-capable agent CLI implements ONE of to plug into glosa's
// delivery ladder (R4). Defined here — not inside packages/providers/claude-code — so both the
// daemon (which owns the SessionRegistry/WorkspaceBus objects `deliver()` acts on) and every
// provider package (which implements it) share the exact same shape. "Adding a CLI = a new
// provider, never a core change" (R7) only holds if the core depends on THIS file and nothing
// provider-specific.
import type { WorkspaceBus } from "../bus/bus.ts";
import type { DeliveryOutcome, DeliveryVia } from "../bus/lifecycle.ts";

export type { DeliveryOutcome, DeliveryVia } from "../bus/lifecycle.ts";

/** What `detectSession` extracts from a raw hook/event payload (R7 verbatim shape). `workspace`
 * is whatever the provider considers the session's home directory (Claude: `cwd`; other
 * providers may differ) — R2's routing precedence treats an explicit binding as authoritative
 * over this, but `detectSession` itself only ever reports the provider's own notion of "where".
 * `transcript_path` is optional (not every provider has one); `source` is the provider's own
 * event/trigger label (Claude: `"startup"|"resume"|"clear"|"compact"`, A2 §F08). */
export interface SessionBinding {
  session_id: string;
  workspace: string;
  transcript_path?: string;
  source: string;
}

/** R7 verbatim — the four delivery mechanisms a provider may offer (R4's table: push into idle,
 * blocking gate, turn-boundary drain, pull on demand). A provider that can't do one just reports
 * `false` for it; `deliver()` is the only thing that needs to know how to fall back through
 * whichever subset is `true` — R4: "channels are optional compatibility, not a required gate". */
export interface ProviderCapabilities {
  push: boolean;
  gate: boolean;
  boundaryDrain: boolean;
  mcpPull: boolean;
}

/** `via`/`outcome` are A5 §F23's fixed vocabulary, imported from `lifecycle.ts` (the ONE place
 * that defines it) rather than redeclared here — a P4.3 review caught exactly this file
 * inventing its own `"delivered"|"failed"` outcome and free-text `via`/`reason` values, none of
 * which are legal A5 §F23 detail. `outcome` distinguishes four real points in a delivery's life:
 * `attempted` (fired/queued, no confirmation — e.g. a rung that will only fire at a FUTURE turn
 * boundary), `transport_accepted` (the transport layer itself ack'd it — a channel notification
 * accepted, a watcher successfully signaled), `presented` (actually shown to the agent this turn
 * — the hook route surfacing it via additionalContext/block reason), `failed` (a rung that was
 * actually attempted and errored — never "this rung wasn't available", which `deliver()` simply
 * skips on its way down the ladder, recording nothing for it).
 *
 * Deliberately no `reason` field here: A5 §F23's `reason` is `initial|re_nudge` — whether this is
 * the FIRST attempt for `entryId` or a later re-nudge — and only the caller holding the
 * `WorkspaceBus` (i.e. `recordDelivery()` below) can answer that; `deliver()` itself has no view
 * of an entry's attempt history, so it must never guess. */
export interface DeliveryResult {
  via: DeliveryVia;
  outcome: DeliveryOutcome;
  /** Free-text technical detail for a `failed` outcome (an exception message, a rejection
   * reason) — NOT a place to stash a human-readable gloss of a successful outcome; `via` +
   * `outcome` alone are meant to fully describe a success. */
  error?: string;
}

export interface PresentationRetrieval {
  command: string;
  mcp_tool: "glosa_inbox_get";
  cursor?: string;
}

export interface PresentationTruncation {
  truncated: boolean;
  omitted_bytes: number;
  omitted_hunks: number;
}

interface PresentationBase {
  id: string;
  status: string;
  text: string;
  bytes: number;
  truncation: PresentationTruncation;
  retrieval: PresentationRetrieval;
}

/** Provider-neutral, already-bounded actionable content. The `kind` discriminant keeps annotation,
 * human-edit, and attention payloads explicit while every transport shares the exact same text,
 * byte accounting, truncation metadata, and retrieval instructions. */
export type DeliverableEntry =
  | (PresentationBase & { kind: "annotation"; detail: Record<string, unknown> })
  | (PresentationBase & { kind: "human_edit"; detail: Record<string, unknown> })
  | (PresentationBase & { kind: "attention_request"; detail: Record<string, unknown> });

export type Liveness = "alive" | "stale";

/** R7's minimal interface, verbatim — a provider's own design may EXTEND this (add methods,
 * accept extra constructor deps), never narrow what's exposed here. */
export interface AgentProvider {
  /** `"claude-code"` | `"codex"` | ... — stable, used as the `provider` field on a
   * `SessionRegistry` record (A2 §F08). */
  id: string;
  /** From a raw hook/event payload → a `SessionBinding`, or `null` if the payload doesn't carry
   * enough to identify a session (malformed/foreign event). Pure — no I/O. */
  detectSession(hookEvent: unknown): SessionBinding | null;
  capabilities(session: SessionBinding): ProviderCapabilities;
  /** Uses the best available capability (the R4 ladder) to get `entry` in front of the agent.
   * The result maps to a journal `delivery_attempt` via `recordDelivery()` — this method itself
   * never touches the journal, so it stays testable without a `WorkspaceBus`. */
  deliver(session: SessionBinding, entry: DeliverableEntry): Promise<DeliveryResult>;
  /** Lease/heartbeat only — NEVER `kill(pid, 0)` (A2 §F08: hook input has no documented PID). */
  liveness(session: SessionBinding): Liveness;
  /** For the conversation mirror (R6) — `null` when this provider/session has none. */
  transcriptPath(session: SessionBinding): string | null;
}

/** The one place a `DeliveryResult` becomes a journal `delivery_attempt` (A5 §F23) — every
 * `deliver()` caller should route through this rather than calling `bus.recordDeliveryAttempt`
 * directly, so the R7-return-shape → journal-detail mapping lives in exactly one place. This is
 * ALSO the one place `reason:initial|re_nudge` gets decided (A5 §F23/R3: "re-nudging a delivered
 * entry emits new delivery_attempt") — `bus.state.entries[entryId]` is the entry's own attempt
 * history, so "does this entry already have a prior delivery_attempt" is answered by inspecting
 * it directly, never guessed at by the provider. */
export function recordDelivery(
  bus: WorkspaceBus,
  entryId: string,
  session: SessionBinding,
  result: DeliveryResult,
): Promise<void> {
  const priorAttempts = bus.state.entries[entryId]?.deliveryAttempts;
  const reason = Array.isArray(priorAttempts) && priorAttempts.length > 0 ? "re_nudge" : "initial";
  return bus.recordDeliveryAttempt(entryId, {
    via: result.via,
    session: session.session_id,
    outcome: result.outcome,
    reason,
    error: result.error,
  });
}

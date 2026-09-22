// SPDX-License-Identifier: Apache-2.0
// Session signals (issue #155 part 2): short, addressed notices telling an agent session what
// happened to the claims around it — above all, that a PERSON took over a file it was editing.
//
// A separate axis from the journal, deliberately. Signals are derived from claim events AS THEY ARE
// APPENDED (`WorkspaceBus.subscribe` is cursor-ordered and synchronous), held in memory, and lost on
// restart; the journal event that caused each one is the durable truth, and nothing here is ever
// written back to it. That is what keeps invariant 2 intact: a signal can be missed, but it can never
// be the only record of what happened.
//
// One record per ADDRESSEE. A "broadcast" is resolved to the explicit list of sessions routed to the
// workspace at emit time and fanned out, so every record has exactly one owner, one ack token that
// only its owner is ever shown, and an ack that only its owner can make. Never a daemon-wide "*".
import { randomBytes, randomUUID } from "node:crypto";
import type { WorkspaceBus } from "../bus/bus.ts";
import type { JournalEvent } from "../bus/journal.ts";

export type SignalKind = "conflict" | "info";

/** What a session is shown. `ack_token` is present only in the addressee's own copy. */
export interface SignalFrame {
  id: string;
  kind: SignalKind;
  workspace: string;
  resources: string[];
  claim_id?: string;
  /** One plain sentence an agent can act on, and what the provider transports print. */
  message: string;
  created_at: string;
  expires_at: string;
  ack_token: string;
}

interface StoredSignal extends SignalFrame {
  target: string;
  cursor: number;
  acked_at: string | null;
}

/** 15 minutes, the exclusive-claim TTL: a signal about a claim outliving any claim it could be about
 * would be news about nothing. */
export const SIGNAL_TTL_MS = 15 * 60 * 1000;
/** Per addressee. Past it the OLDEST is dropped — the newest is the one that describes now. */
export const MAX_SIGNALS_PER_SESSION = 64;
/** The drain's own budget for signals, separate from (and outside) the 32 KiB entry budget. */
export const MAX_DRAINED_SIGNALS = 8;
export const MAX_DRAINED_SIGNAL_BYTES = 8 * 1024;

export interface SignalRegistryDeps {
  /** Live session ids routed to `workspace` right now (the R2 routing predicate). */
  sessionsFor: (workspace: string) => string[];
  /** Pushes a frame to a live stream; `false` when the session has none. */
  push?: (sessionId: string, frame: SignalFrame) => boolean;
  now?: () => Date;
  id?: () => string;
  token?: () => string;
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function listed(resources: readonly string[]): string {
  return resources.length > 0 ? resources.join(", ") : "its files";
}

/** One planned signal, before it is stored: the pure half of the rules. */
export interface PlannedSignal {
  target: string;
  kind: SignalKind;
  resources: string[];
  claim_id?: string;
  message: string;
}

/** Which signals a journal event causes, and for whom. Pure: the caller supplies who is routed to
 * the workspace. The rules (issue #155):
 *  - a claim released BY A PERSON → `conflict` to its holder: someone overrode it, and the holder's
 *    next write would be to a file it no longer holds;
 *  - a claim expired → `info` to its holder, naming why;
 *  - a claim taken or released → `info` to every OTHER session on the workspace.
 * Nobody is ever told about their own action, and the holder of a human-released claim gets the
 * conflict only, not an info copy of the same fact. */
export function planSignals(event: JournalEvent, sessions: readonly string[]): PlannedSignal[] {
  const d = event.detail ?? {};
  const claimId = typeof d.claim_id === "string" ? d.claim_id : undefined;
  const resources = stringsOf(d.resources);
  const others = (except: string | undefined) => sessions.filter((session) => session !== except);
  switch (event.event) {
    case "claim_taken": {
      const actor = typeof d.session === "string" ? d.session : undefined;
      const mode = d.mode === "presence" ? "is looking at" : "is editing";
      return others(actor).map((target) => ({
        target,
        kind: "info" as const,
        resources,
        ...(claimId ? { claim_id: claimId } : {}),
        message: `session ${actor ?? "?"} ${mode} ${listed(resources)} (claim ${claimId ?? "?"}).`,
      }));
    }
    case "claim_released": {
      const holder = typeof d.holder_session === "string" ? d.holder_session : undefined;
      const byHuman = d.by === "human";
      const planned: PlannedSignal[] = others(holder).map((target) => ({
        target,
        kind: "info" as const,
        resources,
        ...(claimId ? { claim_id: claimId } : {}),
        message: byHuman
          ? `a person released session ${holder ?? "?"}'s claim on ${listed(resources)}.`
          : `session ${holder ?? "?"} released its claim on ${listed(resources)}.`,
      }));
      if (byHuman && holder) {
        planned.unshift({
          target: holder,
          kind: "conflict",
          resources,
          ...(claimId ? { claim_id: claimId } : {}),
          message: `a person took over ${listed(resources)}: your claim ${claimId ?? "?"} was released and your unfinished edits were recorded as unknown. Re-read the file before doing anything else; resolving now answers claim-revoked.`,
        });
      }
      return planned;
    }
    case "claim_expired": {
      const holder = typeof d.holder_session === "string" ? d.holder_session : undefined;
      if (!holder) return [];
      const why = d.reason === "holder_stale" ? "this session stopped responding" : "its time ran out";
      return [
        {
          target: holder,
          kind: "info",
          resources,
          ...(claimId ? { claim_id: claimId } : {}),
          message: `your claim ${claimId ?? "?"} on ${listed(resources)} expired because ${why}; claim it again before resolving.`,
        },
      ];
    }
    default:
      return [];
  }
}

function frameBytes(frame: SignalFrame): number {
  return Buffer.byteLength(JSON.stringify(frame), "utf8");
}

export class SignalRegistry {
  private readonly signals = new Map<string, StoredSignal>();
  private readonly deps: SignalRegistryDeps;
  private readonly now: () => Date;
  private readonly id: () => string;
  private readonly token: () => string;

  constructor(deps: SignalRegistryDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
    this.id = deps.id ?? (() => `sig-${randomUUID()}`);
    this.token = deps.token ?? (() => randomBytes(16).toString("hex"));
  }

  /** Derives signals from `bus`'s journal as it is appended. Returns the unsubscribe. */
  attach(bus: Pick<WorkspaceBus, "subscribe">, workspace: string): () => void {
    return bus.subscribe(({ cursor, event }) => this.record(workspace, cursor, event));
  }

  /** Applies the rules to one journal event, stores what it causes, and pushes each signal to its
   * addressee's live stream when there is one. Synchronous, so signals leave in journal order. */
  record(workspace: string, cursor: number, event: JournalEvent): SignalFrame[] {
    const planned = planSignals(event, this.deps.sessionsFor(workspace));
    if (planned.length === 0) return [];
    const now = this.now();
    const created: SignalFrame[] = [];
    for (const signal of planned) {
      const stored: StoredSignal = {
        id: this.id(),
        kind: signal.kind,
        workspace,
        resources: signal.resources,
        ...(signal.claim_id ? { claim_id: signal.claim_id } : {}),
        message: signal.message,
        created_at: now.toISOString(),
        expires_at: new Date(now.getTime() + SIGNAL_TTL_MS).toISOString(),
        ack_token: this.token(),
        target: signal.target,
        cursor,
        acked_at: null,
      };
      this.signals.set(stored.id, stored);
      this.enforceCap(signal.target);
      const frame = this.frameOf(stored);
      created.push(frame);
      try {
        this.deps.push?.(signal.target, frame);
      } catch {
        // A broken stream never loses a signal: it stays pending for the next drain or reconnect.
      }
    }
    return created;
  }

  /** The addressee's unacknowledged, unexpired signals in journal order, bounded for a drain. */
  pending(sessionId: string, opts: { limit?: number; maxBytes?: number } = {}): SignalFrame[] {
    this.prune();
    const limit = opts.limit ?? MAX_DRAINED_SIGNALS;
    const maxBytes = opts.maxBytes ?? MAX_DRAINED_SIGNAL_BYTES;
    const out: SignalFrame[] = [];
    let bytes = 0;
    for (const signal of this.ownedBy(sessionId)) {
      if (signal.acked_at !== null) continue;
      const frame = this.frameOf(signal);
      const size = frameBytes(frame);
      if (out.length >= limit || bytes + size > maxBytes) break;
      out.push(frame);
      bytes += size;
    }
    return out;
  }

  /** Acknowledges one signal for its addressee. The token AND the session must both match — a
   * bearer that learns a signal id cannot consume another session's signal. Idempotent: acking an
   * already-acked signal answers `already`. Anything that does not match answers `not-found`, the
   * same as a signal that never existed, so the route leaks nothing about other sessions. */
  ack(sessionId: string, signalId: string, token: string): "acked" | "already" | "not-found" {
    this.prune();
    const signal = this.signals.get(signalId);
    if (!signal || signal.target !== sessionId || signal.ack_token !== token) return "not-found";
    if (signal.acked_at !== null) return "already";
    signal.acked_at = this.now().toISOString();
    return "acked";
  }

  private ownedBy(sessionId: string): StoredSignal[] {
    return [...this.signals.values()]
      .filter((signal) => signal.target === sessionId)
      .sort((a, b) => a.cursor - b.cursor);
  }

  private enforceCap(sessionId: string): void {
    const owned = this.ownedBy(sessionId);
    for (const signal of owned.slice(0, Math.max(0, owned.length - MAX_SIGNALS_PER_SESSION))) {
      this.signals.delete(signal.id);
    }
  }

  private prune(): void {
    const now = this.now().getTime();
    for (const [id, signal] of this.signals) {
      if (new Date(signal.expires_at).getTime() <= now) this.signals.delete(id);
    }
  }

  private frameOf(signal: StoredSignal): SignalFrame {
    return {
      id: signal.id,
      kind: signal.kind,
      workspace: signal.workspace,
      resources: signal.resources,
      ...(signal.claim_id ? { claim_id: signal.claim_id } : {}),
      message: signal.message,
      created_at: signal.created_at,
      expires_at: signal.expires_at,
      ack_token: signal.ack_token,
    };
  }
}

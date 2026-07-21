// SPDX-License-Identifier: Apache-2.0
// @glosa/providers-claude-code — the Claude Code AgentProvider (R7). Implements the R4 delivery
// ladder for Claude specifically:
//   rung 1  channel      MCP `notifications/claude/channel` — pushes into an idle session (A2 §F06)
//   rung 2  asyncRewake  wakes an idle session via the SessionStart-launched watcher (A2 §F07)
//   rung 3  boundary     Stop/UserPromptSubmit hook drain — delivered at the next turn boundary
//   rung 4  mcpPull      the entry sits in the durable inbox for the `glosa mcp` pull tool
//
// Every transport this class can reach for is INJECTED (never a bare `fetch`/`Bun.spawn` inside
// `deliver()` itself) — that's what makes the ladder + fallback behavior unit-testable without a
// live Claude Code session. Wiring the real channel sender / real watcher signal is the P5.4
// rehearsal's job (see this package's test/ dir header comment); this file only has to prove the
// LOGIC: try the best rung first, record what actually happened, fall back correctly when a rung
// is unavailable OR fails.
import type {
  AgentProvider,
  DeliverableEntry,
  DeliveryResult,
  Liveness,
  ProviderCapabilities,
  SessionBinding,
} from "../../../daemon/src/index.ts";
import { looksLikeClaudeHookInput } from "./hook-types.ts";

/** The subset of `SessionRegistry` `deliver()`/`liveness()` need — a structural interface, not an
 * import of the daemon's concrete class, so this package only ever depends on `@glosa/daemon` for
 * the R7 TYPES (already imported above), never for a runtime class. Any object satisfying this
 * shape works, including the real `SessionRegistry` and a hand-rolled test double. */
export interface SessionLivenessSource {
  liveness(sessionId: string): "alive" | "stale";
}

/** Rung 1 — attempts the MCP channel push. Returns `true` on an accepted notification, `false` if
 * channels are unavailable/unregistered/rejected for this session (a `false` is NOT an error —
 * R4: channels are optional, this just means "try the next rung"), and MAY throw for a genuine
 * transport failure (which `deliver()` records as `outcome: "failed"` before falling back). */
export type ChannelSender = (session: SessionBinding, entry: DeliverableEntry) => Promise<boolean>;

/** Rung 2 — signals the currently-armed asyncRewake watcher for this session (if any). `false`
 * (not armed / signal rejected) falls through to rung 3, same contract as `ChannelSender`. */
export type RewakeSignal = (session: SessionBinding, entry: DeliverableEntry) => Promise<boolean>;

export interface ClaudeCodeProviderDeps {
  liveness: SessionLivenessSource;
  /** Whether channels are active for THIS session (the `--dangerously-load-development-channels
   * server:glosa` activation, A2 §F06) — a provider-wide `sendChannel` existing doesn't imply a
   * given session actually has channels loaded; this is what lets a "channels OFF" test disable
   * rung 1 without removing the sender itself. Omit (or return false) to always fall back. */
  channelsEnabled?: (session: SessionBinding) => boolean;
  sendChannel?: ChannelSender;
  /** Whether an asyncRewake watcher is currently armed for this session — backed by
   * `RewakeLeaseStore.isActive` in production. Omit to skip rung 2 entirely (e.g. a provider
   * instance running outside the daemon that has no lease-store access). */
  watcherArmed?: (sessionId: string) => boolean;
  signalWatcher?: RewakeSignal;
}

const CAPABILITIES: ProviderCapabilities = { push: true, gate: true, boundaryDrain: true, mcpPull: true };

export class ClaudeCodeProvider implements AgentProvider {
  readonly id = "claude-code";

  constructor(private readonly deps: ClaudeCodeProviderDeps) {}

  /** Structural only — accepts anything carrying `session_id`/`cwd` (A2 §F08's SessionStart shape
   * and every other Claude hook event share that much), so a hook payload with extra/newer fields
   * this package doesn't know about still detects fine. `workspace` is `cwd` verbatim: R2's
   * routing precedence layers an explicit adapter binding ABOVE this, so `detectSession` itself
   * never has to guess at anything fancier than "the directory this hook fired in". */
  detectSession(hookEvent: unknown): SessionBinding | null {
    if (!looksLikeClaudeHookInput(hookEvent)) return null;
    const raw = hookEvent as {
      session_id: string;
      cwd: string;
      transcript_path?: unknown;
      source?: unknown;
      hook_event_name?: unknown;
    };
    const binding: SessionBinding = {
      session_id: raw.session_id,
      workspace: raw.cwd,
      source: typeof raw.source === "string" ? raw.source : typeof raw.hook_event_name === "string" ? raw.hook_event_name : "unknown",
    };
    if (typeof raw.transcript_path === "string" && raw.transcript_path.length > 0) {
      binding.transcript_path = raw.transcript_path;
    }
    return binding;
  }

  /** Static for this provider — every Claude Code session gets the same four capabilities (R7:
   * "v1 ships: Claude Code provider (deep: push=channels, gate+boundary=hooks, mcpPull=tools...)").
   * Takes `session` only to satisfy the interface; a future provider revision COULD make this
   * session-dependent (e.g. an older CC version lacking channels) without changing the signature. */
  capabilities(_session: SessionBinding): ProviderCapabilities {
    return CAPABILITIES;
  }

  liveness(session: SessionBinding): Liveness {
    return this.deps.liveness.liveness(session.session_id);
  }

  transcriptPath(session: SessionBinding): string | null {
    return session.transcript_path ?? null;
  }

  /** The R4 ladder, in rung order — each rung's `via` and `outcome` are A5 §F23's fixed
   * vocabulary, never a free-text gloss (a P4.3 review caught an earlier revision inventing
   * `"delivered"`/`"boundary_drain"`/`"none"`, none of which are legal A5 §F23 values). Every
   * rung either (a) isn't available for this session/deps configuration → skip straight to the
   * next rung with no journal entry for it (an unavailable rung was never "attempted"), or (b) is
   * attempted and either succeeds or throws/returns `false`. `deliver()` itself only ever returns
   * ONE result per call — the rung it actually landed on — never one event per rung tried; a
   * thrown error from a rung is caught and reported as THAT rung's own `outcome: "failed"` rather
   * than propagating or silently falling through (a genuine transport error is not the same thing
   * as "this rung declined, try the next one").
   *
   * `outcome` distinguishes what's actually KNOWN at the moment `deliver()` returns:
   *   - `transport_accepted` — the channel/watcher ack'd the push (rungs 1–2 success). This is
   *     NOT the same as the agent having seen it yet — just that the transport took it.
   *   - `attempted` — queued for a FUTURE touchpoint with no confirmation at all (rungs 3–4): the
   *     entry is durable and WILL be presented at the next Stop/UserPromptSubmit hook or MCP pull
   *     — but that presentation is a SEPARATE event (recorded by the hook route itself, via
   *     `outcome: "presented"`, when it actually happens) from this proactive queuing record. */
  async deliver(session: SessionBinding, entry: DeliverableEntry): Promise<DeliveryResult> {
    const caps = this.capabilities(session);

    // Rung 1 — channel push.
    if (caps.push && this.deps.channelsEnabled?.(session) && this.deps.sendChannel) {
      try {
        const accepted = await this.deps.sendChannel(session, entry);
        if (accepted) return { via: "channel", outcome: "transport_accepted" };
      } catch (err) {
        return { via: "channel", outcome: "failed", error: errorMessage(err) };
      }
      // Not accepted (e.g. no live channel handshake) — fall through, this was never a hard error.
    }

    // Rung 2 — asyncRewake.
    if (caps.push && this.deps.watcherArmed?.(session.session_id) && this.deps.signalWatcher) {
      try {
        const accepted = await this.deps.signalWatcher(session, entry);
        if (accepted) return { via: "asyncRewake", outcome: "transport_accepted" };
      } catch (err) {
        return { via: "asyncRewake", outcome: "failed", error: errorMessage(err) };
      }
    }

    // Rung 3 — turn-boundary drain (the "gate" row of R4's table — Claude's `gate` capability is
    // always true, so this is deterministic for the real provider; the ACTUAL Stop/UserPromptSubmit
    // hook that surfaces the entry records its own `via:"stop"|"userprompt"` + `outcome:"presented"`
    // separately, once it really happens). Nothing to actively push here — the entry is already
    // durable in the inbox (R4's invariant) — so this is a queuing record, not a delivery
    // confirmation.
    if (caps.gate || caps.boundaryDrain) {
      return { via: "gate", outcome: "attempted" };
    }

    // Rung 4 — MCP pull. Last resort: the entry waits in the durable inbox for an explicit pull.
    if (caps.mcpPull) {
      return { via: "mcp_pull", outcome: "attempted" };
    }

    // No capability at all (unreachable for the real Claude provider — every capability above is
    // statically true; only a test double with a narrowed `capabilities()` hits this). "gate" is
    // reused as the vocabulary has no "none" — `outcome:"failed"` + `error` is what actually
    // distinguishes it from a real gate attempt.
    return { via: "gate", outcome: "failed", error: "no_capability_available" };
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// SPDX-License-Identifier: Apache-2.0
// @glosa/providers-codex — the Codex AgentProvider (R7). Implements the R4 delivery ladder MINUS
// channels — Codex has no async-push-into-idle equivalent (docs/research/codex-contract.md §7:
// "push: false").
//   rung 1  gate/boundaryDrain  Codex's Stop hook `decision:block` (blocking) or plain-stdout/
//                               additionalContext (non-blocking) — codex-contract.md §2-3. Collapsed
//                               into ONE rung, same as the Claude provider's own rung 3 (its `gate`/
//                               `boundaryDrain` are both hook-drain mechanisms, never two
//                               independently reachable transports).
//   rung 2  mcpPull             the entry sits in the durable inbox for the `glosa mcp` pull tool —
//                               Codex is an MCP CLIENT ONLY (codex-contract.md §6), so this is the
//                               SAME "Codex calls glosa's tool" shape Claude's rung 4 already uses,
//                               just registered via `config.toml [mcp_servers.glosa]` instead of
//                               `.mcp.json`.
//
// Structure deliberately mirrors packages/providers/claude-code/src/provider.ts — R7's "adding a
// CLI = a new provider, never a core change" only holds if both providers satisfy AgentProvider
// with no core special-casing, and the easiest way to prove that is to keep their internal shape as
// similar as the underlying mechanics allow. The real difference from Claude's provider is entirely
// SUBTRACTIVE: no ChannelSender, no RewakeSignal, no rungs 1-2.
import type {
  AgentProvider,
  DeliverableEntry,
  DeliveryResult,
  Liveness,
  ProviderCapabilities,
  SessionBinding,
} from "../../../daemon/src/index.ts";
import { looksLikeCodexHookInput } from "./hook-types.ts";

/** The subset of `SessionRegistry` `liveness()` needs — a structural interface, not an import of
 * the daemon's concrete class, same trick `ClaudeCodeProvider`'s own `SessionLivenessSource` uses
 * so this package only ever depends on `@glosa/daemon` for the R7 TYPES, never a runtime class. */
export interface SessionLivenessSource {
  liveness(sessionId: string): "alive" | "stale";
}

export interface CodexProviderDeps {
  liveness: SessionLivenessSource;
}

const CAPABILITIES: ProviderCapabilities = { push: false, gate: true, boundaryDrain: true, mcpPull: true };

export class CodexProvider implements AgentProvider {
  readonly id = "codex";

  constructor(private readonly deps: CodexProviderDeps) {}

  /** Structural only — accepts anything carrying `session_id`/`cwd` (every Codex `*CommandInput`
   * struct carries exactly those two fields under those names, codex-contract.md §7), mirroring
   * `ClaudeCodeProvider.detectSession`'s own guard exactly. `workspace` is `cwd` verbatim — same
   * reasoning as Claude's: R2's routing precedence layers an explicit adapter binding ABOVE this,
   * so `detectSession` never has to guess at anything fancier than "the directory this hook fired
   * in". `source` reads the payload's own `source` field when present (`SessionStart` only), else
   * falls back to `hook_event_name` (`Stop`/`UserPromptSubmit`/`SessionEnd` carry no `source`),
   * exactly mirroring the Claude provider's own fallback. */
  detectSession(hookEvent: unknown): SessionBinding | null {
    if (!looksLikeCodexHookInput(hookEvent)) return null;
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

  /** Static for this provider — every Codex session gets the same three capabilities, no
   * channels-equivalent (codex-contract.md §7 verbatim: `push: false, gate: true,
   * boundaryDrain: true, mcpPull: true` — matches R7's "Codex provider (gate + boundaryDrain +
   * mcpPull; push=false)" now pinned against real source rather than assumed). */
  capabilities(_session: SessionBinding): ProviderCapabilities {
    return CAPABILITIES;
  }

  /** Lease/heartbeat only — same invariant as Claude's provider, doubly true for Codex: no Codex
   * hook payload documents a PID either (codex-contract.md §4), so there's no PID-based liveness
   * check to even be tempted by. */
  liveness(session: SessionBinding): Liveness {
    return this.deps.liveness.liveness(session.session_id);
  }

  transcriptPath(session: SessionBinding): string | null {
    return session.transcript_path ?? null;
  }

  /** The R4 ladder minus channels, in rung order. Same `outcome` vocabulary discipline as the
   * Claude provider (A5 §F23's fixed vocab, never free text) — `attempted` for a rung that queues
   * for a FUTURE touchpoint with no transport confirmation, which is BOTH rungs here: Codex has no
   * synchronous ack path for either (codex-contract.md §2/§3/§6 — the actual `decision:block` JSON
   * only gets written once a real `glosa hook codex stop` handler exists, a later T-task; this
   * method just decides which rung the entry is queued against). Nothing here can throw in the real
   * provider — `outcome:"failed"` only appears via a capabilities()-narrowed test double, same as
   * the Claude provider's own no-capability fallback test. */
  async deliver(session: SessionBinding, _entry: DeliverableEntry): Promise<DeliveryResult> {
    const caps = this.capabilities(session);

    // Rung 1 — gate/boundaryDrain collapsed (codex-contract.md §2-3): Codex's Stop hook is BOTH the
    // blocking-gate mechanism (`decision:block` + non-empty `reason`) and the non-blocking drain
    // mechanism (plain stdout / `hookSpecificOutput.additionalContext`) — there is no second,
    // independently reachable transport behind `boundaryDrain` the way Claude's channel/asyncRewake
    // sit ABOVE its own gate rung.
    if (caps.gate || caps.boundaryDrain) {
      return { via: "gate", outcome: "attempted" };
    }

    // Rung 2 — MCP pull: the entry waits in the durable inbox for `glosa mcp`'s pull tool, which a
    // Codex session reaches as an MCP CLIENT via `config.toml [mcp_servers.glosa]`
    // (codex-contract.md §6) — the same target tool Claude's rung 4 pulls from, just registered
    // through a different config file.
    if (caps.mcpPull) {
      return { via: "mcp_pull", outcome: "attempted" };
    }

    // No capability at all — unreachable for the real Codex provider (both capabilities above are
    // statically true); only a test double with a narrowed capabilities() hits this. "gate" is
    // reused as the vocabulary has no "none" value, same as Claude's own fallback.
    return { via: "gate", outcome: "failed", error: "no_capability_available" };
  }
}

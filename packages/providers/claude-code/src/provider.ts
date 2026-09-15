// SPDX-License-Identifier: Apache-2.0
// @glosa/providers-claude-code — the Claude Code AgentProvider (R7). Implements the R4 delivery
// ladder for Claude specifically:
//   rung 1  monitor   the plugin session monitor's open stream (A2 §F06/§F07) — pushes into an
//                     idle session; available only while THIS session has a connected monitor
//   rung 2  mcpPull   the entry sits in the durable inbox for the `glosa mcp` pull tool
//
// Every transport this class can reach for is INJECTED (never a bare `fetch`/`Bun.spawn` inside
// `deliver()` itself) — that's what makes the ladder + fallback behavior unit-testable without a
// live Claude Code session. This file only has to prove the LOGIC: try the push first, record
// what actually happened, fall back correctly when the push is unavailable OR fails.
import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { confineTranscriptPath } from "../../../daemon/src/transcript/root.ts";
import { claudeConfigRoots } from "../../../daemon/src/transcript/root.ts";
import type {
  AgentProvider,
  DeliverableEntry,
  DeliveryResult,
  Liveness,
  ProviderCapabilities,
  ProviderConnectPrompt,
  ProviderConnectTarget,
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

/** Rung 1 — hands the bounded entry to this session's connected monitor stream. Returns `true` on
 * a transport-accepted push, `false` if the stream declined or timed out (a `false` is NOT an
 * error — it just means "fall back to MCP pull"), and MAY throw for a genuine transport failure
 * (which `deliver()` records as `outcome: "failed"` before falling back). */
export type MonitorSender = (session: SessionBinding, entry: DeliverableEntry) => Promise<boolean>;

export interface ClaudeCodeProviderDeps {
  transcriptRoots?: () => readonly string[];
  liveness: SessionLivenessSource;
  /** Whether THIS session currently has a connected plugin monitor (R7: `push` is evaluated per
   * session at registration, never from plugin installation — a monitor does not start under
   * `DISABLE_TELEMETRY=1`, in non-interactive sessions, or on third-party model platforms).
   * Omit (or return false) to always fall back to MCP pull. */
  pushAvailable?: (session: SessionBinding) => boolean;
  sendPush?: MonitorSender;
}

export class ClaudeCodeProvider implements AgentProvider {
  readonly id = "claude-code";

  constructor(private readonly deps: ClaudeCodeProviderDeps) {}

  connectPrompt(target: ProviderConnectTarget): ProviderConnectPrompt {
    return {
      display_name: "Claude Code",
      instruction:
        "Read CLAUDE_CODE_SESSION_ID from this Claude Code session's environment, then call " +
        `glosa_session_bind with session_id set to that exact value and workspace set to ${JSON.stringify(target.path)}.`,
    };
  }

  /** Structural only — accepts anything carrying `session_id`/`cwd` (A2 §F08's registration shape
   * and every Claude event payload share that much), so a payload with extra/newer fields this
   * package doesn't know about still detects fine. `workspace` is `cwd` verbatim: R2's routing
   * precedence layers an explicit adapter binding ABOVE this, so `detectSession` itself never has
   * to guess at anything fancier than "the directory this session runs in". */
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
      source:
        typeof raw.source === "string"
          ? raw.source
          : typeof raw.hook_event_name === "string"
            ? raw.hook_event_name
            : "unknown",
    };
    if (typeof raw.transcript_path === "string" && raw.transcript_path.length > 0) {
      binding.transcript_path = raw.transcript_path;
    }
    return binding;
  }

  /** R7: `{ push, mcpPull }`, evaluated per session. `push` is true only while this exact session
   * has a connected plugin monitor; `mcpPull` is always true (the durable inbox is reachable from
   * any session with the MCP server loaded). */
  capabilities(session: SessionBinding): ProviderCapabilities {
    return { push: this.deps.pushAvailable?.(session) === true, mcpPull: true };
  }

  liveness(session: SessionBinding): Liveness {
    return this.deps.liveness.liveness(session.session_id);
  }

  transcriptRoots(): readonly string[] {
    return this.deps.transcriptRoots?.() ?? claudeConfigRoots();
  }

  transcriptPath(session: SessionBinding): string | null {
    if (session.transcript_path) return session.transcript_path;
    if (!/^[a-zA-Z0-9_-]+$/.test(session.session_id)) return null;
    const encodedCwd = session.workspace.replace(/[^a-zA-Z0-9]/g, "-");
    const candidates = new Set<string>();
    for (const root of this.transcriptRoots()) {
      const path = join(root, "projects", encodedCwd, `${session.session_id}.jsonl`);
      try {
        if (lstatSync(path).isFile() && confineTranscriptPath(path, [root]).ok) candidates.add(realpathSync(path));
      } catch {
        /* a newly registered session may not have written its transcript yet */
      }
    }
    return candidates.size === 1 ? [...candidates][0]! : null;
  }

  /** The R4 ladder, `push → mcp_pull`. Each rung's `via` and `outcome` are A5 §F23's fixed
   * vocabulary, never a free-text gloss. The push rung either (a) isn't available for this
   * session → skip straight to MCP pull with no journal entry for it (an unavailable rung was
   * never "attempted"), or (b) is attempted and either succeeds, declines (`false`), or throws.
   * `deliver()` only ever returns ONE result per call — the rung it actually landed on; a thrown
   * error from the push is reported as THAT rung's own `outcome: "failed"` rather than propagating
   * or silently falling through (a genuine transport error is not the same thing as "this rung
   * declined, try the next one").
   *
   * `outcome` distinguishes what's actually KNOWN at the moment `deliver()` returns:
   *   - `transport_accepted` — the monitor stream ack'd the push. NOT the same as the agent having
   *     seen it yet — `presented` is recorded separately when the agent calls `glosa_delivery_ack`.
   *   - `attempted` — queued for a FUTURE MCP pull with no confirmation at all: the entry is
   *     durable and WILL be presented when the session next pulls, and that presentation is a
   *     SEPARATE event (recorded by the pull route itself as `outcome: "presented"`). */
  async deliver(session: SessionBinding, entry: DeliverableEntry): Promise<DeliveryResult> {
    const caps = this.capabilities(session);

    if (caps.push && this.deps.sendPush) {
      try {
        if (await this.deps.sendPush(session, entry)) {
          return { via: "monitor", outcome: "transport_accepted" };
        }
      } catch (err) {
        return { via: "monitor", outcome: "failed", error: errorMessage(err) };
      }
      // Not accepted (stream declined or timed out) — fall through, this was never a hard error.
    }

    if (caps.mcpPull) {
      return { via: "mcp_pull", outcome: "attempted" };
    }

    // No capability at all (unreachable for the real Claude provider — `mcpPull` is statically
    // true; only a test double with a narrowed `capabilities()` hits this). The vocabulary has no
    // "none", so `outcome:"failed"` + `error` is what distinguishes it from a real pull attempt.
    return { via: "mcp_pull", outcome: "failed", error: "no_capability_available" };
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Provider-owned identity discovery; transcript recency is never evidence of identity. */
export function discoverClaudeMcpSession(env: Record<string, string | undefined>, cwd: string) {
  const session_id = env.CLAUDE_CODE_SESSION_ID;
  return session_id ? { session_id, provider: "claude-code", cwd } : null;
}

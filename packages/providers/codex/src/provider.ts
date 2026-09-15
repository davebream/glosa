// SPDX-License-Identifier: Apache-2.0
// @glosa/providers-codex — the Codex AgentProvider (R7). Implements the R4 delivery ladder through
// an optional app-server control-socket subscription, then the durable MCP pull fallback.
//   rung 1  codex_app_server    `turn/steer` / `turn/start` on a connected exact-thread transport.
//   rung 2  mcpPull             the entry sits in the durable inbox for the `glosa mcp` pull tool —
//                               Codex calls glosa as an MCP client (codex-contract.md §6), registered
//                               with `codex mcp add glosa -- glosa mcp`.
//
// Structure deliberately mirrors packages/providers/claude-code/src/provider.ts — R7's "adding a
// CLI = a new provider, never a core change" only holds if both providers satisfy AgentProvider
// with no core special-casing, and the easiest way to prove that is to keep their internal shape as
// similar as the underlying mechanics allow. Codex's push transport is provider-owned and present
// only while the local control-socket subscription is live.
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { confineTranscriptPath } from "../../../daemon/src/transcript/root.ts";
import { homedir } from "node:os";
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
import { looksLikeCodexHookInput } from "./hook-types.ts";

/** The subset of `SessionRegistry` `liveness()` needs — a structural interface, not an import of
 * the daemon's concrete class, same trick `ClaudeCodeProvider`'s own `SessionLivenessSource` uses
 * so this package only ever depends on `@glosa/daemon` for the R7 TYPES, never a runtime class. */
export interface SessionLivenessSource {
  liveness(sessionId: string): "alive" | "stale";
}

export interface CodexProviderDeps {
  transcriptRoots?: () => readonly string[];
  liveness: SessionLivenessSource;
  pushAvailable?: (session: SessionBinding) => boolean;
  sendPush?: (session: SessionBinding, entry: DeliverableEntry) => Promise<boolean>;
}

export class CodexProvider implements AgentProvider {
  readonly id = "codex";

  constructor(private readonly deps: CodexProviderDeps) {}

  connectPrompt(target: ProviderConnectTarget): ProviderConnectPrompt {
    return {
      display_name: "Codex",
      instruction:
        "Read CODEX_THREAD_ID from this Codex session's environment, then call " +
        `glosa_session_bind with session_id set to that exact value, provider set to "codex", and workspace set to ${JSON.stringify(target.path)}.`,
    };
  }

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

  /** Push is session-local and true only while that exact thread owns the registered app-server
   * stream. MCP pull remains available regardless. */
  capabilities(session: SessionBinding): ProviderCapabilities {
    return { push: this.deps.pushAvailable?.(session) === true, mcpPull: true };
  }

  /** Lease/heartbeat only — same invariant as Claude's provider, doubly true for Codex: no Codex
   * hook payload documents a PID either (codex-contract.md §4), so there's no PID-based liveness
   * check to even be tempted by. */
  liveness(session: SessionBinding): Liveness {
    return this.deps.liveness.liveness(session.session_id);
  }

  transcriptRoots(): readonly string[] {
    return (
      this.deps.transcriptRoots?.() ?? [
        ...new Set([process.env.CODEX_HOME ?? join(homedir(), ".codex"), join(homedir(), ".codex")]),
      ]
    );
  }

  transcriptPath(session: SessionBinding): string | null {
    if (session.transcript_path) return session.transcript_path;
    if (!/^[a-zA-Z0-9_-]+$/.test(session.session_id)) return null;
    const candidates = new Set<string>();
    // Only the documented YYYY/MM/DD layout, never a recursive home-directory scan.
    const scan = (dir: string, depth: number, root: string) => {
      try {
        if (!confineTranscriptPath(dir, [root]).ok) return;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name);
          const rolloutIdentity = entry.name.replace(/^rollout-(?:\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-)?/, "");
          if (depth < 3 && entry.isDirectory() && (depth === 0 ? /^\d{4}$/ : /^\d{2}$/).test(entry.name)) {
            scan(path, depth + 1, root);
          } else if (
            depth === 3 &&
            entry.isFile() &&
            entry.name.startsWith("rollout-") &&
            rolloutIdentity === `${session.session_id}.jsonl` &&
            confineTranscriptPath(path, [root]).ok &&
            lstatSync(path).isFile()
          ) {
            candidates.add(realpathSync(path));
          }
        }
      } catch {
        /* missing or unreadable transcripts do not prevent registration */
      }
    };
    for (const root of this.transcriptRoots()) scan(join(root, "sessions"), 0, root);
    return candidates.size === 1 ? [...candidates][0]! : null;
  }

  /** The R4 ladder, `push → mcp_pull`. Same `outcome` vocabulary discipline as the Claude
   * provider (A5 §F23's fixed vocab, never free text) — `attempted` for the pull rung, which queues
   * for a FUTURE touchpoint with no transport confirmation. `outcome:"failed"` on the push rung
   * means the socket transport genuinely errored; a declined push (`false`) simply falls through. */
  async deliver(session: SessionBinding, entry: DeliverableEntry): Promise<DeliveryResult> {
    const caps = this.capabilities(session);

    if (caps.push && this.deps.sendPush) {
      try {
        if (await this.deps.sendPush(session, entry)) {
          return { via: "codex_app_server", outcome: "transport_accepted" };
        }
      } catch (error) {
        return {
          via: "codex_app_server",
          outcome: "failed",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    // Rung 2 — MCP pull: the entry waits in the durable inbox for `glosa mcp`'s pull tool, which a
    // Codex session reaches as an MCP CLIENT (codex-contract.md §6) — the same target tool Claude's
    // own pull rung uses.
    if (caps.mcpPull) {
      return { via: "mcp_pull", outcome: "attempted" };
    }

    // No capability at all — unreachable for the real Codex provider (`mcpPull` is statically
    // true); only a test double with a narrowed capabilities() hits this, same as Claude's own
    // fallback.
    return { via: "mcp_pull", outcome: "failed", error: "no_capability_available" };
  }
}

/** Provider-owned identity discovery; transcript recency is never evidence of identity. */
export function discoverCodexMcpSession(env: Record<string, string | undefined>, cwd: string) {
  const session_id = env.CODEX_THREAD_ID;
  return session_id ? { session_id, provider: "codex", cwd } : null;
}

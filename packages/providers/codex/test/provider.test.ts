// SPDX-License-Identifier: Apache-2.0
// P4.4 — the Codex AgentProvider's interface conformance + the R4 delivery ladder MINUS channels
// (docs/research/codex-contract.md, T2a). Mirrors
// packages/providers/claude-code/test/provider.test.ts's structure deliberately — same assertions,
// same shape, proving the two providers satisfy AgentProvider identically apart from the rungs
// Codex genuinely doesn't have. The real `glosa hook codex stop`/MCP wiring is a later T-task; this
// only proves the LADDER LOGIC with capabilities injected/narrowed, same as the Claude suite.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CodexProvider, type SessionLivenessSource } from "../src/provider.ts";
import type { DeliverableEntry, SessionBinding } from "@glosa/daemon";

const SESSION: SessionBinding = { session_id: "sess-1", workspace: "/repo", source: "startup" };
const ENTRY: DeliverableEntry = {
  id: "inb-1",
  kind: "annotation",
  status: "pending",
  text: "glosa annotation inb-1\nartifact: notes.md\ncomment:\nAct on this.",
  bytes: 64,
  detail: { artifact_path: "notes.md" },
  truncation: { truncated: false, omitted_bytes: 0, omitted_hunks: 0 },
  retrieval: { command: "glosa inbox get inb-1", mcp_tool: "glosa_inbox_get" },
};

function liveness(map: Record<string, "alive" | "stale"> = {}): SessionLivenessSource {
  return { liveness: (id) => map[id] ?? "stale" };
}

describe("CodexProvider — AgentProvider conformance", () => {
  test("id is 'codex'", () => {
    const provider = new CodexProvider({ liveness: liveness() });
    expect(provider.id).toBe("codex");
  });

  test("detectSession extracts session_id/workspace/transcript_path/source from a SessionStart payload", () => {
    const provider = new CodexProvider({ liveness: liveness() });
    const hookEvent = {
      session_id: "thread-abc123",
      transcript_path: "/Users/name/.codex/sessions/2026/07/21/rollout-thread-abc123.jsonl",
      cwd: "/Users/name/code/my-repo",
      hook_event_name: "SessionStart",
      source: "startup",
      model: "gpt-5-codex",
      permission_mode: "auto",
    };
    expect(provider.detectSession(hookEvent)).toEqual({
      session_id: "thread-abc123",
      workspace: "/Users/name/code/my-repo",
      transcript_path: "/Users/name/.codex/sessions/2026/07/21/rollout-thread-abc123.jsonl",
      source: "startup",
    });
  });

  test("detectSession falls back to hook_event_name when source is absent (Stop/UserPromptSubmit have no `source`)", () => {
    const provider = new CodexProvider({ liveness: liveness() });
    const detected = provider.detectSession({
      session_id: "thread-abc123",
      turn_id: "turn-1",
      cwd: "/repo",
      hook_event_name: "Stop",
      stop_hook_active: false,
    });
    expect(detected?.source).toBe("Stop");
    expect(detected?.transcript_path).toBeUndefined();
  });

  test("detectSession treats the Codex-native `transcript_path: null` as absent, not a string", () => {
    // Codex's NullableString wire format sends `null`, never omits the key or sends "" — the
    // provider must not mistake that for a present transcript_path (codex-contract.md §4/§5).
    const provider = new CodexProvider({ liveness: liveness() });
    const detected = provider.detectSession({
      session_id: "thread-1",
      cwd: "/repo",
      hook_event_name: "SessionStart",
      source: "startup",
      transcript_path: null,
    });
    expect(detected?.transcript_path).toBeUndefined();
  });

  test("detectSession returns null for a payload missing session_id or cwd", () => {
    const provider = new CodexProvider({ liveness: liveness() });
    expect(provider.detectSession({ cwd: "/repo" })).toBeNull();
    expect(provider.detectSession({ session_id: "abc" })).toBeNull();
    expect(provider.detectSession("not an object")).toBeNull();
    expect(provider.detectSession(null)).toBeNull();
  });

  test("capabilities: no channels-equivalent push, gate+boundaryDrain+mcpPull all true (R7/codex-contract.md §7)", () => {
    const provider = new CodexProvider({ liveness: liveness() });
    expect(provider.capabilities(SESSION)).toEqual({ push: false, gate: true, boundaryDrain: true, mcpPull: true });
  });

  test("liveness delegates to the injected liveness source, never a PID check", () => {
    const provider = new CodexProvider({ liveness: liveness({ "sess-1": "alive" }) });
    expect(provider.liveness(SESSION)).toBe("alive");
    expect(provider.liveness({ ...SESSION, session_id: "unknown" })).toBe("stale");
  });

  test("grep-guard: the provider source never calls process.kill / kill(pid — liveness is lease/heartbeat only", () => {
    const src = readFileSync(new URL("../src/provider.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/process\.kill/);
    expect(src).not.toMatch(/\bkill\s*\(\s*pid/);
  });

  test("transcriptPath reads straight off the SessionBinding, null when absent", () => {
    const provider = new CodexProvider({ liveness: liveness() });
    expect(provider.transcriptPath(SESSION)).toBeNull();
    expect(provider.transcriptPath({ ...SESSION, transcript_path: "/x/rollout-y.jsonl" })).toBe("/x/rollout-y.jsonl");
  });
});

describe("CodexProvider.deliver — the R4 ladder minus channels", () => {
  test("gate/boundaryDrain available (the default) → delivers via 'gate', outcome 'attempted'", async () => {
    const provider = new CodexProvider({ liveness: liveness() });
    const result = await provider.deliver(SESSION, ENTRY);
    expect(result).toEqual({ via: "gate", outcome: "attempted" });
  });

  test("gate unavailable, boundaryDrain still available → still delivers via 'gate' (the two rungs are one mechanism)", async () => {
    class GateOffProvider extends CodexProvider {
      override capabilities() {
        return { push: false, gate: false, boundaryDrain: true, mcpPull: true };
      }
    }
    const provider = new GateOffProvider({ liveness: liveness() });
    const result = await provider.deliver(SESSION, ENTRY);
    expect(result).toEqual({ via: "gate", outcome: "attempted" });
  });

  test("gate AND boundaryDrain both unavailable → falls to rung 2, mcp_pull", async () => {
    class NoHookDrainProvider extends CodexProvider {
      override capabilities() {
        return { push: false, gate: false, boundaryDrain: false, mcpPull: true };
      }
    }
    const provider = new NoHookDrainProvider({ liveness: liveness() });
    const result = await provider.deliver(SESSION, ENTRY);
    expect(result).toEqual({ via: "mcp_pull", outcome: "attempted" });
  });

  test("every capability false → outcome:'failed', not a thrown promise", async () => {
    class NoCapabilityProvider extends CodexProvider {
      override capabilities() {
        return { push: false, gate: false, boundaryDrain: false, mcpPull: false };
      }
    }
    const provider = new NoCapabilityProvider({ liveness: liveness() });
    const result = await provider.deliver(SESSION, ENTRY);
    expect(result).toEqual({ via: "gate", outcome: "failed", error: "no_capability_available" });
  });

  test("push is never consulted — Codex has no channels-equivalent, so a push:true override still doesn't add a rung", async () => {
    class SpuriousPushProvider extends CodexProvider {
      override capabilities() {
        return { push: true, gate: true, boundaryDrain: true, mcpPull: true };
      }
    }
    const provider = new SpuriousPushProvider({ liveness: liveness() });
    const result = await provider.deliver(SESSION, ENTRY);
    expect(result).toEqual({ via: "gate", outcome: "attempted" });
  });
});

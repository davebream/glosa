// SPDX-License-Identifier: Apache-2.0
// P4.3 / #152 — the Claude Code AgentProvider's interface conformance + the R4 delivery ladder
// `push → mcp_pull`, including the monitor-OFF fallback (a session with no connected plugin monitor
// — telemetry disabled, non-interactive, third-party platform — must still land on MCP pull). The
// real monitor subprocess is covered by `monitor.test.ts`; everything here proves the LADDER LOGIC
// with the transport injected.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { discoverClaudeMcpSession, ClaudeCodeProvider, type SessionLivenessSource } from "../src/provider.ts";
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

describe("ClaudeCodeProvider — AgentProvider conformance", () => {
  test("id is 'claude-code'", () => {
    const provider = new ClaudeCodeProvider({ liveness: liveness() });
    expect(provider.id).toBe("claude-code");
  });

  test("connectPrompt owns non-empty current-session guidance", () => {
    const provider = new ClaudeCodeProvider({ liveness: liveness() });
    const prompt = provider.connectPrompt({ slug: "alpha", path: "/work/alpha with spaces" });

    expect(prompt.display_name).toBe("Claude Code");
    expect(prompt.instruction.length).toBeGreaterThan(0);
    expect(prompt.instruction).toContain("CLAUDE_CODE_SESSION_ID");
    expect(prompt.instruction).toContain("glosa_session_bind");
    expect(prompt.instruction).toContain('"/work/alpha with spaces"');
  });

  test("detectSession extracts session_id/workspace/transcript_path/source from a SessionStart payload", () => {
    const provider = new ClaudeCodeProvider({ liveness: liveness() });
    const hookEvent = {
      session_id: "abc123",
      transcript_path: "/Users/name/.claude/projects/slug/abc123.jsonl",
      cwd: "/Users/name/code/my-repo",
      hook_event_name: "SessionStart",
      source: "startup",
      model: "claude-sonnet-5",
    };
    expect(provider.detectSession(hookEvent)).toEqual({
      session_id: "abc123",
      workspace: "/Users/name/code/my-repo",
      transcript_path: "/Users/name/.claude/projects/slug/abc123.jsonl",
      source: "startup",
    });
  });

  test("detectSession falls back to hook_event_name when source is absent (Stop/UserPromptSubmit have no `source`)", () => {
    const provider = new ClaudeCodeProvider({ liveness: liveness() });
    const detected = provider.detectSession({ session_id: "abc123", cwd: "/repo", hook_event_name: "Stop" });
    expect(detected?.source).toBe("Stop");
    expect(detected?.transcript_path).toBeUndefined();
  });

  test("detectSession returns null for a payload missing session_id or cwd", () => {
    const provider = new ClaudeCodeProvider({ liveness: liveness() });
    expect(provider.detectSession({ cwd: "/repo" })).toBeNull();
    expect(provider.detectSession({ session_id: "abc" })).toBeNull();
    expect(provider.detectSession("not an object")).toBeNull();
    expect(provider.detectSession(null)).toBeNull();
  });

  test("capabilities are { push, mcpPull }, with push evaluated per session from a connected monitor (R7)", () => {
    const noMonitor = new ClaudeCodeProvider({ liveness: liveness() });
    expect(noMonitor.capabilities(SESSION)).toEqual({ push: false, mcpPull: true });
    const monitored = new ClaudeCodeProvider({
      liveness: liveness(),
      pushAvailable: (session) => session.session_id === "sess-1",
    });
    expect(monitored.capabilities(SESSION)).toEqual({ push: true, mcpPull: true });
    expect(monitored.capabilities({ ...SESSION, session_id: "sess-2" })).toEqual({ push: false, mcpPull: true });
    // No leftover legacy fields: `gate`/`boundaryDrain` were the hook rungs #152 removed.
    expect(Object.keys(monitored.capabilities(SESSION)).sort()).toEqual(["mcpPull", "push"]);
  });

  test("liveness delegates to the injected liveness source, never a PID check", () => {
    const provider = new ClaudeCodeProvider({ liveness: liveness({ "sess-1": "alive" }) });
    expect(provider.liveness(SESSION)).toBe("alive");
    expect(provider.liveness({ ...SESSION, session_id: "unknown" })).toBe("stale");
  });

  test("transcriptPath reads straight off the SessionBinding, null when absent", () => {
    const provider = new ClaudeCodeProvider({ liveness: liveness() });
    expect(provider.transcriptPath(SESSION)).toBeNull();
    expect(provider.transcriptPath({ ...SESSION, transcript_path: "/x/y.jsonl" })).toBe("/x/y.jsonl");
  });
});

describe("ClaudeCodeProvider.deliver — the R4 ladder (push → mcp_pull)", () => {
  test("rung 1: an accepted monitor push delivers via 'monitor', transport_accepted, with the exact entry", async () => {
    const pushed: DeliverableEntry[] = [];
    const provider = new ClaudeCodeProvider({
      liveness: liveness(),
      pushAvailable: () => true,
      sendPush: async (_session, entry) => {
        pushed.push(entry);
        return true;
      },
    });
    const result = await provider.deliver(SESSION, ENTRY);
    expect(result).toEqual({ via: "monitor", outcome: "transport_accepted" });
    expect(pushed[0]).toBe(ENTRY); // exact bounded presentation; no provider-side summary
  });

  test("rung 1 declined (stream present but rejects/times out) falls through to mcp_pull", async () => {
    const provider = new ClaudeCodeProvider({
      liveness: liveness(),
      pushAvailable: () => true,
      sendPush: async () => false,
    });
    expect(await provider.deliver(SESSION, ENTRY)).toEqual({ via: "mcp_pull", outcome: "attempted" });
  });

  test("a monitor send that throws records outcome:'failed' for that rung (does not silently fall back)", async () => {
    const provider = new ClaudeCodeProvider({
      liveness: liveness(),
      pushAvailable: () => true,
      sendPush: async () => {
        throw new Error("ECONNRESET");
      },
    });
    const result = await provider.deliver(SESSION, ENTRY);
    expect(result).toEqual({ via: "monitor", outcome: "failed", error: "ECONNRESET" });
  });

  // --- Monitor-OFF fallback: the configuration every telemetry-off / non-interactive session is in. ---
  describe("no connected monitor — MCP pull still delivers", () => {
    test("no pushAvailable/sendPush deps at all → straight to mcp_pull", async () => {
      const provider = new ClaudeCodeProvider({ liveness: liveness() });
      expect(await provider.deliver(SESSION, ENTRY)).toEqual({ via: "mcp_pull", outcome: "attempted" });
    });

    test("pushAvailable() false → the sender is never called even though it exists", async () => {
      let sendCalled = false;
      const provider = new ClaudeCodeProvider({
        liveness: liveness(),
        pushAvailable: () => false,
        sendPush: async () => {
          sendCalled = true;
          return true;
        },
      });
      const result = await provider.deliver(SESSION, ENTRY);
      expect(sendCalled).toBe(false);
      expect(result).toEqual({ via: "mcp_pull", outcome: "attempted" });
    });

    test("a declared push with no sender attached falls through to mcp_pull", async () => {
      const provider = new ClaudeCodeProvider({ liveness: liveness(), pushAvailable: () => true });
      expect(await provider.deliver(SESSION, ENTRY)).toEqual({ via: "mcp_pull", outcome: "attempted" });
    });

    test("every capability false → outcome:'failed', not a thrown promise", async () => {
      class NoCapabilityProvider extends ClaudeCodeProvider {
        override capabilities() {
          return { push: false, mcpPull: false };
        }
      }
      const provider = new NoCapabilityProvider({ liveness: liveness() });
      expect(await provider.deliver(SESSION, ENTRY)).toEqual({
        via: "mcp_pull",
        outcome: "failed",
        error: "no_capability_available",
      });
    });
  });

  test("the provider never emits a removed transport (channel/asyncRewake/gate/stop/userprompt)", async () => {
    const removed = new Set(["channel", "asyncRewake", "gate", "stop", "userprompt"]);
    const providers = [
      new ClaudeCodeProvider({ liveness: liveness() }),
      new ClaudeCodeProvider({ liveness: liveness(), pushAvailable: () => true, sendPush: async () => true }),
      new ClaudeCodeProvider({ liveness: liveness(), pushAvailable: () => true, sendPush: async () => false }),
    ];
    for (const provider of providers) expect(removed.has((await provider.deliver(SESSION, ENTRY)).via)).toBe(false);
  });
});

describe("provider-owned recovery discovery", () => {
  test("MCP identity comes only from the provider environment", () => {
    expect(discoverClaudeMcpSession({ CLAUDE_CODE_SESSION_ID: "exact-id" }, "/agent")).toEqual({
      session_id: "exact-id",
      provider: "claude-code",
      cwd: "/agent",
    });
    expect(discoverClaudeMcpSession({}, "/agent")).toBeNull();
  });
  test("exact transcript discovery retries missing files and rejects ambiguity and symlink escape", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "glosa-provider-discovery-")));
    const first = join(root, "first");
    const second = join(root, "second");
    mkdirSync(first);
    mkdirSync(second);
    const provider = new ClaudeCodeProvider({ liveness: liveness(), transcriptRoots: () => [first, second] });
    const session = { session_id: "exact-id", workspace: "/agent/path", source: "mcp" };
    const relative = join("projects", "-agent-path", "exact-id.jsonl");
    try {
      expect(provider.transcriptPath(session)).toBeNull();
      for (const base of [first, second]) mkdirSync(dirname(join(base, relative)), { recursive: true });
      writeFileSync(join(first, relative), "{}\n");
      expect(provider.transcriptPath(session)).toBe(join(first, relative));
      writeFileSync(join(second, relative), "{}\n");
      expect(provider.transcriptPath(session)).toBeNull();
      rmSync(join(second, relative));
      rmSync(join(first, relative));
      const outside = join(root, "outside.jsonl");
      writeFileSync(outside, "{}\n");
      symlinkSync(outside, join(first, relative));
      expect(provider.transcriptPath(session)).toBeNull();
      expect(provider.transcriptPath({ ...session, session_id: "../escape" })).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

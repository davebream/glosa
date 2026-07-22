// SPDX-License-Identifier: Apache-2.0
// P4.3 — the Claude Code AgentProvider's interface conformance + the R4 delivery ladder,
// including the channels-OFF fallback (a SEPARATE gate from a channel smoke test, per R4: "all
// delivery tests pass with channels disabled"). The real channel-push-into-an-idle-Claude-session
// and the real asyncRewake watcher process are the P5.4 rehearsal's job (they need a live Claude
// Code session) — everything here proves the LADDER LOGIC with every transport injected.
import { describe, expect, test } from "bun:test";
import { ClaudeCodeProvider, type SessionLivenessSource } from "../src/provider.ts";
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

  test("capabilities reports the full Claude Code v1 set (R7: push/gate/boundaryDrain/mcpPull all true)", () => {
    const provider = new ClaudeCodeProvider({ liveness: liveness() });
    expect(provider.capabilities(SESSION)).toEqual({ push: true, gate: true, boundaryDrain: true, mcpPull: true });
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

describe("ClaudeCodeProvider.deliver — the R4 ladder", () => {
  test("rung 1: an accepted channel notification delivers via 'channel', no fallback attempted", async () => {
    let calledSignalWatcher = false;
    const channelEntries: DeliverableEntry[] = [];
    const provider = new ClaudeCodeProvider({
      liveness: liveness(),
      channelsEnabled: () => true,
      sendChannel: async (_session, entry) => {
        channelEntries.push(entry);
        return true;
      },
      watcherArmed: () => true,
      signalWatcher: async () => {
        calledSignalWatcher = true;
        return true;
      },
    });
    const result = await provider.deliver(SESSION, ENTRY);
    expect(result).toEqual({ via: "channel", outcome: "transport_accepted" });
    expect(channelEntries[0]).toBe(ENTRY); // exact bounded presentation; no provider-side summary
    expect(calledSignalWatcher).toBe(false);
  });

  test("rung 1 not accepted (channel present but rejects) falls through to rung 2", async () => {
    const provider = new ClaudeCodeProvider({
      liveness: liveness(),
      channelsEnabled: () => true,
      sendChannel: async () => false,
      watcherArmed: () => true,
      signalWatcher: async () => true,
    });
    const result = await provider.deliver(SESSION, ENTRY);
    expect(result.via).toBe("asyncRewake");
    expect(result.outcome).toBe("transport_accepted");
  });

  test("a channel send that throws records outcome:'failed' for that rung (does not silently fall back)", async () => {
    const provider = new ClaudeCodeProvider({
      liveness: liveness(),
      channelsEnabled: () => true,
      sendChannel: async () => {
        throw new Error("ECONNRESET");
      },
    });
    const result = await provider.deliver(SESSION, ENTRY);
    expect(result.via).toBe("channel");
    expect(result.outcome).toBe("failed");
    expect(result.error).toBe("ECONNRESET");
  });

  test("rung 2: asyncRewake signals the armed watcher when channels are unavailable", async () => {
    const provider = new ClaudeCodeProvider({
      liveness: liveness(),
      watcherArmed: () => true,
      signalWatcher: async () => true,
    });
    const result = await provider.deliver(SESSION, ENTRY);
    expect(result).toEqual({ via: "asyncRewake", outcome: "transport_accepted" });
  });

  // --- Channels-OFF fallback: a SEPARATE gate from the channel smoke test (R4). ---
  describe("channels disabled — the fallback rungs still deliver", () => {
    test("no channelsEnabled/sendChannel deps at all → falls straight to the gate/boundary rung", async () => {
      const provider = new ClaudeCodeProvider({ liveness: liveness() });
      const result = await provider.deliver(SESSION, ENTRY);
      expect(result).toEqual({ via: "gate", outcome: "attempted" });
    });

    test("channelsEnabled() returns false → rung 1 is skipped even though sendChannel exists", async () => {
      let sendChannelCalled = false;
      const provider = new ClaudeCodeProvider({
        liveness: liveness(),
        channelsEnabled: () => false,
        sendChannel: async () => {
          sendChannelCalled = true;
          return true;
        },
      });
      const result = await provider.deliver(SESSION, ENTRY);
      expect(sendChannelCalled).toBe(false);
      expect(result.via).not.toBe("channel");
      expect(result.outcome).toBe("attempted");
    });

    test("channels AND asyncRewake both unavailable → rung 3 (gate) delivers", async () => {
      const provider = new ClaudeCodeProvider({ liveness: liveness(), watcherArmed: () => false });
      const result = await provider.deliver(SESSION, ENTRY);
      expect(result).toEqual({ via: "gate", outcome: "attempted" });
    });

    test("gate/boundaryDrain both false → falls to rung 4 mcp_pull", async () => {
      const provider = new ClaudeCodeProvider({ liveness: liveness() });
      // capabilities() is fixed on this provider (always all-true) — simulate a boundary-less
      // fallback by exercising deliver() through a provider whose capabilities() we override.
      class NoBoundaryProvider extends ClaudeCodeProvider {
        override capabilities() {
          return { push: false, gate: false, boundaryDrain: false, mcpPull: true };
        }
      }
      const noBoundary = new NoBoundaryProvider({ liveness: liveness() });
      const result = await noBoundary.deliver(SESSION, ENTRY);
      expect(result).toEqual({ via: "mcp_pull", outcome: "attempted" });
    });

    test("every capability false → outcome:'failed', not a thrown promise", async () => {
      class NoCapabilityProvider extends ClaudeCodeProvider {
        override capabilities() {
          return { push: false, gate: false, boundaryDrain: false, mcpPull: false };
        }
      }
      const provider = new NoCapabilityProvider({ liveness: liveness() });
      const result = await provider.deliver(SESSION, ENTRY);
      expect(result).toEqual({ via: "gate", outcome: "failed", error: "no_capability_available" });
    });
  });
});

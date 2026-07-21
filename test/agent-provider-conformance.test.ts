import { describe, expect, test } from "bun:test";
import type { AgentProvider, SessionBinding } from "@glosa/daemon";
import { ClaudeCodeProvider } from "@glosa/providers-claude-code";
import { CodexProvider } from "@glosa/providers-codex";

// P4.4 — R7's whole point: "one interface, two providers, adding a CLI is a new provider never a
// core change." That claim is only actually proven by running BOTH real providers through the
// exact same interface-shape assertions from a test that knows nothing provider-specific — a
// per-package suite proving "MY provider satisfies AgentProvider" isn't the same claim as "the SAME
// assertions pass for every provider," which is what this file checks. Lives at the repo root
// (not inside either provider package) precisely so it can import both without either depending on
// the other.
const SESSION: SessionBinding = { session_id: "sess-1", workspace: "/repo", source: "startup" };
const ENTRY = { id: "inb-1", kind: "annotation" as const };

const providers: { name: string; make: () => AgentProvider }[] = [
  {
    name: "claude-code",
    make: () => new ClaudeCodeProvider({ liveness: { liveness: () => "alive" } }),
  },
  {
    name: "codex",
    make: () => new CodexProvider({ liveness: { liveness: () => "alive" } }),
  },
];

// Deliberately a plain loop, not `describe.each` (not an established pattern elsewhere in this
// repo, and bun:test's support for it isn't worth being the first thing to depend on it) — each
// provider gets its own `describe` block running the exact same assertion bodies.
for (const { name, make } of providers) {
  describe(`AgentProvider conformance — ${name}`, () => {
    test("exposes a stable, non-empty `id`", () => {
      const provider = make();
      expect(typeof provider.id).toBe("string");
      expect(provider.id.length).toBeGreaterThan(0);
    });

    test("detectSession is a pure function: null for garbage, a SessionBinding for a session_id+cwd payload", () => {
      const provider = make();
      expect(provider.detectSession(null)).toBeNull();
      expect(provider.detectSession("not an object")).toBeNull();
      expect(provider.detectSession({})).toBeNull();
      const detected = provider.detectSession({ session_id: "abc", cwd: "/repo" });
      expect(detected).not.toBeNull();
      expect(detected?.session_id).toBe("abc");
      expect(detected?.workspace).toBe("/repo");
      expect(typeof detected?.source).toBe("string");
    });

    test("capabilities() returns all four R7 fields as booleans", () => {
      const provider = make();
      const caps = provider.capabilities(SESSION);
      expect(typeof caps.push).toBe("boolean");
      expect(typeof caps.gate).toBe("boolean");
      expect(typeof caps.boundaryDrain).toBe("boolean");
      expect(typeof caps.mcpPull).toBe("boolean");
    });

    test("liveness() returns 'alive' or 'stale', never throws for an unknown session", () => {
      const provider = make();
      expect(["alive", "stale"]).toContain(provider.liveness(SESSION));
      expect(["alive", "stale"]).toContain(provider.liveness({ ...SESSION, session_id: "unknown" }));
    });

    test("transcriptPath() returns a string or null, never throws", () => {
      const provider = make();
      const path = provider.transcriptPath(SESSION);
      expect(path === null || typeof path === "string").toBe(true);
    });

    test("deliver() resolves to a DeliveryResult with a legal A5 §F23 `via`/`outcome`, never rejects", async () => {
      const provider = make();
      const result = await provider.deliver(SESSION, ENTRY);
      expect(["channel", "asyncRewake", "gate", "stop", "userprompt", "mcp_pull"]).toContain(result.via);
      expect(["attempted", "transport_accepted", "presented", "failed"]).toContain(result.outcome);
    });
  });
}

// R7 verbatim: "v1 ships: Claude Code provider (deep: push=channels, ...) and a Codex provider
// (gate + boundaryDrain + mcpPull; push=false — no channels-equivalent)." This is the one place
// that literal claim is checked against both real providers side by side, not per-package.
describe("Claude Code vs Codex — the R7 capability split is real, not just documented", () => {
  test("Claude Code has push (channels); Codex does not", () => {
    const claude = new ClaudeCodeProvider({ liveness: { liveness: () => "alive" } });
    const codex = new CodexProvider({ liveness: { liveness: () => "alive" } });
    expect(claude.capabilities(SESSION).push).toBe(true);
    expect(codex.capabilities(SESSION).push).toBe(false);
  });

  test("both agree on gate + boundaryDrain + mcpPull all true", () => {
    const claude = new ClaudeCodeProvider({ liveness: { liveness: () => "alive" } });
    const codex = new CodexProvider({ liveness: { liveness: () => "alive" } });
    for (const provider of [claude, codex]) {
      const caps = provider.capabilities(SESSION);
      expect(caps.gate).toBe(true);
      expect(caps.boundaryDrain).toBe(true);
      expect(caps.mcpPull).toBe(true);
    }
  });
});

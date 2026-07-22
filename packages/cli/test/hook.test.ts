// SPDX-License-Identifier: Apache-2.0
// P4.3 — `glosa hook <event>` handlers. Every test injects a FAKE `DaemonHookClient` (an
// in-memory recorder — no live daemon, no HTTP) alongside a REAL `RewakeCoordinator`/
// `RewakeLeaseStore` (tmp dir), per the task brief: "each calls the daemon API (mock/ensureDaemon),
// never writes the transcript." The real HTTP-backed `DaemonHookClient` is exercised indirectly by
// sessions-routes.test.ts (the routes it calls) — wiring the two together end-to-end against a
// live spawned daemon is the P5.4 rehearsal's job.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RewakeCoordinator, RewakeLeaseStore } from "@glosa/providers-claude-code";
import { runHook, type HookDeps } from "../src/hook.ts";
import type { DaemonHookClient, DrainedEntry, DrainOptions, DrainResult, RegisterSessionInput, RegisterSessionResult } from "../src/daemon-client.ts";

let dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "glosa-hook-test-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

/** An in-memory `DaemonHookClient` — records every call so tests can assert on exactly what a
 * hook handler asked the daemon to do, and lets a test script canned responses (e.g. "the next
 * drain returns these 3 entries") without a real daemon process anywhere in the loop. */
class FakeDaemonClient implements DaemonHookClient {
  calls: { method: string; args: unknown[] }[] = [];
  registered = new Set<string>();
  pendingDrain: DrainResult = { drained: [], count: 0 };

  async register(input: RegisterSessionInput): Promise<RegisterSessionResult> {
    this.calls.push({ method: "register", args: [input] });
    this.registered.add(input.session_id);
    return { workspace: input.workspace_binding ?? input.cwd, drained_workspaces: [] };
  }
  async heartbeat(sessionId: string): Promise<void> {
    this.calls.push({ method: "heartbeat", args: [sessionId] });
  }
  async deregister(sessionId: string): Promise<void> {
    this.calls.push({ method: "deregister", args: [sessionId] });
    this.registered.delete(sessionId);
  }
  async drain(sessionId: string, opts?: DrainOptions): Promise<DrainResult> {
    this.calls.push({ method: "drain", args: [sessionId, opts] });
    const result = this.pendingDrain;
    this.pendingDrain = { drained: [], count: 0 }; // one-shot per call, like the real route
    return result;
  }
}

function actionable(id: string, kind: DrainedEntry["kind"] = "annotation", text = `glosa ${kind} ${id}`): DrainedEntry {
  return {
    id,
    kind,
    status: "pending",
    text,
    bytes: Buffer.byteLength(text, "utf8"),
    detail: {},
    truncation: { truncated: false, omitted_bytes: 0, omitted_hunks: 0 },
    retrieval: { command: `glosa inbox get ${id}`, mcp_tool: "glosa_inbox_get" },
  };
}

function makeDeps(dir: string): { deps: HookDeps; client: FakeDaemonClient; leases: RewakeLeaseStore } {
  const client = new FakeDaemonClient();
  const leases = new RewakeLeaseStore({ dir });
  let nextPid = 5000;
  const rewake = new RewakeCoordinator({ leases, spawnWatcher: () => nextPid++ });
  return { deps: { daemonClient: client, rewake, leases }, client, leases };
}

const SESSION_START_INPUT = {
  session_id: "sess-1",
  cwd: "/repo",
  transcript_path: "/Users/x/.claude/projects/repo/sess-1.jsonl",
  hook_event_name: "SessionStart",
  source: "startup",
};

describe("glosa hook session-start", () => {
  test("registers the session with the daemon and arms the rewake watcher", async () => {
    const { deps, client, leases } = makeDeps(freshDir());
    const outcome = await runHook("session-start", SESSION_START_INPUT, deps);

    expect(outcome.exitCode).toBe(0);
    expect(client.calls[0]).toMatchObject({
      method: "register",
      args: [
        {
          session_id: "sess-1",
          provider: "claude-code",
          cwd: "/repo",
          source: "startup",
          transcript_path: "/Users/x/.claude/projects/repo/sess-1.jsonl",
        },
      ],
    });
    expect(leases.isActive("sess-1")).toBe(true);
  });

  test("drains parked entries immediately and surfaces them as additionalContext", async () => {
    const { deps, client } = makeDeps(freshDir());
    client.pendingDrain = { drained: [actionable("inb-1")], count: 1 };

    const outcome = await runHook("session-start", SESSION_START_INPUT, deps);
    expect(outcome.exitCode).toBe(0);
    const parsed = JSON.parse(outcome.stdout);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("inb-1");
  });

  test("nothing pending -> plain exit 0, no stdout payload", async () => {
    const { deps } = makeDeps(freshDir());
    const outcome = await runHook("session-start", SESSION_START_INPUT, deps);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toBe("");
  });

  test("a malformed hook payload (no session_id) -> usage error, exit 2, never calls the daemon", async () => {
    const { deps, client } = makeDeps(freshDir());
    const outcome = await runHook("session-start", { cwd: "/repo" }, deps);
    expect(outcome.exitCode).toBe(2);
    expect(client.calls).toHaveLength(0);
  });
});

describe("glosa hook session-end", () => {
  test("deregisters the session and releases the rewake lease", async () => {
    const { deps, client, leases } = makeDeps(freshDir());
    await runHook("session-start", SESSION_START_INPUT, deps);
    expect(leases.isActive("sess-1")).toBe(true);

    const outcome = await runHook("session-end", { session_id: "sess-1", cwd: "/repo", hook_event_name: "SessionEnd" }, deps);
    expect(outcome.exitCode).toBe(0);
    expect(client.calls.some((c) => c.method === "deregister" && c.args[0] === "sess-1")).toBe(true);
    expect(leases.isActive("sess-1")).toBe(false);
  });
});

describe("glosa hook user-prompt-submit", () => {
  test("heartbeats then drains, surfacing additionalContext when something is pending", async () => {
    const { deps, client } = makeDeps(freshDir());
    client.pendingDrain = { drained: [actionable("inb-2", "human_edit")], count: 1 };

    const outcome = await runHook(
      "user-prompt-submit",
      { session_id: "sess-1", cwd: "/repo", hook_event_name: "UserPromptSubmit" },
      deps,
    );
    expect(outcome.exitCode).toBe(0);
    expect(client.calls.map((c) => c.method)).toEqual(["heartbeat", "drain"]);
    expect(JSON.parse(outcome.stdout).hookSpecificOutput.additionalContext).toContain("inb-2");
  });
});

describe("glosa hook stop", () => {
  test("heartbeats, drains bounded to 8, and rearms the watcher", async () => {
    const { deps, client, leases } = makeDeps(freshDir());
    const outcome = await runHook("stop", { session_id: "sess-1", cwd: "/repo", hook_event_name: "Stop" }, deps);

    expect(outcome.exitCode).toBe(0);
    const drainCall = client.calls.find((c) => c.method === "drain");
    expect(drainCall?.args).toEqual(["sess-1", { limit: 8, via: "stop" }]);
    expect(leases.isActive("sess-1")).toBe(true); // rearmed
  });

  test("rearm across THREE sequential Stop cycles never leaves more than one active watcher (A2 §F07)", async () => {
    const { deps, leases } = makeDeps(freshDir());
    await runHook("session-start", SESSION_START_INPUT, deps); // watcher #1 armed
    const firstPid = leases.read("sess-1")?.pid;

    for (let i = 0; i < 3; i++) {
      // Simulate the one-shot watcher exiting (releasing its own lease) before Stop fires.
      const current = leases.read("sess-1");
      leases.release("sess-1", current?.pid as number);
      expect(leases.isActive("sess-1")).toBe(false);

      await runHook("stop", { session_id: "sess-1", cwd: "/repo", hook_event_name: "Stop" }, deps);
      expect(leases.isActive("sess-1")).toBe(true);
    }

    const finalPid = leases.read("sess-1")?.pid;
    expect(finalPid).not.toBe(firstPid); // a genuinely fresh watcher each time
  });

  test("a Stop hook while the watcher is still armed does not spawn a duplicate", async () => {
    const { deps, leases } = makeDeps(freshDir());
    await runHook("session-start", SESSION_START_INPUT, deps);
    const armedPid = leases.read("sess-1")?.pid;

    await runHook("stop", { session_id: "sess-1", cwd: "/repo", hook_event_name: "Stop" }, deps);
    expect(leases.read("sess-1")?.pid).toBe(armedPid); // unchanged — no rearm needed
  });
});

describe("glosa hook rewake-watch", () => {
  test("finds a pending entry immediately -> exit 2 with the F07 stderr shape, releases its own lease", async () => {
    const { deps, client, leases } = makeDeps(freshDir());
    leases.tryAcquire("sess-1", 9001);
    client.pendingDrain = { drained: [actionable("inb-9", "annotation", "glosa annotation inb-9\nretrieve: glosa inbox get inb-9")], count: 1 };

    const outcome = await runHook(
      "rewake-watch",
      { session_id: "sess-1", cwd: "/repo", hook_event_name: "SessionStart", source: "startup" },
      deps,
      9001,
    );

    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr).toContain("glosa inbox get inb-9");
    expect(leases.isActive("sess-1")).toBe(false); // released promptly, not left for staleMs to expire
  });

  test("nothing pending after exhausting its poll budget -> exit 0", async () => {
    const { deps, leases } = makeDeps(freshDir());
    leases.tryAcquire("sess-1", 9002);

    const outcome = await runHook(
      "rewake-watch",
      { session_id: "sess-1", cwd: "/repo", hook_event_name: "SessionStart", source: "startup" },
      { ...deps, rewakePollAttempts: 3, rewakePollIntervalMs: 0 },
      9002,
    );

    expect(outcome.exitCode).toBe(0);
    expect(leases.isActive("sess-1")).toBe(true); // still armed — nothing told it to stand down
  });
});

describe("glosa hook notification", () => {
  test("heartbeats the session, exit 0", async () => {
    const { deps, client } = makeDeps(freshDir());
    const outcome = await runHook("notification", { session_id: "sess-1", cwd: "/repo", hook_event_name: "Notification" }, deps);
    expect(outcome.exitCode).toBe(0);
    expect(client.calls[0]).toMatchObject({ method: "heartbeat", args: ["sess-1"] });
  });
});

describe("glosa hook — unknown event", () => {
  test("an unrecognized event name is a usage error, never touches the daemon", async () => {
    const { deps, client } = makeDeps(freshDir());
    const outcome = await runHook("not-a-real-event", { session_id: "sess-1", cwd: "/repo" }, deps);
    expect(outcome.exitCode).toBe(2);
    expect(client.calls).toHaveLength(0);
  });
});

describe("glosa hook — Codex provider", () => {
  test("Stop registers Codex semantics and emits a non-empty blocking presentation", async () => {
    const { deps, client, leases } = makeDeps(freshDir());
    client.pendingDrain = {
      delivery_id: "delivery-1",
      count: 1,
      drained: [
        actionable("inb-codex", "annotation", "glosa annotation inb-codex\nartifact: notes.md\ncomment:\nFix this."),
      ],
    };
    const input = { ...SESSION_START_INPUT, turn_id: "turn-1", hook_event_name: "Stop" };
    const outcome = await runHook("stop", input, deps, 1, "codex");
    const parsed = JSON.parse(outcome.stdout);
    expect(parsed).toEqual({ decision: "block", reason: expect.stringContaining("Fix this.") });
    expect(outcome.delivery).toEqual({ sessionId: "sess-1", deliveryId: "delivery-1" });
    expect(leases.isActive("sess-1")).toBe(false);
  });

  test("SessionStart registers provider codex and does not arm Claude's rewake watcher", async () => {
    const { deps, client, leases } = makeDeps(freshDir());
    await runHook("session-start", SESSION_START_INPUT, deps, 1, "codex");
    expect(client.calls[0]).toMatchObject({ method: "register", args: [expect.objectContaining({ provider: "codex" })] });
    expect(leases.isActive("sess-1")).toBe(false);
  });
});

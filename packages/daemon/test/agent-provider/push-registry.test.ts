// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import type { DeliverableEntry } from "../../src/agent-provider/interface.ts";
import { SessionPushRegistry } from "../../src/agent-provider/push-registry.ts";
import {
  MAX_SIGNALS_PER_SESSION,
  planSignals,
  SIGNAL_TTL_MS,
  type SignalFrame,
  SignalRegistry,
} from "../../src/agent-provider/signal-registry.ts";
import type { JournalEvent } from "../../src/bus/journal.ts";

function conversation(id: string, target: string): DeliverableEntry {
  const message = `message ${id}`;
  const text = `glosa conversation_message ${id}\nmessage:\n${message}`;
  return {
    id,
    kind: "conversation_message",
    status: "pending",
    text,
    bytes: Buffer.byteLength(text, "utf8"),
    message,
    message_bytes: Buffer.byteLength(message, "utf8"),
    target_session_id: target,
    provider: "claude-code",
    detail: { target_session_id: target, provider: "claude-code" },
    truncation: { truncated: false, omitted_bytes: 0, omitted_hunks: 0 },
    retrieval: { command: `glosa inbox get ${id}`, mcp_tool: "glosa_inbox_get" },
  };
}

describe("SessionPushRegistry", () => {
  test("only an active exact-session bridge is available and transport acceptance requires its ack", async () => {
    const registry = new SessionPushRegistry();
    const seen: string[] = [];
    const entry = conversation("message-1", "session-a");
    expect(await registry.send("session-a", entry, 1)).toBe(false);

    const unregister = registry.register("session-a", (value) => seen.push(value.id), undefined, "monitor");
    const accepted = registry.send("session-a", entry, 100);
    expect(registry.has("session-a")).toBe(true);
    expect(registry.has("session-b")).toBe(false);
    expect(seen).toEqual(["message-1"]);
    expect(registry.acknowledgeTransport("session-b", entry.id)).toBe(false);
    expect(registry.acknowledgeTransport("session-a", entry.id)).toBe(true);
    expect(await accepted).toBe(true);

    unregister();
    expect(registry.has("session-a")).toBe(false);
  });

  test("one monitor connection coalesces concurrent sends and remembers transport acceptance", async () => {
    const registry = new SessionPushRegistry();
    const entry = conversation("message-2", "session-a");
    const seen: string[] = [];
    registry.register("session-a", (value) => seen.push(value.id), undefined, "monitor");
    const first = registry.send("session-a", entry, 100);
    const concurrent = registry.send("session-a", entry, 100);
    expect(seen).toEqual(["message-2"]);
    expect(registry.transport("session-a")).toBe("monitor");
    expect(registry.isAwaitingTransport("session-a", entry.id)).toBe(true);
    expect(registry.acknowledgeTransport("session-a", entry.id)).toBe(true);
    expect(await Promise.all([first, concurrent])).toEqual([true, true]);
    expect(await registry.send("session-a", entry, 100)).toBe(true);
    expect(seen).toEqual(["message-2"]);
  });

  test("records a Codex app-server connection as its actual transport", () => {
    const registry = new SessionPushRegistry();
    registry.register("codex-session", () => {}, undefined, "codex_app_server");
    expect(registry.transport("codex-session")).toBe("codex_app_server");
  });
});

// Issue #155 part 2 — session signals. Derived from claim events, addressed to one session each,
// acknowledged only by that session with its own token. Kept beside the push registry that carries
// them rather than in a new file (a new test file repacks the CI partitions).
function claimEvent(event: JournalEvent["event"], detail: Record<string, unknown>, by = "daemon"): JournalEvent {
  return {
    v: 1,
    event_id: `evt-${Math.random()}`,
    at: "2026-09-22T12:00:00.000Z",
    event,
    by: by as JournalEvent["by"],
    detail,
  };
}

describe("planSignals — who hears about a claim event (issue #155)", () => {
  const sessions = ["A", "B", "C"];

  test("a person releasing A's claim tells A as a conflict, and everyone else as info — never A twice", () => {
    const planned = planSignals(
      claimEvent(
        "claim_released",
        { claim_id: "C1", by: "human", holder_session: "A", resources: ["entry:e1"] },
        "human",
      ),
      sessions,
    );
    expect(planned.map((signal) => [signal.target, signal.kind])).toEqual([
      ["A", "conflict"],
      ["B", "info"],
      ["C", "info"],
    ]);
    expect(planned[0]?.message).toContain("a person took over entry:e1");
    expect(planned[0]?.message).toContain("claim-revoked");
  });

  test("the holder releasing its own claim tells only the others", () => {
    const planned = planSignals(
      claimEvent("claim_released", { claim_id: "C1", by: "session", holder_session: "A", resources: ["entry:e1"] }),
      sessions,
    );
    expect(planned.map((signal) => [signal.target, signal.kind])).toEqual([
      ["B", "info"],
      ["C", "info"],
    ]);
  });

  test("a claim taken is info to every other session, never to the one that took it", () => {
    const planned = planSignals(
      claimEvent("claim_taken", { claim_id: "C1", session: "B", mode: "exclusive", resources: ["artifact:notes.md"] }),
      sessions,
    );
    expect(planned.map((signal) => signal.target)).toEqual(["A", "C"]);
    expect(planned[0]?.message).toBe("session B is editing artifact:notes.md (claim C1).");
  });

  test("an expiry is info to its holder only, naming why", () => {
    const planned = planSignals(
      claimEvent("claim_expired", {
        claim_id: "C1",
        holder_session: "A",
        reason: "holder_stale",
        resources: ["entry:e1"],
      }),
      sessions,
    );
    expect(planned.map((signal) => [signal.target, signal.kind])).toEqual([["A", "info"]]);
    expect(planned[0]?.message).toContain("stopped responding");
  });

  test("any other journal event causes nothing", () => {
    expect(planSignals(claimEvent("transition_committed", { to: "applied" }), sessions)).toEqual([]);
    expect(planSignals(claimEvent("claim_renewed", { claim_id: "C1" }), sessions)).toEqual([]);
  });
});

describe("SignalRegistry — addressed, acknowledged by the addressee only (issue #155)", () => {
  function registry(opts: { now?: () => Date; pushed?: Array<[string, SignalFrame]> } = {}) {
    let n = 0;
    return new SignalRegistry({
      sessionsFor: () => ["A", "B"],
      push: (session, frame) => {
        opts.pushed?.push([session, frame]);
        return true;
      },
      now: opts.now,
      id: () => `sig-${++n}`,
      token: () => `token-${n}`,
    });
  }
  const humanRelease = claimEvent(
    "claim_released",
    { claim_id: "C1", by: "human", holder_session: "A", resources: ["entry:e1"] },
    "human",
  );

  test("each addressee gets its own record and token, pushed to it alone", () => {
    const pushed: Array<[string, SignalFrame]> = [];
    const signals = registry({ pushed });
    signals.record("/ws", 7, humanRelease);
    expect(pushed.map(([session, frame]) => [session, frame.kind, frame.id, frame.ack_token])).toEqual([
      ["A", "conflict", "sig-1", "token-1"],
      ["B", "info", "sig-2", "token-2"],
    ]);
    expect(signals.pending("A").map((frame) => frame.id)).toEqual(["sig-1"]);
    expect(signals.pending("B").map((frame) => frame.id)).toEqual(["sig-2"]);
  });

  test("an ack needs the right session AND the right token; a repeat is `already`; an acked signal is no longer pending", () => {
    const signals = registry();
    signals.record("/ws", 7, humanRelease);
    expect(signals.ack("B", "sig-1", "token-1")).toBe("not-found"); // B cannot consume A's signal
    expect(signals.ack("A", "sig-1", "token-2")).toBe("not-found"); // wrong token
    expect(signals.ack("A", "sig-1", "token-1")).toBe("acked");
    expect(signals.ack("A", "sig-1", "token-1")).toBe("already");
    expect(signals.pending("A")).toEqual([]);
    expect(signals.pending("B")).toHaveLength(1);
  });

  test("signals expire after the TTL", () => {
    let now = Date.parse("2026-09-22T12:00:00.000Z");
    const signals = registry({ now: () => new Date(now) });
    signals.record("/ws", 7, humanRelease);
    now += SIGNAL_TTL_MS;
    expect(signals.pending("A")).toEqual([]);
    expect(signals.ack("A", "sig-1", "token-1")).toBe("not-found");
  });

  test("an addressee holds at most MAX_SIGNALS_PER_SESSION, dropping the oldest", () => {
    const signals = registry();
    for (let cursor = 0; cursor < MAX_SIGNALS_PER_SESSION + 5; cursor += 1) {
      signals.record("/ws", cursor, claimEvent("claim_expired", { claim_id: `C${cursor}`, holder_session: "A" }));
    }
    const all = signals.pending("A", { limit: Number.POSITIVE_INFINITY, maxBytes: Number.POSITIVE_INFINITY });
    expect(all).toHaveLength(MAX_SIGNALS_PER_SESSION);
    expect(all[0]?.claim_id).toBe("C5");
  });

  test("a drain's share is bounded by count and bytes, oldest first", () => {
    const signals = registry();
    for (let cursor = 0; cursor < 20; cursor += 1) {
      signals.record("/ws", cursor, claimEvent("claim_expired", { claim_id: `C${cursor}`, holder_session: "A" }));
    }
    expect(signals.pending("A").map((frame) => frame.claim_id)).toEqual([
      "C0",
      "C1",
      "C2",
      "C3",
      "C4",
      "C5",
      "C6",
      "C7",
    ]);
    const one = JSON.stringify(signals.pending("A", { limit: 1 })[0]).length;
    expect(signals.pending("A", { maxBytes: one * 2 + 1 })).toHaveLength(2);
  });
});

describe("SessionPushRegistry.sendSignal", () => {
  test("writes to the session's own stream when it can carry signals, and reports false otherwise", () => {
    const registry = new SessionPushRegistry();
    const frames: string[] = [];
    const frame = { id: "sig-1" } as SignalFrame;
    expect(registry.sendSignal("session-a", frame)).toBe(false); // no stream
    registry.register("session-a", () => {}, undefined, "monitor");
    expect(registry.sendSignal("session-a", frame)).toBe(false); // a stream that cannot carry one
    registry.register(
      "session-a",
      () => {},
      undefined,
      "monitor",
      (value) => frames.push(value.id),
    );
    expect(registry.sendSignal("session-a", frame)).toBe(true);
    expect(frames).toEqual(["sig-1"]);
  });
});

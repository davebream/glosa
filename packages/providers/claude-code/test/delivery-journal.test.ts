// SPDX-License-Identifier: Apache-2.0
// P4.3 — proves the AgentProvider → journal seam end to end: `ClaudeCodeProvider.deliver()`'s
// `DeliveryResult` really does become the correct `delivery_attempt{via, outcome, reason}` on a
// REAL `WorkspaceBus` (A5 §F23), via `recordDelivery()` (the one place R7's return shape maps onto
// the journal). Each rung of the ladder gets its own round-trip so the mapping is proven per-rung,
// not just for the happy path.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceBus, recordDelivery, type DeliveryAttemptRecord, type SessionBinding } from "@glosa/daemon";
import { ClaudeCodeProvider } from "../src/provider.ts";

const SESSION: SessionBinding = { session_id: "sess-1", workspace: "/repo", source: "startup" };

function attemptsOf(bus: WorkspaceBus, entryId: string): DeliveryAttemptRecord[] {
  return (bus.state.entries[entryId]?.deliveryAttempts as DeliveryAttemptRecord[] | undefined) ?? [];
}

function freshWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "glosa-cc-provider-test-"));
}

function cleanupWorkspace(root: string): void {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

describe("ClaudeCodeProvider.deliver() -> recordDelivery -> WorkspaceBus journal", () => {
  test("rung 1 (channel) success is recorded as delivery_attempt{via:'channel', outcome:'transport_accepted', reason:'initial'} — A5 §F23's exact vocabulary, not free text", async () => {
    const root = freshWorkspace();
    const bus = new WorkspaceBus(root);
    await bus.createEntry("inb-1", { kind: "annotation" });

    const provider = new ClaudeCodeProvider({
      liveness: { liveness: () => "alive" },
      channelsEnabled: () => true,
      sendChannel: async () => true,
    });
    const result = await provider.deliver(SESSION, { id: "inb-1", kind: "annotation" });
    await recordDelivery(bus, "inb-1", SESSION, result);

    const attempts = attemptsOf(bus, "inb-1");
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      via: "channel",
      session: "sess-1",
      outcome: "transport_accepted",
      reason: "initial",
    });
    // A5 §F23: delivery_attempt never touches status.
    expect(bus.state.entries["inb-1"]?.status).toBe("pending");

    await bus.close();
    cleanupWorkspace(root);
  });

  test("a failed rung (channel throws) is recorded as outcome:'failed' with the error message", async () => {
    const root = freshWorkspace();
    const bus = new WorkspaceBus(root);
    await bus.createEntry("inb-1", { kind: "annotation" });

    const provider = new ClaudeCodeProvider({
      liveness: { liveness: () => "alive" },
      channelsEnabled: () => true,
      sendChannel: async () => {
        throw new Error("channel closed");
      },
    });
    const result = await provider.deliver(SESSION, { id: "inb-1", kind: "annotation" });
    await recordDelivery(bus, "inb-1", SESSION, result);

    expect(attemptsOf(bus, "inb-1")[0]).toMatchObject({
      via: "channel",
      outcome: "failed",
      error: "channel closed",
    });

    await bus.close();
    cleanupWorkspace(root);
  });

  test("channels-OFF: the fallback rung's delivery_attempt still records a legal A5 §F23 outcome — the durable inbox survives regardless", async () => {
    const root = freshWorkspace();
    const bus = new WorkspaceBus(root);
    await bus.createEntry("inb-1", { kind: "human_edit" });

    // No channelsEnabled/sendChannel/watcherArmed deps at all — channels + asyncRewake both
    // structurally unavailable, exactly the "channels disabled" configuration R4 requires every
    // delivery test to also pass under.
    const provider = new ClaudeCodeProvider({ liveness: { liveness: () => "alive" } });
    const result = await provider.deliver(SESSION, { id: "inb-1", kind: "human_edit" });
    await recordDelivery(bus, "inb-1", SESSION, result);

    const attempt = attemptsOf(bus, "inb-1")[0];
    expect(attempt).toMatchObject({ via: "gate", outcome: "attempted", reason: "initial" });
    expect(bus.state.entries["inb-1"]?.status).toBe("pending"); // still durable, untouched

    await bus.close();
    cleanupWorkspace(root);
  });

  test("a repeat deliver() (re-nudge) appends a SECOND delivery_attempt with reason:'re_nudge', never a duplicate entry_created or a status change", async () => {
    const root = freshWorkspace();
    const bus = new WorkspaceBus(root);
    await bus.createEntry("inb-1", { kind: "annotation" });
    const provider = new ClaudeCodeProvider({ liveness: { liveness: () => "alive" } });

    for (let i = 0; i < 2; i++) {
      const result = await provider.deliver(SESSION, { id: "inb-1", kind: "annotation" });
      await recordDelivery(bus, "inb-1", SESSION, result);
    }

    const attempts = attemptsOf(bus, "inb-1");
    expect(attempts).toHaveLength(2);
    // The FIRST attempt for this entry is "initial"; the second (a re-nudge of the same,
    // still-undelivered entry) is "re_nudge" — R3: "re-nudging a delivered entry emits attempts."
    expect(attempts[0]?.reason).toBe("initial");
    expect(attempts[1]?.reason).toBe("re_nudge");
    expect(bus.state.entries["inb-1"]?.status).toBe("pending");

    await bus.close();
    cleanupWorkspace(root);
  });

  test("every delivery_attempt.detail field carries only A5 §F23-legal values — no free text in via/outcome/reason", async () => {
    const root = freshWorkspace();
    const bus = new WorkspaceBus(root);
    await bus.createEntry("inb-1", { kind: "annotation" });

    const LEGAL_VIA = new Set(["channel", "asyncRewake", "gate", "stop", "userprompt", "mcp_pull"]);
    const LEGAL_OUTCOME = new Set(["attempted", "transport_accepted", "presented", "failed"]);
    const LEGAL_REASON = new Set(["initial", "re_nudge"]);

    const provider = new ClaudeCodeProvider({
      liveness: { liveness: () => "alive" },
      channelsEnabled: () => true,
      sendChannel: async () => true,
    });
    const result = await provider.deliver(SESSION, { id: "inb-1", kind: "annotation" });
    await recordDelivery(bus, "inb-1", SESSION, result);

    const attempt = attemptsOf(bus, "inb-1")[0];
    expect(LEGAL_VIA.has(attempt?.via as string)).toBe(true);
    expect(LEGAL_OUTCOME.has(attempt?.outcome as string)).toBe(true);
    expect(LEGAL_REASON.has(attempt?.reason as string)).toBe(true);

    await bus.close();
    cleanupWorkspace(root);
  });
});

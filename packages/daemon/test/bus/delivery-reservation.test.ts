// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, test } from "bun:test";
import { WorkspaceBus } from "../../src/bus/bus.ts";
import {
  buildDeliveryPresentation,
  formatPresentationBatch,
  MAX_BATCH_PRESENTATION_BYTES,
  utf8Bytes,
} from "../../src/delivery/presentation.ts";
import { cleanupWorkspace, deterministicClock, deterministicUlid, freshWorkspace } from "./helpers.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(cleanupWorkspace));

function payload() {
  return {
    kind: "annotation",
    artifact_path: "notes.md",
    body: "Please clarify this sentence.",
    intent: "content",
    target: { quote: { exact: "sentence" }, position: { start: 1, end: 9 } },
  };
}

describe("two-phase delivery reservations", () => {
  test("targeted conversation messages drain and acknowledge only for the exact session", async () => {
    const root = freshWorkspace();
    roots.push(root);
    const bus = new WorkspaceBus(root, { ulid: deterministicUlid(), now: deterministicClock() });
    await bus.createEntry("message-1", {
      kind: "conversation_message",
      text: "exact target only",
      target_session_id: "session-a",
      provider: "claude-code",
    });
    const build = (id: string, value: unknown, status: string) =>
      buildDeliveryPresentation(id, value, { status });

    expect((await bus.prepareDelivery(8, { via: "mcp_pull", session: "session-b" }, build)).count).toBe(0);
    expect(
      await bus.acknowledgeConversationMessage("message-1", {
        session: "session-b",
        via: "mcp_pull",
        outcome: "presented",
      }),
    ).toBe(false);
    expect(bus.state.entries["message-1"]?.status).toBe("pending");

    const prepared = await bus.prepareDelivery(8, { via: "mcp_pull", session: "session-a" }, build);
    expect(prepared.drained).toHaveLength(1);
    expect(await bus.acknowledgeDelivery(prepared.delivery_id!, "presented")).toBe(true);
    expect(bus.state.entries["message-1"]?.status).toBe("delivered");
  });

  test("a pending conversation target survives journal replay after daemon restart", async () => {
    const root = freshWorkspace();
    roots.push(root);
    const first = new WorkspaceBus(root, { ulid: deterministicUlid(), now: deterministicClock() });
    await first.createEntry("message-restart", {
      kind: "conversation_message",
      text: "survive restart",
      target_session_id: "session-a",
      provider: "codex",
    });
    await first.recordDeliveryAttempt("message-restart", {
      via: "gate",
      session: "session-a",
      outcome: "attempted",
      reason: "initial",
      fsync: true,
    });
    await first.close();

    const restarted = new WorkspaceBus(root, { ulid: deterministicUlid(), now: deterministicClock() });
    await restarted.reconcile();
    const build = (id: string, value: unknown, status: string) =>
      buildDeliveryPresentation(id, value, { status });
    expect(restarted.state.entries["message-restart"]?.status).toBe("pending");
    expect((await restarted.prepareDelivery(8, { via: "mcp_pull", session: "session-b" }, build)).count).toBe(0);
    expect((await restarted.prepareDelivery(8, { via: "mcp_pull", session: "session-a" }, build)).count).toBe(1);
    await restarted.close();
  });

  test("Channel transport and presentation are one initial attempt; repeated terminal ack is idempotent", async () => {
    const root = freshWorkspace();
    roots.push(root);
    const bus = new WorkspaceBus(root, { ulid: deterministicUlid(), now: deterministicClock() });
    await bus.createEntry("message-channel", {
      kind: "conversation_message",
      text: "ack once",
      target_session_id: "session-a",
      provider: "claude-code",
    });
    expect(
      await bus.acknowledgeConversationMessage("message-channel", {
        session: "session-a",
        via: "channel",
        outcome: "transport_accepted",
      }),
    ).toBe(true);
    expect(
      await bus.acknowledgeConversationMessage("message-channel", {
        session: "session-a",
        via: "channel",
        outcome: "presented",
      }),
    ).toBe(true);
    expect(
      await bus.acknowledgeConversationMessage("message-channel", {
        session: "session-a",
        via: "channel",
        outcome: "presented",
      }),
    ).toBe(true);
    expect(bus.state.entries["message-channel"]?.status).toBe("delivered");
    expect(bus.state.entries["message-channel"]?.deliveryAttempts).toEqual([
      expect.objectContaining({ outcome: "transport_accepted", reason: "initial" }),
      expect.objectContaining({ outcome: "presented", reason: "initial" }),
    ]);
  });

  test("prepare reserves without claiming presentation; ack writes presented afterward", async () => {
    const root = freshWorkspace();
    roots.push(root);
    const bus = new WorkspaceBus(root, { ulid: deterministicUlid(), now: deterministicClock() });
    await bus.createEntry("e1", payload());
    const prepared = await bus.prepareDelivery(8, { via: "stop", session: "s1" }, (id, value, status) =>
      buildDeliveryPresentation(id, value, { status }),
    );
    expect(prepared.count).toBe(1);
    expect(bus.state.entries.e1?.deliveryAttempts).toHaveLength(0);

    const concurrent = await bus.prepareDelivery(8, { via: "stop", session: "s2" }, (id, value, status) =>
      buildDeliveryPresentation(id, value, { status }),
    );
    expect(concurrent.count).toBe(0);

    expect(await bus.acknowledgeDelivery(prepared.delivery_id!, "presented")).toBe(true);
    expect(bus.state.entries.e1?.deliveryAttempts).toEqual([
      expect.objectContaining({ via: "stop", session: "s1", outcome: "presented", reason: "initial" }),
    ]);
  });

  test("failed output stays eligible and the retry is a re_nudge", async () => {
    const root = freshWorkspace();
    roots.push(root);
    const bus = new WorkspaceBus(root, { ulid: deterministicUlid(), now: deterministicClock() });
    await bus.createEntry("e1", payload());
    const build = (id: string, value: unknown, status: string) => buildDeliveryPresentation(id, value, { status });
    const first = await bus.prepareDelivery(8, { via: "mcp_pull", session: "m1" }, build);
    await bus.acknowledgeDelivery(first.delivery_id!, "failed", "EPIPE");
    const retry = await bus.prepareDelivery(8, { via: "mcp_pull", session: "m2" }, build);
    await bus.acknowledgeDelivery(retry.delivery_id!, "presented");
    expect(bus.state.entries.e1?.deliveryAttempts).toEqual([
      expect.objectContaining({ outcome: "failed", reason: "initial", error: "EPIPE" }),
      expect.objectContaining({ outcome: "presented", reason: "re_nudge" }),
    ]);
  });

  test("malformed legacy payload remains pending and records a precise failed attempt", async () => {
    const root = freshWorkspace();
    roots.push(root);
    const bus = new WorkspaceBus(root, { ulid: deterministicUlid(), now: deterministicClock() });
    await bus.createEntry("legacy", { kind: "annotation" });
    const prepared = await bus.prepareDelivery(8, { via: "stop", session: "s1" }, (id, value, status) =>
      buildDeliveryPresentation(id, value, { status }),
    );
    expect(prepared.count).toBe(0);
    expect(bus.state.entries.legacy?.status).toBe("pending");
    expect(bus.state.entries.legacy?.deliveryAttempts).toEqual([
      expect.objectContaining({ outcome: "failed", error: "entry_payload_not_actionable" }),
    ]);
  });

  test("batch accounting includes separators, stays under 32 KiB, and remains oldest-first", async () => {
    const root = freshWorkspace();
    roots.push(root);
    const bus = new WorkspaceBus(root, { ulid: deterministicUlid(), now: deterministicClock() });
    for (let i = 0; i < 5; i++) await bus.createEntry(`e${i}`, { ...payload(), body: `${i}:${"ż".repeat(5_000)}` });
    const prepared = await bus.prepareDelivery(8, { via: "stop", session: "s1" }, (id, value, status) =>
      buildDeliveryPresentation(id, value, { status }),
    );
    expect(prepared.drained.map((entry) => entry.id)).toEqual(["e0", "e1", "e2"]);
    expect(prepared.has_more).toBe(true);
    expect(utf8Bytes(formatPresentationBatch(prepared.drained))).toBeLessThanOrEqual(MAX_BATCH_PRESENTATION_BYTES);
  });

  test("an expired reservation becomes eligible again without a false presented attempt", async () => {
    const root = freshWorkspace();
    roots.push(root);
    let nowMs = 1_700_000_000_000;
    const bus = new WorkspaceBus(root, { ulid: deterministicUlid(), now: () => new Date(nowMs) });
    await bus.createEntry("e1", payload());
    const build = (id: string, value: unknown, status: string) => buildDeliveryPresentation(id, value, { status });
    const first = await bus.prepareDelivery(8, { via: "stop", session: "s1" }, build);
    nowMs += 30_001;
    const retry = await bus.prepareDelivery(8, { via: "stop", session: "s2" }, build);
    expect(first.delivery_id).not.toBe(retry.delivery_id);
    expect(retry.drained.map((entry) => entry.id)).toEqual(["e1"]);
    expect(bus.state.entries.e1?.deliveryAttempts).toHaveLength(0);
  });
});

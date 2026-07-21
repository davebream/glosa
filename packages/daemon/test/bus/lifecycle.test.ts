// SPDX-License-Identifier: Apache-2.0
// P2.5 — real edge coverage for the guarded inbox/attention lifecycle (A5 §F23), built on P2.1's
// replay engine. Every test folds hand-built event arrays through `lifecycleReducer` directly
// (via `foldEvents`) rather than going through a WorkspaceBus — the transition table is a pure
// function of the event sequence, so that's the sharpest way to exercise it.
import { describe, expect, test } from "bun:test";
import type { EventType, JournalEvent } from "../../src/bus/journal.ts";
import { foldEvents } from "../../src/bus/replay.ts";
import { lifecycleReducer } from "../../src/bus/lifecycle.ts";
import { WorkspaceBus } from "../../src/bus/bus.ts";
import { cleanupWorkspace, deterministicClock, deterministicUlid, freshWorkspace } from "./helpers.ts";

let seq = 0;
function mkEvent(
  type: EventType,
  entry: string,
  extra: Partial<JournalEvent> = {},
): JournalEvent {
  seq++;
  return {
    v: 1,
    event_id: extra.event_id ?? `evt-${seq}`,
    at: new Date(seq).toISOString(),
    event: type,
    entry,
    by: "daemon",
    ...extra,
  };
}

function created(entry: string, extra: Partial<JournalEvent> = {}): JournalEvent {
  return mkEvent("entry_created", entry, extra);
}

function attentionCreated(entry: string, extra: Partial<JournalEvent> = {}): JournalEvent {
  return created(entry, { detail: { kind: "attention_request" }, ...extra });
}

function transition(entry: string, to: string, extra: Partial<JournalEvent> = {}): JournalEvent {
  return mkEvent("transition_committed", entry, { detail: { to }, ...extra });
}

function attentionTransition(entry: string, to: string, extra: Partial<JournalEvent> = {}): JournalEvent {
  return mkEvent("attention_committed", entry, { detail: { to }, ...extra });
}

function delivery(entry: string, extra: Partial<JournalEvent> = {}): JournalEvent {
  return mkEvent("delivery_attempt", entry, extra);
}

function fold(events: JournalEvent[]) {
  return foldEvents(events, lifecycleReducer);
}

describe("common-entry lifecycle — every legal transition", () => {
  test("pending -> delivered -> seen -> applied", () => {
    const s = fold([created("e1"), transition("e1", "delivered"), transition("e1", "seen"), transition("e1", "applied")]);
    expect(s.entries.e1?.status).toBe("applied");
  });

  test("pending -> delivered -> seen -> rejected", () => {
    const s = fold([created("e1"), transition("e1", "delivered"), transition("e1", "seen"), transition("e1", "rejected")]);
    expect(s.entries.e1?.status).toBe("rejected");
  });

  test("pending -> delivered -> seen -> stale", () => {
    const s = fold([created("e1"), transition("e1", "delivered"), transition("e1", "seen"), transition("e1", "stale")]);
    expect(s.entries.e1?.status).toBe("stale");
  });

  test("resolve straight from pending (no intervening delivered/seen) — the P2.3 path", () => {
    const s = fold([created("e1"), transition("e1", "applied")]);
    expect(s.entries.e1?.status).toBe("applied");
  });

  test("stale straight from pending (daemon-driven, loose guard)", () => {
    const s = fold([created("e1"), transition("e1", "stale")]);
    expect(s.entries.e1?.status).toBe("stale");
  });
});

describe("attention lifecycle — every legal transition", () => {
  test("open -> delivered -> seen -> done, with the verdict detail preserved", () => {
    const s = fold([
      attentionCreated("a1"),
      attentionTransition("a1", "delivered"),
      attentionTransition("a1", "seen"),
      attentionTransition("a1", "done", { detail: { to: "done", verdict: "approved" } }),
    ]);
    expect(s.entries.a1?.status).toBe("done");
    expect((s.entries.a1?.detail as Record<string, unknown> | undefined)?.verdict).toBe("approved");
  });

  test("open -> delivered -> seen -> expired, with detail preserved", () => {
    const s = fold([
      attentionCreated("a1"),
      attentionTransition("a1", "delivered"),
      attentionTransition("a1", "seen"),
      attentionTransition("a1", "expired", { detail: { to: "expired", reason: "ttl" } }),
    ]);
    expect(s.entries.a1?.status).toBe("expired");
    expect((s.entries.a1?.detail as Record<string, unknown> | undefined)?.reason).toBe("ttl");
  });

  test("done is also legal straight from delivered (no intervening seen)", () => {
    const s = fold([attentionCreated("a1"), attentionTransition("a1", "delivered"), attentionTransition("a1", "done")]);
    expect(s.entries.a1?.status).toBe("done");
  });

  test("open -> delivered -> stale (daemon-driven, loose guard)", () => {
    const s = fold([attentionCreated("a1"), attentionTransition("a1", "delivered"), attentionTransition("a1", "stale")]);
    expect(s.entries.a1?.status).toBe("stale");
  });

  test("attention entries default to the 'open' initial status, common entries to 'pending'", () => {
    const s = fold([attentionCreated("a1"), created("e1")]);
    expect(s.entries.a1?.status).toBe("open");
    expect(s.entries.e1?.status).toBe("pending");
  });
});

describe("illegal transitions are ignored on replay (idempotent), never fatal", () => {
  test("seen before delivered (from-mismatch) is a no-op", () => {
    const events = [created("e1"), transition("e1", "seen")];
    const s = fold(events);
    expect(s.entries.e1?.status).toBe("pending");
    expect(fold(events).entries).toEqual(fold(events).entries); // replay twice is byte-identical
  });

  test("attention seen before delivered is a no-op", () => {
    const s = fold([attentionCreated("a1"), attentionTransition("a1", "seen")]);
    expect(s.entries.a1?.status).toBe("open");
  });

  test("delivered when already seen is a no-op (stays seen, doesn't regress)", () => {
    const s = fold([
      created("e1"),
      transition("e1", "delivered"),
      transition("e1", "seen"),
      transition("e1", "delivered"),
    ]);
    expect(s.entries.e1?.status).toBe("seen");
  });

  test("a transition out of a terminal state is ignored — first-terminal-wins", () => {
    const s = fold([created("e1"), transition("e1", "applied"), transition("e1", "rejected")]);
    expect(s.entries.e1?.status).toBe("applied");
  });

  test("first-terminal-wins holds for every later transition, including daemon-driven staled", () => {
    const s = fold([
      created("e1"),
      transition("e1", "applied"),
      transition("e1", "rejected"),
      transition("e1", "stale"),
      transition("e1", "delivered"),
    ]);
    expect(s.entries.e1?.status).toBe("applied");
  });

  test("duplicate resolve on a terminal attention entry is a no-op", () => {
    const s = fold([
      attentionCreated("a1"),
      attentionTransition("a1", "delivered"),
      attentionTransition("a1", "done"),
      attentionTransition("a1", "expired"), // illegal — a1 is already terminal
      attentionTransition("a1", "stale"), // illegal — a1 is already terminal
    ]);
    expect(s.entries.a1?.status).toBe("done");
  });

  test("an unrecognized `to` value for this entry's kind is ignored, not fatal", () => {
    const s = fold([created("e1"), transition("e1", "done")]); // "done" is attention-only
    expect(s.entries.e1?.status).toBe("pending");
  });

  test("a transition for an entry with no entry_created on record auto-vivifies unguarded (P2.3's apply-lease path never routes through createEntry)", () => {
    const s = fold([transition("ghost", "applied")]);
    expect(s.entries.ghost?.status).toBe("applied");
  });

  test("replaying an entire journal with illegal transitions sprinkled in is byte-identical across two folds", () => {
    const events = [
      created("e1"),
      transition("e1", "seen"), // illegal — no-op
      transition("e1", "delivered"),
      transition("e1", "delivered"), // illegal (already delivered) — no-op
      transition("e1", "applied"),
      transition("e1", "rejected"), // illegal (terminal) — no-op
      attentionCreated("a1"),
      attentionTransition("a1", "done"), // illegal — no-op, needs delivered/seen first
      attentionTransition("a1", "delivered"),
      attentionTransition("a1", "done"),
    ];
    const s1 = fold(events);
    const s2 = fold(events);
    expect(s1.entries).toEqual(s2.entries);
    expect(s1.entries.e1?.status).toBe("applied");
    expect(s1.entries.a1?.status).toBe("done");
  });
});

describe("delivery_attempt is a separate axis — never changes status", () => {
  test("create -> deliver -> N delivery_attempt (incl. re_nudge) — status stays delivered, attempts tracked", () => {
    const N = 5;
    const events = [created("e1"), transition("e1", "delivered")];
    for (let i = 0; i < N; i++) {
      events.push(delivery("e1", { detail: { via: "channel", session: "sess-1", outcome: "presented", reason: i === 0 ? "initial" : "re_nudge" } }));
    }
    const s = fold(events);
    expect(s.entries.e1?.status).toBe("delivered");
    const attempts = s.entries.e1?.deliveryAttempts as unknown[];
    expect(attempts).toHaveLength(N);
  });

  test("a delivery_attempt on a still-pending entry doesn't advance it to delivered", () => {
    const s = fold([created("e1"), delivery("e1", { detail: { via: "gate", outcome: "attempted", reason: "initial" } })]);
    expect(s.entries.e1?.status).toBe("pending");
    expect(s.entries.e1?.deliveryAttempts).toHaveLength(1);
  });

  test("delivery_attempt after resolution (re-nudging a terminal entry, however unusual) still never touches status", () => {
    const s = fold([created("e1"), transition("e1", "applied"), delivery("e1")]);
    expect(s.entries.e1?.status).toBe("applied");
    expect(s.entries.e1?.deliveryAttempts).toHaveLength(1);
  });
});

describe("idempotent replay — dedup axes inherited from P2.1, one lifecycle-flavored assertion", () => {
  test("duplicate event_id (the exact same transition event object appended twice) folds once", () => {
    const t = transition("e1", "delivered");
    const s = fold([created("e1"), t, t]);
    expect(s.entries.e1?.status).toBe("delivered");
    expect(s.appliedEventIds.size).toBe(2); // entry_created + the one distinct event_id
  });

  test("a repeated idem key across two distinct event_ids for different `to` values is a no-op on the retry", () => {
    const s = fold([
      created("e1"),
      transition("e1", "delivered"),
      mkEvent("transition_committed", "e1", { idem: "resolve:e1", detail: { to: "applied" } }),
      mkEvent("transition_committed", "e1", { idem: "resolve:e1", detail: { to: "rejected" } }), // retry, different event_id
    ]);
    expect(s.entries.e1?.status).toBe("applied"); // the idem-deduped retry never reaches the reducer at all
  });
});

describe("auto-vivify (no entry_created on record) only mints legal common `to` values", () => {
  test("a legal common `to` (e.g. applied) vivifies the entry", () => {
    const s = fold([transition("ghost", "applied")]);
    expect(s.entries.ghost?.status).toBe("applied");
  });

  test("an attention-only `to` (e.g. done) does not vivify — no limbo entry is minted", () => {
    const s = fold([transition("ghost", "done")]);
    expect(s.entries.ghost).toBeUndefined();
  });

  test("a nonsense `to` does not vivify either", () => {
    const s = fold([transition("ghost", "bogus-status")]);
    expect(s.entries.ghost).toBeUndefined();
  });
});

describe("wrong-axis events are no-ops — the guard table is keyed on the entry's OWN kind", () => {
  test("a common entry + attention_committed{to:'done'} is a no-op ('done' isn't in the common vocabulary)", () => {
    const s = fold([created("e1"), attentionTransition("e1", "done")]);
    expect(s.entries.e1?.status).toBe("pending");
  });

  test("an attention entry + transition_committed{to:'applied'} is a no-op ('applied' isn't in the attention vocabulary)", () => {
    const s = fold([attentionCreated("a1"), transition("a1", "applied")]);
    expect(s.entries.a1?.status).toBe("open");
  });
});

describe("WorkspaceBus.createEntry propagates payload.kind into entry_created.detail.kind (the blocker fix)", () => {
  test("an attention_request entry created via createEntry (not a hand-built event) reaches 'done' through the real guard table", async () => {
    const root = freshWorkspace();
    const bus = new WorkspaceBus(root, { ulid: deterministicUlid(), now: deterministicClock() });
    await bus.createEntry("a1", { kind: "attention_request", title: "review this" });
    expect(bus.state.entries.a1?.status).toBe("open"); // proves the kind was read as "attention", not defaulted to "common"'s "pending"

    await bus.commitTransition("a1", "delivered");
    await bus.commitTransition("a1", "seen");
    await bus.commitTransition("a1", "done");

    expect(bus.state.entries.a1?.status).toBe("done");
    await bus.close();
    cleanupWorkspace(root);
  });

  test("a human_edit/annotation entry created via createEntry still gets the common table (regression guard)", async () => {
    const root = freshWorkspace();
    const bus = new WorkspaceBus(root, { ulid: deterministicUlid(), now: deterministicClock() });
    await bus.createEntry("e1", { kind: "human_edit" });
    expect(bus.state.entries.e1?.status).toBe("pending");
    await bus.commitTransition("e1", "applied");
    expect(bus.state.entries.e1?.status).toBe("applied");
    await bus.close();
    cleanupWorkspace(root);
  });
});

describe("live WorkspaceBus state == a fresh restart's reconcile fold (concurrency-expert #2)", () => {
  test("create/transition/delivery incl. illegal transitions and interleaved delivery_attempts round-trips byte-identical across a restart", async () => {
    const root = freshWorkspace();
    const bus = new WorkspaceBus(root, { ulid: deterministicUlid(), now: deterministicClock() });

    await bus.createEntry("e1", { kind: "human_edit" });
    await bus.createEntry("a1", { kind: "attention_request" });

    await bus.commitTransition("e1", "seen"); // illegal — no-op (no delivered yet)
    await bus.commitTransition("e1", "delivered");
    await bus.recordDeliveryAttempt("e1", { via: "gate", outcome: "presented", reason: "initial" });
    await bus.commitTransition("e1", "seen");
    await bus.recordDeliveryAttempt("e1", { via: "gate", outcome: "presented", reason: "re_nudge" });
    await bus.commitTransition("e1", "applied");
    await bus.commitTransition("e1", "rejected"); // illegal — already terminal, no-op

    await bus.commitTransition("a1", "done"); // illegal — a1 is still "open", no delivered/seen yet
    await bus.commitTransition("a1", "delivered");
    await bus.recordDeliveryAttempt("a1", { via: "channel", session: "sess-1", outcome: "presented", reason: "initial" });
    await bus.commitTransition("a1", "done");

    const liveEntries = structuredClone(bus.state.entries);
    await bus.close();

    const bus2 = new WorkspaceBus(root, { ulid: deterministicUlid(9_000_000), now: deterministicClock(9_000_000) });
    await bus2.reconcile();

    expect(bus2.state.entries).toEqual(liveEntries);
    expect(bus2.state.entries.e1?.status).toBe("applied");
    expect(bus2.state.entries.a1?.status).toBe("done");

    await bus2.close();
    cleanupWorkspace(root);
  });
});

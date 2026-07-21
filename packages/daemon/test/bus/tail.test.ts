// P3.2 — bus/tail.ts: the SSE cursor space (A1 §8.1, physical journal-line offsets), read
// straight off a real journal built via WorkspaceBus (not hand-crafted NDJSON) so these tests
// exercise the exact bytes production writes.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync } from "node:fs";
import { WorkspaceBus } from "../../src/bus/bus.ts";
import { journalPath } from "../../src/bus/paths.ts";
import { countJournalLines, readJournalEventsSince } from "../../src/bus/tail.ts";
import { cleanupWorkspace, deterministicClock, deterministicUlid, freshWorkspace } from "./helpers.ts";

describe("bus/tail.ts", () => {
  let root: string;
  let bus: WorkspaceBus;

  beforeEach(async () => {
    root = freshWorkspace();
    bus = new WorkspaceBus(root, { ulid: deterministicUlid(), now: deterministicClock() });
    await bus.reconcile();
  });

  afterEach(async () => {
    await bus.close();
    cleanupWorkspace(root);
  });

  test("countJournalLines is 0 for a workspace with no journal yet", () => {
    const empty = freshWorkspace();
    expect(countJournalLines(empty)).toBe(0);
    cleanupWorkspace(empty);
  });

  test("countJournalLines counts exactly one line per appended event", async () => {
    expect(countJournalLines(root)).toBe(0);
    await bus.createEntry("e1", { kind: "annotation" });
    expect(countJournalLines(root)).toBe(1);
    await bus.createEntry("e2", { kind: "annotation" });
    expect(countJournalLines(root)).toBe(2);
    await bus.commitTransition("e1", "applied");
    expect(countJournalLines(root)).toBe(3);
  });

  test("readJournalEventsSince(-1) returns every line from offset 0", async () => {
    await bus.createEntry("e1", { kind: "annotation" });
    await bus.createEntry("e2", { kind: "annotation" });
    const tail = readJournalEventsSince(root, -1);
    expect(tail.map((t) => t.sequence)).toEqual([0, 1]);
    expect(tail.map((t) => t.event.entry)).toEqual(["e1", "e2"]);
  });

  test("readJournalEventsSince(cursor) returns only sequences strictly greater than cursor", async () => {
    await bus.createEntry("e1", { kind: "annotation" });
    await bus.createEntry("e2", { kind: "annotation" });
    await bus.createEntry("e3", { kind: "annotation" });
    const tail = readJournalEventsSince(root, 0);
    expect(tail.map((t) => t.sequence)).toEqual([1, 2]);
    expect(tail.map((t) => t.event.entry)).toEqual(["e2", "e3"]);
  });

  test("readJournalEventsSince at the current tail (nothing new) returns empty", async () => {
    await bus.createEntry("e1", { kind: "annotation" });
    const cursor = bus.currentCursor();
    expect(readJournalEventsSince(root, cursor)).toEqual([]);
  });

  test("review fix: a cursor below the -1 sentinel (e.g. -5) never crashes — clamps to the start instead of computing a negative array index", async () => {
    await bus.createEntry("e1", { kind: "annotation" });
    await bus.createEntry("e2", { kind: "annotation" });
    const tail = readJournalEventsSince(root, -5);
    expect(tail.map((t) => t.sequence)).toEqual([0, 1]); // same as sinceSeq = -1 ("return everything")
    expect(tail.map((t) => t.event.entry)).toEqual(["e1", "e2"]);
  });

  test("a malformed interior line occupies its own offset but is skipped, never shifting a later valid line's sequence", async () => {
    await bus.createEntry("e1", { kind: "annotation" }); // sequence 0
    appendFileSync(journalPath(root), "not valid json\n"); // sequence 1 — malformed, occupies the slot
    await bus.createEntry("e2", { kind: "annotation" }); // WorkspaceBus doesn't know about the manual
    // append above, so ITS own nextSequence counter is now stale (it thinks e2 is sequence 1) —
    // that's a deliberately out-of-band write to prove the FILE-level read is what's authoritative
    // for readJournalEventsSince, independent of any single bus instance's bookkeeping.
    expect(countJournalLines(root)).toBe(3);
    const tail = readJournalEventsSince(root, -1);
    // Only the two well-formed lines surface, at their TRUE physical offsets (0 and 2) — offset 1
    // (the malformed line) is silently absent, never reassigned to e2.
    expect(tail.map((t) => t.sequence)).toEqual([0, 2]);
    expect(tail.map((t) => t.event.entry)).toEqual(["e1", "e2"]);
  });
});

describe("WorkspaceBus cursor tracking (A1 §8.1/§8.2)", () => {
  let root: string;
  let bus: WorkspaceBus;

  beforeEach(async () => {
    root = freshWorkspace();
    bus = new WorkspaceBus(root, { ulid: deterministicUlid(), now: deterministicClock() });
    await bus.reconcile();
  });

  afterEach(async () => {
    await bus.close();
    cleanupWorkspace(root);
  });

  test("currentCursor is -1 for a freshly reconciled, empty journal", () => {
    expect(bus.currentCursor()).toBe(-1);
  });

  test("currentCursor advances by exactly 1 per append, matching the event's own notified cursor", async () => {
    const seen: number[] = [];
    const unsubscribe = bus.subscribe(({ cursor }) => seen.push(cursor));

    await bus.createEntry("e1", { kind: "annotation" });
    expect(bus.currentCursor()).toBe(0);
    await bus.createEntry("e2", { kind: "annotation" });
    expect(bus.currentCursor()).toBe(1);
    await bus.commitTransition("e1", "applied");
    expect(bus.currentCursor()).toBe(2);

    expect(seen).toEqual([0, 1, 2]);
    unsubscribe();
  });

  test("resolveEntry's two events (apply_end, transition_committed) each get their own sequential cursor", async () => {
    const seen: { cursor: number; event: string }[] = [];
    bus.subscribe(({ cursor, event }) => seen.push({ cursor, event: event.event }));

    await bus.applyBegin("entry-x", "sess-a"); // may checkpoint — at least 1 event (apply_begin)
    const cursorBeforeResolve = bus.currentCursor();
    await bus.resolveEntry("entry-x", "applied", "sess-a");

    // Exactly two more journal lines landed, at cursorBeforeResolve+1 and +2, in order.
    const afterApplyBegin = seen.filter((s) => s.cursor > cursorBeforeResolve);
    expect(afterApplyBegin.map((s) => s.event)).toEqual(["apply_end", "transition_committed"]);
    expect(afterApplyBegin.map((s) => s.cursor)).toEqual([cursorBeforeResolve + 1, cursorBeforeResolve + 2]);
  });

  test("subscribe/unsubscribe: unsubscribing stops further notifications and listenerCount reflects it", async () => {
    const seen: number[] = [];
    const unsubscribe = bus.subscribe(({ cursor }) => seen.push(cursor));
    expect(bus.listenerCount()).toBe(1);

    await bus.createEntry("e1", { kind: "annotation" });
    expect(seen).toEqual([0]);

    unsubscribe();
    expect(bus.listenerCount()).toBe(0);

    await bus.createEntry("e2", { kind: "annotation" });
    expect(seen).toEqual([0]); // no new notification after unsubscribe
  });

  test("reconcile() re-derives nextSequence from the file, not incrementally — matches physical line count after a fresh reconcile", async () => {
    await bus.createEntry("e1", { kind: "annotation" });
    await bus.createEntry("e2", { kind: "annotation" });
    expect(bus.currentCursor()).toBe(1);

    await bus.reconcile(); // forces a fresh recount
    expect(bus.currentCursor()).toBe(1); // same two lines on disk -> same cursor
  });

  test("review fix: a throwing listener is isolated — the write still resolves, the entry is still persisted, and a SIBLING listener registered after the throwing one still fires", async () => {
    const seenBySecond: number[] = [];
    bus.subscribe(() => {
      throw new Error("boom — a bad SSE listener");
    });
    bus.subscribe(({ cursor }) => seenBySecond.push(cursor));

    // The write itself must not reject just because a subscriber threw — the append+state
    // mutation already durably succeeded before notify() ever ran.
    await expect(bus.createEntry("e1", { kind: "annotation" })).resolves.toBeUndefined();

    // The entry really was persisted (not silently dropped by the throw).
    expect(bus.state.entries["e1"]).toBeDefined();

    // The SECOND listener (registered after the throwing one) still received the notification —
    // proves `for...of` isolation, not just "the write survives."
    expect(seenBySecond).toEqual([0]);
  });
});

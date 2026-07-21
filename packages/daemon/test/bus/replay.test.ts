import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { EventType, JournalEvent } from "../../src/bus/journal.ts";
import { JournalWriter, MAX_EVENT_BYTES } from "../../src/bus/journal.ts";
import { journalPath, quarantinePath } from "../../src/bus/paths.ts";
import { reconcileWorkspace } from "../../src/bus/reconcile.ts";
import { foldEvents, replayJournal } from "../../src/bus/replay.ts";
import { cleanupWorkspace, deterministicClock, deterministicUlid, freshWorkspace } from "./helpers.ts";

const genUlid = deterministicUlid();

function mkEvent(type: EventType, entry: string, extra: Partial<JournalEvent> = {}): JournalEvent {
  return { v: 1, event_id: genUlid(), at: new Date(0).toISOString(), event: type, entry, by: "daemon", ...extra };
}

describe("replay.ts — foldEvents (pure)", () => {
  test("replaying the same events twice yields deep-equal derived state (entries)", () => {
    const events: JournalEvent[] = [
      mkEvent("entry_created", "e1"),
      mkEvent("entry_created", "e2"),
      mkEvent("transition_committed", "e1", { detail: { to: "delivered" } }),
      mkEvent("transition_committed", "e1", { detail: { to: "applied" } }),
    ];
    const s1 = foldEvents(events);
    const s2 = foldEvents(events);
    expect(s1.entries).toEqual(s2.entries);
    expect(s1.entries).toEqual({ e1: { status: "applied" }, e2: { status: "pending" } });
  });

  test("duplicate event_id (the exact same event appended twice) is ignored", () => {
    const created = mkEvent("entry_created", "e1");
    const resolved = mkEvent("transition_committed", "e1", { detail: { to: "applied" } });
    const state = foldEvents([created, resolved, resolved]); // resolved's object appended "twice"
    expect(state.entries.e1?.status).toBe("applied");
    expect(state.appliedEventIds.size).toBe(2); // not 3
  });

  test("a repeated idem key is a no-op even across two distinct event_ids", () => {
    const created = mkEvent("entry_created", "e1");
    const first = mkEvent("transition_committed", "e1", { idem: "resolve:e1", detail: { to: "applied" } });
    const retry = mkEvent("transition_committed", "e1", { idem: "resolve:e1", detail: { to: "rejected" } });
    const state = foldEvents([created, first, retry]);
    expect(state.entries.e1?.status).toBe("applied"); // retry never applied — first-terminal-wins
  });

  test("transition_committed applied twice with the same idem settles on the first terminal state", () => {
    const state = foldEvents([
      mkEvent("entry_created", "e1"),
      mkEvent("transition_committed", "e1", { idem: "resolve:e1", detail: { to: "applied" } }),
      mkEvent("transition_committed", "e1", { idem: "resolve:e1", detail: { to: "applied" } }),
    ]);
    expect(state.entries.e1?.status).toBe("applied");
  });

  test("delivery_attempt never changes status — separate axis", () => {
    const state = foldEvents([mkEvent("entry_created", "e1"), mkEvent("delivery_attempt", "e1")]);
    expect(state.entries.e1?.status).toBe("pending");
  });
});

describe("replayJournal — corruption quarantine", () => {
  test("a malformed interior line is quarantined, counted once, and folding continues past it", () => {
    const root = freshWorkspace();
    const jPath = journalPath(root);
    mkdirSync(dirname(jPath), { recursive: true });
    const good1 = JSON.stringify(mkEvent("entry_created", "e1")) + "\n";
    const bad = "{ this is not valid json\n";
    const good2 = JSON.stringify(mkEvent("transition_committed", "e1", { detail: { to: "applied" } })) + "\n";
    writeFileSync(jPath, good1 + bad + good2);

    const writer = new JournalWriter(jPath);
    const result = replayJournal({
      journalPath: jPath,
      quarantinePath: quarantinePath(root),
      writer,
      ulid: deterministicUlid(),
    });
    writer.close();

    expect(result.quarantineCount).toBe(1);
    expect(result.state.entries.e1?.status).toBe("applied"); // good2 still folded — bus not disabled
    expect(readFileSync(quarantinePath(root), "utf8")).toContain("this is not valid json");

    // The bad line's exclusion is also recorded as a journal event.
    const journalText = readFileSync(jPath, "utf8");
    expect(journalText).toContain('"line_quarantined"');
    cleanupWorkspace(root);
  });

  test("an empty or missing journal replays to an empty, valid state", () => {
    const root = freshWorkspace();
    const writer = new JournalWriter(journalPath(root));
    const result = replayJournal({
      journalPath: journalPath(root),
      quarantinePath: quarantinePath(root),
      writer,
      ulid: deterministicUlid(),
    });
    writer.close();
    expect(result.state.entries).toEqual({});
    expect(result.quarantineCount).toBe(0);
    cleanupWorkspace(root);
  });

  test("an oversize interior line (valid-length JSON aside) is quarantined during replay too", () => {
    const root = freshWorkspace();
    const jPath = journalPath(root);
    mkdirSync(dirname(jPath), { recursive: true });
    const good1 = JSON.stringify(mkEvent("entry_created", "e1")) + "\n";
    // Syntactically valid JSON, but its line (incl. trailing \n) exceeds MAX_EVENT_BYTES — must be
    // quarantined by the same size gate `appendEvent` enforces on the way in.
    const oversizeEvent = mkEvent("transition_committed", "e1", { detail: { blob: "x".repeat(MAX_EVENT_BYTES) } });
    const oversizeLine = JSON.stringify(oversizeEvent) + "\n";
    expect(Buffer.byteLength(oversizeLine, "utf8")).toBeGreaterThan(MAX_EVENT_BYTES);
    writeFileSync(jPath, good1 + oversizeLine);

    const writer = new JournalWriter(jPath);
    const result = replayJournal({
      journalPath: jPath,
      quarantinePath: quarantinePath(root),
      writer,
      ulid: deterministicUlid(),
    });
    writer.close();

    expect(result.quarantineCount).toBe(1);
    expect(result.state.entries.e1?.status).toBe("pending"); // the oversize transition never applied
    cleanupWorkspace(root);
  });
});

describe("reconcile — quarantine is idempotent across restarts", () => {
  test("reconciling twice over a journal with one bad interior line does not re-grow the journal or the count", async () => {
    const root = freshWorkspace();
    const jPath = journalPath(root);
    mkdirSync(dirname(jPath), { recursive: true });
    const good1 = JSON.stringify(mkEvent("entry_created", "e1")) + "\n";
    const bad = "{ still not valid json\n";
    const good2 = JSON.stringify(mkEvent("transition_committed", "e1", { detail: { to: "applied" } })) + "\n";
    writeFileSync(jPath, good1 + bad + good2);

    const first = await reconcileWorkspace(root, { ulid: deterministicUlid(1_000), now: deterministicClock(1_000) });
    expect(first.quarantineCount).toBe(1);
    const linesAfterFirst = readFileSync(jPath, "utf8").split("\n").filter((l) => l.length > 0);
    const quarantinedAfterFirst = linesAfterFirst.filter((l) => l.includes('"line_quarantined"')).length;
    expect(quarantinedAfterFirst).toBe(1);

    const second = await reconcileWorkspace(root, { ulid: deterministicUlid(2_000), now: deterministicClock(2_000) });
    expect(second.quarantineCount).toBe(1); // still "1 distinct bad line present", not accumulating
    const linesAfterSecond = readFileSync(jPath, "utf8").split("\n").filter((l) => l.length > 0);
    expect(linesAfterSecond.length).toBe(linesAfterFirst.length); // journal didn't grow
    const quarantinedAfterSecond = linesAfterSecond.filter((l) => l.includes('"line_quarantined"')).length;
    expect(quarantinedAfterSecond).toBe(1); // not re-announced

    expect(second.state.entries.e1?.status).toBe("applied"); // the bad line still stays folded-out
    cleanupWorkspace(root);
  });
});

import { describe, expect, spyOn, test } from "bun:test";
import * as nodeFs from "node:fs";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { appendEvent, isLifecycleCritical, JournalWriter, MAX_EVENT_BYTES, type JournalEvent } from "../../src/bus/journal.ts";
import { journalPath } from "../../src/bus/paths.ts";
import { cleanupWorkspace, freshWorkspace } from "./helpers.ts";

function event(overrides: Partial<JournalEvent> = {}): JournalEvent {
  return {
    v: 1,
    event_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    at: new Date(0).toISOString(),
    event: "entry_created",
    entry: "e1",
    by: "daemon",
    ...overrides,
  };
}

describe("journal.ts — append", () => {
  test("appendEvent writes one newline-terminated JSON line, fd held across calls", () => {
    const root = freshWorkspace();
    const writer = new JournalWriter(journalPath(root));
    appendEvent(writer, event({ event_id: "id-1" }));
    appendEvent(writer, event({ event_id: "id-2", event: "transition_committed", detail: { to: "resolved" } }));
    writer.close();

    const raw = readFileSync(journalPath(root), "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect(raw.endsWith("\n")).toBe(true);
    expect(JSON.parse(lines[0] as string).event_id).toBe("id-1");
    expect(JSON.parse(lines[1] as string).event_id).toBe("id-2");
    cleanupWorkspace(root);
  });

  test("fsync-before-ACK: a lifecycle-critical event is immediately readable from disk", () => {
    const root = freshWorkspace();
    const writer = new JournalWriter(journalPath(root));
    const e = event({ event_id: "critical-1", event: "entry_created" });
    appendEvent(writer, e); // returns only after writeSync + fsyncSync for lifecycle-critical types
    writer.close();

    const raw = readFileSync(journalPath(root), "utf8");
    expect(JSON.parse(raw.trim())).toEqual(e);
  });

  test("isLifecycleCritical matches the A4 §F04 fsync-before-ACK list", () => {
    expect(isLifecycleCritical("entry_created")).toBe(true);
    expect(isLifecycleCritical("transition_committed")).toBe(true);
    expect(isLifecycleCritical("attention_committed")).toBe(true);
    expect(isLifecycleCritical("apply_begin")).toBe(true);
    expect(isLifecycleCritical("apply_end")).toBe(true);
    expect(isLifecycleCritical("baseline_checkpoint")).toBe(true);
    expect(isLifecycleCritical("delivery_attempt")).toBe(false);
    expect(isLifecycleCritical("line_quarantined")).toBe(false);
  });

  test("EVENT_TOO_LARGE: an oversize event is rejected and never touches the journal file", () => {
    const root = freshWorkspace();
    const jPath = journalPath(root);
    mkdirSync(dirname(jPath), { recursive: true });
    writeFileSync(jPath, JSON.stringify(event({ event_id: "seed" })) + "\n");
    const before = readFileSync(jPath);

    const writer = new JournalWriter(jPath);
    const huge = event({ event_id: "too-big", detail: { blob: "x".repeat(70_000) } });
    expect(() => appendEvent(writer, huge)).toThrow();
    try {
      appendEvent(writer, huge);
    } catch (err) {
      expect((err as NodeJS.ErrnoException).code).toBe("EVENT_TOO_LARGE");
    }
    writer.close();

    const after = readFileSync(jPath);
    expect(after.equals(before)).toBe(true); // byte-identical — nothing was written or truncated
    cleanupWorkspace(root);
  });

  test("EVENT_TOO_LARGE never even creates the journal file when it doesn't exist yet", () => {
    const root = freshWorkspace();
    const writer = new JournalWriter(journalPath(root));
    const huge = event({ detail: { blob: "y".repeat(MAX_EVENT_BYTES) } });
    expect(() => appendEvent(writer, huge)).toThrow();
    expect(() => readFileSync(journalPath(root))).toThrow(); // ENOENT — never created
    writer.close();
    cleanupWorkspace(root);
  });

  test("delivery_attempt defaults to no forced fsync, but AppendOptions.fsync can override either way", () => {
    const root = freshWorkspace();
    const writer = new JournalWriter(journalPath(root));
    // Both just need to not throw and to land on disk (we can't observe the fsync syscall itself
    // from here — see journal.ts's isLifecycleCritical for the authoritative default table).
    appendEvent(writer, event({ event: "delivery_attempt" })); // default: no forced fsync
    appendEvent(writer, event({ event: "delivery_attempt", event_id: "forced" }), { fsync: true });
    appendEvent(writer, event({ event: "entry_created", event_id: "skip-fsync" }), { fsync: false });
    writer.close();

    const lines = readFileSync(journalPath(root), "utf8").split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(3);
  });

  test("a mid-write failure rolls back to the pre-write size, leaving the tail clean", () => {
    const root = freshWorkspace();
    const writer = new JournalWriter(journalPath(root));
    appendEvent(writer, event({ event_id: "first" })); // establish a clean baseline
    const sizeBefore = readFileSync(journalPath(root)).length;

    const spy = spyOn(nodeFs, "writeSync").mockImplementation(() => {
      throw Object.assign(new Error("ENOSPC, no space left on device"), { code: "ENOSPC" });
    });
    try {
      expect(() => appendEvent(writer, event({ event_id: "boom" }))).toThrow();
    } finally {
      spy.mockRestore();
    }

    const afterFailure = readFileSync(journalPath(root));
    expect(afterFailure.length).toBe(sizeBefore); // rolled back — no torn bytes left behind
    expect(afterFailure[afterFailure.length - 1]).toBe(0x0a); // tail still clean

    // The writer (and its fd) are still usable — the next append lands cleanly right after.
    appendEvent(writer, event({ event_id: "recovered" }));
    writer.close();

    const lines = readFileSync(journalPath(root), "utf8").split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1] as string).event_id).toBe("recovered");
    cleanupWorkspace(root);
  });
});

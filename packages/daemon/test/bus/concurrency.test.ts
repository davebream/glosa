// Single-writer proof: N concurrent calls into the same WorkspaceBus (i.e. the same workspace's
// mutex slot) must never interleave or tear a journal record, no matter how they're scheduled.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { WorkspaceBus } from "../../src/bus/bus.ts";
import { journalPath } from "../../src/bus/paths.ts";
import { cleanupWorkspace, deterministicClock, deterministicUlid, freshWorkspace } from "./helpers.ts";

function readLines(root: string): string[] {
  return readFileSync(journalPath(root), "utf8")
    .split("\n")
    .filter((l) => l.length > 0);
}

describe("concurrency — single-writer proof", () => {
  test("N concurrent createEntry calls each produce one independently-valid, non-interleaved line", async () => {
    const root = freshWorkspace();
    const bus = new WorkspaceBus(root, { ulid: deterministicUlid(), now: deterministicClock() });
    const N = 60;

    await Promise.all(Array.from({ length: N }, (_, i) => bus.createEntry(`e${i}`, { seq: i })));
    await bus.close();

    const lines = readLines(root);
    expect(lines).toHaveLength(N);

    const seenIds = new Set<string>();
    const seenEntries = new Set<string>();
    for (const line of lines) {
      const parsed = JSON.parse(line); // throws on any interleaved/torn record
      expect(parsed.v).toBe(1);
      expect(parsed.event).toBe("entry_created");
      expect(seenIds.has(parsed.event_id)).toBe(false);
      seenIds.add(parsed.event_id);
      seenEntries.add(parsed.entry);
    }
    expect(seenIds.size).toBe(N);
    expect(seenEntries.size).toBe(N);
    cleanupWorkspace(root);
  });

  test("mixed concurrent createEntry / delivery_attempt / commitTransition calls stay serialized", async () => {
    const root = freshWorkspace();
    const bus = new WorkspaceBus(root, { ulid: deterministicUlid(), now: deterministicClock() });
    await bus.createEntry("e1", {});

    const N = 40;
    const ops = Array.from({ length: N }, () => bus.recordDeliveryAttempt("e1"));
    ops.push(bus.commitTransition("e1", "resolved"));
    await Promise.all(ops);
    await bus.close();

    const lines = readLines(root);
    expect(lines).toHaveLength(1 + N + 1); // entry_created + N delivery_attempt + 1 transition
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    expect(bus.state.entries.e1?.status).toBe("resolved");
    cleanupWorkspace(root);
  });
});

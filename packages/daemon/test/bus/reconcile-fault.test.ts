// The acceptance bar for P2.1 (A4 §F04): kill the process at every possible write boundary and
// prove reconcile always recovers exactly ONE legal state — the event either fully applied or
// fully absent, never a half-applied/corrupt state — with a clean trailing newline and the torn
// bytes quarantined.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JournalEvent } from "../../src/bus/journal.ts";
import { WorkspaceBus } from "../../src/bus/bus.ts";
import { inboxDir } from "../../src/bus/paths.ts";
import { journalPath, quarantinePath, workspaceBusDir } from "../../src/bus/paths.ts";
import { reconcileWorkspace } from "../../src/bus/reconcile.ts";
import { foldEvents } from "../../src/bus/replay.ts";
import { writeInboxEntryOnce } from "../../src/bus/inbox.ts";
import { cleanupWorkspace, deterministicClock, deterministicUlid, freshWorkspace } from "./helpers.ts";

/** Folds a prefix of raw journal bytes that's known to end exactly on a record boundary (so
 * every line in it is guaranteed-valid JSON — no quarantine machinery needed for this reference
 * computation). */
function entriesAfterPrefix(bytes: Buffer): Record<string, unknown> {
  const text = bytes.toString("utf8");
  const lines = text.length === 0 ? [] : text.split("\n").filter((l) => l.length > 0);
  const events = lines.map((l) => JSON.parse(l) as JournalEvent);
  return foldEvents(events).entries;
}

describe("reconcile — kill at every write boundary (headline fault suite)", () => {
  test("truncating the journal at every byte offset of every record recovers exactly one legal state", async () => {
    // Build a reference journal via 4 real, sequential WorkspaceBus appends.
    const buildRoot = freshWorkspace();
    const bus = new WorkspaceBus(buildRoot, { ulid: deterministicUlid(), now: deterministicClock() });
    await bus.createEntry("e1", { kind: "human_edit" });
    await bus.createEntry("e2", { kind: "annotation" });
    await bus.commitTransition("e1", "delivered");
    await bus.commitTransition("e1", "resolved");
    await bus.close();
    const fullBytes = readFileSync(journalPath(buildRoot));
    cleanupWorkspace(buildRoot);
    expect(fullBytes[fullBytes.length - 1]).toBe(0x0a); // sanity: reference journal ends clean

    // Record start offsets: 0, then right after every "\n".
    const starts: number[] = [0];
    for (let i = 0; i < fullBytes.length; i++) {
      if (fullBytes[i] === 0x0a && i + 1 < fullBytes.length) starts.push(i + 1);
    }
    const recordBoundaries = [...starts, fullBytes.length]; // N+1 boundaries around N records

    // One reusable workspace dir — we overwrite the journal file per case instead of paying for
    // a fresh mkdtemp/rm per iteration (this sweep is hundreds of cases).
    const root = freshWorkspace();
    let casesRun = 0;

    for (let k = 0; k < recordBoundaries.length - 1; k++) {
      const recordStart = recordBoundaries[k] as number;
      const recordEnd = recordBoundaries[k + 1] as number; // one past this record's trailing \n

      const legalBefore = entriesAfterPrefix(fullBytes.subarray(0, recordStart));
      const legalAfter = entriesAfterPrefix(fullBytes.subarray(0, recordEnd));

      for (let offset = recordStart; offset <= recordEnd; offset++) {
        casesRun++;
        rmSync(workspaceBusDir(root), { recursive: true, force: true });
        mkdirSync(workspaceBusDir(root), { recursive: true });
        writeFileSync(journalPath(root), fullBytes.subarray(0, offset));

        const result = await reconcileWorkspace(root, {
          ulid: deterministicUlid(9_000_000_000_000 + offset),
          now: deterministicClock(9_000_000_000_000 + offset),
        });

        // 1. The journal on disk always ends clean (empty, or trailing "\n") after reconcile.
        const after = readFileSync(journalPath(root));
        expect(after.length === 0 || after[after.length - 1] === 0x0a).toBe(true);

        // 2. Recovered entries state matches EXACTLY one legal state: the record fully applied,
        //    or fully absent — never a partial/corrupt in-between.
        const gotEntries = result.state.entries;
        const matchesBefore = JSON.stringify(gotEntries) === JSON.stringify(legalBefore);
        const matchesAfter = JSON.stringify(gotEntries) === JSON.stringify(legalAfter);
        expect(matchesBefore || matchesAfter).toBe(true);

        // 3. Torn bytes are quarantined exactly when this offset actually landed mid-record.
        const isCleanBoundary = offset === recordStart || offset === recordEnd;
        expect(result.tailTruncated).toBe(!isCleanBoundary);
        if (!isCleanBoundary) {
          expect(result.bytesRemoved).toBeGreaterThan(0);
          expect(existsSync(quarantinePath(root))).toBe(true);
        }
      }
    }

    // Sanity: we actually swept a substantial number of byte offsets, not a token few.
    expect(casesRun).toBeGreaterThan(fullBytes.length);
    cleanupWorkspace(root);
  }, 60_000);
});

describe("reconcile — inbox <-> journal crash scenarios", () => {
  test("crash before rename: an orphan temp file leaves no phantom entry and gets swept", async () => {
    const root = freshWorkspace();
    mkdirSync(inboxDir(root), { recursive: true });
    writeFileSync(join(inboxDir(root), ".e1.crash.tmp"), JSON.stringify({ kind: "human_edit" }));

    const result = await reconcileWorkspace(root, { ulid: deterministicUlid(), now: deterministicClock() });

    expect(result.state.entries.e1).toBeUndefined();
    expect(result.healedEntryIds).toEqual([]);
    expect(existsSync(join(inboxDir(root), ".e1.crash.tmp"))).toBe(false);
    cleanupWorkspace(root);
  });

  test("crash after rename, before entry_created: reconcile self-heals by synthesizing entry_created", async () => {
    const root = freshWorkspace();
    writeInboxEntryOnce(root, "e1", { kind: "human_edit" }); // rename happened...
    // ...but the daemon crashed before the paired journal append, so no journal exists at all.

    const result = await reconcileWorkspace(root, { ulid: deterministicUlid(), now: deterministicClock() });

    expect(result.healedEntryIds).toEqual(["e1"]);
    expect(result.state.entries.e1?.status).toBe("pending");

    const journalText = readFileSync(journalPath(root), "utf8");
    expect(journalText).toContain('"entry_created"');
    expect(journalText).toContain("inbox_self_heal");

    // Reconciling again must not double-heal (idempotent startup).
    const again = await reconcileWorkspace(root, {
      ulid: deterministicUlid(500_000_000_000),
      now: deterministicClock(500_000_000_000),
    });
    expect(again.healedEntryIds).toEqual([]);
    expect(again.state.entries.e1?.status).toBe("pending");
    const lines = readFileSync(journalPath(root), "utf8").split("\n").filter((l) => l.length > 0);
    expect(lines.filter((l) => l.includes('"entry_created"')).length).toBe(1); // not duplicated

    cleanupWorkspace(root);
  });
});

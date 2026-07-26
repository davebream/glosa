// SPDX-License-Identifier: Apache-2.0
// issue #79 — read-only scan for orphaned home-state buses (`~/.glosa/state/<id>` dirs holding
// pending entries with no live registration). The scanner reports; it never deletes or adopts.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scanOrphanedHomeState } from "../../src/registry/orphan-scan.ts";
import { WorkspaceIndex } from "../../src/registry/workspace-index.ts";
import { cleanup, deterministicClock, freshHome, freshWorkspaceDir } from "./helpers.ts";

const PENDING_LINE = JSON.stringify({
  v: 1,
  event_id: "01TESTEVENT0000000000000001",
  at: "2026-07-26T00:00:00.000Z",
  entry: "inb-pending-1",
  event: "entry_created",
  by: "daemon",
  detail: { kind: "annotation" },
});
const TERMINAL_LINE = JSON.stringify({
  v: 1,
  event_id: "01TESTEVENT0000000000000002",
  at: "2026-07-26T00:01:00.000Z",
  entry: "inb-pending-1",
  event: "transition_committed",
  by: "daemon",
  detail: { to: "rejected" },
});

function writeStateBus(home: string, id: string, journal: string): void {
  const busDir = join(home, "state", id);
  mkdirSync(busDir, { recursive: true });
  writeFileSync(join(busDir, "journal.ndjson"), journal);
}

describe("scanOrphanedHomeState", () => {
  test("state dir with pending journal and no registration -> reported with its count", () => {
    const home = freshHome();
    const index = new WorkspaceIndex({ home, now: deterministicClock() });
    writeStateBus(home, "deadbeef".repeat(8), `${PENDING_LINE}\n`);

    const orphans = scanOrphanedHomeState(home, index);
    expect(orphans).toEqual([{ registration_id: "deadbeef".repeat(8), pending_count: 1 }]);
    cleanup(home);
  });

  test("terminal-only journal -> not reported (nothing pending to recover)", () => {
    const home = freshHome();
    const index = new WorkspaceIndex({ home, now: deterministicClock() });
    writeStateBus(home, "aa".repeat(32), `${PENDING_LINE}\n${TERMINAL_LINE}\n`);

    expect(scanOrphanedHomeState(home, index)).toEqual([]);
    cleanup(home);
  });

  test("a registered state dir is never an orphan", async () => {
    const home = freshHome();
    const index = new WorkspaceIndex({ home, now: deterministicClock() });
    const ws = freshWorkspaceDir();
    const filePath = join(ws, "note.md");
    writeFileSync(filePath, "# note\n");
    const { entry } = await index.resolveOpenTarget(filePath, {}); // loose file -> home-redirected bus
    mkdirSync(entry.bus_path, { recursive: true });
    writeFileSync(join(entry.bus_path, "journal.ndjson"), `${PENDING_LINE}\n`);

    expect(scanOrphanedHomeState(home, index)).toEqual([]);
    cleanup(home);
    cleanup(ws);
  });

  test("missing state/ root, stray files, and unreadable journals are tolerated silently", () => {
    const home = freshHome();
    const index = new WorkspaceIndex({ home, now: deterministicClock() });
    expect(scanOrphanedHomeState(home, index)).toEqual([]); // no state/ at all

    mkdirSync(join(home, "state"), { recursive: true });
    writeFileSync(join(home, "state", "not-a-dir"), "stray file"); // non-directory entry
    writeStateBus(home, "bb".repeat(32), '{"torn line'); // journal folds to empty -> nothing pending
    expect(scanOrphanedHomeState(home, index)).toEqual([]);
    cleanup(home);
  });
});

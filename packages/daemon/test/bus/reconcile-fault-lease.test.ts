// SPDX-License-Identifier: Apache-2.0
// P5.2 (T8 storage/fault). `reconcile-fault.test.ts`'s own headline sweep proves the GENERIC
// journal-recovery mechanism (torn-tail truncate + interior quarantine) is content-agnostic — but
// its reference journal only ever contains entry_created/transition_committed events, never a
// real apply-lease lifecycle. Since apply_begin/apply_end are exactly the events A4 §F05's
// honest-provenance crux depends on (bus.ts's own isLifecycleCritical fsync-before-ACK list —
// journal.ts's `isLifecycleCritical` names both), that generic proof was never actually exercised
// against a lease in flight. This extends the SAME kill-at-every-write-step methodology across a
// real `createEntry -> applyBegin -> resolveEntry('applied')` lifecycle: does a crash at ANY byte
// offset inside that sequence recover to exactly one legal state — never a phantom half-open
// lease, and never a `status: "applied"` without the apply_end that's supposed to have proven it?
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { JournalEvent } from "../../src/bus/journal.ts";
import type { ApplyLeaseState, DerivedState } from "../../src/bus/replay.ts";
import { WorkspaceBus } from "../../src/bus/bus.ts";
import { journalPath, workspaceBusDir } from "../../src/bus/paths.ts";
import { reconcileWorkspace } from "../../src/bus/reconcile.ts";
import { foldEvents } from "../../src/bus/replay.ts";
import { lifecycleReducer } from "../../src/bus/lifecycle.ts";
import { cleanupWorkspace, deterministicClock, deterministicUlid, freshWorkspace } from "./helpers.ts";
import { writeFile as writeTrackedFile } from "../git/helpers.ts";

/** Same reference computation `reconcile-fault.test.ts` uses: fold a byte prefix known to end
 * exactly on a record boundary through the real production reducer. */
function stateAfterPrefix(bytes: Buffer): DerivedState {
  const text = bytes.toString("utf8");
  const lines = text.length === 0 ? [] : text.split("\n").filter((l) => l.length > 0);
  const events = lines.map((l) => JSON.parse(l) as JournalEvent);
  return foldEvents(events, lifecycleReducer);
}

/** A recovered lease is either entirely absent, or a fully-populated, internally-consistent
 * object — never a partially-folded/corrupt shape (which would itself be a §F05 violation: a
 * lease glosa can't correctly attribute or expire). */
function assertLeaseShapeLegal(lease: ApplyLeaseState | null, expectedLeaseId: string): void {
  if (lease === null) return;
  expect(lease.leaseId).toBe(expectedLeaseId);
  expect(lease.entry).toBe("e1");
  expect(lease.session).toBe("sess-1");
  expect(lease.preSha.length).toBeGreaterThan(0);
  expect(() => new Date(lease.expiresAt).toISOString()).not.toThrow();
}

describe("reconcile — kill mid real apply-lease lifecycle (A4 §F05 x §F04)", () => {
  test("truncating a real createEntry->applyBegin->resolveEntry journal at every byte offset of the lease-critical records never yields a phantom lease or an unproven 'applied' status", async () => {
    // 1. Build a reference journal via real WorkspaceBus operations — a genuine lease lifecycle,
    // not a hand-authored fixture.
    const buildRoot = freshWorkspace();
    writeTrackedFile(buildRoot, "notes.md", "v1");
    const bus = new WorkspaceBus(buildRoot, { ulid: deterministicUlid(), now: deterministicClock() });
    await bus.createEntry("e1", { kind: "human_edit" });
    const { leaseId } = await bus.applyBegin("e1", "sess-1");
    writeTrackedFile(buildRoot, "notes.md", "v2, edited under the lease");
    await bus.resolveEntry("e1", "applied", "sess-1");
    await bus.close();
    const fullBytes = readFileSync(journalPath(buildRoot));
    cleanupWorkspace(buildRoot);
    expect(fullBytes[fullBytes.length - 1]).toBe(0x0a); // sanity: reference journal ends clean

    const text = fullBytes.toString("utf8");
    const rawLines = text.split("\n").filter((l) => l.length > 0);
    expect(rawLines.some((l) => l.includes('"apply_begin"'))).toBe(true);
    expect(rawLines.some((l) => l.includes('"apply_end"'))).toBe(true);

    // expires_at from the real apply_begin event, so the sweep can deliberately reconcile from
    // both sides of the lease's own expiry — proving BOTH legal outcomes (still-active, and
    // auto-expired) recover cleanly, not just whichever one the wall clock happens to hit.
    const applyBeginLine = rawLines.find((l) => l.includes('"apply_begin"'));
    expect(applyBeginLine).toBeDefined();
    const applyBeginEvent = JSON.parse(applyBeginLine as string) as JournalEvent;
    const expiresAt = new Date((applyBeginEvent.detail as Record<string, unknown>).expires_at as string);
    const wellBeforeExpiry = new Date(expiresAt.getTime() - 60_000);
    const wellAfterExpiry = new Date(expiresAt.getTime() + 60_000);

    // Record boundaries: 0, then right after every "\n" (N+1 boundaries around N records).
    const starts: number[] = [0];
    for (let i = 0; i < fullBytes.length; i++) {
      if (fullBytes[i] === 0x0a && i + 1 < fullBytes.length) starts.push(i + 1);
    }
    const recordBoundaries = [...starts, fullBytes.length];

    // Exhaustive byte-offset sweep, but scoped to just the lease-critical span (apply_begin's
    // record start through apply_end's record end) rather than the whole journal — the
    // torn-write/quarantine mechanism itself is already proven content-agnostic by
    // reconcile-fault.test.ts's own exhaustive sweep; what's new and worth paying for here is the
    // real lease STATE SHAPE at every possible crash point within it. Elsewhere, only whole-record
    // boundaries are swept.
    const applyBeginRecordStart = text.indexOf('"apply_begin"');
    const transitionCommittedRecordStart = text.indexOf('"transition_committed"');
    expect(applyBeginRecordStart).toBeGreaterThan(-1);
    expect(transitionCommittedRecordStart).toBeGreaterThan(-1);
    const leaseSpanStart = recordBoundaries.filter((b) => b <= applyBeginRecordStart).slice(-1)[0] as number;
    // The boundary AFTER `transition_committed`'s own record — not the boundary that merely
    // STARTS it (that was the bug: computing this from `applyEndRecordStart` stopped the sweep
    // at transition_committed's record start, so truncation never actually landed inside the one
    // record that flips status to "applied", the very record this test exists to prove safe to
    // tear mid-write).
    const leaseSpanEnd = recordBoundaries.find((b) => b > transitionCommittedRecordStart) as number;
    const transitionRecordBoundaryStart = recordBoundaries
      .filter((b) => b <= transitionCommittedRecordStart)
      .slice(-1)[0] as number;

    // Deliberately NO tracked file in the sweep workspace: with nothing tracked and no shadow repo
    // yet, `reconcileWorkspace`'s step 5 (offline catch-up) is a true no-op (see reconcile.ts's own
    // comment on this exact fast path) — the journal-derived entries/lease state this test checks
    // comes entirely from steps 1-4, so this keeps the sweep to hundreds of pure in-process folds
    // instead of hundreds of real git spawns.
    const root = freshWorkspace();
    let casesRun = 0;

    const offsetsToTest: number[] = [];
    for (const boundary of recordBoundaries) offsetsToTest.push(boundary); // every whole-record cut
    for (let offset = leaseSpanStart; offset <= leaseSpanEnd; offset++) offsetsToTest.push(offset); // every byte in the lease span

    for (const offset of new Set(offsetsToTest)) {
      casesRun++;
      const legalBefore = stateAfterPrefix(fullBytes.subarray(0, recordBoundaries.filter((b) => b <= offset).slice(-1)[0] as number));
      const legalAfter = stateAfterPrefix(fullBytes.subarray(0, recordBoundaries.find((b) => b >= offset) as number));

      // Both sides of the expiry only produce a DIFFERENT outcome when a lease is actually open
      // in one of this offset's two legal snapshots — everywhere else (no lease on record either
      // way) the wall clock is inert, so skip the redundant (and git-spawning) second pass there.
      const leaseCouldBeOpenHere = legalBefore.applyLease?.leaseId === leaseId || legalAfter.applyLease?.leaseId === leaseId;
      const clocksToTry = leaseCouldBeOpenHere ? [wellBeforeExpiry, wellAfterExpiry] : [wellBeforeExpiry];

      for (const now of clocksToTry) {
        rmSync(workspaceBusDir(root), { recursive: true, force: true });
        mkdirSync(workspaceBusDir(root), { recursive: true });
        writeFileSync(journalPath(root), fullBytes.subarray(0, offset));

        const result = await reconcileWorkspace(root, {
          ulid: deterministicUlid(9_000_000_000_000 + offset),
          now: () => now,
        });

        // 1. Entries recovered to exactly one of the two legal record-boundary snapshots.
        const gotEntries = JSON.stringify(result.state.entries);
        const matchesBefore = gotEntries === JSON.stringify(legalBefore.entries);
        const matchesAfter = gotEntries === JSON.stringify(legalAfter.entries);
        expect(matchesBefore || matchesAfter).toBe(true);

        // 1b. The specific honest-provenance property widening the sweep into
        // transition_committed's own bytes exists to prove: any truncation that lands anywhere
        // from that record's own start up to (but not including) its full end — i.e. the record
        // never fully landed — must recover to EXACTLY the pre-transition snapshot, never a
        // partially-applied one, and "applied" must never appear. (At `leaseSpanEnd` itself the
        // record IS fully present, so that boundary is deliberately excluded here — it's covered
        // by the whole-record-boundary case instead.)
        if (offset >= transitionRecordBoundaryStart && offset < leaseSpanEnd) {
          expect(gotEntries).toBe(JSON.stringify(legalBefore.entries));
          expect(result.state.entries.e1?.status).not.toBe("applied");
        }

        // 2. The recovered lease is never a phantom/partial shape.
        assertLeaseShapeLegal(result.state.applyLease, leaseId);

        // 3. THE crux: "applied" can never appear without the lease already being closed. If
        // transition_committed's bytes never fully landed, status stays "pending" by construction
        // (it's the reducer's own dedup on incomplete data) — this asserts the STRONGER,
        // recovery-specific property: even after auto-expiry runs during THIS reconcile call,
        // status is never fast-forwarded to "applied" as a side effect of closing the lease.
        if (result.state.entries.e1?.status === "applied") {
          expect(result.state.applyLease).toBeNull();
        }

        // 4. If a lease was legally open in the pre-crash state and we reconciled well past its
        // expiry, it must have been closed out (never left dangling forever) — and closing it out
        // must NEVER fabricate a completed status.
        const leaseWasOpenBefore = legalBefore.applyLease?.leaseId === leaseId && legalAfter.applyLease?.leaseId !== leaseId
          ? legalBefore.applyLease
          : legalBefore.applyLease?.leaseId === leaseId && legalAfter.applyLease?.leaseId === leaseId
            ? legalBefore.applyLease
            : null;
        if (leaseWasOpenBefore && now === wellAfterExpiry) {
          expect(result.state.applyLease).toBeNull();
          expect(result.state.entries.e1?.status).not.toBe("applied");
        }
      }
    }

    expect(casesRun).toBeGreaterThan(leaseSpanEnd - leaseSpanStart); // actually swept the full lease span, not a token few
    cleanupWorkspace(root);
  }, 120_000);
});

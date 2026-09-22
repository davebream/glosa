// SPDX-License-Identifier: Apache-2.0
// Single-writer proof: N concurrent calls into the same WorkspaceBus (i.e. the same workspace's
// mutex slot) must never interleave or tear a journal record, no matter how they're scheduled.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { WorkspaceBus } from "../../src/bus/bus.ts";
import type { JournalEvent } from "../../src/bus/journal.ts";
import { EXCLUSIVE_CLAIM_TTL_MS } from "../../src/bus/lease.ts";
import { lifecycleReducer } from "../../src/bus/lifecycle.ts";
import { journalPath } from "../../src/bus/paths.ts";
import { foldEvents } from "../../src/bus/replay.ts";
import { checkpoint, diffShas, runGit } from "../../src/git/shadow.ts";
import { writeFile } from "../git/helpers.ts";
import { WorkspaceBusRegistry } from "../../src/bus/workspace-bus-registry.ts";
import { CLAIM_SWEEP_INTERVAL_MS, ClaimSweeper } from "../../src/claim-sweeper.ts";
import { SessionRegistry } from "../../src/registry/session-registry.ts";
import { WorkspaceIndex } from "../../src/registry/workspace-index.ts";
import { cleanup, freshHome, freshWorkspaceDir, manualClock } from "../registry/helpers.ts";
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
    ops.push(bus.commitTransition("e1", "applied"));
    await Promise.all(ops);
    await bus.close();

    const lines = readLines(root);
    expect(lines).toHaveLength(1 + N + 1); // entry_created + N delivery_attempt + 1 transition
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    expect(bus.state.entries.e1?.status).toBe("applied");
    cleanupWorkspace(root);
  });
});

// ---------------------------------------------------------------------------------------------
// Issue #155 AC-1 — two sessions, one workspace. Everything here is decided under the one
// workspace mutex, so each refusal is asserted twice: by its error, and by the journal line count
// not moving (a refusal that appended something would be a refusal in name only).
// ---------------------------------------------------------------------------------------------

function settableClock(startMs: number): { now: () => Date; advance: (ms: number) => void } {
  let t = startMs;
  return { now: () => new Date(t), advance: (ms: number) => (t += ms) };
}

function events(root: string): JournalEvent[] {
  return readLines(root).map((line) => JSON.parse(line) as JournalEvent);
}

async function postApplyCommits(root: string): Promise<string[]> {
  const log = await runGit(root, ["log", "--format=%H %(trailers:key=Glosa-Kind,valueonly)"]);
  return log.stdout
    .split("\n")
    .filter((line) => line.trim().endsWith("post_apply"))
    .map((line) => line.split(" ")[0] ?? "");
}

describe("claims — two sessions, one workspace (issue #155 AC-1)", () => {
  async function setup() {
    const root = freshWorkspace();
    writeFile(root, "notes.md", "v1\n");
    const clock = settableClock(1_700_000_000_000);
    const bus = new WorkspaceBus(root, { ulid: deterministicUlid(), now: clock.now });
    await bus.reconcile();
    await bus.createEntry("e1", { kind: "annotation", artifact_path: "notes.md" });
    return { root, clock, bus };
  }

  test("A claims; B is told who holds it; A renews; A resolves; A's retry replays; B learns the entry is closed and by whom", async () => {
    const { root, clock, bus } = await setup();

    // A claims.
    const a = await bus.applyBegin("e1", "A");
    expect(a.fence).toBe(1);
    expect(a.renewed).toBe(false);

    // B's apply-begin → CLAIM_HELD with the holder INLINE, and nothing appended.
    let lines = readLines(root).length;
    await expect(bus.applyBegin("e1", "B")).rejects.toMatchObject({
      code: "CLAIM_HELD",
      claim: { claim_id: a.leaseId, holder_session: "A", mode: "exclusive", fence: 1, expires_at: a.expiresAt },
    });
    expect(readLines(root).length).toBe(lines);

    // B's resolve → 409 with holder (AC-1.4), and nothing appended, nothing committed.
    const headBefore = (await runGit(root, ["rev-parse", "HEAD"])).stdout.trim();
    await expect(bus.resolveEntry("e1", "applied", "B")).rejects.toMatchObject({
      code: "CLAIM_HELD",
      claim: { holder_session: "A" },
    });
    expect(readLines(root).length).toBe(lines);
    expect((await runGit(root, ["rev-parse", "HEAD"])).stdout.trim()).toBe(headBefore);

    // A's re-claim renews (AC-1.5): same claim, same fence, exactly one `claim_renewed`.
    clock.advance(60_000);
    const renewed = await bus.applyBegin("e1", "A");
    expect(renewed).toMatchObject({ leaseId: a.leaseId, fence: 1, renewed: true });
    expect(readLines(root).length).toBe(lines + 1);
    expect(events(root).at(-1)?.event).toBe("claim_renewed");

    // A resolves: exactly `apply_end` + `transition_committed`.
    writeFile(root, "notes.md", "v2, applied by A\n");
    lines = readLines(root).length;
    const resolved = await bus.resolveEntry("e1", "applied", "A");
    expect(resolved.replayed).toBe(false);
    expect(readLines(root).length).toBe(lines + 2);

    // A's retry REPLAYS: same body, `replayed`, and NOTHING appended or committed — the side
    // effect a key-based dedup would still have performed.
    const replay = await bus.resolveEntry("e1", "applied", "A");
    expect(replay).toMatchObject({ replayed: true, leaseId: a.leaseId, postSha: resolved.postSha });
    expect(readLines(root).length).toBe(lines + 2);

    // B's resolve on the closed entry → ENTRY_RESOLVED naming who closed it, and nothing else.
    await expect(bus.resolveEntry("e1", "rejected", "B")).rejects.toMatchObject({
      code: "ENTRY_RESOLVED",
      terminalBy: "session:A",
      status: "applied",
    });
    // A with a DIFFERENT outcome is not a replay either — it is a second, conflicting decision.
    await expect(bus.resolveEntry("e1", "rejected", "A")).rejects.toMatchObject({ code: "ENTRY_RESOLVED" });
    expect(readLines(root).length).toBe(lines + 2);

    // Exactly one post_apply commit ever, and it is A's.
    const posts = await postApplyCommits(root);
    expect(posts).toEqual([resolved.postSha]);
    expect(bus.state.entries.e1?.terminalBy).toBe("session:A");
    expect(bus.state.entries.e1?.appliedInterval).toMatchObject({ by: "session:A", claim_id: a.leaseId });

    // The journal is the truth: a cold fold agrees with the live one.
    const cold = foldEvents(events(root), lifecycleReducer);
    expect(cold.entries.e1).toEqual(bus.state.entries.e1);
    expect(cold.claims).toEqual(bus.state.claims);
    await bus.close();
    cleanupWorkspace(root);
  });

  test("A dies holding a claim; after the TTL B claims the same file, A's claim expires naming A, and the two intervals are disjoint", async () => {
    const { root, clock, bus } = await setup();
    await bus.createEntry("e2", { kind: "annotation", artifact_path: "notes.md" });

    // A applies e1 cleanly, then claims e2 and goes silent mid-edit.
    const a1 = await bus.applyBegin("e1", "A");
    writeFile(root, "notes.md", "v2, applied by A\n");
    const a1End = await bus.resolveEntry("e1", "applied", "A");
    const a2 = await bus.applyBegin("e2", "A");
    writeFile(root, "notes.md", "v3, A's abandoned half-edit\n");

    // Same file, so B is refused while A's claim is live...
    await expect(bus.applyBegin("e2", "B")).rejects.toMatchObject({ code: "CLAIM_HELD" });
    // ...and after the TTL, B's claim closes A's out first (AC-1.7), naming A.
    clock.advance(EXCLUSIVE_CLAIM_TTL_MS + 1_000);
    const b = await bus.applyBegin("e2", "B");
    expect(b.fence).toBe(2); // strictly greater than A's — a stale A token can never match it
    const expired = events(root).filter((e) => e.event === "claim_expired");
    expect(expired.map((e) => [e.detail?.claim_id, e.detail?.holder_session, e.detail?.reason])).toEqual([
      [a2.leaseId, "A", "ttl"],
    ]);

    // A's abandoned bytes are on record as unknown, reported as an external_edit — never A's,
    // never B's.
    const abandoned = Object.values(bus.state.entries).filter((entry) => entry.payload_kind === "external_edit");
    expect(abandoned).toHaveLength(1);
    const abandonedCommit = (await runGit(root, ["show", "-s", "--format=%B", b.preSha])).stdout;
    expect(abandonedCommit).toContain("Glosa-Attribution: unknown");
    expect(abandonedCommit).toContain("Glosa-Kind: claim_expired");

    // B claims and resolves (AC-1.8).
    writeFile(root, "notes.md", "v4, applied by B\n");
    const bEnd = await bus.resolveEntry("e2", "applied", "B");

    // AC-1.9 — intervals are disjoint and correct: A's ends where the abandoned capture begins,
    // B's begins after it, and neither contains the other's work as its own.
    const aDiff = await diffShas(root, a1.preSha, a1End.postSha, ["notes.md"]);
    const bDiff = await diffShas(root, b.preSha, bEnd.postSha, ["notes.md"]);
    expect(aDiff).toContain("+v2, applied by A");
    expect(aDiff).not.toContain("applied by B");
    expect(bDiff).toContain("+v4, applied by B");
    expect(bDiff).not.toContain("+v3, A's abandoned half-edit"); // the baseline B replaced, not B's work
    expect(bDiff).not.toContain("+v2");
    expect(
      (await runGit(root, ["merge-base", "--is-ancestor", a1End.postSha, b.preSha], { allowExitCodes: [0, 1] }))
        .exitCode,
    ).toBe(0);
    const posts = await postApplyCommits(root);
    expect(posts.length).toBe(2);
    for (const [sha, who] of [
      [a1End.postSha, "A"],
      [bEnd.postSha, "B"],
    ] as const) {
      expect((await runGit(root, ["show", "-s", "--format=%B", sha])).stdout).toContain(
        `Glosa-Attribution: session:${who}`,
      );
    }

    // A's late resolve is told the claim expired — its fence (1) is not B's (2).
    await expect(bus.resolveEntry("e2", "applied", "A")).rejects.toMatchObject({ code: "ENTRY_RESOLVED" });
    await bus.close();
    cleanupWorkspace(root);
  });

  test("a human release revokes A's claim: B claims with fence 2, and A's late resolve answers CLAIM_REVOKED with or without its fence", async () => {
    const { root, bus } = await setup();
    const a = await bus.applyBegin("e1", "A");
    writeFile(root, "notes.md", "v2, A mid-edit\n");

    const released = await bus.release(a.leaseId, "human");
    expect(released.released).toBe(true);
    const release = events(root).find((e) => e.event === "claim_released");
    expect(release).toMatchObject({ by: "human", detail: { claim_id: a.leaseId, by: "human", holder_session: "A" } });

    const b = await bus.applyBegin("e1", "B");
    expect(b.fence).toBe(2);

    const lines = readLines(root).length;
    await expect(bus.resolveEntry("e1", "applied", "A")).rejects.toMatchObject({
      code: "CLAIM_REVOKED",
      tombstone: { claim_id: a.leaseId, holder_session: "A", fence: 1, reason: "released_by_human" },
    });
    await expect(bus.resolveEntry("e1", "applied", "A", { fence: 1 })).rejects.toMatchObject({ code: "CLAIM_REVOKED" });
    expect(readLines(root).length).toBe(lines);

    // B's own resolve is unaffected.
    await bus.resolveEntry("e1", "applied", "B", { fence: 2 });
    expect(bus.state.entries.e1?.terminalBy).toBe("session:B");
    await bus.close();
    cleanupWorkspace(root);
  });

  test("a foreign commit inside the claimed interval makes it unknown — the entry still closes, but nobody is credited", async () => {
    const { root, bus } = await setup();
    const a = await bus.applyBegin("e1", "A");
    // Some other writer's checkpoint lands on the claimed path mid-interval (shadow history is
    // shared; a claim cannot stop a commit, only refuse to take credit for one).
    writeFile(root, "notes.md", "v2, written by something that is not A\n");
    await checkpoint(root, { attribution: "unknown", kind: "auto_checkpoint", paths: ["notes.md"] });
    writeFile(root, "notes.md", "v3, A's edit on top\n");

    const end = await bus.resolveEntry("e1", "applied", "A");
    expect(bus.state.entries.e1?.status).toBe("applied");
    const applyEnd = events(root).find((e) => e.event === "apply_end");
    expect(applyEnd?.detail).toMatchObject({
      claim_id: a.leaseId,
      fence: 1,
      paths: ["notes.md"],
      pre_sha: a.preSha,
      post_sha: end.postSha,
      interval_attribution: "unknown",
      reason: "foreign-commit-in-interval",
    });
    expect(bus.state.entries.e1?.appliedInterval?.interval_attribution).toBe("unknown");
    await bus.close();
    cleanupWorkspace(root);
  });

  test("a clean interval is recorded as the session's", async () => {
    const { root, bus } = await setup();
    await bus.applyBegin("e1", "A");
    writeFile(root, "notes.md", "v2, A\n");
    await bus.resolveEntry("e1", "applied", "A");
    expect(events(root).find((e) => e.event === "apply_end")?.detail?.interval_attribution).toBe("session");
    await bus.close();
    cleanupWorkspace(root);
  });
});

// Issue #155 Q2 / AC-1.7 — "A dies → claim_expired{holder:A}". A claim nobody meets again would
// otherwise outlive its holder for the rest of the TTL; the daemon's sweeper closes it once the
// holder's session has been stale for the grace period, naming the holder.
describe("claims — the daemon sweeper (issue #155 AC-1.7)", () => {
  async function setup() {
    const home = freshHome();
    const root = freshWorkspaceDir();
    const idle = freshWorkspaceDir();
    writeFile(root, "notes.md", "v1\n");
    writeFile(idle, "idle.md", "idle\n");
    const clock = manualClock();
    const index = new WorkspaceIndex({ home, now: clock });
    const sessions = new SessionRegistry({ now: clock });
    const buses = new WorkspaceBusRegistry({ now: clock, ulid: deterministicUlid() });
    const entry = await index.upsertWorkspace(root, "glosa-open");
    const idleEntry = await index.upsertWorkspace(idle, "glosa-open");
    const bus = buses.get(entry);
    await bus.reconcileOnce();
    await bus.createEntry("e1", { kind: "annotation", artifact_path: "notes.md" });
    let tick: (() => void) | null = null;
    let interval = 0;
    const sweeper = new ClaimSweeper({
      workspaceIndex: index,
      busRegistry: buses,
      sessionRegistry: sessions,
      now: clock,
      schedule: (fn, ms) => {
        tick = fn;
        interval = ms;
        return () => {
          tick = null;
        };
      },
    });
    sweeper.start();
    const done = async () => {
      await sweeper.stop();
      await buses.closeAll();
      cleanup(home);
      cleanup(root);
      cleanup(idle);
    };
    return { root, clock, sessions, buses, bus, sweeper, idleEntry, done, scheduled: () => ({ tick, interval }) };
  }

  test("a claim survives its holder's first 119 s of staleness and expires holder_stale at 120 s, naming the holder", async () => {
    const { root, clock, sessions, bus, sweeper, done, scheduled } = await setup();
    expect(scheduled().interval).toBe(CLAIM_SWEEP_INTERVAL_MS);
    expect(scheduled().tick).not.toBeNull();

    await sessions.register({ session_id: "A", provider: "claude-code", cwd: root, source: "startup" });
    const a = await bus.applyBegin("e1", "A");
    writeFile(root, "notes.md", "v2, A's half-finished edit\n");

    // The session registry's lease is 60 s, so A is stale from t+60 s. One missed heartbeat must
    // never cost a working session its claim.
    clock.advance(60_000);
    await sweeper.tick();
    clock.advance(119_000);
    await sweeper.tick();
    expect(bus.state.claims["entry:e1"]?.exclusive?.claim_id).toBe(a.leaseId);
    expect(events(root).some((e) => e.event === "claim_expired")).toBe(false);

    clock.advance(1_000);
    await sweeper.tick();
    const expired = events(root).filter((e) => e.event === "claim_expired");
    expect(expired.map((e) => [e.by, e.detail])).toEqual([
      ["daemon", { claim_id: a.leaseId, holder_session: "A", reason: "holder_stale" }],
    ]);
    expect(bus.state.claims["entry:e1"]?.last?.reason).toBe("expired_holder_stale");

    // What A left behind is captured as unknown and reported — never A's, never lost.
    const abandoned = Object.values(bus.state.entries).filter((entry) => entry.payload_kind === "external_edit");
    expect(abandoned).toHaveLength(1);
    const head = (await runGit(root, ["show", "-s", "--format=%B", "HEAD"])).stdout;
    expect(head).toContain("Glosa-Attribution: unknown");
    expect(head).toContain("Glosa-Kind: claim_expired");

    // B can now claim the same file (AC-1.8), with a fence A's stale token can never match.
    const b = await bus.applyBegin("e1", "B");
    expect(b.fence).toBe(2);
    await expect(bus.resolveEntry("e1", "applied", "A")).rejects.toMatchObject({ code: "CLAIM_EXPIRED" });
    await done();
  });

  test("a live holder's claim still expires by TTL, reason ttl", async () => {
    const { root, clock, sessions, bus, sweeper, done } = await setup();
    await sessions.register({ session_id: "A", provider: "claude-code", cwd: root, source: "startup" });
    const a = await bus.applyBegin("e1", "A");
    // A keeps heartbeating: never stale.
    for (let elapsed = 0; elapsed <= EXCLUSIVE_CLAIM_TTL_MS; elapsed += 30_000) {
      clock.advance(30_000);
      await sessions.register({ session_id: "A", provider: "claude-code", cwd: root, source: "startup" });
      await sweeper.tick();
    }
    const expired = events(root).filter((e) => e.event === "claim_expired");
    expect(expired.map((e) => e.detail)).toEqual([{ claim_id: a.leaseId, holder_session: "A", reason: "ttl" }]);
    await done();
  });

  test("a holder that never registered is bounded by the TTL alone, not expired as stale", async () => {
    // The registry answers "stale" for a session it has never seen — there is no heartbeat to have
    // missed. Treating that as holder-stale would expire every CLI-only claim on the first sweep.
    const { root, clock, bus, sweeper, done } = await setup();
    await bus.applyBegin("e1", "cli-only");
    clock.advance(10 * 60_000);
    await sweeper.tick();
    expect(events(root).some((e) => e.event === "claim_expired")).toBe(false);
    await done();
  });

  test("the sweeper never opens a bus that nothing else opened", async () => {
    const { buses, sweeper, idleEntry, clock, done } = await setup();
    clock.advance(EXCLUSIVE_CLAIM_TTL_MS * 2);
    await sweeper.tick();
    expect(buses.has(idleEntry)).toBe(false);
    await done();
  });
});

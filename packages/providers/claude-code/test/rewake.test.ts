// P4.3 — A2 §F07's asyncRewake rearm protocol. The two things the spec demands are proven
// separately here: (1) rearm keeps working across MANY sequential inbox entries, not just once
// (F07's whole complaint is "repeated inbox entries silently lose rung 2" without this), and
// (2) the per-session lease is a real mutual-exclusion mechanism — two racing acquire attempts for
// the same session can never both win, so "exactly one active watcher per session" holds even
// under a race, not just in the well-behaved sequential case.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RewakeCoordinator, RewakeLeaseStore } from "../src/rewake.ts";

let dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "glosa-rewake-test-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("RewakeLeaseStore — the duplicate-watcher guard", () => {
  test("tryAcquire wins an unheld lease and records the pid", () => {
    const store = new RewakeLeaseStore({ dir: freshDir() });
    const result = store.tryAcquire("sess-1", 111);
    expect(result.acquired).toBe(true);
    expect(result.lease.pid).toBe(111);
    expect(store.isActive("sess-1")).toBe(true);
  });

  test("a second tryAcquire for the same session while the first is still fresh is refused — proves mutual exclusion under a race", () => {
    const store = new RewakeLeaseStore({ dir: freshDir() });
    const first = store.tryAcquire("sess-1", 111);
    const second = store.tryAcquire("sess-1", 222); // "racing" attempt — same tick, no release between
    expect(first.acquired).toBe(true);
    expect(second.acquired).toBe(false);
    // Exactly one active watcher: the lease still names the FIRST winner's pid, not the loser's.
    expect(store.read("sess-1")?.pid).toBe(111);
  });

  test("release then tryAcquire lets a fresh watcher win", () => {
    const store = new RewakeLeaseStore({ dir: freshDir() });
    store.tryAcquire("sess-1", 111);
    store.release("sess-1", 111);
    expect(store.isActive("sess-1")).toBe(false);
    const rearm = store.tryAcquire("sess-1", 222);
    expect(rearm.acquired).toBe(true);
    expect(store.read("sess-1")?.pid).toBe(222);
  });

  test("release(sessionId, pid) refuses to release a lease owned by a DIFFERENT pid (a stale watcher can't steal a fresh owner's lease on its way out)", () => {
    const store = new RewakeLeaseStore({ dir: freshDir() });
    store.tryAcquire("sess-1", 111);
    store.release("sess-1", 999); // some other pid's release call — must be a no-op
    expect(store.isActive("sess-1")).toBe(true);
    expect(store.read("sess-1")?.pid).toBe(111);
  });

  test("a stale lease (older than staleMs) is reclaimed by the next tryAcquire", () => {
    let now = 0;
    const store = new RewakeLeaseStore({ dir: freshDir(), now: () => new Date(now), staleMs: 30_000 });
    store.tryAcquire("sess-1", 111);
    now += 30_001; // past staleMs
    const reclaimed = store.tryAcquire("sess-1", 222);
    expect(reclaimed.acquired).toBe(true);
    expect(store.read("sess-1")?.pid).toBe(222);
  });

  test("a lease within staleMs is NOT reclaimed", () => {
    let now = 0;
    const store = new RewakeLeaseStore({ dir: freshDir(), now: () => new Date(now), staleMs: 30_000 });
    store.tryAcquire("sess-1", 111);
    now += 29_000; // still fresh
    const attempt = store.tryAcquire("sess-1", 222);
    expect(attempt.acquired).toBe(false);
    expect(store.read("sess-1")?.pid).toBe(111);
  });

  test("different sessions never contend for the same lease", () => {
    const store = new RewakeLeaseStore({ dir: freshDir() });
    expect(store.tryAcquire("sess-1", 111).acquired).toBe(true);
    expect(store.tryAcquire("sess-2", 222).acquired).toBe(true);
    expect(store.read("sess-1")?.pid).toBe(111);
    expect(store.read("sess-2")?.pid).toBe(222);
  });
});

describe("RewakeCoordinator — rearm across sequential inbox entries (A2 §F07)", () => {
  function makeCoordinator(dir: string) {
    let nextPid = 1000;
    const spawned: number[] = [];
    const leases = new RewakeLeaseStore({ dir });
    const coordinator = new RewakeCoordinator({
      leases,
      spawnWatcher: () => {
        const pid = nextPid++;
        spawned.push(pid);
        return pid;
      },
    });
    return { coordinator, leases, spawned };
  }

  test("SessionStart arms exactly one watcher", () => {
    const { coordinator, leases, spawned } = makeCoordinator(freshDir());
    const result = coordinator.onSessionStart("sess-1");
    expect(result.rearmed).toBe(true);
    expect(spawned).toHaveLength(1);
    expect(leases.isActive("sess-1")).toBe(true);
  });

  test("rearm works across THREE sequential inbox entries — each rewake-exit + Stop cycle spawns exactly one fresh watcher, never zero, never two", () => {
    const { coordinator, leases, spawned } = makeCoordinator(freshDir());

    // SessionStart: watcher #1 armed.
    coordinator.onSessionStart("sess-1");
    expect(spawned).toEqual([1000]);

    // --- Entry 1 arrives: the one-shot watcher wakes Claude (exit 2) and, per its own shutdown
    // path, releases its lease on the way out (A2 §F07: "NOT automatically re-spawned"). The Stop
    // hook that follows is what rearms it.
    leases.release("sess-1", 1000);
    expect(leases.isActive("sess-1")).toBe(false);
    let rearm = coordinator.onStop("sess-1");
    expect(rearm.rearmed).toBe(true);
    expect(spawned).toEqual([1000, 1001]);
    expect(leases.isActive("sess-1")).toBe(true);

    // --- Entry 2 arrives: same cycle — watcher #2 wakes, releases, Stop rearms watcher #3.
    leases.release("sess-1", 1001);
    rearm = coordinator.onStop("sess-1");
    expect(rearm.rearmed).toBe(true);
    expect(spawned).toEqual([1000, 1001, 1002]);

    // --- Entry 3 arrives: watcher #3 wakes, releases, Stop rearms watcher #4.
    leases.release("sess-1", 1002);
    rearm = coordinator.onStop("sess-1");
    expect(rearm.rearmed).toBe(true);
    expect(spawned).toEqual([1000, 1001, 1002, 1003]);

    // Exactly one watcher spawn per entry (plus the initial SessionStart spawn) — never a
    // duplicate, never a gap.
    expect(spawned).toHaveLength(4);
    expect(leases.isActive("sess-1")).toBe(true);
  });

  test("a Stop hook firing while the watcher is STILL armed (no entry arrived) is a no-op — never spawns a second watcher", () => {
    const { coordinator, leases, spawned } = makeCoordinator(freshDir());
    coordinator.onSessionStart("sess-1");
    expect(spawned).toHaveLength(1);

    // Several Stop hooks fire across ordinary turns with nothing pending — none of them should
    // spawn a duplicate watcher while the armed one is still alive.
    for (let i = 0; i < 5; i++) {
      const result = coordinator.onStop("sess-1");
      expect(result.rearmed).toBe(false);
      expect(result.pid).toBe(1000);
    }
    expect(spawned).toHaveLength(1); // exactly one active watcher, the whole time
  });

  test("claim-before-spawn ordering: spawnWatcher is NEVER invoked before this call already holds the lease (P4.3 concurrency review fix #5 — the actual race-proofing invariant)", () => {
    const dir = freshDir();
    const leases = new RewakeLeaseStore({ dir });
    let leaseWasActiveAtSpawnTime: boolean | undefined;
    const coordinator = new RewakeCoordinator({
      leases,
      spawnWatcher: (sessionId) => {
        // If this ever observes `false`, the coordinator spawned speculatively BEFORE winning
        // the lease — exactly the bug the review caught (isActive-check-then-spawn-then-claim).
        leaseWasActiveAtSpawnTime = leases.isActive(sessionId);
        return 4242;
      },
    });
    coordinator.onSessionStart("sess-1");
    expect(leaseWasActiveAtSpawnTime).toBe(true);
  });

  test("two coordinator instances sharing ONE on-disk lease dir (simulating two separate racing `glosa hook stop` OS processes) — only ONE ever spawns a watcher, even though BOTH start from 'no lease held'", () => {
    const dir = freshDir();
    // Two fully independent store/coordinator pairs — the ONLY thing they share is the on-disk
    // lease file, exactly like two real separate hook processes would (each constructs its own
    // fresh RewakeCoordinator/RewakeLeaseStore per P4.3 concurrency review finding #5's repro).
    const leasesA = new RewakeLeaseStore({ dir });
    const leasesB = new RewakeLeaseStore({ dir });
    const spawned: string[] = [];
    const coordinatorA = new RewakeCoordinator({
      leases: leasesA,
      spawnWatcher: () => {
        spawned.push("A");
        return 1001;
      },
    });
    const coordinatorB = new RewakeCoordinator({
      leases: leasesB,
      spawnWatcher: () => {
        spawned.push("B");
        return 1002;
      },
    });

    // Both "processes" independently observe no active lease — the exact race window the review
    // described (wide, since a real Stop handler awaits daemon round-trips first).
    expect(leasesA.isActive("sess-1")).toBe(false);
    expect(leasesB.isActive("sess-1")).toBe(false);

    const resultA = coordinatorA.onStop("sess-1");
    const resultB = coordinatorB.onStop("sess-1");

    // Exactly one watcher ever spawned — never two, regardless of which "process" got there
    // first — because each `armIfNeeded` call claims the lease via the atomic `wx` exclusive
    // create BEFORE calling `spawnWatcher`, not after.
    expect(spawned).toHaveLength(1);
    expect([resultA.rearmed, resultB.rearmed].filter(Boolean)).toHaveLength(1);
    expect(leasesA.isActive("sess-1")).toBe(true);
  });

  test("SessionEnd releases the lease so the session's watcher file doesn't linger", () => {
    const { coordinator, leases } = makeCoordinator(freshDir());
    coordinator.onSessionStart("sess-1");
    expect(leases.isActive("sess-1")).toBe(true);
    coordinator.onSessionEnd("sess-1");
    expect(leases.isActive("sess-1")).toBe(false);
    expect(leases.read("sess-1")).toBeNull();
  });

  test("rearm is scoped per-session — session A's cycle never spawns or releases session B's watcher", () => {
    const { coordinator, leases, spawned } = makeCoordinator(freshDir());
    coordinator.onSessionStart("sess-A");
    coordinator.onSessionStart("sess-B");
    expect(spawned).toHaveLength(2);

    leases.release("sess-A", 1000);
    coordinator.onStop("sess-A");
    expect(leases.isActive("sess-B")).toBe(true); // untouched
    expect(leases.read("sess-B")?.pid).toBe(1001); // still the original watcher, no B rearm happened
  });
});

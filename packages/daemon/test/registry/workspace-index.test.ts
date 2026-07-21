import { describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { WorkspaceBusRegistry } from "../../src/bus/workspace-bus-registry.ts";
import { WorkspaceIndex, workspaceIndexPath } from "../../src/registry/workspace-index.ts";
import { cleanup, deterministicClock, freshHome, freshWorkspaceDir, manualClock } from "./helpers.ts";

describe("WorkspaceIndex — atomicity + concurrency", () => {
  test("N concurrent upsertWorkspace calls (distinct paths) all land, no lost entries", async () => {
    const home = freshHome();
    const index = new WorkspaceIndex({ home, now: deterministicClock() });
    const N = 40;

    await Promise.all(Array.from({ length: N }, (_, i) => index.upsertWorkspace(`/ws/${i}`, "session")));

    const entries = index.list();
    expect(entries).toHaveLength(N);
    expect(new Set(entries.map((e) => e.slug)).size).toBe(N); // every entry got a distinct slug

    const onDisk = JSON.parse(readFileSync(workspaceIndexPath(home), "utf8"));
    expect(Object.keys(onDisk.workspaces)).toHaveLength(N);
    cleanup(home);
  });

  test("every intermediate on-disk snapshot during a concurrent burst is complete, valid JSON — never torn", async () => {
    // A live reader racing the writes (e.g. via Bun.sleep(0)) can't actually observe this in
    // Bun: `AsyncMutex.runExclusive`'s chained `.then()`s are microtasks, and Bun (like Node)
    // drains the ENTIRE microtask queue before any timer-based macrotask gets a turn — so a
    // macrotask-scheduled reader deterministically never runs until every queued write has
    // already landed. That's not a gap in the guarantee, it's a stronger one: the synchronous
    // openSync/writeSync/fsyncSync/renameSync sequence inside `persist()` can't be preempted by
    // JS itself either way. What actually needs proving is that `persist()`'s own temp -> fsync
    // -> rename sequence never leaves a half-written file at the FINAL path — snapshot it after
    // every single upsert in a sequential burst and parse each one.
    const home = freshHome();
    const index = new WorkspaceIndex({ home, now: deterministicClock() });
    const path = workspaceIndexPath(home);
    const N = 40;

    for (let i = 0; i < N; i++) {
      await index.upsertWorkspace(`/ws/${i}`, "session");
      const raw = readFileSync(path, "utf8");
      expect(() => JSON.parse(raw)).not.toThrow();
      expect(Object.keys(JSON.parse(raw).workspaces)).toHaveLength(i + 1);
    }
    cleanup(home);
  });

  test("repeated upsertWorkspace for the same path is idempotent (reuses the slug, bumps last_seen)", async () => {
    const home = freshHome();
    const index = new WorkspaceIndex({ home, now: deterministicClock() });
    const first = await index.upsertWorkspace("/ws/a", "session");
    const second = await index.upsertWorkspace("/ws/a", "glosa-open");
    expect(second.slug).toBe(first.slug);
    expect(second.first_seen).toBe(first.first_seen);
    expect(index.list()).toHaveLength(1);
    cleanup(home);
  });

  test("collision-lengthening runs inside upsertWorkspace's own mutex critical section", async () => {
    const fakeHash = (path: string): string => {
      if (path === "/Users/alice/glosa") return "aaaaaa00" + "0".repeat(56);
      if (path === "/Users/bob/glosa") return "aaaaaa11" + "0".repeat(56);
      throw new Error(`unexpected path: ${path}`);
    };
    const home = freshHome();
    const index = new WorkspaceIndex({ home, now: deterministicClock(), slug: { hash: fakeHash } });

    const alice = await index.upsertWorkspace("/Users/alice/glosa", "session");
    const bob = await index.upsertWorkspace("/Users/bob/glosa", "session");

    expect(alice.slug).toBe("glosa-aaaaaa");
    expect(bob.slug).not.toBe(alice.slug);
    expect(bob.slug_len).toBeGreaterThan(alice.slug_len);
    cleanup(home);
  });

  test("a corrupt on-disk workspaces.json is tolerated, not fatal", async () => {
    const home = freshHome();
    mkdirSync(home, { recursive: true });
    writeFileSync(workspaceIndexPath(home), "{ this is not json");

    const index = new WorkspaceIndex({ home, now: deterministicClock() });
    expect(index.list()).toEqual([]);

    const entry = await index.upsertWorkspace("/ws/a", "session");
    expect(entry.canonical_path).toBe("/ws/a");
    // The next persist() overwrote the corrupt file — it's valid JSON again now.
    expect(() => JSON.parse(readFileSync(workspaceIndexPath(home), "utf8"))).not.toThrow();
    cleanup(home);
  });
});

describe("WorkspaceIndex — GC", () => {
  test("missing path softens to present:false; reappearing heals back to present:true", async () => {
    const home = freshHome();
    const clock = manualClock();
    const existing = new Set(["/ws/a"]);
    const index = new WorkspaceIndex({ home, now: clock, gcThrottleMs: 0, pathExists: (p) => existing.has(p) });
    await index.upsertWorkspace("/ws/a", "session");

    existing.delete("/ws/a");
    const softened = await index.gc({ force: true });
    expect(softened.softened).toEqual(["/ws/a"]);
    expect(index.get("/ws/a")?.present).toBe(false);
    expect(index.get("/ws/a")?.absent_since).toBeDefined();

    existing.add("/ws/a");
    await index.gc({ force: true });
    const healed = index.get("/ws/a");
    expect(healed?.present).toBe(true);
    expect(healed?.absent_since).toBeUndefined();
    cleanup(home);
  });

  test("hard-remove only after the grace period, and never in the same pass a path went absent", async () => {
    const home = freshHome();
    const clock = manualClock();
    const existing = new Set(["/ws/a"]);
    const index = new WorkspaceIndex({
      home,
      now: clock,
      gcGraceMs: 1000,
      gcThrottleMs: 0,
      pathExists: (p) => existing.has(p),
      hasLiveSession: () => false, // explicitly wired — this test is about grace-period timing, not the unwired-default safety
    });
    await index.upsertWorkspace("/ws/a", "session");

    existing.delete("/ws/a");
    let result = await index.gc({ force: true }); // pass 1: softens
    expect(result.softened).toEqual(["/ws/a"]);
    expect(result.removed).toEqual([]);

    result = await index.gc({ force: true }); // pass 2, same instant: grace hasn't elapsed yet
    expect(result.removed).toEqual([]);
    expect(index.get("/ws/a")).not.toBeNull();

    clock.advance(1000);
    result = await index.gc({ force: true }); // pass 3: grace elapsed
    expect(result.removed).toEqual(["/ws/a"]);
    expect(index.get("/ws/a")).toBeNull();
    cleanup(home);
  });

  test("never hard-removes a workspace with a live session, no matter how long it's been absent", async () => {
    const home = freshHome();
    const clock = manualClock();
    const existing = new Set(["/ws/a"]);
    let liveSession = true;
    const index = new WorkspaceIndex({
      home,
      now: clock,
      gcGraceMs: 100,
      gcThrottleMs: 0,
      pathExists: (p) => existing.has(p),
      hasLiveSession: (p) => liveSession && p === "/ws/a",
    });
    await index.upsertWorkspace("/ws/a", "session");
    existing.delete("/ws/a");
    await index.gc({ force: true });

    clock.advance(10_000); // well past the grace period
    let result = await index.gc({ force: true });
    expect(result.removed).toEqual([]);
    expect(index.get("/ws/a")).not.toBeNull();

    liveSession = false;
    result = await index.gc({ force: true });
    expect(result.removed).toEqual(["/ws/a"]);
    cleanup(home);
  });

  test("throttled to at most once per gcThrottleMs unless forced", async () => {
    const home = freshHome();
    const clock = manualClock();
    const existing = new Set<string>(); // "/ws/a" never exists on disk
    const index = new WorkspaceIndex({
      home,
      now: clock,
      gcGraceMs: 100,
      gcThrottleMs: 1000,
      pathExists: (p) => existing.has(p),
      hasLiveSession: () => false, // explicitly wired — this test is about throttle timing, not the unwired-default safety
    });
    await index.upsertWorkspace("/ws/a", "session");

    const first = await index.gc(); // unforced, but lastGcAt starts at -Infinity so this runs
    expect(first.softened).toEqual(["/ws/a"]);

    clock.advance(150); // past grace, NOT past the throttle window
    const second = await index.gc();
    expect(second).toEqual({ softened: [], removed: [] });
    expect(index.get("/ws/a")).not.toBeNull(); // throttle blocked the pass entirely

    clock.advance(1000); // now past the throttle window too
    const third = await index.gc();
    expect(third.removed).toEqual(["/ws/a"]);
    cleanup(home);
  });
});

describe("WorkspaceIndex — forget", () => {
  test("explicit forget hard-removes regardless of grace period or live-session state", async () => {
    const home = freshHome();
    const index = new WorkspaceIndex({ home, now: deterministicClock(), hasLiveSession: () => true });
    const entry = await index.upsertWorkspace("/ws/a", "glosa-open");

    expect(await index.forget(entry.slug)).toBe(true);
    expect(index.get("/ws/a")).toBeNull();
    expect(await index.forget("no-such-slug")).toBe(false);
    cleanup(home);
  });

  test("forget() also fires onHardRemove, same as a GC hard-remove", async () => {
    const home = freshHome();
    const removedPaths: string[] = [];
    const index = new WorkspaceIndex({ home, now: deterministicClock(), onHardRemove: (p) => void removedPaths.push(p) });
    const entry = await index.upsertWorkspace("/ws/a", "glosa-open");

    await index.forget(entry.slug);
    expect(removedPaths).toEqual(["/ws/a"]);
    cleanup(home);
  });
});

describe("WorkspaceIndex — onHardRemove (resource-leak fix)", () => {
  test("a GC hard-remove fires onHardRemove with exactly the removed path, awaited before gc() resolves", async () => {
    const home = freshHome();
    const clock = manualClock();
    const existing = new Set<string>(); // "/ws/a" never exists on disk
    const removedPaths: string[] = [];
    let hookRanBeforeGcResolved = false;
    const index = new WorkspaceIndex({
      home,
      now: clock,
      gcGraceMs: 0,
      gcThrottleMs: 0,
      pathExists: (p) => existing.has(p),
      hasLiveSession: () => false, // explicitly wired — this test is about the onHardRemove hook, not the unwired-default safety
      onHardRemove: async (p) => {
        await Bun.sleep(1); // prove gc() genuinely awaits this, not fire-and-forget
        removedPaths.push(p);
        hookRanBeforeGcResolved = true;
      },
    });
    await index.upsertWorkspace("/ws/a", "session");

    await index.gc({ force: true }); // pass 1: softens (grace is 0, but this pass only softens — see the "never in the same pass" rule)
    const result = await index.gc({ force: true }); // pass 2: grace already elapsed -> hard-removes

    expect(result.removed).toEqual(["/ws/a"]);
    expect(hookRanBeforeGcResolved).toBe(true); // gc() awaited the async hook before returning
    expect(removedPaths).toEqual(["/ws/a"]);
    cleanup(home);
  });

  test("onHardRemove is never fired for a soft present:false (only for a real hard-remove)", async () => {
    const home = freshHome();
    const clock = manualClock();
    const existing = new Set(["/ws/a"]);
    const removedPaths: string[] = [];
    const index = new WorkspaceIndex({
      home,
      now: clock,
      gcThrottleMs: 0,
      pathExists: (p) => existing.has(p),
      onHardRemove: (p) => void removedPaths.push(p),
    });
    await index.upsertWorkspace("/ws/a", "session");

    existing.delete("/ws/a");
    await index.gc({ force: true }); // softens only
    expect(removedPaths).toEqual([]);
    cleanup(home);
  });

  test("wired to a real WorkspaceBusRegistry: hard-remove evicts the open bus, and a later get() returns a fresh instance", async () => {
    const home = freshHome();
    const root = freshWorkspaceDir();
    const clock = manualClock();
    const busRegistry = new WorkspaceBusRegistry();
    const index = new WorkspaceIndex({
      home,
      now: clock,
      gcGraceMs: 0,
      gcThrottleMs: 0,
      pathExists: () => false, // "root" is treated as gone the instant GC looks at it
      hasLiveSession: () => false, // explicitly wired — this test is about bus eviction, not the unwired-default safety
      onHardRemove: (p) => busRegistry.evict(p),
    });

    const originalBus = busRegistry.get(root);
    await originalBus.createEntry("e1", {}); // opens the journal fd for real
    await index.upsertWorkspace(root, "session");

    await index.gc({ force: true }); // softens
    expect(busRegistry.has(root)).toBe(true); // not evicted yet — only a soft present:false so far
    await index.gc({ force: true }); // hard-removes -> evicts

    expect(busRegistry.has(root)).toBe(false);
    const freshBus = busRegistry.get(root);
    expect(freshBus).not.toBe(originalBus);
    await freshBus.close();
    cleanup(home);
    cleanup(root);
  });
});

describe("WorkspaceIndex — unwired GC safety", () => {
  test("GC never hard-removes anything before setLiveSessionPredicate (or the constructor dep) has ever been wired — soft-delete only", async () => {
    const home = freshHome();
    const clock = manualClock();
    const existing = new Set<string>(); // "/ws/a" never exists on disk
    // Deliberately NOT passing `hasLiveSession` here, and NEVER calling
    // `setLiveSessionPredicate` below — this is exactly the "nobody wired it yet" state a fresh
    // daemon boot would be in before its startup sequence gets around to connecting the
    // SessionRegistry. The unwired default predicate reads as "no live session," which must NOT
    // be treated as an affirmative answer.
    const index = new WorkspaceIndex({ home, now: clock, gcGraceMs: 0, gcThrottleMs: 0, pathExists: (p) => existing.has(p) });
    await index.upsertWorkspace("/ws/a", "session");

    await index.gc({ force: true }); // pass 1: softens
    const result = await index.gc({ force: true }); // pass 2: grace already elapsed, but STILL unwired

    expect(result.removed).toEqual([]);
    expect(index.get("/ws/a")).not.toBeNull();
    expect(index.get("/ws/a")?.present).toBe(false); // soft-delete still happened, just not the hard-remove

    // Wiring the predicate now (mirroring what real daemon boot does shortly after construction)
    // makes the NEXT pass eligible for real hard-removal again.
    index.setLiveSessionPredicate(() => false);
    const afterWiring = await index.gc({ force: true });
    expect(afterWiring.removed).toEqual(["/ws/a"]);
    cleanup(home);
  });
});

describe("WorkspaceIndex — corrupt file quarantine", () => {
  test("a corrupt workspaces.json is renamed aside to a .corrupt.<ISO-ts> sibling, not silently discarded", async () => {
    const home = freshHome();
    mkdirSync(home, { recursive: true });
    const path = workspaceIndexPath(home);
    writeFileSync(path, "{ this is not valid json at all");

    const index = new WorkspaceIndex({ home, now: deterministicClock() });
    expect(index.list()).toEqual([]); // load() still returns a usable empty index

    const siblings = readdirSync(home).filter((name) => name.startsWith("workspaces.json.corrupt."));
    expect(siblings).toHaveLength(1);
    // The quarantined copy still holds the original corrupt bytes, verbatim.
    const quarantined = readFileSync(`${home}/${siblings[0]}`, "utf8");
    expect(quarantined).toBe("{ this is not valid json at all");
    cleanup(home);
  });

  test("an on-disk file that parses but has the wrong shape is ALSO quarantined, not just genuinely invalid JSON", async () => {
    const home = freshHome();
    mkdirSync(home, { recursive: true });
    const path = workspaceIndexPath(home);
    writeFileSync(path, JSON.stringify({ not: "the right shape" }));

    const index = new WorkspaceIndex({ home, now: deterministicClock() });
    expect(index.list()).toEqual([]);

    const siblings = readdirSync(home).filter((name) => name.startsWith("workspaces.json.corrupt."));
    expect(siblings).toHaveLength(1);
    cleanup(home);
  });
});

// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { WorkspaceBusRegistry } from "../../src/bus/workspace-bus-registry.ts";
import { resolveTrackedFiles } from "../../src/matcher.ts";
import {
  AdoptionError,
  WorkspaceIndex,
  WorkspaceOpenError,
  workspaceIndexPath,
} from "../../src/registry/workspace-index.ts";
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

describe("WorkspaceIndex — GC pending-work guard (issue #79)", () => {
  /** A minimal, valid pending journal: one entry_created line the production reducer folds to
   * status "pending". Written straight to <busDir>/journal.ndjson — same bytes the bus writes. */
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

  function gcReadyIndex(home: string, existing: Set<string>, clock: ReturnType<typeof manualClock>) {
    return new WorkspaceIndex({
      home,
      now: clock,
      gcGraceMs: 100,
      gcThrottleMs: 0,
      pathExists: (p) => existing.has(p),
      hasLiveSession: () => false, // wired — these tests are about the pending-work guard, not the unwired safety
    });
  }

  test("pending entry in the bus journal blocks hard-remove; terminal transition unblocks it", async () => {
    const home = freshHome();
    const clock = manualClock();
    const ws = freshWorkspaceDir(); // real dir so the local bus lands beside it
    const existing = new Set([ws]);
    const index = gcReadyIndex(home, existing, clock);
    const entry = await index.upsertWorkspace(ws, "glosa-open");

    mkdirSync(entry.bus_path, { recursive: true });
    writeFileSync(join(entry.bus_path, "journal.ndjson"), `${PENDING_LINE}\n`);

    existing.delete(entry.canonical_path);
    await index.gc({ force: true }); // softens
    clock.advance(10_000); // well past grace
    let result = await index.gc({ force: true });
    expect(result.removed).toEqual([]); // pending work blocks removal indefinitely
    expect(index.get(entry.canonical_path)).not.toBeNull();

    // The same entry reaching a terminal status resumes normal grace-based removal.
    writeFileSync(join(entry.bus_path, "journal.ndjson"), `${PENDING_LINE}\n${TERMINAL_LINE}\n`);
    result = await index.gc({ force: true });
    expect(result.removed).toEqual([entry.canonical_path]);
    cleanup(home);
    cleanup(ws);
  });

  test("a torn journal tail cannot hide an earlier intact pending entry", async () => {
    const home = freshHome();
    const clock = manualClock();
    const ws = freshWorkspaceDir();
    const existing = new Set([ws]);
    const index = gcReadyIndex(home, existing, clock);
    const entry = await index.upsertWorkspace(ws, "glosa-open");

    mkdirSync(entry.bus_path, { recursive: true });
    // Intact pending line + a torn (mid-write) tail — the fold skips the torn line, keeps the
    // pending one, so the guard still blocks.
    writeFileSync(join(entry.bus_path, "journal.ndjson"), `${PENDING_LINE}\n{"v":1,"event":"transi`);

    existing.delete(entry.canonical_path);
    await index.gc({ force: true });
    clock.advance(10_000);
    const result = await index.gc({ force: true });
    expect(result.removed).toEqual([]);
    cleanup(home);
    cleanup(ws);
  });

  test("a throwing hasPendingWork predicate blocks removal (fail-safe: never remove on uncertainty)", async () => {
    const home = freshHome();
    const clock = manualClock();
    const existing = new Set(["/ws/a"]);
    const index = new WorkspaceIndex({
      home,
      now: clock,
      gcGraceMs: 100,
      gcThrottleMs: 0,
      pathExists: (p) => existing.has(p),
      hasLiveSession: () => false,
      hasPendingWork: () => {
        throw new Error("journal unreadable");
      },
    });
    await index.upsertWorkspace("/ws/a", "session");

    existing.delete("/ws/a");
    await index.gc({ force: true });
    clock.advance(10_000);
    // The injected predicate throws synchronously inside gc(); the guard must swallow that as
    // "has pending", not crash the pass and not remove the entry.
    const result = await index.gc({ force: true }).catch(() => null);
    expect(result === null || result.removed.length === 0).toBe(true);
    expect(index.get("/ws/a")).not.toBeNull();
    cleanup(home);
  });

  test("re-opening the same loose file after forget reclaims the surviving home-redirected bus (deterministic ids)", async () => {
    const home = freshHome();
    const ws = freshWorkspaceDir();
    const filePath = join(ws, "note.md");
    writeFileSync(filePath, "# note\n");
    const index = new WorkspaceIndex({ home, now: deterministicClock() });

    const first = await index.resolveOpenTarget(filePath, {});
    const firstEntry = first.entry;
    expect(firstEntry.kind).toBe("loose-file");
    expect(firstEntry.bus_path.startsWith(join(home, "state"))).toBe(true);

    // Park a pending entry in the redirected bus, then hard-remove the registration.
    mkdirSync(firstEntry.bus_path, { recursive: true });
    writeFileSync(join(firstEntry.bus_path, "journal.ndjson"), `${PENDING_LINE}\n`);
    expect(await index.forget(firstEntry.slug)).toBe(true);
    expect(index.get(firstEntry.canonical_path)).toBeNull();

    // Same path re-opened -> same deterministic registration id -> same bus dir, work intact.
    const second = await index.resolveOpenTarget(filePath, {});
    expect(second.entry.registration_id).toBe(firstEntry.registration_id);
    expect(second.entry.bus_path).toBe(firstEntry.bus_path);
    expect(existsSync(join(second.entry.bus_path, "journal.ndjson"))).toBe(true);
    cleanup(home);
    cleanup(ws);
  });

  test("forget still hard-removes despite pending work (explicit user command stays forceful)", async () => {
    const home = freshHome();
    const ws = freshWorkspaceDir();
    const index = new WorkspaceIndex({ home, now: deterministicClock() });
    const entry = await index.upsertWorkspace(ws, "glosa-open");
    mkdirSync(entry.bus_path, { recursive: true });
    writeFileSync(join(entry.bus_path, "journal.ndjson"), `${PENDING_LINE}\n`);

    expect(await index.forget(entry.slug)).toBe(true);
    expect(index.get(entry.canonical_path)).toBeNull();
    cleanup(home);
    cleanup(ws);
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
    const index = new WorkspaceIndex({
      home,
      now: deterministicClock(),
      onHardRemove: (entry) => void removedPaths.push(entry.canonical_path),
    });
    const entry = await index.upsertWorkspace("/ws/a", "glosa-open");

    await index.forget(entry.slug);
    expect(removedPaths).toEqual(["/ws/a"]);
    cleanup(home);
  });
});

describe("WorkspaceIndex — forget operation record (issue #156)", () => {
  test("beginForgetOperation is idempotent and marks every member forgetting in one durable write", async () => {
    const home = freshHome();
    const index = new WorkspaceIndex({ home, now: deterministicClock() });
    const target = await index.upsertWorkspace("/ws/target", "glosa-open");

    const first = await index.beginForgetOperation(target, [target]);
    expect(index.getBySlug(target.slug)?.lifecycle?.state).toBe("forgetting");
    expect(first.members).toEqual([
      {
        registration_id: target.registration_id,
        slug: target.slug,
        canonical_path: target.canonical_path,
        worktree_path: target.worktree_path,
        kind: target.kind,
        bus_path: target.bus_path,
        prior_lifecycle: { state: "active" },
      },
    ]);

    // Idempotent: a second call for the same still-active target returns the SAME record rather
    // than starting a second one.
    const second = await index.beginForgetOperation(target, [target]);
    expect(second.operation_id).toBe(first.operation_id);
    expect(index.pendingForgetOperations().map((op) => op.operation_id)).toEqual([first.operation_id]);

    cleanup(home);
  });

  test("abortForgetOperation reverts lifecycle and drops the record — never after completion", async () => {
    const home = freshHome();
    const index = new WorkspaceIndex({ home, now: deterministicClock() });
    const target = await index.upsertWorkspace("/ws/target", "glosa-open");
    const operation = await index.beginForgetOperation(target, [target]);

    await index.abortForgetOperation(operation.operation_id);
    expect(index.getBySlug(target.slug)?.lifecycle?.state).toBe("active");
    expect(index.pendingForgetOperations()).toEqual([]);
    expect(index.forgetOperationForSlug(target.slug)).toBeNull();

    // A no-op against an unknown/already-gone operation id — never throws.
    await index.abortForgetOperation(operation.operation_id);

    // And once COMPLETED, abort must never revert it — completion is the point of no return.
    // (`completeForgetOperation` now independently refuses while any snapshotted registration is
    // still live — issue #156 target-last hardening — so the target must be deregistered first,
    // exactly as the real `commitForgetLocked` always does before it ever completes an operation.)
    const restarted = await index.beginForgetOperation(target, [target]);
    expect(await index.forget(target.slug)).toBe(true);
    await index.completeForgetOperation(restarted.operation_id);
    await index.abortForgetOperation(restarted.operation_id);
    expect(index.forgetOperationForSlug(target.slug)?.completed_at).toBeDefined();

    cleanup(home);
  });

  test("abortForgetOperation restores an adopted source's TRUE prior lifecycle, never a bare 'active' (held-review finding)", async () => {
    // Regression: the OLD `abortForgetOperation` unconditionally reset every member to
    // `{state:"active"}` — correct for the target, but a lie for an already-sealed adopted source,
    // whose real prior state carries `adoption_id`/`target_registration_id`/`sealed_at` that
    // `sealedSourcesFor` depends on to ever find it again. Restoring a bare "active" here would
    // silently strip that and orphan the source's bus on every SUBSEQUENT forget attempt.
    const home = freshHome();
    const index = new WorkspaceIndex({ home, now: deterministicClock() });
    const target = await index.upsertWorkspace("/ws/target", "glosa-open");
    const source = await index.upsertWorkspace("/ws/source", "glosa-open");

    // Simulate a source already sealed into the target by a completed adoption — the exact shape
    // `commitAdoption` itself writes (workspace-index.ts's own `commitAdoption`).
    const adoptedLifecycle = {
      state: "adopted" as const,
      adoption_id: "test-adoption-1",
      target_registration_id: target.registration_id,
      sealed_at: "2020-01-01T00:00:00.000Z",
    };
    source.lifecycle = adoptedLifecycle;
    expect(index.sealedSourcesFor(target.registration_id).map((e) => e.registration_id)).toEqual([
      source.registration_id,
    ]);

    const operation = await index.beginForgetOperation(target, [target, source]);
    expect(index.getWorkspaceByRegistration(source.registration_id)?.lifecycle?.state).toBe("forgetting");

    await index.abortForgetOperation(operation.operation_id);

    expect(index.getBySlug(target.slug)?.lifecycle).toEqual({ state: "active" }); // the target's own true prior state
    const restoredSource = index.getWorkspaceByRegistration(source.registration_id)!;
    expect(restoredSource.lifecycle).toEqual(adoptedLifecycle); // exactly "adopted" again, never "active"

    // And therefore still discoverable as a sealed source — a later forget attempt must still
    // find and delete it, not silently orphan its bus.
    expect(index.sealedSourcesFor(target.registration_id).map((e) => e.registration_id)).toEqual([
      source.registration_id,
    ]);

    cleanup(home);
  });

  test("forgetOperationForSlug resolves a completed operation by any original member's slug, even once every registration is gone", async () => {
    const home = freshHome();
    const index = new WorkspaceIndex({ home, now: deterministicClock() });
    const target = await index.upsertWorkspace("/ws/target", "glosa-open");
    const source = await index.upsertWorkspace("/ws/source", "glosa-open");

    const operation = await index.beginForgetOperation(target, [target, source]);
    await index.forget(source.slug);
    await index.forget(target.slug);
    await index.completeForgetOperation(operation.operation_id);

    expect(index.getBySlug(target.slug)).toBeNull();
    expect(index.getBySlug(source.slug)).toBeNull();
    const bySlug = index.forgetOperationForSlug(target.slug);
    const byMemberSlug = index.forgetOperationForSlug(source.slug);
    expect(bySlug?.operation_id).toBe(operation.operation_id);
    expect(byMemberSlug?.operation_id).toBe(operation.operation_id);
    expect(bySlug?.completed_at).toBeDefined();
    expect(bySlug?.members.map((m) => m.registration_id).sort()).toEqual(
      [target.registration_id, source.registration_id].sort(),
    );

    cleanup(home);
  });

  test("completeForgetOperation refuses while any snapshotted registration remains", async () => {
    // Direct completion-guard regression (issue #156, target-last hardening, fifth held-review
    // pass): "independently harden `completeForgetOperation` so it refuses to stamp completion
    // while any snapshotted registration remains" — schema-v4 load-time validation
    // (`isLifecycleOperationGraphConsistent`) refuses to TRUST an on-disk graph in this shape, but
    // this proves the SEPARATE runtime guard inside `completeForgetOperation` itself: even reached
    // directly, with no prior deregistration at all, it must refuse rather than stamp a completion
    // receipt that lies about the deletion being done.
    const home = freshHome();
    const index = new WorkspaceIndex({ home, now: deterministicClock() });
    const target = await index.upsertWorkspace("/ws/target", "glosa-open");
    const source = await index.upsertWorkspace("/ws/source", "glosa-open");
    const operation = await index.beginForgetOperation(target, [target, source]);

    // Neither registration has been removed yet — completion must refuse outright.
    await expect(index.completeForgetOperation(operation.operation_id)).rejects.toThrow(/still live/);
    expect(index.forgetOperationForSlug(target.slug)?.completed_at).toBeUndefined();

    // Removing only the SOURCE (never the target) still leaves the target itself live — must still
    // refuse, proving the guard checks every snapshotted member, not just the one being resolved.
    expect(await index.forget(source.slug)).toBe(true);
    await expect(index.completeForgetOperation(operation.operation_id)).rejects.toThrow(/still live/);
    expect(index.forgetOperationForSlug(target.slug)?.completed_at).toBeUndefined();

    // Once every snapshotted registration is genuinely gone, completion proceeds normally.
    expect(await index.forget(target.slug)).toBe(true);
    const completed = await index.completeForgetOperation(operation.operation_id);
    expect(completed.completed_at).toBeDefined();

    cleanup(home);
  });
});

describe("WorkspaceIndex — resolveOpenTarget vs. an active forget operation (issue #156 final held-review finding)", () => {
  // Regression: "`POST /api/workspaces/open` checks for a registration-less operation before
  // `resolveOpenTarget`, leaving a race in which forget can deregister between the check and
  // registration mutation." The fix moved the check INSIDE `resolveOpenTarget`/
  // `upsertDirectoryForOpen`'s own mutex critical section — the same one that performs the
  // resolve/register mutation — so the two can never be split by an intervening forget step again.
  // These tests exercise `resolveOpenTarget` directly (no HTTP layer, no outer pre-check at all) to
  // prove the guard lives where the mutation itself happens, not in a caller that could race it.

  test("refuses to recreate a directory registration while its forget operation is still active, even once the target's own registration is fully gone", async () => {
    const home = freshHome();
    const root = realpathSync(freshWorkspaceDir()); // realpath'd: macOS's $TMPDIR is itself a symlink
    const index = new WorkspaceIndex({ home, now: deterministicClock() });

    const target = await index.upsertWorkspace(root, "glosa-open");
    await index.beginForgetOperation(target, [target]);
    expect(await index.forget(target.slug)).toBe(true); // deregistered; operation still active
    expect(index.get(root)).toBeNull();
    expect(index.activeForgetOperationForCanonicalPath(root)).not.toBeNull();

    // The work-tree directory itself was never touched by forget — it still exists on disk, so
    // without the fix `resolveOpenTarget` would happily treat it as brand new.
    await expect(index.resolveOpenTarget(root)).rejects.toMatchObject({
      code: "workspace-forgetting",
    });
    await expect(index.resolveOpenTarget(root)).rejects.toBeInstanceOf(AdoptionError);

    // No new registration was created by the refused attempt.
    expect(index.get(root)).toBeNull();

    cleanup(home);
    cleanup(root);
  });

  test("refuses an existing directory registration whose forget is mid-flight rather than silently refreshing it", async () => {
    const home = freshHome();
    const root = realpathSync(freshWorkspaceDir()); // realpath'd: macOS's $TMPDIR is itself a symlink
    const index = new WorkspaceIndex({ home, now: deterministicClock() });

    const target = await index.upsertWorkspace(root, "glosa-open");
    await index.markForgetting([target.registration_id], target.registration_id);
    const beforeLastSeen = index.getWorkspaceByRegistration(target.registration_id)!.last_seen;

    await expect(index.resolveOpenTarget(root)).rejects.toMatchObject({ code: "workspace-forgetting" });

    // Refused BEFORE any mutation — `last_seen` must be untouched, not silently refreshed.
    expect(index.getWorkspaceByRegistration(target.registration_id)!.last_seen).toBe(beforeLastSeen);
    expect(index.getWorkspaceByRegistration(target.registration_id)!.lifecycle?.state).toBe("forgetting");

    cleanup(home);
    cleanup(root);
  });

  test("a loose-file open refuses to recreate a registration for a canonical path an active forget operation still names", async () => {
    const home = freshHome();
    const dir = freshWorkspaceDir();
    const filePath = join(dir, "note.md");
    writeFileSync(filePath, "note\n");
    const index = new WorkspaceIndex({ home, now: deterministicClock() });

    const canonicalFile = (await index.resolveOpenTarget(filePath)).entry.canonical_path;
    const member = index.get(canonicalFile)!;
    await index.beginForgetOperation(member, [member]);
    expect(await index.forget(member.slug)).toBe(true);
    expect(index.get(canonicalFile)).toBeNull();

    await expect(index.resolveOpenTarget(filePath)).rejects.toMatchObject({ code: "workspace-forgetting" });
    expect(index.get(canonicalFile)).toBeNull();

    cleanup(home);
    cleanup(dir);
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
      onHardRemove: async (entry) => {
        await Bun.sleep(1); // prove gc() genuinely awaits this, not fire-and-forget
        removedPaths.push(entry.canonical_path);
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
      onHardRemove: (entry) => void removedPaths.push(entry.canonical_path),
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
    // Terminalize it — a PENDING entry now blocks hard-remove by design (issue #79's guard),
    // and this test is about bus eviction on hard-remove, not the pending-work guard.
    await originalBus.commitTransition("e1", "rejected");
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
    const index = new WorkspaceIndex({
      home,
      now: clock,
      gcGraceMs: 0,
      gcThrottleMs: 0,
      pathExists: (p) => existing.has(p),
    });
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

  test("a valid v4 file with a malformed forget_operations member is quarantined before any later dereference (issue #156 held-review finding)", async () => {
    // Regression: "the v4 index validator does not validate forget-operation records and members
    // before later dereference" — a `members` entry missing `bus_path` previously passed straight
    // through `isWorkspaceIndexShape` untouched, so a later read (status's own member walk,
    // `completeForgetOperation`, ...) could dereference a field that was never actually there.
    const home = freshHome();
    mkdirSync(home, { recursive: true });
    const path = workspaceIndexPath(home);
    writeFileSync(
      path,
      JSON.stringify({
        version: 4,
        updated_at: "2020-01-01T00:00:00.000Z",
        workspaces: {},
        adoptions: {},
        forget_operations: {
          "op-1": {
            operation_id: "op-1",
            target_registration_id: "reg-1",
            target_slug: "target",
            // Malformed member: no `bus_path` at all.
            members: [{ registration_id: "reg-1", slug: "target", canonical_path: "/tmp/x", kind: "directory" }],
            started_at: "2020-01-01T00:00:00.000Z",
          },
        },
      }),
    );

    const index = new WorkspaceIndex({ home, now: deterministicClock() });
    expect(index.list()).toEqual([]); // fell back to a fresh empty index, not a half-trusted one
    expect(index.pendingForgetOperations()).toEqual([]);

    const siblings = readdirSync(home).filter((name) => name.startsWith("workspaces.json.corrupt."));
    expect(siblings).toHaveLength(1);
    cleanup(home);
  });

  test("schema-v4 forget-operation records are validated for semantic invariants beyond field types (held-review finding, second pass)", async () => {
    // Regression: "schema-v4 validation checks only field types. It accepts semantically corrupt
    // operations such as members: [], a target absent from members, mismatched map keys/operation
    // IDs, duplicate members, and non-absolute member paths." Every case below is otherwise
    // well-typed (right string/array/object shapes throughout) and must STILL quarantine.
    const validMember = {
      registration_id: "reg-target",
      slug: "target",
      canonical_path: "/tmp/target",
      worktree_path: "/tmp/target",
      kind: "directory" as const,
      bus_path: "/tmp/target/.glosa",
      prior_lifecycle: { state: "active" as const },
    };
    const validOp = {
      operation_id: "op-1",
      target_registration_id: "reg-target",
      target_slug: "target",
      members: [validMember],
      started_at: "2020-01-01T00:00:00.000Z",
    };

    const cases: Array<{ name: string; forgetOperations: Record<string, unknown> }> = [
      { name: "empty members array", forgetOperations: { "op-1": { ...validOp, members: [] } } },
      {
        name: "target absent from its own member list",
        forgetOperations: { "op-1": { ...validOp, target_registration_id: "reg-missing" } },
      },
      {
        name: "duplicate member registration ids",
        forgetOperations: { "op-1": { ...validOp, members: [validMember, validMember] } },
      },
      {
        name: "a relative canonical_path",
        forgetOperations: { "op-1": { ...validOp, members: [{ ...validMember, canonical_path: "relative/path" }] } },
      },
      {
        name: "map key disagrees with the record's own operation_id",
        forgetOperations: { "op-mismatched-key": validOp },
      },
      {
        name: "the target member's slug disagrees with target_slug",
        forgetOperations: { "op-1": { ...validOp, members: [{ ...validMember, slug: "some-other-slug" }] } },
      },
    ];

    for (const { name, forgetOperations } of cases) {
      const home = freshHome();
      mkdirSync(home, { recursive: true });
      writeFileSync(
        workspaceIndexPath(home),
        JSON.stringify({
          version: 4,
          updated_at: "2020-01-01T00:00:00.000Z",
          workspaces: {},
          adoptions: {},
          forget_operations: forgetOperations,
        }),
      );
      const index = new WorkspaceIndex({ home, now: deterministicClock() });
      expect(index.pendingForgetOperations(), name).toEqual([]);
      const siblings = readdirSync(home).filter((n) => n.startsWith("workspaces.json.corrupt."));
      expect(siblings, name).toHaveLength(1);
      cleanup(home);
    }
  });

  const validWorkspace = {
    registration_id: "reg-target",
    kind: "directory" as const,
    canonical_path: "/tmp/target",
    worktree_path: "/tmp/target",
    bus_path: "/tmp/target/.glosa",
    tracking: { mode: "matcher" as const },
    slug: "target",
    slug_len: 6,
    source: "glosa-open" as const,
    first_seen: "2020-01-01T00:00:00.000Z",
    last_seen: "2020-01-01T00:00:00.000Z",
    present: true,
  };

  test("a workspace entry with a malformed lifecycle value is quarantined (held-review finding, fourth pass)", async () => {
    // Regression: "isWorkspaceEntryShape never calls isWorkspaceLifecycleShape" — a PRESENT
    // `lifecycle` value previously passed straight through untyped, whatever its shape.
    const cases: Array<{ name: string; lifecycle: unknown }> = [
      { name: "unknown lifecycle state", lifecycle: { state: "bogus" } },
      { name: "a bare string instead of an object", lifecycle: "forgetting" },
      { name: "forgetting missing its required fields", lifecycle: { state: "forgetting" } },
      { name: "adopting missing its required fields", lifecycle: { state: "adopting" } },
    ];
    for (const { name, lifecycle } of cases) {
      const home = freshHome();
      mkdirSync(home, { recursive: true });
      writeFileSync(
        workspaceIndexPath(home),
        JSON.stringify({
          version: 4,
          updated_at: "2020-01-01T00:00:00.000Z",
          workspaces: { "reg-target": { ...validWorkspace, lifecycle } },
          adoptions: {},
          forget_operations: {},
        }),
      );
      const index = new WorkspaceIndex({ home, now: deterministicClock() });
      expect(index.list(), name).toEqual([]);
      const siblings = readdirSync(home).filter((n) => n.startsWith("workspaces.json.corrupt."));
      expect(siblings, name).toHaveLength(1);
      cleanup(home);
    }
  });

  test("a workspaces map key that disagrees with the entry's own registration_id is quarantined (held-review finding, fourth pass)", async () => {
    const home = freshHome();
    mkdirSync(home, { recursive: true });
    writeFileSync(
      workspaceIndexPath(home),
      JSON.stringify({
        version: 4,
        updated_at: "2020-01-01T00:00:00.000Z",
        workspaces: { "wrong-key": validWorkspace }, // validWorkspace.registration_id === "reg-target"
        adoptions: {},
        forget_operations: {},
      }),
    );
    const index = new WorkspaceIndex({ home, now: deterministicClock() });
    expect(index.list()).toEqual([]);
    const siblings = readdirSync(home).filter((n) => n.startsWith("workspaces.json.corrupt."));
    expect(siblings).toHaveLength(1);
    cleanup(home);
  });

  test("an active forget operation whose target row's lifecycle disagrees is quarantined, not silently trusted (held-review finding, fourth pass)", async () => {
    // Regression: "a v4 file containing an active forget operation whose live target row says
    // active therefore passes loading; forgetWorkspace takes the fresh path, and
    // beginForgetOperation returns the inconsistent pre-existing operation while deletion is
    // driven by current lifecycle rows." The op's own member/target shapes are individually
    // well-typed; only the CROSS-record link (operation says "forgetting", live row says
    // "active") is broken.
    const member = {
      registration_id: "reg-target",
      slug: "target",
      canonical_path: "/tmp/target",
      worktree_path: "/tmp/target",
      kind: "directory" as const,
      bus_path: "/tmp/target/.glosa",
      prior_lifecycle: { state: "active" as const },
    };
    const op = {
      operation_id: "op-1",
      target_registration_id: "reg-target",
      target_slug: "target",
      members: [member],
      started_at: "2020-01-01T00:00:00.000Z",
    };
    const home = freshHome();
    mkdirSync(home, { recursive: true });
    writeFileSync(
      workspaceIndexPath(home),
      JSON.stringify({
        version: 4,
        updated_at: "2020-01-01T00:00:00.000Z",
        workspaces: { "reg-target": { ...validWorkspace, lifecycle: { state: "active" } } }, // disagrees
        adoptions: {},
        forget_operations: { "op-1": op },
      }),
    );
    const index = new WorkspaceIndex({ home, now: deterministicClock() });
    expect(index.list()).toEqual([]);
    expect(index.pendingForgetOperations()).toEqual([]);
    const siblings = readdirSync(home).filter((n) => n.startsWith("workspaces.json.corrupt."));
    expect(siblings).toHaveLength(1);
    cleanup(home);
  });

  test("a live workspace row marked forgetting with no active operation covering it is quarantined (held-review finding, fourth pass)", async () => {
    // Regression: "unaccounted forgetting rows" — a lifecycle marker with no operation record
    // behind it at all must never be silently trusted either.
    const home = freshHome();
    mkdirSync(home, { recursive: true });
    writeFileSync(
      workspaceIndexPath(home),
      JSON.stringify({
        version: 4,
        updated_at: "2020-01-01T00:00:00.000Z",
        workspaces: {
          "reg-target": {
            ...validWorkspace,
            lifecycle: {
              state: "forgetting",
              started_at: "2020-01-01T00:00:00.000Z",
              target_registration_id: "reg-target",
            },
          },
        },
        adoptions: {},
        forget_operations: {}, // no operation at all backs this marker
      }),
    );
    const index = new WorkspaceIndex({ home, now: deterministicClock() });
    expect(index.list()).toEqual([]);
    const siblings = readdirSync(home).filter((n) => n.startsWith("workspaces.json.corrupt."));
    expect(siblings).toHaveLength(1);
    cleanup(home);
  });

  test("a genuinely consistent active operation (live or registration-less) loads normally — the guard never false-positives on real forget states (held-review finding, fourth pass)", async () => {
    const member = {
      registration_id: "reg-target",
      slug: "target",
      canonical_path: "/tmp/target",
      worktree_path: "/tmp/target",
      kind: "directory" as const,
      bus_path: "/tmp/target/.glosa",
      prior_lifecycle: { state: "active" as const },
    };
    const op = {
      operation_id: "op-1",
      target_registration_id: "reg-target",
      target_slug: "target",
      members: [member],
      started_at: "2020-01-01T00:00:00.000Z",
    };

    // Case 1: the target's own live row is present and correctly agrees.
    const home = freshHome();
    mkdirSync(home, { recursive: true });
    writeFileSync(
      workspaceIndexPath(home),
      JSON.stringify({
        version: 4,
        updated_at: "2020-01-01T00:00:00.000Z",
        workspaces: {
          "reg-target": {
            ...validWorkspace,
            lifecycle: {
              state: "forgetting",
              started_at: "2020-01-01T00:00:00.000Z",
              target_registration_id: "reg-target",
            },
          },
        },
        adoptions: {},
        forget_operations: { "op-1": op },
      }),
    );
    const index = new WorkspaceIndex({ home, now: deterministicClock() });
    expect(index.list()).toHaveLength(1);
    expect(index.pendingForgetOperations()).toHaveLength(1);
    cleanup(home);

    // Case 2: registration-less — the member has NO live row at all (an earlier interrupted
    // attempt already deregistered it) — this is the normal registration-less state, never
    // quarantined.
    const home2 = freshHome();
    mkdirSync(home2, { recursive: true });
    writeFileSync(
      workspaceIndexPath(home2),
      JSON.stringify({
        version: 4,
        updated_at: "2020-01-01T00:00:00.000Z",
        workspaces: {},
        adoptions: {},
        forget_operations: { "op-1": op },
      }),
    );
    const index2 = new WorkspaceIndex({ home: home2, now: deterministicClock() });
    expect(index2.list()).toEqual([]);
    expect(index2.pendingForgetOperations()).toHaveLength(1);
    cleanup(home2);
  });

  test("an active forget operation whose live member's identity field has drifted from its immutable snapshot is quarantined (held-review finding, final pass)", async () => {
    // Regression: "schema-v4 graph validation does not compare every live member identity field
    // with its immutable operation snapshot" — the PRIOR check compared only `lifecycle.state`/
    // `target_registration_id`, so a live row whose `slug`/`canonical_path`/`kind`/`bus_path`/
    // `worktree_path` disagreed with what the operation actually captured passed loading unnoticed.
    const member = {
      registration_id: "reg-target",
      slug: "target",
      canonical_path: "/tmp/target",
      worktree_path: "/tmp/target",
      kind: "directory" as const,
      bus_path: "/tmp/target/.glosa",
      prior_lifecycle: { state: "active" as const },
    };
    const op = {
      operation_id: "op-1",
      target_registration_id: "reg-target",
      target_slug: "target",
      members: [member],
      started_at: "2020-01-01T00:00:00.000Z",
    };
    const liveLifecycle = {
      state: "forgetting" as const,
      started_at: "2020-01-01T00:00:00.000Z",
      target_registration_id: "reg-target",
    };

    const cases: Array<{ name: string; overrides: Record<string, unknown> }> = [
      { name: "drifted slug", overrides: { slug: "some-other-slug" } },
      { name: "drifted canonical_path", overrides: { canonical_path: "/tmp/elsewhere" } },
      { name: "drifted kind", overrides: { kind: "loose-file" } },
      { name: "drifted bus_path", overrides: { bus_path: "/tmp/target/.glosa-other" } },
      { name: "drifted worktree_path", overrides: { worktree_path: "/tmp/elsewhere" } },
    ];

    for (const { name, overrides } of cases) {
      const home = freshHome();
      mkdirSync(home, { recursive: true });
      writeFileSync(
        workspaceIndexPath(home),
        JSON.stringify({
          version: 4,
          updated_at: "2020-01-01T00:00:00.000Z",
          workspaces: { "reg-target": { ...validWorkspace, lifecycle: liveLifecycle, ...overrides } },
          adoptions: {},
          forget_operations: { "op-1": op },
        }),
      );
      const index = new WorkspaceIndex({ home, now: deterministicClock() });
      expect(index.list(), name).toEqual([]);
      expect(index.pendingForgetOperations(), name).toEqual([]);
      const siblings = readdirSync(home).filter((n) => n.startsWith("workspaces.json.corrupt."));
      expect(siblings, name).toHaveLength(1);
      cleanup(home);
    }
  });

  test("a workspace/prior_lifecycle 'adopted' value missing sealed_at is quarantined (held-review finding, final pass)", async () => {
    // Regression: "`adopted` lifecycle validation accepts a missing `sealed_at`, including inside
    // `prior_lifecycle`." Two sites: a live entry's own `lifecycle`, and a forget member's
    // `prior_lifecycle` snapshot — both must reject `state:"adopted"` without `sealed_at`.
    const home = freshHome();
    mkdirSync(home, { recursive: true });
    writeFileSync(
      workspaceIndexPath(home),
      JSON.stringify({
        version: 4,
        updated_at: "2020-01-01T00:00:00.000Z",
        workspaces: {
          "reg-target": {
            ...validWorkspace,
            lifecycle: { state: "adopted", adoption_id: "a1", target_registration_id: "reg-other" }, // no sealed_at
          },
        },
        adoptions: {},
        forget_operations: {},
      }),
    );
    const index = new WorkspaceIndex({ home, now: deterministicClock() });
    expect(index.list()).toEqual([]);
    expect(readdirSync(home).filter((n) => n.startsWith("workspaces.json.corrupt."))).toHaveLength(1);
    cleanup(home);

    const home2 = freshHome();
    mkdirSync(home2, { recursive: true });
    const memberMissingSealedAt = {
      registration_id: "reg-target",
      slug: "target",
      canonical_path: "/tmp/target",
      worktree_path: "/tmp/target",
      kind: "directory" as const,
      bus_path: "/tmp/target/.glosa",
      prior_lifecycle: { state: "adopted", adoption_id: "a1", target_registration_id: "reg-other" }, // no sealed_at
    };
    writeFileSync(
      workspaceIndexPath(home2),
      JSON.stringify({
        version: 4,
        updated_at: "2020-01-01T00:00:00.000Z",
        workspaces: {},
        adoptions: {},
        forget_operations: {
          "op-1": {
            operation_id: "op-1",
            target_registration_id: "reg-target",
            target_slug: "target",
            members: [memberMissingSealedAt],
            started_at: "2020-01-01T00:00:00.000Z",
          },
        },
      }),
    );
    const index2 = new WorkspaceIndex({ home: home2, now: deterministicClock() });
    expect(index2.pendingForgetOperations()).toEqual([]);
    expect(readdirSync(home2).filter((n) => n.startsWith("workspaces.json.corrupt."))).toHaveLength(1);
    cleanup(home2);
  });

  test("an active forget operation with a missing target but a still-live source is quarantined (issue #156 target-last invariant)", async () => {
    // Regression (fifth held-review pass): "an active operation whose target row is absent but
    // whose source row remains live passes schema-v4 validation, then the missing-target branch
    // stamps completion without deleting that source bus." `commitForgetLocked` always removes
    // every source registration BEFORE the target's own (sources-first, target-last) — so the
    // target's row can only ever be legitimately absent once EVERY other snapshotted member is
    // gone too. A live source with an absent target is therefore an impossible state under normal
    // operation, and must never be silently trusted at load time.
    const targetMember = {
      registration_id: "reg-target",
      slug: "target",
      canonical_path: "/tmp/target",
      worktree_path: "/tmp/target",
      kind: "directory" as const,
      bus_path: "/tmp/target/.glosa",
      prior_lifecycle: { state: "active" as const },
    };
    const sourceMember = {
      registration_id: "reg-source",
      slug: "source",
      canonical_path: "/tmp/source",
      worktree_path: "/tmp/source",
      kind: "directory" as const,
      bus_path: "/tmp/source/.glosa",
      prior_lifecycle: { state: "active" as const },
    };
    const op = {
      operation_id: "op-1",
      target_registration_id: "reg-target",
      target_slug: "target",
      members: [targetMember, sourceMember],
      started_at: "2020-01-01T00:00:00.000Z",
    };
    const liveSource = {
      ...validWorkspace,
      registration_id: "reg-source",
      slug: "source",
      canonical_path: "/tmp/source",
      worktree_path: "/tmp/source",
      bus_path: "/tmp/source/.glosa",
      lifecycle: {
        state: "forgetting" as const,
        started_at: "2020-01-01T00:00:00.000Z",
        target_registration_id: "reg-target",
      },
    };

    const home = freshHome();
    mkdirSync(home, { recursive: true });
    writeFileSync(
      workspaceIndexPath(home),
      JSON.stringify({
        version: 4,
        updated_at: "2020-01-01T00:00:00.000Z",
        // No "reg-target" row at all — deregistered — but "reg-source" is still live.
        workspaces: { "reg-source": liveSource },
        adoptions: {},
        forget_operations: { "op-1": op },
      }),
    );
    const index = new WorkspaceIndex({ home, now: deterministicClock() });
    expect(index.list()).toEqual([]); // quarantined -> fresh empty index, not a half-trusted one
    expect(index.pendingForgetOperations()).toEqual([]);
    const siblings = readdirSync(home).filter((n) => n.startsWith("workspaces.json.corrupt."));
    expect(siblings).toHaveLength(1);
    cleanup(home);
  });
});

describe("WorkspaceIndex — v2 workspace contexts", () => {
  test("atomically migrates a v1 directory entry without changing its slug, root, or local bus", () => {
    const home = freshHome();
    const root = freshWorkspaceDir();
    mkdirSync(home, { recursive: true });
    writeFileSync(
      workspaceIndexPath(home),
      JSON.stringify({
        version: 1,
        updated_at: "2024-01-01T00:00:00.000Z",
        workspaces: {
          [root]: {
            canonical_path: root,
            slug: "kept-slug",
            slug_len: 6,
            source: "session",
            first_seen: "2024-01-01T00:00:00.000Z",
            last_seen: "2024-01-01T00:00:00.000Z",
            present: true,
          },
        },
      }),
    );

    const entry = new WorkspaceIndex({ home }).list()[0];
    expect(entry).toBeDefined();
    if (!entry) throw new Error("expected migrated workspace entry");
    expect(entry.slug).toBe("kept-slug");
    expect(entry.canonical_path).toBe(root);
    expect(entry.worktree_path).toBe(root);
    expect(entry.bus_path).toBe(join(root, ".glosa"));
    expect(entry.kind).toBe("directory");
    expect(entry.tracking).toEqual({ mode: "matcher" });
    expect(entry.registration_id).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(readFileSync(workspaceIndexPath(home), "utf8")).version).toBe(4);

    cleanup(home);
    cleanup(root);
  });

  test("atomically migrates a v3 index (pre-issue-#156, no forget_operations map) preserving workspaces and adoptions", () => {
    const home = freshHome();
    const root = freshWorkspaceDir();
    mkdirSync(home, { recursive: true });
    const registrationId = "a".repeat(64);
    writeFileSync(
      workspaceIndexPath(home),
      JSON.stringify({
        version: 3,
        updated_at: "2024-01-01T00:00:00.000Z",
        workspaces: {
          [registrationId]: {
            registration_id: registrationId,
            kind: "directory",
            canonical_path: root,
            worktree_path: root,
            bus_path: join(root, ".glosa"),
            tracking: { mode: "matcher" },
            slug: "v3-slug",
            slug_len: 6,
            source: "session",
            first_seen: "2024-01-01T00:00:00.000Z",
            last_seen: "2024-01-01T00:00:00.000Z",
            present: true,
            lifecycle: { state: "active" },
          },
        },
        adoptions: {},
      }),
    );

    const index = new WorkspaceIndex({ home });
    const entry = index.list()[0];
    expect(entry).toBeDefined();
    if (!entry) throw new Error("expected migrated workspace entry");
    expect(entry.slug).toBe("v3-slug");
    expect(entry.registration_id).toBe(registrationId);
    expect(index.pendingForgetOperations()).toEqual([]);

    const onDisk = JSON.parse(readFileSync(workspaceIndexPath(home), "utf8"));
    expect(onDisk.version).toBe(4);
    expect(onDisk.forget_operations).toEqual({});

    cleanup(home);
    cleanup(root);
  });

  test("two loose sibling files receive distinct full-hash buses and bounded tracked lists", async () => {
    const home = freshHome();
    const root = freshWorkspaceDir();
    const firstPath = join(root, "first.md");
    const secondPath = join(root, "second.md");
    writeFileSync(firstPath, "first");
    writeFileSync(secondPath, "second");
    const index = new WorkspaceIndex({ home });

    const first = await index.resolveOpenTarget(firstPath);
    const second = await index.resolveOpenTarget(secondPath);

    expect(first.entry.kind).toBe("loose-file");
    expect(second.entry.kind).toBe("loose-file");
    expect(first.entry.registration_id).not.toBe(second.entry.registration_id);
    expect(first.entry.bus_path).toBe(join(home, "state", first.entry.registration_id));
    expect(second.entry.bus_path).toBe(join(home, "state", second.entry.registration_id));
    expect(resolveTrackedFiles(first.entry).tracked.map((file) => file.path)).toEqual(["first.md"]);
    expect(resolveTrackedFiles(second.entry).tracked.map((file) => file.path)).toEqual(["second.md"]);
    expect(index.get(root)).toBeNull();

    cleanup(home);
    cleanup(root);
  });

  test("concurrent hardlink aliases converge on one registration and its representative focus", async () => {
    const home = freshHome();
    const root = freshWorkspaceDir();
    const representative = join(root, "representative.md");
    const alias = join(root, "alias.md");
    writeFileSync(representative, "shared");
    linkSync(representative, alias);
    const index = new WorkspaceIndex({ home });

    const [first, second] = await Promise.all([
      index.resolveOpenTarget(representative),
      index.resolveOpenTarget(alias),
    ]);

    expect(second.entry.registration_id).toBe(first.entry.registration_id);
    expect(second.entry.bus_path).toBe(first.entry.bus_path);
    expect(second.focus).toBe("representative.md");
    expect(index.list()).toHaveLength(1);

    cleanup(home);
    cleanup(root);
  });

  test("deepest directory owns tracked files while explicitly named exclusions open as bounded loose files", async () => {
    const home = freshHome();
    const outer = freshWorkspaceDir();
    const inner = join(outer, "nested");
    const hidden = join(inner, ".kombajn", "plans", "secret.md");
    const hiddenAlias = join(inner, ".kombajn", "plans", "secret-alias.md");
    const customExcluded = join(inner, "drafts", "excluded.md");
    const oversized = join(inner, "oversized.md");
    const unsupportedExtension = join(inner, "artifact.json");
    const gitignored = join(inner, "gitignored.md");
    const tracked = join(inner, "note.md");
    const symlink = join(inner, "alias.md");
    mkdirSync(join(inner, ".kombajn", "plans"), { recursive: true });
    mkdirSync(join(inner, "drafts"), { recursive: true });
    mkdirSync(join(inner, ".glosa"), { recursive: true });
    writeFileSync(join(inner, ".gitignore"), ".kombajn/\ngitignored.md\n");
    writeFileSync(join(inner, ".glosa", "config.json"), JSON.stringify({ artifacts: { exclude: ["drafts/**"] } }));
    writeFileSync(hidden, "hidden");
    linkSync(hidden, hiddenAlias);
    writeFileSync(customExcluded, "excluded");
    writeFileSync(oversized, Buffer.alloc(2 * 1024 * 1024 + 1));
    writeFileSync(unsupportedExtension, "json");
    writeFileSync(gitignored, "gitignored but matcher-visible");
    writeFileSync(tracked, "tracked");
    symlinkSync(tracked, symlink);
    const index = new WorkspaceIndex({ home });
    await index.resolveOpenTarget(outer);
    const nested = await index.resolveOpenTarget(inner);

    const owned = await index.resolveOpenTarget(tracked);
    expect(owned.entry.registration_id).toBe(nested.entry.registration_id);
    expect(owned.focus).toBe("note.md");

    // Git ignore state never drives glosa's matcher: a normal .md remains part of the directory.
    const ignoredByGitOnly = await index.resolveOpenTarget(gitignored);
    expect(ignoredByGitOnly.entry.registration_id).toBe(nested.entry.registration_id);

    const hiddenLoose = await index.resolveOpenTarget(hidden);
    const hiddenAgain = await index.resolveOpenTarget(hidden);
    const hardlinkAlias = await index.resolveOpenTarget(hiddenAlias);
    const customLoose = await index.resolveOpenTarget(customExcluded);
    const oversizedLoose = await index.resolveOpenTarget(oversized);
    const extensionLoose = await index.resolveOpenTarget(unsupportedExtension);
    for (const opened of [hiddenLoose, customLoose, oversizedLoose, extensionLoose]) {
      expect(opened.entry.kind).toBe("loose-file");
      expect(opened.entry.bus_path).toBe(join(home, "state", opened.entry.registration_id));
      expect(resolveTrackedFiles(opened.entry).tracked).toHaveLength(1);
    }
    expect(hiddenAgain.entry.registration_id).toBe(hiddenLoose.entry.registration_id);
    expect(hardlinkAlias.entry.registration_id).toBe(hiddenLoose.entry.registration_id);
    expect(hardlinkAlias.focus).toBe(hiddenLoose.focus);

    const parentPaths = resolveTrackedFiles(nested.entry).tracked.map((file) => file.path);
    expect(parentPaths).toContain("note.md");
    expect(parentPaths).toContain("gitignored.md");
    expect(parentPaths).not.toContain(".kombajn/plans/secret.md");
    expect(parentPaths).not.toContain("drafts/excluded.md");
    expect(parentPaths).not.toContain("oversized.md");
    expect(parentPaths).not.toContain("artifact.json");

    await expect(index.resolveOpenTarget(inner, { focus: hidden })).rejects.toMatchObject({
      code: "artifact-not-tracked",
    });
    await expect(index.resolveOpenTarget(symlink)).rejects.toBeInstanceOf(WorkspaceOpenError);

    cleanup(home);
    cleanup(outer);
  });

  test("fresh directory redirection is opt-in when writable and automatic when local state cannot be created", async () => {
    const home = freshHome();
    const localRoot = freshWorkspaceDir();
    const explicitRoot = freshWorkspaceDir();
    const unwritableRoot = freshWorkspaceDir();
    const unwritableHome = freshHome();
    const localIndex = new WorkspaceIndex({ home, canCreateLocalBus: () => true });

    const local = await localIndex.resolveOpenTarget(localRoot);
    const explicit = await localIndex.resolveOpenTarget(explicitRoot, { externalState: true });
    const unwritable = await new WorkspaceIndex({
      home: unwritableHome,
      canCreateLocalBus: () => false,
    }).resolveOpenTarget(unwritableRoot);

    expect(local.entry.bus_path).toBe(join(local.entry.canonical_path, ".glosa"));
    expect(explicit.entry.bus_path).toBe(join(home, "state", explicit.entry.registration_id));
    expect(unwritable.entry.bus_path).toEndWith(join("state", unwritable.entry.registration_id));

    cleanup(home);
    cleanup(localRoot);
    cleanup(explicitRoot);
    cleanup(unwritableRoot);
    cleanup(unwritableHome);
  });

  test("an existing local bus remains authoritative even when external state is requested", async () => {
    const home = freshHome();
    const root = freshWorkspaceDir();
    mkdirSync(join(root, ".glosa"));
    const entry = await new WorkspaceIndex({
      home,
      canCreateLocalBus: () => false,
    }).resolveOpenTarget(root, { externalState: true });

    expect(entry.entry.bus_path).toBe(join(entry.entry.canonical_path, ".glosa"));

    cleanup(home);
    cleanup(root);
  });

  test("redirected matcher config is restored from the registered bus after an index restart", async () => {
    const home = freshHome();
    const root = freshWorkspaceDir();
    const customPath = join(root, "artifact.custom");
    writeFileSync(customPath, "custom");
    const firstIndex = new WorkspaceIndex({ home });
    const opened = await firstIndex.resolveOpenTarget(root, { externalState: true });
    mkdirSync(opened.entry.bus_path, { recursive: true });
    writeFileSync(
      join(opened.entry.bus_path, "config.json"),
      JSON.stringify({ artifacts: { include: ["**/*.custom"] } }),
    );

    const reloaded = new WorkspaceIndex({ home }).get(opened.entry.canonical_path);
    expect(reloaded).not.toBeNull();
    expect(resolveTrackedFiles(reloaded!).tracked.map((file) => file.path)).toEqual(["artifact.custom"]);

    cleanup(home);
    cleanup(root);
  });

  test("segment-boundary prefix siblings do not inherit a registered directory bus", async () => {
    const home = freshHome();
    const parent = freshWorkspaceDir();
    const owner = join(parent, "docs");
    const prefixSibling = join(parent, "docs-archive");
    mkdirSync(owner);
    mkdirSync(prefixSibling);
    const siblingFile = join(prefixSibling, "note.md");
    writeFileSync(siblingFile, "sibling");
    const index = new WorkspaceIndex({ home });
    const registered = await index.resolveOpenTarget(owner);
    const opened = await index.resolveOpenTarget(siblingFile);

    expect(opened.entry.kind).toBe("loose-file");
    expect(opened.entry.registration_id).not.toBe(registered.entry.registration_id);

    cleanup(home);
    cleanup(parent);
  });
});

describe("WorkspaceIndex — enclosing-repo resolution (issue #96)", () => {
  // Before this fix, `glosa open <repo>/sub/doc.md` on a file no registration owned created a
  // `loose-file` registration whose worktree was the file's CONTAINING directory (`<repo>/sub`),
  // not the repo. That disagreed with what `glosa doctor <repo>` and `glosa init <repo>` treat as
  // the workspace root, and its wiring hint ("run `glosa init <repo>/sub`") could point at a
  // system temp dir or a directory holding several unrelated repos. A file inside a git
  // repository now resolves to a DIRECTORY registration rooted at the repo — the same root
  // `doctor`/`init` use — as long as the repo's own matcher would track that file.

  test("an unowned file inside a git repo registers the repo root as a directory, not a loose file", async () => {
    const home = freshHome();
    const repo = realpathSync(freshWorkspaceDir()); // realpath'd: macOS's $TMPDIR is itself a symlink
    mkdirSync(join(repo, ".git"));
    mkdirSync(join(repo, "sub"));
    const docPath = join(repo, "sub", "doc.md");
    writeFileSync(docPath, "# doc\n");
    const index = new WorkspaceIndex({ home });

    const opened = await index.resolveOpenTarget(docPath);

    expect(opened.entry.kind).toBe("directory");
    expect(opened.entry.canonical_path).toBe(repo);
    expect(opened.entry.worktree_path).toBe(repo);
    expect(opened.focus).toBe("sub/doc.md");
    // Same rule `doctor`/`init` resolve to: `.claude/settings.json` would land at the repo root,
    // not at `<repo>/sub/.claude/settings.json`, which Claude Code never reads.
    expect(opened.entry.bus_path).toBe(join(repo, ".glosa"));

    cleanup(home);
    cleanup(repo);
  });

  test("a second unowned file in the same repo reuses the same directory registration", async () => {
    const home = freshHome();
    const repo = freshWorkspaceDir();
    mkdirSync(join(repo, ".git"));
    writeFileSync(join(repo, "a.md"), "a");
    writeFileSync(join(repo, "b.md"), "b");
    const index = new WorkspaceIndex({ home });

    const first = await index.resolveOpenTarget(join(repo, "a.md"));
    const second = await index.resolveOpenTarget(join(repo, "b.md"));

    expect(first.entry.registration_id).toBe(second.entry.registration_id);
    expect(index.list().filter((e) => e.kind === "directory")).toHaveLength(1);

    cleanup(home);
    cleanup(repo);
  });

  test("a file the repo's own matcher excludes still falls back to a loose-file registration", async () => {
    const home = freshHome();
    const repo = realpathSync(freshWorkspaceDir());
    mkdirSync(join(repo, ".git"));
    mkdirSync(join(repo, "node_modules", "pkg"), { recursive: true });
    const excluded = join(repo, "node_modules", "pkg", "readme.md");
    writeFileSync(excluded, "excluded");
    const index = new WorkspaceIndex({ home });

    const opened = await index.resolveOpenTarget(excluded);

    // Falls through to the existing loose-file path rather than newly failing
    // `artifact-not-tracked` — opening a file the matcher would never track anyway must keep
    // working exactly as it did before this fix.
    expect(opened.entry.kind).toBe("loose-file");
    expect(opened.entry.worktree_path).toBe(join(repo, "node_modules", "pkg"));

    cleanup(home);
    cleanup(repo);
  });

  test("a file outside any git repo still registers as a loose file over its containing directory", async () => {
    const home = freshHome();
    const dir = realpathSync(freshWorkspaceDir()); // no .git anywhere in its ancestry
    const docPath = join(dir, "note.md");
    writeFileSync(docPath, "note");
    const index = new WorkspaceIndex({ home });

    const opened = await index.resolveOpenTarget(docPath);

    expect(opened.entry.kind).toBe("loose-file");
    expect(opened.entry.worktree_path).toBe(dir);

    cleanup(home);
    cleanup(dir);
  });

  test("a nested git repo (e.g. a submodule) wins over its outer repo — the NEAREST enclosing root", async () => {
    const home = freshHome();
    const outer = realpathSync(freshWorkspaceDir());
    mkdirSync(join(outer, ".git"));
    const inner = join(outer, "vendor", "lib");
    mkdirSync(join(inner, ".git"), { recursive: true });
    const docPath = join(inner, "doc.md");
    writeFileSync(docPath, "doc");
    const index = new WorkspaceIndex({ home });

    const opened = await index.resolveOpenTarget(docPath);

    expect(opened.entry.canonical_path).toBe(inner);
    expect(opened.focus).toBe("doc.md");

    cleanup(home);
    cleanup(outer);
  });
});

// A5 §F19 makes this file's on-disk bytes the durable truth and the daemon its sole writer, so a
// `persist()` that failed must be indistinguishable from one that never ran — otherwise a caller
// told "500, nothing happened" is lied to, and the next successful write silently commits the
// mutation it was told had failed. `openSync`/`write`/`fsyncSync`/`renameSync` all really do throw
// (ENOSPC, EROFS, EMFILE, a read-only `~/.glosa`); the injected `write` stands in for all of them
// because it is the one step in the sequence a test can fail on demand.
describe("WorkspaceIndex — a failed persist changes nothing", () => {
  const enospc = (): never => {
    const err: NodeJS.ErrnoException = new Error("ENOSPC: no space left on device, write");
    err.code = "ENOSPC";
    throw err;
  };

  /** `write` that fails only while `state.fail` is set, so a test can build its fixture normally
   * and then break exactly one persist. */
  function faultyWrite(state: { fail: boolean }) {
    return (fd: number, buf: Buffer, offset: number, length: number): number =>
      state.fail ? enospc() : writeSync(fd, buf, offset, length);
  }

  test("a forget() whose persist throws leaves the workspace readable in memory and on disk", async () => {
    const home = freshHome();
    const fault = { fail: false };
    const evicted: string[] = [];
    const index = new WorkspaceIndex({
      home,
      now: deterministicClock(),
      onHardRemove: (entry) => {
        evicted.push(entry.canonical_path);
      },
      write: faultyWrite(fault),
    });
    const entry = await index.upsertWorkspace("/ws/keep-me", "session");

    fault.fail = true;
    await expect(index.forget(entry.slug)).rejects.toThrow(/ENOSPC/);
    fault.fail = false;

    // The HTTP caller got a 500 and believes nothing happened — every reader must agree.
    expect(index.getBySlug(entry.slug)).not.toBeNull();
    expect(index.get("/ws/keep-me")).not.toBeNull();
    expect(index.list()).toHaveLength(1);
    expect(Object.keys(JSON.parse(readFileSync(workspaceIndexPath(home), "utf8")).workspaces)).toHaveLength(1);
    // Eviction must stay behind the durable write: tearing down the bus for a workspace that is
    // still registered would destroy live journal/lease state nothing asked to remove.
    expect(evicted).toEqual([]);
    cleanup(home);
  });

  test("a later successful mutation never commits a deletion whose persist failed", async () => {
    const home = freshHome();
    const fault = { fail: false };
    const index = new WorkspaceIndex({ home, now: deterministicClock(), write: faultyWrite(fault) });
    const doomed = await index.upsertWorkspace("/ws/doomed", "session");

    fault.fail = true;
    await expect(index.forget(doomed.slug)).rejects.toThrow(/ENOSPC/);
    fault.fail = false;

    await index.upsertWorkspace("/ws/unrelated", "session"); // succeeds — must not carry the deletion

    const onDisk = JSON.parse(readFileSync(workspaceIndexPath(home), "utf8"));
    expect(Object.keys(onDisk.workspaces)).toHaveLength(2);
    expect(onDisk.workspaces[doomed.registration_id]).toBeDefined();
    expect(index.getBySlug(doomed.slug)).not.toBeNull();
    cleanup(home);
  });

  test("a GC hard-remove whose persist throws keeps the entry and never fires onHardRemove", async () => {
    const home = freshHome();
    const clock = manualClock();
    const fault = { fail: false };
    const evicted: string[] = [];
    let onDisk = true;
    const index = new WorkspaceIndex({
      home,
      now: clock,
      gcGraceMs: 1_000,
      gcThrottleMs: 0,
      hasLiveSession: () => false,
      pathExists: () => onDisk,
      onHardRemove: (entry) => {
        evicted.push(entry.canonical_path);
      },
      write: faultyWrite(fault),
    });
    await index.upsertWorkspace("/ws/gone", "session");

    onDisk = false;
    await index.gc({ force: true }); // softens to present:false, starts the grace clock
    clock.advance(5_000);

    fault.fail = true;
    await expect(index.gc({ force: true })).rejects.toThrow(/ENOSPC/);
    fault.fail = false;

    expect(index.get("/ws/gone")).not.toBeNull();
    expect(index.list()).toHaveLength(1);
    expect(Object.keys(JSON.parse(readFileSync(workspaceIndexPath(home), "utf8")).workspaces)).toHaveLength(1);
    // The bus must not be evicted while the registration is still live — memory, disk, and the
    // bus registry all still say the workspace exists.
    expect(evicted).toEqual([]);
    cleanup(home);
  });

  test("an adoption phase transition whose persist throws leaves the resumable phase unchanged", async () => {
    const home = freshHome();
    const root = realpathSync(freshWorkspaceDir());
    writeFileSync(join(root, "notes.md"), "first\n");
    const fault = { fail: false };
    const index = new WorkspaceIndex({ home, now: deterministicClock(), write: faultyWrite(fault) });

    const loose = await index.resolveOpenTarget(join(root, "notes.md"));
    mkdirSync(loose.entry.bus_path, { recursive: true }); // a durable source bus is what makes it adoptable
    const directory = await index.resolveOpenTarget(root);
    const record = await index.beginAdoption(directory.entry);
    expect(record?.phase).toBe("planned");
    const adoptionId = record?.adoption_id ?? "";

    fault.fail = true;
    await expect(index.markAdoptionSourcesSealed(adoptionId)).rejects.toThrow(/ENOSPC/);
    fault.fail = false;

    // A crash-resumable phase machine that advanced only in memory resumes from the wrong phase.
    expect(index.getAdoption(adoptionId)?.phase).toBe("planned");
    expect(index.pendingAdoptions().map((r) => r.phase)).toEqual(["planned"]);
    expect(JSON.parse(readFileSync(workspaceIndexPath(home), "utf8")).adoptions[adoptionId].phase).toBe("planned");
    cleanup(home);
    cleanup(root);
  });

  test("a short write can never truncate the index (A4 §F04 — writeSync may write fewer bytes)", async () => {
    const home = freshHome();
    let short = false;
    const index = new WorkspaceIndex({
      home,
      now: deterministicClock(),
      write: (fd, buf, offset, length) => writeSync(fd, buf, offset, short ? Math.min(length, 8) : length),
    });
    await index.upsertWorkspace("/ws/a", "session");

    short = true;
    await index.upsertWorkspace("/ws/b", "session");

    const raw = readFileSync(workspaceIndexPath(home), "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(Object.keys(JSON.parse(raw).workspaces)).toHaveLength(2);
    cleanup(home);
  });
});

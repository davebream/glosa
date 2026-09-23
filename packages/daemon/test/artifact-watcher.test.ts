// SPDX-License-Identifier: Apache-2.0
// Regression coverage for #91/#219 and for the restart/readiness stalls chokidar's per-file watches
// caused on Bun: a directory workspace is ONE native recursive watch, excluded churn never reaches
// the matcher, one watch is shared per registration, and oversized or erroring workspaces fail soft
// instead of destabilizing the singleton daemon.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactWatcherAllocation } from "../src/artifact-watcher-allocation.ts";
import {
  ArtifactWatcherRegistry,
  type ArtifactWatcherEvent,
  nativeWorkspaceWatch,
  type WorkspaceWatch,
  type WorkspaceWatchFactory,
  type WorkspaceWatchRequest,
} from "../src/artifact-watcher.ts";
import { SessionRegistry } from "../src/registry/session-registry.ts";
import { WorkspaceIndex, type WorkspaceEntry } from "../src/registry/workspace-index.ts";
import type { WorkspaceLocation } from "../src/workspace.ts";
import { cleanupWorkspace, freshWorkspace, makeDir, makeSymlink, writeFile } from "./matcher/helpers.ts";
import { armedWatchFactory } from "./watch-helpers.ts";

// 15 s, not Bun's 5 s default: these waits sit on real filesystem events, which a loaded macos-14
// runner can take seconds to deliver. The budget is the wait, not the work.
async function waitUntil(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(20);
  if (!predicate()) throw new Error("timed out waiting for artifact watcher state");
}

/** Save `content` to `path`, then keep re-saving it every 250 ms until `observed()` is true.
 *
 * Why the loop: a single write issued right after a watch starts is not reliably observed on
 * macOS: the kernel-side FSEvents stream comes up asynchronously, so the very first save can fall
 * into the gap (the start is not a clean cut the other way either; see `watch-helpers.ts`). It did
 * exactly that in CI:
 * the "custom matcher config" test below waited the full 15 s for a write that had already
 * happened, both on this suite's own PR and on main, while passing locally every time. A real
 * editor produces many saves, so the product sees the second one; a test that saves once must
 * either do the same or assert on a lost cause. Every save writes identical bytes, so the test
 * still checks that the watcher reacts to a change at this path, not how many saves it took.
 */
async function saveUntil(path: string, content: string, observed: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    writeFileSync(path, content);
    const next = Math.min(Date.now() + 250, deadline);
    while (!observed() && Date.now() < next) await Bun.sleep(20);
    if (observed()) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for the watcher to see ${path}`);
  }
}

/** A watch the test drives by hand: `change` plays a filesystem event, `fail` a watch error. */
class FakeWatch implements WorkspaceWatch {
  closeCalls = 0;
  constructor(readonly request: WorkspaceWatchRequest) {}
  change(absPath: string): void {
    this.request.onChange(absPath);
  }
  fail(): void {
    this.request.onError(new Error("boom"));
  }
  close(): void {
    this.closeCalls += 1;
  }
}

function fakeFactory(): { fakes: FakeWatch[]; watchFactory: (request: WorkspaceWatchRequest) => WorkspaceWatch } {
  const fakes: FakeWatch[] = [];
  return {
    fakes,
    watchFactory: (request) => {
      const fake = new FakeWatch(request);
      fakes.push(fake);
      return fake;
    },
  };
}

describe("ArtifactWatcherRegistry — bounded shared watching (#91)", () => {
  let root: string;
  const registries: ArtifactWatcherRegistry[] = [];

  beforeEach(() => {
    root = freshWorkspace();
  });

  afterEach(async () => {
    await Promise.all(registries.map((registry) => registry.closeAll()));
    cleanupWorkspace(root);
  });

  test("a directory workspace is one recursive watch on its root, and excluded churn produces no events", async () => {
    // The tracked note is moved in with its directory, never written under `root`. A new watch can
    // be handed a write made before it existed, seconds late under load (#349), so a write naming
    // `docs/note.md` could surface below as an artifact event the churn never caused. A directory
    // moved in is reported as `docs` alone, which names no tracked file. The excluded fixtures are
    // written in place: a late event for one of them is excluded churn like any other.
    const staging = freshWorkspace();
    writeFile(staging, "docs/note.md", "one");
    renameSync(join(staging, "docs"), join(root, "docs"));
    cleanupWorkspace(staging);
    writeFile(root, "node_modules/pkg/readme.md", "excluded");
    writeFile(root, ".git/objects/noise.md", "excluded");
    writeFile(root, ".glosa/private.md", "excluded");
    writeFile(root, ".someagent/worktrees/w1/noise.md", "excluded");
    writeFile(root, "src/code.ts", "unrelated");
    const outside = freshWorkspace();
    writeFile(outside, "outside.md", "outside");
    makeSymlink(outside, join(root, "linked"));

    const { watchFactory, armed, requests } = armedWatchFactory();
    const events: ArtifactWatcherEvent[] = [];
    const registry = new ArtifactWatcherRegistry({ watchFactory });
    registries.push(registry);
    const stop = registry.subscribe(root, (event) => events.push(event));

    expect(requests.map((request) => ({ mode: request.mode, root: request.root }))).toEqual([{ mode: "tree", root }]);
    expect(registry.modeFor(root)).toBe("tree");
    await armed();

    for (let i = 0; i < 100; i++) {
      writeFileSync(join(root, "node_modules", "pkg", "readme.md"), `excluded-${i}`);
      writeFileSync(join(root, ".someagent", "worktrees", "w1", "noise.md"), `excluded-${i}`);
      writeFileSync(join(root, ".git", "objects", "noise.md"), `excluded-${i}`);
      writeFileSync(join(root, "src", "code.ts"), `unrelated-${i}`);
      writeFileSync(join(outside, "outside.md"), `outside-${i}`);
    }
    await Bun.sleep(1_500);
    expect(events).toEqual([]);

    // The same watch is live: a tracked save still arrives, so the silence above is filtering.
    await saveUntil(join(root, "docs", "note.md"), "two", () =>
      events.some((event) => event.type === "artifact" && event.data.path === "docs/note.md"),
    );
    expect(events.every((event) => event.type !== "artifact" || event.data.path === "docs/note.md")).toBe(true);

    stop();
    cleanupWorkspace(outside);
  }, 30_000);

  test("watching a large workspace neither blocks the event loop nor takes long to close", async () => {
    // The regression behind this rewrite: chokidar held one Bun `fs.watch` per file, and Bun's
    // per-file watches cost more the more there are — a daemon warming 8 workspaces of 300 files
    // did not answer its handshake for ~80 s, and one exiting sat in close() for 30 s+.
    for (let d = 0; d < 20; d++) {
      for (let f = 0; f < 100; f++) writeFile(root, `docs/d${d}/n${f}.md`, `note ${d}/${f}`);
    }
    let last = performance.now();
    let maxGap = 0;
    const tick = setInterval(() => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
    }, 10);
    try {
      const registry = new ArtifactWatcherRegistry();
      registries.push(registry);
      const started = performance.now();
      registry.ensureWatched(root);
      await Bun.sleep(1_000);
      expect(registry.modeFor(root)).toBe("tree");
      const closing = performance.now();
      await registry.closeAll();
      const closeMs = performance.now() - closing;
      await Bun.sleep(50);

      // 2,000 per-file watches took minutes to open on Bun 1.4.2; a recursive watch takes milliseconds.
      expect(closing - started).toBeLessThan(3_000);
      expect(closeMs).toBeLessThan(500);
      expect(maxGap).toBeLessThan(1_000);
    } finally {
      clearInterval(tick);
    }
  }, 30_000);

  test("a sibling root whose path extends this one does not leak its events into this watch", async () => {
    // Bun hands a recursive watcher on `…/ws` the events of a watched `…/ws2` as `2/…`.
    const sibling = `${root}2`;
    mkdirSync(join(sibling, "docs"), { recursive: true });
    writeFile(root, "docs/mine.md", "mine");
    const seen: string[] = [];
    const siblingSeen: string[] = [];
    const watches = [
      nativeWorkspaceWatch({
        mode: "tree",
        root: sibling,
        files: [],
        onChange: (path) => siblingSeen.push(path),
        onError: () => {},
      }),
      nativeWorkspaceWatch({ mode: "tree", root, files: [], onChange: (path) => seen.push(path), onError: () => {} }),
    ];
    try {
      await saveUntil(join(sibling, "docs", "theirs.md"), "theirs", () => siblingSeen.length > 0);
      await saveUntil(join(root, "docs", "mine.md"), "mine again", () => seen.includes(join(root, "docs", "mine.md")));
      await Bun.sleep(500);
      // The leak's signature is the sibling's file surfacing under this root (`<root>/2/docs/theirs.md`).
      expect(seen.filter((path) => path.includes("theirs.md"))).toEqual([]);
    } finally {
      for (const watch of watches) watch.close();
      rmSync(sibling, { recursive: true, force: true });
    }
  }, 30_000);

  test("changes the matcher would never track cost no matcher walk", async () => {
    writeFile(root, "docs/note.md", "one");
    writeFile(root, "node_modules/pkg/readme.md", "excluded");
    writeFile(root, "src/code.ts", "unrelated");
    const { fakes, watchFactory } = fakeFactory();
    const registry = new ArtifactWatcherRegistry({ watchFactory });
    registries.push(registry);
    registry.ensureWatched(root);

    for (let i = 0; i < 50; i++) {
      fakes[0]!.change(join(root, "node_modules", "pkg", "readme.md"));
      fakes[0]!.change(join(root, ".git", "index"));
      fakes[0]!.change(join(root, ".glosa", "journal.jsonl"));
      fakes[0]!.change(join(root, "src", "code.ts"));
    }
    await Bun.sleep(200);
    expect(registry.reconcileCount(root)).toBe(0);

    // The counter does move for a change that matters, so the zero above is the filter.
    fakes[0]!.change(join(root, "docs", "note.md"));
    await waitUntil(() => registry.reconcileCount(root) === 1);
  });

  test("abandonAll retires every state without closing its watch, and stops delivering events", async () => {
    writeFile(root, "docs/note.md", "one");
    const second = freshWorkspace();
    writeFile(second, "note.md", "one");
    const { fakes, watchFactory } = fakeFactory();
    const events: ArtifactWatcherEvent[] = [];
    const registry = new ArtifactWatcherRegistry({ watchFactory });
    registries.push(registry);
    registry.subscribe(root, (event) => events.push(event));
    registry.ensureWatched(second);
    expect(fakes).toHaveLength(2);

    registry.abandonAll();

    expect(fakes.map((fake) => fake.closeCalls)).toEqual([0, 0]);
    expect(registry.watchedWorkspaceCount()).toBe(0);
    expect(registry.modeFor(root)).toBeNull();
    writeFileSync(join(root, "docs", "note.md"), "two");
    fakes[0]!.change(join(root, "docs", "note.md"));
    await Bun.sleep(150);
    expect(events).toEqual([]);
    cleanupWorkspace(second);
  });

  test("tracked changes, atomic replacement, new nested artifacts, deletion, and oversize crossings reconcile", async () => {
    const note = writeFile(root, "docs/note.md", "one");
    const events: ArtifactWatcherEvent[] = [];
    const { watchFactory, armed } = armedWatchFactory();
    const registry = new ArtifactWatcherRegistry({ watchFactory });
    registries.push(registry);
    registry.subscribe(root, (event) => events.push(event));
    await armed();

    await saveUntil(note, "two", () =>
      events.some((event) => event.type === "artifact" && event.data.path === "docs/note.md"),
    );

    events.length = 0;
    const replacement = join(root, "docs", ".note.tmp");
    writeFileSync(replacement, "atomic");
    renameSync(replacement, note);
    await waitUntil(() => events.some((event) => event.type === "artifact" && event.data.path === "docs/note.md"));

    events.length = 0;
    mkdirSync(join(root, "new", "deep"), { recursive: true });
    writeFileSync(join(root, "new", "deep", "fresh.md"), "fresh");
    await waitUntil(() =>
      events.some(
        (event) =>
          event.type === "artifact_index" &&
          event.data.changes.some((change) => change.type === "file_tracked" && change.path === "new/deep/fresh.md"),
      ),
    );
    expect(events.some((event) => event.type === "artifact" && event.data.path === "new/deep/fresh.md")).toBe(true);

    events.length = 0;
    rmSync(note);
    await waitUntil(() =>
      events.some(
        (event) =>
          event.type === "artifact_index" &&
          event.data.changes.some(
            (change) =>
              change.type === "file_untracked" && change.path === "docs/note.md" && change.reason === "deleted",
          ),
      ),
    );

    events.length = 0;
    writeFileSync(join(root, "new", "deep", "fresh.md"), Buffer.alloc(2 * 1024 * 1024 + 1));
    await waitUntil(() =>
      events.some(
        (event) =>
          event.type === "artifact_index" &&
          event.data.changes.some(
            (change) =>
              change.type === "file_untracked" && change.path === "new/deep/fresh.md" && change.reason === "oversize",
          ),
      ),
    );
  }, 30_000);

  test("custom matcher config drives both discovery and direct-entry filtering", async () => {
    makeDir(root, ".glosa");
    writeFileSync(join(root, ".glosa", "config.json"), JSON.stringify({ artifacts: { include: ["**/*.custom"] } }));
    const custom = writeFile(root, "docs/note.custom", "one");
    const events: ArtifactWatcherEvent[] = [];
    const { watchFactory, armed } = armedWatchFactory();
    const registry = new ArtifactWatcherRegistry({ watchFactory });
    registries.push(registry);
    registry.subscribe(root, (event) => events.push(event));
    await armed();

    await saveUntil(custom, "two", () =>
      events.some((event) => event.type === "artifact" && event.data.path === "docs/note.custom"),
    );
  }, 20_000);

  test("a temporarily absent bounded loose file is watched by exact path and reappears live", async () => {
    const path = writeFile(root, "loose.md", "one");
    writeFile(root, "neighbour.md", "not registered");
    const workspace: WorkspaceLocation = {
      registration_id: "loose-1",
      kind: "loose-file",
      canonical_path: path,
      worktree_path: root,
      bus_path: join(root, ".glosa-loose"),
      tracking: { mode: "bounded", paths: ["loose.md"] },
    };
    rmSync(path);

    const events: ArtifactWatcherEvent[] = [];
    const { watchFactory, armed, requests } = armedWatchFactory();
    const registry = new ArtifactWatcherRegistry({ watchFactory });
    registries.push(registry);
    registry.subscribe(workspace, (event) => events.push(event));
    expect(requests.map((request) => ({ mode: request.mode, files: request.files }))).toEqual([
      { mode: "files", files: [path] },
    ]);
    await armed();

    writeFileSync(join(root, "neighbour.md"), "still not registered");
    await saveUntil(path, "back", () =>
      events.some(
        (event) =>
          event.type === "artifact_index" &&
          event.data.changes.some((change) => change.type === "file_tracked" && change.path === "loose.md"),
      ),
    );
    expect(JSON.stringify(events)).not.toContain("neighbour.md");
  }, 20_000);

  test("two subscribers share one watch and the final unsubscribe closes it", async () => {
    writeFile(root, "note.md", "one");
    const { fakes, watchFactory } = fakeFactory();
    const registry = new ArtifactWatcherRegistry({ watchFactory });
    registries.push(registry);

    const stopA = registry.subscribe(root, () => {});
    const stopB = registry.subscribe(root, () => {});
    expect(fakes).toHaveLength(1);

    stopA();
    await Bun.sleep(0);
    expect(fakes[0]!.closeCalls).toBe(0);
    stopB();
    await waitUntil(() => fakes[0]!.closeCalls === 1);
    expect(registry.modeFor(root)).toBeNull();
  });

  test("a workspace over the tracked-artifact budget opens no watch and warns once", () => {
    const crowded = makeDir(root, "crowded");
    writeFileSync(join(crowded, "a.md"), "a");
    writeFileSync(join(crowded, "b.md"), "b");
    writeFileSync(join(crowded, "c.md"), "c");
    const warnings: string[] = [];
    const { fakes, watchFactory } = fakeFactory();
    const registry = new ArtifactWatcherRegistry({
      maxTrackedArtifacts: 2,
      warn: (message) => warnings.push(message),
      watchFactory,
    });
    registries.push(registry);
    registry.subscribe(root, () => {});
    registry.subscribe(root, () => {});
    expect(registry.modeFor(root)).toBe("disabled");
    expect(registry.liveUpdatesFor(root)).toEqual({
      state: "offline_catchup",
      reason: "tracked_artifact_budget",
    });
    expect(fakes).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("more than 2 tracked artifacts");
  });

  test("a workspace that grows past the budget stops watching after reporting what crossed", async () => {
    writeFile(root, "a.md", "a");
    const { fakes, watchFactory } = fakeFactory();
    const events: ArtifactWatcherEvent[] = [];
    const registry = new ArtifactWatcherRegistry({ maxTrackedArtifacts: 2, watchFactory });
    registries.push(registry);
    registry.subscribe(root, (event) => events.push(event));
    expect(registry.modeFor(root)).toBe("tree");

    writeFile(root, "b.md", "b");
    writeFile(root, "c.md", "c");
    fakes[0]!.change(join(root, "c.md"));
    await waitUntil(() => registry.modeFor(root) === "disabled");
    expect(registry.liveUpdatesFor(root)).toEqual({
      state: "offline_catchup",
      reason: "tracked_artifact_budget",
    });
    expect(fakes[0]!.closeCalls).toBe(1);
    expect(events.some((event) => event.type === "artifact_index")).toBe(true);
  });

  test("a watch error restarts the watch once, and a second error leaves the workspace unwatched", async () => {
    writeFile(root, "docs/note.md", "one");
    const warnings: string[] = [];
    const { fakes, watchFactory } = fakeFactory();
    const registry = new ArtifactWatcherRegistry({ warn: (message) => warnings.push(message), watchFactory });
    registries.push(registry);
    registry.ensureWatched(root);
    expect(registry.modeFor(root)).toBe("tree");

    fakes[0]!.fail();
    expect(fakes[0]!.closeCalls).toBe(1);
    expect(fakes).toHaveLength(2);
    expect(registry.modeFor(root)).toBe("tree");

    fakes[1]!.fail();
    expect(fakes[1]!.closeCalls).toBe(1);
    expect(fakes).toHaveLength(2);
    expect(registry.modeFor(root)).toBe("disabled");
    expect(registry.liveUpdatesFor(root)).toEqual({ state: "offline_catchup", reason: "watch_error" });
    expect(warnings).toHaveLength(1);
  });

  test("diagnostics distinguish starting, initial scan failure, and watch start failure", async () => {
    writeFile(root, "docs/note.md", "one");
    let finishScan!: (value: {
      tracked: never[];
      oversize: never[];
      directories: never[];
      skippedSymlinks: never[];
      truncated: boolean;
    }) => void;
    const pending = new ArtifactWatcherRegistry({
      watchFactory: () => ({ close() {} }),
      initialResolveTrackedFiles: () =>
        new Promise((resolve) => {
          finishScan = resolve;
        }),
    });
    registries.push(pending);
    pending.ensureWatched(root);
    expect(pending.liveUpdatesFor(root)).toEqual({ state: "starting" });
    finishScan({ tracked: [], oversize: [], directories: [], skippedSymlinks: [], truncated: false });
    await Bun.sleep(0);
    expect(pending.liveUpdatesFor(root)).toEqual({ state: "live" });

    const scanFailed = new ArtifactWatcherRegistry({
      initialResolveTrackedFiles: () => {
        throw new Error("scan failed");
      },
    });
    registries.push(scanFailed);
    const scanFailedRoot = makeDir(root, "scan-failed");
    scanFailed.ensureWatched(scanFailedRoot);
    expect(scanFailed.liveUpdatesFor(scanFailedRoot)).toEqual({
      state: "offline_catchup",
      reason: "initial_scan_failed",
    });

    const startFailed = new ArtifactWatcherRegistry({
      watchFactory: () => {
        throw new Error("start failed");
      },
    });
    registries.push(startFailed);
    const startFailedRoot = makeDir(root, "start-failed");
    startFailed.ensureWatched(startFailedRoot);
    expect(startFailed.liveUpdatesFor(startFailedRoot)).toEqual({
      state: "offline_catchup",
      reason: "watch_start_failed",
    });
  });
});

const allocationCleanup: string[] = [];

function allocationTemp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  allocationCleanup.push(path);
  return path;
}

function allocationWorkspace(name: string): string {
  const root = join(allocationTemp("glosa-allocation-workspaces-"), name);
  mkdirSync(root);
  writeFileSync(join(root, "notes.md"), `${name}\n`);
  return root;
}

afterEach(() => {
  for (const path of allocationCleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

interface AllocationHarness {
  index: WorkspaceIndex;
  sessions: SessionRegistry;
  registry: ArtifactWatcherRegistry;
  allocation: ArtifactWatcherAllocation;
  opens: string[];
  closes: string[];
}

function allocationHarness(limit: number, leaseTtlMs = 60_000, realTime = false): AllocationHarness {
  let nowMs = Date.parse("2026-09-21T00:00:00.000Z");
  const now = () => (realTime ? new Date() : new Date(nowMs++));
  const home = allocationTemp("glosa-allocation-home-");
  const index = new WorkspaceIndex({ home, userHomeDir: "/Users/not-this-test", now });
  const sessions = new SessionRegistry({ index, now, leaseTtlMs });
  const opens: string[] = [];
  const closes: string[] = [];
  const watchFactory: WorkspaceWatchFactory = (request) => {
    opens.push(request.root);
    return { close: () => closes.push(request.root) };
  };
  const registry = new ArtifactWatcherRegistry({ maxWatchedWorkspaces: limit, watchFactory });
  const allocation = new ArtifactWatcherAllocation({
    workspaceIndex: index,
    sessionRegistry: sessions,
    watcherRegistry: registry,
    userHomeDir: "/Users/not-this-test",
    now,
  });
  index.setOnRegister(() => allocation.requestRebalance());
  sessions.setOnSessionsChanged(() => allocation.requestRebalance());
  return { index, sessions, registry, allocation, opens, closes };
}

async function registerAllocationWorkspace(harness: AllocationHarness, path: string): Promise<WorkspaceEntry> {
  return harness.index.upsertWorkspace(path, "glosa-open");
}

describe("artifact watcher allocation (#219)", () => {
  test("startup selection is newest-first, independent of index insertion order", async () => {
    const h = allocationHarness(2);
    const oldest = await registerAllocationWorkspace(h, allocationWorkspace("oldest"));
    const middle = await registerAllocationWorkspace(h, allocationWorkspace("middle"));
    const newest = await registerAllocationWorkspace(h, allocationWorkspace("newest"));

    await h.allocation.rebalance();

    expect(h.registry.liveUpdatesFor(oldest)).toEqual({ state: "offline_catchup", reason: "workspace_budget" });
    expect(h.registry.liveUpdatesFor(middle)).toEqual({ state: "live" });
    expect(h.registry.liveUpdatesFor(newest)).toEqual({ state: "live" });
    expect(h.registry.watchedWorkspaceCount()).toBe(2);
    await h.allocation.stop();
    await h.registry.closeAll();
  });

  test("equal last_seen timestamps use registration id, never object insertion order", async () => {
    const fixed = new Date("2026-09-21T00:00:00.000Z");
    const home = allocationTemp("glosa-allocation-tie-home-");
    const index = new WorkspaceIndex({ home, userHomeDir: "/Users/not-this-test", now: () => fixed });
    const sessions = new SessionRegistry({ index, now: () => fixed });
    const registry = new ArtifactWatcherRegistry({
      maxWatchedWorkspaces: 2,
      watchFactory: () => ({ close() {} }),
    });
    const allocation = new ArtifactWatcherAllocation({
      workspaceIndex: index,
      sessionRegistry: sessions,
      watcherRegistry: registry,
      userHomeDir: "/Users/not-this-test",
      now: () => fixed,
    });
    const entries = [
      await index.upsertWorkspace(allocationWorkspace("tie-c"), "glosa-open"),
      await index.upsertWorkspace(allocationWorkspace("tie-a"), "glosa-open"),
      await index.upsertWorkspace(allocationWorkspace("tie-b"), "glosa-open"),
    ];

    await allocation.rebalance();

    const expected = [...entries].sort((a, b) => a.registration_id.localeCompare(b.registration_id)).slice(0, 2);
    expect(
      entries
        .filter((entry) => registry.liveUpdatesFor(entry)?.state === "live")
        .map((entry) => entry.registration_id)
        .sort(),
    ).toEqual(expected.map((entry) => entry.registration_id).sort());
    await allocation.stop();
    await registry.closeAll();
  });

  test("a live session outranks a newer workspace, then lease expiry restores recency", async () => {
    const h = allocationHarness(1, 40, true);
    const live = await registerAllocationWorkspace(h, allocationWorkspace("live-old"));
    await h.sessions.register({
      session_id: "session-live",
      provider: "claude-code",
      cwd: live.canonical_path,
      workspace_binding: live.canonical_path,
      source: "monitor",
    });
    await Bun.sleep(5);
    const recent = await registerAllocationWorkspace(h, allocationWorkspace("newer-no-session"));

    await h.allocation.rebalance();
    expect(h.registry.liveUpdatesFor(live)).toEqual({ state: "live" });
    expect(h.registry.liveUpdatesFor(recent)).toEqual({ state: "offline_catchup", reason: "workspace_budget" });

    // The coordinator's single lease-expiry timer, not another registration/read, drives this swap.
    const deadline = Date.now() + 1_000;
    while (h.registry.liveUpdatesFor(recent)?.state !== "live" && Date.now() < deadline) {
      await Bun.sleep(10);
    }
    expect(h.registry.liveUpdatesFor(live)).toEqual({ state: "offline_catchup", reason: "workspace_budget" });
    expect(h.registry.liveUpdatesFor(recent)).toEqual({ state: "live" });
    await h.allocation.stop();
    await h.registry.closeAll();
  });

  test("a newly live workspace preempts the least-recent watcher and deregistration restores recency", async () => {
    const h = allocationHarness(2);
    const oldest = await registerAllocationWorkspace(h, allocationWorkspace("preempt-oldest"));
    const middle = await registerAllocationWorkspace(h, allocationWorkspace("preempt-middle"));
    const newest = await registerAllocationWorkspace(h, allocationWorkspace("preempt-newest"));
    await h.allocation.rebalance();
    expect(h.registry.liveUpdatesFor(oldest)).toEqual({ state: "offline_catchup", reason: "workspace_budget" });
    const closesBeforePreemption = h.closes.length;

    await h.sessions.register({
      session_id: "preempting-session",
      provider: "claude-code",
      cwd: oldest.canonical_path,
      workspace_binding: oldest.canonical_path,
      source: "monitor",
    });
    await h.allocation.rebalance();

    expect(h.registry.liveUpdatesFor(oldest)).toEqual({ state: "live" });
    expect(h.registry.liveUpdatesFor(middle)).toEqual({ state: "offline_catchup", reason: "workspace_budget" });
    expect(h.registry.liveUpdatesFor(newest)).toEqual({ state: "live" });
    expect(h.closes.slice(closesBeforePreemption)).toEqual([middle.canonical_path]);
    expect(h.opens.filter((path) => path === newest.canonical_path)).toHaveLength(1);

    // Session registration legitimately refreshes the bound workspace's durable `last_seen`.
    // Make the other two newer again so deregistration has a different recency winner to restore.
    await h.index.upsertWorkspace(middle.canonical_path, "glosa-open");
    await h.index.upsertWorkspace(newest.canonical_path, "glosa-open");
    await h.allocation.rebalance();

    await h.sessions.deregister("preempting-session");
    await h.allocation.rebalance();

    expect(h.registry.liveUpdatesFor(oldest)).toEqual({ state: "offline_catchup", reason: "workspace_budget" });
    expect(h.registry.liveUpdatesFor(middle)).toEqual({ state: "live" });
    expect(h.registry.liveUpdatesFor(newest)).toEqual({ state: "live" });
    await h.allocation.stop();
    await h.registry.closeAll();
  });

  test("an unchanged winning set reuses watchers instead of reopening them", async () => {
    const h = allocationHarness(2);
    const first = await registerAllocationWorkspace(h, allocationWorkspace("stable-first"));
    const second = await registerAllocationWorkspace(h, allocationWorkspace("stable-second"));
    await h.allocation.rebalance();
    const opened = h.opens.length;

    await h.index.upsertWorkspace(second.canonical_path, "glosa-open");
    await h.allocation.rebalance();

    expect(h.registry.liveUpdatesFor(first)).toEqual({ state: "live" });
    expect(h.registry.liveUpdatesFor(second)).toEqual({ state: "live" });
    expect(h.opens).toHaveLength(opened);
    expect(h.closes).toHaveLength(0);
    await h.allocation.stop();
    await h.registry.closeAll();
  });
});

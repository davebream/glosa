// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactWatcherAllocation } from "../src/artifact-watcher-allocation.ts";
import { ArtifactWatcherRegistry, type WorkspaceWatchFactory } from "../src/artifact-watcher.ts";
import { SessionRegistry } from "../src/registry/session-registry.ts";
import { WorkspaceIndex, type WorkspaceEntry } from "../src/registry/workspace-index.ts";

const cleanup: string[] = [];

function temp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(path);
  return path;
}

function workspace(name: string): string {
  const root = join(temp("glosa-allocation-workspaces-"), name);
  mkdirSync(root);
  writeFileSync(join(root, "notes.md"), `${name}\n`);
  return root;
}

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

interface Harness {
  index: WorkspaceIndex;
  sessions: SessionRegistry;
  registry: ArtifactWatcherRegistry;
  allocation: ArtifactWatcherAllocation;
  opens: string[];
  closes: string[];
}

function harness(limit: number, leaseTtlMs = 60_000, realTime = false): Harness {
  let nowMs = Date.parse("2026-09-21T00:00:00.000Z");
  const now = () => (realTime ? new Date() : new Date(nowMs++));
  const home = temp("glosa-allocation-home-");
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

async function register(h: Harness, path: string): Promise<WorkspaceEntry> {
  return h.index.upsertWorkspace(path, "glosa-open");
}

describe("artifact watcher allocation (#219)", () => {
  test("startup selection is newest-first, independent of index insertion order", async () => {
    const h = harness(2);
    const oldest = await register(h, workspace("oldest"));
    const middle = await register(h, workspace("middle"));
    const newest = await register(h, workspace("newest"));

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
    const home = temp("glosa-allocation-tie-home-");
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
      await index.upsertWorkspace(workspace("tie-c"), "glosa-open"),
      await index.upsertWorkspace(workspace("tie-a"), "glosa-open"),
      await index.upsertWorkspace(workspace("tie-b"), "glosa-open"),
    ];

    await allocation.rebalance();

    const expected = [...entries].sort((a, b) => a.registration_id.localeCompare(b.registration_id)).slice(0, 2);
    expect(
      entries
        .filter((entry) => registry.liveUpdatesFor(entry)?.state === "live")
        .map((e) => e.registration_id)
        .sort(),
    ).toEqual(expected.map((entry) => entry.registration_id).sort());
    await allocation.stop();
    await registry.closeAll();
  });

  test("a live session outranks a newer workspace, then lease expiry restores recency", async () => {
    const h = harness(1, 40, true);
    const live = await register(h, workspace("live-old"));
    await h.sessions.register({
      session_id: "session-live",
      provider: "claude-code",
      cwd: live.canonical_path,
      workspace_binding: live.canonical_path,
      source: "monitor",
    });
    await Bun.sleep(5);
    const recent = await register(h, workspace("newer-no-session"));

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
    const h = harness(2);
    const oldest = await register(h, workspace("preempt-oldest"));
    const middle = await register(h, workspace("preempt-middle"));
    const newest = await register(h, workspace("preempt-newest"));
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
    const h = harness(2);
    const first = await register(h, workspace("stable-first"));
    const second = await register(h, workspace("stable-second"));
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

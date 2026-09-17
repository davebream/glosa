// SPDX-License-Identifier: Apache-2.0
// Regression coverage for #91: the daemon must never hand chokidar a recursively watched
// workspace root. Scope comes from the canonical matcher, one watcher is shared per registration,
// and excessive/erroring scopes fail soft instead of destabilizing the singleton daemon.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { watch, type ChokidarOptions, type FSWatcher } from "chokidar";
import { ArtifactWatcherRegistry, type ArtifactWatcherEvent } from "../src/artifact-watcher.ts";
import type { WorkspaceLocation } from "../src/workspace.ts";
import { cleanupWorkspace, freshWorkspace, makeDir, makeSymlink, writeFile } from "./matcher/helpers.ts";

// 15 s, not Bun's 5 s default: these waits sit on real chokidar events, which a loaded macos-14
// runner can take seconds to deliver. The budget is the wait, not the work.
async function waitUntil(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(20);
  if (!predicate()) throw new Error("timed out waiting for artifact watcher state");
}

/** Save `content` to `path`, then keep re-saving it every 250 ms until `observed()` is true.
 *
 * Why the loop: a single write issued right after chokidar's `ready` is not reliably observed on
 * macOS. `ready` fires when the initial scan is done, but the kernel-side FSEvents stream libuv
 * opens for a directory watch comes up asynchronously after that and does not replay events from
 * before it was live, so the very first save can fall into the gap. It did exactly that in CI:
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

class FakeWatcher extends EventEmitter {
  added: string[][] = [];
  unwatched: string[][] = [];
  closeCalls = 0;

  add(paths: string | readonly string[]): this {
    this.added.push(typeof paths === "string" ? [paths] : [...paths]);
    return this;
  }

  async unwatch(paths: string | readonly string[]): Promise<this> {
    this.unwatched.push(typeof paths === "string" ? [paths] : [...paths]);
    return this;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
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

  test("real chokidar receives only canonical safe directories at depth zero", async () => {
    writeFile(root, "docs/note.md", "one");
    writeFile(root, "node_modules/pkg/readme.md", "excluded");
    writeFile(root, ".git/objects/noise.md", "excluded");
    writeFile(root, ".glosa/private.md", "excluded");
    writeFile(root, ".someagent/worktrees/w1/noise.md", "excluded");
    writeFile(root, "src/code.ts", "unrelated");
    const outside = freshWorkspace();
    writeFile(outside, "outside.md", "outside");
    makeSymlink(outside, join(root, "linked"));

    const calls: Array<{ paths: string[]; options: ChokidarOptions; watcher: FSWatcher }> = [];
    const events: ArtifactWatcherEvent[] = [];
    const registry = new ArtifactWatcherRegistry({
      watchFactory: (paths, options) => {
        const watcher = watch(paths, options);
        calls.push({ paths, options, watcher });
        return watcher;
      },
    });
    registries.push(registry);
    const stop = registry.subscribe(root, (event) => events.push(event));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.options.depth).toBe(0);
    expect(calls[0]!.options.followSymlinks).toBe(false);
    expect(calls[0]!.paths.sort()).toEqual([root, join(root, "docs"), join(root, "src")].sort());
    await new Promise<void>((resolve) => calls[0]!.watcher.once("ready", () => resolve()));

    const watched = calls[0]!.watcher.getWatched();
    const flattened = Object.entries(watched).flatMap(([directory, names]) =>
      names.map((name) => join(directory, name)),
    );
    expect(flattened.some((path) => path.includes("node_modules"))).toBe(false);
    expect(flattened.some((path) => path.includes(".someagent"))).toBe(false);
    expect(flattened.some((path) => path.includes(`${join(root, ".git")}`))).toBe(false);
    expect(flattened.some((path) => path.includes(`${join(root, ".glosa")}`))).toBe(false);
    expect(flattened.some((path) => path.includes(`${join(root, "linked")}`))).toBe(false);
    expect(flattened.some((path) => path.endsWith("code.ts"))).toBe(false);
    expect(Object.keys(watched).some((path) => path.startsWith(outside))).toBe(false);

    for (let i = 0; i < 100; i++) {
      writeFileSync(join(root, "node_modules", "pkg", "readme.md"), `excluded-${i}`);
      writeFileSync(join(root, ".someagent", "worktrees", "w1", "noise.md"), `excluded-${i}`);
    }
    await Bun.sleep(150);
    expect(events).toEqual([]);

    stop();
    cleanupWorkspace(outside);
  }, 20_000);

  test("abandonAll retires every state without closing its watch, and stops delivering events", async () => {
    writeFile(root, "docs/note.md", "one");
    const second = freshWorkspace();
    writeFile(second, "note.md", "one");
    const fakes: FakeWatcher[] = [];
    const events: ArtifactWatcherEvent[] = [];
    const registry = new ArtifactWatcherRegistry({
      watchFactory: () => {
        const fake = new FakeWatcher();
        fakes.push(fake);
        return fake as unknown as FSWatcher;
      },
    });
    registries.push(registry);
    registry.subscribe(root, (event) => events.push(event));
    registry.ensureWatched(second);
    expect(fakes).toHaveLength(2);

    registry.abandonAll();

    expect(fakes.map((fake) => fake.closeCalls)).toEqual([0, 0]);
    expect(registry.watchedWorkspaceCount()).toBe(0);
    expect(registry.modeFor(root)).toBeNull();
    fakes[0]!.emit("change", join(root, "docs", "note.md"));
    await Bun.sleep(150);
    expect(events).toEqual([]);
    cleanupWorkspace(second);
  });

  test("tracked changes, atomic replacement, new nested artifacts, deletion, and oversize crossings reconcile", async () => {
    const note = writeFile(root, "docs/note.md", "one");
    const events: ArtifactWatcherEvent[] = [];
    let watcher: FSWatcher | null = null;
    const registry = new ArtifactWatcherRegistry({
      watchFactory: (paths, options) => {
        watcher = watch(paths, options);
        return watcher;
      },
    });
    registries.push(registry);
    registry.subscribe(root, (event) => events.push(event));
    await new Promise<void>((resolve) => watcher!.once("ready", () => resolve()));

    writeFileSync(note, "two");
    await waitUntil(() => events.some((event) => event.type === "artifact" && event.data.path === "docs/note.md"));

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
    const watchedAfterOversize = Object.entries(watcher!.getWatched()).flatMap(([directory, names]) =>
      names.map((name) => join(directory, name)),
    );
    expect(watchedAfterOversize).not.toContain(join(root, "new", "deep", "fresh.md"));
  }, 15_000);

  test("custom matcher config drives both discovery and direct-entry filtering", async () => {
    makeDir(root, ".glosa");
    writeFileSync(join(root, ".glosa", "config.json"), JSON.stringify({ artifacts: { include: ["**/*.custom"] } }));
    const custom = writeFile(root, "docs/note.custom", "one");
    const events: ArtifactWatcherEvent[] = [];
    let watcher: FSWatcher | null = null;
    const registry = new ArtifactWatcherRegistry({
      watchFactory: (paths, options) => {
        watcher = watch(paths, options);
        return watcher;
      },
    });
    registries.push(registry);
    registry.subscribe(root, (event) => events.push(event));
    await new Promise<void>((resolve) => watcher!.once("ready", () => resolve()));

    await saveUntil(custom, "two", () =>
      events.some((event) => event.type === "artifact" && event.data.path === "docs/note.custom"),
    );
  }, 20_000);

  test("a temporarily absent bounded loose file is watched by exact path and reappears live", async () => {
    const path = writeFile(root, "loose.md", "one");
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
    const calls: string[][] = [];
    const registry = new ArtifactWatcherRegistry({
      watchFactory: (paths, options) => {
        calls.push(paths);
        return watch(paths, options);
      },
    });
    registries.push(registry);
    registry.subscribe(workspace, (event) => events.push(event));
    expect(calls).toEqual([[path]]);

    await Bun.sleep(1_200);
    writeFileSync(path, "back");
    await waitUntil(() =>
      events.some(
        (event) =>
          event.type === "artifact_index" &&
          event.data.changes.some((change) => change.type === "file_tracked" && change.path === "loose.md"),
      ),
    );
  }, 20_000);

  test("two subscribers share one watcher and the final unsubscribe closes it", async () => {
    writeFile(root, "note.md", "one");
    const fake = new FakeWatcher();
    let factoryCalls = 0;
    const registry = new ArtifactWatcherRegistry({
      watchFactory: () => {
        factoryCalls += 1;
        return fake as unknown as FSWatcher;
      },
    });
    registries.push(registry);

    const stopA = registry.subscribe(root, () => {});
    const stopB = registry.subscribe(root, () => {});
    expect(factoryCalls).toBe(1);

    stopA();
    await Bun.sleep(0);
    expect(fake.closeCalls).toBe(0);
    stopB();
    await waitUntil(() => fake.closeCalls === 1);
    expect(registry.modeFor(root)).toBeNull();
  });

  test("the budget falls back to exact files, then disables with one warning when files alone exceed it", () => {
    writeFile(root, "docs/note.md", "one");
    const fallbackCalls: string[][] = [];
    const fallbackWarnings: string[] = [];
    const fallback = new ArtifactWatcherRegistry({
      maxWatchEntries: 2,
      warn: (message) => fallbackWarnings.push(message),
      watchFactory: (paths) => {
        fallbackCalls.push(paths);
        return new FakeWatcher() as unknown as FSWatcher;
      },
    });
    registries.push(fallback);
    fallback.subscribe(root, () => {});
    expect(fallback.modeFor(root)).toBe("files");
    expect(fallbackCalls).toEqual([[join(root, "docs", "note.md")]]);
    expect(fallbackWarnings).toHaveLength(1);

    const crowded = makeDir(root, "crowded");
    writeFileSync(join(crowded, "a.md"), "a");
    writeFileSync(join(crowded, "b.md"), "b");
    writeFileSync(join(crowded, "c.md"), "c");
    const disabledWarnings: string[] = [];
    let disabledFactoryCalls = 0;
    const disabled = new ArtifactWatcherRegistry({
      maxWatchEntries: 2,
      warn: (message) => disabledWarnings.push(message),
      watchFactory: () => {
        disabledFactoryCalls += 1;
        return new FakeWatcher() as unknown as FSWatcher;
      },
    });
    registries.push(disabled);
    disabled.subscribe(root, () => {});
    expect(disabled.modeFor(root)).toBe("disabled");
    expect(disabledFactoryCalls).toBe(0);
    expect(disabledWarnings).toHaveLength(1);
  });

  test("the first watcher error closes the broad watcher and downgrades exactly once", async () => {
    writeFile(root, "docs/note.md", "one");
    const watchers = [new FakeWatcher(), new FakeWatcher()];
    const calls: string[][] = [];
    const warnings: string[] = [];
    const registry = new ArtifactWatcherRegistry({
      warn: (message) => warnings.push(message),
      watchFactory: (paths) => {
        calls.push(paths);
        return watchers[calls.length - 1]! as unknown as FSWatcher;
      },
    });
    registries.push(registry);
    registry.subscribe(root, () => {});
    expect(registry.modeFor(root)).toBe("directories");

    watchers[0]!.emit("error", new Error("boom"));
    await waitUntil(() => registry.modeFor(root) === "files");
    expect(watchers[0]!.closeCalls).toBe(1);
    expect(calls[1]).toEqual([join(root, "docs", "note.md")]);
    expect(warnings).toHaveLength(1);

    watchers[1]!.emit("error", new Error("fallback failed"));
    await waitUntil(() => registry.modeFor(root) === "disabled");
    expect(watchers[1]!.closeCalls).toBe(1);
    expect(calls).toHaveLength(2);
    expect(warnings).toHaveLength(1);
  }, 20_000);
});

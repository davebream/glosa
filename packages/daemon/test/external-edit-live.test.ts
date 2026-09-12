// SPDX-License-Identifier: Apache-2.0
// Daemon-lifetime artifact watching and the quiet-window coalescer (#153, contract A4/A6/A10).
//
// The amendment under test: watching used to last exactly as long as a `GET /w/:slug/stream`
// subscription, so the producer for `external_edit` would only ever fire while a browser tab was
// open — and #153's headline workflow is an external editor plus an agent with NO glosa tab. Every
// test here therefore opens no stream and registers no listener.
import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ArtifactWatcherRegistry, DEFAULT_MAX_WATCHED_WORKSPACES } from "../src/artifact-watcher.ts";
import { WorkspaceBus } from "../src/bus/bus.ts";
import { EXTERNAL_EDIT_KIND } from "../src/bus/external-edit.ts";
import { readInboxEntry } from "../src/bus/inbox.ts";
import type { WorkspaceTarget } from "../src/workspace.ts";
import {
  claimTestDaemonIdentity,
  cleanupWorkspace,
  deterministicClock,
  deterministicUlid,
  dropDaemonIdentity,
  freshWorkspace,
  writeFile,
} from "./git/helpers.ts";

const roots: string[] = [];
const registries: ArtifactWatcherRegistry[] = [];
const buses: WorkspaceBus[] = [];
let epoch = 1_800_000_000_000;

function workspace(): string {
  const root = freshWorkspace();
  roots.push(root);
  return root;
}

function openBus(root: string): WorkspaceBus {
  epoch += 1_000_000;
  const bus = new WorkspaceBus(root, { ulid: deterministicUlid(epoch), now: deterministicClock(epoch) });
  buses.push(bus);
  return bus;
}

function track(registry: ArtifactWatcherRegistry): ArtifactWatcherRegistry {
  registries.push(registry);
  return registry;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(20);
  if (!predicate()) throw new Error("timed out waiting for the artifact watcher");
}

function externalEditEntries(bus: WorkspaceBus): Array<Record<string, unknown>> {
  return Object.keys(bus.state.entries)
    .map((id) => readInboxEntry(bus.workspace, id) as Record<string, unknown> | null)
    .filter((payload): payload is Record<string, unknown> => payload?.kind === EXTERNAL_EDIT_KIND);
}

afterEach(async () => {
  await Promise.all(registries.splice(0).map((registry) => registry.closeAll()));
  await Promise.all(buses.splice(0).map((bus) => bus.close().catch(() => {})));
  dropDaemonIdentity();
  for (const root of roots.splice(0)) cleanupWorkspace(root);
});

describe("A4 — a live external save produces one coalesced entry, with no browser attached", () => {
  test("three saves inside one real 2-second window, no SSE listener, produce exactly one external_edit with correct hunks", async () => {
    const root = workspace();
    claimTestDaemonIdentity(root);
    writeFile(root, "notes.md", "line one\n");
    const bus = openBus(root);
    await bus.reconcile(); // the baseline a daemon start establishes

    // Deliberately the REAL default quiet window, not a shortened test value: the claim is that
    // two seconds absorbs an editor's save burst, and a 50 ms window would prove nothing about it.
    const registry = track(
      new ArtifactWatcherRegistry({
        captureExternalEdit: (target) => openBusFor(target, bus).captureExternalEdit(),
      }),
    );
    // No `subscribe`, no listener, no stream — this is the whole amendment.
    registry.ensureWatched(root);
    expect(registry.watchedWorkspaceCount()).toBe(1);

    writeFileSync(join(root, "notes.md"), "line one\nline two\n");
    await Bun.sleep(300);
    writeFileSync(join(root, "notes.md"), "line one\nline two\nline three\n");
    await Bun.sleep(300);
    writeFileSync(join(root, "notes.md"), "line one\nline two\nline three\nline four\n");

    await waitUntil(() => externalEditEntries(bus).length > 0);
    // Past the window again, so a second entry would have had time to appear if the burst had
    // not coalesced — otherwise "exactly one" is just "the second one has not arrived yet".
    await Bun.sleep(2_500);

    const entries = externalEditEntries(bus);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.path).toBe("notes.md");
    expect(entries[0]!.source).toBe("live");
    // One entry for the whole burst, and its hunks span all three saves rather than just the
    // first: the diff is taken against the checkpoint the burst started from.
    expect(String(entries[0]!.diff)).toContain("+line two");
    expect(String(entries[0]!.diff)).toContain("+line three");
    expect(String(entries[0]!.diff)).toContain("+line four");
  }, 30_000);

  test("a watcher started for a registered workspace outlives the last SSE subscriber", async () => {
    const root = workspace();
    writeFile(root, "notes.md", "one\n");
    const registry = track(new ArtifactWatcherRegistry({ quietWindowMs: 20 }));
    registry.ensureWatched(root);

    const stop = registry.subscribe(root, () => {});
    expect(registry.watchedWorkspaceCount()).toBe(1);
    stop();
    await Bun.sleep(20);

    // Pre-#153 this was exactly when `closeState` fired. A daemon-lifetime watcher must survive it.
    expect(registry.watchedWorkspaceCount()).toBe(1);
    expect(registry.modeFor(root)).not.toBeNull();
  });

  test("a subscription-created watcher is still torn down by its last unsubscribe (unchanged)", async () => {
    const root = workspace();
    writeFile(root, "notes.md", "one\n");
    const registry = track(new ArtifactWatcherRegistry({ quietWindowMs: 20 }));

    const stop = registry.subscribe(root, () => {});
    expect(registry.watchedWorkspaceCount()).toBe(1);
    stop();

    await waitUntil(() => registry.watchedWorkspaceCount() === 0, 2_000);
    expect(registry.modeFor(root)).toBeNull();
  });
});

describe("A6 — the cross-workspace watcher count is bounded, and that is a different claim from the per-workspace entry cap", () => {
  test("past the named bound no further watcher is created, with one warning, and no browser can reach around it", () => {
    const warnings: string[] = [];
    // Two separate budgets, set far apart on purpose: every workspace here sits comfortably under
    // the PER-WORKSPACE path cap, so anything that fails below is the CROSS-WORKSPACE bound doing
    // its job, not the old cap under a new name.
    const registry = track(
      new ArtifactWatcherRegistry({
        maxWatchEntries: 4_096,
        maxWatchedWorkspaces: 2,
        warn: (message) => warnings.push(message),
      }),
    );

    const admitted: string[] = [];
    const refused: string[] = [];
    // Every workspace is evaluated, then asserted over as a whole: an `expect` inside the loop
    // would stop at the first mismatch and leave the rest asserted by reading the source.
    for (let i = 0; i < 5; i++) {
      const root = workspace();
      writeFile(root, "notes.md", `note ${i}\n`);
      registry.ensureWatched(root);
      (registry.modeFor(root) === null ? refused : admitted).push(root);
    }

    expect(admitted).toHaveLength(2);
    expect(refused).toHaveLength(3);
    expect(registry.watchedWorkspaceCount()).toBe(2);
    expect(admitted.map((root) => registry.modeFor(root))).toEqual(["directories", "directories"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("2-workspace safety budget");

    // An SSE subscriber must not be able to open a watcher the bound refused — a ceiling any
    // caller could step around would not be a ceiling.
    const stop = registry.subscribe(refused[0]!, () => {});
    expect(registry.watchedWorkspaceCount()).toBe(2);
    expect(registry.modeFor(refused[0]!)).toBeNull();
    stop();
  });

  test("the per-workspace entry cap still bounds paths within one workspace, independently", () => {
    const warnings: string[] = [];
    const registry = track(
      new ArtifactWatcherRegistry({
        maxWatchEntries: 2,
        maxWatchedWorkspaces: 64,
        warn: (message) => warnings.push(message),
      }),
    );
    const root = workspace();
    writeFile(root, "docs/note.md", "one");
    registry.ensureWatched(root);

    // Downgraded to `files` by the PER-WORKSPACE budget while the cross-workspace count is 1 — the
    // two bounds are not the same claim and neither stands in for the other.
    expect(registry.modeFor(root)).toBe("files");
    expect(registry.watchedWorkspaceCount()).toBe(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("entry safety budget");
  });

  test("the shipped default is a stated constant, not an accident of the per-workspace cap", () => {
    expect(DEFAULT_MAX_WATCHED_WORKSPACES).toBe(64);
  });
});

describe("A10 — the new cross-layer write reuses the existing safety primitive", () => {
  test("eviction during an open quiet window cancels the timer: no capture fires afterwards", async () => {
    const root = workspace();
    writeFile(root, "notes.md", "one\n");
    const captures: string[] = [];
    const registry = track(
      new ArtifactWatcherRegistry({
        quietWindowMs: 400,
        captureExternalEdit: async (target) => {
          captures.push(typeof target === "string" ? target : target.canonical_path);
        },
      }),
    );
    registry.ensureWatched(root);

    writeFileSync(join(root, "notes.md"), "one\ntwo\n");
    // Wait long enough for the change to be observed and the window to be OPEN, but not to fire.
    await Bun.sleep(150);
    // This is the call `onHardRemove` and `sealAdoptionSources` already make (lifecycle/daemon.ts).
    await registry.evict(root);

    await Bun.sleep(800); // well past when the window would have fired
    expect(captures).toEqual([]);
    expect(registry.watchedWorkspaceCount()).toBe(0);
  });

  test("a bus sealed for forget refuses the capture through assertWritable, writing nothing", async () => {
    const root = workspace();
    claimTestDaemonIdentity(root);
    writeFile(root, "notes.md", "one\n");
    const bus = openBus(root);
    await bus.reconcile();

    // The window is conceptually open: the file has already changed on disk.
    writeFileSync(join(root, "notes.md"), "one\ntwo\n");
    await bus.sealForForget();

    // Same refusal every other writer meets — not a check invented for this producer.
    await expect(bus.captureExternalEdit()).rejects.toThrow(/permanently deleted/);
    expect(externalEditEntries(bus)).toEqual([]);
  });

  test("a watcher whose capture throws warns once and keeps watching, rather than destabilizing the daemon", async () => {
    const root = workspace();
    writeFile(root, "notes.md", "one\n");
    const warnings: string[] = [];
    let calls = 0;
    const registry = track(
      new ArtifactWatcherRegistry({
        quietWindowMs: 50,
        warn: (message) => warnings.push(message),
        captureExternalEdit: async () => {
          calls += 1;
          throw new Error("workspace is being permanently deleted (glosa forget)");
        },
      }),
    );
    registry.ensureWatched(root);

    writeFileSync(join(root, "notes.md"), "one\ntwo\n");
    await waitUntil(() => calls > 0, 5_000);
    writeFileSync(join(root, "notes.md"), "one\ntwo\nthree\n");
    await waitUntil(() => calls > 1, 5_000);

    expect(registry.watchedWorkspaceCount()).toBe(1);
    expect(warnings.filter((message) => message.includes("external-edit capture failed"))).toHaveLength(1);
    // Explicit budget: this waits on two real chokidar events plus two quiet windows, and Bun's
    // default 5s is tight enough that it flakes under full-suite load even though the work is fast.
  }, 20_000);
});

/** The composition root hands the watcher a bus resolved per workspace; these tests hold exactly
 * one, so this just proves the target the watcher passed is the one under test rather than
 * silently capturing a different workspace's drift. */
function openBusFor(target: WorkspaceTarget, bus: WorkspaceBus): WorkspaceBus {
  const canonical = typeof target === "string" ? target : target.canonical_path;
  if (canonical !== bus.workspace) throw new Error(`watcher passed an unexpected workspace: ${canonical}`);
  return bus;
}

describe("the bound that protects the machine is watch ENTRIES summed across workspaces, not workspaces", () => {
  // Why this exists. The A6 test above pins the workspace COUNT, and passed throughout — while
  // alpha.19 exhausted memory on a real machine and took it down three times. Its two ceilings
  // (4096 entries per workspace, 64 workspaces) were each enforced and never multiplied: their
  // product is 262,144 filesystem watches. The A6 fixture set the two budgets "far apart on
  // purpose" and gave every workspace one file, which is exactly the shape in which the product
  // cannot be observed. So this measures the axis that actually ran out.
  test("many workspaces, each individually well under the per-workspace cap, cannot exceed the total", () => {
    const warnings: string[] = [];
    const registry = track(
      new ArtifactWatcherRegistry({
        // Deliberately NOT limiting: a failure below cannot be either of these two doing the work.
        maxWatchEntries: 4_096,
        maxWatchedWorkspaces: 64,
        maxTotalWatchEntries: 12,
        warn: (message) => warnings.push(message),
      }),
    );

    // Eight workspaces of five directories each: 40 entries wanted, every workspace a rounding
    // error against its own 4096 cap, and 64 workspaces is never reached. Only the total binds.
    const opened: { root: string; mode: string | null }[] = [];
    for (let i = 0; i < 8; i++) {
      const root = workspace();
      for (let d = 0; d < 5; d++) writeFile(root, join(`dir-${d}`, "notes.md"), `note ${i}/${d}\n`);
      registry.ensureWatched(root);
      opened.push({ root, mode: registry.modeFor(root) });
    }

    // Evaluated in full before anything is asserted: an expect() inside the loop stops at the
    // first mismatch, and then every later workspace is asserted by reading the source instead of
    // by observation. That defect shipped in this repository's own pipeline once already.
    expect(registry.watchedEntryTotal()).toBeLessThanOrEqual(12);
    expect(registry.watchedWorkspaceCount()).toBeLessThanOrEqual(64);
    // The point of the whole test: workspaces were admitted, and the total still held.
    expect(opened.some((entry) => entry.mode !== null && entry.mode !== "disabled")).toBe(true);
    // And the old pair of ceilings alone would have permitted every one of the 40.
    expect(40).toBeGreaterThan(12);
  });

  test("a single workspace under the total is still watched in full — the bound refuses sums, not workspaces", () => {
    const registry = track(
      new ArtifactWatcherRegistry({ maxWatchEntries: 4_096, maxWatchedWorkspaces: 64, maxTotalWatchEntries: 12 }),
    );
    const root = workspace();
    for (let d = 0; d < 4; d++) writeFile(root, join(`dir-${d}`, "notes.md"), `note ${d}\n`);
    registry.ensureWatched(root);

    expect(registry.modeFor(root)).not.toBeNull();
    expect(registry.modeFor(root)).not.toBe("disabled");
    expect(registry.watchedEntryTotal()).toBeLessThanOrEqual(12);
    expect(registry.watchedEntryTotal()).toBeGreaterThan(0);
  });
});

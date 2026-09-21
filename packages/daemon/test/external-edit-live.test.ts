// SPDX-License-Identifier: Apache-2.0
// Daemon-lifetime artifact watching and the quiet-window coalescer (#153, contract A4/A6/A10).
//
// The amendment under test: watching used to last exactly as long as a `GET /w/:slug/stream`
// subscription, so the producer for `external_edit` would only ever fire while a browser tab was
// open — and #153's headline workflow is an external editor plus an agent with NO glosa tab. Every
// test here therefore opens no stream and registers no listener.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ArtifactWatcherRegistry, DEFAULT_MAX_WATCHED_WORKSPACES } from "../src/artifact-watcher.ts";
import { WorkspaceBus } from "../src/bus/bus.ts";
import { EXTERNAL_EDIT_KIND } from "../src/bus/external-edit.ts";
import { readInboxEntry } from "../src/bus/inbox.ts";
import { shadowGitDir } from "../src/bus/paths.ts";
import { buildDeliveryPresentation } from "../src/delivery/presentation.ts";
import { headSha } from "../src/git/shadow.ts";
import { waitForWatch } from "../src/services/watch.ts";
import {
  registrationIdFor,
  type WorkspaceLocation,
  type WorkspaceTarget,
  workspaceRegistrationId,
} from "../src/workspace.ts";
import {
  claimTestDaemonIdentity,
  cleanupWorkspace,
  deterministicClock,
  deterministicUlid,
  dropDaemonIdentity,
  freshWorkspace,
  writeFile,
} from "./git/helpers.ts";
import { armedWatchFactory } from "./watch-helpers.ts";

const roots: string[] = [];
const registries: ArtifactWatcherRegistry[] = [];
const buses: WorkspaceBus[] = [];
let epoch = 1_800_000_000_000;

function workspace(): string {
  const root = freshWorkspace();
  roots.push(root);
  return root;
}

function openBus(root: WorkspaceTarget): WorkspaceBus {
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

/** Save, then keep re-saving identical bytes every 250 ms until `observed()` is true. A single
 * write issued right after a watch starts can be lost on macOS: the FSEvents stream behind it
 * comes up asynchronously and does not replay earlier events. The
 * "warns once and keeps watching" test below saw exactly that in CI, waiting the full 15 s for a
 * first save that had already happened. A real editor saves many times, so the product sees the
 * next one; this loop gives a single-save test the same property. See the twin helper in
 * artifact-watcher.test.ts. */
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
  test("a live watcher captures a racing final save after explicit lost-history repair (#226)", async () => {
    const root = workspace();
    claimTestDaemonIdentity(root);
    writeFile(root, "notes.md", "Initial.\n");
    const bus = openBus(root);
    await bus.reconcile();
    const head = await headSha(root);
    unlinkSync(join(shadowGitDir(root), "objects", head.slice(0, 2), head.slice(2)));
    const { watchFactory, armed } = armedWatchFactory();
    const registry = track(
      new ArtifactWatcherRegistry({
        watchFactory,
        quietWindowMs: 40,
        captureExternalEdit: () => bus.captureExternalEdit(),
      }),
    );
    registry.ensureWatched(root);
    await armed();
    await bus.repairBaseline(
      () => {},
      (step) => {
        if (step === "index-staged") writeFile(root, "notes.md", "Racing final bytes.\n");
      },
    );
    await waitUntil(() => externalEditEntries(bus).length > 0);
    expect(externalEditEntries(bus)).toHaveLength(1);
    expect(externalEditEntries(bus)[0]).toMatchObject({ kind: "external_edit", source: "live", path: "notes.md" });
    expect(String(externalEditEntries(bus)[0]?.diff)).toContain("+Racing final bytes.");
  });

  test("three saves inside one real 2-second window, no SSE listener, produce exactly one external_edit with correct hunks", async () => {
    const root = workspace();
    claimTestDaemonIdentity(root);
    writeFile(root, "notes.md", "line one\n");
    const bus = openBus(root);
    await bus.reconcile(); // the baseline a daemon start establishes

    // Deliberately the REAL default quiet window, not a shortened test value: the claim is that
    // two seconds absorbs an editor's save burst, and a 50 ms window would prove nothing about it.
    const { watchFactory, armed } = armedWatchFactory();
    const registry = track(
      new ArtifactWatcherRegistry({
        watchFactory,
        captureExternalEdit: (target) => openBusFor(target, bus).captureExternalEdit(),
      }),
    );
    // No `subscribe`, no listener, no stream — this is the whole amendment.
    registry.ensureWatched(root);
    expect(registry.watchedWorkspaceCount()).toBe(1);
    await armed();

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

describe("A4b — a save that replaces the file, as Typora's does, is still one coalesced entry, and watching survives it", () => {
  // A4 writes in place. Typora is an NSDocument app: it saves with
  // `-[NSFileManager replaceItemAtURL:withItemAtURL:...]`, which writes the new bytes to a temporary
  // file OUTSIDE the document's directory and swaps it in, so after every save the path names a new
  // inode. A loose-file workspace — a manuscript opened from a folder that is not a git repository —
  // is watched for its exact files (`chooseMode` returns "files" for bounded tracking). A watch on
  // the FILE would follow the inode, not the path, and see only the first replacement; the watch is
  // therefore on the file's DIRECTORY, filtered to the file's path, which sees every swap. If it
  // stopped following replacements, the quiet window would still yield one entry carrying the whole
  // burst — the capture reads the disk when the window closes — but every save after that would
  // produce no entry at all, while A4 and the rest of this file stay green. The closing save below
  // is what pins it.
  //
  // The temp file is written beside the workspace rather than inside it, which is where NSDocument
  // puts it and keeps a stray `.tmp` out of the directory watch's own events.
  function replacingSave(scratch: string, path: string, content: string): void {
    const temp = join(scratch, "save-in-progress", "draft.md");
    mkdirSync(join(scratch, "save-in-progress"), { recursive: true });
    writeFileSync(temp, content);
    renameSync(temp, path);
  }

  // Only the loose-file shape is pinned. A DIRECTORY workspace is one recursive watch on its root,
  // which does not follow inodes at all and reports the swap as a change to the path, so a case
  // there could not fail for any reason A4 cannot; it is left out rather than kept as decoration.
  test("a loose-file workspace: three replacing saves make one external_edit, and a later replacing save is still captured", async () => {
    const scratch = realpathSync(workspace());
    const manuscript = join(scratch, "manuscript");
    mkdirSync(manuscript);
    const draft = join(manuscript, "draft.md");
    writeFileSync(draft, "line one\n");
    // The daemon lock lives outside the watched folder, and the bus is redirected out of it the way
    // the index redirects a loose file's bus to `~/.glosa/state/<id>`.
    claimTestDaemonIdentity(join(scratch, "daemon"));
    mkdirSync(join(scratch, "state"));
    const target: WorkspaceLocation = {
      registration_id: registrationIdFor("loose-file", draft),
      kind: "loose-file",
      canonical_path: draft,
      worktree_path: manuscript,
      bus_path: join(scratch, "state", "loose"),
      tracking: { mode: "bounded", paths: ["draft.md"] },
    };
    const bus = openBus(target);
    await bus.reconcile();

    const { watchFactory, armed } = armedWatchFactory();
    const registry = track(
      new ArtifactWatcherRegistry({
        watchFactory,
        captureExternalEdit: (captured) => {
          if (workspaceRegistrationId(captured) !== target.registration_id) {
            throw new Error("watcher passed an unexpected workspace");
          }
          return bus.captureExternalEdit();
        },
      }),
    );
    registry.ensureWatched(target);
    // Watching file by file is the whole reason this case exists, so it is asserted, not assumed.
    expect(registry.modeFor(target)).toBe("files");
    await armed();

    replacingSave(scratch, draft, "line one\nline two\n");
    await Bun.sleep(300);
    replacingSave(scratch, draft, "line one\nline two\nline three\n");
    await Bun.sleep(300);
    replacingSave(scratch, draft, "line one\nline two\nline three\nline four\n");

    await waitUntil(() => externalEditEntries(bus).length > 0);
    await Bun.sleep(2_500); // past the window, so an uncoalesced second entry would be here by now
    const burst = externalEditEntries(bus);
    expect(burst).toHaveLength(1);
    expect(burst[0]!.source).toBe("live");
    // The burst's bytes, all of them. This does NOT show the watch survived a replacement: the capture
    // reads the disk when the window closes, so it carries the third save even if only the first was
    // observed.
    expect(String(burst[0]!.diff)).toContain("+line four");

    // This is the assertion that goes red when the watch stops following a replaced file: a
    // save made after the burst's window has closed can only become an entry if the watch saw it.
    replacingSave(scratch, draft, "line one\nline two\nline three\nline four\nline five\n");
    await waitUntil(() => externalEditEntries(bus).length === 2);
    expect(String(externalEditEntries(bus)[1]!.diff)).toContain("+line five");

    const kinds = Object.keys(bus.state.entries).map(
      (id) => (readInboxEntry(bus.workspace, id) as { kind?: string } | null)?.kind,
    );
    expect(kinds).not.toContain("human_edit");
  }, 30_000);
});

describe("A6 — the cross-workspace watcher count is bounded, and that is a different claim from the per-workspace entry cap", () => {
  test("past the named bound no further watcher is created, with one warning, and no browser can reach around it", () => {
    const warnings: string[] = [];
    // Two separate budgets, set far apart on purpose: every workspace here sits comfortably under
    // the PER-WORKSPACE path cap, so anything that fails below is the CROSS-WORKSPACE bound doing
    // its job, not the old cap under a new name.
    const registry = track(
      new ArtifactWatcherRegistry({
        maxTrackedArtifacts: 4_096,
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
    expect(admitted.map((root) => registry.modeFor(root))).toEqual(["tree", "tree"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("2-workspace safety budget");

    // An SSE subscriber must not be able to open a watcher the bound refused — a ceiling any
    // caller could step around would not be a ceiling.
    const stop = registry.subscribe(refused[0]!, () => {});
    expect(registry.watchedWorkspaceCount()).toBe(2);
    expect(registry.modeFor(refused[0]!)).toBeNull();
    stop();
  });

  test("the per-workspace tracked-artifact cap still bounds one workspace, independently", () => {
    const warnings: string[] = [];
    const registry = track(
      new ArtifactWatcherRegistry({
        maxTrackedArtifacts: 2,
        maxWatchedWorkspaces: 64,
        warn: (message) => warnings.push(message),
      }),
    );
    const root = workspace();
    for (const name of ["a", "b", "c"]) writeFile(root, `docs/${name}.md`, name);
    registry.ensureWatched(root);

    // Disabled by the PER-WORKSPACE budget while the cross-workspace count is 1 — the two bounds are
    // not the same claim and neither stands in for the other.
    expect(registry.modeFor(root)).toBe("disabled");
    expect(registry.watchedWorkspaceCount()).toBe(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("tracked artifacts");
  });

  test("the shipped default is a stated constant, not an accident of the per-workspace cap", () => {
    expect(DEFAULT_MAX_WATCHED_WORKSPACES).toBe(64);
  });
});

describe("A10 — the new cross-layer write reuses the existing safety primitive", () => {
  test("allocation preemption during an open quiet window cancels the timer: no capture fires afterwards", async () => {
    const root = workspace();
    writeFile(root, "notes.md", "one\n");
    const captures: string[] = [];
    const { watchFactory, armed } = armedWatchFactory();
    const registry = track(
      new ArtifactWatcherRegistry({
        watchFactory,
        quietWindowMs: 400,
        captureExternalEdit: async (target) => {
          captures.push(typeof target === "string" ? target : target.canonical_path);
        },
      }),
    );
    registry.ensureWatched(root);
    // Armed first: a write that lands before the watch exists opens no window, and `captures`
    // would then be empty for a reason that has nothing to do with eviction.
    await armed();

    writeFileSync(join(root, "notes.md"), "one\ntwo\n");
    // Wait long enough for the change to be observed and the window to be OPEN, but not to fire.
    await Bun.sleep(150);
    // The allocator demotes through the same safe close path as explicit lifecycle eviction.
    await registry.applyAllocation([], [root]);

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
    const { watchFactory, armed } = armedWatchFactory();
    const registry = track(
      new ArtifactWatcherRegistry({
        watchFactory,
        quietWindowMs: 50,
        warn: (message) => warnings.push(message),
        captureExternalEdit: async () => {
          calls += 1;
          throw new Error("workspace is being permanently deleted (glosa forget)");
        },
      }),
    );
    registry.ensureWatched(root);
    await armed();

    // The capture throws on every call, so the retrying save cannot create entries; the warning
    // below is deduplicated by the watcher, so however many captures the saves provoke, "once" is
    // still the claim under test.
    await saveUntil(join(root, "notes.md"), "one\ntwo\n", () => calls > 0);
    const seen = calls;
    await saveUntil(join(root, "notes.md"), "one\ntwo\nthree\n", () => calls > seen);

    expect(registry.watchedWorkspaceCount()).toBe(1);
    expect(warnings.filter((message) => message.includes("external-edit capture failed"))).toHaveLength(1);
    // Explicit budget: this waits on two real filesystem events plus two quiet windows, and Bun's
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
  // There used to be a third bound here: 8,192 watch entries summed across every workspace, because
  // each entry was a real per-file watch and alpha.19's 64 x 4,096 of them exhausted a machine. With
  // one recursive watch per workspace that sum no longer measures anything a machine runs out of,
  // and it was refusing small workspaces live updates by warm-up order (#219). This pins its absence:
  // many small workspaces are all watched, and only the workspace count can refuse one.
  test("many small workspaces are all watched; no summed entry budget refuses them", () => {
    const warnings: string[] = [];
    const registry = track(new ArtifactWatcherRegistry({ warn: (message) => warnings.push(message) }));

    const modes: (string | null)[] = [];
    for (let i = 0; i < 12; i++) {
      const root = workspace();
      for (let d = 0; d < 20; d++) writeFile(root, join(`dir-${d}`, "notes.md"), `note ${i}/${d}\n`);
      registry.ensureWatched(root);
      modes.push(registry.modeFor(root));
    }

    // Evaluated in full before anything is asserted: an expect() inside the loop stops at the first
    // mismatch, and then every later workspace is asserted by reading the source instead.
    expect(modes).toEqual(Array.from({ length: 12 }, () => "tree"));
    expect(registry.watchedWorkspaceCount()).toBe(12);
    expect(warnings).toEqual([]);
  });
});

describe("glosa_watch (#153 Part 2) — criterion 1: wake on a real capture, with the real 2s quiet window", () => {
  test("a session blocked in a watch for draft.md wakes with the single coalesced entry, its hunks, and unknown attribution, within quiet window + capture latency of the LAST of three real saves", async () => {
    const root = workspace();
    claimTestDaemonIdentity(root);
    writeFile(root, "draft.md", "line one\n");
    const bus = openBus(root);
    await bus.reconcile(); // the baseline a daemon start establishes

    // Deliberately the REAL default quiet window (2s), not a shortened test value — criterion 1
    // is explicit that a watch's wake is measured against it, not against a window narrowed for
    // test speed.
    const { watchFactory, armed } = armedWatchFactory();
    const registry = track(
      new ArtifactWatcherRegistry({
        watchFactory,
        captureExternalEdit: (target) => openBusFor(target, bus).captureExternalEdit(),
      }),
    );
    registry.ensureWatched(root);
    await armed();

    const build = (id: string, payload: unknown, status: string) =>
      buildDeliveryPresentation(id, payload, { status, watched: true });
    // Blocked BEFORE any save lands — a real held watch, not a poll — with a wait_ms far longer
    // than the quiet window plus capture latency could ever take, so a genuine wake (rather than
    // the timer) is what settles this promise.
    const held = waitForWatch(bus, { session: "sess-a", path: "draft.md", waitMs: 20_000 }, build);

    writeFileSync(join(root, "draft.md"), "line one\nline two\n");
    await Bun.sleep(300);
    writeFileSync(join(root, "draft.md"), "line one\nline two\nline three\n");
    await Bun.sleep(300);
    writeFileSync(join(root, "draft.md"), "line one\nline two\nline three\nline four\n");
    const lastSaveAt = Date.now();

    const result = await held;
    const elapsedSinceLastSave = Date.now() - lastSaveAt;

    expect(result.waited).toBe(true);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.kind).toBe(EXTERNAL_EDIT_KIND);
    // The single coalesced entry for the whole burst, hunks included, not just the first save.
    expect(String(result.entries[0]?.text)).toContain("+line two");
    expect(String(result.entries[0]?.text)).toContain("+line three");
    expect(String(result.entries[0]?.text)).toContain("+line four");
    expect(String(result.entries[0]?.text)).toContain('attribution is "unknown"');
    // Ordering, not a hard latency promise (W6): it must land at or after the quiet window closes
    // following the LAST save, and this generous bound is a harness watchdog, not a product SLA.
    expect(elapsedSinceLastSave).toBeGreaterThanOrEqual(2_000);
    expect(elapsedSinceLastSave).toBeLessThan(10_000);

    // Exactly one entry ever existed — the burst coalesced, it did not just answer on the first.
    expect(externalEditEntries(bus)).toHaveLength(1);
  }, 30_000);
});

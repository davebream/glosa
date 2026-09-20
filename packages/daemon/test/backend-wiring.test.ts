// SPDX-License-Identifier: Apache-2.0
// P3.1 — proves `lifecycle.ts`'s `buildBackend` actually wires the daemon's ONE
// WorkspaceIndex/SessionRegistry/WorkspaceBusRegistry together per P2.4's deferred notes: a live
// session blocks GC hard-remove, and a real hard-remove evicts the workspace's open WorkspaceBus.
// Constructs the backend directly (no port binds, no subprocess) — see http.test.ts/http-routes.
// test.ts for the routes that consume this wiring end-to-end.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceWatch } from "../src/artifact-watcher.ts";
import { buildBackend } from "../src/lifecycle/daemon.ts";
import { WorkspaceIndex } from "../src/registry/workspace-index.ts";
import { canonicalize } from "../src/registry/slug.ts";
import { CapabilityStore } from "../src/security/capability.ts";
import { createApiFetch } from "../src/transport/http.ts";

async function waitForMode(
  backend: ReturnType<typeof buildBackend>,
  entry: Parameters<typeof backend.artifactWatcherRegistry.modeFor>[0],
  mode: "tree" | "files",
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (backend.artifactWatcherRegistry.modeFor(entry) === mode) return;
    await Bun.sleep(5);
  }
  expect(backend.artifactWatcherRegistry.modeFor(entry)).toBe(mode);
}

test("production-wired HTTP open keeps complete matcher scans off the request event loop", async () => {
  const home = mkdtempSync(join(tmpdir(), "glosa-http-scan-home-"));
  const userHome = canonicalize(mkdtempSync(join(tmpdir(), "glosa-http-scan-userhome-")));
  const root = canonicalize(mkdtempSync(join(tmpdir(), "glosa-http-scan-ws-")));
  const artifact = join(root, "note.md");
  writeFileSync(artifact, "# note\n");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let scans = 0;
  let synchronousShadowScans = 0;
  const backend = buildBackend(home, {
    userHomeDir: userHome,
    resolveTrackedFilesAsync: async () => {
      scans += 1;
      await gate;
      return {
        tracked: [{ path: "note.md", rawPath: artifact, sizeBytes: 7 }],
        oversize: [],
        directories: [],
        skippedSymlinks: [],
        truncated: false,
      };
    },
    resolveTrackedFilesSync: () => {
      synchronousShadowScans += 1;
      throw new Error("POISON: synchronous shadow matcher scan reached the HTTP transaction");
    },
  });

  try {
    // Matcher-mode owning directory: the request below point-resolves this existing registration,
    // then performs a real first reconcile with a non-empty snapshot and baseline/checkpoint Git.
    await backend.workspaceIndex.upsertWorkspace(root, "glosa-open");
    const port = 4647;
    const fetchFn = createApiFetch({
      port,
      classFPort: port + 1,
      token: "matcher-worker-test-token",
      instanceId: "matcher-worker-test",
      startedAt: new Date().toISOString(),
      workspaceIndex: backend.workspaceIndex,
      sessionRegistry: backend.sessionRegistry,
      getWorkspaceBus: (workspace) => backend.busRegistry.get(workspace),
      sealAdoptionSources: backend.sealAdoptionSources,
      adoptionCoordinator: backend.adoptionCoordinator,
      capabilityStore: new CapabilityStore(),
      adapterRegistry: backend.adapterRegistry,
      metadataRegistry: backend.metadataRegistry,
      providerRegistry: backend.providerRegistry,
      pushRegistry: backend.pushRegistry,
      artifactWatcherRegistry: backend.artifactWatcherRegistry,
      home,
    });
    let settled = false;
    const opening = fetchFn(
      new Request(`http://127.0.0.1:${port}/api/workspaces/open`, {
        method: "POST",
        headers: {
          Host: `127.0.0.1:${port}`,
          Authorization: "Bearer matcher-worker-test-token",
          Origin: `http://127.0.0.1:${port}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ path: artifact }),
      }),
    ).then((response) => {
      settled = true;
      return response;
    });

    for (let attempt = 0; scans < 2 && attempt < 200; attempt += 1) await Bun.sleep(5);
    expect(scans).toBe(2); // watcher initialization + offline catch-up use the same async boundary
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    release();
    expect((await opening).status).toBe(200);
    expect(synchronousShadowScans).toBe(0);
  } finally {
    release();
    await backend.closeWorkspaceResources();
    rmSync(home, { recursive: true, force: true });
    rmSync(userHome, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("production-wired HTTP adoption keeps the staging bus matcher scan off the request event loop", async () => {
  const home = mkdtempSync(join(tmpdir(), "glosa-http-adoption-home-"));
  const userHome = canonicalize(mkdtempSync(join(tmpdir(), "glosa-http-adoption-userhome-")));
  const root = canonicalize(mkdtempSync(join(tmpdir(), "glosa-http-adoption-ws-")));
  const artifact = join(root, "note.md");
  writeFileSync(artifact, "# note\n");
  let releaseStage!: () => void;
  const stageGate = new Promise<void>((resolve) => {
    releaseStage = resolve;
  });
  let stageScans = 0;
  let synchronousScans = 0;
  const tracked = {
    tracked: [{ path: "note.md", rawPath: artifact, sizeBytes: 7 }],
    oversize: [],
    directories: [],
    skippedSymlinks: [],
    truncated: false,
  };
  const backend = buildBackend(home, {
    userHomeDir: userHome,
    resolveTrackedFilesAsync: async (workspace) => {
      if (typeof workspace !== "string" && workspace.bus_path.includes(".glosa.adopt-")) {
        stageScans += 1;
        await stageGate;
      }
      return tracked;
    },
    resolveTrackedFilesSync: () => {
      synchronousScans += 1;
      throw new Error("POISON: synchronous matcher scan reached adoption staging");
    },
  });

  try {
    const loose = await backend.workspaceIndex.resolveOpenTarget(artifact);
    expect(loose.entry.kind).toBe("loose-file");
    await backend.busRegistry.get(loose.entry).reconcileOnce();
    const port = 4649;
    const fetchFn = createApiFetch({
      port,
      classFPort: port + 1,
      token: "adoption-worker-test-token",
      instanceId: "adoption-worker-test",
      startedAt: new Date().toISOString(),
      workspaceIndex: backend.workspaceIndex,
      sessionRegistry: backend.sessionRegistry,
      getWorkspaceBus: (workspace) => backend.busRegistry.get(workspace),
      sealAdoptionSources: backend.sealAdoptionSources,
      adoptionCoordinator: backend.adoptionCoordinator,
      createAdoptionStagingBus: backend.createAdoptionStagingBus,
      capabilityStore: new CapabilityStore(),
      adapterRegistry: backend.adapterRegistry,
      metadataRegistry: backend.metadataRegistry,
      providerRegistry: backend.providerRegistry,
      pushRegistry: backend.pushRegistry,
      artifactWatcherRegistry: backend.artifactWatcherRegistry,
      home,
    });
    let settled = false;
    const opening = fetchFn(
      new Request(`http://127.0.0.1:${port}/api/workspaces/open`, {
        method: "POST",
        headers: {
          Host: `127.0.0.1:${port}`,
          Authorization: "Bearer adoption-worker-test-token",
          Origin: `http://127.0.0.1:${port}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ path: root }),
      }),
    ).then((response) => {
      settled = true;
      return response;
    });

    for (let attempt = 0; stageScans === 0 && attempt < 200; attempt += 1) await Bun.sleep(5);
    expect(stageScans).toBe(1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    releaseStage();
    expect((await opening).status).toBe(200);
    expect(synchronousScans).toBe(0);
  } finally {
    releaseStage();
    await backend.closeWorkspaceResources();
    rmSync(home, { recursive: true, force: true });
    rmSync(userHome, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

describe("buildBackend — daemon backend wiring (P2.4's deferred notes)", () => {
  let home: string;
  let root: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "glosa-backend-home-"));
    root = canonicalize(mkdtempSync(join(tmpdir(), "glosa-backend-ws-")));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  test("constructs one WorkspaceIndex + one SessionRegistry sharing it", async () => {
    const backend = buildBackend(home);
    const entry = await backend.workspaceIndex.upsertWorkspace(root, "glosa-open");
    expect(entry.canonical_path).toBe(root);

    await backend.sessionRegistry.register({ session_id: "s1", provider: "claude-code", cwd: root, source: "mcp" });
    // The registry's own register() upserts into the SAME index instance it was constructed
    // with — so the workspace is reachable from either handle.
    expect(backend.workspaceIndex.get(root)?.slug).toBe(entry.slug);
  });

  test("live-session predicate is wired: GC never hard-removes a workspace with a live session", async () => {
    const backend = buildBackend(home, { gcGraceMs: 0, gcThrottleMs: 0 });
    await backend.workspaceIndex.upsertWorkspace(root, "glosa-open");
    await backend.sessionRegistry.register({ session_id: "s1", provider: "claude-code", cwd: root, source: "mcp" });
    rmSync(root, { recursive: true, force: true }); // path now missing on disk

    await backend.workspaceIndex.gc({ force: true }); // pass 1: softens to present:false
    await backend.workspaceIndex.gc({ force: true }); // pass 2: would hard-remove if unwired/no live session

    expect(backend.workspaceIndex.get(root)).not.toBeNull(); // still on record — the live session blocked it
  });

  test("reopening a restored soft-absent loose registration starts its daemon-lifetime watcher exactly once", async () => {
    const artifact = join(root, "loose.pdf");
    writeFileSync(artifact, "loose\n");
    const priorProcess = new WorkspaceIndex({ home });
    const original = await priorProcess.resolveOpenTarget(artifact);
    const firstSeen = original.entry.first_seen;
    rmSync(artifact);
    await priorProcess.gc({ force: true });
    expect(priorProcess.getWorkspaceByRegistration(original.entry.registration_id)?.present).toBe(false);

    const backend = buildBackend(home);
    try {
      await backend.warmArtifactWatchers();
      expect(backend.artifactWatcherRegistry.modeFor(original.entry)).toBeNull();
      writeFileSync(artifact, "returned\n");

      const reopened = await backend.workspaceIndex.resolveOpenTarget(artifact);
      await waitForMode(backend, reopened.entry, "files");
      expect(reopened.entry.first_seen).toBe(firstSeen);
      expect(reopened.entry.registration_id).toBe(original.entry.registration_id);
      expect(backend.artifactWatcherRegistry.modeFor(reopened.entry)).toBe("files");

      await backend.workspaceIndex.resolveOpenTarget(artifact);
      expect(backend.artifactWatcherRegistry.modeFor(reopened.entry)).toBe("files");
    } finally {
      await backend.closeWorkspaceResources();
    }
  });

  test("onHardRemove is wired: a real GC hard-remove evicts the workspace's open WorkspaceBus", async () => {
    const backend = buildBackend(home, { gcGraceMs: 0, gcThrottleMs: 0 });
    const entry = await backend.workspaceIndex.upsertWorkspace(root, "glosa-open");

    const bus = backend.busRegistry.get(root);
    expect(backend.busRegistry.has(root)).toBe(true);
    await bus.reconcile();
    backend.artifactWatcherRegistry.subscribe(entry, () => {});
    await waitForMode(backend, entry, "tree");
    expect(backend.artifactWatcherRegistry.modeFor(entry)).toBe("tree");

    rmSync(root, { recursive: true, force: true }); // path missing, AND no live session this time
    await backend.workspaceIndex.gc({ force: true }); // pass 1: soften
    await backend.workspaceIndex.gc({ force: true }); // pass 2: hard-remove (no live session predicate match)

    expect(backend.workspaceIndex.get(root)).toBeNull(); // gone from the index
    expect(backend.busRegistry.has(root)).toBe(false); // AND its bus was evicted, not leaked
    expect(backend.artifactWatcherRegistry.modeFor(entry)).toBeNull();
  });

  test("hard-remove evicts by registration identity without closing a loose-file sibling", async () => {
    const backend = buildBackend(home);
    const directory = await backend.workspaceIndex.upsertWorkspace(root, "glosa-open");
    const artifact = join(root, "loose.pdf");
    writeFileSync(artifact, "loose\n");
    const loose = await backend.workspaceIndex.resolveOpenTarget(artifact);
    expect(loose.entry.kind).toBe("loose-file");

    backend.busRegistry.get(loose.entry);
    backend.artifactWatcherRegistry.subscribe(loose.entry, () => {});
    await waitForMode(backend, loose.entry, "files");
    expect(backend.busRegistry.has(loose.entry)).toBe(true);
    expect(backend.artifactWatcherRegistry.modeFor(loose.entry)).toBe("files");

    await backend.workspaceIndex.forget(directory.slug);
    expect(backend.busRegistry.has(loose.entry)).toBe(true);
    expect(backend.artifactWatcherRegistry.modeFor(loose.entry)).toBe("files");

    await backend.workspaceIndex.forget(loose.entry.slug);
    expect(backend.busRegistry.has(loose.entry)).toBe(false);
    expect(backend.artifactWatcherRegistry.modeFor(loose.entry)).toBeNull();
  });

  test("adoption sealing and daemon resource shutdown close shared artifact watchers", async () => {
    const backend = buildBackend(home);
    const entry = await backend.workspaceIndex.upsertWorkspace(root, "glosa-open");
    backend.artifactWatcherRegistry.subscribe(entry, () => {});
    await waitForMode(backend, entry, "tree");
    expect(backend.artifactWatcherRegistry.modeFor(entry)).toBe("tree");

    await backend.sealAdoptionSources([entry], "adopt-test", "target-registration");
    expect(backend.artifactWatcherRegistry.modeFor(entry)).toBeNull();

    const secondRoot = mkdtempSync(join(tmpdir(), "glosa-backend-second-"));
    try {
      writeFileSync(join(secondRoot, "note.md"), "# second\n");
      const secondEntry = await backend.workspaceIndex.upsertWorkspace(secondRoot, "glosa-open");
      backend.artifactWatcherRegistry.subscribe(secondEntry, () => {});
      await waitForMode(backend, secondEntry, "tree");
      backend.busRegistry.get(secondEntry);
      expect(backend.artifactWatcherRegistry.modeFor(secondEntry)).toBe("tree");
      expect(backend.busRegistry.has(secondEntry)).toBe(true);

      await backend.closeWorkspaceResources();
      expect(backend.artifactWatcherRegistry.modeFor(secondEntry)).toBeNull();
      expect(backend.busRegistry.has(secondEntry)).toBe(false);
    } finally {
      rmSync(secondRoot, { recursive: true, force: true });
    }
  });
});

describe("daemon exit does not wait on closing filesystem watches", () => {
  // The regression this pins: a daemon near the watch-entry budget spent 30 s+ inside chokidar's
  // close() on shutdown (Bun's per-file fs.watch closes synchronously, and slower the more there
  // are), holding daemon.lock with a frozen event loop, so the upgrading client gave up after 5 s.
  // A watch that counts its close calls stands in for that; the exit path must not reach it.
  let home: string;
  let root: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "glosa-exit-home-"));
    root = canonicalize(mkdtempSync(join(tmpdir(), "glosa-exit-ws-")));
    writeFileSync(join(root, "note.md"), "# note\n");
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  /** Stands in for a watch whose close is expensive: the exit path must never call it. */
  class HangingWatcher implements WorkspaceWatch {
    closeCalls = 0;
    close(): void {
      this.closeCalls += 1;
    }
  }

  test("releaseWorkspaceResourcesForExit retires watchers and closes buses without closing any watch", async () => {
    const watchers: HangingWatcher[] = [];
    const backend = buildBackend(home, {
      artifactWatchFactory: () => {
        const watcher = new HangingWatcher();
        watchers.push(watcher);
        return watcher;
      },
    });
    const entry = await backend.workspaceIndex.upsertWorkspace(root, "glosa-open");
    backend.busRegistry.get(entry);
    await waitForMode(backend, entry, "tree");
    expect(watchers).toHaveLength(1);
    expect(backend.artifactWatcherRegistry.watchedWorkspaceCount()).toBe(1);

    const released = await Promise.race([
      backend.releaseWorkspaceResourcesForExit().then(() => true),
      Bun.sleep(2000).then(() => false),
    ]);

    expect(released).toBe(true);
    expect(watchers[0]!.closeCalls).toBe(0);
    expect(backend.artifactWatcherRegistry.watchedWorkspaceCount()).toBe(0);
    expect(backend.artifactWatcherRegistry.modeFor(entry)).toBeNull();
    expect(backend.busRegistry.has(entry)).toBe(false);
  });

  test("warm-up stops opening watches once exit has begun", async () => {
    const extraRoots = [0, 1].map(() => canonicalize(mkdtempSync(join(tmpdir(), "glosa-exit-ws-"))));
    try {
      const seeding = buildBackend(home, { artifactWatchFactory: () => new HangingWatcher() });
      for (const r of [root, ...extraRoots]) {
        writeFileSync(join(r, "note.md"), "# note\n");
        await seeding.workspaceIndex.upsertWorkspace(r, "glosa-open");
      }
      seeding.artifactWatcherRegistry.abandonAll();

      let opened = 0;
      const backend = buildBackend(home, {
        artifactWatchFactory: () => {
          opened += 1;
          return new HangingWatcher();
        },
      });
      // Warm-up schedules the first workspace scan off-thread; exit can retire it before a native
      // watch opens, and must prevent every later workspace from opening one too.
      const warming = backend.warmArtifactWatchers();
      await backend.releaseWorkspaceResourcesForExit();
      await warming;

      expect(opened).toBeLessThanOrEqual(1);
      expect(backend.artifactWatcherRegistry.watchedWorkspaceCount()).toBe(0);
    } finally {
      for (const r of extraRoots) rmSync(r, { recursive: true, force: true });
    }
  });
});

describe("buildBackend does not watch the index it finds — warm-up is not readiness", () => {
  // The regression this pins. alpha.19 walked every registered workspace inside buildBackend,
  // which runs BEFORE Bun.serve, so a machine with an accumulated index never answered the
  // handshake: `glosa open` timed out at 5s while the daemon burned CPU for minutes. The watching
  // itself was right; doing it on the readiness path was not.
  let home: string;
  const roots: string[] = [];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "glosa-warm-home-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  test("constructing the backend starts no watchers; calling the warm-up starts them", async () => {
    const first = buildBackend(home);
    for (let i = 0; i < 3; i++) {
      const root = canonicalize(mkdtempSync(join(tmpdir(), "glosa-warm-ws-")));
      roots.push(root);
      writeFileSync(join(root, "notes.md"), `note ${i}\n`);
      await first.workspaceIndex.upsertWorkspace(root, "glosa-open");
    }
    await first.closeWorkspaceResources();

    // A second backend over the SAME home now finds three workspaces already in the index — the
    // shape that used to make construction do the walking.
    const backend = buildBackend(home);
    expect(backend.workspaceIndex.list({ presentOnly: true }).length).toBe(3);
    // The assertion: construction watched nothing, however many workspaces it found.
    expect(backend.artifactWatcherRegistry.watchedWorkspaceCount()).toBe(0);

    // And the warm-up is what does it, when the caller chooses — after serving.
    await backend.warmArtifactWatchers();
    expect(backend.artifactWatcherRegistry.watchedWorkspaceCount()).toBeGreaterThan(0);
    await backend.closeWorkspaceResources();
  });
});

describe("warm-up applies the same refusals workspace resolution does", () => {
  // #146/#209 made a workspace never the home directory or an ancestor of it. That guard runs when
  // a workspace is RESOLVED, so it stops new registrations and refuses to reuse an existing one —
  // but the index still holds entries written before it existed, and watcher warm-up watches what
  // the index holds. Without this the daemon starts a matcher walk over the whole home directory
  // for a registration `glosa open` would refuse today, and wedges.
  let home: string;
  let fakeHome: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "glosa-refuse-home-"));
    fakeHome = canonicalize(mkdtempSync(join(tmpdir(), "glosa-fake-user-home-")));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  });

  test("a registration at the home directory is left unwatched; an ordinary one beside it is watched", async () => {
    const ordinary = canonicalize(mkdtempSync(join(tmpdir(), "glosa-ordinary-ws-")));
    try {
      writeFileSync(join(fakeHome, "notes.md"), "in home\n");
      writeFileSync(join(ordinary, "notes.md"), "beside it\n");

      const seeding = buildBackend(home, { userHomeDir: fakeHome });
      await seeding.workspaceIndex.upsertWorkspace(fakeHome, "glosa-open");
      await seeding.workspaceIndex.upsertWorkspace(ordinary, "glosa-open");
      await seeding.closeWorkspaceResources();

      const backend = buildBackend(home, { userHomeDir: fakeHome });
      expect(backend.workspaceIndex.list({ presentOnly: true }).length).toBe(2);
      await backend.warmArtifactWatchers();

      // Both halves asserted together: the refusal is real AND it is not refusing everything.
      expect({
        home: backend.artifactWatcherRegistry.modeFor(fakeHome),
        ordinary: backend.artifactWatcherRegistry.modeFor(ordinary) !== null,
      }).toEqual({ home: null, ordinary: true });
      await backend.closeWorkspaceResources();
    } finally {
      rmSync(ordinary, { recursive: true, force: true });
    }
  });
});

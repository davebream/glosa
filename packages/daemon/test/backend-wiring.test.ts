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
import { buildBackend } from "../src/lifecycle.ts";
import { canonicalize } from "../src/registry/slug.ts";

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

    await backend.sessionRegistry.register({ session_id: "s1", provider: "claude-code", cwd: root, source: "hook" });
    // The registry's own register() upserts into the SAME index instance it was constructed
    // with — so the workspace is reachable from either handle.
    expect(backend.workspaceIndex.get(root)?.slug).toBe(entry.slug);
  });

  test("live-session predicate is wired: GC never hard-removes a workspace with a live session", async () => {
    const backend = buildBackend(home, { gcGraceMs: 0, gcThrottleMs: 0 });
    await backend.workspaceIndex.upsertWorkspace(root, "glosa-open");
    await backend.sessionRegistry.register({ session_id: "s1", provider: "claude-code", cwd: root, source: "hook" });
    rmSync(root, { recursive: true, force: true }); // path now missing on disk

    await backend.workspaceIndex.gc({ force: true }); // pass 1: softens to present:false
    await backend.workspaceIndex.gc({ force: true }); // pass 2: would hard-remove if unwired/no live session

    expect(backend.workspaceIndex.get(root)).not.toBeNull(); // still on record — the live session blocked it
  });

  test("onHardRemove is wired: a real GC hard-remove evicts the workspace's open WorkspaceBus", async () => {
    const backend = buildBackend(home, { gcGraceMs: 0, gcThrottleMs: 0 });
    const entry = await backend.workspaceIndex.upsertWorkspace(root, "glosa-open");

    const bus = backend.busRegistry.get(root);
    expect(backend.busRegistry.has(root)).toBe(true);
    await bus.reconcile();
    backend.artifactWatcherRegistry.subscribe(entry, () => {});
    expect(backend.artifactWatcherRegistry.modeFor(entry)).toBe("directories");

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
    expect(backend.artifactWatcherRegistry.modeFor(entry)).toBe("directories");

    await backend.sealAdoptionSources([entry], "adopt-test", "target-registration");
    expect(backend.artifactWatcherRegistry.modeFor(entry)).toBeNull();

    const secondRoot = mkdtempSync(join(tmpdir(), "glosa-backend-second-"));
    try {
      writeFileSync(join(secondRoot, "note.md"), "# second\n");
      const secondEntry = await backend.workspaceIndex.upsertWorkspace(secondRoot, "glosa-open");
      backend.artifactWatcherRegistry.subscribe(secondEntry, () => {});
      backend.busRegistry.get(secondEntry);
      expect(backend.artifactWatcherRegistry.modeFor(secondEntry)).toBe("directories");
      expect(backend.busRegistry.has(secondEntry)).toBe(true);

      await backend.closeWorkspaceResources();
      expect(backend.artifactWatcherRegistry.modeFor(secondEntry)).toBeNull();
      expect(backend.busRegistry.has(secondEntry)).toBe(false);
    } finally {
      rmSync(secondRoot, { recursive: true, force: true });
    }
  });
});

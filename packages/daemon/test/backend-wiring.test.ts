// P3.1 — proves `lifecycle.ts`'s `buildBackend` actually wires the daemon's ONE
// WorkspaceIndex/SessionRegistry/WorkspaceBusRegistry together per P2.4's deferred notes: a live
// session blocks GC hard-remove, and a real hard-remove evicts the workspace's open WorkspaceBus.
// Constructs the backend directly (no port binds, no subprocess) — see http.test.ts/http-routes.
// test.ts for the routes that consume this wiring end-to-end.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
    await backend.workspaceIndex.upsertWorkspace(root, "glosa-open");

    const bus = backend.busRegistry.get(root);
    expect(backend.busRegistry.has(root)).toBe(true);
    await bus.reconcile();

    rmSync(root, { recursive: true, force: true }); // path missing, AND no live session this time
    await backend.workspaceIndex.gc({ force: true }); // pass 1: soften
    await backend.workspaceIndex.gc({ force: true }); // pass 2: hard-remove (no live session predicate match)

    expect(backend.workspaceIndex.get(root)).toBeNull(); // gone from the index
    expect(backend.busRegistry.has(root)).toBe(false); // AND its bus was evicted, not leaked
  });
});

// P5.2 (T8 release gate — "adapter-topology", per docs/OVERNIGHT-LOG.md's D10 reinterpretation:
// the real-world domain adapter this generalizes from is out of this repo as of P6.1, so this
// proves the SAME class of topology generically — "Claude cwd != the adapter's own data path;
// provider binding routes correctly" — through the
// P6.1 fixture-adapter protocol. `test/adapters/interface.test.ts`'s own `resolveSessionBinding`
// describe block already unit-tests `AdapterRegistry.resolveSessionBinding` directly in isolation
// — that's necessary but not sufficient: it never proves the REAL route
// (`POST /api/sessions/register` / `handleSessionRegister` in http.ts) actually wires an
// `AdapterRegistry` into its decision, end to end, over a real `SessionRegistry`. This file does
// that: real `createApiFetch` pipeline, real HTTP request objects, a fixture adapter extended
// with a `sessionBindingFor` map (this task's addition to
// test/fixtures/adapter/fixture-adapter.ts) standing in for a real adapter's own out-of-band
// session-history state.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiFetch, type ApiContext } from "../../src/http.ts";
import { CapabilityStore } from "../../src/capability.ts";
import { WorkspaceIndex } from "../../src/registry/workspace-index.ts";
import { SessionRegistry } from "../../src/registry/session-registry.ts";
import { WorkspaceBusRegistry } from "../../src/bus/workspace-bus-registry.ts";
import { canonicalize } from "../../src/registry/slug.ts";
import { AdapterRegistry } from "../../src/adapters/interface.ts";
import { createFixtureAdapter, FIXTURE_MARKER_FILE } from "../fixtures/adapter/fixture-adapter.ts";

const TOKEN = "adapter-topology-test-token-0123456789";
const PORT = 4646;

describe("adapter-topology (T8, per D10) — session cwd != adapter's real workspace root", () => {
  let home: string;
  let cwdDir: string; // what the hook reports as `cwd` — NOT where the adapter says the real data lives
  let realWorkspaceRoot: string; // what the adapter's own state actually associates with the session
  let unrelatedDir: string; // a third directory, never named by any binding — the mis-route trap
  let workspaceIndex: WorkspaceIndex;
  let sessionRegistry: SessionRegistry;
  let busRegistry: WorkspaceBusRegistry;
  let fetchFn: (req: Request) => Promise<Response>;
  let ctxBase: Omit<ApiContext, "adapterRegistry">;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "glosa-topology-home-"));
    cwdDir = canonicalize(mkdtempSync(join(tmpdir(), "glosa-topology-cwd-")));
    realWorkspaceRoot = canonicalize(mkdtempSync(join(tmpdir(), "glosa-topology-real-")));
    unrelatedDir = canonicalize(mkdtempSync(join(tmpdir(), "glosa-topology-unrelated-")));
    writeFileSync(join(realWorkspaceRoot, FIXTURE_MARKER_FILE), ""); // makes it a real recognizable workspace

    workspaceIndex = new WorkspaceIndex({ home });
    sessionRegistry = new SessionRegistry({ index: workspaceIndex });
    busRegistry = new WorkspaceBusRegistry();
    workspaceIndex.setLiveSessionPredicate((p) => sessionRegistry.forWorkspace(p).length > 0);
    workspaceIndex.setOnHardRemove((p) => busRegistry.evict(p));

    ctxBase = {
      port: PORT,
      classFPort: PORT + 1,
      token: TOKEN,
      instanceId: "gl-test",
      startedAt: new Date().toISOString(),
      workspaceIndex,
      sessionRegistry,
      getWorkspaceBus: (r) => busRegistry.get(r),
      capabilityStore: new CapabilityStore(),
    };
  });

  afterEach(async () => {
    await busRegistry.close(realWorkspaceRoot).catch(() => {});
    await busRegistry.close(cwdDir).catch(() => {});
    await busRegistry.close(unrelatedDir).catch(() => {});
    rmSync(home, { recursive: true, force: true });
    rmSync(cwdDir, { recursive: true, force: true });
    rmSync(realWorkspaceRoot, { recursive: true, force: true });
    rmSync(unrelatedDir, { recursive: true, force: true });
  });

  function req(path: string, body: unknown): Request {
    const headers = new Headers({
      Host: `127.0.0.1:${PORT}`,
      Authorization: `Bearer ${TOKEN}`,
      Origin: `http://127.0.0.1:${PORT}`,
      "Content-Type": "application/json",
    });
    return new Request(`http://127.0.0.1:${PORT}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  }

  test("adapter loaded + cwd mismatched from the real workspace root -> registers to the ADAPTER's answer, not cwd", async () => {
    const registry = new AdapterRegistry();
    registry.register(
      createFixtureAdapter({
        roots: [realWorkspaceRoot],
        sessionBindingFor: { "sess-1": realWorkspaceRoot },
      }),
    );
    const ctx: ApiContext = { ...ctxBase, adapterRegistry: registry };
    fetchFn = createApiFetch(ctx);

    const res = await fetchFn(
      req("/api/sessions/register", { session_id: "sess-1", provider: "claude-code", cwd: cwdDir, source: "startup" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspace: string };

    // The headline assertion: routed to the adapter's real data root, NOT the hook-reported cwd —
    // and NOT the cwd-ancestor fallback either (cwdDir is not even an ancestor of realWorkspaceRoot,
    // so a buggy implementation falling through to that fallback would show up as neither value).
    expect(body.workspace).toBe(realWorkspaceRoot);
    expect(body.workspace).not.toBe(cwdDir);

    const record = sessionRegistry.get("sess-1");
    expect(record?.cwd).toBe(cwdDir); // the raw hook fact is still preserved, untouched
    expect(record?.workspace_binding).toBe(realWorkspaceRoot); // routing authority is the adapter's answer

    await busRegistry.close(realWorkspaceRoot);
  });

  test("NO adapter registry configured + a cwd matching nothing known -> falls back to cwd itself, never a silent mis-route to some OTHER real workspace", async () => {
    const ctx: ApiContext = { ...ctxBase }; // adapterRegistry deliberately absent
    fetchFn = createApiFetch(ctx);

    const res = await fetchFn(
      req("/api/sessions/register", { session_id: "sess-2", provider: "claude-code", cwd: unrelatedDir, source: "startup" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspace: string };

    expect(body.workspace).toBe(unrelatedDir); // honest cwd-ancestor fallback: itself, no adapter to consult
    expect(body.workspace).not.toBe(realWorkspaceRoot); // critically: never mis-routed to an unrelated real workspace
    expect(sessionRegistry.get("sess-2")?.workspace_binding).toBeUndefined(); // no adapter opinion was ever recorded
  });

  test("adapter LOADED but has no opinion on this particular session -> same honest cwd fallback, not the adapter's answer for a DIFFERENT session", async () => {
    const registry = new AdapterRegistry();
    registry.register(
      createFixtureAdapter({
        roots: [realWorkspaceRoot],
        sessionBindingFor: { "sess-1": realWorkspaceRoot }, // only has an opinion about sess-1
      }),
    );
    const ctx: ApiContext = { ...ctxBase, adapterRegistry: registry };
    fetchFn = createApiFetch(ctx);

    const res = await fetchFn(
      req("/api/sessions/register", { session_id: "sess-3", provider: "claude-code", cwd: unrelatedDir, source: "startup" }),
    );
    const body = (await res.json()) as { workspace: string };

    expect(body.workspace).toBe(unrelatedDir); // adapter had nothing to say about sess-3 -> honest fallback
    expect(body.workspace).not.toBe(realWorkspaceRoot); // never sess-1's binding leaking onto sess-3
  });

  test("an explicit workspace_binding in the request body wins outright over the adapter's own answer", async () => {
    const registry = new AdapterRegistry();
    registry.register(
      createFixtureAdapter({
        roots: [realWorkspaceRoot],
        sessionBindingFor: { "sess-1": realWorkspaceRoot },
      }),
    );
    const ctx: ApiContext = { ...ctxBase, adapterRegistry: registry };
    fetchFn = createApiFetch(ctx);

    const res = await fetchFn(
      req("/api/sessions/register", {
        session_id: "sess-1",
        provider: "claude-code",
        cwd: cwdDir,
        source: "startup",
        workspace_binding: unrelatedDir, // explicit — the "more direct signal" per http.ts's own comment
      }),
    );
    const body = (await res.json()) as { workspace: string };
    expect(body.workspace).toBe(unrelatedDir);
    expect(body.workspace).not.toBe(realWorkspaceRoot);
  });
});

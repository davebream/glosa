// SPDX-License-Identifier: Apache-2.0
// P6.1 acceptance: "the core runs with ZERO adapters" — a plain directory -> ordered file list,
// every viewer/annotation/editor route works, class-F HTML is opaque (Preview+Annotate, no Edit
// affordance), no derived-from edge -> no staleness. Same route-schema-level harness as
// http-routes.test.ts (real ApiContext, real WorkspaceIndex/SessionRegistry/WorkspaceBusRegistry
// over a real tmp workspace) but this file's `ctx` deliberately never sets `adapterRegistry` —
// that absence itself IS the thing under test, not a gap in the harness. Also wires the OWED
// class-R anchoring resolution (`anchoring.ts`, built since P3.4 but never called by a live
// route until P6.1) end-to-end via the annotation route's new optional `artifact_path` field.
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

const TOKEN = "zero-adapter-test-token-0123456789";
const PORT = 4646;

describe("core runs with ZERO adapters (P6.1 acceptance)", () => {
  let home: string;
  let root: string;
  let workspaceIndex: WorkspaceIndex;
  let sessionRegistry: SessionRegistry;
  let busRegistry: WorkspaceBusRegistry;
  let ctx: ApiContext;
  let fetchFn: (req: Request) => Promise<Response>;
  let slug: string;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "glosa-zero-adapter-home-"));
    root = canonicalize(mkdtempSync(join(tmpdir(), "glosa-zero-adapter-ws-")));

    workspaceIndex = new WorkspaceIndex({ home });
    sessionRegistry = new SessionRegistry({ index: workspaceIndex });
    busRegistry = new WorkspaceBusRegistry();
    workspaceIndex.setLiveSessionPredicate((p) => sessionRegistry.forWorkspace(p).length > 0);
    workspaceIndex.setOnHardRemove((p) => busRegistry.evict(p));

    const entry = await workspaceIndex.upsertWorkspace(root, "glosa-open");
    slug = entry.slug;

    ctx = {
      port: PORT,
      classFPort: PORT + 1,
      token: TOKEN,
      instanceId: "gl-test",
      startedAt: new Date().toISOString(),
      workspaceIndex,
      sessionRegistry,
      getWorkspaceBus: (r) => busRegistry.get(r),
      capabilityStore: new CapabilityStore(),
      // No `adapterRegistry` — this IS the test.
    };
    fetchFn = createApiFetch(ctx);
  });

  afterEach(async () => {
    await busRegistry.close(root);
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  function req(path: string, init: RequestInit = {}): Request {
    const headers = new Headers(init.headers);
    headers.set("Host", `127.0.0.1:${PORT}`);
    if (!headers.has("Authorization")) headers.set("Authorization", `Bearer ${TOKEN}`);
    return new Request(`http://127.0.0.1:${PORT}${path}`, { ...init, headers });
  }
  function stateChangingReq(path: string, init: RequestInit = {}): Request {
    return req(path, { ...init, headers: { ...init.headers, Origin: `http://127.0.0.1:${PORT}` } });
  }

  test("GET /w/:slug/artifacts: on-disk order, never stale, extension-based class — with no adapter registered", async () => {
    writeFileSync(join(root, "b.md"), "# B\n");
    writeFileSync(join(root, "a.md"), "# A\n");
    writeFileSync(join(root, "out.html"), "<p>hi</p>");
    const res = await fetchFn(req(`/w/${slug}/artifacts`));
    const body = await res.json();
    expect(body.map((a: { path: string }) => a.path)).toEqual(["a.md", "b.md", "out.html"]);
    expect(body.every((a: { stale: boolean }) => a.stale === false)).toBe(true);
    expect(body.find((a: { path: string }) => a.path === "out.html").class).toBe("F");
  });

  test("GET class-F artifact carries no derived_from/manifest_path fields at all — opaque, not just falsy", async () => {
    writeFileSync(join(root, "out.html"), "<p>hi</p>");
    const res = await fetchFn(req(`/w/${slug}/artifacts/out.html`));
    const body = await res.json();
    expect(Object.hasOwn(body, "derived_from")).toBe(false);
    expect(Object.hasOwn(body, "manifest_path")).toBe(false);
  });

  test("class-R editor round-trip (PUT) still works unchanged", async () => {
    writeFileSync(join(root, "notes.md"), "# Title\n\nOriginal.\n");
    const res = await fetchFn(
      stateChangingReq(`/w/${slug}/artifacts/notes.md`, {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
        body: "# Title\n\nEdited.\n",
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content).toBe("# Title\n\nEdited.\n");
  });

  test("class-F capability mint still refuses a class-R path, still mints for class-F", async () => {
    writeFileSync(join(root, "notes.md"), "# Title\n");
    writeFileSync(join(root, "out.html"), "<p>hi</p>");
    const rRes = await fetchFn(stateChangingReq(`/w/${slug}/capability/notes.md`, { method: "POST" }));
    expect(rRes.status).toBe(400);
    const fRes = await fetchFn(stateChangingReq(`/w/${slug}/capability/out.html`, { method: "POST" }));
    expect(fRes.status).toBe(200);
  });

  test("class-R annotation without artifact_path is rejected because actionable delivery requires identity", async () => {
    writeFileSync(join(root, "notes.md"), "# Title\n\nBody text here.\n");
    const res = await fetchFn(
      stateChangingReq(`/w/${slug}/annotations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: "note", intent: "content", target: { quote: { exact: "Body text here.", prefix: "", suffix: "" } } }),
      }),
    );
    expect(res.status).toBe(400);
    const parsed = await res.json();
    expect(parsed.type).toContain("validation-failed");
  });

  test("class-R annotation resolution wired end-to-end via artifact_path — needs NO adapter (P6.1 OWED wiring)", async () => {
    writeFileSync(join(root, "notes.md"), "# Title\n\nA unique sentence here.\n");
    const res = await fetchFn(
      stateChangingReq(`/w/${slug}/annotations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body: "tighten this",
          intent: "content",
          target: { quote: { exact: "A unique sentence here.", prefix: "", suffix: "" } },
          artifact_path: "notes.md",
        }),
      }),
    );
    expect(res.status).toBe(201);
    const parsed = await res.json();
    expect(parsed.resolution).toEqual({
      kind: "source_range",
      path: "notes.md",
      start_line: 2,
      end_line: 2,
      start_col: 0,
      end_col: "A unique sentence here.".length,
      matched_quote: "A unique sentence here.",
      confidence: "exact",
    });
  });

  test("class-R annotation resolution: quote not present anywhere -> orphaned{hash_mismatch_no_match}, never a 500", async () => {
    writeFileSync(join(root, "notes.md"), "# Title\n\nSomething else entirely.\n");
    const res = await fetchFn(
      stateChangingReq(`/w/${slug}/annotations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body: "note",
          intent: "content",
          target: { quote: { exact: "text that does not exist", prefix: "", suffix: "" } },
          artifact_path: "notes.md",
        }),
      }),
    );
    expect(res.status).toBe(201);
    const parsed = await res.json();
    expect(parsed.resolution).toEqual({ kind: "orphaned", reason: "hash_mismatch_no_match" });
  });

  test("class-F annotation resolution with no adapter -> orphaned{no_source_map}, never a 500", async () => {
    writeFileSync(join(root, "out.html"), "<p>hi</p>");
    const res = await fetchFn(
      stateChangingReq(`/w/${slug}/annotations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body: "note",
          intent: "content",
          target: { quote: { exact: "hi", prefix: "", suffix: "" } },
          artifact_path: "out.html",
        }),
      }),
    );
    expect(res.status).toBe(201);
    const parsed = await res.json();
    expect(parsed.resolution).toEqual({ kind: "orphaned", reason: "no_source_map" });
  });

  test("annotation with an artifact_path that doesn't exist -> entry still created (201), resolution simply absent", async () => {
    const res = await fetchFn(
      stateChangingReq(`/w/${slug}/annotations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body: "note",
          intent: "content",
          target: { quote: { exact: "x", prefix: "", suffix: "" } },
          artifact_path: "does-not-exist.md",
        }),
      }),
    );
    expect(res.status).toBe(201);
    const parsed = await res.json();
    expect(Object.hasOwn(parsed, "resolution")).toBe(false);
  });

  // Fix 3 (P6.1 review): a pathological artifact_path with thousands of segments (no "..", so
  // the cheap traversal pre-check doesn't reject it) used to drive that many synchronous
  // realpathSync/dirname calls inside confinePath's ancestor walk — blocking the ENTIRE
  // single-threaded daemon (every workspace) for the request's duration. Post-fix, confinePath
  // rejects it immediately, so buildAnchoringContext degrades to null exactly like any other
  // unconfineable path: the annotation is still created, resolution is simply absent — never a
  // crash, never a 500, and (the point of this test) never slow.
  test("annotation with a pathological (thousands-of-segments) artifact_path -> rejected fast, entry still created (201), resolution absent — never a 500, never a hang", async () => {
    const start = performance.now();
    const res = await fetchFn(
      stateChangingReq(`/w/${slug}/annotations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body: "note",
          intent: "content",
          target: { quote: { exact: "x", prefix: "", suffix: "" } },
          artifact_path: "a/".repeat(5000) + "leaf.md",
        }),
      }),
    );
    const elapsedMs = performance.now() - start;
    expect(res.status).toBe(201);
    const parsed = await res.json();
    expect(Object.hasOwn(parsed, "resolution")).toBe(false);
    expect(elapsedMs).toBeLessThan(1000);
  });
});

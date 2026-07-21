// SPDX-License-Identifier: Apache-2.0
// P6.1 acceptance: the neutral fixture adapter (test/fixtures/adapter/fixture-adapter.ts)
// registers PURELY through the public ContentAdapter protocol and proves every generic behavior
// R7 promises: data-path recognition, the derived-from edge (Edit-on-class-F source + staleness),
// class-F manifest resolution (`manifest_path` in the artifact response), and class-F annotation
// resolution via anchoring.ts — both the verbatim (search-in-chunk) and transformed
// (pipeline_feedback) branches, selected purely by the manifest's own `transformed` flag.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiFetch, type ApiContext } from "../../src/http.ts";
import { CapabilityStore } from "../../src/capability.ts";
import { WorkspaceIndex } from "../../src/registry/workspace-index.ts";
import { SessionRegistry } from "../../src/registry/session-registry.ts";
import { WorkspaceBusRegistry } from "../../src/bus/workspace-bus-registry.ts";
import { canonicalize } from "../../src/registry/slug.ts";
import { AdapterRegistry } from "../../src/adapters/interface.ts";
import { sourceSha256 } from "../../src/artifact-render.ts";
import { createFixtureAdapter, FIXTURE_MARKER_FILE } from "../fixtures/adapter/fixture-adapter.ts";

const TOKEN = "fixture-adapter-test-token-0123456789";
const PORT = 4646;

// Chosen so it round-trips exactly through `normalizeSource` (no \r\n) and its own chunk (the
// whole document) hashes identically for both the doc-level and chunk-level freshness checks
// anchoring.ts's Class-F cascade requires (A5 §F10).
const SOURCE_CONTENT = "# Title\n\nHello fixture world.\n";
const SOURCE_LINES = SOURCE_CONTENT.split("\n");
const LAST_LINE = SOURCE_LINES.length - 1;
const SOURCE_HASH = sourceSha256(Buffer.from(SOURCE_CONTENT, "utf8"));

describe("neutral fixture adapter (P6.1 acceptance)", () => {
  let home: string;
  let root: string;
  let workspaceIndex: WorkspaceIndex;
  let sessionRegistry: SessionRegistry;
  let busRegistry: WorkspaceBusRegistry;
  let ctx: ApiContext;
  let fetchFn: (req: Request) => Promise<Response>;
  let slug: string;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "glosa-fixture-adapter-home-"));
    root = canonicalize(mkdtempSync(join(tmpdir(), "glosa-fixture-adapter-ws-")));
    writeFileSync(join(root, FIXTURE_MARKER_FILE), "");
    writeFileSync(join(root, "source.md"), SOURCE_CONTENT);
    writeFileSync(join(root, "rendered.html"), "<p>Hello fixture world.</p>");

    workspaceIndex = new WorkspaceIndex({ home });
    sessionRegistry = new SessionRegistry({ index: workspaceIndex });
    busRegistry = new WorkspaceBusRegistry();
    workspaceIndex.setLiveSessionPredicate((p) => sessionRegistry.forWorkspace(p).length > 0);
    workspaceIndex.setOnHardRemove((p) => busRegistry.evict(p));

    const entry = await workspaceIndex.upsertWorkspace(root, "glosa-open");
    slug = entry.slug;

    const adapterRegistry = new AdapterRegistry();
    adapterRegistry.register(createFixtureAdapter({ roots: [root] }));

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
      adapterRegistry,
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

  function writeManifest(transformed: boolean): void {
    writeFileSync(
      join(root, "manifest.json"),
      JSON.stringify({
        manifest_version: 1,
        source_path: "source.md",
        source_sha256: SOURCE_HASH,
        chunks: [{ chunk_id: "chunk-1", source_start_line: 0, source_end_line: LAST_LINE, source_sha256: SOURCE_HASH, transformed }],
      }),
    );
  }

  test("recognizes(): a workspace with no marker file is NOT recognized, even with matching content", async () => {
    const bareRoot = canonicalize(mkdtempSync(join(tmpdir(), "glosa-fixture-bare-ws-")));
    writeFileSync(join(bareRoot, "rendered.html"), "<p>hi</p>");
    const bareEntry = await workspaceIndex.upsertWorkspace(bareRoot, "glosa-open");
    const res = await fetchFn(req(`/w/${bareEntry.slug}/artifacts/rendered.html`));
    const body = await res.json();
    expect(Object.hasOwn(body, "derived_from")).toBe(false); // no adapter recognized this root
    rmSync(bareRoot, { recursive: true, force: true });
  });

  test("derived-from edge: class-F artifact response carries derived_from, matching viewer.js's expected shape (a plain source path)", async () => {
    const res = await fetchFn(req(`/w/${slug}/artifacts/rendered.html`));
    const body = await res.json();
    expect(body.derived_from).toBe("source.md");
    expect(body.class).toBe("F");
  });

  test("staleness: source.md newer than rendered.html's own mtime -> rendered.html is stale", async () => {
    const past = new Date(Date.now() - 60_000);
    const future = new Date();
    utimesSync(join(root, "rendered.html"), past, past);
    utimesSync(join(root, "source.md"), future, future);

    const res = await fetchFn(req(`/w/${slug}/artifacts`));
    const body = await res.json();
    expect(body.find((a: { path: string }) => a.path === "rendered.html").stale).toBe(true);
    expect(body.find((a: { path: string }) => a.path === "source.md").stale).toBe(false);
  });

  test("staleness: source.md OLDER than rendered.html -> not stale", async () => {
    const past = new Date(Date.now() - 60_000);
    const now = new Date();
    utimesSync(join(root, "source.md"), past, past);
    utimesSync(join(root, "rendered.html"), now, now);

    const res = await fetchFn(req(`/w/${slug}/artifacts`));
    const body = await res.json();
    expect(body.find((a: { path: string }) => a.path === "rendered.html").stale).toBe(false);
  });

  test("sidebarOrder: the fixture's 'rendered preview sorts last' rule is honored", async () => {
    const res = await fetchFn(req(`/w/${slug}/artifacts`));
    const body = await res.json();
    expect(body.map((a: { path: string }) => a.path)).toEqual(["source.md", "rendered.html"]);
  });

  test("manifest resolution: no manifest.json on disk yet -> manifest_path absent", async () => {
    const res = await fetchFn(req(`/w/${slug}/artifacts/rendered.html`));
    const body = await res.json();
    expect(Object.hasOwn(body, "manifest_path")).toBe(false);
  });

  test("manifest resolution: manifest.json present -> manifest_path surfaced in the artifact response", async () => {
    writeManifest(false);
    const res = await fetchFn(req(`/w/${slug}/artifacts/rendered.html`));
    const body = await res.json();
    expect(body.manifest_path).toBe("manifest.json");
  });

  test("class-F annotation resolution, verbatim (transformed:false): quote found in the manuscript -> source_range against source.md", async () => {
    writeManifest(false);
    const res = await fetchFn(
      stateChangingReq(`/w/${slug}/annotations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body: "tighten this",
          intent: "content",
          target: { chunk_id: "chunk-1", quote: { exact: "Hello fixture world.", prefix: "", suffix: "" } },
          artifact_path: "rendered.html",
        }),
      }),
    );
    expect(res.status).toBe(201);
    const parsed = await res.json();
    expect(parsed.resolution.kind).toBe("source_range");
    expect(parsed.resolution.path).toBe("source.md"); // resolves into the MANUSCRIPT, not the html
    expect(parsed.resolution.matched_quote).toBe("Hello fixture world.");
  });

  test("class-F annotation resolution, verbatim (transformed:false) with NO matching quote -> orphaned{quote_absent_not_transformed}, intent does not rescue it", async () => {
    writeManifest(false);
    const res = await fetchFn(
      stateChangingReq(`/w/${slug}/annotations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body: "note",
          intent: "content",
          target: { chunk_id: "chunk-1", quote: { exact: "text that is not in the source", prefix: "", suffix: "" } },
          artifact_path: "rendered.html",
        }),
      }),
    );
    const parsed = await res.json();
    expect(parsed.resolution).toEqual({ kind: "orphaned", reason: "quote_absent_not_transformed" });
  });

  test("class-F annotation resolution, transformed:true -> pipeline_feedback routed to THIS adapter's id + the manifest's declared component, no search attempted", async () => {
    writeManifest(true);
    const res = await fetchFn(
      stateChangingReq(`/w/${slug}/annotations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body: "this should be a different chunk type",
          intent: "classification",
          target: { chunk_id: "chunk-1", quote: { exact: "text nowhere in the source at all", prefix: "", suffix: "" } },
          artifact_path: "rendered.html",
        }),
      }),
    );
    expect(res.status).toBe(201);
    const parsed = await res.json();
    expect(parsed.resolution).toEqual({
      kind: "pipeline_feedback",
      target: { adapter: "fixture", component: "fixture-renderer", chunk_id: "chunk-1", source_line_range: [0, LAST_LINE] },
      intent: "classification",
      body: "this should be a different chunk type",
    });
  });
});

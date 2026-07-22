// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterRegistry } from "../../src/adapters/interface.ts";
import { WorkspaceMetadataRegistry } from "../../src/adapters/workspace-metadata.ts";
import { sourceSha256 } from "../../src/artifact-render.ts";
import { WorkspaceBusRegistry } from "../../src/bus/workspace-bus-registry.ts";
import { CapabilityStore } from "../../src/capability.ts";
import { createApiFetch, type ApiContext } from "../../src/http.ts";
import { SessionRegistry } from "../../src/registry/session-registry.ts";
import { canonicalize } from "../../src/registry/slug.ts";
import { WorkspaceIndex } from "../../src/registry/workspace-index.ts";

const TOKEN = "metadata-routes-token-0123456789";
const PORT = 4646;
const SOURCE = "# Title\n\nExact source words.\n";
const HASH = sourceSha256(Buffer.from(SOURCE));

describe("declarative metadata adapter — HTTP hydration and class-F resolution", () => {
  let home: string;
  let root: string;
  let slug: string;
  let buses: WorkspaceBusRegistry;
  let fetchFn: (request: Request) => Promise<Response>;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "glosa-metadata-route-home-"));
    root = canonicalize(mkdtempSync(join(tmpdir(), "glosa-metadata-route-ws-")));
    writeFileSync(join(root, "source.md"), SOURCE);
    writeFileSync(join(root, "rendered.html"), '<p data-chunk="chunk-1">Exact source words.</p>');
    writeManifest(false);

    const index = new WorkspaceIndex({ home });
    const sessions = new SessionRegistry({ index });
    buses = new WorkspaceBusRegistry();
    const metadata = new WorkspaceMetadataRegistry();
    const adapters = new AdapterRegistry();
    adapters.register(metadata.adapter());
    slug = (await index.upsertWorkspace(root, "glosa-open")).slug;
    await metadata.set(root, {
      version: 1,
      id: "external-renderer",
      artifacts: [
        { path: "source.md", class: "R", order: 0 },
        {
          path: "rendered.html",
          class: "F",
          order: 1,
          derived_from: { path: "source.md", via: "render" },
          manifest: { path: "manifest.json", component: "preview" },
        },
      ],
    });
    const ctx: ApiContext = {
      port: PORT,
      classFPort: PORT + 1,
      token: TOKEN,
      instanceId: "metadata-test",
      startedAt: new Date().toISOString(),
      workspaceIndex: index,
      sessionRegistry: sessions,
      getWorkspaceBus: (path) => buses.get(path),
      capabilityStore: new CapabilityStore(),
      adapterRegistry: adapters,
      metadataRegistry: metadata,
    };
    fetchFn = createApiFetch(ctx);
  });

  afterEach(async () => {
    await buses.close(root);
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  function writeManifest(transformed: boolean) {
    writeFileSync(join(root, "manifest.json"), JSON.stringify({
      manifest_version: 1,
      source_path: "source.md",
      source_sha256: HASH,
      chunks: [{ chunk_id: "chunk-1", source_start_line: 0, source_end_line: 3, source_sha256: HASH, transformed }],
    }));
  }

  function request(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("Host", `127.0.0.1:${PORT}`);
    headers.set("Authorization", `Bearer ${TOKEN}`);
    if (init.method === "POST") headers.set("Origin", `http://127.0.0.1:${PORT}`);
    return new Request(`http://127.0.0.1:${PORT}${path}`, { ...init, headers });
  }

  function annotation() {
    return {
      body: "Please revise",
      intent: "content",
      target: { chunk_id: "chunk-1", quote: { exact: "Exact source words.", prefix: "", suffix: "" } },
      artifact_path: "rendered.html",
    };
  }

  test("artifact responses derive class, source, order, and manifest only through metadata", async () => {
    expect((await (await fetchFn(request(`/w/${slug}/artifacts`))).json()).map((item: { path: string }) => item.path)).toEqual(["source.md", "rendered.html"]);
    expect(await (await fetchFn(request(`/w/${slug}/artifacts/rendered.html`))).json()).toMatchObject({
      class: "F",
      derived_from: "source.md",
      manifest_path: "manifest.json",
    });
  });

  test("verbatim and transformed chunks resolve to source range and descriptor-owned pipeline feedback", async () => {
    const verbatim = await fetchFn(request(`/w/${slug}/annotations`, { method: "POST", body: JSON.stringify(annotation()) }));
    expect((await verbatim.json()).resolution).toMatchObject({ kind: "source_range", path: "source.md" });

    writeManifest(true);
    const transformed = await fetchFn(request(`/w/${slug}/annotations`, { method: "POST", body: JSON.stringify(annotation()) }));
    expect((await transformed.json()).resolution).toEqual({
      kind: "pipeline_feedback",
      target: { adapter: "external-renderer", component: "preview", chunk_id: "chunk-1", source_line_range: [0, 3] },
      intent: "content",
      body: "Please revise",
    });
  });
});

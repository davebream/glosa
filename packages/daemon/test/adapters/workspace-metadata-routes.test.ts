// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterRegistry } from "../../src/adapters/interface.ts";
import { WorkspaceMetadataRegistry } from "../../src/adapters/workspace-metadata.ts";
import { annotationClaimPaths } from "../../src/services/artifact.ts";
import { runGit } from "../../src/git/shadow.ts";
import { sourceSha256 } from "../../src/artifact-render.ts";
import { WorkspaceBusRegistry } from "../../src/bus/workspace-bus-registry.ts";
import { SessionRegistry } from "../../src/registry/session-registry.ts";
import { canonicalize } from "../../src/registry/slug.ts";
import { WorkspaceIndex } from "../../src/registry/workspace-index.ts";
import { CapabilityStore } from "../../src/security/capability.ts";
import { type ApiContext, createApiFetch } from "../../src/transport/http.ts";

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
    const metadata = new WorkspaceMetadataRegistry();
    const adapters = new AdapterRegistry();
    adapters.register(metadata.adapter());
    buses = new WorkspaceBusRegistry({
      entrySourcePaths: (workspace, payload) => annotationClaimPaths({ adapterRegistry: adapters }, workspace, payload),
    });
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
          manifest: { path: "manifest.json", component: "read" },
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
    writeFileSync(
      join(root, "manifest.json"),
      JSON.stringify({
        manifest_version: 1,
        source_path: "source.md",
        source_sha256: HASH,
        chunks: [{ chunk_id: "chunk-1", source_start_line: 0, source_end_line: 3, source_sha256: HASH, transformed }],
      }),
    );
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
    expect(
      (await (await fetchFn(request(`/w/${slug}/artifacts`))).json()).map((item: { path: string }) => item.path),
    ).toEqual(["source.md", "rendered.html"]);
    expect(await (await fetchFn(request(`/w/${slug}/artifacts/rendered.html`))).json()).toMatchObject({
      class: "F",
      derived_from: "source.md",
      manifest_path: "manifest.json",
    });
  });

  test("a class-F entry claim protects its resolved source from watcher capture and credits the source edit", async () => {
    const created = await (
      await fetchFn(request(`/w/${slug}/annotations`, { method: "POST", body: JSON.stringify(annotation()) }))
    ).json();
    const claimResponse = await fetchFn(
      request("/api/workspaces/claims", {
        method: "POST",
        body: JSON.stringify({ path: root, resources: [`entry:${created.id}`], session: "source-writer" }),
      }),
    );
    expect(claimResponse.status).toBe(201);
    const claim = await claimResponse.json();
    const preSha = (await runGit(root, ["rev-parse", "HEAD"])).stdout.trim();
    expect(claim.paths).toEqual(["rendered.html", "source.md"]);
    const competing = await fetchFn(
      request("/api/workspaces/claims", {
        method: "POST",
        body: JSON.stringify({ path: root, resources: ["artifact:source.md"], session: "other-writer" }),
      }),
    );
    expect(competing.status).toBe(409);
    expect((await competing.json()).holder_session).toBe("source-writer");
    writeFileSync(join(root, "source.md"), SOURCE.replace("Exact source words.", "Revised source words."));
    const bus = buses.get(root);
    await bus.captureExternalEdit();
    // Reclaiming renews the recorded scope even though the original quote no longer resolves.
    expect((await bus.claim([`entry:${created.id}`], "exclusive", "source-writer", "unknown")).paths).toEqual(
      claim.paths,
    );
    const resolved = await fetchFn(
      request("/api/workspaces/resolve", {
        method: "POST",
        body: JSON.stringify({ path: root, entry: created.id, outcome: "applied", session: "source-writer" }),
      }),
    );
    expect(resolved.status).toBe(200);
    const result = await resolved.json();
    expect((await runGit(root, ["show", "-s", "--format=%B", result.post_sha])).stdout).toContain(
      "Glosa-Attribution: session:source-writer",
    );
    expect((await runGit(root, ["diff", preSha, result.post_sha, "--", "source.md"])).stdout).toContain(
      "+Revised source words.",
    );
    expect(
      Object.keys(bus.state.entries)
        .map((id) => bus.readEntry(id)?.payload)
        .filter((p: any) => p?.kind === "external_edit"),
    ).toEqual([]);
    await bus.reconcile();
    expect(bus.state.entries[created.id]?.appliedInterval).toMatchObject({
      by: "session:source-writer",
      paths: ["rendered.html", "source.md"],
    });
  });

  test("claims do not invent source coverage for transformed or unresolved class-F notes or enlarge on renewal", async () => {
    writeManifest(true);
    for (const [id, target] of [
      ["transformed", annotation().target],
      ["missing", { chunk_id: "missing", quote: { exact: "Unknown" } }],
    ] as const) {
      const bus = buses.get(root);
      await bus.reconcileOnce();
      await bus.createEntry(id, { kind: "annotation", ...annotation(), target });
      const held = await bus.claim([`entry:${id}`], "exclusive", "writer", "unknown");
      expect(held.paths).toEqual(["rendered.html"]);
      if (id === "transformed") {
        writeManifest(false);
        // A source mapping that appears later belongs only to the next claim's interval.
        expect((await bus.claim([`entry:${id}`], "exclusive", "writer", "unknown")).paths).toEqual(held.paths);
        await bus.release(held.claimId, "session", "writer");
        const next = await bus.claim([`entry:${id}`], "exclusive", "writer", "unknown");
        expect(next.paths).toEqual(["rendered.html", "source.md"]);
        await bus.release(next.claimId, "session", "writer");
        writeManifest(true);
      } else await bus.release(held.claimId, "session", "writer");
    }
  });

  test("HTTP rejection without a claim omits attribution identifiers on the decision and its replay", async () => {
    const note = await (
      await fetchFn(request(`/w/${slug}/annotations`, { method: "POST", body: JSON.stringify(annotation()) }))
    ).json();
    const reject = () =>
      fetchFn(
        request("/api/workspaces/resolve", {
          method: "POST",
          body: JSON.stringify({ path: root, entry: note.id, outcome: "rejected", session: "decider" }),
        }),
      );
    const first = await reject();
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ entry: note.id, status: "rejected", to: "rejected" });
    expect(await (await reject()).json()).toEqual({
      entry: note.id,
      status: "rejected",
      to: "rejected",
      replayed: true,
    });
  });

  test("listed class-F resolutions follow the current source instead of a saved verdict", async () => {
    await fetchFn(request(`/w/${slug}/annotations`, { method: "POST", body: JSON.stringify(annotation()) }));
    const listing = async () =>
      (await (await fetchFn(request(`/w/${slug}/annotations?artifact=rendered.html`))).json()).annotations;
    expect((await listing())[0].resolution).toMatchObject({ kind: "source_range", path: "source.md" });
    writeFileSync(join(root, "source.md"), "# Title\n\nA different passage.\n");
    expect((await listing())[0].resolution.kind).toBe("orphaned");
  });

  test("verbatim and transformed chunks resolve to source range and descriptor-owned pipeline feedback", async () => {
    const verbatim = await fetchFn(
      request(`/w/${slug}/annotations`, { method: "POST", body: JSON.stringify(annotation()) }),
    );
    expect((await verbatim.json()).resolution).toMatchObject({ kind: "source_range", path: "source.md" });

    writeManifest(true);
    const transformed = await fetchFn(
      request(`/w/${slug}/annotations`, { method: "POST", body: JSON.stringify(annotation()) }),
    );
    expect((await transformed.json()).resolution).toEqual({
      kind: "pipeline_feedback",
      target: { adapter: "external-renderer", component: "read", chunk_id: "chunk-1", source_line_range: [0, 3] },
      intent: "content",
      body: "Please revise",
    });
  });
});

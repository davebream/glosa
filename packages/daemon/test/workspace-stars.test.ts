// SPDX-License-Identifier: Apache-2.0
// Starred workspaces (contract 1.11, A1 §5.21, A3 §4 "Starred workspaces"): the store itself, and
// the four routes through the real `createApiFetch` pipeline over a real index and bus registry.
// The security property under test is that no request can make the daemon open a path it did not
// record from an existing registration.
import { describe, expect, test } from "bun:test";
import { timedHooks } from "../../../test/phase-timing.ts";
const { beforeEach, afterEach } = timedHooks("packages/daemon/test/workspace-stars.test.ts");
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceBusRegistry } from "../src/bus/workspace-bus-registry.ts";
import { SessionRegistry } from "../src/registry/session-registry.ts";
import { canonicalize } from "../src/registry/slug.ts";
import { WorkspaceIndex } from "../src/registry/workspace-index.ts";
import { starIdFor, starsPath, WorkspaceStars } from "../src/registry/workspace-stars.ts";
import { CapabilityStore } from "../src/security/capability.ts";
import { type ApiContext, createApiFetch } from "../src/transport/http.ts";

const TOKEN = "stars-test-token-0123456789abcdef";
const PORT = 4747;

describe("WorkspaceStars store", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "glosa-stars-home-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("starring is idempotent, persisted 0600, and survives a new instance", async () => {
    const stars = new WorkspaceStars({ home });
    const first = await stars.add("/Users/example/code/zeta");
    const again = await stars.add("/Users/example/code/zeta");
    expect(again).toEqual(first);
    expect(first.id).toBe(starIdFor("/Users/example/code/zeta"));
    expect(statSync(starsPath(home)).mode & 0o777).toBe(0o600);

    const reread = new WorkspaceStars({ home });
    expect(reread.list()).toEqual([first]);
  });

  test("lists alphabetically by folder name and removes by id", async () => {
    const stars = new WorkspaceStars({ home });
    await stars.add("/a/zeta");
    const alpha = await stars.add("/z/alpha");
    await stars.add("/m/Beta");
    expect(stars.list().map((s) => s.path)).toEqual(["/z/alpha", "/m/Beta", "/a/zeta"]);

    expect(await stars.remove(alpha.id)).toBe(true);
    expect(await stars.remove(alpha.id)).toBe(false);
    expect(new WorkspaceStars({ home }).list().map((s) => s.path)).toEqual(["/m/Beta", "/a/zeta"]);
  });

  test("a row whose id does not match its path is dropped, so a hand-edited file cannot alias a path", async () => {
    writeFileSync(
      starsPath(home),
      JSON.stringify({
        version: 1,
        stars: [
          { id: starIdFor("/ok"), path: "/ok", starred_at: "2026-09-17T00:00:00.000Z" },
          { id: starIdFor("/ok"), path: "/etc", starred_at: "2026-09-17T00:00:00.000Z" },
        ],
      }),
    );
    expect(new WorkspaceStars({ home }).list().map((s) => s.path)).toEqual(["/ok"]);
  });

  test("a corrupt file is moved aside instead of being overwritten", async () => {
    writeFileSync(starsPath(home), "{not json");
    const stars = new WorkspaceStars({ home });
    expect(stars.list()).toEqual([]);
    expect(readdirSync(home).some((name) => name.startsWith("stars.json.corrupt."))).toBe(true);
    await stars.add("/after");
    expect(new WorkspaceStars({ home }).list().map((s) => s.path)).toEqual(["/after"]);
  });
});

describe("star routes (A1 §5.21)", () => {
  let home: string;
  let userHome: string;
  let root: string;
  let workspaceIndex: WorkspaceIndex;
  let busRegistry: WorkspaceBusRegistry;
  let fetchFn: (req: Request) => Promise<Response>;
  let slug: string;
  const cleanup: string[] = [];

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "glosa-stars-routes-home-"));
    userHome = canonicalize(mkdtempSync(join(tmpdir(), "glosa-stars-userhome-")));
    root = canonicalize(mkdtempSync(join(tmpdir(), "glosa-stars-ws-")));
    workspaceIndex = new WorkspaceIndex({ home, userHomeDir: userHome });
    const sessionRegistry = new SessionRegistry({ index: workspaceIndex });
    busRegistry = new WorkspaceBusRegistry();
    workspaceIndex.setLiveSessionPredicate((p) => sessionRegistry.forWorkspace(p).length > 0);
    workspaceIndex.setOnHardRemove((p) => busRegistry.evict(p));
    slug = (await workspaceIndex.upsertWorkspace(root, "glosa-open")).slug;
    const ctx: ApiContext = {
      port: PORT,
      classFPort: PORT + 1,
      token: TOKEN,
      instanceId: "gl-stars-test",
      startedAt: new Date().toISOString(),
      workspaceIndex,
      sessionRegistry,
      getWorkspaceBus: (r) => busRegistry.get(r),
      capabilityStore: new CapabilityStore(),
      home,
    };
    fetchFn = createApiFetch(ctx);
  });

  afterEach(async () => {
    await busRegistry.close(root);
    for (const path of [home, userHome, root, ...cleanup.splice(0)]) rmSync(path, { recursive: true, force: true });
  });

  function req(path: string, init: RequestInit = {}): Request {
    const headers = new Headers(init.headers);
    headers.set("Host", `127.0.0.1:${PORT}`);
    headers.set("Authorization", `Bearer ${TOKEN}`);
    return new Request(`http://127.0.0.1:${PORT}${path}`, { ...init, headers });
  }
  function post(path: string, body?: unknown, { origin = true } = {}): Request {
    return req(path, {
      method: "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      headers: origin ? { Origin: `http://127.0.0.1:${PORT}` } : {},
    });
  }
  const listStars = async () => (await fetchFn(req("/api/stars"))).json();
  const recordedPaths = () =>
    existsSync(starsPath(home))
      ? JSON.parse(readFileSync(starsPath(home), "utf8")).stars.map((s: { path: string }) => s.path)
      : [];

  test("GET /api/workspaces rows carry kind", async () => {
    const rows = await (await fetchFn(req("/api/workspaces"))).json();
    expect(rows).toEqual([expect.objectContaining({ slug, kind: "directory" })]);
  });

  test("starring a present directory records the registration's own path and lists it open", async () => {
    const res = await fetchFn(post("/api/stars", { slug }));
    expect(res.status).toBe(200);
    const star = await res.json();
    expect(star).toMatchObject({ id: starIdFor(root), path: root, state: "open", slug, has_attention: false });
    expect(recordedPaths()).toEqual([root]);
    expect(await listStars()).toEqual([star]);
  });

  test("no route records or opens a path the request supplies", async () => {
    const elsewhere = canonicalize(mkdtempSync(join(tmpdir(), "glosa-stars-elsewhere-")));
    cleanup.push(elsewhere);

    const byPath = await fetchFn(post("/api/stars", { path: elsewhere }));
    expect(byPath.status).toBe(400);
    const both = await fetchFn(post("/api/stars", { slug: "no-such-workspace", path: elsewhere }));
    expect(both.status).toBe(404);
    expect(recordedPaths()).toEqual([]);

    const unrecorded = await fetchFn(post(`/api/stars/${starIdFor(elsewhere)}/open`, { path: elsewhere }));
    expect(unrecorded.status).toBe(404);
    expect(workspaceIndex.get(elsewhere)).toBeNull();
  });

  test("state-changing star routes require a same Origin", async () => {
    expect((await fetchFn(post("/api/stars", { slug }, { origin: false }))).status).toBe(403);
    expect(recordedPaths()).toEqual([]);
  });

  test("a loose-file registration cannot be starred", async () => {
    const looseRoot = mkdtempSync(join(tmpdir(), "glosa-stars-loose-"));
    cleanup.push(looseRoot);
    writeFileSync(join(looseRoot, "note.md"), "note\n");
    const opened = await (await fetchFn(post("/api/workspaces/open", { path: join(looseRoot, "note.md") }))).json();
    expect(workspaceIndex.getBySlug(opened.slug)?.kind).toBe("loose-file");

    const res = await fetchFn(post("/api/stars", { slug: opened.slug }));
    expect(res.status).toBe(422);
    expect((await res.json()).type).toBe("https://glosa.local/errors/star-not-directory");
    expect(recordedPaths()).toEqual([]);
  });

  test("a star outlives its registration and reopens it by id", async () => {
    const star = await await fetchFn(post("/api/stars", { slug })).then((r) => r.json());
    await busRegistry.close(root);
    expect(await workspaceIndex.forget(slug)).toBe(true);
    expect(await listStars()).toEqual([expect.objectContaining({ id: star.id, state: "closed" })]);
    expect((await listStars())[0].slug).toBeUndefined();

    const res = await fetchFn(post(`/api/stars/${star.id}/open`));
    expect(res.status).toBe(200);
    const opened = await res.json();
    expect(opened).toMatchObject({ path: root, kind: "directory" });
    expect(await listStars()).toEqual([expect.objectContaining({ state: "open", slug: opened.slug })]);
  });

  test("reopening a star whose folder is gone is refused before the index is touched", async () => {
    const doomed = canonicalize(mkdtempSync(join(tmpdir(), "glosa-stars-doomed-")));
    cleanup.push(doomed);
    const doomedSlug = (await workspaceIndex.upsertWorkspace(doomed, "glosa-open")).slug;
    const star = await (await fetchFn(post("/api/stars", { slug: doomedSlug }))).json();
    await workspaceIndex.forget(doomedSlug);
    rmSync(doomed, { recursive: true, force: true });

    expect(await listStars()).toEqual([expect.objectContaining({ id: star.id, state: "missing" })]);
    const res = await fetchFn(post(`/api/stars/${star.id}/open`));
    expect(res.status).toBe(422);
    expect((await res.json()).type).toBe("https://glosa.local/errors/star-folder-missing");
    expect(workspaceIndex.get(doomed)).toBeNull();

    // A folder replaced by a file is not a directory either.
    writeFileSync(doomed, "not a folder");
    expect((await fetchFn(post(`/api/stars/${star.id}/open`))).status).toBe(422);
    rmSync(doomed, { force: true });
    mkdirSync(doomed);
    expect((await listStars())[0].state).toBe("closed");
  });

  test("a registration GC has marked absent cannot be starred", async () => {
    const gone = canonicalize(mkdtempSync(join(tmpdir(), "glosa-stars-gone-")));
    cleanup.push(gone);
    const goneSlug = (await workspaceIndex.upsertWorkspace(gone, "glosa-open")).slug;
    rmSync(gone, { recursive: true, force: true });
    await workspaceIndex.gc();
    expect(workspaceIndex.getBySlug(goneSlug)?.present).toBe(false);

    expect((await fetchFn(post("/api/stars", { slug: goneSlug }))).status).toBe(404);
    expect(recordedPaths()).toEqual([]);
  });

  test("unstar removes the star once", async () => {
    const star = await (await fetchFn(post("/api/stars", { slug }))).json();
    expect((await fetchFn(post(`/api/stars/${star.id}/unstar`))).status).toBe(204);
    expect((await fetchFn(post(`/api/stars/${star.id}/unstar`))).status).toBe(404);
    expect(await listStars()).toEqual([]);
  });
});

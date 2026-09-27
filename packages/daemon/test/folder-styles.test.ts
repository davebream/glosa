// SPDX-License-Identifier: Apache-2.0
// A folder's default style (#407, contract 1.21, A1 §5.23, A3 §4 "Folder default style"): the store
// itself, the three routes through the real `createApiFetch` pipeline on a real loopback server,
// and one real `glosa __daemon` restart. What is under test: the default is kept under the folder's
// own canonical path, taken from the registration the slug names and never from the request; it
// survives the index forgetting the folder and the daemon restarting; changing it needs the page's
// own Origin; and every window's stream on that folder hears that it changed.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceBusRegistry } from "../src/bus/workspace-bus-registry.ts";
import { FolderStyles, folderStylesPath } from "../src/registry/folder-styles.ts";
import { SessionRegistry } from "../src/registry/session-registry.ts";
import { canonicalize } from "../src/registry/slug.ts";
import { WorkspaceIndex } from "../src/registry/workspace-index.ts";
import { CapabilityStore } from "../src/security/capability.ts";
import { tokenPath } from "../src/security/token.ts";
import { type ApiContext, createApiFetch } from "../src/transport/http.ts";
import { type ParsedSseEvent, parseSseStream } from "../src/transport/sse.ts";
import { cleanupHome, freshHome, randomPort, spawnDaemon, stopDaemon, waitForHandshake } from "./helpers.ts";

const TOKEN = "folder-styles-token-0123456789abcdef";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDir(prefix: string): string {
  const dir = canonicalize(mkdtempSync(join(tmpdir(), prefix)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("FolderStyles store", () => {
  test("a default is set, read and cleared by canonical path, persisted 0600, and read back by a new instance", async () => {
    const home = tempDir("glosa-folder-styles-home-");
    const styles = new FolderStyles({ home });
    expect(styles.get("/Users/example/specs")).toBeNull();
    expect(await styles.set("/Users/example/specs", "spec")).toBe("spec");
    expect(await styles.set("/Users/example/notes", "mono")).toBe("mono");
    expect(statSync(folderStylesPath(home)).mode & 0o777).toBe(0o600);
    expect(new FolderStyles({ home }).get("/Users/example/specs")).toBe("spec");

    expect(await styles.clear("/Users/example/specs")).toBe(true);
    expect(await styles.clear("/Users/example/specs")).toBe(false);
    const reread = new FolderStyles({ home });
    expect(reread.get("/Users/example/specs")).toBeNull();
    expect(reread.get("/Users/example/notes")).toBe("mono");
  });

  test("listeners hear a change to their folder only, and not a set that changes nothing", async () => {
    const styles = new FolderStyles({ home: tempDir("glosa-folder-styles-home-") });
    const heard: string[] = [];
    styles.subscribe("/a", () => heard.push("a"));
    const stop = styles.subscribe("/b", () => heard.push("b"));
    await styles.set("/a", "spec");
    await styles.set("/a", "spec");
    await styles.set("/b", "mono");
    stop();
    await styles.clear("/b");
    await styles.clear("/a");
    expect(heard).toEqual(["a", "b", "a"]);
  });

  test("a malformed row costs that row, and a corrupt file is moved aside instead of overwritten", async () => {
    const home = tempDir("glosa-folder-styles-home-");
    writeFileSync(
      folderStylesPath(home),
      JSON.stringify({
        version: 1,
        folders: [
          { path: "/ok", style: "spec", set_at: "2026-09-27T00:00:00.000Z" },
          { path: "/bad", style: "gothic", set_at: "2026-09-27T00:00:00.000Z" },
          { path: "relative", style: "mono", set_at: "2026-09-27T00:00:00.000Z" },
        ],
      }),
    );
    const styles = new FolderStyles({ home });
    expect([styles.get("/ok"), styles.get("/bad"), styles.get("relative")]).toEqual(["spec", null, null]);

    const damaged = tempDir("glosa-folder-styles-home-");
    writeFileSync(folderStylesPath(damaged), "{not json");
    const fresh = new FolderStyles({ home: damaged });
    expect(fresh.get("/ok")).toBeNull();
    expect(readdirSync(damaged).some((name) => name.startsWith("folder-styles.json.corrupt."))).toBe(true);
    await fresh.set("/after", "mono");
    expect(new FolderStyles({ home: damaged }).get("/after")).toBe("mono");
  });
});

describe("folder-style routes (A1 §5.23)", () => {
  interface Harness {
    port: number;
    home: string;
    root: string;
    slug: string;
    workspaceIndex: WorkspaceIndex;
    busRegistry: WorkspaceBusRegistry;
    stop: () => Promise<void>;
  }

  /** The daemon's API over a real loopback server: a fresh index, bus registry and folder-style
   * store each time, so building it twice on one home is the in-process half of a restart. */
  async function serve(home: string, root: string, port = randomPort()): Promise<Harness> {
    const workspaceIndex = new WorkspaceIndex({ home });
    const sessionRegistry = new SessionRegistry({ index: workspaceIndex });
    const busRegistry = new WorkspaceBusRegistry();
    workspaceIndex.setLiveSessionPredicate((p) => sessionRegistry.forWorkspace(p).length > 0);
    workspaceIndex.setOnHardRemove((p) => busRegistry.evict(p));
    const slug = (await workspaceIndex.upsertWorkspace(root, "glosa-open")).slug;
    const ctx: ApiContext = {
      port,
      classFPort: port + 1,
      token: TOKEN,
      instanceId: "gl-folder-styles-test",
      startedAt: new Date().toISOString(),
      workspaceIndex,
      sessionRegistry,
      getWorkspaceBus: (r) => busRegistry.get(r),
      capabilityStore: new CapabilityStore(),
      home,
    };
    const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: createApiFetch(ctx) });
    let stopped = false;
    const stop = async () => {
      if (stopped) return;
      stopped = true;
      await server.stop(true);
      await busRegistry.closeAll();
    };
    cleanups.push(stop);
    if (!(await waitForHandshake(port))) throw new Error(`folder-style test server did not answer on ${port}`);
    return { port, home, root, slug, workspaceIndex, busRegistry, stop };
  }

  function call(
    h: { port: number },
    method: string,
    path: string,
    { body, origin = `http://127.0.0.1:${h.port}` }: { body?: unknown; origin?: string | null } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}` };
    if (origin !== null) headers.Origin = origin;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return fetch(`http://127.0.0.1:${h.port}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
  }

  const read = async (h: { port: number }, slug: string) => (await call(h, "GET", `/w/${slug}/folder-style`)).json();
  const recorded = (home: string) => {
    try {
      return JSON.parse(readFileSync(folderStylesPath(home), "utf8")).folders.map(
        (row: { path: string; style: string }) => [row.path, row.style],
      );
    } catch {
      return [];
    }
  };

  test("set, read and clear: the default is kept under the registration's own canonical path", async () => {
    const h = await serve(tempDir("glosa-fs-home-"), tempDir("glosa-fs-ws-"));
    expect(await read(h, h.slug)).toEqual({ style: null });

    const set = await call(h, "PUT", `/w/${h.slug}/folder-style`, { body: { style: "spec" } });
    expect(set.status).toBe(200);
    expect(await set.json()).toEqual({ style: "spec" });
    expect(await read(h, h.slug)).toEqual({ style: "spec" });
    expect(recorded(h.home)).toEqual([[h.root, "spec"]]);
    expect(statSync(folderStylesPath(h.home)).mode & 0o777).toBe(0o600);

    const cleared = await call(h, "DELETE", `/w/${h.slug}/folder-style`);
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ style: null });
    expect(await read(h, h.slug)).toEqual({ style: null });
    expect((await call(h, "DELETE", `/w/${h.slug}/folder-style`)).status).toBe(200);
    expect(recorded(h.home)).toEqual([]);
  });

  test("a request never names a path: a body path is ignored, and an unknown slug is 404", async () => {
    const h = await serve(tempDir("glosa-fs-home-"), tempDir("glosa-fs-ws-"));
    const elsewhere = tempDir("glosa-fs-elsewhere-");
    const res = await call(h, "PUT", `/w/${h.slug}/folder-style`, { body: { style: "mono", path: elsewhere } });
    expect(res.status).toBe(200);
    expect(recorded(h.home)).toEqual([[h.root, "mono"]]);

    for (const [method, body] of [
      ["GET", undefined],
      ["PUT", { style: "spec" }],
      ["DELETE", undefined],
    ] as const) {
      const unknown = await call(h, method, "/w/no-such-workspace/folder-style", { body });
      expect(unknown.status, method).toBe(404);
      expect((await unknown.json()).type, method).toBe("https://glosa.local/errors/not-found");
    }
    expect(recorded(h.home)).toEqual([[h.root, "mono"]]);
  });

  test("changing a default without the page's own Origin is refused, and reading needs none", async () => {
    const h = await serve(tempDir("glosa-fs-home-"), tempDir("glosa-fs-ws-"));
    for (const origin of [null, "http://evil.example", `http://127.0.0.1:${h.port + 7}`]) {
      const put = await call(h, "PUT", `/w/${h.slug}/folder-style`, { body: { style: "spec" }, origin });
      expect(put.status, `PUT with Origin ${origin}`).toBe(403);
      const del = await call(h, "DELETE", `/w/${h.slug}/folder-style`, { origin });
      expect(del.status, `DELETE with Origin ${origin}`).toBe(403);
    }
    expect(recorded(h.home)).toEqual([]);
    expect((await call(h, "GET", `/w/${h.slug}/folder-style`, { origin: null })).status).toBe(200);
  });

  test("anything but editorial, spec or mono is refused, and so is a single-file workspace", async () => {
    const h = await serve(tempDir("glosa-fs-home-"), tempDir("glosa-fs-ws-"));
    for (const body of [{ style: "sans" }, { style: "default" }, { style: null }, {}, "not json"]) {
      const res = await call(h, "PUT", `/w/${h.slug}/folder-style`, { body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await res.json()).type).toBe("https://glosa.local/errors/validation-failed");
    }

    const looseRoot = tempDir("glosa-fs-loose-");
    writeFileSync(join(looseRoot, "note.md"), "note\n");
    const opened = await (
      await call(h, "POST", "/api/workspaces/open", { body: { path: join(looseRoot, "note.md") } })
    ).json();
    expect(h.workspaceIndex.getBySlug(opened.slug)?.kind).toBe("loose-file");
    for (const [method, body] of [
      ["GET", undefined],
      ["PUT", { style: "spec" }],
      ["DELETE", undefined],
    ] as const) {
      const res = await call(h, method, `/w/${opened.slug}/folder-style`, { body });
      expect(res.status, method).toBe(422);
      expect((await res.json()).type).toBe("https://glosa.local/errors/folder-style-not-directory");
    }
    expect(recorded(h.home)).toEqual([]);
  });

  test("the default outlives the index forgetting the folder and applies again when it is opened", async () => {
    const h = await serve(tempDir("glosa-fs-home-"), tempDir("glosa-fs-ws-"));
    await call(h, "PUT", `/w/${h.slug}/folder-style`, { body: { style: "spec" } });
    await h.busRegistry.close(h.root);
    expect(await h.workspaceIndex.forget(h.slug)).toBe(true);
    expect((await call(h, "GET", `/w/${h.slug}/folder-style`)).status).toBe(404);

    const reopened = await (await call(h, "POST", "/api/workspaces/open", { body: { path: h.root } })).json();
    expect(await read(h, reopened.slug)).toEqual({ style: "spec" });
  });

  test("every stream open on the folder hears that its default changed, and a stream on another folder does not", async () => {
    const h = await serve(tempDir("glosa-fs-home-"), tempDir("glosa-fs-ws-"));
    const other = await h.workspaceIndex.upsertWorkspace(tempDir("glosa-fs-other-"), "glosa-open");
    const windows = [await openStream(h, h.slug), await openStream(h, h.slug)];
    const elsewhere = await openStream(h, other.slug);

    await call(h, "PUT", `/w/${h.slug}/folder-style`, { body: { style: "mono" } });
    for (const window of windows) {
      const frame = await window.next((f) => f.event === "folder_style");
      expect(frame.id).toBeUndefined(); // an invalidation, outside the journal's cursor space
      expect(JSON.parse(frame.data)).toEqual({ changed: true });
    }
    await call(h, "DELETE", `/w/${h.slug}/folder-style`);
    for (const window of windows) await window.next((f) => f.event === "folder_style");
    await expect(elsewhere.next((f) => f.event === "folder_style", 300)).rejects.toThrow("no matching frame");
  });

  test("the default survives a restart of the real daemon", async () => {
    const home = freshHome();
    mkdirSync(home, { recursive: true });
    writeFileSync(tokenPath(home), TOKEN, { mode: 0o600 });
    cleanups.push(() => cleanupHome(home));
    const root = tempDir("glosa-fs-restart-ws-");
    const port = randomPort();
    const start = async () => {
      const proc = spawnDaemon(home, port, { GLOSA_CLASSF_PORT: String(port + 1) });
      cleanups.push(() => stopDaemon(home, proc));
      expect(await waitForHandshake(port, 15_000, proc), `handshake (exitCode=${proc.exitCode})`).not.toBeNull();
      return proc;
    };
    const first = await start();
    const opened = await (await call({ port }, "POST", "/api/workspaces/open", { body: { path: root } })).json();
    expect((await call({ port }, "PUT", `/w/${opened.slug}/folder-style`, { body: { style: "spec" } })).status).toBe(
      200,
    );
    await stopDaemon(home, first);

    await start();
    expect(await read({ port }, opened.slug)).toEqual({ style: "spec" });
  }, 30_000);

  /** Opens a workspace stream and returns a reader that waits for the first frame matching `want`. */
  async function openStream(h: Harness, slug: string) {
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${h.port}/w/${slug}/stream`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    const frames: ParsedSseEvent[] = [];
    const waiters: { want: (f: ParsedSseEvent) => boolean; resolve: (f: ParsedSseEvent) => void }[] = [];
    let pumpError: unknown;
    const pump = (async () => {
      try {
        for await (const frame of parseSseStream(res.body!.getReader())) {
          frames.push(frame);
          for (const waiter of [...waiters]) {
            if (waiter.want(frame)) {
              waiters.splice(waiters.indexOf(waiter), 1);
              waiter.resolve(frame);
            }
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) pumpError = error;
      }
    })();
    cleanups.push(async () => {
      controller.abort();
      await pump;
    });
    const next = (want: (f: ParsedSseEvent) => boolean, ms = 3000): Promise<ParsedSseEvent> => {
      if (pumpError !== undefined) return Promise.reject(pumpError);
      const seen = frames.find(want);
      if (seen) {
        frames.splice(frames.indexOf(seen), 1);
        return Promise.resolve(seen);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no matching frame within the timeout")), ms);
        waiters.push({
          want,
          resolve: (f) => {
            clearTimeout(timer);
            frames.splice(frames.indexOf(f), 1);
            resolve(f);
          },
        });
      });
    };
    await next((f) => f.event === "snapshot");
    return { next };
  }
});

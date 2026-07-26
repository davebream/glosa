// SPDX-License-Identifier: Apache-2.0
// P5.1 / issue #46 — `glosa open [target] [focus]` (A6 §F26).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GlosaApiClient } from "../src/api-client.ts";
import type { InitResult, OwnershipManifest } from "../src/init.ts";
import { maybeOfferInit, printOpenResult, runOpen, type OpenDeps } from "../src/open.ts";
import { apiError, daemonUnreachable, FakeGlosaApiClient } from "./fake-api-client.ts";
import { captureStderr, captureStdout } from "./test-utils.ts";

/** A "wired" drift result so existing cases stay warning-free by default. */
const WIRED = { manifest: {} as OwnershipManifest, drifted: [] as string[] };

let dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "glosa-open-test-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function makeDeps(overrides: Partial<OpenDeps> = {}): {
  deps: OpenDeps;
  client: FakeGlosaApiClient;
  browserCalls: string[];
} {
  const client = new FakeGlosaApiClient();
  const browserCalls: string[] = [];
  const deps: OpenDeps = {
    createClient: async () => client as unknown as GlosaApiClient,
    ensureToken: () => "test-token-abc",
    glosaHome: () => "/tmp/fake-glosa-home",
    openBrowser: (url) => browserCalls.push(url),
    platform: () => "darwin",
    dirExists: () => true,
    fileExists: () => false,
    isRegularFile: () => false,
    checkManifestDrift: () => WIRED,
    ...overrides,
  };
  return { deps, client, browserCalls };
}

describe("glosa open", () => {
  test("non-darwin platform -> exit 5, never touches the daemon", async () => {
    let daemonTouched = false;
    const { deps } = makeDeps({
      platform: () => "linux",
      createClient: async () => {
        daemonTouched = true;
        throw daemonUnreachable();
      },
    });
    const result = await runOpen("/tmp/x", deps);
    expect(result.exitCode).toBe(5);
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe("platform_unsupported");
    expect(daemonTouched).toBe(false);
  });

  test("directory does not exist -> exit 2 (usage)", async () => {
    const { deps } = makeDeps({ dirExists: () => false, fileExists: () => false, isRegularFile: () => false });
    const result = await runOpen("/no/such/dir/at/all", deps);
    expect(result.exitCode).toBe(2);
    expect(result.ok).toBe(false);
  });

  test("daemon unreachable -> exit 3", async () => {
    const dir = freshDir();
    const { deps } = makeDeps({
      createClient: async () => {
        throw daemonUnreachable("spawn failed");
      },
    });
    const result = await runOpen(dir, deps);
    expect(result.exitCode).toBe(3);
    expect(result.error?.kind).toBe("daemon_unreachable");
  });

  test("success: registers the workspace, mints/reuses the token, opens the browser", async () => {
    const dir = freshDir();
    const { deps, client, browserCalls } = makeDeps();
    client.openWorkspaceResult = { slug: "abc123", path: dir, focus: "01-first.md" };

    const result = await runOpen(dir, deps);

    expect(result.exitCode).toBe(0);
    expect(result.ok).toBe(true);
    expect(result.data.slug).toBe("abc123");
    expect(result.data.surface).toBe("workspace");
    expect(result.data.mode).toBe("preview");
    expect(result.data.preview).toBe(false);
    expect(client.calls[0]).toMatchObject({ method: "openWorkspace", args: [dir, { focusFirst: true }] });
    expect(browserCalls).toHaveLength(1);
    expect(browserCalls[0]).toContain("http://127.0.0.1:4646/#");
    expect(browserCalls[0]).toContain("t=test-token-abc");
    expect(browserCalls[0]).toContain("surface=workspace");
    expect(browserCalls[0]).toContain("mode=preview");
    expect(browserCalls[0]).toContain("a=01-first.md");
    expect(browserCalls[0]).not.toContain("lock=");
  });

  test("URL mode registers the workspace and returns its URL without opening a browser", async () => {
    const dir = freshDir();
    const { deps, client, browserCalls } = makeDeps();
    client.openWorkspaceResult = { slug: "abc123", path: dir };

    const result = await runOpen(dir, deps, { launchBrowser: false });

    expect(result.exitCode).toBe(0);
    expect(result.data.url).toContain("t=test-token-abc");
    expect(client.calls[0]).toMatchObject({ method: "openWorkspace", args: [dir, { focusFirst: true }] });
    expect(browserCalls).toHaveLength(0);
  });

  test("--external-state is forwarded only when explicitly requested", async () => {
    const dir = freshDir();
    const { deps, client } = makeDeps();

    await runOpen(dir, deps, { externalState: true });

    expect(client.calls[0]).toEqual({
      method: "openWorkspace",
      args: [dir, { externalState: true, focusFirst: true }],
    });
  });

  test("a FILE argument opens as a document surface and deep-links the artifact", async () => {
    const { deps, client, browserCalls } = makeDeps({
      dirExists: (d) => d === "/ws/essays",
      fileExists: (p) => p === "/ws/essays/07-manuscript.md",
      isRegularFile: (p) => p === "/ws/essays/07-manuscript.md",
    });
    client.openWorkspaceResult = { slug: "essays-abc", path: "/ws/essays", focus: "07-manuscript.md" };

    const result = await runOpen("/ws/essays/07-manuscript.md", deps);

    expect(result.exitCode).toBe(0);
    expect(result.data.focus).toBe("07-manuscript.md");
    expect(result.data.surface).toBe("document");
    expect(client.calls[0]).toMatchObject({
      method: "openWorkspace",
      args: ["/ws/essays/07-manuscript.md"],
    });
    expect(browserCalls[0]).toContain("t=test-token-abc");
    expect(browserCalls[0]).toContain("w=essays-abc");
    expect(browserCalls[0]).toContain("a=07-manuscript.md");
    expect(browserCalls[0]).toContain("surface=document");
  });

  test("--workspace on a lone file forces workspace surface", async () => {
    const { deps, client, browserCalls } = makeDeps({
      dirExists: () => false,
      fileExists: (p) => p === "/tmp/lone.md",
      isRegularFile: (p) => p === "/tmp/lone.md",
    });
    const result = await runOpen("/tmp/lone.md", deps, { surface: "workspace" });
    expect(result.ok).toBe(true);
    expect(result.data.surface).toBe("workspace");
    expect(browserCalls[0]).toContain("surface=workspace");
    expect(client.calls[0]).toEqual({ method: "openWorkspace", args: ["/tmp/lone.md"] });
  });

  test("--document on a directory requests and deep-links its first tracked artifact", async () => {
    const dir = freshDir();
    const { deps, client, browserCalls } = makeDeps({ dirExists: (path) => path === dir, isRegularFile: () => false });
    client.openWorkspaceResult = { slug: "essays-abc", path: dir, focus: "01-first.md" };

    const result = await runOpen(dir, deps, { surface: "document" });

    expect(result.ok).toBe(true);
    expect(result.data.surface).toBe("document");
    expect(result.data.focus).toBe("01-first.md");
    expect(client.calls[0]).toEqual({
      method: "openWorkspace",
      args: [dir, { focusFirst: true, requireFocus: true }],
    });
    expect(browserCalls[0]).toContain("a=01-first.md");
    expect(browserCalls[0]).toContain("surface=document");
  });

  test("--document on an empty directory returns the stable no-tracked-artifact usage error", async () => {
    const dir = freshDir();
    const { deps, client } = makeDeps({ dirExists: (path) => path === dir, isRegularFile: () => false });
    client.openWorkspace = async (path, opts) => {
      client.calls.push({ method: "openWorkspace", args: opts === undefined ? [path] : [path, opts] });
      throw apiError(422, {
        type: "https://glosa.local/errors/no-tracked-artifact",
        title: "document presentation requires at least one tracked artifact",
      });
    };

    const result = await runOpen(dir, deps, { surface: "document" });

    expect(result.exitCode).toBe(2);
    expect(result.error?.code).toBe("no-tracked-artifact");
    expect(client.calls[0]).toEqual({
      method: "openWorkspace",
      args: [dir, { focusFirst: true, requireFocus: true }],
    });
  });

  test("two-arg open <dir> <file> validates focus through the daemon", async () => {
    const { deps, client } = makeDeps({
      dirExists: (d) => d === "/ws/essays",
      fileExists: (p) => p === "/ws/essays/07-manuscript.md",
      isRegularFile: (p) => p === "/ws/essays/07-manuscript.md",
    });
    client.openWorkspaceResult = { slug: "essays-abc", path: "/ws/essays", focus: "07-manuscript.md" };

    const result = await runOpen("/ws/essays", deps, { focus: "07-manuscript.md" });

    expect(result.ok).toBe(true);
    expect(result.data.surface).toBe("workspace");
    expect(client.calls[0]).toEqual({
      method: "openWorkspace",
      args: ["/ws/essays", { focus: "/ws/essays/07-manuscript.md" }],
    });
  });

  test("--document with a second positional is a usage error", async () => {
    const { deps } = makeDeps({
      dirExists: () => true,
      isRegularFile: () => true,
    });
    const result = await runOpen("/ws", deps, { focus: "a.md", surface: "document" });
    expect(result.exitCode).toBe(2);
  });

  test("--preview locks the visit and emits lock=preview", async () => {
    const dir = freshDir();
    const { deps, browserCalls } = makeDeps();
    const result = await runOpen(dir, deps, { previewLock: true });
    expect(result.data.preview).toBe(true);
    expect(result.data.mode).toBe("preview");
    expect(browserCalls[0]).toContain("lock=preview");
  });

  test("--bind success records bound_session", async () => {
    const dir = freshDir();
    const { deps, client } = makeDeps();
    const result = await runOpen(dir, deps, { bindSessionId: "sess-1", launchBrowser: false });
    expect(result.ok).toBe(true);
    expect(result.data.bound_session).toBe("sess-1");
    expect(client.calls.some((c) => c.method === "bindSession")).toBe(true);
  });

  test("--bind failure is nonfatal: URL preserved, warning, exit 0", async () => {
    const dir = freshDir();
    const { deps, client } = makeDeps();
    client.bindSessionError = apiError(404, {
      type: "https://glosa.local/errors/not-found",
      title: "unknown or not-live session",
    });
    const result = await runOpen(dir, deps, { bindSessionId: "dead", launchBrowser: false });
    expect(result.exitCode).toBe(0);
    expect(result.ok).toBe(true);
    expect(result.data.url).toBeTruthy();
    expect(result.data.bound_session).toBeUndefined();
    expect(result.warnings.some((w) => w.code === "bind-failed")).toBe(true);
  });

  test("--preview --bind emits preview-bind-conflict warning", async () => {
    const dir = freshDir();
    const { deps } = makeDeps();
    const result = await runOpen(dir, deps, {
      previewLock: true,
      bindSessionId: "sess-1",
      launchBrowser: false,
    });
    expect(result.exitCode).toBe(0);
    expect(result.warnings.some((w) => w.code === "preview-bind-conflict")).toBe(true);
  });

  test("redirected state_dir appears in successful open data", async () => {
    const { deps, client } = makeDeps({
      dirExists: () => false,
      fileExists: () => true,
      isRegularFile: () => true,
    });
    client.openWorkspaceResult = {
      slug: "loose",
      path: "/tmp/parent",
      focus: "note.md",
      kind: "loose-file",
      state_dir: "/tmp/fake-glosa-home/state/abc",
    };
    const result = await runOpen("/tmp/parent/note.md", deps, { launchBrowser: false });
    expect(result.data.state_dir).toBe("/tmp/fake-glosa-home/state/abc");
  });

  test("URL mode plain output contains exactly the URL", async () => {
    const dir = freshDir();
    const { deps } = makeDeps();
    const result = await runOpen(dir, deps, { launchBrowser: false });

    const out = captureStdout(() => printOpenResult(result, false, true));
    expect(out).toBe(`${result.data.url}\n`);
  });

  test("URL mode --json envelope has surface/mode/preview fields", async () => {
    const dir = freshDir();
    const { deps, client, browserCalls } = makeDeps();
    client.openWorkspaceResult = { slug: "test-workspace", path: dir };
    const result = await runOpen(dir, deps, { launchBrowser: false });

    const out = captureStdout(() => printOpenResult(result, true));
    const parsed = JSON.parse(out);
    expect(Object.keys(parsed).sort()).toEqual(
      ["command", "data", "error", "exit_code", "glosa_json", "ok", "warnings"].sort(),
    );
    expect(parsed).toMatchObject({ glosa_json: 1, ok: true, command: "open", exit_code: 0 });
    expect(parsed.data).toMatchObject({
      slug: "test-workspace",
      path: dir,
      url: result.data.url,
      surface: "workspace",
      mode: "preview",
      preview: false,
    });
    expect(browserCalls).toHaveLength(0);
  });

  // --- un-wired/drifted visibility (issue #78) ---

  test("un-init'd workspace -> not-initialized warning, exit stays 0 (A6: open works without init)", async () => {
    const dir = freshDir();
    const { deps } = makeDeps({ checkManifestDrift: () => ({ manifest: null, drifted: [] }) });
    const result = await runOpen(dir, deps, { launchBrowser: false });

    expect(result.exitCode).toBe(0);
    expect(result.ok).toBe(true);
    const warning = result.warnings.find((w) => w.code === "not-initialized");
    expect(warning).toBeDefined();
    expect(warning?.message).toContain("`glosa init");
    expect(warning?.message).toContain("restart or /resume");
  });

  test("drifted workspace -> init-drifted warning, exit stays 0", async () => {
    const dir = freshDir();
    const { deps } = makeDeps({
      checkManifestDrift: () => ({ manifest: {} as OwnershipManifest, drifted: ["/x/.mcp.json/mcpServers/glosa"] }),
    });
    const result = await runOpen(dir, deps, { launchBrowser: false });

    expect(result.exitCode).toBe(0);
    const warning = result.warnings.find((w) => w.code === "init-drifted");
    expect(warning).toBeDefined();
    expect(warning?.message).toContain("1 node(s) changed");
    expect(warning?.message).toContain("re-run `glosa init");
  });

  test("drift probe throwing never breaks open", async () => {
    const dir = freshDir();
    const { deps } = makeDeps({
      checkManifestDrift: () => {
        throw new Error("probe exploded");
      },
    });
    const result = await runOpen(dir, deps, { launchBrowser: false });
    expect(result.exitCode).toBe(0);
    expect(result.warnings).toHaveLength(0);
  });

  test("not-initialized warning is printed to stderr in human mode", async () => {
    const dir = freshDir();
    const { deps } = makeDeps({ checkManifestDrift: () => ({ manifest: null, drifted: [] }) });
    const result = await runOpen(dir, deps, { launchBrowser: false });

    const err = captureStderr(() => captureStdout(() => printOpenResult(result, false)));
    expect(err).toContain("glosa open: warning:");
    expect(err).toContain("not wired for agent feedback");
  });

  test("--json envelope carries the not-initialized warning code", async () => {
    const dir = freshDir();
    const { deps } = makeDeps({ checkManifestDrift: () => ({ manifest: null, drifted: [] }) });
    const result = await runOpen(dir, deps, { launchBrowser: false });

    const out = captureStdout(() => printOpenResult(result, true));
    const parsed = JSON.parse(out);
    expect(parsed.warnings.map((w: { code: string }) => w.code)).toContain("not-initialized");
  });
});

describe("maybeOfferInit (consented wiring offer)", () => {
  function unwiredResult(dir: string) {
    return {
      ok: true as const,
      command: "open",
      exitCode: 0,
      data: { slug: "s", path: dir, url: "http://127.0.0.1:4646/#x" },
      warnings: [{ code: "not-initialized", message: "..." }],
    };
  }
  function makeOffer(overrides: Partial<Parameters<typeof maybeOfferInit>[1]> = {}) {
    const calls: { confirmed: number; initDirs: string[]; stderr: string[] } = {
      confirmed: 0,
      initDirs: [],
      stderr: [],
    };
    const opts: Parameters<typeof maybeOfferInit>[1] = {
      json: false,
      isTTY: () => true,
      confirm: async () => {
        calls.confirmed += 1;
        return true;
      },
      runInit: async (o) => {
        calls.initDirs.push(o.dir);
        return { ok: true, exitCode: 0, changed: true, data: {}, warnings: [] } as unknown as InitResult;
      },
      stderr: (t) => calls.stderr.push(t),
      ...overrides,
    };
    return { opts, calls };
  }

  test("TTY + yes -> runInit with the workspace dir + restart line on stderr", async () => {
    const { opts, calls } = makeOffer();
    await maybeOfferInit(unwiredResult("/ws/a"), opts);
    expect(calls.confirmed).toBe(1);
    expect(calls.initDirs).toEqual(["/ws/a"]);
    expect(calls.stderr.join("")).toContain("restart or /resume");
  });

  test("TTY + no -> init never runs", async () => {
    const { opts, calls } = makeOffer({ confirm: async () => false });
    await maybeOfferInit(unwiredResult("/ws/a"), opts);
    expect(calls.initDirs).toHaveLength(0);
  });

  test("non-TTY -> confirm never called", async () => {
    const { opts, calls } = makeOffer({ isTTY: () => false });
    await maybeOfferInit(unwiredResult("/ws/a"), opts);
    expect(calls.confirmed).toBe(0);
    expect(calls.initDirs).toHaveLength(0);
  });

  test("--json -> never prompts", async () => {
    const { opts, calls } = makeOffer({ json: true });
    await maybeOfferInit(unwiredResult("/ws/a"), opts);
    expect(calls.confirmed).toBe(0);
    expect(calls.initDirs).toHaveLength(0);
  });

  test("--init runs without confirm, even non-TTY", async () => {
    const { opts, calls } = makeOffer({ initFlag: true, isTTY: () => false });
    await maybeOfferInit(unwiredResult("/ws/a"), opts);
    expect(calls.confirmed).toBe(0);
    expect(calls.initDirs).toEqual(["/ws/a"]);
  });

  test("--no-init suppresses everything, even with --init absent and TTY", async () => {
    const { opts, calls } = makeOffer({ noInitFlag: true });
    await maybeOfferInit(unwiredResult("/ws/a"), opts);
    expect(calls.confirmed).toBe(0);
    expect(calls.initDirs).toHaveLength(0);
  });

  test("no not-initialized warning -> nothing happens (drift excluded by design)", async () => {
    const { opts, calls } = makeOffer();
    const result = {
      ...unwiredResult("/ws/a"),
      warnings: [{ code: "init-drifted", message: "..." }],
    };
    await maybeOfferInit(result, opts);
    expect(calls.confirmed).toBe(0);
  });

  test("runInit failure is reported on stderr, never throws", async () => {
    const { opts, calls } = makeOffer({
      runInit: async () =>
        ({
          ok: false,
          exitCode: 6,
          changed: false,
          data: {},
          warnings: [],
          error: { code: "mcp-key-conflict", kind: "conflict", message: "foreign glosa key", hint: "use --force" },
        }) as unknown as InitResult,
    });
    await maybeOfferInit(unwiredResult("/ws/a"), opts);
    const err = calls.stderr.join("");
    expect(err).toContain("init failed: foreign glosa key");
    expect(err).toContain("hint: use --force");
  });

  test("runInit throwing is caught and reported", async () => {
    const { opts, calls } = makeOffer({
      runInit: async () => {
        throw new Error("disk full");
      },
    });
    await maybeOfferInit(unwiredResult("/ws/a"), opts);
    expect(calls.stderr.join("")).toContain("init failed: disk full");
  });
});

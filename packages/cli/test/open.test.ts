// SPDX-License-Identifier: Apache-2.0
// P5.1 — `glosa open [dir]` (A6 §F26).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GlosaApiClient } from "../src/api-client.ts";
import { printOpenResult, runOpen, type OpenDeps } from "../src/open.ts";
import { daemonUnreachable, FakeGlosaApiClient } from "./fake-api-client.ts";
import { captureStdout } from "./test-utils.ts";

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
    const { deps } = makeDeps({ dirExists: () => false });
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

  test("success: registers the workspace, mints/reuses the token, opens the browser at #t=<token>", async () => {
    const dir = freshDir();
    const { deps, client, browserCalls } = makeDeps();
    client.openWorkspaceResult = { slug: "abc123", path: dir };

    const result = await runOpen(dir, deps);

    expect(result.exitCode).toBe(0);
    expect(result.ok).toBe(true);
    expect(result.data.slug).toBe("abc123");
    expect(client.calls[0]).toMatchObject({ method: "openWorkspace", args: [dir] });
    expect(browserCalls).toHaveLength(1);
    expect(browserCalls[0]).toContain("http://127.0.0.1:4646/#t=test-token-abc");
  });

  test("URL mode registers the workspace and returns its URL without opening a browser", async () => {
    const dir = freshDir();
    const { deps, client, browserCalls } = makeDeps();
    client.openWorkspaceResult = { slug: "abc123", path: dir };

    const result = await runOpen(dir, deps, { launchBrowser: false });

    expect(result.exitCode).toBe(0);
    expect(result.data.url).toBe("http://127.0.0.1:4646/#t=test-token-abc");
    expect(client.calls[0]).toMatchObject({ method: "openWorkspace", args: [dir] });
    expect(browserCalls).toHaveLength(0);
  });

  test("--external-state is forwarded only when explicitly requested", async () => {
    const dir = freshDir();
    const { deps, client } = makeDeps();

    await runOpen(dir, deps, { externalState: true });

    expect(client.calls[0]).toEqual({
      method: "openWorkspace",
      args: [dir, { externalState: true }],
    });
  });

  test("a FILE argument is resolved by the daemon and deep-linked to its representative artifact", async () => {
    const { deps, client, browserCalls } = makeDeps({
      dirExists: (d) => d === "/ws/essays",
      fileExists: (p) => p === "/ws/essays/07-manuscript.md",
    });
    client.openWorkspaceResult = { slug: "essays-abc", path: "/ws/essays", focus: "07-manuscript.md" };

    const result = await runOpen("/ws/essays/07-manuscript.md", deps);

    expect(result.exitCode).toBe(0);
    expect(result.data.focus).toBe("07-manuscript.md");
    expect(client.calls[0]).toMatchObject({
      method: "openWorkspace",
      args: ["/ws/essays/07-manuscript.md"],
    });
    expect(browserCalls[0]).toContain("#t=test-token-abc&w=essays-abc&a=07-manuscript.md");
  });

  test("a directory argument keeps the plain fragment — no w/a params", async () => {
    const dir = freshDir();
    const { deps, browserCalls } = makeDeps();
    await runOpen(dir, deps);
    expect(browserCalls[0]).not.toContain("&a=");
    expect(browserCalls[0]).not.toContain("&w=");
  });

  test("URL mode preserves a FILE deep-link without opening a browser", async () => {
    const { deps, client, browserCalls } = makeDeps({
      dirExists: (d) => d === "/ws/essays",
      fileExists: (p) => p === "/ws/essays/07-manuscript.md",
    });
    client.openWorkspaceResult = { slug: "essays-abc", path: "/ws/essays", focus: "07-manuscript.md" };

    const result = await runOpen("/ws/essays/07-manuscript.md", deps, { launchBrowser: false });

    expect(result.data.url).toBe("http://127.0.0.1:4646/#t=test-token-abc&w=essays-abc&a=07-manuscript.md");
    expect(result.data.focus).toBe("07-manuscript.md");
    expect(browserCalls).toHaveLength(0);
  });

  test("URL mode plain output contains exactly the URL", async () => {
    const dir = freshDir();
    const { deps } = makeDeps();
    const result = await runOpen(dir, deps, { launchBrowser: false });

    const out = captureStdout(() => printOpenResult(result, false, true));
    expect(out).toBe(`${result.data.url}\n`);
  });

  test("URL mode --json envelope has exactly the documented top-level keys", async () => {
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
    expect(parsed.data).toMatchObject({ slug: "test-workspace", path: dir, url: result.data.url });
    expect(browserCalls).toHaveLength(0);
  });
});

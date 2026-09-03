// SPDX-License-Identifier: Apache-2.0
// Direct coverage for the shared CLI/MCP presentation module. `open.test.ts` reaches it only
// through the CLI wrapper; these assertions pin the shared classification and ephemeral-token URL
// contract that `glosa_present` relies on.
import { describe, expect, test } from "bun:test";
import type { GlosaApiClient } from "../src/api-client.ts";
import {
  buildPresentationUrl,
  classifyOpenTarget,
  type OpenPresentationDeps,
  runOpenPresentation,
} from "../src/open-presentation.ts";
import type { ScopedOwnershipManifest } from "../src/scoped-init.ts";
import { FakeGlosaApiClient } from "./fake-api-client.ts";

const WIRED_MANIFEST = {} as ScopedOwnershipManifest;
const WIRED = { manifest: WIRED_MANIFEST, manifests: [WIRED_MANIFEST], drifted: [] as string[] };

describe("open-presentation shared contract", () => {
  test("relative targets resolve against the client cwd, including a relative focus", () => {
    const result = classifyOpenTarget("drafts", "sermon.md", "auto", {
      cwd: () => "/work/review",
      dirExists: (path) => path === "/work/review/drafts",
      fileExists: (path) => path === "/work/review/drafts/sermon.md",
      isRegularFile: (path) => path === "/work/review/drafts/sermon.md",
    });

    expect(result).toEqual({
      openPath: "/work/review/drafts",
      focusPath: "/work/review/drafts/sermon.md",
      surface: "workspace",
    });
  });

  test("buildPresentationUrl emits exactly one pairing secret and preserves preview state", () => {
    const url = new URL(
      buildPresentationUrl(4646, {
        slug: "review-a1b2c3",
        focus: "draft.md",
        surface: "document",
        mode: "preview",
        previewLock: true,
        pairing: { kind: "presentation", token: "ephemeral-secret" },
      }),
    );
    const params = new URLSearchParams(url.hash.slice(1));

    expect(url.origin).toBe("http://127.0.0.1:4646");
    expect(params.get("p")).toBe("ephemeral-secret");
    expect(params.has("t")).toBe(false);
    expect(Object.fromEntries(params)).toEqual({
      p: "ephemeral-secret",
      w: "review-a1b2c3",
      a: "draft.md",
      surface: "document",
      mode: "preview",
      lock: "preview",
    });
  });

  test("MCP-style presentation mints p=, never launches, and does not leak the durable token", async () => {
    const client = new FakeGlosaApiClient();
    client.openWorkspaceResult = {
      slug: "review-a1b2c3",
      path: "/work/review",
      focus: "draft.md",
      kind: "directory",
    };
    client.mintPresentationTokenResult = { token: "single-use-token", expires_in_s: 60 };
    let browserLaunched = false;
    let durableTokenReads = 0;
    const deps: OpenPresentationDeps = {
      createClient: async () => client as unknown as GlosaApiClient,
      ensureToken: () => {
        durableTokenReads++;
        return "durable-token-must-not-leak";
      },
      glosaHome: () => "/tmp/glosa-home-fixture",
      openBrowser: () => {
        browserLaunched = true;
      },
      platform: () => "darwin",
      dirExists: (path) => path === "/work/review",
      fileExists: (path) => path === "/work/review/draft.md",
      isRegularFile: (path) => path === "/work/review/draft.md",
      checkManifestDrift: () => WIRED,
    };

    const result = await runOpenPresentation("/work/review/draft.md", undefined, "document", deps, {
      launchBrowser: false,
      usePresentationToken: true,
      previewLock: true,
      mode: "preview",
    });

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(durableTokenReads).toBe(1);
    expect(browserLaunched).toBe(false);
    expect(client.calls.map((call) => call.method)).toEqual(["openWorkspace", "mintPresentationToken"]);
    expect(result.data.url).toContain("p=single-use-token");
    expect(result.data.url).not.toContain("t=");
    expect(result.data.url).not.toContain("durable-token-must-not-leak");
    expect(result.data).toMatchObject({ surface: "document", mode: "preview", preview: true });
  });
});

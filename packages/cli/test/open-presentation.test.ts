// SPDX-License-Identifier: Apache-2.0
// Direct coverage for the shared CLI/MCP presentation module. `open.test.ts` reaches it only
// through the CLI wrapper; these assertions pin the shared classification and ephemeral-token URL
// contract that `glosa_present` relies on.
import { describe, expect, test } from "bun:test";
import { SPA_HOSTNAMES } from "../../daemon/src/security/hosts.ts";
import type { GlosaApiClient } from "../src/api-client.ts";
import {
  buildPresentationUrl,
  classifyOpenTarget,
  type OpenPresentationDeps,
  presentationHostname,
  runOpenPresentation,
} from "../src/open-presentation.ts";
import { FakeGlosaApiClient } from "./fake-api-client.ts";

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
        mode: "read",
        readLock: true,
        pairing: { kind: "presentation", token: "ephemeral-secret" },
      }),
    );
    const params = new URLSearchParams(url.hash.slice(1));

    expect(url.origin).toBe("http://glosa.localhost:4646");
    expect(params.get("p")).toBe("ephemeral-secret");
    expect(params.has("t")).toBe(false);
    expect(Object.fromEntries(params)).toEqual({
      p: "ephemeral-secret",
      w: "review-a1b2c3",
      a: "draft.md",
      surface: "document",
      mode: "read",
      lock: "read",
    });
  });

  test("presentation mints p=, never launches, and does not leak the durable token", async () => {
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
    };

    const result = await runOpenPresentation("/work/review/draft.md", undefined, "document", deps, {
      launchBrowser: false,
      readLock: true,
      mode: "read",
    });

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(durableTokenReads).toBe(1);
    expect(browserLaunched).toBe(false);
    expect(client.calls.map((call) => call.method)).toEqual(["openWorkspace", "mintPresentationToken"]);
    expect(result.data.url).toContain("p=single-use-token");
    expect(result.data.url).not.toContain("t=");
    expect(result.data.url).not.toContain("durable-token-must-not-leak");
    expect(result.data).toMatchObject({ surface: "document", mode: "read", preview: true });
  });

  // Issue #207: this is the path that used to put the DURABLE pairing token in a URL and hand it
  // to a browser over TCP, addressed to a port resolved earlier and never re-verified. Whatever
  // holds that port when the browser arrives receives what the fragment carries, and moving the
  // API onto a Unix socket cannot protect it — browsers cannot open one. So the fragment must
  // carry a single-use 60-second token instead, on the terminal path as well as the MCP one.
  test("the browser-launching path carries a single-use token, never the durable credential", async () => {
    const client = new FakeGlosaApiClient();
    client.openWorkspaceResult = {
      slug: "review-a1b2c3",
      path: "/work/review",
      focus: "draft.md",
      kind: "directory",
    };
    client.mintPresentationTokenResult = { token: "single-use-token", expires_in_s: 60 };
    // An array rather than a `string | null`: TypeScript narrows a `let` assigned only inside a
    // callback back to `null`, and the assertions below are the point of the test.
    const launched: string[] = [];
    const deps: OpenPresentationDeps = {
      createClient: async () => client as unknown as GlosaApiClient,
      ensureToken: () => "durable-token-must-not-leak",
      glosaHome: () => "/tmp/glosa-home-fixture",
      openBrowser: (url) => {
        launched.push(url);
      },
      platform: () => "darwin",
      dirExists: (path) => path === "/work/review",
      fileExists: (path) => path === "/work/review/draft.md",
      isRegularFile: (path) => path === "/work/review/draft.md",
    };

    const result = await runOpenPresentation("/work/review/draft.md", undefined, "document", deps, {});

    expect(result.ok).toBe(true);
    expect(client.calls.map((call) => call.method)).toContain("mintPresentationToken");
    // Asserted on what the BROWSER was actually handed, not only on the envelope: the envelope
    // and the launched URL are two different strings, and only one of them reaches the port.
    expect(launched).toHaveLength(1);
    const launchedUrl = launched[0] as string;
    expect(launchedUrl).toContain("p=single-use-token");
    expect(launchedUrl).not.toContain("durable-token-must-not-leak");
    expect(new URLSearchParams(new URL(launchedUrl).hash.slice(1)).has("t")).toBe(false);
  });
});

describe("presentation hostname (#159)", () => {
  test("glosa.localhost by default; GLOSA_OPEN_HOST=127.0.0.1 is the only override", () => {
    expect(presentationHostname({})).toBe("glosa.localhost");
    expect(presentationHostname({ GLOSA_OPEN_HOST: "127.0.0.1" })).toBe("127.0.0.1");
    // Anything else would be a Host the daemon answers with a 400, so it is not honoured.
    expect(presentationHostname({ GLOSA_OPEN_HOST: "evil.example" })).toBe("glosa.localhost");
    expect(presentationHostname({ GLOSA_OPEN_HOST: "localhost" })).toBe("glosa.localhost");
  });

  test("every hostname glosa open can link to is on the daemon's Host allowlist", () => {
    for (const env of [{}, { GLOSA_OPEN_HOST: "127.0.0.1" }]) {
      expect(SPA_HOSTNAMES as readonly string[]).toContain(presentationHostname(env));
    }
  });
});

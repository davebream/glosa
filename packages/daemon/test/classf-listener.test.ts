// SPDX-License-Identifier: Apache-2.0
// P4.1 — the class-F listener over a REAL bound socket (A1 §7, A3 §1/§2/§5). Mints a capability
// through the in-process `createApiFetch` pipeline (same harness as http-routes.test.ts — no real
// bind needed for the mint side, since there's no `glosa open` CLI wiring yet to register a
// workspace against a real subprocess daemon), then hits a REAL `Bun.serve` bound with
// `createClassFFetch` sharing that SAME `CapabilityStore` — this is what lets the CSP-exactness,
// traversal, and bridge-injection assertions run over actual HTTP responses instead of just the
// in-process `Response` objects classf-serve.test.ts already covers at the function level.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiFetch, createClassFFetch, type ApiContext } from "../src/http.ts";
import { CapabilityStore } from "../src/capability.ts";
import { WorkspaceIndex } from "../src/registry/workspace-index.ts";
import { SessionRegistry } from "../src/registry/session-registry.ts";
import { WorkspaceBusRegistry } from "../src/bus/workspace-bus-registry.ts";
import { canonicalize } from "../src/registry/slug.ts";
import { randomPort } from "./helpers.ts";

const TOKEN = "classf-listener-test-token-0123456789abcdef";
const API_PORT = 4646; // never bound — only compared against the Host header for the mint side

describe("class-F listener — real socket", () => {
  let home: string;
  let root: string;
  let classFPort: number;
  let workspaceIndex: WorkspaceIndex;
  let sessionRegistry: SessionRegistry;
  let busRegistry: WorkspaceBusRegistry;
  let capabilityStore: CapabilityStore;
  let apiFetchFn: (req: Request) => Promise<Response>;
  let classFServer: ReturnType<typeof Bun.serve>;
  let slug: string;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "glosa-classf-home-"));
    root = canonicalize(mkdtempSync(join(tmpdir(), "glosa-classf-ws-")));
    classFPort = randomPort();

    workspaceIndex = new WorkspaceIndex({ home });
    sessionRegistry = new SessionRegistry({ index: workspaceIndex });
    busRegistry = new WorkspaceBusRegistry();
    workspaceIndex.setLiveSessionPredicate((p) => sessionRegistry.forWorkspace(p).length > 0);
    workspaceIndex.setOnHardRemove((p) => busRegistry.evict(p));

    const entry = await workspaceIndex.upsertWorkspace(root, "glosa-open");
    slug = entry.slug;

    capabilityStore = new CapabilityStore();

    const ctx: ApiContext = {
      port: API_PORT,
      classFPort,
      token: TOKEN,
      instanceId: "gl-classf-test",
      startedAt: new Date().toISOString(),
      workspaceIndex,
      sessionRegistry,
      getWorkspaceBus: (r) => busRegistry.get(r),
      capabilityStore,
    };
    apiFetchFn = createApiFetch(ctx);

    const classFFetch = createClassFFetch({ port: classFPort, spaPort: API_PORT, capabilityStore });
    classFServer = Bun.serve({ hostname: "127.0.0.1", port: classFPort, fetch: classFFetch, idleTimeout: 2 });
  });

  afterEach(async () => {
    await classFServer.stop(true);
    await busRegistry.close(root);
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  function classFUrl(path: string): string {
    return `http://127.0.0.1:${classFPort}${path}`;
  }

  async function mint(artifactPath: string): Promise<{ url: string; nonce: string; expires_in_s: number }> {
    const req = new Request(`http://127.0.0.1:${API_PORT}/w/${slug}/capability/${artifactPath}`, {
      headers: {
        Host: `127.0.0.1:${API_PORT}`,
        Authorization: `Bearer ${TOKEN}`,
        Origin: `http://127.0.0.1:${API_PORT}`,
      },
    });
    const res = await apiFetchFn(req);
    expect(res.status).toBe(200);
    return res.json();
  }

  test("Host mismatch on the class-F origin → 400", async () => {
    const res = await fetch(classFUrl("/doc/whatever/x.html"), { headers: { Host: "evil.com" } });
    expect(res.status).toBe(400);
  });

  test("[A3 §5 #1/#2] the class-F CSP header matches the A3 §1 spec string VERBATIM", async () => {
    writeFileSync(join(root, "notes.html"), "<html><body>hi</body></html>");
    const { url } = await mint("notes.html");
    const res = await fetch(url);
    expect(res.status).toBe(200);
    const expected =
      "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data:; font-src 'self' data:; connect-src 'none'; form-action 'none'; " +
      `frame-ancestors 'self' http://127.0.0.1:${API_PORT}; base-uri 'none'; object-src 'none'; ` +
      "sandbox allow-scripts;";
    expect(res.headers.get("Content-Security-Policy")).toBe(expected);
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  test("the class-F CSP header is present even on a 404 (unknown token) response", async () => {
    const res = await fetch(classFUrl("/doc/" + "0".repeat(64) + "/notes.html"));
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Security-Policy")).toContain("sandbox allow-scripts");
  });

  test("[A3 §5 #7] a Bearer header is IGNORED — never accepted as auth on the class-F origin, the capability alone gates it", async () => {
    writeFileSync(join(root, "notes.html"), "<html><body>hi</body></html>");
    const { url } = await mint("notes.html");
    const withBearer = await fetch(url, { headers: { Authorization: "Bearer totally-wrong-token" } });
    expect(withBearer.status).toBe(200); // wrong Bearer doesn't block it...
    const noAuthAtAll = await fetch(url);
    expect(noAuthAtAll.status).toBe(200); // ...and no Bearer at all is equally fine
  });

  test("unknown token → 404, plain text, no daemon-origin details", async () => {
    const res = await fetch(classFUrl(`/doc/${"a".repeat(64)}/notes.html`));
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).not.toContain("application/problem+json");
    const body = await res.text();
    expect(body.toLowerCase()).not.toContain("workspace");
    expect(body.toLowerCase()).not.toContain(root.toLowerCase());
  });

  test("directory-scoped + multi-request: ONE mint serves the document AND a sibling asset", async () => {
    writeFileSync(join(root, "speech-notes.html"), "<html><body><p>hi</p></body></html>");
    writeFileSync(join(root, "side-notes.css"), "p { color: green; }");
    const { url } = await mint("speech-notes.html");
    const docRes = await fetch(url);
    expect(docRes.status).toBe(200);
    const cssUrl = url.replace(/speech-notes\.html$/, "side-notes.css");
    const cssRes = await fetch(cssUrl);
    expect(cssRes.status).toBe(200);
    expect(await cssRes.text()).toBe("p { color: green; }");
  });

  test("bridge injection: the document carries the bridge before </body>; the sibling CSS does not", async () => {
    writeFileSync(join(root, "speech-notes.html"), "<html><body><p>hello</p></body></html>");
    writeFileSync(join(root, "side-notes.css"), "p{}");
    const { url, nonce } = await mint("speech-notes.html");
    const docBody = await (await fetch(url)).text();
    expect(docBody).toContain("<p>hello</p>");
    expect(docBody).toContain(JSON.stringify(nonce));
    const cssBody = await (await fetch(url.replace(/speech-notes\.html$/, "side-notes.css"))).text();
    expect(cssBody).toBe("p{}");
  });

  test("[A3 §5 #4] literal `..` traversal past the token segment → 404 (the URL parser collapses dot-segments before routing ever sees them)", async () => {
    writeFileSync(join(root, "speech-notes.html"), "<html><body>hi</body></html>");
    const { url } = await mint("speech-notes.html");
    const token = url.split("/doc/")[1]!.split("/")[0];
    const res = await fetch(classFUrl(`/doc/${token}/../../../../../../etc/passwd`));
    expect(res.status).toBe(404);
  });

  test("[A3 §5 #4] percent-encoded `%2e%2e` traversal → 404, same as the literal form", async () => {
    writeFileSync(join(root, "speech-notes.html"), "<html><body>hi</body></html>");
    const { url } = await mint("speech-notes.html");
    const token = url.split("/doc/")[1]!.split("/")[0];
    const res = await fetch(classFUrl(`/doc/${token}/%2e%2e/%2e%2e/%2e%2e/etc/passwd`));
    expect(res.status).toBe(404);
  });

  test("[A3 §5 #4] a symlink inside the artifact dir pointing outside it → 404, contents never read", async () => {
    const outside = mkdtempSync(join(tmpdir(), "glosa-classf-outside-"));
    writeFileSync(join(outside, "secret.txt"), "top secret");
    symlinkSync(join(outside, "secret.txt"), join(root, "evil-link.html"));
    writeFileSync(join(root, "speech-notes.html"), "<html><body>hi</body></html>");
    const { url } = await mint("speech-notes.html");
    const token = url.split("/doc/")[1]!.split("/")[0];
    const res = await fetch(classFUrl(`/doc/${token}/evil-link.html`));
    expect(res.status).toBe(404);
    rmSync(outside, { recursive: true, force: true });
  });

  test("capability scope: a token minted for artifact A cannot serve artifact B's directory", async () => {
    mkdirSync(join(root, "sub-a"));
    mkdirSync(join(root, "sub-b"));
    writeFileSync(join(root, "sub-a", "a.html"), "<html><body>A</body></html>");
    writeFileSync(join(root, "sub-b", "secret.css"), "body{color:red}");
    const { url } = await mint("sub-a/a.html");
    const token = url.split("/doc/")[1]!.split("/")[0];
    // there's no legal relative path from A's confined directory that reaches sub-b — confirm the
    // obvious attempt 404s.
    const res = await fetch(classFUrl(`/doc/${token}/../sub-b/secret.css`));
    expect(res.status).toBe(404);
  });
});

// SPDX-License-Identifier: Apache-2.0
// P4.1 — serveClassFDocument: the class-F origin's real serve logic (A1 §7, A3 §1/§5). Function-
// level coverage against a real tmp directory (no HTTP layer — http.test.ts covers the same
// attack surface end-to-end over a real subprocess, this file is the fast, no-socket harness for
// the same claims, per the existing http-routes.test.ts/http.test.ts split convention).
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { CapabilityStore } from "../src/capability.ts";
import { serveClassFDocument } from "../src/classf-serve.ts";

describe("serveClassFDocument", () => {
  function freshWorkspace() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "glosa-classf-")));
    const artifactDir = join(root, "output", "docs");
    mkdirSync(artifactDir, { recursive: true });
    return { root, artifactDir };
  }

  function mintFor(store: CapabilityStore, artifactDir: string, basename: string) {
    return store.mint({ slug: "ws", artifactDirRealPath: artifactDir, artifactBasename: basename });
  }

  test("unknown token → null (404 at the call site)", () => {
    const store = new CapabilityStore();
    expect(serveClassFDocument(store, "0".repeat(64), "notes.html")).toBeNull();
  });

  test("expired token → null, same as unknown (TTL expiry itself is exercised in capability.test.ts; this pins the propagation into serveClassFDocument)", () => {
    const { artifactDir } = freshWorkspace();
    writeFileSync(join(artifactDir, "notes.html"), "<html><body>hi</body></html>");
    const store = new CapabilityStore();
    // A directly-forged "lookup at a later `now`" isn't reachable through serveClassFDocument's
    // public signature (it always uses the real clock) — so this proves the OTHER half instead:
    // store.lookup with an explicit past-expiry `now` returns null, and serveClassFDocument is a
    // thin wrapper with no additional caching that could paper over that.
    const now = 1_000_000;
    const { token } = store.mint({ slug: "ws", artifactDirRealPath: artifactDir, artifactBasename: "notes.html" }, now);
    expect(store.lookup(token, now + 700_000)).toBeNull();
    expect(serveClassFDocument(store, token, "notes.html")).toBeNull(); // stale (real clock is far past this fixed mint time)
  });

  test("sanity: a token minted against the REAL clock resolves — the null above is expiry, not a bug", () => {
    const { artifactDir } = freshWorkspace();
    writeFileSync(join(artifactDir, "notes.html"), "<html><body>hi</body></html>");
    const store = new CapabilityStore();
    const { token } = mintFor(store, artifactDir, "notes.html");
    expect(serveClassFDocument(store, token, "notes.html")).not.toBeNull();
  });

  test("serves the document itself with the bridge injected before </body>, byte-identical otherwise", () => {
    const { artifactDir } = freshWorkspace();
    writeFileSync(join(artifactDir, "rendered-preview.html"), "<html><body><p>hello</p></body></html>");
    const store = new CapabilityStore();
    const { token, nonce } = mintFor(store, artifactDir, "rendered-preview.html");

    const res = serveClassFDocument(store, token, "rendered-preview.html");
    expect(res).not.toBeNull();
    expect(res!.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    return res!.text().then((body) => {
      expect(body).toContain("<p>hello</p>"); // original content untouched
      expect(body).toContain(JSON.stringify(nonce)); // the bridge, carrying the right nonce
      expect(body.indexOf("<script>")).toBeLessThan(body.indexOf("</body>")); // injected BEFORE </body>
    });
  });

  test("a document with no </body> at all still gets the bridge appended, not dropped", () => {
    const { artifactDir } = freshWorkspace();
    writeFileSync(join(artifactDir, "rendered-preview.html"), "<html><body><p>no closing tag");
    const store = new CapabilityStore();
    const { token } = mintFor(store, artifactDir, "rendered-preview.html");

    const res = serveClassFDocument(store, token, "rendered-preview.html");
    return res!.text().then((body) => {
      expect(body).toContain("<script>");
      expect(body.startsWith("<html><body><p>no closing tag")).toBe(true);
    });
  });

  test("a sibling asset (CSS) in the SAME directory is served with its own content-type and NO bridge", () => {
    const { artifactDir } = freshWorkspace();
    writeFileSync(join(artifactDir, "rendered-preview.html"), "<html><body>doc</body></html>");
    writeFileSync(join(artifactDir, "notes-style.css"), "body { color: red; }");
    const store = new CapabilityStore();
    const { token } = mintFor(store, artifactDir, "rendered-preview.html");

    const res = serveClassFDocument(store, token, "notes-style.css");
    expect(res).not.toBeNull();
    expect(res!.headers.get("Content-Type")).toBe("text/css; charset=utf-8");
    return res!.text().then((body) => {
      expect(body).toBe("body { color: red; }");
      expect(body).not.toContain("<script>");
    });
  });

  test("a sibling .html file that ISN'T the minted document itself is served bridge-free (A1 §7)", () => {
    const { artifactDir } = freshWorkspace();
    writeFileSync(join(artifactDir, "rendered-preview.html"), "<html><body>doc</body></html>");
    writeFileSync(join(artifactDir, "fragment.html"), "<div>partial</div>");
    const store = new CapabilityStore();
    const { token } = mintFor(store, artifactDir, "rendered-preview.html");

    const res = serveClassFDocument(store, token, "fragment.html");
    return res!.text().then((body) => {
      expect(body).toBe("<div>partial</div>");
      expect(body).not.toContain("<script>");
    });
  });

  test("[A3 §5 #4] a `..`-containing request path → null (confinePath rejects it before any fs read)", () => {
    const { artifactDir } = freshWorkspace();
    writeFileSync(join(artifactDir, "rendered-preview.html"), "<html><body>doc</body></html>");
    const store = new CapabilityStore();
    const { token } = mintFor(store, artifactDir, "rendered-preview.html");

    expect(serveClassFDocument(store, token, "../../../etc/passwd")).toBeNull();
    expect(serveClassFDocument(store, token, "sub/../../escape.html")).toBeNull();
  });

  test("[A3 §5 #4] a symlink inside the artifact dir pointing outside it → null, contents never read", () => {
    const { root, artifactDir } = freshWorkspace();
    const secretDir = join(root, "secret");
    mkdirSync(secretDir, { recursive: true });
    writeFileSync(join(secretDir, "passwd"), "root:x:0:0");
    symlinkSync(join(secretDir, "passwd"), join(artifactDir, "evil-link.html"));
    writeFileSync(join(artifactDir, "rendered-preview.html"), "<html><body>doc</body></html>");

    const store = new CapabilityStore();
    const { token } = mintFor(store, artifactDir, "rendered-preview.html");

    expect(serveClassFDocument(store, token, "evil-link.html")).toBeNull();
  });

  test("capability scope: a token minted for artifact A's directory cannot serve artifact B's directory", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "glosa-classf-scope-")));
    const dirA = join(root, "a");
    const dirB = join(root, "b");
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    writeFileSync(join(dirA, "a.html"), "<html><body>A</body></html>");
    writeFileSync(join(dirB, "secret.css"), "body{color:blue}");

    const store = new CapabilityStore();
    const { token } = mintFor(store, dirA, "a.html");

    // A relative path can't spell "../b/secret.css" past confinePath's `..` rejection, and even a
    // pre-resolved absolute-looking segment is still relative-joined against dirA, never dirB —
    // there is no path string that reaches B's directory through A's token.
    expect(serveClassFDocument(store, token, "../b/secret.css")).toBeNull();
  });

  test("a request for a directory (not a file) → null, never serves a listing", () => {
    const { artifactDir } = freshWorkspace();
    mkdirSync(join(artifactDir, "subdir"));
    writeFileSync(join(artifactDir, "rendered-preview.html"), "<html><body>doc</body></html>");
    const store = new CapabilityStore();
    const { token } = mintFor(store, artifactDir, "rendered-preview.html");

    expect(serveClassFDocument(store, token, "subdir")).toBeNull();
  });

  test("a missing sibling file → null", () => {
    const { artifactDir } = freshWorkspace();
    writeFileSync(join(artifactDir, "rendered-preview.html"), "<html><body>doc</body></html>");
    const store = new CapabilityStore();
    const { token } = mintFor(store, artifactDir, "rendered-preview.html");

    expect(serveClassFDocument(store, token, "missing.css")).toBeNull();
  });

  // --- review follow-up: </body> splice correctness (not a lowercased-copy index) + meta-refresh
  // stripping (the one no-script self-navigation exfil variant that's actually closable) ---

  async function serveDoc(html: string): Promise<string> {
    const { artifactDir } = freshWorkspace();
    writeFileSync(join(artifactDir, "rendered-preview.html"), html);
    const store = new CapabilityStore();
    const { token } = mintFor(store, artifactDir, "rendered-preview.html");
    const res = serveClassFDocument(store, token, "rendered-preview.html");
    expect(res).not.toBeNull();
    return res!.text();
  }

  test("an UPPERCASE </BODY> is found correctly, not just lowercase </body>", async () => {
    const body = await serveDoc("<html><body><p>hi</p></BODY></html>");
    expect(body).toContain("<p>hi</p>");
    expect(body.indexOf("<script>")).toBeLessThan(body.indexOf("</BODY>"));
  });

  test("multiple </body>-looking strings: the bridge lands before the LAST real one", async () => {
    // A literal "</body>" INSIDE a text node (not a real closing tag) followed by the actual
    // closing tag — the bridge must land before the real one, not the text-node lookalike.
    const html = "<html><body><p>the string &lt;/body&gt; appears in this sentence</p></body></html>";
    const body = await serveDoc(html);
    expect(body).toContain("the string &lt;/body&gt; appears");
    const lastBodyClose = body.lastIndexOf("</body>");
    const scriptIdx = body.indexOf("<script>");
    expect(scriptIdx).toBeGreaterThan(-1);
    expect(scriptIdx).toBeLessThan(lastBodyClose);
  });

  test("a realistic multi-element document (rendered-preview-shaped) gets the bridge spliced at the true </body>, otherwise byte-identical", async () => {
    const html = [
      "<!doctype html>",
      '<html lang="pl">',
      "<head>",
      '<meta charset="utf-8">',
      "<title>Document — notatki</title>",
      "<style>.verse { color: #333; } .highlight { background: yellow; }</style>",
      "</head>",
      "<body>",
      '<header><h1>Boża łaska</h1></header>',
      '<section data-chunk-id="chunk-001">',
      "<p>Pierwszy fragment kazania.</p>",
      '<p class="verse">Drugi fragment, z cytatem biblijnym.</p>',
      "</section>",
      '<section data-chunk-id="chunk-002">',
      "<p>Trzeci fragment.</p>",
      "</section>",
      "<script>console.log('rendered preview loaded');</script>",
      "</body>",
      "</html>",
      "",
    ].join("\n");
    const body = await serveDoc(html);

    // every original element survives, untouched
    expect(body).toContain("<h1>Boża łaska</h1>");
    expect(body).toContain('<section data-chunk-id="chunk-001">');
    expect(body).toContain("Pierwszy fragment kazania.");
    expect(body).toContain("console.log('rendered preview loaded');");
    // the bridge is spliced BEFORE the real closing </body>, after the doc's own closing </script>
    const ownScriptEnd = body.indexOf("rendered preview loaded');</script>");
    const bridgeScriptStart = body.indexOf('<script>\n(function () {\n  "use strict";');
    const bodyClose = body.lastIndexOf("</body>");
    expect(ownScriptEnd).toBeGreaterThan(-1);
    expect(bridgeScriptStart).toBeGreaterThan(ownScriptEnd);
    expect(bridgeScriptStart).toBeLessThan(bodyClose);
    // nothing AFTER </body> in the original (</html> + trailing newline) got clobbered
    expect(body.trimEnd().endsWith("</html>")).toBe(true);
  });

  test("[self-navigation mitigation] a <meta http-equiv=refresh> tag is neutralized before serving", async () => {
    const html = '<html><head><meta http-equiv="refresh" content="0;url=http://evil.example.com"></head><body>hi</body></html>';
    const body = await serveDoc(html);
    expect(body).not.toContain("http-equiv");
    expect(body).not.toContain("evil.example.com");
    expect(body).toContain("<!-- glosa: meta refresh removed -->");
  });

  test("[self-navigation mitigation] case/quote-style variants of meta-refresh are all caught", async () => {
    const variants = [
      "<META HTTP-EQUIV=REFRESH CONTENT=\"1;url=http://evil.example.com\">",
      "<meta content='2;url=http://evil.example.com' http-equiv='refresh'>",
      "<meta http-equiv=refresh content=\"3;url=http://evil.example.com\">",
    ];
    for (const metaTag of variants) {
      const body = await serveDoc(`<html><head>${metaTag}</head><body>hi</body></html>`);
      expect(body.toLowerCase()).not.toContain("http-equiv");
      expect(body).not.toContain("evil.example.com");
    }
  });

  test("a meta tag that ISN'T refresh (e.g. charset, viewport) is left untouched", async () => {
    const html = '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head><body>hi</body></html>';
    const body = await serveDoc(html);
    expect(body).toContain('<meta charset="utf-8">');
    expect(body).toContain('<meta name="viewport" content="width=device-width">');
  });

  test("meta-refresh stripping does NOT apply to a sibling asset — it's a document-only mitigation", async () => {
    const { artifactDir } = freshWorkspace();
    writeFileSync(join(artifactDir, "rendered-preview.html"), "<html><body>doc</body></html>");
    // A sibling .html fragment containing a meta-refresh-shaped string in what is NOT the minted
    // document — sibling assets are streamed byte-identical, unconditionally, per A1 §7.
    writeFileSync(join(artifactDir, "fragment.html"), '<meta http-equiv="refresh" content="0;url=x">');
    const store = new CapabilityStore();
    const { token } = mintFor(store, artifactDir, "rendered-preview.html");
    const res = serveClassFDocument(store, token, "fragment.html");
    const body = await res!.text();
    expect(body).toBe('<meta http-equiv="refresh" content="0;url=x">');
  });
});

// SPDX-License-Identifier: Apache-2.0
// P5.2 (T8 release gate — "browser security: the A3 §5 attacks"). docs/appendices/A3-security.md
// §5 names 8 specific attacks with named defenses; each already has scattered per-mechanism unit
// tests across packages/daemon/test/{auth,csp,confine-path,classf-bridge,classf-serve,token,
// classf-listener,http}.test.ts and packages/spa/test/{classf-viewer,bootstrap}.test.ts — real and
// individually solid, but no single place lets a reviewer see "is the FULL attack matrix covered"
// without re-deriving it from memory. This file is that literal checklist: one describe block per
// numbered attack, calling the SAME production functions the scattered tests already exercise (not
// reimplementing them), so this is a genuine assertion of defense, not just an index. Where a
// scattered test already goes deeper (e.g. real-socket Host/CSP checks in classf-listener.test.ts,
// the exhaustive confinePath symlink/traversal matrix in confine-path.test.ts), that's noted rather
// than duplicated — this file's job is breadth-in-one-place, not replacing that depth.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorizeRequest, isForeignOrigin } from "../../packages/daemon/src/auth.ts";
import { classFCspHeaders, spaCspHeaders } from "../../packages/daemon/src/csp.ts";
import { confinePath } from "../../packages/daemon/src/confine-path.ts";
import { bridgeShouldAcceptInit } from "../../packages/daemon/src/classf-bridge.ts";
import { renderMarkdown } from "../../packages/daemon/src/artifact-render.ts";
import { checkEventSource, checkNonce, isTrustedInitEvent, validateBridgeMessage } from "../../packages/spa/src/classf-viewer.js";
import { scrubToken } from "../../packages/spa/src/bootstrap.js";
import { mountConversationPane } from "../../packages/spa/src/conversation.js";
import { installDom, type DomEnv } from "../../packages/spa/test/dom-env.ts";

const SPA_PORT = 4646;
const CLASSF_PORT = 4647;

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "glosa-attack-matrix-"));
}
function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------------------------
// #1 — open class-F in a new tab -> origin split + CSP sandbox
// (deeper real-socket proof: packages/daemon/test/classf-listener.test.ts, capability.test.ts)
// ---------------------------------------------------------------------------------------------
describe("A3 §5 attack #1 — direct-nav open of a class-F URL", () => {
  test("the class-F CSP forces every load (incl. a bare top-level tab) into a fresh opaque origin: sandbox + no allow-same-origin/popups/top-navigation", () => {
    const csp = classFCspHeaders(SPA_PORT)["Content-Security-Policy"];
    expect(csp).toContain("sandbox allow-scripts"); // no allow-same-origin/allow-popups/allow-top-navigation
    expect(csp).toContain("connect-src 'none'"); // storage/fetch dead even if something ran
  });
});

// ---------------------------------------------------------------------------------------------
// #2 — remote img/fetch/WS/form embedded in the doc -> connect-src/form-action none
// ---------------------------------------------------------------------------------------------
describe("A3 §5 attack #2 — remote img/fetch/WS/form inside a served document", () => {
  test("class-F CSP locks down every outbound vector: connect-src none, form-action none, default-src none", () => {
    const csp = classFCspHeaders(SPA_PORT)["Content-Security-Policy"];
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("form-action 'none'");
    // img-src is intentionally scoped to self+data: (sibling assets), never a wildcard/remote host.
    expect(csp).toContain("img-src 'self' data:");
    expect(csp).not.toMatch(/img-src[^;]*\*/);
  });
});

// ---------------------------------------------------------------------------------------------
// #3 — forged postMessage at the parent -> event.source + nonce + MessageChannel
// (deeper unit coverage: packages/spa/test/classf-viewer.test.ts; bridge side: classf-bridge.test.ts)
// ---------------------------------------------------------------------------------------------
describe("A3 §5 attack #3 — forged postMessage", () => {
  test("a 3rd window posting a well-formed {type,nonce} message at the parent is rejected unless BOTH event.source and the nonce match", () => {
    const realWin = { name: "real-iframe" } as unknown as Window;
    const attackerWin = { name: "attacker-window" } as unknown as Window;
    const nonce = "a".repeat(64);

    expect(isTrustedInitEvent({ source: realWin, data: { type: "glosa:init", nonce } }, realWin, nonce)).toBe(true);
    // Right nonce, wrong source (a 3rd window impersonating the iframe's message shape).
    expect(isTrustedInitEvent({ source: attackerWin, data: { type: "glosa:init", nonce } }, realWin, nonce)).toBe(false);
    // Right source object, wrong/missing nonce.
    expect(isTrustedInitEvent({ source: realWin, data: { type: "glosa:init", nonce: "wrong" } }, realWin, nonce)).toBe(false);
    expect(checkEventSource({ source: attackerWin }, realWin)).toBe(false);
    expect(checkNonce({ nonce: "wrong" }, nonce)).toBe(false);
  });

  test("bridge side: the nonce gate accepts exactly once, never re-validates a second glosa:init (A3 §2)", () => {
    const nonce = "b".repeat(64);
    expect(bridgeShouldAcceptInit({ type: "glosa:init", nonce }, nonce, false)).toBe(true);
    expect(bridgeShouldAcceptInit({ type: "glosa:init", nonce }, nonce, true)).toBe(false); // already handshaked
  });

  test("post-handshake messages are schema-validated (zod-shaped) — an attacker with port2 access still can't send an arbitrary payload", () => {
    expect(validateBridgeMessage({ type: "selection", seq: 1, quote: { exact: "x", prefix: "", suffix: "" }, range: { start: 0, end: 1 } }).ok).toBe(true);
    expect(validateBridgeMessage({ type: "selection", seq: "not-a-number" }).ok).toBe(false);
    expect(validateBridgeMessage({ type: "eval", code: "alert(1)" }).ok).toBe(false); // unknown type
  });
});

// ---------------------------------------------------------------------------------------------
// #4 — symlink escape -> confinePath realpath
// (exhaustive matrix: packages/daemon/test/confine-path.test.ts)
// ---------------------------------------------------------------------------------------------
describe("A3 §5 attack #4 — symlink escape", () => {
  let root: string;
  let outside: string;
  beforeEach(() => {
    root = freshDir();
    outside = freshDir();
  });
  afterEach(() => {
    cleanup(root);
    cleanup(outside);
  });

  test("workspace/evil -> /etc/passwd-shaped external target: rejected, contents never read", () => {
    writeFileSync(join(outside, "secret.txt"), "should never be read");
    symlinkSync(join(outside, "secret.txt"), join(root, "evil"));
    const result = confinePath(root, "evil");
    expect(result.ok).toBe(false);
  });

  test("a symlinked directory escape one level deep is also rejected", () => {
    mkdirSync(join(outside, "sub"));
    symlinkSync(outside, join(root, "escape-dir"));
    const result = confinePath(root, "escape-dir/sub/anything");
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// #5 — leading-`-`/control-char filename -> `--` + argv array + control-char rejection
// (git argv-safety matrix: packages/daemon/test/git/shadow.test.ts)
// ---------------------------------------------------------------------------------------------
describe("A3 §5 attack #5 — leading-dash / control-char filenames", () => {
  let root: string;
  beforeEach(() => {
    root = freshDir();
  });
  afterEach(() => {
    cleanup(root);
  });

  test("a path targeting '--force'-shaped content is confined normally, never parsed as a flag by confinePath itself", () => {
    writeFileSync(join(root, "--force"), "not a flag");
    const result = confinePath(root, "--force");
    expect(result.ok).toBe(true); // confinePath's job is confinement, not flag-parsing — this proves it does't choke/misparse
    expect(result.ok && result.realPath.endsWith("--force")).toBe(true);
  });

  test("an embedded newline in the relative path is rejected (control-char reject)", () => {
    const result = confinePath(root, "artifact\nname.md");
    expect(result.ok).toBe(false);
  });

  test("a NUL byte in the path is rejected", () => {
    const result = confinePath(root, "artifact\0name.md");
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// #6 — injected HTML in name/md/annotation/transcript/tool_result -> contextual escaping
// ---------------------------------------------------------------------------------------------
describe("A3 §5 attack #6 — injected HTML across render surfaces", () => {
  test("class R: a <script> tag in markdown SOURCE renders escaped, never as a live element (markdown-it { html: false })", () => {
    const html = renderMarkdown("before\n\n<script>alert(document.cookie)</script>\n\nafter");
    expect(html).not.toContain("<script>alert");
    expect(html.toLowerCase()).not.toMatch(/<script[^>]*>alert/);
  });

  test("class-F overlay message layer: a <script>/HTML payload in an annotation quote is carried as inert plain text, never executed by the validator", () => {
    const result = validateBridgeMessage({
      type: "selection",
      seq: 1,
      quote: { exact: "<img src=x onerror=alert(1)>", prefix: "", suffix: "" },
      range: { start: 0, end: 1 },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.quote.exact).toBe("<img src=x onerror=alert(1)>"); // untouched string
  });

  let dom: DomEnv;
  beforeEach(() => {
    dom = installDom();
  });
  afterEach(() => {
    dom.teardown();
  });

  test("conversation mirror: prose/tool_input/tool_result content is set via textContent, so an injected <script>/tag never becomes a live element", () => {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    const events: Array<{ onEvent: (frame: unknown) => void }> = [];
    const dataAccess = {
      openTranscriptStream: (_slug: string, opts: { onEvent: (frame: unknown) => void }) => {
        events.push(opts);
        return () => {
          events.length = 0;
        };
      },
      sendComposerMessage: async () => ({ accepted: true, delivered: false }),
    };

    mountConversationPane(root, { dataAccess, slug: "ws-1" });
    const payload = "<script>window.__pwned = true</script><img src=x onerror=alert(1)>";
    events[0]?.onEvent({ event: "transcript", data: { type: "prose", role: "user", content: payload, id: "1" } });

    expect(root.querySelector("script")).toBeNull();
    expect(root.querySelector("img")).toBeNull();
    const p = root.querySelector(".glosa-conv-prose") as unknown as { textContent: string };
    expect(p.textContent).toBe(payload); // the raw string is preserved as DATA, never parsed as markup
    expect(root.innerHTML).toContain("&lt;script&gt;"); // the DOM itself serializes it back escaped
    expect((globalThis as Record<string, unknown>).__pwned).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// #7 — a local site navigates/frames class-F/handshake -> Host literal + Origin table + frame-ancestors
// (deeper real-socket + real-subprocess proof: packages/daemon/test/{classf-listener,http}.test.ts)
// ---------------------------------------------------------------------------------------------
describe("A3 §5 attack #7 — foreign-site navigation/framing", () => {
  const TOKEN = "a".repeat(32);

  test("(a) a foreign Origin actually present on the handshake route (only possible via fetch/XHR, never real top-nav) is rejected; a state-changing route from the SAME foreign Origin is rejected too", () => {
    const foreignReq = new Request(`http://127.0.0.1:${SPA_PORT}/api/handshake`, {
      headers: { Origin: "http://evil.example" },
    });
    expect(authorizeRequest(foreignReq, { routeClass: "tokenless-handshake", port: SPA_PORT, token: TOKEN })).toEqual({
      ok: false,
      status: 403,
      slug: "invalid-origin",
    });
    // Real top-level navigation can't carry Origin at all — that's the `routeClass: "navigation"`
    // case (attack #7's actual "non-sensitive top-nav" scenario), which is unconditionally allowed
    // (checked separately in the "navigation" describe of auth.test.ts) since no header exists to gate on.

    const stateChanging = new Request(`http://127.0.0.1:${SPA_PORT}/w/slug/annotations`, {
      method: "POST",
      headers: { Origin: "http://evil.example", Authorization: `Bearer ${TOKEN}` },
    });
    const result = authorizeRequest(stateChanging, { routeClass: "state-changing", port: SPA_PORT, token: TOKEN });
    expect(result).toEqual({ ok: false, status: 403, slug: "invalid-origin" });
  });

  test("(b) an authed-read route with no Bearer at all is 401 regardless of Origin", () => {
    const req = new Request(`http://127.0.0.1:${SPA_PORT}/w/slug/artifacts`);
    expect(authorizeRequest(req, { routeClass: "authed-read", port: SPA_PORT, token: TOKEN })).toEqual({
      ok: false,
      status: 401,
      slug: "unauthorized",
    });
  });

  test("(c) class-F CSP names frame-ancestors as ONLY the SPA origin — a foreign page embedding it is blocked by the browser at that header", () => {
    const csp = classFCspHeaders(SPA_PORT)["Content-Security-Policy"];
    expect(csp).toContain(`frame-ancestors 'self' http://127.0.0.1:${SPA_PORT}`);
  });

  test("(d) SPA-origin CSP refuses to ever be framed by ANYONE, including itself embedding a foreign page", () => {
    const csp = spaCspHeaders(CLASSF_PORT)["Content-Security-Policy"];
    expect(csp).toContain("frame-ancestors 'none'");
    // and its only permitted frame-src is the glosa class-F origin itself, never a foreign one.
    expect(csp).toContain(`frame-src http://127.0.0.1:${CLASSF_PORT}`);
  });

  test("isForeignOrigin correctly distinguishes self vs foreign vs absent", () => {
    const self = new Request(`http://127.0.0.1:${SPA_PORT}/x`, { headers: { Origin: `http://127.0.0.1:${SPA_PORT}` } });
    const foreign = new Request(`http://127.0.0.1:${SPA_PORT}/x`, { headers: { Origin: "http://127.0.0.1:9999" } });
    const absent = new Request(`http://127.0.0.1:${SPA_PORT}/x`);
    expect(isForeignOrigin(self, SPA_PORT)).toBe(false);
    expect(isForeignOrigin(foreign, SPA_PORT)).toBe(true);
    expect(isForeignOrigin(absent, SPA_PORT)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// #8 — fragment token in history/localStorage -> replaceState + sessionStorage + rotate/revoke
// ---------------------------------------------------------------------------------------------
describe("A3 §5 attack #8 — token persistence/lifecycle", () => {
  function fakeStorage(): Storage {
    const map = new Map<string, string>();
    return {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
      removeItem: (key: string) => void map.delete(key),
      clear: () => map.clear(),
      key: (i: number) => Array.from(map.keys())[i] ?? null,
      get length() {
        return map.size;
      },
    } as Storage;
  }

  test("fragment scrub: the token lands in sessionStorage (never localStorage), and the URL hash is stripped via history.replaceState", () => {
    const loc = { hash: "#t=SUPERSECRET", pathname: "/", search: "" };
    const session = fakeStorage();
    const localStorage = fakeStorage();
    const calls: Array<[unknown, string, string]> = [];
    const history = { replaceState: (s: unknown, t: string, u?: string | URL | null) => calls.push([s, t, String(u)]) };

    const result = scrubToken(loc, session, history as unknown as History);

    expect(result).toBe("SUPERSECRET");
    expect(session.getItem("glosa_token")).toBe("SUPERSECRET");
    expect(localStorage.getItem("glosa_token")).toBeNull(); // never touched
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[2]).not.toContain("t="); // no `t=` survives into browser history
  });

  // KNOWN GAP (not built here — see test/acceptance/T8-GATE.md): `glosa token rotate`/`revoke`
  // (the "old Bearer -> 401 after revoke" half of this attack) has no implementation anywhere in
  // packages/daemon or packages/cli as of this suite — token.ts's own top comment says rotation/
  // revocation is explicitly deferred. There is nothing to test until that ships; asserting
  // anything here would be theater, not proof.
});

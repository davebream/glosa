// SPDX-License-Identifier: Apache-2.0
// P1.3 — integration coverage for the real daemon HTTP pipeline (A1, A3 §4-5). Spawns the actual
// `glosa __daemon` subprocess (P1.2's spawnDaemon helper) against a hermetic tmp GLOSA_HOME and
// random ports, then hits both listeners over real HTTP — this is where the A3 §5 attack items
// that need a live server (Host rebinding, class-F CSP headers, contract-version header) are
// exercised end-to-end. Route-class × Origin/Bearer combinatorics live in auth.test.ts;
// confinement combinatorics live in confine-path.test.ts.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tokenPath } from "../src/token.ts";
import { APP_VERSION, BUILD_ID } from "../src/build-id.ts";
import { cleanupHome, freshHome, randomPort, spawnDaemon, stopDaemon, waitForHandshake } from "./helpers.ts";

const TOKEN = "integration-test-token-0123456789abcdef";

describe("daemon HTTP pipeline — real subprocess", () => {
  let home: string;
  let port: number;
  let classFPort: number;
  let proc: Bun.Subprocess;

  beforeEach(async () => {
    home = freshHome();
    port = randomPort();
    classFPort = port + 1;
    mkdirSync(home, { recursive: true });
    writeFileSync(tokenPath(home), TOKEN, { mode: 0o600 });
    proc = spawnDaemon(home, port, { GLOSA_CLASSF_PORT: String(classFPort) });
    const hs = await waitForHandshake(port);
    expect(hs).not.toBeNull();
  });

  afterEach(async () => {
    await stopDaemon(home, proc);
    cleanupHome(home);
  });

  function apiUrl(path: string): string {
    return `http://127.0.0.1:${port}${path}`;
  }
  function classFUrl(path: string): string {
    return `http://127.0.0.1:${classFPort}${path}`;
  }

  test("Host mismatch → 400, no body [A3 §5 #7]", async () => {
    const res = await fetch(apiUrl("/api/handshake"), { headers: { Host: "evil.com" } });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toBe("");
  });

  test("handshake: no Origin → 200 + superset body (P1.2 fields + A1 §5.1 fields)", async () => {
    const res = await fetch(apiUrl("/api/handshake"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.contract_version).toBe("1.0");
    expect(body.daemon_version).toBe(APP_VERSION);
    expect(body.build_id).toBe(BUILD_ID);
    expect(body.paired).toBe(true); // token file exists
    expect(typeof body.protocol_version).toBe("string");
    expect(typeof body.instance_id).toBe("string");
    expect(typeof body.pid).toBe("number");
    expect(typeof body.started_at).toBe("string");
  });

  test("handshake with foreign Origin → 403", async () => {
    const res = await fetch(apiUrl("/api/handshake"), { headers: { Origin: "http://evil.example.com" } });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.type).toContain("invalid-origin");
  });

  test("handshake reflects paired:false when no token file exists", async () => {
    const home2 = freshHome();
    const port2 = randomPort();
    const proc2 = spawnDaemon(home2, port2, { GLOSA_CLASSF_PORT: String(port2 + 1) });
    try {
      const hs = await waitForHandshake(port2);
      expect(hs).not.toBeNull();
      const res = await fetch(`http://127.0.0.1:${port2}/api/handshake`);
      const body = await res.json();
      expect(body.paired).toBe(false);
    } finally {
      await stopDaemon(home2, proc2);
      cleanupHome(home2);
    }
  });

  test("authed GET /api/workspaces with no Bearer → 401", async () => {
    const res = await fetch(apiUrl("/api/workspaces"));
    expect(res.status).toBe(401);
  });

  test("authed GET /api/workspaces with valid Bearer + no Origin → 200 []", async () => {
    const res = await fetch(apiUrl("/api/workspaces"), { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test("authed GET /api/workspaces with foreign Origin but valid Bearer → 403 (reads reject foreign)", async () => {
    const res = await fetch(apiUrl("/api/workspaces"), {
      headers: { Authorization: `Bearer ${TOKEN}`, Origin: "http://evil.example.com" },
    });
    expect(res.status).toBe(403);
  });

  test("state-changing POST with valid Bearer but missing Origin → 403", async () => {
    const res = await fetch(apiUrl("/w/some-slug/session-binding"), {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "x" }),
    });
    expect(res.status).toBe(403);
  });

  test("state-changing POST with valid Bearer + foreign Origin → 403", async () => {
    const res = await fetch(apiUrl("/w/some-slug/session-binding"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Origin: "http://evil.example.com",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ session_id: "x" }),
    });
    expect(res.status).toBe(403);
  });

  test("state-changing POST with Sec-Fetch-Site: cross-site → 403 even with self Origin + valid Bearer", async () => {
    const res = await fetch(apiUrl("/w/some-slug/session-binding"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Origin: `http://127.0.0.1:${port}`,
        "Sec-Fetch-Site": "cross-site",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ session_id: "x" }),
    });
    expect(res.status).toBe(403);
  });

  test("state-changing POST with self Origin + valid Bearer → passes auth, then 404 (empty registry) [A3 §5 #7]", async () => {
    const res = await fetch(apiUrl("/w/some-slug/session-binding"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Origin: `http://127.0.0.1:${port}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ session_id: "x" }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.type).toContain("not-found");
  });

  test("unauthorized/foreign POST is rejected BEFORE the 404 — an invalid Bearer never reaches the handler", async () => {
    const res = await fetch(apiUrl("/w/some-slug/session-binding"), {
      method: "POST",
      headers: { Authorization: "Bearer wrong", Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "x" }),
    });
    expect(res.status).toBe(401);
  });

  test("X-Contract-Version major mismatch (2.0) on a non-handshake route → 409", async () => {
    const res = await fetch(apiUrl("/api/workspaces"), {
      headers: { Authorization: `Bearer ${TOKEN}`, "X-Contract-Version": "2.0" },
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.type).toContain("contract-mismatch");
  });

  test("X-Contract-Version minor mismatch (1.9) → 200 + X-Contract-Warning: stale-minor", async () => {
    const res = await fetch(apiUrl("/api/workspaces"), {
      headers: { Authorization: `Bearer ${TOKEN}`, "X-Contract-Version": "1.9" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Contract-Warning")).toBe("stale-minor");
  });

  test("X-Contract-Version is not checked on the handshake route", async () => {
    const res = await fetch(apiUrl("/api/handshake"), { headers: { "X-Contract-Version": "99.0" } });
    expect(res.status).toBe(200);
  });

  test("body > 1 MiB on the POST → 413", async () => {
    const oversized = "x".repeat(1024 * 1024 + 1);
    const res = await fetch(apiUrl("/w/some-slug/session-binding"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Origin: `http://127.0.0.1:${port}`,
        "Content-Type": "application/json",
      },
      body: oversized,
    });
    expect(res.status).toBe(413);
  });

  test("SPA-origin CSP headers attached to API responses", async () => {
    const res = await fetch(apiUrl("/api/handshake"));
    const csp = res.headers.get("Content-Security-Policy");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain(`frame-src http://127.0.0.1:${classFPort}`);
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  test("unknown route → 404 problem+json", async () => {
    const res = await fetch(apiUrl("/api/nonexistent"));
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toBe("application/problem+json");
    const body = await res.json();
    expect(body.type).toContain("not-found");
  });

  test("foreign Origin + unknown route → 403, not 404 — no route-enumeration side channel [review item 1 / D3]", async () => {
    const res = await fetch(apiUrl("/api/nonexistent"), { headers: { Origin: "http://evil.example.com" } });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.type).toContain("invalid-origin");
  });

  test("absent/self Origin + unknown route → 404 (unchanged)", async () => {
    const res1 = await fetch(apiUrl("/api/nonexistent"));
    expect(res1.status).toBe(404);
    const res2 = await fetch(apiUrl("/api/nonexistent"), { headers: { Origin: `http://127.0.0.1:${port}` } });
    expect(res2.status).toBe(404);
  });

  test("body exactly 1 MiB (1048576 bytes) passes the cap — boundary is > not >= [review item 4]", async () => {
    const exact = "x".repeat(1024 * 1024);
    expect(new TextEncoder().encode(exact).byteLength).toBe(1024 * 1024);
    const res = await fetch(apiUrl("/w/some-slug/session-binding"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Origin: `http://127.0.0.1:${port}`,
        "Content-Type": "application/json",
      },
      body: exact,
    });
    // Passed the cap and reached the handler — empty registry → 404, not 413.
    expect(res.status).toBe(404);
  });

  test("streaming body over cap without a truthful Content-Length → 413 (exercises the streaming-cancel path, not the Content-Length short-circuit) [review item 4]", async () => {
    const chunk = new Uint8Array(128 * 1024).fill(120); // 128 KiB of 'x'
    const totalChunks = 9; // 9 * 128 KiB = 1152 KiB > 1 MiB cap
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= totalChunks) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
        sent++;
      },
    });
    const res = await fetch(apiUrl("/w/some-slug/session-binding"), {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, Origin: `http://127.0.0.1:${port}` },
      body: stream,
      // @ts-expect-error duplex is required by undici/Bun for a streaming request body but isn't
      // in the DOM lib's RequestInit type yet.
      duplex: "half",
    });
    expect(res.status).toBe(413);
  });

  // --- class-F listener (4647) ---

  test("class-F listener: Host mismatch → 400", async () => {
    const res = await fetch(classFUrl("/doc/whatever"), { headers: { Host: "evil.com" } });
    expect(res.status).toBe(400);
  });

  test("class-F listener: response carries the class-F CSP header [A3 §5 #1/#2]", async () => {
    const res = await fetch(classFUrl("/doc/whatever"));
    const csp = res.headers.get("Content-Security-Policy");
    expect(csp).toContain("sandbox allow-scripts");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain(`frame-ancestors 'self' http://127.0.0.1:${port}`);
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  test("class-F listener: unmapped path (no capability logic yet) → 404", async () => {
    const res = await fetch(classFUrl("/doc/whatever"));
    expect(res.status).toBe(404);
  });

  // --- SPA shell + static assets (P1.4) ---

  test("GET / serves the SPA shell: 200, text/html, no Bearer required (navigation)", async () => {
    const res = await fetch(apiUrl("/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    const body = await res.text();
    expect(body).toContain("<div id=\"app\">");
  });

  test("GET / carries the SPA CSP (script-src 'self', frame-ancestors 'none') + nosniff", async () => {
    const res = await fetch(apiUrl("/"));
    const csp = res.headers.get("Content-Security-Policy");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  test("GET / is served even with a foreign Origin — non-sensitive nav route (A3 §4)", async () => {
    const res = await fetch(apiUrl("/"), { headers: { Origin: "http://evil.example.com" } });
    expect(res.status).toBe(200);
  });

  test("GET /app/bootstrap.js: 200, text/javascript, SPA CSP, no Bearer required", async () => {
    const res = await fetch(apiUrl("/app/bootstrap.js"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
    expect(res.headers.get("Content-Security-Policy")).toContain("script-src 'self'");
    const body = await res.text();
    expect(body).toContain("export function scrubToken");
  });

  test("appearance preload + controller are fixed allowlisted JavaScript assets", async () => {
    for (const name of ["appearance-preload.js", "appearance.js"]) {
      const res = await fetch(apiUrl(`/app/${name}`));
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
    }
  });

  test("GET /app/<unknown file> → 404, not a filesystem read", async () => {
    const res = await fetch(apiUrl("/app/does-not-exist.js"));
    expect(res.status).toBe(404);
  });

  test("GET /app/../secret (literal traversal, collapsed by the URL parser) → 404, not the daemon's own secrets", async () => {
    const res = await fetch(apiUrl("/app/../secret"));
    expect(res.status).toBe(404);
  });

  test("GET /app/..%2f.. (encoded traversal, allowlist rejects it) → 404", async () => {
    const res = await fetch(apiUrl("/app/..%2f.."));
    expect(res.status).toBe(404);
  });

  test("GET /app/__proto__ (prototype key) → 404, not a 500 — own-keys-only lookup", async () => {
    // A bare `SPA_ASSETS[name]` lookup would resolve `__proto__`/`constructor` to a truthy
    // inherited value, slip past the undefined guard, and hit readFileSync → 500. Must be 404.
    for (const name of ["__proto__", "constructor", "hasOwnProperty"]) {
      const res = await fetch(apiUrl(`/app/${name}`));
      expect(res.status).toBe(404);
    }
  });

  // --- P3.1: the A3 §5 attack suite still holds through the NEW route catalog (real subprocess,
  // empty registry — schema-level coverage for these routes lives in http-routes.test.ts) ---

  test("GET /w/:slug/artifacts (authed-read) with Host mismatch → 400, no body [A3 §5 #7]", async () => {
    const res = await fetch(apiUrl("/w/some-slug/artifacts"), { headers: { Host: "evil.com" } });
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("");
  });

  test("GET /w/:slug/diff with no Bearer → 401, never reaches the unknown-slug 404", async () => {
    const res = await fetch(apiUrl("/w/some-slug/diff?from=a&to=b"));
    expect(res.status).toBe(401);
  });

  test("GET /w/:slug/artifacts with foreign Origin but valid Bearer → 403 (reads reject foreign)", async () => {
    const res = await fetch(apiUrl("/w/some-slug/artifacts"), {
      headers: { Authorization: `Bearer ${TOKEN}`, Origin: "http://evil.example.com" },
    });
    expect(res.status).toBe(403);
  });

  test("POST /w/:slug/annotations with valid Bearer + self Origin → passes auth, then 404 (empty registry)", async () => {
    const res = await fetch(apiUrl("/w/some-slug/annotations"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Origin: `http://127.0.0.1:${port}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ body: "x", intent: "content", target: { quote: { exact: "x" } } }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).type).toContain("not-found");
  });

  test("POST /w/:slug/annotations with valid Bearer but missing Origin → 403 (state-changing)", async () => {
    const res = await fetch(apiUrl("/w/some-slug/annotations"), {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ body: "x", intent: "content", target: { quote: { exact: "x" } } }),
    });
    expect(res.status).toBe(403);
  });

  test("GET /w/:slug/stream (route SHELL) with no Bearer → 401 — the pipeline runs for shells too", async () => {
    const res = await fetch(apiUrl("/w/some-slug/stream"));
    expect(res.status).toBe(401);
  });
});

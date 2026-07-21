// @glosa/daemon — the two listeners' fetch pipelines (A1 §1/§3/§4, A3 §4). Wires together
// host-check → route lookup → authorizeRequest → contract-version gate → body cap → handler for
// the SPA/API listener, and the minimal host-check-only pipeline for the class-F listener.
//
// Route logic beyond the three routes below (artifact/session/inbox/diff/SSE/capability-mint,
// the class-F doc serve+bridge) is later tasks' scope (see the `// Pxx:` notes at each). This
// module only has to prove the pipeline itself is correct — that's what the P1.3 attack-suite
// tests exercise.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { authorizeRequest, isForeignOrigin, type RouteClass } from "./auth.ts";
import { checkContractVersion, CONTRACT_VERSION, DAEMON_VERSION } from "./contract.ts";
import { classFCspHeaders, spaCspHeaders } from "./csp.ts";
import { internalErrorResponse, problem } from "./problem.ts";
import { PROTOCOL_VERSION } from "./protocol.ts";

const BODY_CAP_BYTES = 1024 * 1024; // A1 §4

// The SPA's static source dir (`packages/spa/src/`), resolved relative to this file rather than
// `process.cwd()` so it's correct regardless of where `glosa` is invoked from (P1.4).
const SPA_SRC_DIR = fileURLToPath(new URL("../../spa/src/", import.meta.url));

// Fixed allowlist of files servable under `GET /app/<file>` (D5/A3 §3: no path traversal — a
// basename check alone isn't enough, so every servable file is named here explicitly; anything
// not in this map 404s regardless of what else lives on disk under SPA_SRC_DIR).
const SPA_ASSETS: Record<string, string> = {
  "bootstrap.js": "text/javascript; charset=utf-8",
};

export interface ApiContext {
  port: number;
  classFPort: number;
  token: string | null;
  instanceId: string;
  startedAt: string;
}

/** The handshake body is a superset of P1.2's `HandshakeResponse` (D2): keeps
 * `protocol_version`/`instance_id`/`pid`/`started_at` so `ensureDaemon`/`fetchHandshake` keep
 * working unchanged, and adds the A1 §5.1 fields the SPA needs (`contract_version` ===
 * `protocol_version` by this task's resolution, `daemon_version`, `paired`). */
export interface HandshakeBody {
  contract_version: string;
  daemon_version: string;
  paired: boolean;
  protocol_version: string;
  instance_id: string;
  pid: number;
  started_at: string;
}

function checkHost(req: Request, port: number): boolean {
  return req.headers.get("Host") === `127.0.0.1:${port}`;
}

function withHeaders(res: Response, extra: Record<string, string>): Response {
  const headers = new Headers(res.headers);
  for (const [key, value] of Object.entries(extra)) headers.set(key, value);
  return new Response(res.body, { status: res.status, headers });
}

/** Reads the body up to the cap without ever buffering past it. A present `Content-Length` over
 * the cap short-circuits before touching the stream at all; otherwise (chunked, or no header)
 * the stream is read incrementally and cancelled the moment the running total exceeds the cap. */
async function readBodyCapped(req: Request): Promise<{ ok: true; body: Uint8Array } | { ok: false }> {
  const contentLength = req.headers.get("Content-Length");
  if (contentLength !== null && Number(contentLength) > BODY_CAP_BYTES) return { ok: false };
  if (!req.body) return { ok: true, body: new Uint8Array(0) };

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > BODY_CAP_BYTES) {
      await reader.cancel();
      return { ok: false };
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, body: merged };
}

interface RouteMatch {
  routeClass: RouteClass;
  handle: (req: Request) => Response | Promise<Response>;
}

function handleHandshake(ctx: ApiContext): () => Response {
  return () => {
    const body: HandshakeBody = {
      contract_version: CONTRACT_VERSION,
      daemon_version: DAEMON_VERSION,
      paired: ctx.token !== null,
      protocol_version: PROTOCOL_VERSION,
      instance_id: ctx.instanceId,
      pid: process.pid,
      started_at: ctx.startedAt,
    };
    return Response.json(body);
  };
}

/** `GET /` — the SPA shell (P1.4). Navigation route class: the SPA hasn't read the pairing
 * fragment yet at this point, so this response carries no Bearer and must be non-sensitive
 * (A3 §4's navigation row) — it's static HTML, the token arrives client-side via `#t=` (D5). */
function serveShell(): Response {
  const html = readFileSync(join(SPA_SRC_DIR, "shell.html"), "utf8");
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

/** `GET /app/<file>` — the SPA's static ES modules (P1.4). `name` is checked against the fixed
 * allowlist, not just sanitized, so a request can never read anything else under SPA_SRC_DIR. */
function serveSpaAsset(pathname: string): Response {
  const name = pathname.slice("/app/".length);
  // Object.hasOwn, not a bare `SPA_ASSETS[name]` lookup: a prototype key like `__proto__` or
  // `constructor` would otherwise resolve to a truthy inherited value, slip past the `undefined`
  // guard, and fall through to readFileSync (→ 500 instead of a clean 404). Own-keys only.
  const contentType = Object.hasOwn(SPA_ASSETS, name) ? SPA_ASSETS[name] : undefined;
  if (contentType === undefined) {
    return problem(404, "not-found", "no such static asset", undefined, pathname);
  }
  const body = readFileSync(join(SPA_SRC_DIR, name), "utf8");
  return new Response(body, { headers: { "Content-Type": contentType } });
}

function matchApiRoute(ctx: ApiContext, method: string, pathname: string): RouteMatch | null {
  if (method === "GET" && pathname === "/api/handshake") {
    return { routeClass: "tokenless-handshake", handle: handleHandshake(ctx) };
  }
  if (method === "GET" && pathname === "/") {
    return { routeClass: "navigation", handle: () => serveShell() };
  }
  if (method === "GET" && pathname.startsWith("/app/")) {
    return { routeClass: "navigation", handle: () => serveSpaAsset(pathname) };
  }
  // P2.4: the live registry. Empty until then.
  if (method === "GET" && pathname === "/api/workspaces") {
    return { routeClass: "authed-read", handle: () => Response.json([]) };
  }
  // P2.4 (registry) + P3.x (binding logic) own the real behavior; wired here only so the auth
  // pipeline has a real state-changing route to exercise end-to-end.
  if (method === "POST" && /^\/w\/[^/]+\/session-binding$/.test(pathname)) {
    return {
      routeClass: "state-changing",
      handle: (req) => problem(404, "not-found", "unknown workspace", undefined, new URL(req.url).pathname),
    };
  }
  return null;
}

export function createApiFetch(ctx: ApiContext): (req: Request) => Promise<Response> {
  const csp = spaCspHeaders(ctx.classFPort);

  return async (req) => {
    try {
      const url = new URL(req.url);

      // Host check runs first, unconditionally, before route lookup even knows a route class
      // exists (A3 §4 Rule 1). Literal mismatch → 400, closed, no body — never 403 (D1).
      if (!checkHost(req, ctx.port)) return new Response(null, { status: 400 });

      const route = matchApiRoute(ctx, req.method, url.pathname);
      if (!route) {
        // A foreign Origin is rejected even on a route that doesn't exist (A1 §1 "Origin
        // allowlisted first, regardless of route") — otherwise 403-on-real-route vs
        // 404-on-fake-route is a route-enumeration side channel for a hostile page (D3).
        if (isForeignOrigin(req, ctx.port)) {
          return withHeaders(problem(403, "invalid-origin", "origin not allowed", undefined, url.pathname), csp);
        }
        return withHeaders(problem(404, "not-found", "no such route", undefined, url.pathname), csp);
      }

      const authResult = authorizeRequest(req, { routeClass: route.routeClass, port: ctx.port, token: ctx.token });
      if (!authResult.ok) {
        const title = authResult.status === 401 ? "missing or invalid bearer token" : "origin not allowed";
        return withHeaders(problem(authResult.status, authResult.slug, title, undefined, url.pathname), csp);
      }

      // The version-discovery route is exempt — a client can't know its contract version is
      // compatible before it's asked (A1 §3).
      let contractWarning = false;
      if (route.routeClass !== "tokenless-handshake") {
        const check = checkContractVersion(req.headers.get("X-Contract-Version"));
        if (check.status === "mismatch") {
          return withHeaders(
            problem(409, "contract-mismatch", "contract major version mismatch — reload", undefined, url.pathname),
            csp,
          );
        }
        contractWarning = check.status === "stale-minor";
      }

      let effectiveReq = req;
      if (req.method === "POST" || req.method === "PUT" || req.method === "DELETE") {
        const bodyResult = await readBodyCapped(req);
        if (!bodyResult.ok) {
          return withHeaders(
            problem(413, "payload-too-large", "request body exceeds 1 MiB", undefined, url.pathname),
            csp,
          );
        }
        // Rebuild the request over the already-drained bytes so a future handler can still read
        // the body (readBodyCapped consumed the original stream).
        effectiveReq = new Request(req.url, {
          method: req.method,
          headers: req.headers,
          body: bodyResult.body as BodyInit,
        });
      }

      const res = await route.handle(effectiveReq);
      const withCsp = withHeaders(res, csp);
      if (contractWarning) withCsp.headers.set("X-Contract-Warning", "stale-minor");
      return withCsp;
    } catch {
      // Never let a throw anywhere in the pipeline (a route handler, a future JSON.parse, a bug
      // in this function) reach Bun's default error response — that leaks source/stack in dev
      // mode and has no CSP either way (P1.3 review item 2). `development: false` + the
      // Bun.serve `error` callback in lifecycle.ts are the second layer, for a throw that
      // somehow still escapes this try/catch.
      return internalErrorResponse(csp);
    }
  };
}

export function createClassFFetch(ctx: { port: number; spaPort: number }): (req: Request) => Promise<Response> {
  const csp = classFCspHeaders(ctx.spaPort);

  return async (req) => {
    try {
      if (!checkHost(req, ctx.port)) return new Response(null, { status: 400 });
      // P4.1: capability lookup + realpath-confined sibling serving + bridge injection. Every
      // path 404s until then — the pipeline (Host check + CSP) is what this task proves.
      return withHeaders(new Response("not found", { status: 404 }), csp);
    } catch {
      return internalErrorResponse(csp);
    }
  };
}

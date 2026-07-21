// @glosa/daemon — the two listeners' fetch pipelines (A1 §1/§3/§4, A3 §4). Wires together
// host-check → route lookup → authorizeRequest → contract-version gate → body cap → handler for
// the SPA/API listener, and the minimal host-check-only pipeline for the class-F listener.
//
// P3.1 fills in the full A1 §5 route catalog on top of the P1.3 pipeline: every `/w/:slug/...`
// route resolves its slug through `ctx.workspaceIndex` (unknown slug → 404) before touching
// anything else, and every `:path`/`:artifactPath` param goes through `confinePath` (A1 §6). Three
// routes (the transcript SSE stream, the class-F capability mint, the attention-response route)
// are still SHELLS — the auth/contract/confinement pipeline runs for real, but the body is a
// `// Pxx:` placeholder until their owning task lands (see `handleNotImplemented`/
// `handleCapabilityShell`). P3.2 replaced the fourth shell, the artifact/journal SSE stream
// (§5.5), with the real thing — see `handleStream`/stream.ts.
import { existsSync, readFileSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { authorizeRequest, isForeignOrigin, type RouteClass } from "./auth.ts";
import { checkContractVersion, CONTRACT_VERSION, DAEMON_VERSION } from "./contract.ts";
import { classFCspHeaders, spaCspHeaders } from "./csp.ts";
import { confinePath } from "./confine-path.ts";
import { internalErrorResponse, problem } from "./problem.ts";
import { PROTOCOL_VERSION } from "./protocol.ts";
import { resolveMatchedFiles } from "./matcher.ts";
import { classifyArtifactPath, renderMarkdown, sourceSha256 } from "./artifact-render.ts";
import { buildDiffHunks, commitExists } from "./checkpoint-diff.ts";
import { createJournalStreamResponse } from "./stream.ts";
import type { WorkspaceIndex } from "./registry/workspace-index.ts";
import type { SessionRegistry } from "./registry/session-registry.ts";
import type { WorkspaceBus } from "./bus/bus.ts";
import { journalPath } from "./bus/paths.ts";
import { createEmptyState, foldEvents, type DerivedState } from "./bus/replay.ts";
import { isTerminal, lifecycleReducer } from "./bus/lifecycle.ts";
import type { JournalEvent } from "./bus/journal.ts";

const BODY_CAP_BYTES = 1024 * 1024; // A1 §4

/** Bun's `fetch` handler is always invoked with `(req, server)` — this is that `server`'s type,
 * aliased here (rather than importing a `bun` global type name) to match the existing
 * `ReturnType<typeof Bun.serve>` convention already used in lifecycle.ts. Optional everywhere it
 * appears below so route-schema-level tests that call `createApiFetch(ctx)`'s returned function
 * directly (no real bound `Bun.serve`, e.g. http-routes.test.ts) don't have to fabricate one —
 * only the stream route (P3.2) actually needs it, for `server.timeout(req, 0)` (A1 §8.3). */
export type BunServer = ReturnType<typeof Bun.serve>;

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
  workspaceIndex: WorkspaceIndex;
  sessionRegistry: SessionRegistry;
  /** Always resolves to the SAME `WorkspaceBus` instance for a given canonical root (backed by
   * the daemon's one `WorkspaceBusRegistry`, see lifecycle.ts's `buildBackend`) — routes never
   * construct their own `WorkspaceBus`. */
  getWorkspaceBus: (canonicalRoot: string) => WorkspaceBus;
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
  handle: (req: Request, server?: BunServer) => Response | Promise<Response>;
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

// -------------------------------------------------------------------------------------------
// P3.1 — A1 §5's `/w/:slug/...` route catalog. Every handler below resolves `:slug` through
// `ctx.workspaceIndex.getBySlug` FIRST (unknown slug → 404 not-found) before doing anything else
// — this is the one gate every workspace-scoped route shares, per the P3.1 task brief ("slug →
// workspace: routes resolve `:slug`... unknown slug → 404").
// -------------------------------------------------------------------------------------------

function workspaceOrNotFound(ctx: ApiContext, slug: string, pathname: string) {
  const entry = ctx.workspaceIndex.getBySlug(slug);
  if (!entry) return { ok: false as const, response: problem(404, "not-found", "unknown workspace", undefined, pathname) };
  return { ok: true as const, entry };
}

/** `GET /api/workspaces` (A1 §5.2) — the live, present-only registry. */
function handleListWorkspaces(ctx: ApiContext): Response {
  const entries = ctx.workspaceIndex.list({ presentOnly: true });
  const body = entries.map((e) => ({
    slug: e.slug,
    path: e.canonical_path,
    last_seen: e.last_seen,
    has_attention: hasOpenAttention(peekJournal(e.canonical_path).state),
  }));
  return Response.json(body);
}

/** A passive, read-only fold over a workspace's journal — deliberately NOT `WorkspaceBus`/
 * `reconcileWorkspace`: those self-heal and checkpoint (real writes, incl. spawning git), which
 * would make a plain GET (workspace listing, inbox summary) have write side effects. This just
 * parses whatever's already durably on disk and folds it with the same production reducer
 * (`lifecycleReducer`) — a malformed line is silently skipped here rather than quarantined; the
 * durable quarantine still happens the first time any WRITE path (`resolveBus` below) reconciles
 * this workspace for real. */
function peekJournal(root: string): { state: DerivedState; createdAt: Map<string, string> } {
  const path = journalPath(root);
  const createdAt = new Map<string, string>();
  if (!existsSync(path)) return { state: createEmptyState(), createdAt };

  const raw = readFileSync(path, "utf8");
  const events: JournalEvent[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // not this read-only peek's job to quarantine — see docstring above
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const p = parsed as Record<string, unknown>;
    if (p.v !== 1 || typeof p.event !== "string" || typeof p.event_id !== "string") continue;
    const event = p as unknown as JournalEvent;
    events.push(event);
    if (event.event === "entry_created" && typeof event.entry === "string" && !createdAt.has(event.entry)) {
      createdAt.set(event.entry, event.at);
    }
  }
  return { state: foldEvents(events, lifecycleReducer), createdAt };
}

function hasOpenAttention(state: DerivedState): boolean {
  return Object.values(state.entries).some((e) => e.kind === "attention" && !isTerminal("attention", e.status));
}

/** Routes that need the LIVE bus (annotations, diff) reconcile the first time they touch a given
 * `WorkspaceBus` INSTANCE, then reuse its already-reconciled in-memory `bus.state` on every later
 * request — `WorkspaceBus.reconcileOnce()` owns that "once per instance" gate itself (P3.1 review
 * fix: an external cache keyed by root string would survive past a `WorkspaceBusRegistry.evict()`
 * + reopen and wrongly skip reconciling the fresh instance underneath it — see reconcileOnce's own
 * docstring in bus.ts). */
async function resolveBus(ctx: ApiContext, root: string): Promise<WorkspaceBus> {
  const bus = ctx.getWorkspaceBus(root);
  await bus.reconcileOnce();
  return bus;
}

/** `GET /w/:slug/artifacts` (A1 §5.3) — the sidebar listing. */
function handleListArtifacts(ctx: ApiContext, slug: string, pathname: string): Response {
  const resolved = workspaceOrNotFound(ctx, slug, pathname);
  if (!resolved.ok) return resolved.response;

  const { tracked } = resolveMatchedFiles(resolved.entry.canonical_path);
  const body = tracked.map((f) => ({
    path: f.path,
    class: classifyArtifactPath(f.path),
    size_bytes: f.sizeBytes,
    mtime: statSync(f.rawPath).mtime.toISOString(),
    source_sha256: sourceSha256(readFileSync(f.rawPath)),
    stale: false, // P6.1: staleness needs derived-from edges, not built yet — always fresh for now
  }));
  return Response.json(body);
}

/** `GET /w/:slug/artifacts/:path` (A1 §5.4). `path` is workspace-relative and must both pass
 * `confinePath` (A1 §6 — traversal/symlink-escape → 400) AND be a currently tracked artifact
 * (matcher membership — confined-but-untracked → 404, a different failure class per §6 step 4). */
function handleGetArtifact(ctx: ApiContext, slug: string, rawPathParam: string, req: Request): Response {
  const url = new URL(req.url);
  const resolved = workspaceOrNotFound(ctx, slug, url.pathname);
  if (!resolved.ok) return resolved.response;
  const root = resolved.entry.canonical_path;

  const confineResult = confinePath(root, rawPathParam);
  if (!confineResult.ok) {
    return problem(400, "invalid-path", "path escapes the workspace or is malformed", undefined, url.pathname);
  }

  const relNfc = rawPathParam
    .split("/")
    .map((segment) => segment.normalize("NFC"))
    .join("/");
  const { tracked } = resolveMatchedFiles(root);
  const match = tracked.find((f) => f.path === relNfc);
  if (!match) return problem(404, "not-found", "path within workspace but no such artifact", undefined, url.pathname);

  const raw = readFileSync(match.rawPath);
  const sourceSha = sourceSha256(raw);
  const cls = classifyArtifactPath(match.path);

  if (cls === "F") {
    // Metadata only — the actual HTML is never served through this route (A1 §5.4/§7); serving it
    // is the class-F capability listener's job (P4.1).
    return Response.json({ source_path: match.path, source_sha256: sourceSha, class: "F" });
  }

  const content = raw.toString("utf8");
  if (url.searchParams.get("render") === "html") {
    return Response.json({
      source_path: match.path,
      source_sha256: sourceSha,
      class: "R",
      content,
      rendered_html: renderMarkdown(content),
    });
  }
  return Response.json({ source_path: match.path, source_sha256: sourceSha, class: "R", content });
}

const ANNOTATION_INTENTS = new Set(["content", "classification", "style"]);

function validateAnnotationBody(body: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, reason: "body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;
  if (typeof b.body !== "string" || b.body.length === 0) return { ok: false, reason: "body.body is required" };
  if (typeof b.intent !== "string" || !ANNOTATION_INTENTS.has(b.intent)) {
    return { ok: false, reason: "body.intent must be one of content|classification|style" };
  }
  const target = b.target;
  if (typeof target !== "object" || target === null || Array.isArray(target)) {
    return { ok: false, reason: "body.target is required" };
  }
  const quote = (target as Record<string, unknown>).quote;
  if (typeof quote !== "object" || quote === null || typeof (quote as Record<string, unknown>).exact !== "string") {
    return { ok: false, reason: "body.target.quote.exact is required" };
  }
  return { ok: true, value: b };
}

/** Matches the A1 §5.6 example id shape (`inb-1721470000-a1c2`) — epoch seconds + 4 hex chars.
 * Not a `ulid()` (that's reserved for journal `event_id`s, A4 §F04) — an inbox entry's own id has
 * no ordering/dedup contract of its own beyond "write-once", so a shorter, spec-matching id is
 * fine here. */
function generateAnnotationId(): string {
  return `inb-${Math.floor(Date.now() / 1000)}-${randomBytes(2).toString("hex")}`;
}

/** `POST /w/:slug/annotations` (A1 §5.6). Persists the annotation as an inbox entry via
 * `WorkspaceBus.createEntry` — honest provenance only: this route creates the entry, it does NOT
 * resolve its anchor (that's P3.4's job, A5 §F10/§F11). */
async function handleCreateAnnotation(ctx: ApiContext, slug: string, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const resolved = workspaceOrNotFound(ctx, slug, url.pathname);
  if (!resolved.ok) return resolved.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return problem(400, "validation-failed", "body must be valid JSON", undefined, url.pathname);
  }
  const validated = validateAnnotationBody(body);
  if (!validated.ok) return problem(400, "validation-failed", validated.reason, undefined, url.pathname);

  const bus = await resolveBus(ctx, resolved.entry.canonical_path);
  const id = generateAnnotationId();
  // Explicitly picked fields ONLY — never spread the raw parsed body. `kind` in particular must
  // stay a server-assigned constant: a client-supplied `kind` (e.g. "attention_request") spread
  // in after this literal would silently clobber it, forging an attention-tray entry through the
  // annotations endpoint.
  await bus.createEntry(id, {
    kind: "annotation",
    body: validated.value.body,
    intent: validated.value.intent,
    target: validated.value.target,
  });

  return new Response(JSON.stringify({ id, status: "pending" }), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  });
}

/** `GET /w/:slug/diff` (A1 §5.7). v1 only implements the `from`/`to` checkpoint-id form — `since`
 * (`last-annotation`|`yesterday`) needs the full checkpoint-history resolution P3.5 owns, so any
 * `since` value 400s for now rather than half-implementing named-token resolution here. */
async function handleDiff(ctx: ApiContext, slug: string, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const resolved = workspaceOrNotFound(ctx, slug, url.pathname);
  if (!resolved.ok) return resolved.response;
  const root = resolved.entry.canonical_path;

  if (url.searchParams.get("since") !== null) {
    // P3.5: `since=last-annotation|yesterday` resolution belongs to the full checkpoint-query UI.
    return problem(400, "validation-failed", "since= is not yet supported — use from=/to=", undefined, url.pathname);
  }
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (!from || !to) {
    return problem(400, "validation-failed", "from and to query params are required", undefined, url.pathname);
  }

  await resolveBus(ctx, root); // ensures the shadow repo exists (if there's anything to check out) before we ask git about it

  const [fromOk, toOk] = await Promise.all([commitExists(root, from), commitExists(root, to)]);
  if (!fromOk || !toOk) {
    return problem(400, "validation-failed", "from/to is not a known checkpoint", undefined, url.pathname);
  }

  const hunks = await buildDiffHunks(root, from, to);
  return Response.json({ from, to, hunks });
}

/** `GET /w/:slug/inbox` (A1 §5.9) — sidebar badge + attention tray summary. `attention[]` lists
 * only attention-kind entries (per A5 §F23's two-axis split — common entries like annotations
 * aren't "attention"); the exact item shape is F12's to finalize, per A1 §5.9. */
function handleInbox(ctx: ApiContext, slug: string, pathname: string): Response {
  const resolved = workspaceOrNotFound(ctx, slug, pathname);
  if (!resolved.ok) return resolved.response;

  const { state, createdAt } = peekJournal(resolved.entry.canonical_path);
  const attention = Object.entries(state.entries)
    .filter(([, e]) => e.kind === "attention" && !isTerminal("attention", e.status))
    .map(([id, e]) => ({ id, created_at: createdAt.get(id) ?? "", status: e.status }))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));

  return Response.json({ pending_count: attention.length, attention });
}

/** `POST /w/:slug/session-binding` (A1 §5.11) — the explicit user pick from the session picker
 * (R2). There's no separate "rebind" mutation on `SessionRegistry`; `register()` already
 * documents that a repeat call for a known `session_id` replaces its record, so binding is
 * "re-register this session with an explicit `workspace_binding`", carrying every other field
 * of its existing record forward unchanged. */
async function handleSessionBinding(ctx: ApiContext, slug: string, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const resolved = workspaceOrNotFound(ctx, slug, url.pathname);
  if (!resolved.ok) return resolved.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return problem(400, "validation-failed", "body must be valid JSON", undefined, url.pathname);
  }
  const sessionId = (body as Record<string, unknown> | null)?.session_id;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return problem(400, "validation-failed", "session_id is required", undefined, url.pathname);
  }

  const existing = ctx.sessionRegistry.get(sessionId);
  if (!existing || ctx.sessionRegistry.liveness(sessionId) !== "alive") {
    return problem(404, "not-found", "unknown or not-live session", undefined, url.pathname);
  }

  await ctx.sessionRegistry.register({ ...existing, workspace_binding: resolved.entry.canonical_path });
  return Response.json({ bound: true, session_id: sessionId });
}

/** Shared body for three of the four route SHELLS (A1 §5.5/§5.8/§5.10) — their real backends land
 * in later tasks (noted per call site below), but the slug-resolution + auth/contract/confinement
 * pipeline in front of them is real today, so the A3 §5 attack suite already covers these routes.
 * `capability/:artifactPath` (§5.12) has its own variant below — it's the one shell with a
 * `:path`-shaped param, so it confines that param too rather than skipping straight to 501. */
function handleNotImplemented(ctx: ApiContext, slug: string, pathname: string, note: string): Response {
  const resolved = workspaceOrNotFound(ctx, slug, pathname);
  if (!resolved.ok) return resolved.response;
  return problem(501, "not-implemented", note, undefined, pathname);
}

/** `GET /w/:slug/stream` (A1 §5.5/§8, P3.2) — resolves the slug, ensures the bus is reconciled
 * (so `bus.currentCursor()`/`bus.state` reflect the journal before anything subscribes to it),
 * then hands off to stream.ts, which owns the actual SSE mechanics. Kept a thin wrapper here so
 * stream.ts never has to know about `ApiContext`/slug resolution (avoids an http.ts <-> stream.ts
 * import cycle — see stream.ts's own header comment). */
async function handleStream(ctx: ApiContext, slug: string, req: Request, server: BunServer | undefined): Promise<Response> {
  const url = new URL(req.url);
  const resolved = workspaceOrNotFound(ctx, slug, url.pathname);
  if (!resolved.ok) return resolved.response;
  const bus = await resolveBus(ctx, resolved.entry.canonical_path);
  return createJournalStreamResponse(resolved.entry.canonical_path, bus, req, server);
}

/** `GET /w/:slug/capability/:artifactPath` shell (A1 §5.12) — P4.1 owns the real token mint, but
 * `artifactPath` is confined here now (traversal/symlink-escape → 400) so P4.1 builds on a real
 * gate instead of a bare stub, and so the confinement attack suite already covers this route. */
function handleCapabilityShell(ctx: ApiContext, slug: string, artifactPath: string, pathname: string): Response {
  const resolved = workspaceOrNotFound(ctx, slug, pathname);
  if (!resolved.ok) return resolved.response;

  const confineResult = confinePath(resolved.entry.canonical_path, artifactPath);
  if (!confineResult.ok) {
    return problem(400, "invalid-path", "path escapes the workspace or is malformed", undefined, pathname);
  }
  return problem(501, "not-implemented", "class-F capability mint — P4.1", undefined, pathname);
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
  if (method === "GET" && pathname === "/api/workspaces") {
    return { routeClass: "authed-read", handle: () => handleListWorkspaces(ctx) };
  }

  let m: RegExpMatchArray | null;

  if (method === "GET" && (m = pathname.match(/^\/w\/([^/]+)\/artifacts$/))) {
    const slug = m[1] as string;
    return { routeClass: "authed-read", handle: () => handleListArtifacts(ctx, slug, pathname) };
  }
  if (method === "GET" && (m = pathname.match(/^\/w\/([^/]+)\/artifacts\/(.+)$/))) {
    const slug = m[1] as string;
    const path = m[2] as string;
    return { routeClass: "authed-read", handle: (req) => handleGetArtifact(ctx, slug, path, req) };
  }
  // P3.2: artifact/journal SSE stream (A1 §5.5, full protocol §8).
  if (method === "GET" && (m = pathname.match(/^\/w\/([^/]+)\/stream$/))) {
    const slug = m[1] as string;
    return { routeClass: "authed-read", handle: (req, server) => handleStream(ctx, slug, req, server) };
  }
  // P4.2: conversation-mirror SSE stream.
  if (method === "GET" && (m = pathname.match(/^\/w\/([^/]+)\/transcript\/stream$/))) {
    const slug = m[1] as string;
    return {
      routeClass: "authed-read",
      handle: () => handleNotImplemented(ctx, slug, pathname, "transcript mirror SSE stream — P4.2"),
    };
  }
  if (method === "POST" && (m = pathname.match(/^\/w\/([^/]+)\/annotations$/))) {
    const slug = m[1] as string;
    return { routeClass: "state-changing", handle: (req) => handleCreateAnnotation(ctx, slug, req) };
  }
  if (method === "GET" && (m = pathname.match(/^\/w\/([^/]+)\/diff$/))) {
    const slug = m[1] as string;
    return { routeClass: "authed-read", handle: (req) => handleDiff(ctx, slug, req) };
  }
  if (method === "GET" && (m = pathname.match(/^\/w\/([^/]+)\/inbox$/))) {
    const slug = m[1] as string;
    return { routeClass: "authed-read", handle: () => handleInbox(ctx, slug, pathname) };
  }
  // F12: human response to an attention_request.
  if (method === "POST" && (m = pathname.match(/^\/w\/([^/]+)\/inbox\/[^/]+\/response$/))) {
    const slug = m[1] as string;
    return {
      routeClass: "state-changing",
      handle: () => handleNotImplemented(ctx, slug, pathname, "attention_request response — F12"),
    };
  }
  if (method === "POST" && (m = pathname.match(/^\/w\/([^/]+)\/session-binding$/))) {
    const slug = m[1] as string;
    return { routeClass: "state-changing", handle: (req) => handleSessionBinding(ctx, slug, req) };
  }
  // P4.1: class-F capability-URL mint (A1 §7).
  if (method === "GET" && (m = pathname.match(/^\/w\/([^/]+)\/capability\/(.+)$/))) {
    const slug = m[1] as string;
    const artifactPath = m[2] as string;
    return { routeClass: "state-changing", handle: () => handleCapabilityShell(ctx, slug, artifactPath, pathname) };
  }

  return null;
}

export function createApiFetch(ctx: ApiContext): (req: Request, server?: BunServer) => Promise<Response> {
  const csp = spaCspHeaders(ctx.classFPort);

  return async (req, server) => {
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

      const res = await route.handle(effectiveReq, server);
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

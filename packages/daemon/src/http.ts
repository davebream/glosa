// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — the two listeners' fetch pipelines (A1 §1/§3/§4, A3 §4). Wires together
// host-check → route lookup → authorizeRequest → contract-version gate → body cap → handler for
// the SPA/API listener, and the minimal host-check-only pipeline for the class-F listener.
//
// P3.1 fills in the full A1 §5 route catalog on top of the P1.3 pipeline: every `/w/:slug/...`
// route resolves its slug through `ctx.workspaceIndex` (unknown slug → 404) before touching
// anything else, and every `:path`/`:artifactPath` param goes through `confinePath` (A1 §6). Two
// routes (the transcript SSE stream, the attention-response route) are still SHELLS — the
// auth/contract/confinement pipeline runs for real, but the body is a `// Pxx:` placeholder until
// their owning task lands (see `handleNotImplemented`). P3.2 replaced one shell, the artifact/
// journal SSE stream (§5.5), with the real thing (`handleStream`/stream.ts); P4.1 replaced
// another, the class-F capability mint (`handleMintCapability`) plus the class-F listener's own
// serve route (`createClassFFetch`/classf-serve.ts).
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILD_ID } from "./build-id.ts";
import { authorizeRequest, isForeignOrigin, type RouteClass } from "./auth.ts";
import { checkContractVersion, CONTRACT_VERSION, DAEMON_VERSION } from "./contract.ts";
import { classFCspHeaders, spaCspHeaders } from "./csp.ts";
import { confinePath } from "./confine-path.ts";
import { internalErrorResponse, problem, restoreConflictResponse } from "./problem.ts";
import { PROTOCOL_VERSION } from "./protocol.ts";
import { resolveTrackedFiles } from "./matcher.ts";
import { classifyArtifactPath, renderMarkdown, sourceSha256, writeArtifactAtomic } from "./artifact-render.ts";
import {
  type AdapterRegistry,
  classifyWithAdapter,
  derivedFromSourcePath,
  isArtifactStale,
  orderWithAdapter,
  resolveManifest,
  type AdapterSessionHint,
} from "./adapters/interface.ts";
import { WorkspaceMetadataError, type WorkspaceMetadataRegistry } from "./adapters/workspace-metadata.ts";
import {
  resolve as resolveAnchor,
  type ClassFArtifact,
  type ClassRArtifact,
  type Resolution,
  type ResolveCtx,
} from "./anchoring.ts";
import { buildDiffHunks, commitExists } from "./checkpoint-diff.ts";
import { checkpointArtifactPath, listCheckpoints } from "./checkpoints.ts";
import { adoptLooseLineages } from "./adoption.ts";
import { isPathDirty, readFileAtCheckpoint, runGit, safePathspec } from "./git/shadow.ts";
import { createJournalStreamResponse } from "./stream.ts";
import { CAPABILITY_TTL_MS, type CapabilityStore } from "./capability.ts";
import {
  PRESENTATION_TOKEN_TTL_MS,
  type PresentationTokenStore,
} from "./presentation-token.ts";
import { serveClassFDocument } from "./classf-serve.ts";
import { confineTranscriptPath } from "./transcript/root.ts";
import { createTranscriptStreamResponse } from "./transcript/stream.ts";
import {
  AdoptionError,
  WorkspaceOpenError,
  type WorkspaceEntry,
  type WorkspaceIndex,
} from "./registry/workspace-index.ts";
import type { SessionRegistry } from "./registry/session-registry.ts";
import { canonicalize } from "./registry/slug.ts";
import { WorkspaceAdoptedError, type WorkspaceBus } from "./bus/bus.ts";
import { journalPath } from "./bus/paths.ts";
import { readInboxEntry } from "./bus/inbox.ts";
import { createEmptyState, foldEvents, type DerivedState } from "./bus/replay.ts";
import { isTerminal, lifecycleReducer, type DeliveryVia } from "./bus/lifecycle.ts";
import type { JournalEvent } from "./bus/journal.ts";
import { buildDeliveryPresentation } from "./delivery/presentation.ts";
import {
  type AgentProviderRegistry,
  recordDelivery,
  type DeliverableEntry,
  type DeliveryResult,
  type SessionBinding,
} from "./providers/interface.ts";
import type { SessionPushRegistry } from "./providers/push-registry.ts";
import type { TokenSource } from "./token.ts";
import type { WorkspaceTarget } from "./workspace.ts";

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

// Fixed allowlist of files servable under `GET /app/<file>` (A3 §3: no path traversal — a
// basename check alone isn't enough, so every servable file is named here explicitly; anything
// not in this map 404s regardless of what else lives on disk under SPA_SRC_DIR).
const SPA_ASSETS: Record<string, string> = {
  // Appearance preload is classic/blocking to apply a persisted override before CSS paints;
  // appearance.js owns the page-lifetime controller and workspace popover.
  "appearance-preload.js": "text/javascript; charset=utf-8",
  "appearance.js": "text/javascript; charset=utf-8",
  "bootstrap.js": "text/javascript; charset=utf-8",
  // The SPA's visual system (design brief docs/design/2026-07-21-workspace-review-surface-brief.md).
  "app.css": "text/css; charset=utf-8",
  // The product mark is a fixed, self-adapting SVG used by the shell and browser chrome.
  "glosa-mark.svg": "image/svg+xml",
  // P3.3 additions — the class-R viewer + its ONE data-access module (R6), and idiomorph
  // vendored under src/vendor/ (see that file's own header for why it's vendored rather than a
  // bare-specifier import).
  "data-access.js": "text/javascript; charset=utf-8",
  "viewer.js": "text/javascript; charset=utf-8",
  "artifact-tree.js": "text/javascript; charset=utf-8",
  "annotate.js": "text/javascript; charset=utf-8",
  "vendor/idiomorph.js": "text/javascript; charset=utf-8",
  // P3.5 additions — the checkpoint/diff timeline pane and its ONE vendored rendering dependency.
  "history.js": "text/javascript; charset=utf-8",
  "vendor/diff2html.js": "text/javascript; charset=utf-8",
  "vendor/diff2html.min.css": "text/css; charset=utf-8",
  // P4.1 addition — the class-F viewer's iframe/handshake/message-validation logic.
  "classf-viewer.js": "text/javascript; charset=utf-8",
  // P4.2 addition — the read-only conversation mirror + out-of-band composer (R6/F32).
  "conversation.js": "text/javascript; charset=utf-8",
  "attention-tray.js": "text/javascript; charset=utf-8",
  // Rich markdown editor (Edit mode's default face) + its vendored ProseMirror bundle.
  "rich-editor.js": "text/javascript; charset=utf-8",
  "vendor/prosemirror.js": "text/javascript; charset=utf-8",
  // Shared confirm dialog (discard-edits and restore guards).
  "dialog.js": "text/javascript; charset=utf-8",
};

export interface ApiContext {
  port: number;
  classFPort: number;
  /** A static token remains accepted for narrow tests. Production passes TokenAuthority so each
   * request sees the current on-disk generation without restarting the daemon. */
  token: string | null | TokenSource;
  instanceId: string;
  startedAt: string;
  workspaceIndex: WorkspaceIndex;
  sessionRegistry: SessionRegistry;
  /** Always resolves to the SAME `WorkspaceBus` instance for a given canonical root (backed by
   * the daemon's one `WorkspaceBusRegistry`, see lifecycle.ts's `buildBackend`) — routes never
   * construct their own `WorkspaceBus`. */
  getWorkspaceBus: (workspace: WorkspaceTarget) => WorkspaceBus;
  /** Atomically preflights and seals all loose sources through the daemon's shared registry. */
  sealAdoptionSources?: (
    sources: readonly WorkspaceTarget[],
    adoptionId: string,
    targetRegistrationId: string,
  ) => Promise<void>;
  /** The ONE class-F capability store shared with `createClassFFetch` (A1 §7) — a token minted
   * here (`POST /w/:slug/capability/:artifactPath`) must be lookup-able by the class-F listener,
   * so both fetch handlers are built from the same `CapabilityStore` instance (lifecycle.ts). */
  capabilityStore: CapabilityStore;
  /** Short-TTL single-use presentation tokens for MCP `glosa_present` / `#p=` deep-links (A3).
   * Optional only for narrow tests that never mint or redeem; production always wires it. */
  presentationTokenStore?: PresentationTokenStore;
  /** P6.1 — the daemon's one `AdapterRegistry` (R7). OPTIONAL and defaulted to "no adapter" by
   * every call site below (`ctx.adapterRegistry?.forWorkspace(root)`) rather than required, so
   * every existing test's hand-built `ApiContext` literal keeps compiling unchanged — an absent
   * registry IS the zero-adapter core, not a gap to fill in. */
  adapterRegistry?: AdapterRegistry;
  /** Durable descriptor owner. Optional only for narrow tests; production always wires it. */
  metadataRegistry?: WorkspaceMetadataRegistry;
  /** Provider implementations are injected by the outer composition root. An absent registry is
   * the supported zero-provider core and yields an honest delivery-unavailable response. */
  providerRegistry?: AgentProviderRegistry;
  pushRegistry?: SessionPushRegistry;
  /** Lifecycle signal used to send `event: bye` and close long-lived streams on SIGTERM. */
  shutdownSignal?: AbortSignal;
}

/** The handshake body extends the A1 §5.1 response with daemon-lifecycle fields: it keeps
 * `protocol_version`/`instance_id`/`pid`/`started_at` so `ensureDaemon`/`fetchHandshake` keep
 * working unchanged, and adds the A1 §5.1 fields the SPA needs (`contract_version` ===
 * `protocol_version` by this task's resolution, `daemon_version`, `paired`). */
export interface HandshakeBody {
  contract_version: string;
  daemon_version: string;
  build_id: string;
  paired: boolean;
  protocol_version: string;
  instance_id: string;
  pid: number;
  started_at: string;
}

function checkHost(req: Request, port: number): boolean {
  return req.headers.get("Host") === `127.0.0.1:${port}`;
}

function currentToken(token: ApiContext["token"]): string | null {
  return typeof token === "object" && token !== null ? token.current() : token;
}

function tokenGenerationSignal(token: ApiContext["token"]): AbortSignal | undefined {
  return typeof token === "object" && token !== null ? token.generationSignal() : undefined;
}

function tokenSnapshot(token: ApiContext["token"]): { token: string | null; signal?: AbortSignal } {
  return typeof token === "object" && token !== null ? token.snapshot() : { token };
}

function lifecycleSignal(ctx: ApiContext, authSignal?: AbortSignal): AbortSignal | undefined {
  const signals = [ctx.shutdownSignal, authSignal ?? tokenGenerationSignal(ctx.token)].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
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
  handle: (req: Request, server?: BunServer, authSignal?: AbortSignal) => Response | Promise<Response>;
}

function handleHandshake(ctx: ApiContext): () => Response {
  return () => {
    const body: HandshakeBody = {
      contract_version: CONTRACT_VERSION,
      daemon_version: DAEMON_VERSION,
      build_id: BUILD_ID,
      paired: currentToken(ctx.token) !== null,
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
 * (A3 §4's navigation row) — it's static HTML, and the token arrives client-side via `#t=`. */
function serveShell(): Response {
  const html = readFileSync(join(SPA_SRC_DIR, "shell.html"), "utf8");
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

/** `GET /app/<file>` — the SPA's static ES modules (P1.4). `name` is checked against the fixed
 * allowlist, not just sanitized, so a request can never read anything else under SPA_SRC_DIR. */
function serveSpaAsset(req: Request, pathname: string): Response {
  const name = pathname.slice("/app/".length);
  // Object.hasOwn, not a bare `SPA_ASSETS[name]` lookup: a prototype key like `__proto__` or
  // `constructor` would otherwise resolve to a truthy inherited value, slip past the `undefined`
  // guard, and fall through to readFileSync (→ 500 instead of a clean 404). Own-keys only.
  const contentType = Object.hasOwn(SPA_ASSETS, name) ? SPA_ASSETS[name] : undefined;
  if (contentType === undefined) {
    return problem(404, "not-found", "no such static asset", undefined, pathname);
  }
  const body = readFileSync(join(SPA_SRC_DIR, name), "utf8");
  const etag = `"${sourceSha256(Buffer.from(body, "utf8"))}"`;
  const headers = {
    "Content-Type": contentType,
    "Cache-Control": "private, no-cache",
    ETag: etag,
  };
  if (req.headers.get("If-None-Match") === etag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(body, { headers });
}

// -------------------------------------------------------------------------------------------
// P3.1 — A1 §5's `/w/:slug/...` route catalog. Every handler below resolves `:slug` through
// `ctx.workspaceIndex.getBySlug` FIRST (unknown slug → 404 not-found) before doing anything else
// — this is the one gate every workspace-scoped route shares, per the P3.1 task brief ("slug →
// workspace: routes resolve `:slug`... unknown slug → 404").
// -------------------------------------------------------------------------------------------

function workspaceOrNotFound(ctx: ApiContext, slug: string, pathname: string) {
  const entry = ctx.workspaceIndex.getBySlug(slug);
  if (!entry)
    return { ok: false as const, response: problem(404, "not-found", "unknown workspace", undefined, pathname) };
  return { ok: true as const, entry };
}

/** `GET /api/workspaces` (A1 §5.2) — the live, present-only registry. */
function handleListWorkspaces(ctx: ApiContext): Response {
  const entries = ctx.workspaceIndex.list({ presentOnly: true });
  const body = entries.map((e) => ({
    slug: e.slug,
    path: e.worktree_path,
    last_seen: e.last_seen,
    has_attention: hasOpenAttention(peekJournal(e).state),
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
function peekJournal(root: WorkspaceTarget): { state: DerivedState; createdAt: Map<string, string> } {
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
async function resolveBus(ctx: ApiContext, root: WorkspaceTarget): Promise<WorkspaceBus> {
  const bus = ctx.getWorkspaceBus(root);
  await bus.reconcileOnce();
  return bus;
}

/** `GET /w/:slug/artifacts` (A1 §5.3) — the sidebar listing. P6.1: `class`/ordering/`stale` are
 * all generic-core behavior driven by whatever adapter (if any) recognizes this workspace —
 * `ctx.adapterRegistry` absent, or present but not recognizing `root`, degrades every one of
 * these to its pre-P6.1 answer (extension-based class, on-disk-sorted order, never stale). */
function handleListArtifacts(ctx: ApiContext, slug: string, pathname: string): Response {
  const resolved = workspaceOrNotFound(ctx, slug, pathname);
  if (!resolved.ok) return resolved.response;
  const root = resolved.entry.worktree_path;
  const adapter = ctx.adapterRegistry?.forWorkspace(resolved.entry);

  const { tracked } = resolveTrackedFiles(resolved.entry);
  const byPath = new Map(tracked.map((f) => [f.path, f]));
  const mtimeMs = new Map(tracked.map((f) => [f.path, statSync(f.rawPath).mtime.getTime()]));
  const resolveSourceMtimeMs = (p: string): number | null => mtimeMs.get(p) ?? null;

  const orderedPaths = orderWithAdapter(
    adapter,
    root,
    tracked.map((f) => f.path),
    resolved.entry,
  );
  const body = orderedPaths.map((path) => {
    const f = byPath.get(path)!;
    return {
      path: f.path,
      class: classifyWithAdapter(adapter, root, f.path, classifyArtifactPath(f.path), resolved.entry),
      size_bytes: f.sizeBytes,
      mtime: new Date(mtimeMs.get(f.path)!).toISOString(),
      source_sha256: sourceSha256(readFileSync(f.rawPath)),
      stale: isArtifactStale(adapter, root, f.path, mtimeMs.get(f.path)!, resolveSourceMtimeMs, resolved.entry),
    };
  });
  return Response.json(body);
}

/** `GET /w/:slug/artifacts/:path` (A1 §5.4). `path` is workspace-relative and must both pass
 * `confinePath` (A1 §6 — traversal/symlink-escape → 400) AND be a currently tracked artifact
 * (matcher membership — confined-but-untracked → 404, a different failure class per §6 step 4). */
function handleGetArtifact(ctx: ApiContext, slug: string, rawPathParam: string, req: Request): Response {
  const url = new URL(req.url);
  const resolved = workspaceOrNotFound(ctx, slug, url.pathname);
  if (!resolved.ok) return resolved.response;
  const root = resolved.entry.worktree_path;

  const confineResult = confinePath(root, rawPathParam);
  if (!confineResult.ok) {
    return problem(400, "invalid-path", "path escapes the workspace or is malformed", undefined, url.pathname);
  }

  const relNfc = rawPathParam
    .split("/")
    .map((segment) => segment.normalize("NFC"))
    .join("/");
  const { tracked } = resolveTrackedFiles(resolved.entry);
  const match = tracked.find((f) => f.path === relNfc);
  if (!match) return problem(404, "not-found", "path within workspace but no such artifact", undefined, url.pathname);

  const raw = readFileSync(match.rawPath);
  const sourceSha = sourceSha256(raw);
  const adapter = ctx.adapterRegistry?.forWorkspace(resolved.entry);
  const cls = classifyWithAdapter(adapter, root, match.path, classifyArtifactPath(match.path), resolved.entry);

  if (cls === "F") {
    // Metadata only — the actual HTML is never served through this route (A1 §5.4/§7); serving it
    // is the class-F capability listener's job (P4.1).
    // P6.1: `derived_from` (R6/R7's generic Edit-on-class-F affordance, already consumed by
    // viewer.js's `canEdit`/`setMode`) and `manifest_path` (A1 §5.4's own example response) are
    // both domain provenance a CONTENT ADAPTER supplies — the core ships with zero adapters
    // (invariant #1), so both are simply absent when none is registered/recognizes this workspace.
    const derivedFrom = derivedFromSourcePath(adapter, root, match.path, resolved.entry);
    const manifestResolution = resolveManifest(root, adapter, match.path, resolved.entry);
    return Response.json({
      source_path: match.path,
      source_sha256: sourceSha,
      class: "F",
      ...(derivedFrom !== undefined ? { derived_from: derivedFrom } : {}),
      ...(manifestResolution?.manifestPath !== undefined ? { manifest_path: manifestResolution.manifestPath } : {}),
    });
  }

  const content = raw.toString("utf8");
  if (url.searchParams.get("render") === "html") {
    const renderedHtml = renderMarkdown(content);
    return Response.json({
      source_path: match.path,
      source_sha256: sourceSha,
      rendered_sha256: createHash("sha256").update(renderedHtml, "utf8").digest("hex"),
      class: "R",
      content,
      rendered_html: renderedHtml,
    });
  }
  return Response.json({ source_path: match.path, source_sha256: sourceSha, class: "R", content });
}

/** `PUT /w/:slug/artifacts/:path` — P3.3 addition, NOT in A1 §5 (the class-R editor's save
 * action). Same slug-gate + `confinePath` + tracked-artifact-membership pipeline as the GET
 * (A1 §6): confined-but-untracked → 404, same as GET, so this route can only overwrite an
 * artifact that already exists and is currently tracked — it never creates a new one. Body is
 * either the raw new source text, or a JSON object `{content: "..."}` (either is accepted so a
 * plain-text `fetch(..., {body: source})` and a JSON caller both work without a content-type
 * dance). An optional `If-Match: <source_sha256>` header makes the write conditional — a
 * mismatch means the file changed since the caller last read it, so the write is refused rather
 * than silently clobbering someone else's change (a nice-to-have, not required by any invariant
 * here, since glosa is single-user v1 — but cheap to offer). On success, writes the file
 * (temp -> fsync -> rename, `writeArtifactAtomic`) then checkpoints it as a `human`-attributed
 * shadow-git commit (`WorkspaceBus#humanEditCheckpoint`) — an edit made through glosa's own
 * editor is `human` BY CONSTRUCTION (A4 §F05), never `session`/`unknown`. */
async function handlePutArtifact(ctx: ApiContext, slug: string, rawPathParam: string, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const resolved = workspaceOrNotFound(ctx, slug, url.pathname);
  if (!resolved.ok) return resolved.response;
  const root = resolved.entry.worktree_path;

  const confineResult = confinePath(root, rawPathParam);
  if (!confineResult.ok) {
    return problem(400, "invalid-path", "path escapes the workspace or is malformed", undefined, url.pathname);
  }

  const relNfc = rawPathParam
    .split("/")
    .map((segment) => segment.normalize("NFC"))
    .join("/");
  const { tracked } = resolveTrackedFiles(resolved.entry);
  const match = tracked.find((f) => f.path === relNfc);
  if (!match) return problem(404, "not-found", "path within workspace but no such artifact", undefined, url.pathname);

  const putAdapter = ctx.adapterRegistry?.forWorkspace(resolved.entry);
  if (classifyWithAdapter(putAdapter, root, match.path, classifyArtifactPath(match.path), resolved.entry) === "F") {
    return problem(
      400,
      "validation-failed",
      "class-F artifacts are not editable through this route",
      undefined,
      url.pathname,
    );
  }

  const ifMatch = req.headers.get("If-Match");
  if (ifMatch !== null) {
    const currentSha = sourceSha256(readFileSync(match.rawPath));
    if (ifMatch !== currentSha) {
      return problem(409, "conflict", "source_sha256 has changed since If-Match was captured", undefined, url.pathname);
    }
  }

  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return problem(400, "validation-failed", "unable to read request body", undefined, url.pathname);
  }
  if (raw.length === 0)
    return problem(400, "validation-failed", "request body must not be empty", undefined, url.pathname);

  // Accept either a bare-text body or `{"content": "..."}` — a body that parses as JSON but
  // isn't that shape (an array, a number, an object with no string `content`) falls back to
  // treating the ORIGINAL raw text as the content, not an error: a markdown source file starting
  // with e.g. `123` or `"just a quoted line"` is itself valid JSON, so "parses as JSON" alone
  // can't be the signal for "caller meant the wrapped-object form".
  let content = raw;
  try {
    const parsed = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      typeof (parsed as Record<string, unknown>).content === "string"
    ) {
      content = (parsed as Record<string, unknown>).content as string;
    }
  } catch {
    // not JSON at all — `content` stays the raw text, which is the common case
  }

  // `resolveBus` (and the reconcile it may trigger) MUST run BEFORE the file is written, not
  // after: reconcile's own offline-catch-up self-heal checkpoints whatever it finds already
  // sitting on disk as `unknown` drift (correctly, for content that arrived some other way while
  // the daemon wasn't watching) — if it ran AFTER this write, the very first reconcile for a
  // workspace would steal THIS edit's commit as unknown drift before `humanEditCheckpoint` below
  // ever got to attribute it `human`. Reconciling first means any real pre-existing drift is
  // captured under its own honest `unknown` commit, leaving a clean slate for our write to be the
  // next (and only) thing `humanEditCheckpoint` finds staged.
  const bus = await resolveBus(ctx, resolved.entry);
  const inboxId = generateAnnotationId();
  const captured = await bus.captureHumanEdit(inboxId, match.path, () => writeArtifactAtomic(match.rawPath, content));

  const newSha = sourceSha256(Buffer.from(content, "utf8"));
  return Response.json({
    source_path: match.path,
    source_sha256: newSha,
    class: "R",
    content,
    rendered_html: renderMarkdown(content),
    ...(captured ? { inbox_id: inboxId } : {}),
  });
}

const ANNOTATION_INTENTS = new Set(["content", "classification", "style"]);

function validateAnnotationBody(
  body: unknown,
): { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, reason: "body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;
  if (typeof b.artifact_path !== "string" || b.artifact_path.length === 0) {
    return { ok: false, reason: "body.artifact_path is required" };
  }
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

/** P6.1 — builds the `AnchoringArtifact` + `ResolveCtx` `anchoring.ts`'s `resolve()` needs for
 * `artifactPath`, from real on-disk content (class R) or the adapter's manifest + derived-from
 * source (class F). Returns `null` when `artifactPath` isn't a currently-tracked artifact — the
 * same "can't prove anything" posture as every other not-found case in this file, never a guess.
 * Class F with no manifest still returns an artifact (empty `source`, no `manifest`) rather than
 * `null` — `resolveClassF` already turns that into the honest `orphaned{no_source_map}` on its
 * own, so this function doesn't need to special-case "no adapter" itself. */
function buildAnchoringContext(
  ctx: ApiContext,
  workspace: WorkspaceEntry,
  artifactPath: string,
): { artifact: ClassRArtifact | ClassFArtifact; resolveCtx: ResolveCtx } | null {
  const root = workspace.worktree_path;
  const confineResult = confinePath(root, artifactPath);
  if (!confineResult.ok) return null;
  const relNfc = artifactPath
    .split("/")
    .map((segment) => segment.normalize("NFC"))
    .join("/");
  const { tracked } = resolveTrackedFiles(workspace);
  const match = tracked.find((f) => f.path === relNfc);
  if (!match) return null;

  const adapter = ctx.adapterRegistry?.forWorkspace(workspace);
  const cls = classifyWithAdapter(adapter, root, match.path, classifyArtifactPath(match.path), workspace);

  if (cls === "R") {
    const source = readFileSync(match.rawPath, "utf8");
    const artifact: ClassRArtifact = { class: "R", path: match.path, source, renderedHtml: renderMarkdown(source) };
    return { artifact, resolveCtx: {} };
  }

  const manifestResolution = resolveManifest(root, adapter, match.path, workspace);
  let source = "";
  if (manifestResolution) {
    const srcMatch = tracked.find((f) => f.path === manifestResolution.manifest.source_path);
    if (srcMatch) source = readFileSync(srcMatch.rawPath, "utf8");
  }
  const artifact: ClassFArtifact = {
    class: "F",
    path: match.path,
    source,
    ...(manifestResolution ? { manifest: manifestResolution.manifest } : {}),
  };
  const resolveCtx: ResolveCtx = manifestResolution
    ? { pipelineFeedback: { adapter: manifestResolution.adapterId, component: manifestResolution.component } }
    : {};
  return { artifact, resolveCtx };
}

function buildActionablePresentation(
  ctx: ApiContext,
  workspace: WorkspaceEntry,
  id: string,
  payload: unknown,
  status: string,
  cursor?: string,
): DeliverableEntry | null {
  const record =
    payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
  let resolution: Resolution | undefined;
  if (record?.kind === "annotation" && typeof record.artifact_path === "string") {
    const built = buildAnchoringContext(ctx, workspace, record.artifact_path);
    if (built) {
      const capturedRenderedSha256 = record.captured_rendered_sha256;
      resolution = resolveAnchor({ body: record.body, intent: record.intent, target: record.target }, built.artifact, {
        ...built.resolveCtx,
        ...(typeof capturedRenderedSha256 === "string" ? { capturedRenderedSha256 } : {}),
      });
    }
  }
  return buildDeliveryPresentation(id, payload, {
    status,
    ...(resolution ? { resolution } : {}),
    ...(cursor ? { cursor } : {}),
  });
}

/** `POST /w/:slug/annotations` (A1 §5.6). Persists the annotation as an inbox entry via
 * `WorkspaceBus.createEntry` — honest provenance only: this route creates the entry, it does NOT
 * decide what the entry means, `resolve()` does.
 *
 * `artifact_path` is required and the SPA also sends the rendered hash it captured. Both are
 * immutable entry content; anchoring itself is intentionally re-run against current content for
 * every presentation attempt, so parked or retried annotations never carry a stale resolution. */
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

  const bus = await resolveBus(ctx, resolved.entry);
  const id = generateAnnotationId();
  // Explicitly picked fields ONLY — never spread the raw parsed body. `kind` in particular must
  // stay a server-assigned constant: a client-supplied `kind` (e.g. "attention_request") spread
  // in after this literal would silently clobber it, forging an attention-tray entry through the
  // annotations endpoint.
  await bus.createEntry(id, {
    kind: "annotation",
    artifact_path: validated.value.artifact_path,
    ...(typeof validated.value.captured_rendered_sha256 === "string"
      ? { captured_rendered_sha256: validated.value.captured_rendered_sha256 }
      : {}),
    body: validated.value.body,
    intent: validated.value.intent,
    target: validated.value.target,
  });

  let resolution: Resolution | undefined;
  const artifactPathRaw = validated.value.artifact_path;
  if (typeof artifactPathRaw === "string" && artifactPathRaw.length > 0) {
    const built = buildAnchoringContext(ctx, resolved.entry, artifactPathRaw);
    if (built) {
      const capturedRenderedSha256 = (body as Record<string, unknown>).captured_rendered_sha256;
      const resolveCtx: ResolveCtx = {
        ...built.resolveCtx,
        ...(typeof capturedRenderedSha256 === "string" ? { capturedRenderedSha256 } : {}),
      };
      resolution = resolveAnchor(
        { body: validated.value.body, intent: validated.value.intent, target: validated.value.target },
        built.artifact,
        resolveCtx,
      );
    }
  }

  return new Response(JSON.stringify({ id, status: "pending", ...(resolution ? { resolution } : {}) }), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  });
}

/** `POST /w/:slug/annotations/:id/withdraw` — the human retracts an annotation from glosa's own
 * margin UI. The inbox entry is immutable and the journal append-only (R3), so "remove" is a
 * guarded terminal transition to `rejected` (legal from any non-terminal status, A5 §F23), never
 * a delete: the entry stops being deliverable/nudgeable but its history stays replayable. 404 for
 * an id the journal has never seen; 409 `conflict` once terminal (a session may have applied it
 * concurrently — the UI should refresh, not pretend the retraction won). */
async function handleWithdrawAnnotation(
  ctx: ApiContext,
  slug: string,
  entryId: string,
  req: Request,
): Promise<Response> {
  const url = new URL(req.url);
  const resolved = workspaceOrNotFound(ctx, slug, url.pathname);
  if (!resolved.ok) return resolved.response;

  const bus = await resolveBus(ctx, resolved.entry);
  const entry = bus.state.entries[entryId];
  if (!entry) return problem(404, "not-found", "no such annotation entry", entryId, url.pathname);
  const kind = entry.kind === "attention" ? "attention" : "common";
  if (isTerminal(kind, entry.status)) {
    return problem(409, "conflict", "entry already closed", `status is ${entry.status}`, url.pathname);
  }

  await bus.commitTransition(entryId, "rejected", { by: "human", note: "withdrawn in glosa" });
  return Response.json({ id: entryId, status: bus.state.entries[entryId]?.status ?? "rejected" });
}

/** `GET /w/:slug/diff` (A1 §5.7). v1 only implements the `from`/`to` checkpoint-id form — `since`
 * (`last-annotation`|`yesterday`) needs the full checkpoint-history resolution P3.5 owns, so any
 * `since` value 400s for now rather than half-implementing named-token resolution here.
 *
 * P3.5 addition: `to=working` is the sentinel for "checkpoint <-> the live working tree" (A6
 * §F31's "unified diff any two checkpoints OR checkpoint<->working") — it skips the
 * `commitExists` check (the working tree obviously isn't a checkpoint) and hands off to
 * `buildDiffHunks`'s own `to==="working"` branch. This is what lets the timeline UI show "what
 * changed since checkpoint X" for the file as it sits on disk right now, and what
 * restore-then-diff-clean (P3.5's acceptance case) proves against: after a successful restore,
 * diffing `from=<restored-to checkpoint>&to=working` for that file comes back with zero hunks. */
async function handleDiff(ctx: ApiContext, slug: string, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const resolved = workspaceOrNotFound(ctx, slug, url.pathname);
  if (!resolved.ok) return resolved.response;
  const root = resolved.entry;

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

  const fromOk = await commitExists(root, from);
  const toOk = to === "working" || (await commitExists(root, to));
  if (!fromOk || !toOk) {
    return problem(400, "validation-failed", "from/to is not a known checkpoint", undefined, url.pathname);
  }

  const hunks = await buildDiffHunks(root, from, to);
  return Response.json({ from, to, hunks });
}

/** `GET /w/:slug/checkpoints` (A6 §F31) — the full-history listing behind the timeline UI.
 * `?since=` is optional (omit for full history); `?limit=` caps the row count after filtering.
 * `checkpoints.ts` owns the actual token resolution/git reads — this handler is just the
 * query-param parse + slug/shadow-repo plumbing every other route already does. */
async function handleCheckpoints(ctx: ApiContext, slug: string, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const resolved = workspaceOrNotFound(ctx, slug, url.pathname);
  if (!resolved.ok) return resolved.response;
  const root = resolved.entry;

  const limitParam = url.searchParams.get("limit");
  let limit: number | undefined;
  if (limitParam !== null) {
    const n = Number(limitParam);
    if (!Number.isInteger(n) || n <= 0) {
      return problem(400, "validation-failed", "limit must be a positive integer", undefined, url.pathname);
    }
    limit = n;
  }

  await resolveBus(ctx, root); // ensures the shadow repo exists before we ask git about it (mirrors handleDiff)

  const since = url.searchParams.get("since") ?? undefined;
  const result = await listCheckpoints(root, { since, limit }, new Date());
  if (!result.ok) {
    return problem(
      400,
      "validation-failed",
      "since is not a recognized token or known checkpoint",
      undefined,
      url.pathname,
    );
  }
  return Response.json(result.rows);
}

/** `POST /w/:slug/restore` (A6 §F31) — restores one artifact's bytes from a chosen checkpoint into
 * the working tree. Body `{path, to, force?}`. Same slug/confinePath/tracked-membership pipeline
 * as `PUT /w/:slug/artifacts/:path`, plus the dirty-worktree guard this route owns: if `path` has
 * changes since its latest checkpoint (HEAD) and the caller didn't pass `force:true`, refuses with
 * `409 restore-conflict` carrying the would-be-lost diff (`restoreConflictResponse`) rather than
 * silently clobbering it. A successful restore is recorded as a NEW `by:human` checkpoint
 * (`kind: "restore"`, via `WorkspaceBus#humanEditCheckpoint`) — append-only, same as every other
 * checkpoint; it never rewrites history. */
async function handleRestore(ctx: ApiContext, slug: string, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const resolved = workspaceOrNotFound(ctx, slug, url.pathname);
  if (!resolved.ok) return resolved.response;
  const root = resolved.entry.worktree_path;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return problem(400, "validation-failed", "body must be valid JSON", undefined, url.pathname);
  }
  const b = body as Record<string, unknown> | null;
  const rawPathParam = typeof b?.path === "string" ? b.path : null;
  const to = typeof b?.to === "string" ? b.to : null;
  const force = b?.force === true;
  if (!rawPathParam || !to) {
    return problem(400, "validation-failed", "path and to are required", undefined, url.pathname);
  }

  const confineResult = confinePath(root, rawPathParam);
  if (!confineResult.ok) {
    return problem(400, "invalid-path", "path escapes the workspace or is malformed", undefined, url.pathname);
  }

  const relNfc = rawPathParam
    .split("/")
    .map((segment) => segment.normalize("NFC"))
    .join("/");
  const { tracked } = resolveTrackedFiles(resolved.entry);
  const match = tracked.find((f) => f.path === relNfc);
  if (!match) return problem(404, "not-found", "path within workspace but no such artifact", undefined, url.pathname);

  // resolveBus BEFORE the dirty check / commitExists — same reasoning as handlePutArtifact: it's
  // what guarantees the shadow repo exists at all (a workspace whose first-ever git op is a
  // restore call still needs `initShadowRepo` to have run).
  const bus = await resolveBus(ctx, resolved.entry);

  if (!(await commitExists(resolved.entry, to))) {
    return problem(400, "validation-failed", "to is not a known checkpoint", undefined, url.pathname);
  }

  const dirty = await isPathDirty(resolved.entry, match.path);
  if (dirty && !force) {
    const lostDiff = await runGit(resolved.entry, ["diff", "HEAD", "--", safePathspec(match.path)]);
    return restoreConflictResponse(url.pathname, match.path, lostDiff.stdout);
  }

  const checkpointPath = await checkpointArtifactPath(resolved.entry, to, match.path);
  const content = await readFileAtCheckpoint(resolved.entry, to, checkpointPath);
  if (content === null) {
    return problem(404, "not-found", "artifact did not exist at that checkpoint", undefined, url.pathname);
  }

  const inboxId = generateAnnotationId();
  const captured = await bus.captureHumanEdit(
    inboxId,
    match.path,
    () => writeArtifactAtomic(match.rawPath, content),
    "restore",
  );
  const fullSha = captured?.checkpoint_after ?? to;
  // Shortened to match `checkpoints.ts`'s `checkpoint_id` format (A6 §F31: "the shadow-git SHORT
  // sha") — `humanEditCheckpoint` itself returns the full sha (its `checkpoint()`/`headSha()`
  // return type everywhere else in this codebase), so this is the one place that narrows it to
  // the same opaque identifier the checkpoints listing hands back for the exact same commit.
  const shortSha = (await runGit(resolved.entry, ["rev-parse", "--short", fullSha])).stdout.trim();

  return Response.json({
    path: match.path,
    restored_to: to,
    checkpoint_id: shortSha,
    source_sha256: sourceSha256(Buffer.from(content, "utf8")),
    ...(captured ? { inbox_id: inboxId } : {}),
  });
}

/** `GET /w/:slug/inbox` (A1 §5.9) — sidebar badge + attention tray summary. `attention[]` lists
 * only attention-kind entries (per A5 §F23's two-axis split — common entries like annotations
 * aren't "attention"); the exact item shape is F12's to finalize, per A1 §5.9. */
function handleInbox(ctx: ApiContext, slug: string, pathname: string): Response {
  const resolved = workspaceOrNotFound(ctx, slug, pathname);
  if (!resolved.ok) return resolved.response;

  const { state, createdAt } = peekJournal(resolved.entry);
  const attention = Object.entries(state.entries)
    .filter(([, e]) => e.kind === "attention" && !isTerminal("attention", e.status))
    .map(([id, e]) => {
      let payload: Record<string, unknown> = {};
      try {
        const raw = readInboxEntry(resolved.entry, id);
        if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) payload = raw as Record<string, unknown>;
      } catch {
        // Journal state remains authoritative even if an immutable payload is unreadable.
      }
      return {
        id,
        created_at: createdAt.get(id) ?? "",
        status: e.status,
        message: typeof payload.message === "string" ? payload.message : null,
        action: typeof payload.action === "string" ? payload.action : null,
        target: typeof payload.path === "string" ? payload.path : null,
      };
    })
    .sort((a, b) => a.created_at.localeCompare(b.created_at));

  return Response.json({ pending_count: attention.length, attention });
}

async function handleAttentionSeen(ctx: ApiContext, slug: string, entryId: string, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const resolved = workspaceOrNotFound(ctx, slug, url.pathname);
  if (!resolved.ok) return resolved.response;
  const bus = await resolveBus(ctx, resolved.entry);
  try {
    return Response.json({ id: entryId, ...(await bus.markAttentionSeen(entryId)) });
  } catch {
    return problem(404, "not-found", "unknown attention request", undefined, url.pathname);
  }
}

async function handleAttentionResponse(
  ctx: ApiContext,
  slug: string,
  entryId: string,
  req: Request,
): Promise<Response> {
  const url = new URL(req.url);
  const resolved = workspaceOrNotFound(ctx, slug, url.pathname);
  if (!resolved.ok) return resolved.response;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return problem(400, "validation-failed", "body must be valid JSON", undefined, url.pathname);
  }
  const b = body as Record<string, unknown> | null;
  const outcome = b?.outcome;
  if (outcome !== "done" && outcome !== "approved" && outcome !== "changes_requested") {
    return problem(
      400,
      "validation-failed",
      "outcome must be done, approved, or changes_requested",
      undefined,
      url.pathname,
    );
  }
  const response = b?.response;
  if (response !== undefined && (typeof response !== "string" || Buffer.byteLength(response, "utf8") > 4096)) {
    return problem(
      400,
      "validation-failed",
      "response must be a string of at most 4096 bytes",
      undefined,
      url.pathname,
    );
  }

  const bus = await resolveBus(ctx, resolved.entry);
  const entry = bus.readEntry(entryId);
  if (!entry || typeof entry.payload !== "object" || entry.payload === null) {
    return problem(404, "not-found", "unknown attention request", undefined, url.pathname);
  }
  const action = (entry.payload as Record<string, unknown>).action;
  if (action === "review" && outcome === "done") {
    return problem(
      400,
      "validation-failed",
      "review requests require approved or changes_requested",
      undefined,
      url.pathname,
    );
  }
  if (action !== "review" && outcome !== "done") {
    return problem(400, "validation-failed", "generic requests require outcome done", undefined, url.pathname);
  }
  try {
    return Response.json({
      id: entryId,
      ...(await bus.completeAttention(entryId, outcome, response as string | undefined)),
    });
  } catch (error) {
    return problem(409, "conflict", (error as Error).message, undefined, url.pathname);
  }
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

function metadataUnavailable(pathname: string): Response {
  return problem(500, "internal", "workspace metadata service is unavailable", undefined, pathname);
}

function metadataError(error: unknown, pathname: string): Response {
  if (error instanceof WorkspaceMetadataError) {
    return problem(
      error.status,
      error.code === "metadata-conflict" ? "conflict" : "validation-failed",
      error.message,
      undefined,
      pathname,
    );
  }
  return problem(500, "internal", "workspace metadata operation failed", undefined, pathname);
}

function handleGetMetadata(ctx: ApiContext, slug: string, pathname: string): Response {
  const resolved = workspaceOrNotFound(ctx, slug, pathname);
  if (!resolved.ok) return resolved.response;
  if (!ctx.metadataRegistry) return metadataUnavailable(pathname);
  const descriptor = ctx.metadataRegistry.get(resolved.entry);
  if (!descriptor) return problem(404, "not-found", "workspace metadata is not registered", undefined, pathname);
  return Response.json({ metadata: descriptor });
}

async function handleSetMetadata(ctx: ApiContext, slug: string, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const resolved = workspaceOrNotFound(ctx, slug, url.pathname);
  if (!resolved.ok) return resolved.response;
  if (!ctx.metadataRegistry) return metadataUnavailable(url.pathname);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return problem(400, "validation-failed", "body must be valid JSON", undefined, url.pathname);
  }
  try {
    const { descriptor, replaced } = await ctx.metadataRegistry.set(resolved.entry, body);
    return Response.json({ metadata: descriptor, replaced });
  } catch (error) {
    return metadataError(error, url.pathname);
  }
}

async function handleClearMetadata(ctx: ApiContext, slug: string, pathname: string): Promise<Response> {
  const resolved = workspaceOrNotFound(ctx, slug, pathname);
  if (!resolved.ok) return resolved.response;
  if (!ctx.metadataRegistry) return metadataUnavailable(pathname);
  try {
    return Response.json({ cleared: await ctx.metadataRegistry.clear(resolved.entry) });
  } catch (error) {
    return metadataError(error, pathname);
  }
}

// -------------------------------------------------------------------------------------------
// P4.3 additions — not in A1 §5 (same footing as P4.2's `/transcript/compose`): the internal
// `/api/sessions/...` surface `glosa hook <event>` calls into. R2/A2 §F08 are explicit that
// "providers register live agent sessions via hooks → daemon API (never direct file writes)" —
// these four routes are that API. Kept under `/api/` (not `/w/:slug/...`) since a hook fires
// before the caller necessarily knows which workspace slug it landed in; `register` is what
// resolves that (via `SessionRegistry.register`'s own workspace upsert).
// -------------------------------------------------------------------------------------------

/** Resolves a hook-supplied path to its canonical identity (realpath -> NFC -> strip trailing
 * slash, same convention as every other workspace-identity call site) — a hook's `cwd` is NOT
 * pre-canonicalized the way `/w/:slug/...` routes' `entry.canonical_path` already is. `null` on
 * anything that doesn't resolve (nonexistent directory, symlink loop, etc.). */
function canonicalOrNull(path: string): string | null {
  try {
    return canonicalize(path);
  } catch {
    return null;
  }
}

/** `POST /api/sessions/register` — A2 §F08's SessionStart registration + R2's "no live session ->
 * park; next registration for that workspace drains it" (the drained-workspace list this returns
 * is exactly `SessionRegistry.register`'s own `drainedWorkspaces`, surfaced so the caller can
 * decide what to do with a just-unparked workspace — this route never itself pushes/delivers). */
async function handleSessionRegister(ctx: ApiContext, req: Request): Promise<Response> {
  const url = new URL(req.url);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return problem(400, "validation-failed", "body must be valid JSON", undefined, url.pathname);
  }
  const b = body as Record<string, unknown> | null;
  const sessionId = b?.session_id;
  const provider = b?.provider;
  const cwd = b?.cwd;
  const source = b?.source;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return problem(400, "validation-failed", "session_id is required", undefined, url.pathname);
  }
  if (typeof provider !== "string" || provider.length === 0) {
    return problem(400, "validation-failed", "provider is required", undefined, url.pathname);
  }
  if (typeof cwd !== "string" || cwd.length === 0) {
    return problem(400, "validation-failed", "cwd is required", undefined, url.pathname);
  }
  if (typeof source !== "string" || source.length === 0) {
    return problem(400, "validation-failed", "source is required", undefined, url.pathname);
  }

  const canonicalCwd = canonicalOrNull(cwd);
  if (!canonicalCwd)
    return problem(400, "invalid-path", "cwd does not resolve to a real directory", undefined, url.pathname);

  let workspaceBinding: string | undefined;
  if (typeof b?.workspace_binding === "string" && b.workspace_binding.length > 0) {
    const canonicalBinding = canonicalOrNull(b.workspace_binding);
    if (!canonicalBinding) {
      return problem(
        400,
        "invalid-path",
        "workspace_binding does not resolve to a real directory",
        undefined,
        url.pathname,
      );
    }
    workspaceBinding = canonicalBinding;
  } else if (ctx.adapterRegistry) {
    // P6.1 — R2's authoritative routing input, from adapter-specific state, only consulted when
    // the caller didn't already supply an explicit binding (an explicit body field is the more
    // direct signal and wins outright). The core has no idea WHY the adapter picked what it did.
    const hint: AdapterSessionHint = { session_id: sessionId, provider, cwd: canonicalCwd, source };
    const adapterBinding = ctx.adapterRegistry.resolveSessionBinding(hint);
    if (adapterBinding !== null) {
      const canonicalAdapterBinding = canonicalOrNull(adapterBinding);
      if (canonicalAdapterBinding) workspaceBinding = canonicalAdapterBinding;
    }
  }

  const transcriptPath =
    typeof b?.transcript_path === "string" && b.transcript_path.length > 0 ? b.transcript_path : undefined;

  const { record, drainedWorkspaces } = await ctx.sessionRegistry.register({
    session_id: sessionId,
    provider,
    cwd: canonicalCwd,
    source,
    ...(workspaceBinding !== undefined ? { workspace_binding: workspaceBinding } : {}),
    ...(transcriptPath !== undefined ? { transcript_path: transcriptPath } : {}),
  });

  return Response.json({
    session_id: record.session_id,
    workspace: record.workspace_binding ?? record.cwd,
    drained_workspaces: drainedWorkspaces,
  });
}

/** `POST /api/sessions/:id/heartbeat` — UserPromptSubmit/Stop's lease refresh (A2 §F08: "the
 * lease... refreshed on each hook"). An unknown session_id is a silent no-op on the registry side
 * (see `SessionRegistry.heartbeat`'s own docstring) — mirrored here as a 200, not a 404, since a
 * heartbeat racing a session that just ended is expected, not an error. */
async function handleSessionHeartbeat(ctx: ApiContext, sessionId: string): Promise<Response> {
  await ctx.sessionRegistry.heartbeat(sessionId);
  return Response.json({ ok: true });
}

/** `POST /api/sessions/:id/deregister` — SessionEnd (A2 §F08: "removes the session from the
 * active registry (keeps journal audit trail)"). Also a no-op-safe 200 for an unknown id. */
async function handleSessionDeregister(ctx: ApiContext, sessionId: string): Promise<Response> {
  await ctx.sessionRegistry.deregister(sessionId);
  return Response.json({ ok: true });
}

const DRAIN_MAX = 8; // A2 §F07/A6 §F26: "Stop drains are bounded (≤8) and treated as drains, not loops."

/** `POST /api/sessions/:id/drain` — prepares the rung-3 turn-boundary payload (UserPromptSubmit's
 * additionalContext + Stop's blocking reason, A6 §F26). Selection, actionable formatting, byte
 * accounting, and reservation happen under one workspace mutex; no `presented` event is written
 * until the output owner calls the acknowledgement route after its stream/protocol write succeeds.
 * An entry whose earlier attempts failed or only reached `transport_accepted` remains eligible.
 * `via` MUST be told apart by the caller, since
 * `"gate"`/`"stop"`/`"userprompt"`/`"asyncRewake"` are distinct transports and only the caller
 * (`glosa hook stop` vs. `user-prompt-submit` vs. `rewake-watch`) knows which one is actually
 * surfacing this drain right now. An unknown session_id is 404 (unlike heartbeat/deregister,
 * there is no live-registry-race reading here to be lenient about — the caller just registered
 * this exact session moments earlier in the same hook invocation). */
async function handleSessionDrain(ctx: ApiContext, sessionId: string, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const record = ctx.sessionRegistry.get(sessionId);
  if (!record) return problem(404, "not-found", "unknown session", undefined, url.pathname);

  let limit = DRAIN_MAX;
  let via: DeliveryVia = "userprompt";
  let entryId: string | undefined;
  let cursor: string | undefined;
  try {
    const raw = await req.text();
    if (raw.length > 0) {
      const body = JSON.parse(raw) as Record<string, unknown>;
      if (typeof body.limit === "number" && body.limit > 0) limit = Math.min(body.limit, DRAIN_MAX);
      if (typeof body.entryId === "string" && body.entryId.length > 0) entryId = body.entryId;
      if (typeof body.cursor === "string" && body.cursor.length > 0) cursor = body.cursor;
      // The four "this route surfaced it" transports — never channel/mcp_pull, which have their
      // own separate delivery paths that don't go through this drain-and-mark route at all.
      if (
        body.via === "gate" ||
        body.via === "stop" ||
        body.via === "userprompt" ||
        body.via === "asyncRewake" ||
        body.via === "mcp_pull"
      ) {
        via = body.via;
      }
    }
  } catch {
    return problem(400, "validation-failed", "body must be valid JSON", undefined, url.pathname);
  }

  const root = record.workspace_binding ?? record.cwd;
  const workspace = ctx.workspaceIndex.get(root) ?? (await ctx.workspaceIndex.upsertWorkspace(root, "session"));
  const bus = await resolveBus(ctx, workspace);

  const prepared = await bus.prepareDelivery(
    limit,
    { via, session: sessionId, ...(entryId ? { entryId } : {}) },
    (id, payload, status) => buildActionablePresentation(ctx, workspace, id, payload, status, cursor),
  );

  return Response.json(prepared);
}

async function handleSessionDeliveryAck(
  ctx: ApiContext,
  sessionId: string,
  deliveryId: string,
  req: Request,
): Promise<Response> {
  const url = new URL(req.url);
  const record = ctx.sessionRegistry.get(sessionId);
  if (!record) return problem(404, "not-found", "unknown session", undefined, url.pathname);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return problem(400, "validation-failed", "body must be valid JSON", undefined, url.pathname);
  }
  const value = body as Record<string, unknown> | null;
  const outcome = value?.outcome;
  if (outcome !== "presented" && outcome !== "failed") {
    return problem(400, "validation-failed", "outcome must be presented|failed", undefined, url.pathname);
  }
  const root = record.workspace_binding ?? record.cwd;
  const bus = await resolveBus(ctx, ctx.workspaceIndex.get(root) ?? root);
  const acknowledged = await bus.acknowledgeDelivery(
    deliveryId,
    outcome,
    typeof value?.error === "string" ? value.error : undefined,
  );
  if (!acknowledged)
    return problem(409, "conflict", "delivery reservation is missing or expired", undefined, url.pathname);
  return Response.json({ acknowledged: true });
}

function handleSessionPushStream(
  ctx: ApiContext,
  sessionId: string,
  req: Request,
  server: BunServer | undefined,
): Response {
  const record = ctx.sessionRegistry.get(sessionId);
  if (!record || ctx.sessionRegistry.liveness(sessionId) !== "alive") {
    return problem(404, "not-found", "unknown live session", undefined, new URL(req.url).pathname);
  }
  if (!record.workspace_binding) {
    return problem(409, "conflict", "session is not explicitly bound", undefined, new URL(req.url).pathname);
  }
  if (!ctx.pushRegistry) {
    return problem(503, "internal", "session push is unavailable", undefined, new URL(req.url).pathname);
  }
  const encoder = new TextEncoder();
  let unregister: (() => void) | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (entry: DeliverableEntry) => {
        controller.enqueue(encoder.encode(`event: conversation_message\ndata: ${JSON.stringify(entry)}\n\n`));
      };
      unregister = ctx.pushRegistry?.register(sessionId, send) ?? null;
      controller.enqueue(encoder.encode(": connected\n\n"));
    },
    cancel() {
      unregister?.();
    },
  });
  req.signal.addEventListener("abort", () => unregister?.(), { once: true });
  server?.timeout(req, 0);
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}

async function handleConversationAck(
  ctx: ApiContext,
  sessionId: string,
  messageId: string,
  req: Request,
): Promise<Response> {
  const url = new URL(req.url);
  const record = ctx.sessionRegistry.get(sessionId);
  if (!record?.workspace_binding) {
    return problem(404, "not-found", "unknown explicitly bound session", undefined, url.pathname);
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return problem(400, "validation-failed", "body must be valid JSON", undefined, url.pathname);
  }
  const outcome = (body as Record<string, unknown> | null)?.outcome;
  if (outcome !== "transport_accepted" && outcome !== "presented" && outcome !== "failed") {
    return problem(
      400,
      "validation-failed",
      "outcome must be transport_accepted|presented|failed",
      undefined,
      url.pathname,
    );
  }
  if (outcome === "transport_accepted") ctx.pushRegistry?.acknowledgeTransport(sessionId, messageId);
  const bus = await resolveBus(ctx, ctx.workspaceIndex.get(record.workspace_binding) ?? record.workspace_binding);
  const acknowledged = await bus.acknowledgeConversationMessage(messageId, {
    session: sessionId,
    via: "channel",
    outcome,
    ...(outcome === "failed" ? { error: "channel_transport_failed" } : {}),
  });
  if (!acknowledged) {
    return problem(409, "conflict", "conversation message does not target this session", undefined, url.pathname);
  }
  return Response.json({ acknowledged: true, delivered: outcome === "presented" });
}

async function handleInboxPresentation(
  ctx: ApiContext,
  slug: string,
  entryId: string,
  req: Request,
): Promise<Response> {
  const url = new URL(req.url);
  const resolved = workspaceOrNotFound(ctx, slug, url.pathname);
  if (!resolved.ok) return resolved.response;
  const root = resolved.entry;
  const bus = await resolveBus(ctx, root);
  const entry = bus.readEntry(entryId);
  if (!entry) return problem(404, "not-found", "no such inbox entry", entryId, url.pathname);
  const presentation = buildActionablePresentation(
    ctx,
    root,
    entryId,
    entry.payload,
    entry.status,
    url.searchParams.get("cursor") ?? undefined,
  );
  if (!presentation) return problem(422, "validation-failed", "entry payload is not actionable", entryId, url.pathname);
  return Response.json({ presentation });
}

// -------------------------------------------------------------------------------------------
// P5.1 additions — the CLI-facing `/api/workspaces/...` surface (A6 §F26's `open`/`resolve`/
// `apply-begin`/`request-review`/`status` command surface). Not in A1 §5 (same footing as every
// other `// PX.Y:` addition in this file): every `/w/:slug/...` route above resolves an ALREADY-
// REGISTERED workspace's slug, but `open`/`resolve`/`apply-begin`/`request-review` are called
// from a bare directory the CLI was invoked in — often BEFORE that directory has ever been
// registered as a workspace at all (that's exactly what `open` is for). These routes take a raw
// `path` instead of a `:slug` and canonicalize it themselves (mirrors `handleSessionRegister`'s
// own `canonicalOrNull` use), then hand off to `ctx.getWorkspaceBus(canonicalRoot)` — which needs
// no slug lookup, only the canonical root string — for everything past that point.
// -------------------------------------------------------------------------------------------

/** `POST /api/workspaces/open` — `glosa open`'s daemon-side half (A6 §F26's "ensure `.glosa/`
 * baseline exists"). Upserts the workspace into the global index (source `glosa-open` — a
 * `WorkspaceSource` literal `workspace-index.ts` already reserves for exactly this caller) and
 * reconciles its `WorkspaceBus` once, which is what actually performs the "first-touch scaffold"
 * (`.glosa/` dir, `initShadowRepo`'s baseline commit) via `reconcileWorkspace`'s own step 4/5 —
 * the SAME mechanism a session registration's first `resolveBus` call already triggers elsewhere
 * in this file. `open` deliberately does NOT duplicate that scaffold logic itself; it just
 * triggers the real thing through this one daemon-side call. */
async function handleWorkspaceOpen(ctx: ApiContext, req: Request): Promise<Response> {
  const url = new URL(req.url);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return problem(400, "validation-failed", "body must be valid JSON", undefined, url.pathname);
  }
  const parsed = body as Record<string, unknown> | null;
  const rawPath = parsed?.path;
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    return problem(400, "validation-failed", "path is required", undefined, url.pathname);
  }
  const focus = typeof parsed?.focus === "string" && parsed.focus.length > 0 ? parsed.focus : undefined;
  try {
    const opened = await ctx.workspaceIndex.resolveOpenTarget(rawPath, {
      externalState: parsed?.external_state === true,
      ...(focus ? { focus } : {}),
      ...(parsed?.focus_first === true ? { focusFirst: true } : {}),
      ...(parsed?.require_focus === true ? { requireFocus: true } : {}),
    });
    if (opened.entry.kind === "directory") {
      await adoptLooseLineages(ctx.workspaceIndex, opened.entry, ctx.getWorkspaceBus, ctx.sealAdoptionSources);
    }
    await resolveBus(ctx, opened.entry);
    const localBus = join(opened.entry.worktree_path, ".glosa");
    const redirected = opened.entry.bus_path !== localBus;
    return Response.json({
      slug: opened.entry.slug,
      path: opened.entry.worktree_path,
      kind: opened.entry.kind,
      ...(opened.focus ? { focus: opened.focus } : {}),
      ...(redirected ? { state_dir: opened.entry.bus_path } : {}),
    });
  } catch (error) {
    if (error instanceof WorkspaceOpenError) {
      const status = error.code === "artifact-not-tracked" || error.code === "no-tracked-artifact" ? 422 : 400;
      return problem(status, error.code, error.message, undefined, url.pathname);
    }
    if (error instanceof AdoptionError) {
      return problem(409, error.code, error.message, undefined, url.pathname);
    }
    if (error instanceof WorkspaceAdoptedError) {
      return problem(409, "workspace-adopted", error.message, undefined, url.pathname);
    }
    throw error;
  }
}

/** `POST /api/presentation-token/mint` — CLI/MCP mint a short-TTL single-use `p=` token. */
function handlePresentationTokenMint(ctx: ApiContext, pathname: string): Response {
  const store = ctx.presentationTokenStore;
  if (!store) {
    return problem(500, "internal", "presentation token store is unavailable", undefined, pathname);
  }
  const minted = store.mint();
  return Response.json({
    token: minted.token,
    expires_in_s: PRESENTATION_TOKEN_TTL_MS / 1000,
  });
}

/** `POST /api/presentation-token/redeem` — SPA exchanges `p=` once for the durable pairing token.
 * Expired, unknown, and replayed tokens all collapse to the same 401 (A3). */
async function handlePresentationTokenRedeem(ctx: ApiContext, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const store = ctx.presentationTokenStore;
  if (!store) {
    return problem(500, "internal", "presentation token store is unavailable", undefined, url.pathname);
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return problem(400, "validation-failed", "body must be valid JSON", undefined, url.pathname);
  }
  const token =
    typeof (body as { token?: unknown } | null)?.token === "string" ? (body as { token: string }).token : "";
  if (!token || !store.redeem(token)) {
    // Collapse unknown / expired / replayed into one 401 with no distinguishing detail.
    return problem(401, "unauthorized", "invalid or expired presentation token", undefined, url.pathname);
  }
  const durable = currentToken(ctx.token);
  if (!durable) {
    return problem(401, "unauthorized", "daemon is unpaired", undefined, url.pathname);
  }
  return Response.json({ token: durable });
}

const RESOLVE_TERMINAL_OUTCOMES = new Set(["applied", "rejected", "stale"]);

/** `POST /api/workspaces/resolve` — `glosa resolve <id> <applied|rejected|deferred|stale>`'s
 * daemon-side half (A6 §F26). `applied`/`rejected`/`stale` go through `WorkspaceBus.resolveEntry`
 * — the SAME "proven pre..post diff" lease-close mechanism `apply-begin` opens (A4 §F05): this
 * REQUIRES an active apply-begin lease for `entry` held by `session`, since that lease is what
 * proves the attribution `resolveEntry` records. An unknown entry, or a resolve attempted with no
 * matching open lease, surfaces as `NO_ACTIVE_LEASE`/`LEASE_SESSION_MISMATCH` — mapped to 409
 * here, which the CLI maps to exit 8 (`entry_error`).
 *
 * `deferred` is deliberately NOT routed through `resolveEntry` — see `commitTransition`'s own
 * docstring in bus.ts for why `deferred` is folded as a legal-but-inert `transition_committed`
 * event (no lease touched, no status change) rather than a lease-closing terminal outcome. */
async function handleWorkspaceResolve(ctx: ApiContext, req: Request): Promise<Response> {
  const url = new URL(req.url);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return problem(400, "validation-failed", "body must be valid JSON", undefined, url.pathname);
  }
  const b = body as Record<string, unknown> | null;
  const rawPath = typeof b?.path === "string" ? b.path : null;
  const entry = typeof b?.entry === "string" ? b.entry : null;
  const outcome = typeof b?.outcome === "string" ? b.outcome : null;
  const session = typeof b?.session === "string" ? b.session : null;
  const note = typeof b?.note === "string" ? b.note : undefined;
  if (!rawPath || !entry || !outcome || !session) {
    return problem(400, "validation-failed", "path, entry, outcome, and session are required", undefined, url.pathname);
  }
  const root = canonicalOrNull(rawPath);
  if (!root) return problem(400, "invalid-path", "path does not resolve to a real directory", undefined, url.pathname);

  const bus = await resolveBus(ctx, ctx.workspaceIndex.get(root) ?? root);

  if (outcome === "deferred") {
    const entryState = bus.state.entries[entry];
    if (!entryState) {
      return problem(404, "not-found", "unknown inbox entry", undefined, url.pathname);
    }
    // `deferred` is a legal-but-inert no-op on the lifecycle reducer (absent from both guard
    // tables) — firing it on an entry that's ALREADY terminal would otherwise still return 200
    // `{to: "deferred"}`, which a client reading only `to` could misread as a successful
    // transition. Guard it the same way `resolveEntry`'s illegal-transition cases are guarded
    // below (409 `conflict`) rather than silently accepting it — first-terminal-wins, and this
    // endpoint always tells the truth about what happened.
    const kind = entryState.kind === "attention" ? "attention" : "common";
    if (isTerminal(kind, entryState.status)) {
      return problem(
        409,
        "conflict",
        `entry is already ${entryState.status}; deferred is a no-op on a terminal entry`,
        undefined,
        url.pathname,
      );
    }
    await bus.commitTransition(entry, "deferred", { by: `session:${session}`, note });
    return Response.json({ entry, status: bus.state.entries[entry]?.status ?? "unknown", to: "deferred" });
  }

  if (!RESOLVE_TERMINAL_OUTCOMES.has(outcome)) {
    return problem(
      400,
      "validation-failed",
      "outcome must be one of applied|rejected|deferred|stale",
      undefined,
      url.pathname,
    );
  }

  try {
    const result = await bus.resolveEntry(entry, outcome as "applied" | "rejected" | "stale", session, { note });
    return Response.json({ entry, status: outcome, to: outcome, lease_id: result.leaseId, post_sha: result.postSha });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "NO_ACTIVE_LEASE" || code === "LEASE_SESSION_MISMATCH") {
      return problem(409, "conflict", "no matching apply-begin lease for this entry/session", undefined, url.pathname);
    }
    throw err;
  }
}

/** `POST /api/workspaces/apply-begin` — `glosa apply-begin <id> --session <sid>`'s daemon-side
 * half (A4 §F05). A second apply-begin already active for this workspace surfaces as
 * `LEASE_HELD` — mapped to 409 `lease-conflict`, which the CLI maps to exit 12. */
async function handleWorkspaceApplyBegin(ctx: ApiContext, req: Request): Promise<Response> {
  const url = new URL(req.url);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return problem(400, "validation-failed", "body must be valid JSON", undefined, url.pathname);
  }
  const b = body as Record<string, unknown> | null;
  const rawPath = typeof b?.path === "string" ? b.path : null;
  const entry = typeof b?.entry === "string" ? b.entry : null;
  const session = typeof b?.session === "string" ? b.session : null;
  if (!rawPath || !entry || !session) {
    return problem(400, "validation-failed", "path, entry, and session are required", undefined, url.pathname);
  }
  const root = canonicalOrNull(rawPath);
  if (!root) return problem(400, "invalid-path", "path does not resolve to a real directory", undefined, url.pathname);

  const bus = await resolveBus(ctx, ctx.workspaceIndex.get(root) ?? root);
  try {
    const { leaseId, preSha } = await bus.applyBegin(entry, session);
    return new Response(JSON.stringify({ entry, lease_id: leaseId, pre_sha: preSha }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    if ((err as { code?: string }).code === "LEASE_HELD") {
      return problem(
        409,
        "lease-conflict",
        "an apply-lease is already active for this workspace",
        undefined,
        url.pathname,
      );
    }
    throw err;
  }
}

/** `POST /api/workspaces/attention-request` — `glosa request-review <path> [--message] [--action]`'s
 * daemon-side half (A5 §F23's attention axis: `open -> delivered -> seen -> {done|expired|stale}`).
 * `path` here is the WORKSPACE root (same convention as `open`/`resolve`/`apply-begin` — the CLI
 * runs from the workspace directory); `target_path`, if given, is the artifact the review concerns,
 * carried as informational payload only (no anchoring — that's `POST /w/:slug/annotations`'s job,
 * a different entry kind). */
async function handleWorkspaceAttentionRequest(ctx: ApiContext, req: Request): Promise<Response> {
  const url = new URL(req.url);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return problem(400, "validation-failed", "body must be valid JSON", undefined, url.pathname);
  }
  const b = body as Record<string, unknown> | null;
  const rawPath = typeof b?.path === "string" ? b.path : null;
  if (!rawPath) return problem(400, "validation-failed", "path is required", undefined, url.pathname);
  const root = canonicalOrNull(rawPath);
  if (!root) return problem(400, "invalid-path", "path does not resolve to a real directory", undefined, url.pathname);

  const message = typeof b?.message === "string" ? b.message : undefined;
  const action = typeof b?.action === "string" ? b.action : "review";
  const targetPath = typeof b?.target_path === "string" ? b.target_path : undefined;
  if (message !== undefined && Buffer.byteLength(message, "utf8") > 4096) {
    return problem(400, "validation-failed", "message must be at most 4096 bytes", undefined, url.pathname);
  }
  if (Buffer.byteLength(action, "utf8") > 64) {
    return problem(400, "validation-failed", "action must be at most 64 bytes", undefined, url.pathname);
  }
  if (targetPath !== undefined && !confinePath(root, targetPath).ok) {
    return problem(400, "invalid-path", "target_path must be workspace-relative and confined", undefined, url.pathname);
  }

  const entry = await ctx.workspaceIndex.upsertWorkspace(root, "glosa-open");
  const bus = await resolveBus(ctx, entry);
  const id = generateAnnotationId();
  await bus.createEntry(id, {
    kind: "attention_request",
    ...(message !== undefined ? { message } : {}),
    action,
    ...(targetPath !== undefined ? { path: targetPath } : {}),
  });
  return new Response(JSON.stringify({ id, slug: entry.slug, status: "open" }), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  });
}

/** `GET /api/workspaces/entry-status?path=&entry=` — `glosa request-review --wait`'s poll target.
 * Peeks the LIVE (reconciled) bus state for one entry's current status/detail — a resolved
 * (terminal) attention entry no longer appears in `GET /w/:slug/inbox` (that route only lists
 * NON-terminal attention entries, by design — A1 §5.9), so `--wait` needs a way to see the
 * TERMINAL outcome, verdict included, once one lands. */
async function handleWorkspaceEntryStatus(ctx: ApiContext, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const rawPath = url.searchParams.get("path");
  const entry = url.searchParams.get("entry");
  if (!rawPath || !entry) {
    return problem(400, "validation-failed", "path and entry query params are required", undefined, url.pathname);
  }
  const root = canonicalOrNull(rawPath);
  if (!root) return problem(400, "invalid-path", "path does not resolve to a real directory", undefined, url.pathname);

  const bus = await resolveBus(ctx, ctx.workspaceIndex.get(root) ?? root);
  const state = bus.state.entries[entry];
  if (!state) return problem(404, "not-found", "unknown inbox entry", undefined, url.pathname);
  return Response.json({ id: entry, kind: state.kind, status: state.status, detail: state.detail ?? null });
}

/** `GET /api/status` — `glosa status`'s aggregate (A6 §F26: "daemon+workspaces+sessions+pending").
 * One route rather than several client-side calls: `status` is meant to answer "what's going on"
 * in a single round trip, and every piece it needs (`workspaceIndex`, `sessionRegistry`, each
 * workspace's own journal) already lives on `ctx` — there's nothing a second daemon endpoint would
 * add except more network round trips for the CLI to fail independently on. */
function handleStatusAggregate(ctx: ApiContext): Response {
  const workspaces = ctx.workspaceIndex.list({ presentOnly: true }).map((e) => {
    const { state } = peekJournal(e);
    const pendingCount = Object.values(state.entries).filter((entry) => {
      const kind = entry.kind === "attention" ? "attention" : "common";
      return !isTerminal(kind, entry.status);
    }).length;
    return {
      slug: e.slug,
      path: e.worktree_path,
      last_seen: e.last_seen,
      pending_count: pendingCount,
      has_attention: hasOpenAttention(state),
    };
  });
  const sessions = ctx.sessionRegistry.list().map((s) => ({
    session_id: s.session_id,
    provider: s.provider,
    cwd: s.cwd,
    workspace_binding: s.workspace_binding ?? null,
    last_active_at: s.last_active_at,
    liveness: ctx.sessionRegistry.liveness(s.session_id),
  }));
  return Response.json({
    daemon: {
      instance_id: ctx.instanceId,
      pid: process.pid,
      started_at: ctx.startedAt,
      protocol_version: PROTOCOL_VERSION,
      contract_version: CONTRACT_VERSION,
      build_id: BUILD_ID,
    },
    workspaces,
    sessions,
  });
}

/** Shared body for the two remaining route SHELLS (A1 §5.8/§5.10) — their real backends land in
 * later tasks (noted per call site below), but the slug-resolution + auth/contract/confinement
 * pipeline in front of them is real today, so the A3 §5 attack suite already covers these routes. */
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
async function handleStream(
  ctx: ApiContext,
  slug: string,
  req: Request,
  server: BunServer | undefined,
  authSignal?: AbortSignal,
): Promise<Response> {
  const url = new URL(req.url);
  const resolved = workspaceOrNotFound(ctx, slug, url.pathname);
  if (!resolved.ok) return resolved.response;
  const bus = await resolveBus(ctx, resolved.entry);
  return createJournalStreamResponse(resolved.entry, bus, req, server, {
    shutdownSignal: lifecycleSignal(ctx, authSignal),
    subscribeMetadata: ctx.metadataRegistry
      ? (listener) => ctx.metadataRegistry!.subscribe(resolved.entry, listener)
      : undefined,
  });
}

/** `GET /w/:slug/transcript/stream` (A1 §5.8/§8, P4.2) — resolves the slug, then the LIVE
 * session bound to it via the registry (never a cwd->slug guess, per A2 §F16's "Source
 * (Authoritative)"); no session at all, or none with a known `transcript_path`, is 404 "no
 * session registered" (A1 §5.8: "the SPA shows 'no session registered' rather than treating this
 * as a stream error"). Several live sessions with equal routing precedence (`forWorkspace`'s own
 * "never guess" contract) aren't disambiguated here — v1 has no session-picker wiring for the
 * conversation mirror, so this just takes the first; a future picker is additive. `transcript_
 * path` is confined under `$CLAUDE_CONFIG_DIR` (A2 §F16/A6 §F30's doctor check) BEFORE this route
 * ever opens it — outside that root is refused (400), never tailed. */
function handleTranscriptStream(
  ctx: ApiContext,
  slug: string,
  req: Request,
  server: BunServer | undefined,
  authSignal?: AbortSignal,
): Response {
  const url = new URL(req.url);
  const resolved = workspaceOrNotFound(ctx, slug, url.pathname);
  if (!resolved.ok) return resolved.response;

  const sessions = ctx.sessionRegistry.forWorkspace(resolved.entry.canonical_path).filter((s) => s.transcript_path);
  if (sessions.length === 0) {
    return problem(404, "not-found", "no session registered", undefined, url.pathname);
  }
  const transcriptPath = sessions[0]!.transcript_path as string;

  const confined = confineTranscriptPath(transcriptPath);
  if (!confined.ok) {
    return problem(
      400,
      "invalid-path",
      "transcript path is outside the allowed CLAUDE_CONFIG_DIR root",
      undefined,
      url.pathname,
    );
  }

  return createTranscriptStreamResponse(confined.realPath, req, server, {
    shutdownSignal: lifecycleSignal(ctx, authSignal),
  });
}

const CONVERSATION_MESSAGE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function conversationProblem(
  status: number,
  slug: string,
  title: string,
  instance: string,
  extra: Record<string, unknown> = {},
): Response {
  return new Response(
    JSON.stringify({
      type: `https://glosa.local/errors/${slug}`,
      title,
      status,
      instance,
      ...extra,
    }),
    { status, headers: { "Content-Type": "application/problem+json" } },
  );
}

function conversationResult(
  messageId: string,
  state: { status: string; deliveryAttempts?: unknown },
  fallback?: DeliveryResult,
): Record<string, unknown> {
  const attempts = Array.isArray(state.deliveryAttempts)
    ? (state.deliveryAttempts as Array<Record<string, unknown>>)
    : [];
  const latest = attempts.at(-1) ?? fallback;
  const delivered =
    state.status === "delivered" ||
    (latest !== undefined && typeof latest === "object" && (latest as Record<string, unknown>).outcome === "presented");
  return {
    message_id: messageId,
    accepted: true,
    delivered,
    state: delivered
      ? "presented"
      : latest && typeof latest === "object" && (latest as Record<string, unknown>).outcome === "transport_accepted"
        ? "transport_accepted"
        : latest && typeof latest === "object" && (latest as Record<string, unknown>).outcome === "failed"
          ? "failed"
          : "queued",
    ...(latest
      ? {
          delivery: {
            via: (latest as Record<string, unknown>).via,
            outcome: (latest as Record<string, unknown>).outcome,
          },
        }
      : {}),
  };
}

function composerCandidates(records: ReturnType<SessionRegistry["explicitlyBoundForWorkspace"]>) {
  return records.map((record) => ({
    session_id: record.session_id,
    provider: record.provider,
    last_active_at: record.last_active_at,
  }));
}

/** `POST /w/:slug/transcript/compose` — out-of-band, session-targeted conversation delivery.
 * The immutable inbox + journal carry the message; the transcript remains read-only. */
async function handleComposerSend(ctx: ApiContext, slug: string, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const resolved = workspaceOrNotFound(ctx, slug, url.pathname);
  if (!resolved.ok) return resolved.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return problem(400, "validation-failed", "body must be valid JSON", undefined, url.pathname);
  }
  const parsed = body as Record<string, unknown> | null;
  const text = parsed?.text;
  if (typeof text !== "string" || text.trim().length === 0) {
    return problem(400, "validation-failed", "text is required", undefined, url.pathname);
  }
  const suppliedMessageId = parsed?.message_id;
  if (
    suppliedMessageId !== undefined &&
    (typeof suppliedMessageId !== "string" || !CONVERSATION_MESSAGE_ID_RE.test(suppliedMessageId))
  ) {
    return problem(400, "validation-failed", "message_id must be a UUID", undefined, url.pathname);
  }
  const messageId = typeof suppliedMessageId === "string" ? suppliedMessageId : randomUUID();
  const sessionHint = typeof parsed?.session_hint === "string" ? parsed.session_hint : undefined;
  const bus = await resolveBus(ctx, resolved.entry);
  const existingEntry = bus.readEntry(messageId);
  let immutableTargetSession: string | undefined;
  let immutableProvider: string | undefined;
  if (existingEntry !== null) {
    const existingPayload =
      existingEntry.payload && typeof existingEntry.payload === "object"
        ? (existingEntry.payload as Record<string, unknown>)
        : null;
    if (
      existingPayload?.kind !== "conversation_message" ||
      existingPayload.text !== text ||
      typeof existingPayload.target_session_id !== "string" ||
      typeof existingPayload.provider !== "string" ||
      (sessionHint !== undefined && sessionHint !== existingPayload.target_session_id)
    ) {
      return conversationProblem(
        409,
        "idempotency-conflict",
        "message_id already identifies a different message",
        url.pathname,
      );
    }
    immutableTargetSession = existingPayload.target_session_id;
    immutableProvider = existingPayload.provider;
    const existingState = bus.state.entries[messageId];
    if (!existingState) return internalErrorResponse();
    const current = conversationResult(messageId, existingState);
    const latest = Array.isArray(existingState.deliveryAttempts) ? existingState.deliveryAttempts.at(-1) : undefined;
    if (existingState.status === "delivered") return Response.json(current);
    if (latest?.outcome !== "failed") return Response.json(current, { status: 202 });
  }

  const allBound = ctx.sessionRegistry.explicitlyBoundForWorkspace(resolved.entry.canonical_path, {
    includeStale: true,
  });
  const liveBound = allBound.filter((record) => ctx.sessionRegistry.liveness(record.session_id) === "alive");
  if (allBound.length === 0) {
    return conversationProblem(404, "no-bound-session", "no live session is explicitly bound", url.pathname, {
      recovery: "Start or resume an agent session and bind it to this workspace.",
    });
  }
  if (liveBound.length === 0) {
    return conversationProblem(409, "bound-session-stale", "the bound session is stale", url.pathname, {
      recovery: "Resume the bound agent session and try again.",
    });
  }

  let target = immutableTargetSession
    ? liveBound.find((record) => record.session_id === immutableTargetSession && record.provider === immutableProvider)
    : sessionHint
      ? liveBound.find((record) => record.session_id === sessionHint)
      : undefined;
  if (immutableTargetSession && !target) {
    return conversationProblem(409, "bound-session-stale", "the target session is not live", url.pathname, {
      recovery: "Resume the originally targeted agent session and try again.",
    });
  }
  if (!immutableTargetSession && sessionHint && !target) {
    return conversationProblem(
      409,
      "session-selection-required",
      "the selected session is not a live binding",
      url.pathname,
      {
        candidates: composerCandidates(liveBound),
      },
    );
  }
  if (!target && liveBound.length > 1) {
    return conversationProblem(409, "session-selection-required", "choose a live bound session", url.pathname, {
      candidates: composerCandidates(liveBound),
    });
  }
  target ??= liveBound[0];
  if (!target) {
    return conversationProblem(409, "bound-session-stale", "the selected session is not live", url.pathname, {
      candidates: composerCandidates(liveBound),
    });
  }

  const provider = ctx.providerRegistry?.get(target.provider);
  if (!provider) {
    return conversationProblem(503, "delivery-unavailable", "delivery is unavailable for this provider", url.pathname, {
      provider: target.provider,
      retryable: true,
    });
  }

  const payload = {
    kind: "conversation_message",
    text,
    target_session_id: target.session_id,
    provider: target.provider,
  } as const;
  const preview = buildDeliveryPresentation(messageId, payload, { status: "pending" });
  if (!preview || preview.bytes > 16 * 1024) {
    return conversationProblem(400, "validation-failed", "message exceeds the 16 KiB delivery limit", url.pathname, {
      max_bytes: 16 * 1024,
    });
  }

  if (existingEntry === null) {
    await bus.createEntry(messageId, payload, { idem: `conversation:${messageId}:created` });
  }

  const session: SessionBinding = {
    session_id: target.session_id,
    workspace: target.workspace_binding as string,
    source: target.source,
    ...(target.transcript_path ? { transcript_path: target.transcript_path } : {}),
  };
  let result: DeliveryResult;
  try {
    const deliverable = buildDeliveryPresentation(messageId, payload, { status: "pending" });
    if (!deliverable) throw new Error("invalid_conversation_message");
    result = await provider.deliver(session, deliverable);
  } catch {
    result = { via: "gate", outcome: "failed", error: "provider_delivery_failed" };
  }
  if (result.outcome === "failed") result = { ...result, error: "provider_delivery_failed" };
  const priorAttempts = bus.state.entries[messageId]?.deliveryAttempts;
  const attemptCount = Array.isArray(priorAttempts) ? priorAttempts.length : 0;
  const latestRecorded = Array.isArray(priorAttempts) ? priorAttempts.at(-1) : undefined;
  if (
    bus.state.entries[messageId]?.status !== "delivered" &&
    (latestRecorded?.via !== result.via || latestRecorded?.outcome !== result.outcome)
  ) {
    await recordDelivery(bus, messageId, session, result, {
      durable: true,
      idem: `conversation:${messageId}:delivery:${attemptCount + 1}`,
    });
  }

  const state = bus.state.entries[messageId];
  if (!state) return internalErrorResponse();
  const responseBody = conversationResult(messageId, state, result);
  if (result.outcome === "failed") {
    return conversationProblem(502, "delivery-failed", "the provider could not start delivery", url.pathname, {
      ...responseBody,
      retryable: true,
    });
  }
  return Response.json(responseBody, { status: responseBody.delivered === true ? 200 : 202 });
}

async function handleComposerStatus(
  ctx: ApiContext,
  slug: string,
  messageId: string,
  pathname: string,
): Promise<Response> {
  const resolved = workspaceOrNotFound(ctx, slug, pathname);
  if (!resolved.ok) return resolved.response;
  if (!CONVERSATION_MESSAGE_ID_RE.test(messageId)) {
    return problem(400, "validation-failed", "message_id must be a UUID", undefined, pathname);
  }
  const bus = await resolveBus(ctx, resolved.entry);
  const record = bus.readEntry(messageId);
  const payload = record?.payload;
  if (!payload || typeof payload !== "object" || (payload as Record<string, unknown>).kind !== "conversation_message") {
    return problem(404, "not-found", "conversation message not found", undefined, pathname);
  }
  const state = bus.state.entries[messageId];
  if (!state) return problem(404, "not-found", "conversation message not found", undefined, pathname);
  return Response.json(conversationResult(messageId, state));
}

/** `POST /w/:slug/capability/:artifactPath` (A1 §5.13/§7, P4.1) — mints a fresh, directory-scoped
 * capability for a class-F artifact. Runs the identical slug/confinePath/tracked-membership
 * pipeline handleGetArtifact does (A1 §6) so a mint request is held to the same bar before it's
 * ever allowed to hand one out; a confined-but-untracked path is 404, same failure class as every
 * other route (§6 step 4). A capability request for a class-R path is refused — A1 §7 is explicit
 * that "class R is served in-band via §5.4, never through this listener". */
function handleMintCapability(ctx: ApiContext, slug: string, artifactPath: string, pathname: string): Response {
  const resolved = workspaceOrNotFound(ctx, slug, pathname);
  if (!resolved.ok) return resolved.response;
  const root = resolved.entry.worktree_path;

  const confineResult = confinePath(root, artifactPath);
  if (!confineResult.ok) {
    return problem(400, "invalid-path", "path escapes the workspace or is malformed", undefined, pathname);
  }

  const relNfc = artifactPath
    .split("/")
    .map((segment) => segment.normalize("NFC"))
    .join("/");
  const { tracked } = resolveTrackedFiles(resolved.entry);
  const match = tracked.find((f) => f.path === relNfc);
  if (!match) return problem(404, "not-found", "path within workspace but no such artifact", undefined, pathname);

  const mintAdapter = ctx.adapterRegistry?.forWorkspace(resolved.entry);
  if (classifyWithAdapter(mintAdapter, root, match.path, classifyArtifactPath(match.path), resolved.entry) !== "F") {
    return problem(400, "invalid-path", "capability minting is only for class-F artifacts", undefined, pathname);
  }

  // realpath'd at MINT time, not at every serve — classf-serve.ts's confinePath call re-resolves
  // the requested sibling against this fixed real directory on every single request (A1 §7).
  const artifactDirRealPath = dirname(realpathSync(match.rawPath));
  const artifactBasename = basename(match.rawPath);
  const minted = ctx.capabilityStore.mint({ slug, artifactDirRealPath, artifactBasename });

  return Response.json({
    url: `http://127.0.0.1:${ctx.classFPort}/doc/${minted.token}/${artifactBasename}`,
    // Not one of A1 §5.12's two documented example fields — required by A3 §2's MessageChannel
    // handshake (the bridge validates the parent's `glosa:init` message against this exact
    // value). A1 itself defers the nonce/postMessage schema to F03/F18 (its own "out of scope"
    // footer), so this reconciles the two: A1's route/field names, A3's nonce requirement.
    nonce: minted.nonce,
    expires_in_s: CAPABILITY_TTL_MS / 1000,
  });
}

function matchApiRoute(ctx: ApiContext, req: Request, pathname: string): RouteMatch | null {
  const method = req.method;
  if (method === "GET" && pathname === "/api/handshake") {
    return { routeClass: "tokenless-handshake", handle: handleHandshake(ctx) };
  }
  if (method === "GET" && pathname === "/") {
    return { routeClass: "navigation", handle: () => serveShell() };
  }
  if (method === "GET" && pathname.startsWith("/app/")) {
    return { routeClass: "navigation", handle: () => serveSpaAsset(req, pathname) };
  }
  if (method === "GET" && pathname === "/api/workspaces") {
    return { routeClass: "authed-read", handle: () => handleListWorkspaces(ctx) };
  }
  // P4.3: the session-registration surface `glosa hook <event>` calls into (A2 §F08/R2) — see
  // the handlers' own header comment above.
  if (method === "POST" && pathname === "/api/sessions/register") {
    return { routeClass: "state-changing", handle: (req) => handleSessionRegister(ctx, req) };
  }
  // P5.1: the CLI-facing path-based workspace surface — see the handlers' own header comment
  // above (`open`/`resolve`/`apply-begin`/`request-review`/`status`).
  if (method === "POST" && pathname === "/api/workspaces/open") {
    return { routeClass: "state-changing", handle: (req) => handleWorkspaceOpen(ctx, req) };
  }
  if (method === "POST" && pathname === "/api/presentation-token/mint") {
    return { routeClass: "state-changing", handle: () => handlePresentationTokenMint(ctx, pathname) };
  }
  if (method === "POST" && pathname === "/api/presentation-token/redeem") {
    return { routeClass: "presentation-redeem", handle: (req) => handlePresentationTokenRedeem(ctx, req) };
  }
  if (method === "POST" && pathname === "/api/workspaces/resolve") {
    return { routeClass: "state-changing", handle: (req) => handleWorkspaceResolve(ctx, req) };
  }
  if (method === "POST" && pathname === "/api/workspaces/apply-begin") {
    return { routeClass: "state-changing", handle: (req) => handleWorkspaceApplyBegin(ctx, req) };
  }
  if (method === "POST" && pathname === "/api/workspaces/attention-request") {
    return { routeClass: "state-changing", handle: (req) => handleWorkspaceAttentionRequest(ctx, req) };
  }
  if (method === "GET" && pathname === "/api/workspaces/entry-status") {
    return { routeClass: "authed-read", handle: (req) => handleWorkspaceEntryStatus(ctx, req) };
  }
  if (method === "GET" && pathname === "/api/status") {
    return { routeClass: "authed-read", handle: () => handleStatusAggregate(ctx) };
  }

  let m: RegExpMatchArray | null;

  if (method === "POST" && (m = pathname.match(/^\/api\/sessions\/([^/]+)\/heartbeat$/))) {
    const sessionId = m[1] as string;
    return { routeClass: "state-changing", handle: () => handleSessionHeartbeat(ctx, sessionId) };
  }
  if (method === "POST" && (m = pathname.match(/^\/api\/sessions\/([^/]+)\/deregister$/))) {
    const sessionId = m[1] as string;
    return { routeClass: "state-changing", handle: () => handleSessionDeregister(ctx, sessionId) };
  }
  if (method === "POST" && (m = pathname.match(/^\/api\/sessions\/([^/]+)\/drain$/))) {
    const sessionId = m[1] as string;
    return { routeClass: "state-changing", handle: (req) => handleSessionDrain(ctx, sessionId, req) };
  }
  if (method === "POST" && (m = pathname.match(/^\/api\/sessions\/([^/]+)\/deliveries\/([^/]+)\/ack$/))) {
    const sessionId = m[1] as string;
    const deliveryId = m[2] as string;
    return { routeClass: "state-changing", handle: (req) => handleSessionDeliveryAck(ctx, sessionId, deliveryId, req) };
  }
  if (method === "GET" && (m = pathname.match(/^\/api\/sessions\/([^/]+)\/push-stream$/))) {
    const sessionId = m[1] as string;
    return {
      routeClass: "authed-read",
      handle: (req, server) => handleSessionPushStream(ctx, sessionId, req, server),
    };
  }
  if (method === "POST" && (m = pathname.match(/^\/api\/sessions\/([^/]+)\/conversation\/([^/]+)\/ack$/))) {
    const sessionId = m[1] as string;
    const messageId = m[2] as string;
    return {
      routeClass: "state-changing",
      handle: (req) => handleConversationAck(ctx, sessionId, messageId, req),
    };
  }

  if (method === "GET" && (m = pathname.match(/^\/w\/([^/]+)\/artifacts$/))) {
    const slug = m[1] as string;
    return { routeClass: "authed-read", handle: () => handleListArtifacts(ctx, slug, pathname) };
  }
  if (method === "GET" && (m = pathname.match(/^\/w\/([^/]+)\/inbox\/([^/]+)\/presentation$/))) {
    const slug = m[1] as string;
    const entryId = m[2] as string;
    return { routeClass: "authed-read", handle: (req) => handleInboxPresentation(ctx, slug, entryId, req) };
  }
  if (method === "GET" && (m = pathname.match(/^\/w\/([^/]+)\/artifacts\/(.+)$/))) {
    const slug = m[1] as string;
    const path = m[2] as string;
    return { routeClass: "authed-read", handle: (req) => handleGetArtifact(ctx, slug, path, req) };
  }
  // P3.3 addition — not in A1 §5 (see handlePutArtifact's own docstring): the class-R editor's
  // save action.
  if (method === "PUT" && (m = pathname.match(/^\/w\/([^/]+)\/artifacts\/(.+)$/))) {
    const slug = m[1] as string;
    const path = m[2] as string;
    return { routeClass: "state-changing", handle: (req) => handlePutArtifact(ctx, slug, path, req) };
  }
  // P3.2: artifact/journal SSE stream (A1 §5.5, full protocol §8).
  if (method === "GET" && (m = pathname.match(/^\/w\/([^/]+)\/stream$/))) {
    const slug = m[1] as string;
    return {
      routeClass: "authed-read",
      handle: (req, server, authSignal) => handleStream(ctx, slug, req, server, authSignal),
    };
  }
  // P4.2: conversation-mirror SSE stream (A1 §5.8/§8, A2 §F16).
  if (method === "GET" && (m = pathname.match(/^\/w\/([^/]+)\/transcript\/stream$/))) {
    const slug = m[1] as string;
    return {
      routeClass: "authed-read",
      handle: (req, server, authSignal) => handleTranscriptStream(ctx, slug, req, server, authSignal),
    };
  }
  // P4.2: the conversation viewer's out-of-band composer (F32/R6) — not in A1 §5, see
  // handleComposerSend's own docstring.
  if (method === "POST" && (m = pathname.match(/^\/w\/([^/]+)\/transcript\/compose$/))) {
    const slug = m[1] as string;
    return { routeClass: "state-changing", handle: (req) => handleComposerSend(ctx, slug, req) };
  }
  if (method === "GET" && (m = pathname.match(/^\/w\/([^/]+)\/transcript\/compose\/([^/]+)$/))) {
    const slug = m[1] as string;
    const messageId = m[2] as string;
    return {
      routeClass: "authed-read",
      handle: () => handleComposerStatus(ctx, slug, messageId, pathname),
    };
  }
  if (method === "POST" && (m = pathname.match(/^\/w\/([^/]+)\/annotations$/))) {
    const slug = m[1] as string;
    return { routeClass: "state-changing", handle: (req) => handleCreateAnnotation(ctx, slug, req) };
  }
  if (method === "POST" && (m = pathname.match(/^\/w\/([^/]+)\/annotations\/([^/]+)\/withdraw$/))) {
    const slug = m[1] as string;
    const entryId = m[2] as string;
    return { routeClass: "state-changing", handle: (req) => handleWithdrawAnnotation(ctx, slug, entryId, req) };
  }
  if (method === "GET" && (m = pathname.match(/^\/w\/([^/]+)\/diff$/))) {
    const slug = m[1] as string;
    return { routeClass: "authed-read", handle: (req) => handleDiff(ctx, slug, req) };
  }
  // P3.5: full checkpoint history (A6 §F31).
  if (method === "GET" && (m = pathname.match(/^\/w\/([^/]+)\/checkpoints$/))) {
    const slug = m[1] as string;
    return { routeClass: "authed-read", handle: (req) => handleCheckpoints(ctx, slug, req) };
  }
  // P3.5: restore an artifact's bytes from a checkpoint (A6 §F31).
  if (method === "POST" && (m = pathname.match(/^\/w\/([^/]+)\/restore$/))) {
    const slug = m[1] as string;
    return { routeClass: "state-changing", handle: (req) => handleRestore(ctx, slug, req) };
  }
  if (method === "GET" && (m = pathname.match(/^\/w\/([^/]+)\/inbox$/))) {
    const slug = m[1] as string;
    return { routeClass: "authed-read", handle: () => handleInbox(ctx, slug, pathname) };
  }
  if (method === "POST" && (m = pathname.match(/^\/w\/([^/]+)\/inbox\/([^/]+)\/seen$/))) {
    const slug = m[1] as string;
    const entryId = m[2] as string;
    return { routeClass: "state-changing", handle: (req) => handleAttentionSeen(ctx, slug, entryId, req) };
  }
  if (method === "POST" && (m = pathname.match(/^\/w\/([^/]+)\/inbox\/([^/]+)\/response$/))) {
    const slug = m[1] as string;
    const entryId = m[2] as string;
    return { routeClass: "state-changing", handle: (req) => handleAttentionResponse(ctx, slug, entryId, req) };
  }
  if (method === "GET" && (m = pathname.match(/^\/w\/([^/]+)\/metadata$/))) {
    const slug = m[1] as string;
    return { routeClass: "authed-read", handle: () => handleGetMetadata(ctx, slug, pathname) };
  }
  if (method === "PUT" && (m = pathname.match(/^\/w\/([^/]+)\/metadata$/))) {
    const slug = m[1] as string;
    return { routeClass: "state-changing", handle: (req) => handleSetMetadata(ctx, slug, req) };
  }
  if (method === "DELETE" && (m = pathname.match(/^\/w\/([^/]+)\/metadata$/))) {
    const slug = m[1] as string;
    return { routeClass: "state-changing", handle: () => handleClearMetadata(ctx, slug, pathname) };
  }
  if (method === "POST" && (m = pathname.match(/^\/w\/([^/]+)\/session-binding$/))) {
    const slug = m[1] as string;
    return { routeClass: "state-changing", handle: (req) => handleSessionBinding(ctx, slug, req) };
  }
  // P4.1: class-F capability-URL mint (A1 §7).
  if (method === "POST" && (m = pathname.match(/^\/w\/([^/]+)\/capability\/(.+)$/))) {
    const slug = m[1] as string;
    const artifactPath = m[2] as string;
    return { routeClass: "state-changing", handle: () => handleMintCapability(ctx, slug, artifactPath, pathname) };
  }

  return null;
}

function logUnhandledRequestError(req: Request, error: unknown): void {
  const normalized = error instanceof Error ? error : new Error(String(error));
  let pathname = "<invalid-url>";
  try {
    pathname = new URL(req.url).pathname;
  } catch {
    // The Request constructor normally guarantees a valid URL. Keep logging fail-safe anyway:
    // this diagnostic path must never mask the original exception with a second throw.
  }
  const stack = normalized.stack ?? `${normalized.name}: ${normalized.message}\n    <stack unavailable>`;
  // The detached daemon redirects stderr to ~/.glosa/daemon.log. Deliberately log only the
  // request method/path plus exception diagnostics — never headers, query parameters, or body,
  // any of which may contain bearer/capability tokens or manuscript content.
  console.error(
    `[glosa] unhandled request ${req.method} ${pathname}\nmessage: ${normalized.message}\nstack:\n${stack}`,
  );
}

export function createApiFetch(ctx: ApiContext): (req: Request, server?: BunServer) => Promise<Response> {
  const csp = spaCspHeaders(ctx.classFPort);

  return async (req, server) => {
    try {
      const url = new URL(req.url);

      // Host check runs first, unconditionally, before route lookup even knows a route class
      // exists (A3 §4 Rule 1). Literal mismatch → 400, closed, no body — never 403.
      if (!checkHost(req, ctx.port)) return new Response(null, { status: 400 });

      const route = matchApiRoute(ctx, req, url.pathname);
      if (!route) {
        // A foreign Origin is rejected even on a route that doesn't exist (A1 §1 "Origin
        // allowlisted first, regardless of route") — otherwise 403-on-real-route vs
        // 404-on-fake-route is a route-enumeration side channel for a hostile page (A3 §4).
        if (isForeignOrigin(req, ctx.port)) {
          return withHeaders(problem(403, "invalid-origin", "origin not allowed", undefined, url.pathname), csp);
        }
        return withHeaders(problem(404, "not-found", "no such route", undefined, url.pathname), csp);
      }

      const authSnapshot = tokenSnapshot(ctx.token);
      const authResult = authorizeRequest(req, {
        routeClass: route.routeClass,
        port: ctx.port,
        token: authSnapshot.token,
      });
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

      const res = await route.handle(effectiveReq, server, authSnapshot.signal);
      if (authSnapshot.signal?.aborted && route.routeClass !== "tokenless-handshake") {
        // A credential generation changed after this request passed auth. Streams already bind
        // to the same signal; clearing here also closes the narrow mint-after-rotation race where
        // a stale request could otherwise create a capability after the generation subscriber ran.
        ctx.capabilityStore.clear();
        ctx.presentationTokenStore?.clear();
        return withHeaders(
          problem(401, "unauthorized", "missing or invalid bearer token", undefined, url.pathname),
          csp,
        );
      }
      const withCsp = withHeaders(res, csp);
      if (contractWarning) withCsp.headers.set("X-Contract-Warning", "stale-minor");
      return withCsp;
    } catch (error) {
      if (error instanceof WorkspaceAdoptedError) {
        return withHeaders(problem(409, "workspace-adopted", error.message, undefined, new URL(req.url).pathname), csp);
      }
      if (error instanceof AdoptionError) {
        return withHeaders(problem(409, error.code, error.message, undefined, new URL(req.url).pathname), csp);
      }
      // Never let a throw anywhere in the pipeline (a route handler, a future JSON.parse, a bug
      // in this function) reach Bun's default error response — that leaks source/stack in dev
      // mode and has no CSP either way (P1.3 review item 2). The Bun.serve `error` callback in
      // lifecycle.ts is the second layer, for a throw that somehow still escapes this try/catch.
      logUnhandledRequestError(req, error);
      return internalErrorResponse(csp);
    }
  };
}

/** The class-F listener's ONLY route: `GET /doc/:token/<path...>`. Never accepts a Bearer — the
 * capability token IS the auth (A1 §7, A3 §1) — so this pipeline is deliberately just Host-check
 * → route parse → `serveClassFDocument`, none of the SPA/API listener's Origin/Bearer/contract
 * machinery. `capabilityStore` is the SAME instance `ApiContext.capabilityStore` mints into
 * (lifecycle.ts wires both fetch handlers from one store) — a token minted on the SPA origin must
 * be resolvable here. */
export function createClassFFetch(ctx: {
  port: number;
  spaPort: number;
  capabilityStore: CapabilityStore;
  tokenSource?: TokenSource;
}): (req: Request) => Promise<Response> {
  const csp = classFCspHeaders(ctx.spaPort);

  return async (req) => {
    try {
      if (!checkHost(req, ctx.port)) return new Response(null, { status: 400 });

      // Refresh before capability lookup. TokenAuthority's generation subscriber clears the
      // shared store, so a rotate/revoke invalidates already-minted iframe URLs too.
      ctx.tokenSource?.current();

      const url = new URL(req.url);
      const routeMatch = url.pathname.match(/^\/doc\/([^/]+)\/(.+)$/);
      if (!routeMatch) return withHeaders(new Response("not found", { status: 404 }), csp);
      const token = routeMatch[1] as string;
      const path = routeMatch[2] as string;

      const res = serveClassFDocument(ctx.capabilityStore, token, path);
      if (!res) return withHeaders(new Response("not found", { status: 404 }), csp);
      return withHeaders(res, csp);
    } catch {
      return internalErrorResponse(csp);
    }
  };
}

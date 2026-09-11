// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — the two listeners' fetch pipelines (A1 §1/§3/§4, A3 §4). Wires together
// host-check → route lookup → authorizeRequest → contract-version gate → body cap → handler for
// the SPA/API listener, and the minimal host-check-only pipeline for the class-F listener.
//
// Route families own URL/body validation and exact problem mapping. The top-level pipeline keeps
// host checks, route precedence, authorization, contract-version enforcement, and body limits.

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterRegistry, AdapterSessionHint } from "../adapters/interface.ts";
import { WorkspaceMetadataError, type WorkspaceMetadataRegistry } from "../adapters/workspace-metadata.ts";
import { AdoptionCoordinator, adoptLooseLineages } from "../adoption.ts";
import type { AgentProviderRegistry, DeliverableEntry } from "../agent-provider/interface.ts";
import type { SessionPushRegistry } from "../agent-provider/push-registry.ts";
import { sourceSha256 } from "../artifact-render.ts";
import type { ArtifactWatcherRegistry } from "../artifact-watcher.ts";
import { WorkspaceAdoptedError, type WorkspaceBus } from "../bus/bus.ts";
import { type DeliveryVia, isTerminal } from "../bus/lifecycle.ts";
import { badgePendingCount, hasOpenAttention, orphanedEntryCount, peekJournal } from "../bus/peek.ts";
import { CompositeDeliveryRegistry } from "../delivery/composite-reservations.ts";
import { MAX_BATCH_PRESENTATION_BYTES, MAX_ENTRY_PRESENTATION_BYTES, utf8Bytes } from "../delivery/presentation.ts";
import { probeInitManifest } from "../init-probe.ts";
import type { InitRunner } from "../init-runner.ts";
import { BUILD_ID } from "../lifecycle/build-id.ts";
import { INSTALL_ID } from "../lifecycle/install.ts";
import { glosaHome } from "../lifecycle/home.ts";
import { PROTOCOL_VERSION } from "../lifecycle/protocol.ts";
import { forgetWorkspace } from "../registry/forget-workspace.ts";
import { type OrphanedState, scanOrphanedHomeState } from "../registry/orphan-scan.ts";
import { SessionProviderConflict, type SessionRecord, type SessionRegistry } from "../registry/session-registry.ts";
import { canonicalize } from "../registry/slug.ts";
import {
  AdoptionError,
  type WorkspaceEntry,
  type WorkspaceIndex,
  WorkspaceOpenError,
} from "../registry/workspace-index.ts";
import { artifactRoutes } from "../routes/artifact.ts";
import { attentionRoutes } from "../routes/attention.ts";
import { composerRoutes } from "../routes/composer.ts";
import type { BunServer, RouteMatch } from "../routes/types.ts";
import { authorizeRequest, isForeignOrigin } from "../security/auth.ts";
import type { CapabilityStore } from "../security/capability.ts";
import { classFCspHeaders, spaCspHeaders } from "../security/csp.ts";
import { PRESENTATION_TOKEN_TTL_MS, type PresentationTokenStore } from "../security/presentation-token.ts";
import type { TokenSource } from "../security/token.ts";
import {
  type ArtifactAccessDependencies,
  actionablePresentation as buildArtifactPresentation,
  listInboxEntries,
} from "../services/artifact.ts";
import { getOrRegisterWorkspace } from "../services/workspace-access.ts";
import { confineTranscriptPath } from "../transcript/root.ts";
import { createTranscriptStreamResponse } from "../transcript/stream.ts";
import { type WorkspaceTarget, workspaceRegistrationId } from "../workspace.ts";
import { serveClassFDocument } from "./classf-serve.ts";
import { CONTRACT_VERSION, checkContractVersion, DAEMON_VERSION } from "./contract.ts";
import { forgetBlockedResponse, forgetStalePreviewResponse, internalErrorResponse, problem } from "./problem.ts";
import { createJournalStreamResponse } from "./stream.ts";

const BODY_CAP_BYTES = 1024 * 1024; // A1 §4

/** Bun's `fetch` handler is always invoked with `(req, server)` — this is that `server`'s type,
 * aliased here (rather than importing a `bun` global type name) to match the existing
 * `ReturnType<typeof Bun.serve>` convention already used in lifecycle.ts. Optional everywhere it
 * appears below so route-schema-level tests that call `createApiFetch(ctx)`'s returned function
 * directly (no real bound `Bun.serve`, e.g. http-routes.test.ts) don't have to fabricate one —
 * only the stream route (P3.2) actually needs it, for `server.timeout(req, 0)` (A1 §8.3). */
export type { BunServer } from "../routes/types.ts";

// The SPA's static source dir (`packages/spa/src/`), resolved relative to this file rather than
// `process.cwd()` so it's correct regardless of where `glosa` is invoked from (P1.4).
const SPA_SRC_DIR = fileURLToPath(new URL("../../../spa/src/", import.meta.url));

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
  "viewer-shell.js": "text/javascript; charset=utf-8",
  "viewer-context-surfaces.js": "text/javascript; charset=utf-8",
  "viewer-feedback.js": "text/javascript; charset=utf-8",
  "viewer-navigator.js": "text/javascript; charset=utf-8",
  "agent-feedback.js": "text/javascript; charset=utf-8",
  "artifact-tree.js": "text/javascript; charset=utf-8",
  "annotate.js": "text/javascript; charset=utf-8",
  // The agent's half of the Review margin: source→rendered quote resolution and card shaping.
  "agent-request.js": "text/javascript; charset=utf-8",
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
  // Multi-artifact workbench (design brief docs/design/2026-09-04-multi-artifact-workbench-brief.md):
  // the dock engine and its stylesheet, one pane per artifact, and a comparison as a pane.
  "dock.js": "text/javascript; charset=utf-8",
  "artifact-pane.js": "text/javascript; charset=utf-8",
  // The fore-edge index: one pane's document outline, drawn in the whitespace the manuscript
  // already leaves. Pure DOM over entries the pane hands it — no transport of its own.
  "outline.js": "text/javascript; charset=utf-8",
  "diff-pane.js": "text/javascript; charset=utf-8",
  "vendor/dockview.js": "text/javascript; charset=utf-8",
  // Served as a real stylesheet rather than injected inline, so it lands under `style-src 'self'`.
  "vendor/dockview.css": "text/css; charset=utf-8",
};

export interface ApiContext {
  port: number;
  classFPort: number;
  /** A static token remains accepted for narrow tests. Production passes TokenAuthority so each
   * request sees the current on-disk generation without restarting the daemon. */
  token: string | null | TokenSource;
  instanceId: string;
  startedAt: string;
  /** Daemon-owned reconciliation hook for a lock file that disappeared after initial ownership
   * was established. The tokenless handshake may trigger the repair, but clients never write the
   * lock themselves. Optional for hand-built test contexts. */
  repairLockOwnership?: () => void;
  workspaceIndex: WorkspaceIndex;
  sessionRegistry: SessionRegistry;
  /** Always resolves to the SAME `WorkspaceBus` instance for a given canonical root (backed by
   * the daemon's one `WorkspaceBusRegistry`, see lifecycle.ts's `buildBackend`) — routes never
   * construct their own `WorkspaceBus`. */
  getWorkspaceBus: (workspace: WorkspaceTarget) => WorkspaceBus;
  /** Ephemeral only: coordinates a single agent-visible batch assembled from several workspace
   * reservations. Optional for hand-built tests; `createApiFetch` owns one per context otherwise. */
  compositeDeliveryRegistry?: CompositeDeliveryRegistry;
  /** Atomically preflights and seals all loose sources through the daemon's shared registry. */
  sealAdoptionSources?: (
    sources: readonly WorkspaceTarget[],
    adoptionId: string,
    targetRegistrationId: string,
  ) => Promise<void>;
  /** Serializes the complete loose-file adoption transaction per target. Optional only for
   * hand-built contexts; production shares the backend's daemon-scoped coordinator. */
  adoptionCoordinator?: AdoptionCoordinator;
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
  /** Daemon-owned shared artifact watcher. Optional only for narrow route/stream tests. */
  artifactWatcherRegistry?: ArtifactWatcherRegistry;
  /** Lifecycle signal used to send `event: bye` and close long-lived streams on SIGTERM. */
  shutdownSignal?: AbortSignal;
  /** Throttled 401 diagnostics (A3 §4). Optional so every hand-built test context keeps compiling;
   * production wires `createRejectionRecorder` over the daemon log in lifecycle.ts. Scoped to the
   * SPA/API listener — class-F carries its capability in the URL path and must never reach a
   * recorder that could one day be asked to include one. */
  recordRejection?: (reason: RejectionReason) => void;
  /** GLOSA_HOME for the orphaned-state scan in `GET /api/status` (issue #79). Optional and
   * defaulted to `glosaHome()` at the use site so every hand-built test context keeps compiling;
   * production wires the boot-time home (lifecycle.ts) so a custom `GLOSA_HOME` is honored. */
  home?: string;
  /** The consent-gated `glosa init` shell-out behind `POST /w/:slug/init` (issue #80, A1 §5.19).
   * Optional: absent → the route answers 503 (same posture as an absent providerRegistry), so
   * hand-built test contexts keep compiling and narrow tests can inject a fake. Production wires
   * `createInitRunner` in lifecycle.ts. */
  runWorkspaceInit?: InitRunner;
}

const contextCompositeRegistries = new WeakMap<ApiContext, CompositeDeliveryRegistry>();
const contextAdoptionCoordinators = new WeakMap<ApiContext, AdoptionCoordinator>();

function compositeRegistry(ctx: ApiContext): CompositeDeliveryRegistry {
  if (ctx.compositeDeliveryRegistry) return ctx.compositeDeliveryRegistry;
  let registry = contextCompositeRegistries.get(ctx);
  if (!registry) {
    registry = new CompositeDeliveryRegistry();
    contextCompositeRegistries.set(ctx, registry);
  }
  return registry;
}

/** The daemon's ONE per-target ownership lock (`ApiContext.adoptionCoordinator`, kept its original
 * field/type name for wire/wiring compatibility). Originally scoped to `adoptLooseLineages`'s own
 * seal/build/publish transaction; issue #156's revised approach generalizes it to every mutation
 * that can race a workspace's identity — loose-file adoption, `glosa forget`'s commit, and now
 * session register/bind — so exactly one of them ever holds a given target's lock at a time, and
 * each re-reads durable state fresh once it actually has the lock rather than trusting whatever it
 * observed beforehand. */
function ownershipCoordinator(ctx: ApiContext): AdoptionCoordinator {
  if (ctx.adoptionCoordinator) return ctx.adoptionCoordinator;
  let coordinator = contextAdoptionCoordinators.get(ctx);
  if (!coordinator) {
    coordinator = new AdoptionCoordinator();
    contextAdoptionCoordinators.set(ctx, coordinator);
  }
  return coordinator;
}

/** The handshake body extends the A1 §5.1 response with daemon-lifecycle fields: it keeps
 * `protocol_version`/`instance_id`/`pid`/`started_at` so `ensureDaemon`/`fetchHandshake` keep
 * working unchanged, and adds the A1 §5.1 fields the SPA needs (`contract_version` ===
 * `protocol_version` by this task's resolution, `daemon_version`, `paired`). */
export interface HandshakeBody {
  contract_version: string;
  daemon_version: string;
  build_id: string;
  /** Which install started this daemon (A5 §F13). A hash, never a path — this endpoint is
   * tokenless. Lets `ensureDaemon` refuse to stop a daemon another install owns, and lets the SPA
   * tell "my daemon restarted" apart from "something else is on this port". */
  install_id: string;
  paired: boolean;
  protocol_version: string;
  instance_id: string;
  pid: number;
  started_at: string;
}

function checkHost(req: Request, port: number): boolean {
  return req.headers.get("Host") === `127.0.0.1:${port}`;
}

/** Why a request was refused, at the coarsest granularity that still answers "was the tab holding a
 * stale credential, or had this daemon no credential at all?" — the question a de-pair report can
 * never be settled without after the fact. */
export type RejectionReason = "no-token-on-daemon" | "bearer-mismatch" | "credential-rotated";

const REJECTION_THROTTLE_MS = 60_000;

/**
 * Throttled 401 recorder (A3 §4). Two deliberate omissions:
 *
 * - **No request path.** It is attacker-controlled, so logging it is both an injection vector into
 *   a line-oriented log and unbounded key cardinality. A throttle keyed on the path is no throttle
 *   at all: vary the path and every request is a fresh "first occurrence", which turns a diagnostic
 *   into a disk-filling primitive for any local page. The key is the REASON alone.
 * - **No credential, not even a prefix.** The whole point of the log is to be safe to read.
 */
export function createRejectionRecorder(
  write: (line: string) => void,
  now: () => number = () => Date.now(),
): (reason: RejectionReason) => void {
  const lastLoggedAt = new Map<RejectionReason, number>();
  const suppressed = new Map<RejectionReason, number>();
  return (reason) => {
    const at = now();
    const previous = lastLoggedAt.get(reason);
    if (previous !== undefined && at - previous < REJECTION_THROTTLE_MS) {
      suppressed.set(reason, (suppressed.get(reason) ?? 0) + 1);
      return;
    }
    const held = suppressed.get(reason) ?? 0;
    suppressed.delete(reason);
    lastLoggedAt.set(reason, at);
    write(held > 0 ? `401 ${reason} (${held} more suppressed in the last 60s)` : `401 ${reason}`);
  };
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

function handleHandshake(ctx: ApiContext): () => Response {
  return () => {
    ctx.repairLockOwnership?.();
    const body: HandshakeBody = {
      contract_version: CONTRACT_VERSION,
      daemon_version: DAEMON_VERSION,
      build_id: BUILD_ID,
      install_id: INSTALL_ID,
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

function isAdoptingTarget(entry: WorkspaceEntry | null): boolean {
  return entry?.lifecycle?.state === "adopting" && entry.lifecycle.target_registration_id === entry.registration_id;
}

/** issue #156: an entry whose `glosa forget` deletion is durably committed (possibly mid-resume
 * after a crash) — the TARGET or any of its sealed sources, both marked `"forgetting"` the moment
 * the transaction commits. Deliberately NOT self-reference-scoped like `isAdoptingTarget`: a
 * source's own slug must refuse routing too, since its bus is just as much a part of the active
 * deletion as the target's. Ordinary routes must never touch either — new activity here would
 * race the file deletion `forget-workspace.ts` performs. */
function isBeingForgotten(entry: WorkspaceEntry | null): boolean {
  return entry?.lifecycle?.state === "forgetting";
}

/** Resolves any workspace entry to its PROVENANCE OWNER (issue #156 review finding 4): an adopted
 * source (`lifecycle.state === "adopted"`) or a member mid an active/pending forget
 * (`lifecycle.state === "forgetting"`) both carry a `target_registration_id` pointing at the entry
 * that actually owns routing/locking/liveness for this canonical identity now — self-referencing
 * for the owner itself. Session register/bind MUST canonicalize through this before selecting the
 * per-target ownership lock key or storing a `workspace_binding`: locking the SOURCE's own
 * registration_id while `glosa forget`'s commit locks the TARGET's leaves the two entirely
 * unserialized for a session still addressed by (or bound to) a pre-adoption alias path, and a
 * `workspace_binding` left as the source's raw path would never match `forgetBlockers`'s
 * `sessionRegistry.forWorkspace(target.canonical_path)` liveness check either. Falls back to the
 * entry itself if the pointer is dangling (defensive; should be unreachable). */
function provenanceOwner(index: WorkspaceIndex, entry: WorkspaceEntry): WorkspaceEntry {
  const lifecycle = entry.lifecycle;
  if (lifecycle?.state === "adopted" || lifecycle?.state === "forgetting") {
    return index.getWorkspaceByRegistration(lifecycle.target_registration_id) ?? entry;
  }
  return entry;
}

function workspaceOrNotFound(ctx: ApiContext, slug: string, pathname: string) {
  const entry = ctx.workspaceIndex.getBySlug(slug);
  if (!entry)
    return { ok: false as const, response: problem(404, "not-found", "unknown workspace", undefined, pathname) };
  if (isAdoptingTarget(entry)) {
    return {
      ok: false as const,
      response: problem(409, "workspace-adopting", "workspace adoption is in progress", undefined, pathname),
    };
  }
  if (isBeingForgotten(entry)) {
    return {
      ok: false as const,
      response: problem(409, "workspace-forgetting", "workspace is being forgotten", undefined, pathname),
    };
  }
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

// peekJournal / hasOpenAttention / pendingCount moved to bus/peek.ts (issue #79) so the
// workspace-index GC pending-work guard and the orphaned-home-state scanner share the exact same
// read-only fold these handlers use — the docstring rationale lives there now.

/** Routes that need the LIVE bus (annotations, diff) reconcile the first time they touch a given
 * `WorkspaceBus` INSTANCE, then reuse its already-reconciled in-memory `bus.state` on every later
 * request — `WorkspaceBus.reconcileOnce()` owns that "once per instance" gate itself (P3.1 review
 * fix: an external cache keyed by root string would survive past a `WorkspaceBusRegistry.evict()`
 * + reopen and wrongly skip reconciling the fresh instance underneath it — see reconcileOnce's own
 * docstring in bus.ts). */
async function resolveBus(ctx: ApiContext, root: WorkspaceTarget): Promise<WorkspaceBus> {
  const indexed = ctx.workspaceIndex.getWorkspaceByRegistration(workspaceRegistrationId(root));
  if (isAdoptingTarget(indexed)) {
    throw new AdoptionError("workspace-adopting", "workspace adoption is in progress");
  }
  if (isBeingForgotten(indexed)) {
    throw new AdoptionError("workspace-forgetting", "workspace is being forgotten");
  }
  // Held-review finding (third pass): "registration-less pending operations are not enforced by
  // the central bus/access boundary" — every path-addressed caller of this function (resolve,
  // apply-begin, dismiss, delivery drain/ack, conversation acknowledgement) falls back to a bare
  // canonical-path STRING once `indexed` is null, which previously read as "never seen before" even
  // during the exact registration-less window between a forget's own deregistration step and its
  // completion receipt — `ctx.getWorkspaceBus(root)` would then happily recreate the bus this
  // deletion is mid-way through removing. Checked here, once, for every caller: an active operation
  // still naming this canonical path refuses BEFORE a bus is ever constructed or reconciled.
  if (!indexed) {
    const canonicalPath = typeof root === "string" ? root : root.canonical_path;
    if (ctx.workspaceIndex.activeForgetOperationForCanonicalPath(canonicalPath)) {
      throw new AdoptionError("workspace-forgetting", "workspace is being forgotten");
    }
  }
  const bus = ctx.getWorkspaceBus(root);
  await bus.reconcileOnce();
  return bus;
}

function artifactAccess(ctx: ApiContext): ArtifactAccessDependencies {
  return {
    workspaceIndex: ctx.workspaceIndex,
    getWorkspaceBus: ctx.getWorkspaceBus,
    adapterRegistry: ctx.adapterRegistry,
  };
}

/** Provider-owned exact identity discovery; absence must never prevent registration. */
function discoverTranscript(
  ctx: ApiContext,
  session: { session_id: string; provider: string; cwd: string; source: string },
): string | undefined {
  const provider = ctx.providerRegistry?.get(session.provider);
  try {
    const path = provider?.transcriptPath({ ...session, workspace: session.cwd });
    return path && confineTranscriptPath(path, provider?.transcriptRoots?.()).ok ? path : undefined;
  } catch {
    return undefined;
  }
}

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
  const b = body as Record<string, unknown> | null;
  const sessionId = b?.session_id;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return problem(400, "validation-failed", "session_id is required", undefined, url.pathname);
  }
  for (const field of ["provider", "cwd", "source"] as const) {
    if (b?.[field] !== undefined && (typeof b[field] !== "string" || b[field].length === 0)) {
      return problem(400, "validation-failed", `${field} must be a nonempty string`, undefined, url.pathname);
    }
  }
  const cwd = typeof b?.cwd === "string" ? canonicalOrNull(b.cwd) : undefined;
  if (cwd === null)
    return problem(400, "invalid-path", "cwd does not resolve to a real directory", undefined, url.pathname);

  // issue #156 revised approach: session binding shares the SAME per-target ownership lock a
  // `glosa forget` commit holds while it re-checks liveness and writes its durable marker — never
  // just the lock-free `workspaceOrNotFound` read above, which can go stale in the gap before this
  // mutation actually lands. Re-checking fresh state under the lock closes that race in both
  // directions: a bind that wins the lock is a live session `forget`'s own recheck will see, and a
  // bind that loses it sees the marker and refuses instead of resurrecting a workspace mid-deletion.
  //
  // `:slug` can name a sealed adopted source directly (still "adopted", not yet "forgetting" —
  // `workspaceOrNotFound` above only refuses the latter) — `provenanceOwner` canonicalizes to the
  // OWNING target for both the lock key and the bound path, so this can never lock or bind against
  // a different registration than the one `forget`'s own commit locks (review finding 4).
  const owner = provenanceOwner(ctx.workspaceIndex, resolved.entry);
  try {
    const blocked = await ownershipCoordinator(ctx).run(owner.registration_id, async () => {
      const fresh = ctx.workspaceIndex.getWorkspaceByRegistration(owner.registration_id);
      if (fresh?.lifecycle?.state === "forgetting") return true;
      await ctx.sessionRegistry.bind(sessionId, owner.canonical_path, {
        provider: b?.provider as string | undefined,
        cwd,
        source: b?.source as string | undefined,
        transcript_path: discoverTranscript(ctx, {
          session_id: sessionId,
          provider: (b?.provider as string | undefined) ?? ctx.sessionRegistry.get(sessionId)?.provider ?? "mcp",
          cwd: cwd ?? ctx.sessionRegistry.get(sessionId)?.cwd ?? owner.canonical_path,
          source: (b?.source as string | undefined) ?? "manual",
        }),
      });
      return false;
    });
    if (blocked) {
      return problem(409, "workspace-forgetting", "workspace is being forgotten", undefined, url.pathname);
    }
  } catch (error) {
    if (error instanceof SessionProviderConflict)
      return problem(409, "session-provider-conflict", error.message, undefined, url.pathname);
    throw error;
  }

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
/** A canonical path that exists AND is a directory. `canonicalOrNull` alone is realpath-only, so a
 * regular file passes it; a workspace scope naming a file is not a workspace. */
function isExistingDirectory(canonicalPath: string): boolean {
  try {
    return statSync(canonicalPath).isDirectory();
  } catch {
    return false;
  }
}

function canonicalOrNull(path: string): string | null {
  try {
    return canonicalize(path);
  } catch {
    return null;
  }
}

/** `POST /api/sessions/register` — A2 §F08's merge-safe session registration. It records the session and
 * returns the identity the caller resolved to; it never pushes or delivers. R2's "no live session
 * -> park; next registration for that workspace drains it" is NOT settled here: a park is an entry
 * left non-terminal in the workspace journal, and the drain is the separate
 * `POST /api/sessions/:id/drain` the same hook invocation calls immediately after this one (see
 * `handleSessionDrain`, and `glosa hook session-start`). Nothing about a park lives in daemon
 * memory, so it survives a daemon restart. */
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
  let fallbackBinding: string | undefined;
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
      if (canonicalAdapterBinding) fallbackBinding = canonicalAdapterBinding;
    }
  }

  const transcriptPath =
    typeof b?.transcript_path === "string" && b.transcript_path.length > 0
      ? b.transcript_path
      : discoverTranscript(ctx, { session_id: sessionId, provider, cwd: canonicalCwd, source });

  // issue #156 revised approach: mirror `handleSessionBinding` — a session registration that would
  // land on an EXISTING workspace shares the same per-target ownership lock a `glosa forget` commit
  // holds, so it either lands entirely before that commit's own liveness recheck (which then sees
  // it and refuses itself) or entirely after (and sees the durable "forgetting" marker and refuses
  // instead). A brand-new workspace path has nothing to race — `upsertWorkspace` cannot collide
  // with a forget of a registration that does not exist yet — so it proceeds without the lock.
  //
  // The resolved path can itself be a sealed adopted source's own (pre-adoption) canonical path —
  // e.g. a still-live session whose `workspace_binding` was set before its loose file got adopted
  // into a directory workspace. `provenanceOwner` canonicalizes to the OWNING target for the lock
  // key; `workspaceBinding` (if this is what produced the alias) is rewritten to the owner's own
  // canonical path so the session registry never stores the stale alias either — `forget`'s own
  // liveness check (`sessionRegistry.forWorkspace(target.canonical_path)`) matches on the TARGET's
  // exact path, and a session left bound to the source's path would never be seen by it (review
  // finding 4).
  const preAliasPath =
    workspaceBinding ?? ctx.sessionRegistry.get(sessionId)?.workspace_binding ?? fallbackBinding ?? canonicalCwd;
  const preAliasTarget = ctx.workspaceIndex.get(preAliasPath);
  const owner = preAliasTarget ? provenanceOwner(ctx.workspaceIndex, preAliasTarget) : null;
  // Only when SOME binding (explicit, prior-stored, or adapter-supplied) actually produced the
  // alias — never inject an explicit binding where none was intended just because `canonicalCwd`
  // itself happens to equal a source's canonical path (`cwd` describes where the process runs and
  // must stay truthful; it is not a routing hint the way `workspace_binding` is).
  if (owner && owner.canonical_path !== preAliasPath && preAliasPath !== canonicalCwd) {
    workspaceBinding = owner.canonical_path;
  }
  // Held-review finding: "an active forget operation stops governing access once its target
  // registration is removed... session registration treats the missing entry as a new workspace
  // and bypasses the coordinator." `owner` above is `null` whenever NOTHING is currently registered
  // at `preAliasPath` — which is exactly the state right after a forget's own deregistration step
  // but BEFORE its completion receipt lands. Without this check, that gap reads as "brand-new
  // workspace, nothing to race" and registers straight through it.
  const pendingOp = owner ? null : ctx.workspaceIndex.activeForgetOperationForCanonicalPath(preAliasPath);

  const doRegister = () =>
    ctx.sessionRegistry.register({
      session_id: sessionId,
      provider,
      cwd: canonicalCwd,
      source,
      ...(workspaceBinding !== undefined ? { workspace_binding: workspaceBinding } : {}),
      fallback_workspace_binding: fallbackBinding,
      ...(transcriptPath !== undefined ? { transcript_path: transcriptPath } : {}),
    });

  let record: SessionRecord;
  try {
    if (owner) {
      const outcome = await ownershipCoordinator(ctx).run(owner.registration_id, async () => {
        const fresh = ctx.workspaceIndex.getWorkspaceByRegistration(owner.registration_id);
        if (fresh?.lifecycle?.state === "forgetting") return { blocked: true as const };
        return { blocked: false as const, record: await doRegister() };
      });
      if (outcome.blocked) {
        return problem(409, "workspace-forgetting", "workspace is being forgotten", undefined, url.pathname);
      }
      record = outcome.record;
    } else if (pendingOp) {
      const outcome = await ownershipCoordinator(ctx).run(pendingOp.target_registration_id, async () => {
        // Re-checked fresh under the lock: the operation may have completed while this call
        // waited for it, in which case a fresh registration at this same path is a legitimate
        // reopen, not a race — never held against a receipt that already finished.
        if (ctx.workspaceIndex.activeForgetOperationForCanonicalPath(preAliasPath)) {
          return { blocked: true as const };
        }
        return { blocked: false as const, record: await doRegister() };
      });
      if (outcome.blocked) {
        return problem(409, "workspace-forgetting", "workspace is being forgotten", undefined, url.pathname);
      }
      record = outcome.record;
    } else {
      record = await doRegister();
    }
  } catch (error) {
    if (error instanceof SessionProviderConflict)
      return problem(409, "session-provider-conflict", error.message, undefined, url.pathname);
    throw error;
  }

  return Response.json({
    session_id: record.session_id,
    workspace: record.workspace_binding ?? record.cwd,
  });
}

/** Unknown sessions return a typed 404 so MCP activity can recover registration after restart. */
async function handleSessionHeartbeat(ctx: ApiContext, sessionId: string): Promise<Response> {
  if (!(await ctx.sessionRegistry.heartbeat(sessionId))) {
    return problem(404, "session-not-registered", "session not registered — re-register by calling any glosa tool");
  }
  return Response.json({ ok: true });
}

/** `POST /api/sessions/:id/deregister` — SessionEnd (A2 §F08: "removes the session from the
 * active registry (keeps journal audit trail)"). Also a no-op-safe 200 for an unknown id. */
async function handleSessionDeregister(ctx: ApiContext, sessionId: string): Promise<Response> {
  await ctx.sessionRegistry.deregister(sessionId);
  return Response.json({ ok: true });
}

const DRAIN_MAX = 8; // A2 §F07/A6 §F26: "Stop drains are bounded (≤8) and treated as drains, not loops."

interface CompositeDrainCandidate {
  workspace: WorkspaceEntry;
  bus: WorkspaceBus;
  id: string;
  created_at: string;
  journal_order: number;
  presentation: (DeliverableEntry & { workspace: string }) | null;
}

function compareUtf8Text(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** Cross-workspace creation order is the persisted entry timestamp. Equal timestamps use the
 * durable registration id's raw UTF-8 bytes, then the entry's local journal order and id bytes.
 * No host locale participates. Invalid legacy timestamps sort after valid timestamps, then by
 * their raw UTF-8 bytes so even damaged-but-readable history has one deterministic order. */
function compareCompositeCandidates(a: CompositeDrainCandidate, b: CompositeDrainCandidate): number {
  const aAt = Date.parse(a.created_at);
  const bAt = Date.parse(b.created_at);
  const aValid = Number.isFinite(aAt);
  const bValid = Number.isFinite(bAt);
  if (aValid !== bValid) return aValid ? -1 : 1;
  if (aValid && bValid && aAt !== bAt) return aAt < bAt ? -1 : 1;
  if (!aValid && !bValid) {
    const malformedAt = compareUtf8Text(a.created_at, b.created_at);
    if (malformedAt !== 0) return malformedAt;
  }
  const workspace = compareUtf8Text(a.workspace.registration_id, b.workspace.registration_id);
  if (workspace !== 0) return workspace;
  if (a.journal_order !== b.journal_order) return a.journal_order - b.journal_order;
  return compareUtf8Text(a.id, b.id);
}

/**
 * `scope`, when given, is issue #205's immutable drain scope: the requesting generic pull's own
 * workspace argument, captured once at route entry (`handleSessionDrain`) rather than re-read from
 * the session's live registry row. Every OTHER session's routing still reads the live registry —
 * only THIS session's own `cwd`/`workspace_binding` is replaced for the purpose of the predicate,
 * via `SessionRegistry.forWorkspace`'s `scopeOverride`. Absent `scope`, behaviour is byte-for-byte
 * what it was before this fix: the row's current `cwd` decides routing, as the four hook transports
 * still expect.
 *
 * `capturedRecord` (A10) is the SAME `record` `handleSessionDrain` fetched before admitting this
 * request — passed through so the override can complete an admitted drain even if the live row is
 * gone (deregistered or lease-expired) by the time this actually runs. Unused when `scope` is
 * absent. */
function sessionRoutesToWorkspace(
  ctx: ApiContext,
  sessionId: string,
  workspace: WorkspaceEntry,
  scope: string | undefined,
  capturedRecord: SessionRecord,
): boolean {
  return ctx.sessionRegistry
    .forWorkspace(workspace.canonical_path, scope !== undefined ? { sessionId, cwd: scope, capturedRecord } : undefined)
    .some((candidate) => candidate.session_id === sessionId);
}

async function handleCompositeSessionDrain(
  ctx: ApiContext,
  sessionId: string,
  record: NonNullable<ReturnType<SessionRegistry["get"]>>,
  limit: number,
  via: DeliveryVia,
  entryId?: string,
  cursor?: string,
  scope?: string,
): Promise<Response> {
  return compositeRegistry(ctx).prepare(async () => {
    let workspaces = ctx.workspaceIndex
      .list({ presentOnly: true })
      .filter((workspace) => (workspace.lifecycle?.state ?? "active") === "active")
      .filter((workspace) => sessionRoutesToWorkspace(ctx, sessionId, workspace, scope, record))
      .sort((a, b) => compareUtf8Text(a.registration_id, b.registration_id));

    // Registration normally created this already. Preserve the old route's self-healing behavior
    // if an in-memory session outlives an absent index entry, but do not override an explicit
    // session bound to the cwd (the routing predicate still decides eligibility).
    //
    // Held-review finding (third pass): "composite-drain self-healing can recreate deleted bus or
    // index state after target deregistration" — `ctx.workspaceIndex.get(record.cwd)` returning
    // `null` is exactly the registration-less window a `glosa forget` deletion passes through
    // between removing this path's registration and stamping its completion receipt, not only
    // "never registered." Unlike every other path-addressed call site in this file, this branch
    // calls `upsertWorkspace` directly — which would durably RECREATE the index row an in-flight
    // deletion is committed to removing. Routed through `getOrRegisterWorkspace` (held-review
    // finding, fourth pass: the SAME shared boundary now used everywhere a raw
    // `get(path) ?? upsertWorkspace(path, source)` fallback previously ran inline) rather than a
    // local ad-hoc check, so a future call site copying this pattern cannot silently regress the
    // ordering. An active operation refuses the self-heal outright — caught and swallowed here
    // (never surfaced as a 409, unlike every other caller of this boundary): this is an aggregate
    // route across many workspaces, not addressed at one, so the candidate set for this session
    // simply stays empty, exactly as it would for any other workspace this session cannot
    // currently route to.
    if (workspaces.length === 0) {
      try {
        const cwdWorkspace = await getOrRegisterWorkspace(ctx.workspaceIndex, scope ?? record.cwd, "session");
        if (sessionRoutesToWorkspace(ctx, sessionId, cwdWorkspace, scope, record)) workspaces = [cwdWorkspace];
      } catch (error) {
        if (!(error instanceof AdoptionError && error.code === "workspace-forgetting")) throw error;
      }
    }

    const candidates: CompositeDrainCandidate[] = [];
    let undisclosedLocalCandidates = false;
    for (const workspace of workspaces) {
      const bus = await resolveBus(ctx, workspace);
      const plan = await bus.previewDelivery(
        DRAIN_MAX,
        { session: sessionId, ...(entryId ? { entryId } : {}) },
        (id, payload, status) => buildArtifactPresentation(artifactAccess(ctx), workspace, id, payload, status, cursor),
      );
      undisclosedLocalCandidates ||= plan.has_more;
      for (const item of plan.entries) {
        candidates.push({
          ...item,
          workspace,
          bus,
          presentation: item.presentation as CompositeDrainCandidate["presentation"],
        });
      }
    }
    candidates.sort(compareCompositeCandidates);

    const selected: CompositeDrainCandidate[] = [];
    let plannedBytes = 0;
    for (const candidate of candidates) {
      if (!candidate.presentation) throw new Error(`entry ${candidate.id} is not an actionable presentation`);
      if (selected.length >= Math.min(Math.max(1, limit), DRAIN_MAX)) break;
      const separatorBytes = selected.length > 0 ? utf8Bytes("\n\n---\n\n") : 0;
      if (plannedBytes + separatorBytes + candidate.presentation.bytes > MAX_BATCH_PRESENTATION_BYTES) break;
      selected.push(candidate);
      plannedBytes += separatorBytes + candidate.presentation.bytes;
    }

    if (selected.length === 0) {
      return Response.json({ delivery_id: null, drained: [], count: 0, has_more: candidates.length > 0 });
    }

    const children: Array<{ bus: WorkspaceBus; delivery_id: string }> = [];
    const drained: Array<DeliverableEntry & { workspace: string }> = [];
    let reservedBytes = 0;
    let compositeDeliveryId: string;
    try {
      for (const candidate of selected) {
        // Reserve exactly the planned id. If another drain won the race after preview, this returns
        // no item; never substitute the workspace's next eligible entry.
        const prepared = await candidate.bus.prepareDelivery(
          1,
          { via, session: sessionId, entryId: candidate.id },
          (id, payload, status) =>
            buildArtifactPresentation(artifactAccess(ctx), candidate.workspace, id, payload, status, cursor),
        );
        if (prepared.count !== 1 || prepared.delivery_id === null || prepared.drained[0]?.id !== candidate.id) {
          if (prepared.delivery_id) children.push({ bus: candidate.bus, delivery_id: prepared.delivery_id });
          throw new Error(`delivery candidate ${candidate.id} changed during preparation`);
        }
        const presentation = prepared.drained[0] as DeliverableEntry & { workspace?: string };
        if (presentation.workspace !== candidate.workspace.canonical_path) {
          children.push({ bus: candidate.bus, delivery_id: prepared.delivery_id });
          throw new Error(`delivery candidate ${candidate.id} lost its workspace identity`);
        }
        const separatorBytes = drained.length > 0 ? utf8Bytes("\n\n---\n\n") : 0;
        if (
          presentation.bytes > MAX_ENTRY_PRESENTATION_BYTES ||
          reservedBytes + separatorBytes + presentation.bytes > MAX_BATCH_PRESENTATION_BYTES
        ) {
          children.push({ bus: candidate.bus, delivery_id: prepared.delivery_id });
          throw new Error(`delivery candidate ${candidate.id} changed beyond the presentation cap`);
        }
        children.push({ bus: candidate.bus, delivery_id: prepared.delivery_id });
        drained.push(presentation as DeliverableEntry & { workspace: string });
        reservedBytes += separatorBytes + presentation.bytes;
      }
      // Registry allocation is part of preparation. If it fails, none of the child reservations
      // may remain stranded behind a token that was never returned to the caller.
      compositeDeliveryId = compositeRegistry(ctx).create(sessionId, children);
    } catch (error) {
      const releases = await Promise.allSettled(children.map((child) => child.bus.cancelDelivery(child.delivery_id)));
      const releaseFailure = releases.find((result) => result.status === "rejected");
      if (releaseFailure?.status === "rejected") {
        throw new AggregateError(
          [error, releaseFailure.reason],
          "composite preparation and reservation release failed",
        );
      }
      throw error;
    }

    return Response.json({
      delivery_id: compositeDeliveryId,
      drained,
      count: drained.length,
      has_more: undisclosedLocalCandidates || candidates.length > selected.length,
    });
  });
}

/** `POST /api/sessions/:id/drain` — prepares the rung-3 turn-boundary payload (UserPromptSubmit's
 * additionalContext + Stop's blocking reason, A6 §F26). Selection, actionable formatting, byte
 * accounting, and reservation happen under one workspace mutex; no `presented` event is written
 * until the output owner calls the acknowledgement route after its stream/protocol write succeeds.
 * An entry whose earlier attempts failed or only reached `transport_accepted` remains eligible.
 * `via` MUST be told apart by the caller, since
 * `"gate"`/`"stop"`/`"userprompt"`/`"asyncRewake"` are distinct transports and only the caller
 * (`glosa hook stop` vs. `user-prompt-submit` vs. `rewake-watch`) knows which one is actually
 * surfacing this drain right now. An unknown session_id is a typed 404, as on heartbeat; clients can re-register before retrying. */
async function handleSessionDrain(ctx: ApiContext, sessionId: string, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const record = ctx.sessionRegistry.get(sessionId);
  if (!record)
    return problem(
      404,
      "session-not-registered",
      "session not registered — re-register by calling any glosa tool",
      undefined,
      url.pathname,
    );

  let limit = DRAIN_MAX;
  let via: DeliveryVia = "userprompt";
  let entryId: string | undefined;
  let cursor: string | undefined;
  // Issue #205: the immutable scope a generic MCP pull sends for itself, additive and optional (A1
  // §5.15). Captured once, here, before anything async runs — never re-derived from the session's
  // live registry row, which a concurrent re-registration can legitimately move out from under this
  // exact request. Every other caller (gate/stop/userprompt/asyncRewake) omits it, and behaviour for
  // them is unchanged: routing still resolves from the row.
  //
  // Canonicalised below with the SAME rule `handleSessionRegister` applies to `cwd`, and for the
  // same reason: a client-supplied path is not pre-canonicalised, every routing comparison
  // (`isCwdAncestorOf`, `workspace_binding === canonical_path`) is a literal string match against a
  // canonical path, and on macOS the natural spelling of a temp or home path (`/tmp`, `/var`) is a
  // symlink. An un-canonicalised scope therefore matches NO registered workspace, falls into
  // `handleCompositeSessionDrain`'s self-heal branch, and makes `getOrRegisterWorkspace` durably
  // register a SECOND index row for a directory that already has one — observed, not theorised.
  // PRESENCE and VALUE are tracked separately, deliberately. Folding a type test into the capture
  // (`typeof body.scope === "string" && length > 0`) makes `""`, `null` and a non-string
  // indistinguishable from an omitted field, so a caller that asked for an explicit scope and
  // spelled it wrong silently gets the row-derived routing it asked NOT to have — the defect this
  // field exists to remove, arriving through the validator's front door.
  let scopePresent = false;
  let rawScope: unknown;
  try {
    const raw = await req.text();
    if (raw.length > 0) {
      const body = JSON.parse(raw) as Record<string, unknown>;
      if (typeof body.limit === "number" && body.limit > 0) limit = Math.min(body.limit, DRAIN_MAX);
      if (typeof body.entryId === "string" && body.entryId.length > 0) entryId = body.entryId;
      if (typeof body.cursor === "string" && body.cursor.length > 0) cursor = body.cursor;
      if (Object.hasOwn(body, "scope")) {
        scopePresent = true;
        rawScope = body.scope;
      }
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

  // Validated inside the branch that actually reads it. An explicitly bound session's drain never
  // consults `scope` (A1 §5.15), so validating ahead of this branch would 400 a bound drain over a
  // field it is documented to ignore — the code and the contract have to agree on which it is.
  if (!record.workspace_binding) {
    // Refused rather than ignored: silently dropping an unusable scope would hand this request the
    // row-derived behaviour it explicitly asked NOT to have, which is the defect, not a fallback.
    // Same status and shape as `handleSessionRegister`'s own `cwd` refusal. The directory check is
    // not redundant with canonicalisation: `canonicalOrNull` is realpath-only, so an existing
    // regular file canonicalises happily and would reach `getOrRegisterWorkspace` as a workspace.
    let scope: string | undefined;
    if (scopePresent) {
      if (typeof rawScope !== "string" || rawScope.length === 0)
        return problem(400, "invalid-path", "scope must be a non-empty path string", undefined, url.pathname);
      const canonicalScope = canonicalOrNull(rawScope);
      if (!canonicalScope || !isExistingDirectory(canonicalScope))
        return problem(400, "invalid-path", "scope does not resolve to a real directory", undefined, url.pathname);
      scope = canonicalScope;
    }
    return handleCompositeSessionDrain(ctx, sessionId, record, limit, via, entryId, cursor, scope);
  }

  const root = record.workspace_binding;
  // Held-review finding (fourth pass): a direct `upsertWorkspace` here recreated an ACTIVE row
  // during the registration-less window a `glosa forget` deletion passes through — before
  // `resolveBus` ever ran, so its own registration-less check below never even fired.
  // `getOrRegisterWorkspace` refuses BEFORE the upsert instead; a thrown `AdoptionError` propagates
  // to the pipeline's own catch (this route has no local try/catch), which already maps it to
  // `409 workspace-forgetting`.
  const workspace = await getOrRegisterWorkspace(ctx.workspaceIndex, root, "session");
  const bus = await resolveBus(ctx, workspace);

  const prepared = await bus.prepareDelivery(
    limit,
    { via, session: sessionId, ...(entryId ? { entryId } : {}) },
    (id, payload, status) => buildArtifactPresentation(artifactAccess(ctx), workspace, id, payload, status, cursor),
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
  const isComposite = CompositeDeliveryRegistry.isCompositeToken(deliveryId);
  // Issue #205 A10: a composite reservation already authenticates its OWN session match —
  // `CompositeDeliveryRegistry.acknowledge` compares the token's stored `reservation.session` to
  // `sessionId` and answers `"missing"` on a mismatch — so this route's row lookup is not what
  // makes a composite acknowledgement safe, only what makes a NON-composite one able to resolve
  // which bus to acknowledge against. An admitted scoped drain can legitimately complete after its
  // requester deregisters (mechanism 1, `SessionRegistry.forWorkspace`'s captured-snapshot
  // fallback), and requiring the row to still exist here would turn that completed drain into a
  // permanently 404ing acknowledgement — its reservation would sit unconsumed until the composite
  // registry's own 30s TTL/lazy pruning released it, not a redirect but a silent drop. Only the
  // composite-token branch below moves ahead of the row requirement, and only that far: a
  // non-composite acknowledgement still 404s in exactly the same place, relative to body parsing,
  // as before this fix — `record` is re-checked immediately before that branch runs.
  if (!record && !isComposite) {
    return problem(
      404,
      "session-not-registered",
      "session not registered — re-register by calling any glosa tool",
      undefined,
      url.pathname,
    );
  }
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
  if (isComposite) {
    const acknowledged = await compositeRegistry(ctx).acknowledge(
      deliveryId,
      sessionId,
      outcome,
      typeof value?.error === "string" ? value.error : undefined,
    );
    if (acknowledged === "outcome-conflict") {
      return problem(409, "conflict", "composite acknowledgement outcome changed", undefined, url.pathname);
    }
    if (acknowledged !== "acknowledged") {
      return problem(409, "conflict", "delivery reservation is missing or expired", undefined, url.pathname);
    }
    return Response.json({ acknowledged: true });
  }
  if (!record)
    return problem(
      404,
      "session-not-registered",
      "session not registered — re-register by calling any glosa tool",
      undefined,
      url.pathname,
    );
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
  authSignal?: AbortSignal,
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
  const signals = [req.signal, lifecycleSignal(ctx, authSignal)].filter((signal): signal is AbortSignal => !!signal);
  const signal = AbortSignal.any(signals);
  let unregister: (() => void) | undefined;
  let releaseLease: (() => void) | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener("abort", close);
    unregister?.();
    releaseLease?.();
    try {
      controller.close();
    } catch {
      /* reader cancellation already closed the stream */
    }
  };
  const stream = new ReadableStream<Uint8Array>({
    start(output) {
      controller = output;
      if (signal.aborted) {
        close();
        return;
      }
      const send = (entry: DeliverableEntry) => {
        try {
          controller.enqueue(encoder.encode(`event: conversation_message\ndata: ${JSON.stringify(entry)}\n\n`));
        } catch (error) {
          close();
          throw error;
        }
      };
      unregister = ctx.pushRegistry?.register(sessionId, send, close);
      releaseLease = ctx.sessionRegistry.holdConnection(sessionId);
      controller.enqueue(encoder.encode(": connected\n\n"));
      signal.addEventListener("abort", close, { once: true });
    },
    cancel: close,
  });
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

  // Held-review finding (final pass): the PRIOR fix here — a pre-check against
  // `activeForgetOperationForCanonicalPath` run before `resolveOpenTarget`, even wrapped in the
  // per-target ownership lock — was itself a check-then-act race: `resolveOpenTarget` runs under
  // `WorkspaceIndex`'s OWN separate mutex, so a forget commit's individual steps (each their own
  // critical section on that same mutex) could still land in the gap between this check returning
  // and `resolveOpenTarget` actually resolving/registering. The atomic fix moved INTO
  // `resolveOpenTarget`/`upsertDirectoryForOpen` themselves (`hasActiveForgetOperation`,
  // workspace-index.ts) — checked and mutated inside the exact same critical section, which is what
  // an outer pre-check here can never be. `resolveOpenTarget` throws the same `AdoptionError`
  // (`"workspace-forgetting"`) the catch block below already maps to `409`.
  try {
    const opened = await ctx.workspaceIndex.resolveOpenTarget(rawPath, {
      externalState: parsed?.external_state === true,
      ...(focus ? { focus } : {}),
      ...(parsed?.focus_first === true ? { focusFirst: true } : {}),
      ...(parsed?.require_focus === true ? { requireFocus: true } : {}),
    });
    if (opened.entry.kind === "directory") {
      await adoptLooseLineages(
        ctx.workspaceIndex,
        opened.entry,
        ctx.getWorkspaceBus,
        ctx.sealAdoptionSources,
        ownershipCoordinator(ctx),
      );
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
    // A4 §F05 lease expiry. Deliberately the same 409 `conflict` slug (and so the same exit 8
    // `entry_error`) as the two above rather than `lease-conflict`/exit 12 — A6 §F26 fixes
    // `resolve`'s exit set at `0;3;8;2`, and exit 12 belongs to `apply-begin`'s LEASE_HELD. The
    // recovery step goes in the TITLE, not just the detail, because `runResolve`'s
    // `mapEntryFailure` (packages/cli/src/resolve.ts) surfaces `problem.title` as the CLI's
    // error message and never reads `detail` — guidance parked in `detail` would never be seen.
    if (code === "LEASE_EXPIRED") {
      return problem(
        409,
        "conflict",
        "the apply-lease for this entry expired — re-run apply-begin, then resolve again",
        "past its TTL the lease could no longer prove its pre..post interval, so that interval was recorded as unknown rather than attributed to the session",
        url.pathname,
      );
    }
    throw err;
  }
}

/** `POST /api/workspaces/inbox/dismiss` — `glosa inbox dismiss <id>`'s daemon-side half (issue
 * #142). Mirrors `handleWorkspaceResolve`'s `deferred` arm above exactly (404 → terminal-guard
 * 409 → one `commitTransition` → JSON): a guarded transition that takes no lease. The difference
 * is the attribution and the terminal it lands on — `by: "human"` (a person typed the command,
 * never a session), `to: "dismissed"`, first-terminal-wins against `applied`/`rejected`/`stale`
 * exactly as it does against a second dismiss. No lease is opened or closed and no inbox file is
 * touched; this is precisely the supported, durably-recorded reconciliation the issue's hand-move
 * workaround never left a trace of. */
async function handleWorkspaceInboxDismiss(ctx: ApiContext, req: Request): Promise<Response> {
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
  const note = typeof b?.note === "string" ? b.note : undefined;
  if (!rawPath || !entry) {
    return problem(400, "validation-failed", "path and entry are required", undefined, url.pathname);
  }
  const root = canonicalOrNull(rawPath);
  if (!root) return problem(400, "invalid-path", "path does not resolve to a real directory", undefined, url.pathname);

  const bus = await resolveBus(ctx, ctx.workspaceIndex.get(root) ?? root);

  const entryState = bus.state.entries[entry];
  if (!entryState) {
    return problem(404, "not-found", "unknown inbox entry", undefined, url.pathname);
  }
  const kind = entryState.kind === "attention" ? "attention" : "common";
  if (isTerminal(kind, entryState.status)) {
    return problem(409, "conflict", `entry is already ${entryState.status}`, undefined, url.pathname);
  }
  await bus.commitTransition(entry, "dismissed", { by: "human", ...(note !== undefined ? { note } : {}) });
  return Response.json({ entry, status: bus.state.entries[entry]?.status ?? "unknown", to: "dismissed" });
}

/** `GET /api/workspaces/inbox?path=<ws>[&all=1]` — `glosa inbox list`'s daemon-side half (issue
 * #142). Read-only, no lease and no mutex: `listInboxEntries` folds the journal the same way
 * `GET /api/status`'s `pending_count` does, so this never blocks behind — and never observes a
 * half-applied — a concurrent write. `all=1` includes terminal entries (D4); the default omits
 * them, matching "prints the pending entries" from the issue this closes. */
function handleWorkspaceInboxList(ctx: ApiContext, req: Request): Response {
  const url = new URL(req.url);
  const rawPath = url.searchParams.get("path");
  if (!rawPath) {
    return problem(400, "validation-failed", "path query param is required", undefined, url.pathname);
  }
  const root = canonicalOrNull(rawPath);
  if (!root) return problem(400, "invalid-path", "path does not resolve to a real directory", undefined, url.pathname);
  const indexed = ctx.workspaceIndex.get(root);
  // Held-review finding: "path-addressed inbox listing bypasses the forgetting lifecycle gate" —
  // every other workspace data-access path (`workspaceOrNotFound`, `resolveBus`, `findWorkspace`/
  // `workspaceBus` in workspace-access.ts) refuses BOTH a target and an adopted source mid a
  // durably-committed `glosa forget`; this route, addressed by raw path rather than slug, read
  // straight through the index with no such check at all. `provenanceOwner` covers the alias case
  // exactly like those other call sites do: a still-registered adopted-source path whose OWNING
  // target is now forgetting must refuse too, not just a path that is itself the target.
  if (indexed) {
    const owner = provenanceOwner(ctx.workspaceIndex, indexed);
    if (isBeingForgotten(indexed) || isBeingForgotten(owner)) {
      return problem(409, "workspace-forgetting", "workspace is being forgotten", undefined, url.pathname);
    }
  } else if (ctx.workspaceIndex.activeForgetOperationForCanonicalPath(root)) {
    // Held-review finding: an active forget operation must keep refusing access even once its
    // target/source registration has been fully removed but before its completion receipt lands —
    // `indexed` being `null` here does NOT mean "never registered", it can equally mean "mid-
    // deletion, registration already gone." Read-only, so no coordinator lock is needed: this
    // route never mutates and a race against completion only ever costs one over-cautious refusal.
    return problem(409, "workspace-forgetting", "workspace is being forgotten", undefined, url.pathname);
  }
  const workspace = indexed ?? root;
  const all = url.searchParams.get("all") === "1";
  return Response.json({ entries: listInboxEntries(workspace, { all }) });
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
    // The entry belongs to another workspace, or does not exist. A 404 naming the reason, not the
    // detail-free 500 an unhandled throw would produce — this is the likeliest mistake a caller
    // can make here, and it was previously indistinguishable from a daemon fault.
    if ((err as { code?: string }).code === "UNKNOWN_ENTRY") {
      return problem(
        404,
        "not-found",
        "this workspace has no such inbox entry — pass --workspace to name the one that owns it",
        undefined,
        url.pathname,
      );
    }
    throw err;
  }
}

/** `POST /api/workspaces/forget` (issue #156) — `glosa forget <slug>`'s daemon-side half, the one
 * supported whole-bus deletion primitive. Body `{slug, confirm?}`; `confirm` defaults to `false`,
 * a pure preview (see `forget-workspace.ts`'s own docstring for why a preview call is guaranteed
 * side-effect-free). Deliberately addressed by SLUG, not by `path` like `resolve`/`apply-begin`:
 * the whole point of `forget` is that it must still work once a workspace's on-disk path is gone,
 * and a slug is the one identifier that survives that. */
async function handleWorkspaceForget(ctx: ApiContext, req: Request): Promise<Response> {
  const url = new URL(req.url);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return problem(400, "validation-failed", "body must be valid JSON", undefined, url.pathname);
  }
  const b = body as Record<string, unknown> | null;
  const slug = typeof b?.slug === "string" ? b.slug : null;
  if (!slug) return problem(400, "validation-failed", "slug is required", undefined, url.pathname);
  // Held-review finding: a non-boolean `confirm` (string, number, null, array, object) was silently
  // coerced to `false` by `=== true` and treated as an ordinary preview request instead of being
  // rejected as malformed — a caller that sent e.g. `confirm: "true"` believing it opted into
  // deletion would instead silently get a no-op preview with no error at all.
  if (b?.confirm !== undefined && typeof b.confirm !== "boolean") {
    return problem(400, "validation-failed", "confirm must be a boolean", undefined, url.pathname);
  }
  const confirm = b?.confirm === true;
  // Held-review finding (third pass): "a present non-string `member_fingerprint` is treated as
  // omission and bypasses preview binding" — `typeof ... === "string" ? ... : undefined` silently
  // turned any non-string value (a number, `null`, an array, an object) into `undefined`, which
  // `forgetWorkspace`'s own stale-preview check reads as "no fingerprint to bind against at all"
  // and skips entirely — the exact same class of bug `confirm` itself was already fixed for above.
  // A present value must be a genuine lowercase SHA-256 hex digest (`memberFingerprint`'s own output
  // shape in forget-workspace.ts) or the request is rejected outright, with zero side effects —
  // never silently reinterpreted as "no fingerprint was supplied."
  if (b?.member_fingerprint !== undefined) {
    if (typeof b.member_fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(b.member_fingerprint)) {
      return problem(
        400,
        "validation-failed",
        "member_fingerprint must be a lowercase SHA-256 hex string",
        undefined,
        url.pathname,
      );
    }
  }
  const memberFingerprint = typeof b?.member_fingerprint === "string" ? b.member_fingerprint : undefined;

  const outcome = await forgetWorkspace(
    {
      workspaceIndex: ctx.workspaceIndex,
      sessionRegistry: ctx.sessionRegistry,
      home: ctx.home ?? glosaHome(),
      getWorkspaceBus: ctx.getWorkspaceBus,
      adoptionCoordinator: ownershipCoordinator(ctx),
    },
    slug,
    { confirm, memberFingerprint },
  );

  if (!outcome.ok) {
    if (outcome.code === "not-found") {
      return problem(404, "not-found", "unknown workspace", undefined, url.pathname);
    }
    if (outcome.code === "blocked") {
      // `requested_slug` names the owning target when `slug` named a sealed adopted source — never
      // treated as an independent provenance unit (issue #156 revised approach).
      return forgetBlockedResponse(
        url.pathname,
        outcome.blockers,
        outcome.target_slug,
        outcome.requested_slug !== outcome.target_slug ? outcome.requested_slug : undefined,
      );
    }
    if (outcome.code === "stale-preview") {
      return forgetStalePreviewResponse(
        url.pathname,
        outcome.target_slug,
        outcome.requested_slug,
        outcome.entries,
        outcome.member_fingerprint,
      );
    }
    // "confinement-failed" — a corrupted or foreign-pointing bus_path record. Never expected in
    // normal operation; refuses loudly rather than risk deleting the wrong thing (see
    // `confineBusPathForDeletion`'s own docstring in forget-workspace.ts).
    return problem(
      500,
      "internal",
      "a workspace bus path failed confinement — refusing to delete anything for this workspace",
      `registration ${outcome.registration_id}`,
      url.pathname,
    );
  }

  // `slug` always names the RESOLVED target (never a sealed source it was adopted into); when the
  // caller named a source, `requested_slug` carries what they actually asked for — a stable
  // response naming the owning target rather than silently forgetting the source alone.
  return Response.json({
    slug: outcome.target_slug,
    ...(outcome.requested_slug !== outcome.target_slug ? { requested_slug: outcome.requested_slug } : {}),
    confirmed: outcome.confirmed,
    ...(outcome.confirmed
      ? { removed: outcome.removed }
      : { would_remove: outcome.entries, member_fingerprint: outcome.member_fingerprint }),
  });
}

/** `GET /api/status` — `glosa status`'s aggregate (A6 §F26: "daemon+workspaces+sessions+pending").
 * One route rather than several client-side calls: `status` is meant to answer "what's going on"
 * in a single round trip, and every piece it needs (`workspaceIndex`, `sessionRegistry`, each
 * workspace's own journal) already lives on `ctx` — there's nothing a second daemon endpoint would
 * add except more network round trips for the CLI to fail independently on. */
export type WiringState = "live" | "wired" | "unwired";

interface WiringBody {
  state: WiringState;
  init: { manifest_present: boolean; manifest_invalid: boolean };
  sessions: { bound_live: number; routable_live: number };
  pending_count: number;
  kind: WorkspaceEntry["kind"];
}

/** The 3-state wiring signal behind the SPA badge (issue #80, A1 §5.18): `live` = init manifest
 * present AND at least one session the delivery router would actually reach (`forWorkspace` —
 * the same predicate delivery routing uses, so "live" means delivery genuinely lands);
 * `wired` = manifest present but no routable session (restart/resume needed); `unwired` = init
 * never ran. `pending_count` rides along so the badge can say "N queued". NEVER includes a
 * filesystem path (A1 §5.14's rule for SPA-facing workspace routes). */
function computeWiring(ctx: ApiContext, entry: WorkspaceEntry): WiringBody {
  const probe = probeInitManifest(entry.worktree_path);
  const boundLive = ctx.sessionRegistry.explicitlyBoundForWorkspace(entry.canonical_path).length;
  const routableLive = ctx.sessionRegistry.forWorkspace(entry.canonical_path).length;
  let pending = 0;
  try {
    // BADGE-facing (`GET /w/:slug/wiring`). Its own call, not a value borrowed from the status
    // row below: this is the fold the badge reads when no status aggregate is in hand, so it
    // carries its own exclusion and its own assertion.
    pending = badgePendingCount(peekJournal(entry).state);
  } catch {
    // a torn/unreadable journal must not break a status read; 0 is the honest floor here
  }
  const state: WiringState = probe.manifest_present ? (routableLive > 0 ? "live" : "wired") : "unwired";
  return {
    state,
    init: probe,
    sessions: { bound_live: boundLive, routable_live: routableLive },
    pending_count: pending,
    kind: entry.kind,
  };
}

/** `GET /w/:slug/wiring` (authed-read, issue #80). */
function handleWiring(ctx: ApiContext, slug: string, pathname: string): Response {
  const resolved = workspaceOrNotFound(ctx, slug, pathname);
  if (!resolved.ok) return resolved.response;
  return Response.json(computeWiring(ctx, resolved.entry));
}

/** `POST /w/:slug/init` (state-changing, issue #80) — runs `glosa init` for a registered
 * workspace on the client's explicit consent (the SPA's dialog click). CSRF safety is the
 * state-changing route class (Bearer + Origin + Sec-Fetch-Site); the workspace dir comes from
 * the registry entry, never the request. Loose-file workspaces are rejected: their worktree is
 * the CONTAINING directory, and silently writing `.claude/` config into a directory the user
 * may not consider a project would be a surprising mutation — the SPA shows the copyable
 * terminal command instead. */
async function handleWorkspaceInit(ctx: ApiContext, slug: string, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const resolved = workspaceOrNotFound(ctx, slug, url.pathname);
  if (!resolved.ok) return resolved.response;
  const entry = resolved.entry;
  if (!ctx.runWorkspaceInit) {
    return problem(503, "internal", "workspace init is unavailable", undefined, url.pathname);
  }
  if (entry.kind !== "directory") {
    return problem(400, "validation-failed", "init applies to directory workspaces", undefined, url.pathname);
  }
  let force = false;
  const raw = await req.text();
  if (raw.length > 0) {
    try {
      const body = JSON.parse(raw) as Record<string, unknown> | null;
      // Forwarded ONLY on an explicit true — --force overwrites a foreign glosa MCP key, so it
      // must be a deliberate client re-confirmation, never a default.
      force = body?.force === true;
    } catch {
      return problem(400, "validation-failed", "body must be valid JSON", undefined, url.pathname);
    }
  }

  const result = await ctx.runWorkspaceInit(entry.worktree_path, entry.registration_id, { force });
  switch (result.kind) {
    case "completed": {
      const envelope = result.envelope;
      if (envelope.exit_code === 0) {
        const wiring = computeWiring(ctx, entry);
        // The F26 init envelope reports change per target file (`data.files.<name>.changed`) —
        // "anything changed" is the aggregate the SPA cares about ("wired now" vs "was already").
        const files =
          typeof envelope.data === "object" && envelope.data !== null
            ? (envelope.data as { files?: Record<string, { changed?: boolean }> }).files
            : undefined;
        const changed = files ? Object.values(files).some((f) => f?.changed === true) : true;
        return Response.json({
          ok: true,
          changed,
          warnings: envelope.warnings,
          wiring,
          // Post-init the hooks only take effect at the next SessionStart — this is the field
          // the SPA turns into "restart or /resume your Claude Code session".
          restart_required: wiring.sessions.routable_live === 0,
        });
      }
      // Exit 6 = foreign-config conflict (client may re-confirm with force:true); exit 2 = usage,
      // which the child emits for durable-install-required (ephemeral runner cache), an unsafe
      // init target (issue #96), and — because this child runs `init` with no `--agent` so the
      // provider choice stays provider-owned (A6 §F26, AGENTS.md invariant 1) — a provider
      // selection it refuses to guess at. Only the first is re-confirmable with force:true; the
      // rest are still honest 409s because the child's own error code + hint ride in `detail`,
      // which is what the SPA shows next to its "run `glosa init` in the terminal" fallback.
      if (envelope.exit_code === 6 || envelope.exit_code === 2) {
        const err = envelope.error;
        const detail = err
          ? `${err.code}: ${err.message}${err.hint ? ` — ${err.hint}` : ""}`
          : `init exited ${envelope.exit_code}`;
        return problem(409, "conflict", "glosa init reported a conflict", detail, url.pathname);
      }
      const failDetail = envelope.error
        ? `${envelope.error.code}: ${envelope.error.message}`
        : `init exited ${envelope.exit_code}`;
      return problem(500, "internal", "glosa init failed", failDetail, url.pathname);
    }
    case "timeout":
      return problem(500, "internal", "glosa init timed out", undefined, url.pathname);
    case "spawn-failed":
      return problem(500, "internal", `could not spawn glosa init: ${result.message}`, undefined, url.pathname);
    case "bad-output":
      return problem(500, "internal", result.message, undefined, url.pathname);
  }
}

function handleStatusAggregate(ctx: ApiContext): Response {
  // Additive (issue #156): a workspace mid a durably-committed `glosa forget` must stay visible
  // here even once its on-disk path has gone missing (`present:false`) — its worktree may simply
  // no longer exist (the deletion never touches work-tree files, but nothing stops a user from
  // removing the directory themselves mid-forget), and `doctor` cannot name the exact resume
  // command for a workspace `status` never reports at all (review finding: "status omits
  // present:false forgetting targets"). Every other lifecycle state stays present-only.
  const forgettingAbsent = ctx.workspaceIndex.list().filter((e) => !e.present && e.lifecycle?.state === "forgetting");
  const registeredRegistrationIds = new Set(
    [...ctx.workspaceIndex.list({ presentOnly: true }), ...forgettingAbsent].map((e) => e.registration_id),
  );
  // Held-review finding: "a crash after target deregistration but before operation completion
  // leaves no workspace row for status/doctor, even though a pending operation exists." Once the
  // target's OWN registration is fully removed there is no `WorkspaceEntry` left at all — neither
  // `forgettingAbsent` above (which only ever looks at still-registered rows) nor `doctor`'s own
  // path-keyed lookup can find it. The durable `ForgetOperationRecord` is what survives that crash
  // point (see `WorkspaceIndex.beginForgetOperation`'s own docstring), so a pending operation whose
  // target registration is gone gets a synthesized row here — same shape every other row has, so
  // `doctor`'s existing `w.lifecycle === "forgetting"` / path-matching logic needs no changes at all.
  const registrationlessForgetOps = ctx.workspaceIndex
    .pendingForgetOperations()
    .filter((op) => !registeredRegistrationIds.has(op.target_registration_id));
  const registrationlessRows = registrationlessForgetOps.flatMap((op) => {
    const targetMember = op.members.find((m) => m.registration_id === op.target_registration_id);
    if (!targetMember) return []; // defensive — the target is always its own member by construction
    return [
      {
        slug: op.target_slug,
        // Held-review finding (final pass): "registration-less loose-file status synthesizes the
        // file path instead of the durable worktree path, so doctor misses the recovery state" —
        // `canonical_path` is the FILE itself for a `loose-file` target, never what `doctor <dir>`
        // (or every OTHER row's own `path` field, below: always `WorkspaceEntry.worktree_path`) is
        // addressed by. `worktree_path` is captured in the immutable snapshot for exactly this.
        path: targetMember.worktree_path,
        last_seen: op.started_at,
        pending_count: 0,
        has_attention: false,
        orphaned_entry_count: 0,
        wiring: "unwired" as const,
        lifecycle: "forgetting" as const,
        connect: {
          providers: (ctx.providerRegistry?.list() ?? []).map((provider) => ({
            provider: provider.id,
            ...provider.connectPrompt({ slug: op.target_slug, path: targetMember.worktree_path }),
          })),
          cli_fallback: "glosa session bind <current-session-id> --workspace <workspace-path>",
        },
      },
    ];
  });
  const workspaces = [
    ...[...ctx.workspaceIndex.list({ presentOnly: true }), ...forgettingAbsent].map((e) => {
      const peek = peekJournal(e);
      return {
        slug: e.slug,
        path: e.worktree_path,
        last_seen: e.last_seen,
        // BADGE-facing, and the one the SPA actually renders: `agent-feedback.js` reads
        // `connection.workspace.pending_count ?? wiring.pending_count`, i.e. THIS row first and
        // `computeWiring`'s only as a fallback. `glosa doctor`'s pending-delivery check reads it
        // too, and says "queued ... will sit until delivery is wired" — a promise an
        // `external_edit` can never keep, since it is excluded from delivery eligibility.
        pending_count: badgePendingCount(peek.state),
        has_attention: hasOpenAttention(peek.state),
        // Additive (issue #142): journal entries whose immutable inbox payload has gone missing —
        // see `orphanedEntryCount`'s own docstring for the exact orphan signature and why the count
        // reuses this already-computed fold rather than folding the journal a second time.
        orphaned_entry_count: orphanedEntryCount(e, peek),
        // Additive (issue #80): the same 3-state signal `GET /w/:slug/wiring` serves, so
        // `glosa status`/`doctor` see wiring without a per-workspace round-trip.
        wiring: computeWiring(ctx, e).state,
        // Additive (issue #156): a `glosa forget` whose deletion is durably committed — possibly
        // mid-resume after a crash — so `doctor` can name the interrupted state and the exact resume
        // command instead of misreading a mid-deletion workspace as merely "not yet opened".
        ...(e.lifecycle?.state === "forgetting" ? { lifecycle: "forgetting" as const } : {}),
        // Additive (issue #95): the SPA composes the generic workspace identity + CLI fallback
        // around provider-owned agent instructions. No provider-specific text enters the core.
        connect: {
          providers: (ctx.providerRegistry?.list() ?? []).map((provider) => ({
            provider: provider.id,
            ...provider.connectPrompt({ slug: e.slug, path: e.worktree_path }),
          })),
          cli_fallback: "glosa session bind <current-session-id> --workspace <workspace-path>",
        },
      };
    }),
    ...registrationlessRows,
  ];
  const sessions = ctx.sessionRegistry.list().map((s) => ({
    session_id: s.session_id,
    provider: s.provider,
    cwd: s.cwd,
    workspace_binding: s.workspace_binding ?? null,
    source: s.source,
    lease_expiry: s.lease_expiry,
    last_active_at: s.last_active_at,
    liveness: ctx.sessionRegistry.liveness(s.session_id),
  }));
  // Additive (contract-minor-safe) orphan report — see registry/orphan-scan.ts. Never throws;
  // a scan failure degrades to an empty list rather than breaking the whole status aggregate.
  let orphanedState: OrphanedState[] = [];
  try {
    orphanedState = scanOrphanedHomeState(ctx.home ?? glosaHome(), ctx.workspaceIndex);
  } catch {
    // reporting-only surface — status must stay available even if the home dir is unreadable
  }
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
    orphaned_state: orphanedState,
  });
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
    subscribeArtifacts: ctx.artifactWatcherRegistry
      ? (listener) => ctx.artifactWatcherRegistry!.subscribe(resolved.entry, listener)
      : undefined,
  });
}

/** `GET /w/:slug/transcript/stream` (A1 §5.8/§8, P4.2) — resolves the slug, then the LIVE
 * session bound to it via the registry (never a cwd->slug guess, per A2 §F16's "Source
 * (Authoritative)"); no session at all, or none with a known `transcript_path`, is 404 "no
 * session registered" (A1 §5.8: "the SPA shows 'no session registered' rather than treating this
 * as a stream error"). Several live transcript-bearing sessions with equal routing precedence
 * fail closed with the same safe session-selection problem shape as the composer; this GET route
 * has no session-hint parameter. `transcript_path` is confined under `$CLAUDE_CONFIG_DIR` (A2
 * §F16/A6 §F30's doctor check) BEFORE this route ever opens it — outside that root is refused
 * (400), never tailed. */
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

  const sessions = ctx.sessionRegistry.forWorkspace(resolved.entry.canonical_path).flatMap((session) => {
    const provider = ctx.providerRegistry?.get(session.provider);
    let transcriptPath: string | null = session.transcript_path ?? null;
    try {
      transcriptPath = provider?.transcriptPath({ ...session, workspace: session.cwd }) ?? transcriptPath;
    } catch {
      transcriptPath = null;
    }
    return transcriptPath ? [{ ...session, transcript_path: transcriptPath }] : [];
  });
  if (sessions.length === 0) {
    return problem(404, "not-found", "no session registered", undefined, url.pathname);
  }
  if (sessions.length > 1) {
    return conversationProblem(409, "session-selection-required", "choose a live session", url.pathname, {
      candidates: sessionCandidates(sessions),
    });
  }
  const transcriptPath = sessions[0]!.transcript_path as string;

  const confined = confineTranscriptPath(
    transcriptPath,
    ctx.providerRegistry?.get(sessions[0]!.provider)?.transcriptRoots?.(),
  );
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

function sessionCandidates(records: ReturnType<SessionRegistry["forWorkspace"]>) {
  return records.map((record) => ({
    session_id: record.session_id,
    provider: record.provider,
    last_active_at: record.last_active_at,
  }));
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
  if (method === "POST" && pathname === "/api/workspaces/inbox/dismiss") {
    return { routeClass: "state-changing", handle: (req) => handleWorkspaceInboxDismiss(ctx, req) };
  }
  if (method === "GET" && pathname === "/api/workspaces/inbox") {
    return { routeClass: "authed-read", handle: (req) => handleWorkspaceInboxList(ctx, req) };
  }
  if (method === "POST" && pathname === "/api/workspaces/apply-begin") {
    return { routeClass: "state-changing", handle: (req) => handleWorkspaceApplyBegin(ctx, req) };
  }
  if (method === "POST" && pathname === "/api/workspaces/forget") {
    return { routeClass: "state-changing", handle: (req) => handleWorkspaceForget(ctx, req) };
  }
  const attentionRoute = attentionRoutes(
    {
      workspaceIndex: ctx.workspaceIndex,
      workspaceRegistration: ctx.workspaceIndex,
      getWorkspaceBus: ctx.getWorkspaceBus,
    },
    method,
    pathname,
  );
  if (attentionRoute) return attentionRoute;
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
      handle: (req, server, authSignal) => handleSessionPushStream(ctx, sessionId, req, server, authSignal),
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

  const artifactRoute = artifactRoutes(
    {
      ...artifactAccess(ctx),
      capabilityStore: ctx.capabilityStore,
      classFPort: ctx.classFPort,
    },
    method,
    pathname,
  );
  if (artifactRoute) return artifactRoute;
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
  const composerRoute = composerRoutes(
    {
      workspaceIndex: ctx.workspaceIndex,
      getWorkspaceBus: ctx.getWorkspaceBus,
      sessionRegistry: ctx.sessionRegistry,
      providerRegistry: ctx.providerRegistry,
    },
    method,
    pathname,
  );
  if (composerRoute) return composerRoute;
  // issue #80: the SPA wiring badge's read + the consent-gated init trigger (A1 §5.18/§5.19).
  if (method === "GET" && (m = pathname.match(/^\/w\/([^/]+)\/wiring$/))) {
    const slug = m[1] as string;
    return { routeClass: "authed-read", handle: () => handleWiring(ctx, slug, pathname) };
  }
  if (method === "POST" && (m = pathname.match(/^\/w\/([^/]+)\/init$/))) {
    const slug = m[1] as string;
    return { routeClass: "state-changing", handle: (req) => handleWorkspaceInit(ctx, slug, req) };
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
        if (authResult.status === 401) {
          // "This daemon holds no credential" and "the caller's credential is not this daemon's"
          // are the same 401 on the wire (no oracle), but they are different diagnoses — and
          // without the distinction a de-pair report cannot be settled after the fact.
          ctx.recordRejection?.(authSnapshot.token === null ? "no-token-on-daemon" : "bearer-mismatch");
        }
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
        ctx.recordRejection?.("credential-rotated");
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

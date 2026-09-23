// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — the two listeners' fetch pipelines (A1 §1/§3/§4, A3 §4). Wires together
// host-check → route lookup → authorizeRequest → contract-version gate → body cap → handler for
// the SPA/API listener, and the minimal host-check-only pipeline for the class-F listener.
//
// Route families own URL/body validation and exact problem mapping. The top-level pipeline keeps
// host checks, route precedence, authorization, contract-version enforcement, and body limits.

import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterRegistry, AdapterSessionHint } from "../adapters/interface.ts";
import { WorkspaceMetadataError, type WorkspaceMetadataRegistry } from "../adapters/workspace-metadata.ts";
import { AdoptionCoordinator, adoptLooseLineages } from "../adoption.ts";
import type { AgentProviderRegistry, DeliverableEntry } from "../agent-provider/interface.ts";
import type { SessionPushRegistry } from "../agent-provider/push-registry.ts";
import type { SignalFrame, SignalRegistry } from "../agent-provider/signal-registry.ts";
import type { WatchEmissionRegistry } from "../agent-provider/watch-emissions.ts";
import type { DictationProviderRegistry } from "../dictation/interface.ts";
import { createHash } from "node:crypto";
import { sourceSha256 } from "../artifact-render.ts";
import type { ArtifactWatcherRegistry } from "../artifact-watcher.ts";
import { WorkspaceAdoptedError, type WorkspaceBus } from "../bus/bus.ts";
import { type DeliveryVia, isTerminal } from "../bus/lifecycle.ts";
import { badgePendingCount, hasOpenAttention, orphanedEntryCount, peekJournal } from "../bus/peek.ts";
import { CompositeDeliveryRegistry } from "../delivery/composite-reservations.ts";
import { MAX_BATCH_PRESENTATION_BYTES, MAX_ENTRY_PRESENTATION_BYTES, utf8Bytes } from "../delivery/presentation.ts";
import { BUILD_ID } from "../lifecycle/build-id.ts";
import { glosaHome } from "../lifecycle/home.ts";
import { INSTALL_ID } from "../lifecycle/install.ts";
import { PROTOCOL_VERSION } from "../lifecycle/protocol.ts";
import { forgetRemedy, forgetRemedyWithoutSlug } from "../registry/forget-remedy.ts";
import { forgetWorkspace } from "../registry/forget-workspace.ts";
import { type OrphanedState, scanOrphanedHomeState } from "../registry/orphan-scan.ts";
import { SessionProviderConflict, type SessionRecord, type SessionRegistry } from "../registry/session-registry.ts";
import { canonicalize } from "../registry/slug.ts";
import { starName, type WorkspaceStar, WorkspaceStars } from "../registry/workspace-stars.ts";
import {
  AdoptionError,
  type WorkspaceEntry,
  type WorkspaceIndex,
  WorkspaceOpenError,
} from "../registry/workspace-index.ts";
import { artifactRoutes } from "../routes/artifact.ts";
import { attentionRoutes } from "../routes/attention.ts";
import { claimProblem, claimRoutes } from "../routes/claims.ts";
import { composerRoutes } from "../routes/composer.ts";
import { dictationRoutes } from "../routes/dictation.ts";
import { shadowRoutes } from "../routes/shadow.ts";
import type { BunServer, RouteMatch } from "../routes/types.ts";
import { authorizeRequest, isForeignOrigin, principalOfRequest, type Transport } from "../security/auth.ts";
import type { CapabilityStore } from "../security/capability.ts";
import { confinePath, decodePathCapture } from "../security/confine-path.ts";
import { classFCspHeaders, spaCspHeaders } from "../security/csp.ts";
import { CLASSF_HOSTNAME, isAllowedHost, SPA_HOSTNAMES } from "../security/hosts.ts";
import { PRESENTATION_TOKEN_TTL_MS, type PresentationTokenStore } from "../security/presentation-token.ts";
import type { TokenSource } from "../security/token.ts";
import {
  type ArtifactAccessDependencies,
  actionablePresentation as buildArtifactPresentation,
  listInboxEntries,
} from "../services/artifact.ts";
import { MAX_ENTRY_WAIT_MS, waitForWatch } from "../services/watch.ts";
import { findWorkspace, getOrRegisterWorkspace, WorkspaceLookupError } from "../services/workspace-access.ts";
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
  // The manuscript face store and its per-artifact control (Default / Sans / Mono).
  "face.js": "text/javascript; charset=utf-8",
  // Passage addresses ("§2.3"), derived from the rendered Markdown structure.
  "address.js": "text/javascript; charset=utf-8",
  "bootstrap.js": "text/javascript; charset=utf-8",
  // The SPA's visual system (design brief docs/design/2026-07-21-workspace-review-surface-brief.md).
  "app.css": "text/css; charset=utf-8",
  // The product mark is a fixed, self-adapting SVG used by the shell and browser chrome.
  "glosa-mark.svg": "image/svg+xml",
  // The two faces of the visual system, vendored so the runtime never reaches a font service
  // (A3: no external calls). Licences: src/fonts/OFL.txt. Served as bytes, never decoded as text.
  "fonts/source-serif-4-roman.woff2": "font/woff2",
  "fonts/source-serif-4-italic.woff2": "font/woff2",
  "fonts/source-sans-3-roman.woff2": "font/woff2",
  "fonts/source-sans-3-italic.woff2": "font/woff2",
  // P3.3 additions — the class-R viewer + its ONE data-access module (R6), and idiomorph
  // vendored under src/vendor/ (see that file's own header for why it's vendored rather than a
  // bare-specifier import).
  "data-access.js": "text/javascript; charset=utf-8",
  "dictation.js": "text/javascript; charset=utf-8",
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
  // Which bytes a run of top-level blocks owns (#271). Statically imported by artifact-pane.js —
  // it is pure arithmetic with no imports of its own, so it stays outside the lazy editor bundle
  // and has to be served with the Read/Review modules rather than beside the editor below.
  "run-spans.js": "text/javascript; charset=utf-8",
  // Rich markdown editor (the byte-exact source view) + its vendored ProseMirror bundle.
  "rich-editor.js": "text/javascript; charset=utf-8",
  "markdown-parser.js": "text/javascript; charset=utf-8",
  "markdown-non-manuscript.js": "text/javascript; charset=utf-8",
  "vendor/prosemirror.js": "text/javascript; charset=utf-8",
  // Shared confirm dialog (discard-edits and restore guards).
  "dialog.js": "text/javascript; charset=utf-8",
  // Multi-artifact workbench (design brief docs/design/2026-09-04-multi-artifact-workbench-brief.md):
  // the dock engine and its stylesheet, one pane per artifact, and a comparison as a pane.
  "dock.js": "text/javascript; charset=utf-8",
  "artifact-pane.js": "text/javascript; charset=utf-8",
  // #182 — the pure three-way merge behind Keep mine, imported by artifact-pane.js.
  "merge-markdown.js": "text/javascript; charset=utf-8",
  // The document outline as data (headings, depths, the current section), and the Go to palette
  // (⌘K) that lists it beside the workspace's files. Pure DOM — no transport of their own.
  "outline.js": "text/javascript; charset=utf-8",
  "palette.js": "text/javascript; charset=utf-8",
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
  /** Set by `bootDaemon` once the Unix listener is bound, and published by the tokenless
   * handshake so a client can tell a socket-serving daemon from one that predates it. Hand-built
   * test contexts leave it undefined, which reports `false` — truthfully, since they have none. */
  servesSocket?: boolean;
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
  /** Constructs adoption's unpublished staging bus with the same matcher boundary as production
   * registry buses. Optional only for hand-built tests, which retain the synchronous default. */
  createAdoptionStagingBus?: (workspace: WorkspaceTarget) => WorkspaceBus;
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
  /** Optional external dictation providers, injected by the CLI composition root. */
  dictationRegistry?: DictationProviderRegistry;
  pushRegistry?: SessionPushRegistry;
  /** Session signals derived from claim events (issue #155). Optional so a hand-built test context
   * keeps compiling; absent, drains carry no `signals` and the ack route answers 404. */
  signalRegistry?: SignalRegistry;
  /** Proves a `watch/transport-ack` names entries this session's own watch response emitted (#153
   * Part 2). Optional so every hand-built test context keeps compiling; when absent the ack route
   * refuses rather than falling back to the old "any in-scope external_edit" rule, because that
   * rule is the defect it replaces. */
  watchEmissions?: WatchEmissionRegistry;
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
  /** Starred workspaces (`<home>/stars.json`). Optional: defaulted per context from `home`, so
   * production and every hand-built test context get a store without extra wiring. */
  workspaceStars?: WorkspaceStars;
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
  /** Whether this daemon also serves `<GLOSA_HOME>/run/api.sock` (A3 §3.2). A BOOLEAN, never the
   * path, for the same reason `install_id` is a hash: this endpoint is tokenless, and a home
   * directory path on an unauthenticated endpoint is a privacy regression for a tool holding
   * manuscripts. A client already knows where its own home's socket would be; what it cannot know
   * is whether the daemon answering predates it. Absent in a legacy response means "no", so an
   * older daemon is refused rather than silently talked to over TCP. */
  serves_socket: boolean;
}

function checkHost(req: Request, port: number, hostnames: readonly string[]): boolean {
  return isAllowedHost(req.headers.get("Host"), port, hostnames);
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
      serves_socket: ctx.servesSocket === true,
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
function serveSpaAsset(ctx: ApiContext, req: Request, pathname: string): Response {
  const name = pathname.slice("/app/".length);
  // Object.hasOwn, not a bare `SPA_ASSETS[name]` lookup: a prototype key like `__proto__` or
  // `constructor` would otherwise resolve to a truthy inherited value, slip past the `undefined`
  // guard, and fall through to readFileSync (→ 500 instead of a clean 404). Own-keys only.
  const builtInContentType = Object.hasOwn(SPA_ASSETS, name) ? SPA_ASSETS[name] : undefined;
  const providerAsset = builtInContentType === undefined ? ctx.dictationRegistry?.browserAsset(pathname) : undefined;
  const contentType = builtInContentType ?? providerAsset?.contentType;
  if (contentType === undefined) {
    return problem(404, "not-found", "no such static asset", undefined, pathname);
  }
  // Read bytes, not text: a font decoded as UTF-8 and re-encoded would reach the browser corrupt.
  const body = readFileSync(providerAsset?.filePath ?? join(SPA_SRC_DIR, name));
  const etag = `"${contentType.startsWith("font/") ? createHash("sha256").update(body).digest("hex") : sourceSha256(body)}"`;
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
      // #312: the TITLE stays byte-identical (the SPA and its tests read it); the remedy rides in
      // `detail`, because the whole message an agent used to receive was "workspace is being
      // forgotten" — true, and useless. Now it also learns how to finish the deletion.
      response: problem(
        409,
        "workspace-forgetting",
        "workspace is being forgotten",
        forgetRemedy(entry.slug),
        pathname,
      ),
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
    // Contract 1.11: lets the SPA offer a star only where one can be taken.
    kind: e.kind,
    last_seen: e.last_seen,
    has_attention: hasOpenAttention(peekJournal(e).state),
  }));
  return Response.json(body);
}

// ---------- starred workspaces (contract 1.11, A1 §5.21) ----------

const contextStars = new WeakMap<ApiContext, WorkspaceStars>();

function workspaceStars(ctx: ApiContext): WorkspaceStars {
  if (ctx.workspaceStars) return ctx.workspaceStars;
  let stars = contextStars.get(ctx);
  if (!stars) {
    stars = new WorkspaceStars({ home: ctx.home ?? glosaHome() });
    contextStars.set(ctx, stars);
  }
  return stars;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** One star as the navigator draws it. `open` means a present directory registration serves this
 * exact path right now; `closed` means the folder is there but glosa is not serving it; `missing`
 * means the folder is gone. */
function starRow(ctx: ApiContext, star: WorkspaceStar) {
  const entry = ctx.workspaceIndex
    .list({ presentOnly: true })
    .find((e) => e.kind === "directory" && e.worktree_path === star.path && !isBeingForgotten(e));
  const base = { id: star.id, name: starName(star), path: star.path, starred_at: star.starred_at };
  if (entry) {
    return {
      ...base,
      state: "open" as const,
      slug: entry.slug,
      has_attention: hasOpenAttention(peekJournal(entry).state),
    };
  }
  return { ...base, state: isDirectory(star.path) ? ("closed" as const) : ("missing" as const) };
}

/** `GET /api/stars` */
function handleListStars(ctx: ApiContext): Response {
  return Response.json(
    workspaceStars(ctx)
      .list()
      .map((star) => starRow(ctx, star)),
  );
}

/** `POST /api/stars` `{slug}` — stars a workspace glosa is already serving. The request names a
 * registration, never a path: the path written down is the one the index already holds. */
async function handleStarWorkspace(ctx: ApiContext, req: Request): Promise<Response> {
  const url = new URL(req.url);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return problem(400, "validation-failed", "body must be valid JSON", undefined, url.pathname);
  }
  const slug = (body as { slug?: unknown } | null)?.slug;
  if (typeof slug !== "string" || slug.length === 0) {
    return problem(400, "validation-failed", "slug is required", undefined, url.pathname);
  }
  const entry = ctx.workspaceIndex.getBySlug(slug);
  if (!entry || !entry.present) return problem(404, "not-found", "unknown workspace", undefined, url.pathname);
  if (entry.kind !== "directory") {
    return problem(422, "star-not-directory", "only a directory workspace can be starred", undefined, url.pathname);
  }
  const star = await workspaceStars(ctx).add(entry.worktree_path);
  return Response.json(starRow(ctx, star));
}

/** `POST /api/stars/:id/unstar` */
async function handleUnstar(ctx: ApiContext, id: string, pathname: string): Promise<Response> {
  const removed = await workspaceStars(ctx).remove(id);
  if (!removed) return problem(404, "not-found", "unknown star", undefined, pathname);
  return new Response(null, { status: 204 });
}

/** `POST /api/stars/:id/open` — reopens a star's folder exactly as `glosa open <dir>` would. The
 * path comes from the star store, which only ever recorded paths of existing directory
 * registrations (A3 §4 "Starred workspaces"). */
async function handleOpenStar(ctx: ApiContext, id: string, pathname: string): Promise<Response> {
  const star = workspaceStars(ctx).get(id);
  if (!star) return problem(404, "not-found", "unknown star", undefined, pathname);
  if (!isDirectory(star.path)) {
    return problem(422, "star-folder-missing", "the starred folder no longer exists", undefined, pathname);
  }
  return openWorkspaceAt(ctx, star.path, {}, pathname);
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

/** The same guards as `resolveBus`, WITHOUT the reconciliation.
 *
 * Reconciling self-heals and checkpoints — real writes, which `bus/peek.ts` spells out is exactly
 * what a plain GET must not cause. A held watch is a read, so it takes this: it never reconciles.
 * Attaching a session is what reconciles (both the binding route and a binding-carrying register),
 * but the caller does not ASSUME that happened — see the hydration note below.
 *
 * Hydration is a CHECKED INVARIANT here, not an assumption about route order. An earlier version of
 * this route reasoned that a watch always runs behind a bind, and the bind hydrates — review round 3
 * disproved it three ways. `register` accepts a `workspace_binding` and USED to resolve no bus (it
 * now hydrates, best-effort, like the binding route); a binding
 * can be revived after its bus was evicted by GC or forget; and the bind's own hydration is
 * best-effort and swallows failure. In all three the watch meets a fresh instance whose derived
 * state is empty, which reads exactly like "nothing to report" — a silent wrong answer, worse than
 * an error, because the agent concludes the manuscript is untouched.
 *
 * So the caller folds the journal read-only (`WorkspaceBus.hydrateForRead`) rather than serving that
 * silence, and rather than refusing: §5.11b promises the hold ends returning whatever the cursor
 * has, honestly, even when empty, and three W3 lifecycle gates assert exactly that 200. The GET
 * still writes nothing on either path.
 *
 * What remains absent, stated rather than hidden: a reconcile that FAILED at attach leaves drift
 * uncommitted, and folding the journal cannot invent entries for it. Those appear at the next
 * successful writer reconciliation. The read is honest about the journal; it does not promise
 * catch-up it has not run. */
async function resolveBusForRead(ctx: ApiContext, root: WorkspaceTarget): Promise<WorkspaceBus> {
  const indexed = ctx.workspaceIndex.getWorkspaceByRegistration(workspaceRegistrationId(root));
  if (isAdoptingTarget(indexed)) {
    throw new AdoptionError("workspace-adopting", "workspace adoption is in progress");
  }
  if (isBeingForgotten(indexed)) {
    throw new AdoptionError("workspace-forgetting", "workspace is being forgotten");
  }
  if (!indexed) {
    const canonicalPath = typeof root === "string" ? root : root.canonical_path;
    if (ctx.workspaceIndex.activeForgetOperationForCanonicalPath(canonicalPath)) {
      throw new AdoptionError("workspace-forgetting", "workspace is being forgotten");
    }
  }
  return ctx.getWorkspaceBus(root);
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
      return problem(
        409,
        "workspace-forgetting",
        "workspace is being forgotten",
        forgetRemedy(owner.slug),
        url.pathname,
      );
    }
  } catch (error) {
    if (error instanceof SessionProviderConflict)
      return problem(409, "session-provider-conflict", error.message, undefined, url.pathname);
    throw error;
  }

  // #153 Part 2: hydrate the workspace bus HERE rather than on the watch's own read. Opening a bus
  // reconciles it, and reconciliation self-heals and checkpoints — real writes, which is exactly
  // what `bus/peek.ts` says a plain GET must never cause. Binding is already a state-changing route,
  // so the write lands where writes are allowed and `GET /w/:slug/watch` stays a read.
  //
  // NOT the only way a session attaches, and the watch does not assume it was: `register` can carry
  // a `workspace_binding` and hydrates for the same reason, and a watch that still meets an
  // unreconciled bus folds the journal read-only rather than answering from empty state. Failure
  // here is not fatal to the binding — the session is bound either way, and the drift this reconcile
  // would have committed stays absent until the next successful writer reconciliation.
  try {
    await resolveBus(ctx, owner);
  } catch {
    /* binding succeeded; hydration is an optimisation for the reads that follow it */
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
// `/api/sessions/...` surface the monitor, the Codex attachment, and the MCP shim call into. R2/A2
// §F08 are explicit that "providers register live agent sessions through their push transport at
// session start, MCP activity, or explicit binding — daemon API, never direct file writes" — these
// four routes are that API. Kept under `/api/` (not `/w/:slug/...`) since a registering caller
// doesn't necessarily know which workspace slug it landed in yet; `register` is what resolves that
// (via `SessionRegistry.register`'s own workspace upsert).
// -------------------------------------------------------------------------------------------

/** Resolves a registering caller's supplied path to its canonical identity (realpath -> NFC ->
 * strip trailing slash, same convention as every other workspace-identity call site) — a
 * provider's `cwd` is NOT pre-canonicalized the way `/w/:slug/...` routes' `entry.canonical_path`
 * already is. `null` on anything that doesn't resolve (nonexistent directory, symlink loop, etc.). */
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
 * `POST /api/sessions/:id/drain` the same registering caller requests immediately after this one
 * (see `handleSessionDrain`). Nothing about a park lives in daemon memory, so it survives a daemon
 * restart. */
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
      principal: principalOfRequest(req),
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

  // `register` can establish a binding on its own, without the session-binding route and without
  // ever touching a bus (review round 3, F-8). Hydrate here too, on the same best-effort terms. It
  // is NOT assumed to have worked: a watch folds the journal read-only when it meets an unhydrated
  // bus, and drift this reconcile fails to commit stays absent until the next successful writer.
  if (record.workspace_binding) {
    try {
      await resolveBus(ctx, ctx.workspaceIndex.get(record.workspace_binding) ?? record.workspace_binding);
    } catch {
      /* registration succeeded; hydration is an optimisation, and the watch checks the invariant */
    }
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

/** `POST /api/sessions/:id/deregister` — an explicit client deregistration: removes the session from
 * the active registry and keeps the journal audit trail. Also a no-op-safe 200 for an unknown id. */
async function handleSessionDeregister(ctx: ApiContext, sessionId: string): Promise<Response> {
  await ctx.sessionRegistry.deregister(sessionId);
  // A later registration reusing this id inherits no ackable emissions from the session that just
  // left; the TTL would get there eventually, deregistration is the honest moment.
  ctx.watchEmissions?.forgetSession(sessionId);
  return Response.json({ ok: true });
}

const DRAIN_MAX = 8; // Per-request cap on entries one drain returns; a caller pulls again for the rest.

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
 * what it was before this fix: the row's current `cwd` decides routing, as every identified
 * session's own drain call still expects.
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
        (id, payload, status, { claims }) =>
          buildArtifactPresentation(artifactAccess(ctx), workspace, id, payload, status, cursor, { claims }),
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
      return Response.json(
        withSignals(ctx, sessionId, { delivery_id: null, drained: [], count: 0, has_more: candidates.length > 0 }),
      );
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
          (id, payload, status, { claims }) =>
            buildArtifactPresentation(artifactAccess(ctx), candidate.workspace, id, payload, status, cursor, {
              claims,
            }),
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

    return Response.json(
      withSignals(ctx, sessionId, {
        delivery_id: compositeDeliveryId,
        drained,
        count: drained.length,
        has_more: undisclosedLocalCandidates || candidates.length > selected.length,
      }),
    );
  });
}

/** Adds the session's pending signals (issue #155) to a drain response — outside the 32 KiB entry
 * budget, with their own cap of 8 signals / 8 KiB — and only when there are any, so a drain with
 * nothing to say is byte-identical to one from before signals existed. */
function withSignals<T extends object>(ctx: ApiContext, sessionId: string, body: T): T & { signals?: SignalFrame[] } {
  const signals = ctx.signalRegistry?.pending(sessionId) ?? [];
  return signals.length > 0 ? { ...body, signals } : body;
}

/** `POST /api/sessions/:id/signals/:sid/ack` — the addressee acknowledges one signal (issue #155).
 * The path session AND the body's `ack_token` must both match the signal's own; anything else is
 * the same 404 as a signal that does not exist, so the route reveals nothing about other sessions'
 * signals. Repeating an ack is a 200. */
async function handleSignalAck(ctx: ApiContext, sessionId: string, signalId: string, req: Request): Promise<Response> {
  const pathname = new URL(req.url).pathname;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return problem(400, "validation-failed", "body must be valid JSON", undefined, pathname);
  }
  const token = (body as { ack_token?: unknown } | null)?.ack_token;
  if (typeof token !== "string" || token.length === 0) {
    return problem(400, "validation-failed", "ack_token is required", undefined, pathname);
  }
  const outcome = ctx.signalRegistry?.ack(sessionId, signalId, token) ?? "not-found";
  if (outcome === "not-found") return problem(404, "not-found", "no such signal for this session", undefined, pathname);
  return Response.json({ signal_id: signalId, acked: true, ...(outcome === "already" ? { already: true } : {}) });
}

/** `POST /api/sessions/:id/drain` — prepares the MCP pull payload (`glosa_inbox_pull`, A1 §5.15).
 * Selection, actionable formatting, byte accounting, and reservation happen under one workspace
 * mutex; no `presented` event is written until the output owner calls the acknowledgement route
 * after its protocol write succeeds. An entry whose earlier attempts failed or only reached
 * `transport_accepted` remains eligible. `via` is always `mcp_pull` — the push transports
 * (monitor, Codex app-server) have their own stream/ack routes and never go through this
 * drain-and-mark route. An unknown session_id is a typed 404, as on heartbeat; clients can
 * re-register before retrying. */
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
  const via: DeliveryVia = "mcp_pull";
  let entryId: string | undefined;
  let cursor: string | undefined;
  // Issue #205: the immutable scope a generic MCP pull sends for itself, additive and optional (A1
  // §5.15). Captured once, here, before anything async runs — never re-derived from the session's
  // live registry row, which a concurrent re-registration can legitimately move out from under this
  // exact request. An identified session's own drain call omits it, and its routing still resolves
  // from the row unchanged.
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
      // A client-supplied `via` other than `mcp_pull` is refused rather than recorded: this route
      // only ever surfaces an MCP pull, and the journal must never carry a transport that did not
      // actually happen (A5 §F23).
      if (Object.hasOwn(body, "via") && body.via !== "mcp_pull") {
        return problem(400, "validation-failed", "via must be mcp_pull", undefined, url.pathname);
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
    (id, payload, status, { claims }) =>
      buildArtifactPresentation(artifactAccess(ctx), workspace, id, payload, status, cursor, { claims }),
  );

  return Response.json(withSignals(ctx, sessionId, prepared));
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

/** Provider-neutral SSE stream used by plugin transports. It reuses the same bounded presentation
 * builder as MCP pull, emits the parked queue on connect, and subscribes to the journal for later
 * entries. Transport acceptance remains non-terminal; only an explicit agent acknowledgement can
 * suppress the entry from later pull delivery. */
async function handleSessionStream(
  ctx: ApiContext,
  sessionId: string,
  req: Request,
  server: BunServer | undefined,
  authSignal?: AbortSignal,
): Promise<Response> {
  const transport = new URL(req.url).searchParams.get("transport") ?? "monitor";
  if (transport !== "monitor" && transport !== "codex_app_server") {
    return problem(400, "validation-failed", "transport must be monitor|codex_app_server");
  }
  const record = ctx.sessionRegistry.get(sessionId);
  if (!record || ctx.sessionRegistry.liveness(sessionId) !== "alive") {
    return problem(404, "not-found", "unknown live session", undefined, new URL(req.url).pathname);
  }
  if (!record.workspace_binding) {
    return problem(409, "conflict", "session is not explicitly bound", undefined, new URL(req.url).pathname);
  }
  if (
    (transport === "monitor" && record.provider !== "claude-code") ||
    (transport === "codex_app_server" && record.provider !== "codex")
  ) {
    return problem(409, "conflict", "session provider does not match the requested stream transport");
  }
  if (!ctx.pushRegistry) {
    return problem(503, "internal", "session push is unavailable", undefined, new URL(req.url).pathname);
  }

  const workspace = ctx.workspaceIndex.get(record.workspace_binding);
  if (!workspace || !workspace.present || (workspace.lifecycle?.state ?? "active") !== "active") {
    return problem(404, "not-found", "bound workspace is not active", undefined, new URL(req.url).pathname);
  }
  const bus = await resolveBus(ctx, workspace);
  const encoder = new TextEncoder();
  const signals = [req.signal, lifecycleSignal(ctx, authSignal)].filter((signal): signal is AbortSignal => !!signal);
  const signal = AbortSignal.any(signals);
  const sent = new Set<string>();
  let unregister: (() => void) | undefined;
  let unsubscribe: (() => void) | undefined;
  let releaseLease: (() => void) | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let pumping = false;
  let rerun = false;
  let closed = false;

  const close = (supersededBy?: "monitor" | "codex_app_server") => {
    if (closed) return;
    closed = true;
    signal.removeEventListener("abort", abortClose);
    if (supersededBy) {
      // #206: the ONLY frame that ever precedes close(). Written before unsubscribe/unregister/
      // release so a reader already blocked in `read()` observes it ahead of EOF — daemon shutdown,
      // token revocation/rotation, client cancel and send failure never pass a reason here and stay
      // byte-identical EOF.
      try {
        controller.enqueue(
          encoder.encode(`event: superseded\ndata: ${JSON.stringify({ transport: supersededBy })}\n\n`),
        );
      } catch {
        /* stream already torn down underneath us; nothing left to signal */
      }
    }
    unsubscribe?.();
    unregister?.();
    releaseLease?.();
    try {
      controller.close();
    } catch {
      /* reader cancellation already closed the stream */
    }
  };
  const abortClose = () => close();

  const stream = new ReadableStream<Uint8Array>({
    start(output) {
      controller = output;
      if (signal.aborted) {
        close();
        return;
      }
      const send = (entry: DeliverableEntry) => {
        try {
          controller.enqueue(encoder.encode(`event: delivery\ndata: ${JSON.stringify(entry)}\n\n`));
        } catch (error) {
          close();
          throw error;
        }
      };
      // Issue #155: signals share this one writer with deliveries, so frames never interleave.
      // `ack_token` rides only in this session's own frames — every signal record has one addressee.
      const sendSignal = (frame: SignalFrame) => {
        try {
          controller.enqueue(encoder.encode(`event: signal\ndata: ${JSON.stringify(frame)}\n\n`));
        } catch (error) {
          close();
          throw error;
        }
      };
      unregister = ctx.pushRegistry?.register(sessionId, send, close, transport, sendSignal);
      releaseLease = ctx.sessionRegistry.holdConnection(sessionId);

      const pump = async () => {
        if (closed) return;
        if (pumping) {
          rerun = true;
          return;
        }
        pumping = true;
        try {
          do {
            rerun = false;
            const plan = await bus.previewDelivery(
              DRAIN_MAX,
              { session: sessionId, excludeEntryIds: sent },
              (id, payload, status, { claims }) =>
                buildArtifactPresentation(artifactAccess(ctx), workspace, id, payload, status, undefined, { claims }),
            );
            for (const candidate of plan.entries) {
              if (closed || !candidate.presentation) break;
              const entry = candidate.presentation as DeliverableEntry;
              const accepted = await ctx.pushRegistry!.send(sessionId, entry, 30_000);
              if (!accepted) break;
              sent.add(entry.id);
            }
            if (plan.has_more && plan.entries.length > 0) rerun = true;
          } while (rerun && !closed);
        } finally {
          pumping = false;
        }
      };

      unsubscribe = bus.subscribe(({ event }) => {
        if (event.event !== "delivery_attempt") void pump();
      });
      controller.enqueue(encoder.encode(": connected\n\n"));
      // Anything addressed to this session while it had no stream is sent now, oldest first.
      for (const frame of ctx.signalRegistry?.pending(sessionId, {
        limit: Number.POSITIVE_INFINITY,
        maxBytes: Number.POSITIVE_INFINITY,
      }) ?? []) {
        sendSignal(frame);
      }
      signal.addEventListener("abort", abortClose, { once: true });
      void pump();
    },
    cancel: () => close(),
  });
  server?.timeout(req, 0);
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}

/** The one read behind both the `stream/status` probe and `/api/status`'s per-session `push`
 * (#306). An absent registry is an honest "no push", never an error: a daemon assembled without
 * one simply has no session holding a stream. */
function pushTransport(ctx: ApiContext, sessionId: string): "monitor" | "codex_app_server" | null {
  return ctx.pushRegistry?.transport(sessionId) ?? null;
}

/** `GET /api/sessions/:id/stream/status` (#206) — an authenticated, read-only ownership probe. It
 * answers from `SessionPushRegistry` alone: no session-registry lookup, no liveness check, no lease
 * hold, no registration. An unknown session id honestly reports `connected:false` the same as a
 * known one with no live connection — a parked client's probe treats both as "free". */
function handleSessionStreamStatus(ctx: ApiContext, sessionId: string): Response {
  const transport = pushTransport(ctx, sessionId);
  return Response.json({ connected: transport !== null, transport });
}

async function handleSessionStreamTransportAck(ctx: ApiContext, sessionId: string, entryId: string): Promise<Response> {
  const record = ctx.sessionRegistry.get(sessionId);
  const transport = ctx.pushRegistry?.transport(sessionId);
  if (!record?.workspace_binding || (transport !== "monitor" && transport !== "codex_app_server"))
    return problem(404, "not-found", "unknown session stream");
  if (!ctx.pushRegistry?.isAwaitingTransport(sessionId, entryId)) {
    return problem(409, "conflict", "stream delivery is not awaiting transport acknowledgement");
  }
  const bus = await resolveBus(ctx, ctx.workspaceIndex.get(record.workspace_binding) ?? record.workspace_binding);
  const attempts = bus.state.entries[entryId]?.deliveryAttempts;
  await bus.recordDeliveryAttempt(entryId, {
    fsync: true,
    idem: `${transport}:${sessionId}:${entryId}:transport_accepted`,
    via: transport,
    session: sessionId,
    outcome: "transport_accepted",
    reason: Array.isArray(attempts) && attempts.length > 0 ? "re_nudge" : "initial",
  });
  if (!ctx.pushRegistry?.acknowledgeTransport(sessionId, entryId)) {
    return problem(409, "conflict", "stream delivery is not awaiting transport acknowledgement");
  }
  return Response.json({ acknowledged: true });
}

async function handleSessionStreamPresentedAck(
  ctx: ApiContext,
  sessionId: string,
  entryId: string,
  req: Request,
): Promise<Response> {
  const record = ctx.sessionRegistry.get(sessionId);
  if (!record?.workspace_binding) return problem(404, "not-found", "unknown explicitly bound session");
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return problem(400, "validation-failed", "body must be valid JSON");
  }
  const outcome = (body as Record<string, unknown> | null)?.outcome;
  if (outcome !== "presented" && outcome !== "failed") {
    return problem(400, "validation-failed", "outcome must be presented|failed");
  }
  const bus = await resolveBus(ctx, ctx.workspaceIndex.get(record.workspace_binding) ?? record.workspace_binding);
  const attempts = bus.state.entries[entryId]?.deliveryAttempts;
  const accepted = Array.isArray(attempts)
    ? [...attempts]
        .reverse()
        .find(
          (attempt) =>
            attempt.session === sessionId &&
            attempt.outcome === "transport_accepted" &&
            (attempt.via === "monitor" || attempt.via === "codex_app_server"),
        )
    : undefined;
  if (!accepted || (accepted.via !== "monitor" && accepted.via !== "codex_app_server")) {
    return problem(409, "conflict", "entry has no accepted session-stream delivery");
  }
  const acknowledged = await bus.acknowledgePushedEntry(entryId, {
    session: sessionId,
    via: accepted.via,
    outcome,
    ...(outcome === "failed" ? { error: "stream_presentation_failed" } : {}),
  });
  if (!acknowledged) return problem(409, "conflict", "entry is not deliverable to this session");
  return Response.json({ acknowledged: true, delivered: outcome === "presented" });
}

/** Does this session STILL hold the binding it was admitted under? Synchronous on purpose: it is
 * handed to the bus record methods and evaluated inside the mutex that guards their append (review
 * round 4, F-7/F-3).
 *
 * Checking it in the route before awaiting the append is not enough, and that was the first
 * attempt. `runExclusive` is an asynchronous queue, so a request can validate its binding, queue
 * behind another writer, lose the binding while waiting, and still append — recording a delivery
 * attempt for a session that had already moved on. Authority is only meaningful re-read at the
 * moment of the write. */
function stillBound(ctx: ApiContext, sessionId: string, owned: string): () => boolean {
  // Captured BEFORE the first await, so the predicate compares a generation and not just a value.
  // Comparing values alone misses ABA: rebind A→B→A, or deregister and re-register with the same
  // binding, restores every compared field while the authority this request was admitted under is
  // gone (review round 5). The signal for that generation has fired by then, and no later one can
  // un-fire it.
  const admitted = ctx.sessionRegistry.sessionLifecycleSignal(sessionId);
  return () => {
    if (admitted?.aborted) return false;
    const current = ctx.sessionRegistry.get(sessionId);
    return !!current && ctx.sessionRegistry.liveness(sessionId) === "alive" && current.workspace_binding === owned;
  };
}

/** `POST /api/sessions/:id/watch/transport-ack` (#153 Part 2, W4) — Origin-gated, records
 * `delivery_attempt{via:"watch", session, outcome:"transport_accepted"}` for exactly the ids the
 * client's own watch response body named, once the HTTP body actually reached it.
 *
 * Provenance is the whole point of the route, so it is checked here rather than assumed. This used
 * to accept any id that was currently an `external_edit` entry in the bound workspace, reasoning
 * that the bus-level scope check stood in for `handleSessionStreamTransportAck`'s
 * `isAwaitingTransport`. It does not: entry ids appear in ordinary reads, so any bearer of the
 * token could mint `transport_accepted` — and then `presented`, which gates on it — for an entry
 * no watch ever delivered to that session, writing a delivery record that never happened
 * (AGENTS.md invariant 3). `WatchEmissionRegistry` supplies the missing half: only ids a watch
 * response actually emitted to THIS session are ackable. */
async function handleSessionWatchTransportAck(ctx: ApiContext, sessionId: string, req: Request): Promise<Response> {
  const pathname = new URL(req.url).pathname;
  const record = ctx.sessionRegistry.get(sessionId);
  if (!record?.workspace_binding)
    return problem(404, "not-found", "unknown explicitly bound session", undefined, pathname);
  // Built before the body read, so the capture is the first thing this handler does with authority.
  //
  // Review round 6 called the later placement a live race: a rebind A→B→A while the body streams
  // would capture the REPLACEMENT generation. That does not hold on this path, and it was checked
  // rather than argued — `createApiFetch` calls `readBodyCapped(req)` and rebuilds the request over
  // the drained bytes BEFORE `route.handle`, so by the time any handler runs `req.json()` resolves
  // from memory and spans nothing. A test built on a streaming body could not observe the window
  // because the window does not exist; it was removed rather than kept as decoration.
  //
  // The capture stays here anyway: it costs nothing, and it keeps the ordering correct by
  // construction rather than by depending on a transport-layer detail that could change.
  const authorised = stillBound(ctx, sessionId, record.workspace_binding);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return problem(400, "validation-failed", "body must be valid JSON", undefined, pathname);
  }
  const entries = (body as Record<string, unknown> | null)?.entries;
  if (!Array.isArray(entries) || entries.length === 0 || !entries.every((e) => typeof e === "string")) {
    return problem(400, "validation-failed", "entries must be a non-empty array of entry ids", undefined, pathname);
  }
  const emitted = (entries as string[]).filter((id) => ctx.watchEmissions?.isAwaitingTransport(sessionId, id));
  if (emitted.length === 0) {
    return problem(409, "conflict", "no named id was emitted to this session by a watch response", undefined, pathname);
  }
  const bus = await resolveBus(ctx, ctx.workspaceIndex.get(record.workspace_binding) ?? record.workspace_binding);
  const { accepted, authorityLost } = await bus.recordWatchTransportAccepted(sessionId, emitted, authorised);
  if (authorityLost)
    return problem(409, "conflict", "session is no longer bound to this workspace", undefined, pathname);
  if (accepted.length === 0)
    return problem(409, "conflict", "no named id is an in-scope external_edit entry", undefined, pathname);
  return Response.json({ accepted });
}

/** `POST /api/sessions/:id/watch/ack` (#153 Part 2, W4) — Origin-gated, records `presented`
 * (default) or `failed` after the MCP tool response reaches stdout (`DeliveryAwareTransport`).
 * `recordWatchPresented` refuses any id this session's watch never recorded `transport_accepted`
 * for, mirroring `handleSessionStreamPresentedAck`'s "no attempt without proven transport" rule. */
async function handleSessionWatchAck(ctx: ApiContext, sessionId: string, req: Request): Promise<Response> {
  const pathname = new URL(req.url).pathname;
  const record = ctx.sessionRegistry.get(sessionId);
  if (!record?.workspace_binding)
    return problem(404, "not-found", "unknown explicitly bound session", undefined, pathname);
  // Same boundary as `transport-ack`, for the same reason recorded there.
  const authorised = stillBound(ctx, sessionId, record.workspace_binding);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return problem(400, "validation-failed", "body must be valid JSON", undefined, pathname);
  }
  const parsed = body as Record<string, unknown> | null;
  const entries = parsed?.entries;
  if (!Array.isArray(entries) || entries.length === 0 || !entries.every((e) => typeof e === "string")) {
    return problem(400, "validation-failed", "entries must be a non-empty array of entry ids", undefined, pathname);
  }
  const outcome = parsed?.outcome ?? "presented";
  if (outcome !== "presented" && outcome !== "failed") {
    return problem(400, "validation-failed", "outcome must be presented|failed", undefined, pathname);
  }
  const error = typeof parsed?.error === "string" ? parsed.error : undefined;
  const bus = await resolveBus(ctx, ctx.workspaceIndex.get(record.workspace_binding) ?? record.workspace_binding);
  const { accepted, authorityLost } = await bus.recordWatchPresented(
    sessionId,
    entries as string[],
    outcome,
    error,
    authorised,
  );
  if (authorityLost)
    return problem(409, "conflict", "session is no longer bound to this workspace", undefined, pathname);
  if (accepted.length === 0) {
    return problem(
      409,
      "conflict",
      "no named id has an accepted watch transport for this session",
      undefined,
      pathname,
    );
  }
  return Response.json({ accepted });
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
  return openWorkspaceAt(
    ctx,
    rawPath,
    {
      externalState: parsed?.external_state === true,
      ...(focus ? { focus } : {}),
      ...(parsed?.focus_first === true ? { focusFirst: true } : {}),
      ...(parsed?.require_focus === true ? { requireFocus: true } : {}),
    },
    url.pathname,
  );
}

/** The shared body of `glosa open` and reopening a star: register (or refresh) the target, adopt
 * loose lineages into a directory, and reconcile its bus once. */
/** The remedy for whatever row owns `rawPath`, or the slugless fallback when none survives. Never
 * throws: this runs on an error path, and a failed lookup must not replace one refusal with
 * another. */
function forgetRemedyForPath(ctx: ApiContext, rawPath: string): string {
  try {
    const canonical = canonicalize(rawPath);
    const row = ctx.workspaceIndex
      .list()
      .find(
        (e) => e.lifecycle?.state === "forgetting" && (e.canonical_path === canonical || e.worktree_path === rawPath),
      );
    return row ? forgetRemedy(row.slug) : forgetRemedyWithoutSlug();
  } catch {
    return forgetRemedyWithoutSlug();
  }
}

async function openWorkspaceAt(
  ctx: ApiContext,
  rawPath: string,
  options: Parameters<WorkspaceIndex["resolveOpenTarget"]>[1],
  pathname: string,
): Promise<Response> {
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
    const opened = await ctx.workspaceIndex.resolveOpenTarget(rawPath, options);
    if (opened.entry.kind === "directory") {
      await adoptLooseLineages(
        ctx.workspaceIndex,
        opened.entry,
        ctx.getWorkspaceBus,
        ctx.sealAdoptionSources,
        ownershipCoordinator(ctx),
        ctx.createAdoptionStagingBus,
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
      if (error.code === "alias-discovery-unavailable") {
        console.error(`[glosa] ${error.message}`);
        return problem(503, error.code, "hardlink alias discovery unavailable", undefined, pathname);
      }
      const status = error.code === "artifact-not-tracked" || error.code === "no-tracked-artifact" ? 422 : 400;
      return problem(status, error.code, error.message, undefined, pathname);
    }
    if (error instanceof AdoptionError) {
      // THE site the connect flow hits: `glosa_session_bind` and `glosa_present` both open the
      // workspace before they bind, so this is where a session inside a half-deleted workspace is
      // refused (#312). `resolveOpenTarget` throws from several depths and does not carry a slug,
      // so resolve one from the requested path when the index still has a row; when it does not —
      // the registration-less window, where the row is already gone — name `doctor`, which reads
      // the durable forget record, rather than interpolate `undefined` into a delete command.
      const detail = error.code === "workspace-forgetting" ? forgetRemedyForPath(ctx, rawPath) : undefined;
      return problem(409, error.code, error.message, detail, pathname);
    }
    if (error instanceof WorkspaceAdoptedError) {
      return problem(409, "workspace-adopted", error.message, undefined, pathname);
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
    // `deferred` is a legal-but-inert no-op on the lifecycle reducer (absent from both guard
    // tables) — firing it on an entry that's ALREADY terminal would otherwise still return 200
    // `{to: "deferred"}`, which a client reading only `to` could misread as a successful
    // transition. The bus refuses it under the same in-mutex terminal guard every other close
    // uses (issue #155), so this endpoint always tells the truth about what happened.
    try {
      const deferred = await bus.deferEntry(entry, session, { ...(note !== undefined ? { note } : {}) });
      return Response.json({ entry, status: deferred.status, to: "deferred" });
    } catch (err) {
      const mapped = claimProblem(err, url.pathname);
      if (mapped) return mapped;
      throw err;
    }
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

  const fence = b?.fence;
  if (fence !== undefined && (typeof fence !== "number" || !Number.isInteger(fence) || fence < 1)) {
    return problem(400, "validation-failed", "fence must be a positive integer", undefined, url.pathname);
  }
  try {
    const result = await bus.resolveEntry(entry, outcome as "applied" | "rejected" | "stale", session, {
      note,
      ...(typeof fence === "number" ? { fence } : {}),
    });
    // A replay (issue #155 rung 1) answers with the ORIGINAL result and says so, so a retrying
    // caller can tell "this is what you already did" from "this just happened".
    return Response.json({
      entry,
      status: outcome,
      to: outcome,
      lease_id: result.leaseId,
      post_sha: result.postSha,
      ...(result.fence !== null ? { fence: result.fence } : {}),
      ...(result.replayed ? { replayed: true } : {}),
    });
  } catch (err) {
    // Every ladder refusal is a 409 with a slug of its own and the holder/tombstone inline, and an
    // unknown entry is a 404 — all of them exit 8 in the CLI (A6 §F26 fixes `resolve`'s exit set
    // at `0;3;8;2`; exit 12 belongs to apply-begin's conflict).
    const mapped = claimProblem(err, url.pathname);
    if (mapped) return mapped;
    throw err;
  }
}

/** `POST /api/workspaces/inbox/dismiss` — `glosa inbox dismiss <id>`'s daemon-side half (issue
 * #142). Mirrors `handleWorkspaceResolve`'s `deferred` arm above (404 → terminal-guard 409
 * `entry-resolved` → one transition → JSON), with `by: "human"` (a person typed the command,
 * never a session) and `to: "dismissed"`, first-terminal-wins against `applied`/`rejected`/`stale`
 * exactly as it does against a second dismiss. No inbox file is touched; this is precisely the
 * supported, durably-recorded reconciliation the issue's hand-move workaround never left a trace
 * of. Unchanged on the wire except that a claim it released is named in `released`. */
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

  try {
    // A person dismissing an entry an agent holds is the human-wins case (issue #155 REQ-6): the
    // claim is released `by: "human"` inside the same critical section that closes the entry.
    const dismissed = await bus.dismissEntry(entry, { ...(note !== undefined ? { note } : {}) });
    return Response.json({
      entry,
      status: dismissed.status,
      to: "dismissed",
      ...(dismissed.released.length > 0
        ? {
            released: dismissed.released.map((claim) => ({
              claim_id: claim.claim_id,
              holder_session: claim.holder_session,
            })),
          }
        : {}),
    });
  } catch (err) {
    const mapped = claimProblem(err, url.pathname);
    if (mapped) return mapped;
    throw err;
  }
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
 * half (A4 §F05). Kept as an alias for an exclusive claim over `entry:<id>` (issue #155): another
 * session holding the entry's paths surfaces as 409 `claim-held`, which the CLI maps to exit 12. */
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
    const principal = ctx.sessionRegistry.get(session)?.principal ?? principalOfRequest(req);
    const result = await bus.applyBegin(entry, session, principal);
    // Same session again renews (issue #155 REQ-3): 200 with the SAME lease id and fence, never a
    // conflict. `lease_id` is the claim id; `pre_sha` is what the claim's interval is measured from.
    return new Response(
      JSON.stringify({
        entry,
        lease_id: result.leaseId,
        pre_sha: result.preSha,
        fence: result.fence,
        expires_at: result.expiresAt,
        ...(result.renewed ? { renewed: true } : {}),
      }),
      { status: result.renewed ? 200 : 201, headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    // Another session's claim over this entry's paths → 409 `claim-held` with the holder inline
    // (the CLI maps it to exit 12). An entry from another workspace, or none at all → 404 naming
    // the likeliest mistake, never the detail-free 500 an unhandled throw would produce.
    const mapped = claimProblem(err, url.pathname);
    if (mapped) return mapped;
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
        lifecycle: "forgetting" as const,
        remedy: forgetRemedy(op.target_slug),
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
      const liveUpdates = ctx.artifactWatcherRegistry?.liveUpdatesFor(e);
      return {
        slug: e.slug,
        path: e.worktree_path,
        last_seen: e.last_seen,
        // BADGE-facing, and the one the SPA actually renders (`agent-feedback.js`). `glosa doctor`'s
        // pending-delivery check reads it too, and says "queued, no live session" — a promise an
        // `external_edit` cannot keep, since it is excluded from ORDINARY delivery eligibility.
        // Since #153 Part 2 a bound session can still pull its own through `GET /w/:slug/watch`,
        // which is the opt-in exception and deliberately changes neither this count nor the badge.
        pending_count: badgePendingCount(peek.state),
        has_attention: hasOpenAttention(peek.state),
        // Additive (issue #142): journal entries whose immutable inbox payload has gone missing —
        // see `orphanedEntryCount`'s own docstring for the exact orphan signature and why the count
        // reuses this already-computed fold rather than folding the journal a second time.
        orphaned_entry_count: orphanedEntryCount(e, peek),
        // Additive (issue #156): a `glosa forget` whose deletion is durably committed — possibly
        // mid-resume after a crash — so `doctor` can name the interrupted state and the exact resume
        // command instead of misreading a mid-deletion workspace as merely "not yet opened".
        ...(e.lifecycle?.state === "forgetting"
          ? { lifecycle: "forgetting" as const, remedy: forgetRemedy(e.slug) }
          : {}),
        // Additive (contract 1.15, issue #219): runtime truth only. Omitted when a narrow test or
        // older composition does not provide the daemon-owned watcher registry.
        ...(liveUpdates ? { live_updates: liveUpdates } : {}),
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
  const sessions = ctx.sessionRegistry.list().map((s) => {
    const transport = pushTransport(ctx, s.session_id);
    return {
      session_id: s.session_id,
      provider: s.provider,
      cwd: s.cwd,
      workspace_binding: s.workspace_binding ?? null,
      source: s.source,
      lease_expiry: s.lease_expiry,
      last_active_at: s.last_active_at,
      liveness: ctx.sessionRegistry.liveness(s.session_id),
      // Contract 1.17 (issue #155): which principal registered this session — reporting only.
      ...(s.principal ? { principal: s.principal } : {}),
      // Contract 1.16 (issue #306). Answered from `SessionPushRegistry` alone, exactly like the
      // `GET /api/sessions/:id/stream/status` probe, and carrying that probe's shape verbatim so
      // there is ONE wire shape for "is push live" rather than two that must be kept in step.
      //
      // This is a delivery-transport fact about one session, NOT a workspace-connection fact: it
      // must never feed the connected/stale/unbound derivation, which stays `workspace_binding` +
      // liveness and nothing else (A1 §5.2b). `source` cannot stand in for it — an explicit bind
      // overwrites `source` with "mcp", erasing the only trace a monitor leaves behind.
      push: { connected: transport !== null, transport },
    };
  });
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

const WATCH_SHA_PATTERN = /^[0-9a-f]{40}$/;

/** `GET /w/:slug/watch?session=&path=&since=&wait_ms=` (#153 Part 2) — an opt-in held read over
 * `external_edit`. Session identity/binding is validated exactly like the session stream
 * (`handleSessionStream`'s own checks, above): registered, alive, and explicitly bound to THIS
 * workspace — a watch is per-session by construction, so an unbound or foreign session has no
 * scope to watch. D7/W3: this is a SEPARATE held request from the monitor stream — it never
 * touches `SessionPushRegistry` and holds the session lease under its own, per-request
 * `holdConnection` key, so it neither closes nor is closed by a live monitor stream, and two
 * concurrent watches by the same session never cancel each other's lease refresh. W3's lifecycle
 * abort set (session rebind/deregistration via `sessionLifecycleSignal`, workspace eviction/
 * forget/close via `bus.closeSignal()`) ends the hold the moment the binding this request captured
 * stops being authoritative, rather than serving (or, on the ack routes, appending against) a
 * workspace the session has since left. W4: this GET writes nothing — the client acknowledges
 * transport receipt and presentation through the two POSTs below. */
async function handleWorkspaceWatch(
  ctx: ApiContext,
  slug: string,
  req: Request,
  server: BunServer | undefined,
  authSignal?: AbortSignal,
): Promise<Response> {
  const url = new URL(req.url);
  const pathname = url.pathname;
  const resolved = workspaceOrNotFound(ctx, slug, pathname);
  if (!resolved.ok) return resolved.response;
  const entry = resolved.entry;

  const sessionId = url.searchParams.get("session");
  if (!sessionId) return problem(400, "validation-failed", "session is required", undefined, pathname);
  const record = ctx.sessionRegistry.get(sessionId);
  if (!record || ctx.sessionRegistry.liveness(sessionId) !== "alive") {
    return problem(404, "not-found", "unknown live session", undefined, pathname);
  }
  if (!record.workspace_binding || record.workspace_binding !== entry.canonical_path) {
    return problem(409, "conflict", "session is not explicitly bound to this workspace", undefined, pathname);
  }

  let path: string | undefined;
  const rawPath = url.searchParams.get("path");
  if (rawPath !== null) {
    if (!confinePath(entry.worktree_path, rawPath).ok) {
      return problem(400, "invalid-path", "path must be workspace-relative and confined", undefined, pathname);
    }
    path = rawPath
      .split("/")
      .map((segment) => segment.normalize("NFC"))
      .join("/");
  }

  const since = url.searchParams.get("since") ?? undefined;
  if (since !== undefined && !WATCH_SHA_PATTERN.test(since)) {
    return problem(400, "validation-failed", "since must be a full shadow-git checkpoint sha", undefined, pathname);
  }

  const rawWait = url.searchParams.get("wait_ms");
  let waitMs = 0;
  if (rawWait !== null) {
    waitMs = Number(rawWait);
    if (!Number.isFinite(waitMs) || !Number.isInteger(waitMs) || waitMs < 0 || waitMs > MAX_ENTRY_WAIT_MS) {
      return problem(
        400,
        "validation-failed",
        `wait_ms must be an integer between 0 and ${MAX_ENTRY_WAIT_MS}`,
        undefined,
        pathname,
      );
    }
  }

  // Captured with the ADMISSION, before any await: a rebind away and back, or a deregister followed
  // by re-registration with the same binding, leaves the post-await state identical while handing a
  // later caller a fresh, un-aborted controller. Taking the signal here means this request holds the
  // one belonging to the generation it was admitted under, so that ABA sequence aborts it (review
  // round 2, F-7).
  const admittedLifecycle = ctx.sessionRegistry.sessionLifecycleSignal(sessionId);
  // A read: no reconciliation here (see `resolveBusForRead`). Attaching a session hydrates, but
  // neither attach route is assumed to have succeeded — an unhydrated workspace is folded read-only
  // rather than answered from empty derived state.
  const bus = await resolveBusForRead(ctx, entry);
  // An instance nobody reconciled has empty derived state, which reads as "nothing to report".
  // Fold the journal read-only rather than serving that silence, or erroring on a workspace whose
  // journal can be answered from perfectly well. Writes nothing; see `hydrateForRead`.
  await bus.hydrateForRead();
  const signals = [req.signal, lifecycleSignal(ctx, authSignal), admittedLifecycle, bus.closeSignal()].filter(
    (s): s is AbortSignal => !!s,
  );
  const signal = AbortSignal.any(signals);
  // The binding was checked before `resolveBus` awaited. A rebind landing in that window would hand
  // us a lifecycle signal for the NEW generation, which never fires for the request admitted under
  // the old one — so the hold would run its full `wait_ms` against a workspace this session no
  // longer watches. Re-read the binding now that the signal exists and refuse if it moved (review
  // round 1, F-7).
  const admitted = ctx.sessionRegistry.get(sessionId);
  if (!admitted || ctx.sessionRegistry.liveness(sessionId) !== "alive") {
    return problem(404, "not-found", "unknown live session", undefined, pathname);
  }
  if (admitted.workspace_binding !== entry.canonical_path) {
    return problem(409, "conflict", "session is not explicitly bound to this workspace", undefined, pathname);
  }
  // W3: a unique key per request, never the stream's `"push"` key — two concurrent watches by the
  // same session each get their own handle, and neither cancels the monitor stream's lease.
  const releaseLease = ctx.sessionRegistry.holdConnection(sessionId, `watch:${randomUUID()}`);
  server?.timeout(req, 0);
  try {
    const result = await waitForWatch(
      bus,
      { session: sessionId, path, since, waitMs, signal },
      (id, payload, status, { claims }) =>
        buildArtifactPresentation(artifactAccess(ctx), entry, id, payload, status, undefined, {
          watched: true,
          claims,
        }),
    );
    // Revalidate the admitted authority before anything leaves this handler (review round 3,
    // F-7/F-3). `waitForWatch` can settle on an authority-loss abort and still carry entries it
    // read earlier, so a rebind, deregistration or bus close during the hold would otherwise let
    // this response emit — and register — entries belonging to a workspace this session no longer
    // watches. Checked here, after the await and before `noteEmitted`, so nothing is emitted or
    // made ackable under authority that has since moved.
    const stillAdmitted = ctx.sessionRegistry.get(sessionId);
    const authorityHeld =
      // The captured generations first: a value comparison alone cannot see an A→B→A rebind, and a
      // closed bus can still answer from state read before it closed (review round 5).
      !admittedLifecycle?.aborted &&
      !bus.closeSignal().aborted &&
      !!stillAdmitted &&
      ctx.sessionRegistry.liveness(sessionId) === "alive" &&
      stillAdmitted.workspace_binding === entry.canonical_path;
    if (!authorityHeld) {
      // §5.11b: the hold ends returning what the cursor has, honestly — so this stays a 200 rather
      // than becoming an error. What it must NOT do is hand over entries read under authority that
      // has since moved, which is what an authority-loss abort would otherwise carry out of
      // `waitForWatch`. Empty, and nothing made ackable.
      return Response.json({ entries: [], latest_checkpoint: result.latest_checkpoint, has_more: false });
    }
    // Record what this response hands over BEFORE handing it over, so `watch/transport-ack` can
    // tell an id this session was really given from one it merely knows the name of (review round
    // 2). An emission that never reaches the client simply expires unacked.
    ctx.watchEmissions?.noteEmitted(
      sessionId,
      result.entries.map((emitted) => emitted.id),
    );
    return Response.json({
      entries: result.entries,
      latest_checkpoint: result.latest_checkpoint,
      has_more: result.has_more,
    });
  } finally {
    releaseLease();
  }
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
    return { routeClass: "navigation", handle: () => serveSpaAsset(ctx, req, pathname) };
  }
  if (method === "GET" && pathname === "/api/workspaces") {
    return { routeClass: "authed-read", handle: () => handleListWorkspaces(ctx) };
  }
  // P4.3: the session-registration surface the monitor, the Codex attachment, and the MCP shim
  // call into (A2 §F08/R2) — see the handlers' own header comment above.
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
  if (method === "GET" && pathname === "/api/stars") {
    return { routeClass: "authed-read", handle: () => handleListStars(ctx) };
  }
  if (method === "POST" && pathname === "/api/stars") {
    return { routeClass: "state-changing", handle: (req) => handleStarWorkspace(ctx, req) };
  }
  {
    const starRoute = pathname.match(/^\/api\/stars\/([0-9a-f]{16})\/(open|unstar)$/);
    if (method === "POST" && starRoute) {
      const id = starRoute[1] as string;
      return starRoute[2] === "open"
        ? { routeClass: "state-changing", handle: () => handleOpenStar(ctx, id, pathname) }
        : { routeClass: "state-changing", handle: () => handleUnstar(ctx, id, pathname) };
    }
  }
  if (method === "POST" && pathname === "/api/workspaces/forget") {
    return { routeClass: "state-changing", handle: (req) => handleWorkspaceForget(ctx, req) };
  }
  const claimRoute = claimRoutes(
    {
      busForPath: async (rawPath) => {
        const root = canonicalOrNull(rawPath);
        if (!root) throw Object.assign(new Error("invalid workspace path"), { code: "INVALID_WORKSPACE_PATH" });
        return resolveBus(ctx, ctx.workspaceIndex.get(root) ?? root);
      },
      busForSlug: async (slug) => {
        let entry: WorkspaceEntry;
        try {
          entry = findWorkspace(ctx, slug);
        } catch (error) {
          if (error instanceof WorkspaceLookupError && error.code !== "not-found") {
            throw new AdoptionError(
              error.code,
              error.code === "workspace-forgetting"
                ? "workspace is being forgotten"
                : "workspace adoption is in progress",
            );
          }
          throw Object.assign(new Error("unknown workspace"), { code: "WORKSPACE_NOT_FOUND" });
        }
        return resolveBus(ctx, entry);
      },
      // The principal the session registered under, when it registered; otherwise the one this
      // request's own bearer derives. Reporting only (see `principalOf`).
      principalFor: (sessionId, req) => ctx.sessionRegistry.get(sessionId)?.principal ?? principalOfRequest(req),
    },
    method,
    pathname,
  );
  if (claimRoute) return claimRoute;
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
  const dictationRoute = dictationRoutes({ registry: ctx.dictationRegistry }, method, pathname);
  if (dictationRoute) return dictationRoute;

  let m: RegExpMatchArray | null;

  if (method === "POST" && (m = pathname.match(/^\/api\/sessions\/([^/]+)\/heartbeat$/))) {
    const sessionId = m[1] as string;
    return { routeClass: "state-changing", handle: () => handleSessionHeartbeat(ctx, sessionId) };
  }
  if (method === "POST" && (m = pathname.match(/^\/api\/sessions\/([^/]+)\/deregister$/))) {
    const sessionId = m[1] as string;
    return { routeClass: "state-changing", handle: () => handleSessionDeregister(ctx, sessionId) };
  }
  if (method === "POST" && (m = pathname.match(/^\/api\/sessions\/([^/]+)\/signals\/([^/]+)\/ack$/))) {
    const sessionId = m[1] as string;
    const signalId = m[2] as string;
    return { routeClass: "state-changing", handle: (req) => handleSignalAck(ctx, sessionId, signalId, req) };
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
  if (method === "GET" && (m = pathname.match(/^\/api\/sessions\/([^/]+)\/stream$/))) {
    const sessionId = m[1] as string;
    return {
      routeClass: "authed-read",
      handle: (req, server, authSignal) => handleSessionStream(ctx, sessionId, req, server, authSignal),
    };
  }
  if (method === "GET" && (m = pathname.match(/^\/api\/sessions\/([^/]+)\/stream\/status$/))) {
    const sessionId = m[1] as string;
    return { routeClass: "authed-read", handle: () => handleSessionStreamStatus(ctx, sessionId) };
  }
  if (method === "POST" && (m = pathname.match(/^\/api\/sessions\/([^/]+)\/stream\/([^/]+)\/transport-ack$/))) {
    const sessionId = m[1] as string;
    const entryId = m[2] as string;
    return { routeClass: "state-changing", handle: () => handleSessionStreamTransportAck(ctx, sessionId, entryId) };
  }
  if (method === "POST" && (m = pathname.match(/^\/api\/sessions\/([^/]+)\/watch\/transport-ack$/))) {
    const sessionId = m[1] as string;
    return { routeClass: "state-changing", handle: (req) => handleSessionWatchTransportAck(ctx, sessionId, req) };
  }
  if (method === "POST" && (m = pathname.match(/^\/api\/sessions\/([^/]+)\/watch\/ack$/))) {
    const sessionId = m[1] as string;
    return { routeClass: "state-changing", handle: (req) => handleSessionWatchAck(ctx, sessionId, req) };
  }
  if (method === "POST" && (m = pathname.match(/^\/api\/sessions\/([^/]+)\/stream\/([^/]+)\/ack$/))) {
    const sessionId = m[1] as string;
    const entryId = m[2] as string;
    return {
      routeClass: "state-changing",
      handle: (req) => handleSessionStreamPresentedAck(ctx, sessionId, entryId, req),
    };
  }

  const shadowRoute = shadowRoutes(
    {
      workspaceIndex: ctx.workspaceIndex,
      getWorkspaceBus: ctx.getWorkspaceBus,
      home: ctx.home ?? glosaHome(),
      adoptionCoordinator: ownershipCoordinator(ctx),
    },
    method,
    pathname,
  );
  if (shadowRoute) return shadowRoute;

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
  // #153 Part 2: the opt-in held `external_edit` watch (D5/W3/W4) — distinct from the stream
  // below, deliberately: it never shares `SessionPushRegistry` or its `holdConnection` key.
  if (method === "GET" && (m = pathname.match(/^\/w\/([^/]+)\/watch$/))) {
    const slug = m[1] as string;
    return {
      routeClass: "authed-read",
      handle: (req, server, authSignal) => handleWorkspaceWatch(ctx, slug, req, server, authSignal),
    };
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

/**
 * `transport` is a PARAMETER, not an `ApiContext` field, and that is load-bearing. The daemon
 * builds two pipelines — one per listener — and `compositeRegistry`/`adoptionCoordinator` above
 * key their per-daemon singletons on the context's OBJECT IDENTITY via a `WeakMap`. A second
 * context, even a spread copy sharing every reference, would therefore get its own composite
 * delivery registry and its own adoption coordinator: a drain begun on one listener would be
 * invisible to the other. One context, two closures.
 */
export function createApiFetch(
  ctx: ApiContext,
  transport: Transport = "loopback",
): (req: Request, server?: BunServer) => Promise<Response> {
  const overSocket = transport === "socket";

  return async (req, server) => {
    // Read the local consent flag for every response. `glosa dictation configure|disable` can run
    // beside a live daemon; the next page reload must receive the corresponding CSP without a
    // daemon restart. This check is filesystem-only and never probes the provider.
    const csp = spaCspHeaders(ctx.classFPort, ctx.dictationRegistry?.enabledConnectOrigins() ?? []);
    try {
      const url = new URL(req.url);

      // Host check runs first, unconditionally, before route lookup even knows a route class
      // exists (A3 §4 Rule 1). Not one of the allowlisted literals → 400, closed, no body — never 403.
      //
      // Skipped on the socket: the allowlist's job is to make a rebound DNS name arrive with its
      // own name in `Host` and be refused (A3 §4's rebinding note), and there is no name, no
      // resolver and no browser on this transport. Enforcing it here would only require every
      // local client to send a `Host` naming a TCP port it does not use.
      if (!overSocket && !checkHost(req, ctx.port, SPA_HOSTNAMES)) return new Response(null, { status: 400 });

      const route = matchApiRoute(ctx, req, url.pathname);
      if (!route) {
        // A foreign Origin is rejected even on a route that doesn't exist (A1 §1 "Origin
        // allowlisted first, regardless of route") — otherwise 403-on-real-route vs
        // 404-on-fake-route is a route-enumeration side channel for a hostile page (A3 §4).
        if (!overSocket && isForeignOrigin(req, ctx.port)) {
          return withHeaders(problem(403, "invalid-origin", "origin not allowed", undefined, url.pathname), csp);
        }
        return withHeaders(problem(404, "not-found", "no such route", undefined, url.pathname), csp);
      }

      const authSnapshot = tokenSnapshot(ctx.token);
      const authResult = authorizeRequest(req, {
        routeClass: route.routeClass,
        port: ctx.port,
        token: authSnapshot.token,
        transport,
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
      if (!checkHost(req, ctx.port, [CLASSF_HOSTNAME])) return new Response(null, { status: 400 });

      // Refresh before capability lookup. TokenAuthority's generation subscriber clears the
      // shared store, so a rotate/revoke invalidates already-minted iframe URLs too.
      ctx.tokenSource?.current();

      const url = new URL(req.url);
      const routeMatch = url.pathname.match(/^\/doc\/([^/]+)\/(.+)$/);
      if (!routeMatch) return withHeaders(new Response("not found", { status: 404 }), csp);
      const token = routeMatch[1] as string;
      // issue #337: decode exactly once before serveClassFDocument confines — a malformed
      // escape is this listener's existing plain 404, never a thrown URIError.
      const decoded = decodePathCapture(routeMatch[2] as string);
      if (!decoded.ok) return withHeaders(new Response("not found", { status: 404 }), csp);

      const res = serveClassFDocument(ctx.capabilityStore, token, decoded.path);
      if (!res) return withHeaders(new Response("not found", { status: 404 }), csp);
      return withHeaders(res, csp);
    } catch {
      return internalErrorResponse(csp);
    }
  };
}

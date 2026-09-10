// SPDX-License-Identifier: Apache-2.0
// @glosa/cli — P5.1: the broader daemon-facing client the non-hook CLI surface (open/resolve/
// apply-begin/request-review/status) calls into. Same shape convention as daemon-client.ts's
// `DaemonHookClient` (an interface + one real HTTP-backed implementation) — every command handler
// depends on the INTERFACE, never on `fetch`/`ensureDaemon` directly, which is what makes each
// command testable with an in-memory fake (mirrors hook.test.ts's `FakeDaemonClient` convention)
// instead of a live daemon subprocess. Kept as a SEPARATE client from `daemon-client.ts`'s
// `DaemonHookClient` rather than folded into it: that one is deliberately minimal (exactly the
// four hook-facing routes), and every hook handler's test only ever needs to fake those four —
// widening that interface would mean every hook test's fake grows methods it never calls.

import type { WorkspaceMetadataDescriptor } from "../../daemon/src/adapters/workspace-metadata.ts";
import type { DeliverableEntry } from "../../daemon/src/agent-provider/interface.ts";
import { ensureDaemon, glosaHome, loadToken } from "../../daemon/src/index.ts";

export interface ApiProblem {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  instance?: string;
  [key: string]: unknown;
}

export interface ApiError extends Error {
  code: "API_ERROR";
  status: number;
  problem: ApiProblem | null;
}

function isApiError(err: unknown): err is ApiError {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "API_ERROR";
}

export function apiError(status: number, problem: ApiProblem | null): ApiError {
  const err = new Error(problem?.title ?? `glosa daemon request failed with status ${status}`) as ApiError;
  err.code = "API_ERROR";
  err.status = status;
  err.problem = problem;
  return err;
}

export interface DaemonUnreachableError extends Error {
  code: "DAEMON_UNREACHABLE";
}

function unreachableError(reason: string): DaemonUnreachableError {
  const err = new Error(`glosa daemon unreachable: ${reason}`) as DaemonUnreachableError;
  err.code = "DAEMON_UNREACHABLE";
  return err;
}

export interface WorkspaceStatusSummary {
  slug: string;
  path: string;
  last_seen: string;
  pending_count: number;
  has_attention: boolean;
  wiring?: "live" | "wired" | "unwired";
  /** Additive (issue #142): journal entries with no inbox payload — optional for N-1 daemon
   * compatibility. `doctor`'s `orphaned-entries` check reads this. */
  orphaned_entry_count?: number;
  /** Additive (issue #156): present only for a workspace whose `glosa forget` deletion is durably
   * committed — possibly mid-resume after a crash. `doctor`'s `workspace` check reads this so an
   * interrupted deletion reads as "resume with `glosa forget <slug> --yes`", not as a plain
   * not-yet-opened workspace. */
  lifecycle?: "forgetting";
  /** Additive in contract 1.5; optional for N-1 daemon compatibility. */
  connect?: {
    providers: Array<{ provider: string; display_name: string; instruction: string }>;
    cli_fallback: string;
  };
}

export interface SessionStatusSummary {
  source?: string;
  lease_expiry?: string;
  session_id: string;
  provider: string;
  cwd: string;
  workspace_binding: string | null;
  last_active_at: string;
  liveness: "alive" | "stale";
}

export interface OrphanedStateSummary {
  registration_id: string;
  pending_count: number;
}

export interface StatusSummary {
  daemon: {
    instance_id: string;
    pid: number;
    started_at: string;
    protocol_version: string;
    contract_version: string;
    build_id: string;
  };
  workspaces: WorkspaceStatusSummary[];
  sessions: SessionStatusSummary[];
  /** Additive (issue #79): home-state buses with pending entries and no live registration.
   * Optional so this client keeps accepting N-1 daemons that predate the field. */
  orphaned_state?: OrphanedStateSummary[];
}

export interface StandardAttentionVerdict {
  outcome: "done" | "approved" | "changes_requested";
  response?: string;
}

export interface ApprovalVerdict {
  outcome: "approved";
  target_path: string;
  revision_id: string;
  completed_at: string;
}

export type AttentionVerdict = StandardAttentionVerdict | ApprovalVerdict;

export interface EntryStatus {
  id: string;
  kind: string;
  status: string;
  detail: AttentionVerdict | null;
}

export interface ResolveResult {
  entry: string;
  status: string;
  to: string;
  lease_id?: string;
  post_sha?: string;
}

/** `glosa inbox dismiss <id>`'s daemon-side result (issue #142) — always `to: "dismissed"`, no
 * lease fields, since `dismissEntry` opens and closes none. */
export interface DismissResult {
  entry: string;
  status: string;
  to: string;
}

export interface ApplyBeginResult {
  entry: string;
  lease_id: string;
  pre_sha: string;
}

export interface AttentionRequestResult {
  id: string;
  slug: string;
  status: string;
}

export interface InboxPresentationResult {
  presentation: DeliverableEntry;
}

export interface InboxListEntry {
  id: string;
  kind: string;
  status: string;
  /** Raw ISO from the journal fold — a formatted age is the human renderer's job, not the wire
   * shape's (`inbox.ts`'s D6). `null` only if the daemon predates this field entirely. */
  created_at: string | null;
  /** `null` for every entry kind that never records one today (an `entry_adopted` entry never
   * carries one at all) — never backfilled from the payload. */
  target_path: string | null;
  /** `false` marks a row whose inbox `.json` is gone (hand-removed, or otherwise lost) — the row
   * is still listed, never dropped, which is the entire point of issue #142. */
  payload_present: boolean;
}

export interface InboxListResult {
  entries: InboxListEntry[];
}

export type ResolveOutcome = "applied" | "rejected" | "deferred" | "stale";

/** `glosa forget <slug>`'s daemon-side blockers (issue #156) — a live bound session, an
 * unexpired apply lease, or an in-progress adoption, named individually so the CLI can print
 * exactly what is blocking. */
export type ForgetBlocker =
  | { kind: "live-session"; session_id: string }
  | { kind: "apply-lease"; lease_id: string; expires_at: string }
  | { kind: "adopting" };

export interface ForgetBusEntry {
  registration_id: string;
  slug: string;
  canonical_path: string;
  kind: "directory" | "loose-file";
  bus_path: string;
}

/** `confirm:false` (preview) always returns `would_remove`; `confirm:true` (execute/resume)
 * always returns `removed` — the two members are mutually exclusive, matching the daemon's
 * `POST /api/workspaces/forget` response shape (http.ts's `handleWorkspaceForget`). `slug` always
 * names the resolved TARGET; `requested_slug` is present only when the caller named a sealed
 * adopted source instead — that source is never an independent provenance unit (issue #156
 * revised approach), so the daemon reports what it actually acted on. */
export type ForgetWorkspaceResult =
  | {
      slug: string;
      requested_slug?: string;
      confirmed: false;
      would_remove: ForgetBusEntry[];
      /** Held-review addition: a deterministic digest of `would_remove`, echoed back as
       * `memberFingerprint` on the matching `confirm:true` call so the daemon can refuse a stale
       * confirmation (an adoption completed the member set between preview and confirm) rather
       * than silently deleting a different set than the one previewed. */
      member_fingerprint: string;
    }
  | { slug: string; requested_slug?: string; confirmed: true; removed: ForgetBusEntry[] };

/** The interface every P5.1 command depends on. `port` is exposed (rather than kept private)
 * because `glosa open` needs it to build the `http://127.0.0.1:<port>/#t=<token>` pairing URL —
 * without this, `runOpen` would have to re-run `ensureDaemon()` itself just to rediscover a port
 * this client already resolved a moment earlier. */
export interface OpenWorkspaceResult {
  slug: string;
  path: string;
  focus?: string;
  kind?: "directory" | "loose-file";
  /** Absolute redirected state directory when the registration stores its bus under GLOSA_HOME. */
  state_dir?: string;
}

export interface OpenWorkspaceOptions {
  externalState?: boolean;
  focus?: string;
  /** Select the first path in the daemon's normalized tracked-artifact order. */
  focusFirst?: boolean;
  /** Fail when `focusFirst` cannot select a tracked artifact. */
  requireFocus?: boolean;
}

export interface GlosaApiClient {
  readonly port: number;
  openWorkspace(path: string, opts?: OpenWorkspaceOptions): Promise<OpenWorkspaceResult>;
  resolveEntry(
    path: string,
    entry: string,
    outcome: ResolveOutcome,
    session: string,
    note?: string,
  ): Promise<ResolveResult>;
  /** `glosa inbox dismiss <id>`'s daemon-side call (issue #142) — a human terminal transition with
   * no session and no lease. See `resolveEntry`'s path-addressed POST shape, which this mirrors. */
  dismissEntry(path: string, entry: string, note?: string): Promise<DismissResult>;
  applyBegin(path: string, entry: string, session: string): Promise<ApplyBeginResult>;
  createAttentionRequest(
    path: string,
    opts: {
      message?: string;
      action?: string;
      targetPath?: string;
      approvalMode?: boolean;
      agentLabel?: string;
      target?: { quote: { exact: string; prefix?: string; suffix?: string } };
      answerOptions?: string[];
    },
  ): Promise<AttentionRequestResult>;
  /** `waitMs > 0` holds the request open until the entry goes terminal or the wait elapses — one
   * blocked request rather than a poll loop. Omit it for the immediate read. */
  getEntryStatus(path: string, entry: string, waitMs?: number): Promise<EntryStatus | null>;
  /** `glosa inbox list`'s daemon-side call (issue #142) — journal-derived, so it works on an
   * entry whose inbox payload is gone. `opts.all` includes terminal entries; the default omits
   * them. */
  listInboxEntries(path: string, opts?: { all?: boolean }): Promise<InboxListResult>;
  getInboxPresentation(path: string, entry: string, cursor?: string): Promise<InboxPresentationResult>;
  getStatus(): Promise<StatusSummary>;
  setMetadata?(
    path: string,
    metadata: WorkspaceMetadataDescriptor,
  ): Promise<{ metadata: WorkspaceMetadataDescriptor; replaced: boolean }>;
  getMetadata?(path: string): Promise<WorkspaceMetadataDescriptor | null>;
  clearMetadata?(path: string): Promise<{ cleared: boolean }>;
  bindSession?(
    path: string,
    sessionId: string,
    metadata?: { provider?: string; cwd?: string; source?: string },
  ): Promise<{ bound: true; session_id: string }>;
  /** Mint a short-TTL single-use presentation token for MCP/present URLs (`p=`). */
  mintPresentationToken?(): Promise<{ token: string; expires_in_s: number }>;
  /** `glosa forget <slug>`'s daemon-side call (issue #156). Addressed by SLUG, not `path` — the
   * whole point is that it must still work once a workspace's on-disk path is gone. `confirm`
   * defaults to `false`: a pure preview that performs the exact same preflight but never marks,
   * deletes, or removes anything. Throws an `ApiError` with `problem.type` ending in
   * `forget-blocked` (409) when a live bound session or an unexpired apply lease blocks deletion —
   * `problem.blockers` names each one. */
  forgetWorkspace(
    slug: string,
    opts?: {
      confirm?: boolean;
      /** Echoes a prior preview's `member_fingerprint` back on the matching `confirm:true` call
       * — see `ForgetWorkspaceResult`'s own docstring. Throws an `ApiError` with `problem.type`
       * ending in `forget-stale-preview` (409) when the member set has changed since. */
      memberFingerprint?: string;
    },
  ): Promise<ForgetWorkspaceResult>;
}

/** The real `GlosaApiClient` — `ensureDaemon()` once per construction (find-or-spawn, R1), then an
 * authed `fetch` against the `/api/workspaces/...` and `/api/status` surface (http.ts's P5.1
 * additions). Every call sets `Origin` to the daemon's own self-origin, same as
 * `daemon-client.ts`'s `createHttpDaemonClient` — these are trusted local-process calls, not
 * browser requests, but the state-changing route class still requires it (A3 §4). */
export interface HttpGlosaClientOptions {
  /**
   * Bound into every request this client instance makes, issue #140's shutdown owner —
   * including `getEntryStatus`'s long poll (`glosa_ask`, up to 600s). Normal callers omit it:
   * ordinary request semantics are unbounded and unchanged, since the signal never fires until
   * its owner aborts it.
   */
  signal?: AbortSignal;
}

export async function createHttpGlosaClient(options: HttpGlosaClientOptions = {}): Promise<GlosaApiClient> {
  const conn = await ensureDaemon();
  if (!conn.ok) {
    throw unreachableError(
      conn.logPath && !conn.reason.includes(conn.logPath) ? `${conn.reason} — see ${conn.logPath}` : conn.reason,
    );
  }
  const port = conn.port;
  const base = `http://127.0.0.1:${port}`;
  const shutdownSignal = options.signal;

  async function call(method: string, path: string, body?: unknown): Promise<Response> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: base,
        // Resolved per request, not captured when the client was built — the same reason as
        // `daemon-client.ts`. This client is reused across a whole tool call: `glosa_ask` holds it
        // through the attention request and every held-status poll, which can span minutes. A
        // rotation in that window turned the next poll into a 401 that `glosa_ask` treats as
        // transient and retries until it reports `unanswered`, with a healthy daemon and a real
        // human answer waiting on the other side.
        Authorization: `Bearer ${loadToken(glosaHome())}`,
        "Content-Type": "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      ...(shutdownSignal ? { signal: shutdownSignal } : {}),
    });
    if (!res.ok) {
      let problem: ApiProblem | null = null;
      try {
        problem = (await res.json()) as ApiProblem;
      } catch {
        // no body, or not JSON — ApiError tolerates a null problem
      }
      throw apiError(res.status, problem);
    }
    return res;
  }

  async function openWorkspace(path: string, opts: OpenWorkspaceOptions = {}): Promise<OpenWorkspaceResult> {
    return (
      await call("POST", "/api/workspaces/open", {
        path,
        ...(opts.externalState ? { external_state: true } : {}),
        ...(opts.focus ? { focus: opts.focus } : {}),
        ...(opts.focusFirst ? { focus_first: true } : {}),
        ...(opts.requireFocus ? { require_focus: true } : {}),
      })
    ).json();
  }

  return {
    port,
    openWorkspace,
    async resolveEntry(path, entry, outcome, session, note) {
      return (
        await call("POST", "/api/workspaces/resolve", {
          path,
          entry,
          outcome,
          session,
          ...(note !== undefined ? { note } : {}),
        })
      ).json();
    },
    async dismissEntry(path, entry, note) {
      return (
        await call("POST", "/api/workspaces/inbox/dismiss", {
          path,
          entry,
          ...(note !== undefined ? { note } : {}),
        })
      ).json();
    },
    async applyBegin(path, entry, session) {
      return (await call("POST", "/api/workspaces/apply-begin", { path, entry, session })).json();
    },
    async createAttentionRequest(path, opts) {
      return (
        await call("POST", "/api/workspaces/attention-request", {
          path,
          ...(opts.message !== undefined ? { message: opts.message } : {}),
          ...(opts.action !== undefined ? { action: opts.action } : {}),
          ...(opts.targetPath !== undefined ? { target_path: opts.targetPath } : {}),
          ...(opts.approvalMode === true ? { approval_mode: true } : {}),
          ...(opts.agentLabel !== undefined ? { agent_label: opts.agentLabel } : {}),
          ...(opts.target !== undefined ? { target: opts.target } : {}),
          ...(opts.answerOptions !== undefined ? { answer_options: opts.answerOptions } : {}),
        })
      ).json();
    },
    async getEntryStatus(path, entry, waitMs) {
      const params: Record<string, string> = { path, entry };
      if (waitMs !== undefined && waitMs > 0) params.wait_ms = String(Math.floor(waitMs));
      const qs = new URLSearchParams(params).toString();
      try {
        return await (await call("GET", `/api/workspaces/entry-status?${qs}`)).json();
      } catch (err) {
        if (isApiError(err) && err.status === 404) return null;
        throw err;
      }
    },
    async listInboxEntries(path, opts = {}) {
      const params: Record<string, string> = { path };
      if (opts.all) params.all = "1";
      const qs = new URLSearchParams(params).toString();
      return (await call("GET", `/api/workspaces/inbox?${qs}`)).json();
    },
    async getInboxPresentation(path, entry, cursor) {
      const workspace = await openWorkspace(path);
      const suffix = cursor ? `?${new URLSearchParams({ cursor }).toString()}` : "";
      return (
        await call(
          "GET",
          `/w/${encodeURIComponent(workspace.slug)}/inbox/${encodeURIComponent(entry)}/presentation${suffix}`,
        )
      ).json();
    },
    async getStatus() {
      return (await call("GET", "/api/status")).json();
    },
    async setMetadata(path, metadata) {
      const workspace = await openWorkspace(path);
      return (await call("PUT", `/w/${encodeURIComponent(workspace.slug)}/metadata`, metadata)).json();
    },
    async getMetadata(path) {
      const workspace = await openWorkspace(path);
      try {
        const result = (await call("GET", `/w/${encodeURIComponent(workspace.slug)}/metadata`)).json() as Promise<{
          metadata: WorkspaceMetadataDescriptor;
        }>;
        return (await result).metadata;
      } catch (err) {
        if (isApiError(err) && err.status === 404) return null;
        throw err;
      }
    },
    async clearMetadata(path) {
      const workspace = await openWorkspace(path);
      return (await call("DELETE", `/w/${encodeURIComponent(workspace.slug)}/metadata`)).json();
    },
    async bindSession(path, sessionId, metadata) {
      const workspace = await openWorkspace(path);
      return (
        await call("POST", `/w/${encodeURIComponent(workspace.slug)}/session-binding`, {
          session_id: sessionId,
          ...metadata,
        })
      ).json();
    },
    async mintPresentationToken() {
      return (await call("POST", "/api/presentation-token/mint", {})).json();
    },
    async forgetWorkspace(slug, opts = {}) {
      return (
        await call("POST", "/api/workspaces/forget", {
          slug,
          ...(opts.confirm ? { confirm: true } : {}),
          ...(opts.memberFingerprint !== undefined ? { member_fingerprint: opts.memberFingerprint } : {}),
        })
      ).json();
    },
  };
}

export { isApiError };

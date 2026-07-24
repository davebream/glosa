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

function apiError(status: number, problem: ApiProblem | null): ApiError {
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
}

export interface SessionStatusSummary {
  session_id: string;
  provider: string;
  cwd: string;
  workspace_binding: string | null;
  last_active_at: string;
  liveness: "alive" | "stale";
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

export type ResolveOutcome = "applied" | "rejected" | "deferred" | "stale";

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
  applyBegin(path: string, entry: string, session: string): Promise<ApplyBeginResult>;
  createAttentionRequest(
    path: string,
    opts: { message?: string; action?: string; targetPath?: string; approvalMode?: boolean },
  ): Promise<AttentionRequestResult>;
  getEntryStatus(path: string, entry: string): Promise<EntryStatus | null>;
  getInboxPresentation(path: string, entry: string, cursor?: string): Promise<InboxPresentationResult>;
  getStatus(): Promise<StatusSummary>;
  setMetadata?(
    path: string,
    metadata: WorkspaceMetadataDescriptor,
  ): Promise<{ metadata: WorkspaceMetadataDescriptor; replaced: boolean }>;
  getMetadata?(path: string): Promise<WorkspaceMetadataDescriptor | null>;
  clearMetadata?(path: string): Promise<{ cleared: boolean }>;
  bindSession?(path: string, sessionId: string): Promise<{ bound: true; session_id: string }>;
  /** Mint a short-TTL single-use presentation token for MCP/present URLs (`p=`). */
  mintPresentationToken?(): Promise<{ token: string; expires_in_s: number }>;
}

/** The real `GlosaApiClient` — `ensureDaemon()` once per construction (find-or-spawn, R1), then an
 * authed `fetch` against the `/api/workspaces/...` and `/api/status` surface (http.ts's P5.1
 * additions). Every call sets `Origin` to the daemon's own self-origin, same as
 * `daemon-client.ts`'s `createHttpDaemonClient` — these are trusted local-process calls, not
 * browser requests, but the state-changing route class still requires it (A3 §4). */
export async function createHttpGlosaClient(): Promise<GlosaApiClient> {
  const conn = await ensureDaemon();
  if (!conn.ok) throw unreachableError(conn.reason);
  const port = conn.port;
  const token = loadToken(glosaHome());
  const base = `http://127.0.0.1:${port}`;

  async function call(method: string, path: string, body?: unknown): Promise<Response> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: base,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
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
        })
      ).json();
    },
    async getEntryStatus(path, entry) {
      const qs = new URLSearchParams({ path, entry }).toString();
      try {
        return await (await call("GET", `/api/workspaces/entry-status?${qs}`)).json();
      } catch (err) {
        if (isApiError(err) && err.status === 404) return null;
        throw err;
      }
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
    async bindSession(path, sessionId) {
      const workspace = await openWorkspace(path);
      return (
        await call("POST", `/w/${encodeURIComponent(workspace.slug)}/session-binding`, { session_id: sessionId })
      ).json();
    },
    async mintPresentationToken() {
      return (await call("POST", "/api/presentation-token/mint", {})).json();
    },
  };
}

export { isApiError };

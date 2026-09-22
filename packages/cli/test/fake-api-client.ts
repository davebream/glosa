// SPDX-License-Identifier: Apache-2.0
// Shared in-memory `GlosaApiClient` fake — mirrors mcp.test.ts's `FakeDaemonClient` convention:
// records every call so a test can assert exactly what a command asked the daemon to do, and lets
// a test script canned responses/throws without a real daemon process anywhere in the loop.
import type {
  ApplyBeginResult,
  AttentionRequestResult,
  ClaimResult,
  DismissResult,
  EntryStatus,
  ForgetWorkspaceResult,
  GlosaApiClient,
  InboxListResult,
  InboxPresentationResult,
  OpenWorkspaceResult,
  OpenWorkspaceOptions,
  ReleaseClaimResult,
  ResolveOutcome,
  ResolveResult,
  StatusSummary,
} from "../src/api-client.ts";

export class FakeGlosaApiClient implements GlosaApiClient {
  readonly port = 4646;
  calls: { method: string; args: unknown[] }[] = [];

  openWorkspaceResult: OpenWorkspaceResult = { slug: "ws-slug", path: "/tmp/ws" };
  resolveEntryImpl:
    | ((path: string, entry: string, outcome: ResolveOutcome, session: string, note?: string) => Promise<ResolveResult>)
    | null = null;
  applyBeginImpl: ((path: string, entry: string, session: string) => Promise<ApplyBeginResult>) | null = null;
  dismissEntryImpl: ((path: string, entry: string, note?: string) => Promise<DismissResult>) | null = null;
  claimImpl:
    | ((
        path: string,
        resources: string[],
        session: string,
        opts?: { mode?: "exclusive" | "presence" },
      ) => Promise<ClaimResult>)
    | null = null;
  releaseClaimImpl: ((path: string, claimId: string, session: string) => Promise<ReleaseClaimResult>) | null = null;
  attentionRequestResult: AttentionRequestResult = { id: "inb-1", slug: "ws-slug", status: "open" };
  entryStatusResult: EntryStatus | null = null;
  inboxListResult: InboxListResult = { entries: [] };
  inboxListImpl: ((path: string, opts?: { all?: boolean }) => Promise<InboxListResult>) | null = null;
  inboxPresentationResult: InboxPresentationResult | null = null;
  bindSessionResult: { bound: true; session_id: string } | null = null;
  bindSessionError: Error | null = null;
  mintPresentationTokenResult: { token: string; expires_in_s: number } = {
    token: "present-token-abc",
    expires_in_s: 60,
  };
  statusResult: StatusSummary = {
    daemon: {
      instance_id: "gl-fake",
      pid: 1,
      started_at: "2020-01-01T00:00:00.000Z",
      protocol_version: "1.0",
      contract_version: "1.0",
      build_id: "0.1.0-alpha.0-0123456789abcdef",
    },
    workspaces: [],
    sessions: [],
  };

  async openWorkspace(path: string, opts?: OpenWorkspaceOptions): Promise<OpenWorkspaceResult> {
    this.calls.push({ method: "openWorkspace", args: opts === undefined ? [path] : [path, opts] });
    return this.openWorkspaceResult;
  }

  async resolveEntry(
    path: string,
    entry: string,
    outcome: ResolveOutcome,
    session: string,
    note?: string,
  ): Promise<ResolveResult> {
    this.calls.push({ method: "resolveEntry", args: [path, entry, outcome, session, note] });
    if (this.resolveEntryImpl) return this.resolveEntryImpl(path, entry, outcome, session, note);
    return { entry, status: outcome, to: outcome };
  }

  async applyBegin(path: string, entry: string, session: string): Promise<ApplyBeginResult> {
    this.calls.push({ method: "applyBegin", args: [path, entry, session] });
    if (this.applyBeginImpl) return this.applyBeginImpl(path, entry, session);
    return { entry, lease_id: "lease-1", pre_sha: "abc123" };
  }

  async claim(
    path: string,
    resources: string[],
    session: string,
    opts?: { mode?: "exclusive" | "presence" },
  ): Promise<ClaimResult> {
    this.calls.push({ method: "claim", args: [path, resources, session, opts] });
    if (this.claimImpl) return this.claimImpl(path, resources, session, opts);
    return {
      claim_id: "claim-1",
      fence: 1,
      expires_at: "2026-09-22T12:15:00.000Z",
      paths: ["notes.md"],
      mode: opts?.mode ?? "exclusive",
      renewed: false,
    };
  }

  async releaseClaim(path: string, claimId: string, session: string): Promise<ReleaseClaimResult> {
    this.calls.push({ method: "releaseClaim", args: [path, claimId, session] });
    if (this.releaseClaimImpl) return this.releaseClaimImpl(path, claimId, session);
    return { claim_id: claimId, released: true };
  }

  async dismissEntry(path: string, entry: string, note?: string): Promise<DismissResult> {
    this.calls.push({ method: "dismissEntry", args: [path, entry, note] });
    if (this.dismissEntryImpl) return this.dismissEntryImpl(path, entry, note);
    return { entry, status: "dismissed", to: "dismissed" };
  }

  async createAttentionRequest(
    path: string,
    opts: { message?: string; action?: string; targetPath?: string; approvalMode?: boolean },
  ): Promise<AttentionRequestResult> {
    this.calls.push({ method: "createAttentionRequest", args: [path, opts] });
    return this.attentionRequestResult;
  }

  async getEntryStatus(
    path: string,
    entry: string,
    waitMs?: number,
    signal?: AbortSignal,
  ): Promise<EntryStatus | null> {
    this.calls.push({ method: "getEntryStatus", args: [path, entry, waitMs, signal] });
    if (this.getEntryStatusImpl) return this.getEntryStatusImpl(path, entry, waitMs, signal);
    return this.entryStatusResult;
  }

  getEntryStatusImpl:
    | ((path: string, entry: string, waitMs?: number, signal?: AbortSignal) => Promise<EntryStatus | null>)
    | null = null;

  withdrawAttentionResult = { status: "expired", withdrawn: true };

  async withdrawAttention(
    path: string,
    entry: string,
    session: string,
  ): Promise<{ id: string; status: string; withdrawn: boolean }> {
    this.calls.push({ method: "withdrawAttention", args: [path, entry, session] });
    return { id: entry, ...this.withdrawAttentionResult };
  }

  async listInboxEntries(path: string, opts?: { all?: boolean }): Promise<InboxListResult> {
    this.calls.push({ method: "listInboxEntries", args: opts === undefined ? [path] : [path, opts] });
    if (this.inboxListImpl) return this.inboxListImpl(path, opts);
    return this.inboxListResult;
  }

  async getInboxPresentation(path: string, entry: string, cursor?: string): Promise<InboxPresentationResult> {
    this.calls.push({ method: "getInboxPresentation", args: [path, entry, cursor] });
    if (!this.inboxPresentationResult) throw new Error("unexpected getInboxPresentation call");
    return this.inboxPresentationResult;
  }

  async getStatus(): Promise<StatusSummary> {
    this.calls.push({ method: "getStatus", args: [] });
    return this.statusResult;
  }

  async bindSession(path: string, sessionId: string): Promise<{ bound: true; session_id: string }> {
    this.calls.push({ method: "bindSession", args: [path, sessionId] });
    if (this.bindSessionError) throw this.bindSessionError;
    return this.bindSessionResult ?? { bound: true, session_id: sessionId };
  }

  async mintPresentationToken(): Promise<{ token: string; expires_in_s: number }> {
    this.calls.push({ method: "mintPresentationToken", args: [] });
    return this.mintPresentationTokenResult;
  }

  forgetWorkspaceImpl:
    | ((slug: string, opts?: { confirm?: boolean; memberFingerprint?: string }) => Promise<ForgetWorkspaceResult>)
    | null = null;
  forgetWorkspaceResult: ForgetWorkspaceResult = {
    slug: "ws-slug",
    confirmed: false,
    would_remove: [],
    member_fingerprint: "fake-fingerprint",
  };

  async forgetWorkspace(
    slug: string,
    opts?: { confirm?: boolean; memberFingerprint?: string },
  ): Promise<ForgetWorkspaceResult> {
    this.calls.push({ method: "forgetWorkspace", args: opts === undefined ? [slug] : [slug, opts] });
    if (this.forgetWorkspaceImpl) return this.forgetWorkspaceImpl(slug, opts);
    return this.forgetWorkspaceResult;
  }
}

export function apiError(
  status: number,
  problem: Record<string, unknown> | null = null,
): Error & { code: "API_ERROR"; status: number; problem: unknown } {
  const err = new Error(
    (problem?.title as string | undefined) ?? `glosa daemon request failed with status ${status}`,
  ) as Error & {
    code: "API_ERROR";
    status: number;
    problem: unknown;
  };
  err.code = "API_ERROR";
  err.status = status;
  err.problem = problem;
  return err;
}

export function daemonUnreachable(message = "no peer answered"): Error & { code: "DAEMON_UNREACHABLE" } {
  const err = new Error(`glosa daemon unreachable: ${message}`) as Error & { code: "DAEMON_UNREACHABLE" };
  err.code = "DAEMON_UNREACHABLE";
  return err;
}

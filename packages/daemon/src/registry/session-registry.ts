// SPDX-License-Identifier: Apache-2.0
// In-memory sessions recover through MCP activity or explicit binding after a daemon restart.
// The journal remains the durable delivery authority. All registration/activity mutations share
// one mutex; lease expiry is the sole liveness rule, independent of provider or process IDs.
import { AsyncMutex } from "../bus/mutex.ts";
import type { WorkspaceIndex } from "./workspace-index.ts";

export interface SessionRecord {
  session_id: string;
  provider: string;
  /** Explicit provider/adapter-supplied workspace association (canonical path). Authoritative
   * over `cwd` when present — R2 routing precedence's rung (1). */
  workspace_binding?: string;
  /** Canonical path. */
  cwd: string;
  transcript_path?: string;
  source: string;
  last_active_at: string;
  lease_expiry: string;
}

export type RegisterInput = Omit<SessionRecord, "last_active_at" | "lease_expiry"> &
  Partial<Pick<SessionRecord, "last_active_at" | "lease_expiry">> & { fallback_workspace_binding?: string };

export type Liveness = "alive" | "stale";

export interface SessionRegistryDeps {
  now?: () => Date;
  /** A2 §F08: 60-second lease refreshed by hooks, MCP activity, or an open connection. */
  leaseTtlMs?: number;
  index?: WorkspaceIndex;
  /** Injectable scheduler for deterministic connection/expiry tests. */
  scheduleRefresh?: (refresh: () => void, intervalMs: number) => () => void;
}

const DEFAULT_LEASE_TTL_MS = 60_000;

export class SessionRegistry {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly mutex = new AsyncMutex();
  private readonly now: () => Date;
  private readonly leaseTtlMs: number;
  private readonly index?: WorkspaceIndex;
  private readonly connections = new Map<string, Map<string, () => void>>();
  private readonly scheduleRefresh: NonNullable<SessionRegistryDeps["scheduleRefresh"]>;

  constructor(deps: SessionRegistryDeps = {}) {
    this.now = deps.now ?? (() => new Date());
    this.leaseTtlMs = deps.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    this.index = deps.index;
    this.scheduleRefresh =
      deps.scheduleRefresh ??
      ((refresh, intervalMs) => {
        const timer = setInterval(refresh, intervalMs);
        timer.unref?.();
        return () => clearInterval(timer);
      });
  }

  /** Merge under the same lock as binding: an MCP refresh cannot erase a hook's transcript
   * or a user's explicit binding. Publish only after workspace persistence succeeds. */
  register(input: RegisterInput): Promise<SessionRecord> {
    return this.mutex.runExclusive(() => this.upsert(input));
  }

  bind(
    sessionId: string,
    workspace: string,
    metadata: { provider?: string; cwd?: string; source?: string; transcript_path?: string } = {},
  ): Promise<SessionRecord> {
    return this.mutex.runExclusive(() =>
      this.upsert({
        session_id: sessionId,
        provider: metadata.provider ?? this.sessions.get(sessionId)?.provider ?? "mcp",
        cwd: metadata.cwd ?? this.sessions.get(sessionId)?.cwd ?? workspace,
        source: metadata.source ?? "manual",
        workspace_binding: workspace,
        transcript_path: metadata.transcript_path,
      }),
    );
  }

  private async upsert(input: RegisterInput): Promise<SessionRecord> {
    const prior = this.sessions.get(input.session_id);
    if (prior && prior.provider !== "mcp" && input.provider !== "mcp" && prior.provider !== input.provider) {
      throw new SessionProviderConflict();
    }
    const now = this.now();
    const record: SessionRecord = {
      ...prior,
      ...Object.fromEntries(
        Object.entries(input).filter(([key, value]) => value !== undefined && key !== "fallback_workspace_binding"),
      ),
      session_id: input.session_id,
      provider: prior && input.provider === "mcp" ? prior.provider : input.provider,
      cwd: input.cwd,
      workspace_binding: input.workspace_binding ?? prior?.workspace_binding ?? input.fallback_workspace_binding,
      source: input.source,
      last_active_at: input.last_active_at ?? now.toISOString(),
      lease_expiry: input.lease_expiry ?? new Date(now.getTime() + this.leaseTtlMs).toISOString(),
    };
    await this.index?.upsertWorkspace(record.workspace_binding ?? record.cwd, "session");
    this.sessions.set(record.session_id, record);
    return record;
  }

  /** Returns false for an unknown identity, allowing a client to recover registration. */
  heartbeat(sessionId: string): Promise<boolean> {
    return this.mutex.runExclusive(() => this.refresh(sessionId));
  }

  private refresh(sessionId: string): boolean {
    const record = this.sessions.get(sessionId);
    if (!record) return false;
    const now = this.now();
    record.last_active_at = now.toISOString();
    record.lease_expiry = new Date(now.getTime() + this.leaseTtlMs).toISOString();
    return true;
  }

  /** A transport owns one handle per connection key. Replacing it invalidates the old timer;
   * closing it leaves the last refreshed lease to expire naturally. Future providers use this
   * same handle while their local subscription is open. */
  holdConnection(sessionId: string, key = "push"): () => void {
    if (!this.sessions.has(sessionId)) throw new Error("session not registered");
    this.connections.get(sessionId)?.get(key)?.();
    const handles = this.connections.get(sessionId) ?? new Map<string, () => void>();
    this.connections.set(sessionId, handles);
    let cancel = () => {};
    const release = () => {
      cancel();
      if (handles.get(key) !== release) return;
      handles.delete(key);
      if (handles.size === 0 && this.connections.get(sessionId) === handles) this.connections.delete(sessionId);
    };
    handles.set(key, release);
    const refresh = () => {
      void this.mutex.runExclusive(() => {
        if (this.connections.get(sessionId)?.get(key) === release) this.refresh(sessionId);
      });
    };
    cancel = this.scheduleRefresh(refresh, Math.min(20_000, this.leaseTtlMs / 3));
    refresh();
    return release;
  }

  /** Lease-based liveness ONLY (see module docstring — never PID-based). An unregistered/unknown
   * session_id is "stale": there is nothing to be alive. */
  liveness(sessionId: string): Liveness {
    const record = this.sessions.get(sessionId);
    if (!record) return "stale";
    return this.now().getTime() < new Date(record.lease_expiry).getTime() ? "alive" : "stale";
  }

  get(sessionId: string): SessionRecord | null {
    return this.sessions.get(sessionId) ?? null;
  }

  /** P5.1 — every currently-registered session record, for `glosa status`'s aggregate view.
   * Read-only snapshot (a fresh array each call); liveness isn't included here — call
   * `liveness(session_id)` per record, same as every other consumer of this registry. */
  list(): SessionRecord[] {
    return [...this.sessions.values()];
  }

  deregister(sessionId: string): Promise<void> {
    return this.mutex.runExclusive(() => {
      for (const release of this.connections.get(sessionId)?.values() ?? []) release();
      this.sessions.delete(sessionId);
    });
  }

  /** Exact explicit bindings only. Conversation composition uses this stricter view and never
   * falls back to cwd ancestry. `includeStale` exists so the API can distinguish "not bound"
   * from "bound session needs to be resumed" without treating a stale record as routable. */
  explicitlyBoundForWorkspace(canonicalWorkspace: string, opts: { includeStale?: boolean } = {}): SessionRecord[] {
    return [...this.sessions.values()].filter(
      (record) =>
        record.workspace_binding === canonicalWorkspace &&
        (opts.includeStale === true || this.liveness(record.session_id) === "alive"),
    );
  }

  /** Live sessions (per `liveness()`) that route to `canonicalWorkspace`, honoring R2's
   * precedence: rung (1) any LIVE session with an explicit `workspace_binding` equal to this
   * path wins outright, full stop — if at least one exists, cwd-ancestor sessions are never even
   * considered. A session that has an explicit binding to some OTHER workspace is also excluded
   * from ever matching THIS workspace via its `cwd`: its binding says where it actually belongs,
   * so it doesn't leak into the generic fallback. Only when no explicit-binding session matches
   * does rung (2), the cwd-ancestor fallback, apply — and within that rung, only the NEAREST
   * (deepest) matching cwd(s) are candidates (A2 §F08 step 2): a session sitting at a repo root
   * shouldn't force a picker against a session opened directly in the relevant subdirectory. This
   * is candidate SCOPING, not guessing — R2's "never guess" still governs what happens once the
   * candidate set is narrowed (a single deepest match routes directly; several sessions sharing
   * that exact same deepest cwd still fall through to the caller's picker). Recency is deliberately
   * NOT used to break a tie — R2's "never guess" supersedes A2's recency auto-pick. */
  forWorkspace(canonicalWorkspace: string): SessionRecord[] {
    const alive = [...this.sessions.values()].filter((r) => this.liveness(r.session_id) === "alive");
    const explicit = alive.filter((r) => r.workspace_binding === canonicalWorkspace);
    if (explicit.length > 0) return explicit;

    const ancestorMatches = alive.filter((r) => !r.workspace_binding && isCwdAncestorOf(r.cwd, canonicalWorkspace));
    if (ancestorMatches.length === 0) return [];

    // Two different ancestor paths of the SAME workspace can never share a length — equal-length
    // prefixes of the same string are identical strings — so this max-by-length is unambiguous:
    // it always isolates exactly the deepest cwd (or several sessions that share it verbatim).
    const deepestLen = Math.max(...ancestorMatches.map((r) => r.cwd.length));
    return ancestorMatches.filter((r) => r.cwd.length === deepestLen);
  }
}

/** `cwd` is an ancestor of (or equal to) `workspace` — R2's generic fallback. Pure string
 * comparison over already-canonicalized paths, no filesystem access. A `cwd` of exactly `"/"` is
 * treated as degenerate, never as "an ancestor of everything" — a real session opened at the
 * filesystem root shouldn't out-scope every other workspace on the machine. */
export function isCwdAncestorOf(cwd: string, workspace: string): boolean {
  if (cwd === "/") return workspace === "/";
  if (cwd === workspace) return true;
  const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return workspace.startsWith(prefix);
}

export class SessionProviderConflict extends Error {
  constructor() {
    super("session already belongs to a different provider");
  }
}

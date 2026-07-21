// @glosa/daemon — the session registry (A2 §F08, R2). In-memory only: sessions re-register on
// every SessionStart, so a daemon restart simply rebuilds this from scratch as live agent
// sessions fire their next hook — no durability requirement here (unlike the journal or the
// workspace index, which ARE the truth for their domains).
//
// Every mutation is serialized behind ONE mutex so concurrent SessionStart hooks (the F08
// "registration race") never lose an entry, and a registration upserts the session's workspace
// into the shared `WorkspaceIndex` in the SAME critical section — the index's own mutex still
// does the actual file write, this just guarantees the two updates (in-memory record, on-disk
// workspace entry) always happen together, never interleaved by a second concurrent register().
//
// Liveness NEVER calls `process.kill`/`kill(pid, 0)`. SessionStart hook input has no documented
// PID (A2 §F08) — there is no process to check in the first place, so liveness here is lease +
// activity heartbeat only, full stop. (Contrast with registry/lockfile-fallback.ts, which
// legitimately uses `process.kill` — that's checking whether the OS process that wrote a lease
// FILE is still alive, an entirely different question with a real, documented PID to check.)
//
// Production wiring (once the HTTP layer exists) is three lines:
//   const index = new WorkspaceIndex();
//   const registry = new SessionRegistry({ index });
//   index.setLiveSessionPredicate((canonicalPath) => registry.forWorkspace(canonicalPath).length > 0);
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
  Partial<Pick<SessionRecord, "last_active_at" | "lease_expiry">>;

export type Liveness = "alive" | "stale";

export interface RegisterResult {
  record: SessionRecord;
  /** Canonical workspace paths that had a pending park — `routing.ts`'s `route()` calls
   * `markParked` when it finds no live session — and are now drained by THIS registration. The
   * parked inbox entries themselves live in the journal (P2.1/P2.3's concern); this is only the
   * "a session is now available for workspace X" signal the delivery layer re-attempts on. */
  drainedWorkspaces: string[];
}

export interface SessionRegistryDeps {
  now?: () => Date;
  /** A2 §F08: "auto-expires in 60s (heartbeat buffer); refreshed on each hook." */
  leaseTtlMs?: number;
  index?: WorkspaceIndex;
}

const DEFAULT_LEASE_TTL_MS = 60_000;

export class SessionRegistry {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly parkedWorkspaces = new Set<string>();
  private readonly mutex = new AsyncMutex();
  private readonly now: () => Date;
  private readonly leaseTtlMs: number;
  private readonly index?: WorkspaceIndex;

  constructor(deps: SessionRegistryDeps = {}) {
    this.now = deps.now ?? (() => new Date());
    this.leaseTtlMs = deps.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    this.index = deps.index;
  }

  /** Registers (or re-registers) a session. Concurrent calls for distinct session_ids all land —
   * this is the F08 race fix: the mutex means one register()'s workspace upsert always fully
   * completes (index write included) before the next one starts, so slug assignment and the
   * in-memory record never interleave. A repeat call for an already-known session_id just
   * replaces its record (e.g. a fresh SessionStart with an updated transcript_path). */
  register(input: RegisterInput): Promise<RegisterResult> {
    return this.mutex.runExclusive(async () => {
      const now = this.now();
      const record: SessionRecord = {
        ...input,
        last_active_at: input.last_active_at ?? now.toISOString(),
        lease_expiry: input.lease_expiry ?? new Date(now.getTime() + this.leaseTtlMs).toISOString(),
      };

      // Captured BEFORE the mutation, not reordered after the index await: the park/drain
      // ordering below still needs `this.sessions` mutated first. If the index upsert throws
      // (e.g. ENOSPC/EACCES in `persist()`), roll the in-memory map back to exactly what it held
      // before this call, so a failed registration never leaves a session routable for a
      // workspace `workspaces.json` never actually recorded.
      const priorRecord = this.sessions.get(record.session_id);
      this.sessions.set(record.session_id, record);

      const canonicalWorkspace = record.workspace_binding ?? record.cwd;
      if (this.index) {
        try {
          await this.index.upsertWorkspace(canonicalWorkspace, "session");
        } catch (err) {
          if (priorRecord) this.sessions.set(record.session_id, priorRecord);
          else this.sessions.delete(record.session_id);
          throw err;
        }
      }

      const drainedWorkspaces: string[] = [];
      if (this.parkedWorkspaces.has(canonicalWorkspace)) {
        this.parkedWorkspaces.delete(canonicalWorkspace);
        drainedWorkspaces.push(canonicalWorkspace);
      }

      return { record, drainedWorkspaces };
    });
  }

  /** Extends the lease and bumps `last_active_at` — called on every SessionStart/
   * UserPromptSubmit/Stop hook (A2 §F08). A heartbeat for an unknown session_id is a silent
   * no-op, never a throw: the session may have already deregistered (SessionEnd raced ahead of a
   * stray hook firing), and a heartbeat is advisory, not a state transition worth failing over. */
  heartbeat(sessionId: string): Promise<void> {
    return this.mutex.runExclusive(() => {
      const record = this.sessions.get(sessionId);
      if (!record) return;
      const now = this.now();
      record.last_active_at = now.toISOString();
      record.lease_expiry = new Date(now.getTime() + this.leaseTtlMs).toISOString();
    });
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
      this.sessions.delete(sessionId);
    });
  }

  // `markParked`/`isParked` touch `parkedWorkspaces` OUTSIDE `this.mutex` — `route()` (below and
  // in routing.ts) calls them directly, unserialized. That's only safe because every touch is
  // fully SYNCHRONOUS: JS run-to-completion guarantees a synchronous `Set.add`/`Set.has`/
  // `Set.delete` can never interleave with another one, mutex or not. If either of these, or
  // `route()` itself, ever grows an `await`, this safety argument breaks and `parkedWorkspaces`
  // would need its own lock (or a move under `this.mutex`) — do not add one without doing that.

  /** Marks a canonical workspace as having a pending park — called by `routing.ts`'s `route()`
   * when it finds no live session for that workspace (R2: "no live session -> the entry parks").
   * The next `register()` whose resolved workspace (workspace_binding ?? cwd) equals this exact
   * canonical path drains it. MUST stay synchronous — see the comment above. */
  markParked(canonicalWorkspace: string): void {
    this.parkedWorkspaces.add(canonicalWorkspace);
  }

  /** MUST stay synchronous — see the comment above `markParked`. */
  isParked(canonicalWorkspace: string): boolean {
    return this.parkedWorkspaces.has(canonicalWorkspace);
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
   * that exact same deepest cwd still fall through to `route()`'s picker). Recency is deliberately
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

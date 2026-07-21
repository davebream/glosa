// SPDX-License-Identifier: Apache-2.0
// @glosa/cli — the daemon-facing API `glosa hook <event>` calls into (A2 §F08/R2: "providers
// register live agent sessions via hooks → daemon API (never direct file writes)"). A thin
// interface + one real HTTP-backed implementation, so every hook handler in hook.ts depends on
// the INTERFACE, never on `fetch`/`ensureDaemon` directly — that's what makes the handlers
// testable with an in-memory fake instead of a live daemon subprocess.
import { ensureDaemon, glosaHome, loadToken } from "@glosa/daemon";

export interface RegisterSessionInput {
  session_id: string;
  provider: string;
  cwd: string;
  transcript_path?: string;
  source: string;
  workspace_binding?: string;
}

export interface RegisterSessionResult {
  workspace: string;
  drained_workspaces: string[];
}

export interface DrainedEntry {
  id: string;
  kind: string;
  status: string;
}

export interface DrainResult {
  drained: DrainedEntry[];
  count: number;
}

/** A5 §F23's turn-boundary/watcher `via` values — exactly the ones `POST /api/sessions/:id/drain`
 * accepts (never `channel`/`mcp_pull`, which have their own separate delivery paths). The caller
 * MUST say which hook is actually surfacing this drain right now — `deliver()`'s own proactive
 * `"gate"`/`"attempted"` queuing record (providers/interface.ts) is a SEPARATE, earlier event from
 * this route's `"presented"` confirmation once the drain genuinely happens. */
export type DrainVia = "gate" | "stop" | "userprompt" | "asyncRewake";

export interface DrainOptions {
  limit?: number;
  via?: DrainVia;
}

export interface DaemonHookClient {
  register(input: RegisterSessionInput): Promise<RegisterSessionResult>;
  heartbeat(sessionId: string): Promise<void>;
  deregister(sessionId: string): Promise<void>;
  drain(sessionId: string, opts?: DrainOptions): Promise<DrainResult>;
}

export interface DaemonUnreachableError extends Error {
  code: "DAEMON_UNREACHABLE";
}

function unreachableError(reason: string): DaemonUnreachableError {
  const err = new Error(`glosa daemon unreachable: ${reason}`) as DaemonUnreachableError;
  err.code = "DAEMON_UNREACHABLE";
  return err;
}

/** The real `DaemonHookClient` — `ensureDaemon()` (find-or-spawn, R1) once per call site, then an
 * authed `fetch` against the `/api/sessions/...` surface (http.ts's P4.3 additions). Every call
 * sets `Origin` to the daemon's own self-origin — these are trusted local-process calls, not
 * browser requests, but the state-changing route class still requires it (A3 §4). */
export async function createHttpDaemonClient(): Promise<DaemonHookClient> {
  const conn = await ensureDaemon();
  if (!conn.ok) throw unreachableError(conn.reason);
  const port = conn.port; // captured outside the closure below — narrowing doesn't cross into it
  const token = loadToken(glosaHome());
  const base = `http://127.0.0.1:${port}`;

  async function call(path: string, body?: unknown): Promise<Response> {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: base,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw unreachableError(`${path} -> HTTP ${res.status}`);
    return res;
  }

  return {
    async register(input) {
      return (await call("/api/sessions/register", input)).json();
    },
    async heartbeat(sessionId) {
      await call(`/api/sessions/${encodeURIComponent(sessionId)}/heartbeat`);
    },
    async deregister(sessionId) {
      await call(`/api/sessions/${encodeURIComponent(sessionId)}/deregister`);
    },
    async drain(sessionId, opts) {
      return (await call(`/api/sessions/${encodeURIComponent(sessionId)}/drain`, opts ?? {})).json();
    },
  };
}

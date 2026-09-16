// SPDX-License-Identifier: Apache-2.0
// @glosa/cli — the daemon-facing session-registration/drain API the MCP shim and Codex attachment
// call into (A2 §F08/R2: "providers register live agent sessions via push transports → daemon API
// (never direct file writes)"). A thin interface + one real HTTP-backed implementation, so every
// caller depends on the INTERFACE, never on `fetch`/`ensureDaemon` directly — that's what makes
// them testable with an in-memory fake instead of a live daemon subprocess.

import { apiError, type ApiProblem } from "./api-client.ts";
import type { DeliverableEntry } from "../../daemon/src/agent-provider/interface.ts";
import { ensureDaemon, glosaHome, loadToken } from "../../daemon/src/index.ts";

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
}

/** Contract 1.6 daemons always label the canonical workspace in structured data and visible text.
 * The field stays optional here because same-major N/N-1 clients may receive a 1.5 response. */
export type DrainedEntry = DeliverableEntry & { workspace?: string };

export interface DrainResult {
  delivery_id?: string | null;
  drained: DrainedEntry[];
  count: number;
  has_more?: boolean;
}

/** The one `via` `POST /api/sessions/:id/drain` accepts (A5 §F23): the route only ever surfaces an
 * MCP pull. The push transports (monitor, Codex app-server) have their own stream/ack routes.
 * `deliver()`'s own proactive `"mcp_pull"`/`"attempted"` queuing record
 * (agent-provider/interface.ts) is a SEPARATE, earlier event from this route's `"presented"`
 * confirmation once the pull genuinely happens. */
export type DrainVia = "mcp_pull";

export interface DrainOptions {
  limit?: number;
  via?: DrainVia;
  entryId?: string;
  cursor?: string;
}

/** Issue #205: the generic `glosa_inbox_pull` path's own operation. `workspace` is the scope the
 * pull was asked for — the daemon captures it once and uses it for the whole drain, immune to a
 * concurrent re-registration moving the session's row afterward (contract "shape B"). Deliberately
 * NOT a field on `DrainOptions`: an identified session's own drain must keep resolving scope from
 * its registry row, and giving it no way to even spell a scope is what makes that structural rather
 * than a convention every caller has to remember. */
export interface ScopedPullDrainOptions {
  workspace: string;
  limit?: number;
}

/** How `openSessionStream` ended (#206). `superseded`: the daemon's `event: superseded` frame
 * arrived — a replacement connection took the session; the caller must park, not reconnect.
 * `eof`: an ordinary close with no such frame (daemon shutdown, token revocation/rotation, client
 * cancel, send failure, or a network drop) — the caller's existing retry-with-backoff applies. */
export type SessionStreamEnd = { ended: "superseded" | "eof" };

/** #206: how long, after `onEntry` (or its transport acknowledgement) fails while the stream is
 * still open, `openSessionStream` keeps reading before giving up on seeing a `superseded` frame.
 * Replacement deletes the OLD connection's pending acknowledgement, so a failure right there is the
 * expected shape of a mid-delivery displacement, not a reason to reconnect and re-displace the new
 * owner — but an ordinary failure on a healthy connection must not hang forever either. *
 * 12 s, not the 2 s this shipped with (and deliberately not 15 s, which would collide with the
 * park-probe interval and make the two sleeps indistinguishable to a test). CI run 35039592341 saw a
 * displaced monitor deliver an entry only the owner should have had; its log proves that duplicate
 * delivery but records neither monitor's timeline nor how the stream end was classified, so this
 * race is the strongest explanation from the code rather than an observed one. Waiting longer costs nothing in the case this exists for —
 * replacement closes the stream immediately, so EOF ends the wait — and only delays surfacing a
 * genuine handling error on a stream that stays healthy. */
export const SESSION_STREAM_FAILURE_DEADLINE_MS = 12_000;

export interface DaemonClient {
  register(input: RegisterSessionInput): Promise<RegisterSessionResult>;
  heartbeat(sessionId: string): Promise<void>;
  deregister(sessionId: string): Promise<void>;
  drain(sessionId: string, opts?: DrainOptions): Promise<DrainResult>;
  /** The scoped counterpart `glosa_inbox_pull`'s generic path calls instead of `drain` above — see
   * `ScopedPullDrainOptions`. Raw construction of the `/api/sessions/:id/drain` route stays private
   * to this module either way; this is a second typed door onto the same route, not an escape from
   * the client abstraction (A7). */
  drainScoped(sessionId: string, opts: ScopedPullDrainOptions): Promise<DrainResult>;
  acknowledge?(sessionId: string, deliveryId: string, outcome: "presented" | "failed", error?: string): Promise<void>;
  acknowledgePushed?(sessionId: string, entryId: string, outcome: "presented" | "failed"): Promise<void>;
  acknowledgeStreamTransport?(sessionId: string, entryId: string): Promise<void>;
  openSessionStream?(
    sessionId: string,
    transport: "monitor" | "codex_app_server",
    onEntry: (entry: DrainedEntry) => Promise<void>,
    signal: AbortSignal,
    onOpen?: () => void,
  ): Promise<SessionStreamEnd>;
  /** `GET /api/sessions/:id/stream/status` (#206) — the parked client's ownership probe. Never
   * registers, heartbeats, or holds a lease; an unknown session id is a legitimate `connected:false`
   * answer, not an error. */
  sessionStreamStatus?(sessionId: string): Promise<{ connected: boolean; transport: string | null }>;
}

export interface DaemonUnreachableError extends Error {
  code: "DAEMON_UNREACHABLE";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}

export interface HttpDaemonClientOptions {
  ensureTimeoutMs?: number;
  fetch?: typeof fetch;
  /**
   * Bound into every POST this client instance makes (register/heartbeat/deregister/drain/
   * acknowledge*), issue #140's shutdown owner. Normal callers omit it: ordinary request
   * semantics are unbounded and unchanged, since the signal never fires until its owner aborts
   * it. `openSessionStream` is unaffected — it already takes its own dedicated signal.
   */
  signal?: AbortSignal;
}

function unreachableError(reason: string): DaemonUnreachableError {
  const err = new Error(`glosa daemon unreachable: ${reason}`) as DaemonUnreachableError;
  err.code = "DAEMON_UNREACHABLE";
  return err;
}

/** The real `DaemonClient` — `ensureDaemon()` (find-or-spawn, R1) once per call site, then an
 * authed `fetch` against the `/api/sessions/...` surface (http.ts's P4.3 additions). Every call
 * sets `Origin` to the daemon's own self-origin — these are trusted local-process calls, not
 * browser requests, but the state-changing route class still requires it (A3 §4). */
export async function createHttpDaemonClient(options: HttpDaemonClientOptions = {}): Promise<DaemonClient> {
  const conn = await ensureDaemon({ timeoutMs: options.ensureTimeoutMs });
  if (!conn.ok) {
    throw unreachableError(
      conn.logPath && !conn.reason.includes(conn.logPath) ? `${conn.reason} — see ${conn.logPath}` : conn.reason,
    );
  }
  const port = conn.port; // captured outside the closure below — narrowing doesn't cross into it
  const base = `http://127.0.0.1:${port}`;
  const fetchRequest = options.fetch ?? fetch;
  const shutdownSignal = options.signal;

  async function call(path: string, body?: unknown, method: "POST" | "GET" = "POST"): Promise<Response> {
    let res: Response;
    try {
      res = await fetchRequest(`${base}${path}`, {
        method,
        headers: {
          Host: `127.0.0.1:${port}`,
          Origin: base,
          // Resolved per request, not captured when the client was built. A client can outlive a
          // `glosa token rotate` — the shim's push-stream client is held for the whole session, and
          // a pending delivery acknowledgement uses the client that was current when its delivery
          // arrived — and the daemon accepts only the current credential, with no grace period.
          // Pinning it here turned the next call on any such client into a silent 401.
          Authorization: `Bearer ${loadToken(glosaHome())}`,
          ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
        },
        body: method === "POST" && body !== undefined ? JSON.stringify(body) : undefined,
        ...(shutdownSignal ? { signal: shutdownSignal } : {}),
      });
    } catch (error) {
      throw unreachableError((error as Error).message);
    }
    if (!res.ok) {
      const problem = (await res.json().catch(() => null)) as ApiProblem | null;
      throw apiError(res.status, problem);
    }
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
    async drainScoped(sessionId, opts) {
      return (
        await call(`/api/sessions/${encodeURIComponent(sessionId)}/drain`, {
          via: "mcp_pull",
          limit: opts.limit,
          scope: opts.workspace,
        })
      ).json();
    },
    async acknowledge(sessionId, deliveryId, outcome, error) {
      await call(`/api/sessions/${encodeURIComponent(sessionId)}/deliveries/${encodeURIComponent(deliveryId)}/ack`, {
        outcome,
        ...(error ? { error } : {}),
      });
    },
    async acknowledgePushed(sessionId, entryId, outcome) {
      await call(`/api/sessions/${encodeURIComponent(sessionId)}/stream/${encodeURIComponent(entryId)}/ack`, {
        outcome,
      });
    },
    async acknowledgeStreamTransport(sessionId, entryId) {
      await call(
        `/api/sessions/${encodeURIComponent(sessionId)}/stream/${encodeURIComponent(entryId)}/transport-ack`,
        {},
      );
    },
    async openSessionStream(sessionId, transport, onEntry, signal, onOpen) {
      const res = await fetchRequest(
        `${base}/api/sessions/${encodeURIComponent(sessionId)}/stream?transport=${encodeURIComponent(transport)}`,
        {
          headers: {
            Host: `127.0.0.1:${port}`,
            Origin: base,
            Authorization: `Bearer ${loadToken(glosaHome())}`,
          },
          signal,
        },
      );
      if (!res.ok) throw apiError(res.status, (await res.json().catch(() => null)) as ApiProblem | null);
      if (!res.body) throw new Error("session stream response has no body");
      onOpen?.();
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      let superseded = false;
      // #206: set once `onEntry` (or its caller's own transport acknowledgement, thrown back
      // through `onEntry`) fails while the stream is still open. Supersession takes precedence: a
      // replacement deletes the OLD connection's pending acknowledgement, so a failure right here is
      // the expected shape of a mid-delivery displacement — keep reading toward EOF instead of
      // surfacing it immediately, bounded so an ordinary failure still gets reported promptly.
      let failure: { error: unknown } | undefined;
      let deadlineAt = 0;
      while (!signal.aborted) {
        if (failure && Date.now() >= deadlineAt) throw failure.error;
        let done: boolean;
        let value: Uint8Array | undefined;
        if (failure) {
          const remaining = Math.max(0, deadlineAt - Date.now());
          const raced = await Promise.race([
            reader.read().then((r) => ({ timedOut: false as const, r })),
            sleep(remaining).then(() => ({ timedOut: true as const })),
          ]);
          if (raced.timedOut) throw failure.error;
          ({ done, value } = raced.r);
        } else {
          ({ done, value } = await reader.read());
        }
        if (done) {
          if (failure) {
            if (superseded) return { ended: "superseded" };
            throw failure.error;
          }
          return { ended: superseded ? "superseded" : "eof" };
        }
        buffered += decoder.decode(value, { stream: true });
        let boundary = buffered.indexOf("\n\n");
        while (boundary >= 0) {
          const frame = buffered.slice(0, boundary);
          buffered = buffered.slice(boundary + 2);
          boundary = buffered.indexOf("\n\n");
          const event = frame.match(/^event:\s*(.+)$/m)?.[1];
          if (event === "superseded") {
            superseded = true;
            continue;
          }
          if (event !== "delivery" || failure) continue;
          const data = frame.match(/^data:\s*(.+)$/m)?.[1];
          if (!data) continue;
          try {
            await onEntry(JSON.parse(data) as DrainedEntry);
          } catch (error) {
            failure = { error };
            deadlineAt = Date.now() + SESSION_STREAM_FAILURE_DEADLINE_MS;
          }
        }
      }
      return { ended: superseded ? "superseded" : "eof" };
    },
    async sessionStreamStatus(sessionId) {
      const res = await call(`/api/sessions/${encodeURIComponent(sessionId)}/stream/status`, undefined, "GET");
      return res.json();
    },
  };
}

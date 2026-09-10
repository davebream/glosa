// SPDX-License-Identifier: Apache-2.0
// @glosa/cli — the daemon-facing API `glosa hook <event>` calls into (A2 §F08/R2: "providers
// register live agent sessions via hooks → daemon API (never direct file writes)"). A thin
// interface + one real HTTP-backed implementation, so every hook handler in hook.ts depends on
// the INTERFACE, never on `fetch`/`ensureDaemon` directly — that's what makes the handlers
// testable with an in-memory fake instead of a live daemon subprocess.

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

/** A5 §F23's turn-boundary/watcher `via` values — exactly the ones `POST /api/sessions/:id/drain`
 * accepts (never `channel`/`mcp_pull`, which have their own separate delivery paths). The caller
 * MUST say which hook is actually surfacing this drain right now — `deliver()`'s own proactive
 * `"gate"`/`"attempted"` queuing record (agent-provider/interface.ts) is a SEPARATE, earlier event from
 * this route's `"presented"` confirmation once the drain genuinely happens. */
export type DrainVia = "gate" | "stop" | "userprompt" | "asyncRewake" | "mcp_pull";

export interface DrainOptions {
  limit?: number;
  via?: DrainVia;
  entryId?: string;
  cursor?: string;
}

export interface DaemonHookClient {
  register(input: RegisterSessionInput): Promise<RegisterSessionResult>;
  heartbeat(sessionId: string): Promise<void>;
  deregister(sessionId: string): Promise<void>;
  drain(sessionId: string, opts?: DrainOptions): Promise<DrainResult>;
  acknowledge?(sessionId: string, deliveryId: string, outcome: "presented" | "failed", error?: string): Promise<void>;
  acknowledgeConversation?(
    sessionId: string,
    messageId: string,
    outcome: "transport_accepted" | "presented" | "failed",
  ): Promise<void>;
  /**
   * `onOpen`, when given, fires once the stream response is actually established (headers
   * received, body readable) — before the first read, so a caller can measure genuine connected
   * time separately from daemon-discovery latency or a request that never gets a response at all.
   */
  openConversationPush?(
    sessionId: string,
    onEntry: (entry: DrainedEntry) => Promise<void>,
    signal: AbortSignal,
    onOpen?: () => void,
  ): Promise<void>;
}

export interface DaemonUnreachableError extends Error {
  code: "DAEMON_UNREACHABLE";
}

export interface HttpDaemonClientOptions {
  ensureTimeoutMs?: number;
  fetch?: typeof fetch;
  /**
   * Bound into every POST this client instance makes (register/heartbeat/deregister/drain/
   * acknowledge*), issue #140's shutdown owner. Normal callers omit it: ordinary request
   * semantics are unbounded and unchanged, since the signal never fires until its owner aborts
   * it. `openConversationPush` is unaffected — it already takes its own dedicated signal.
   */
  signal?: AbortSignal;
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
export async function createHttpDaemonClient(options: HttpDaemonClientOptions = {}): Promise<DaemonHookClient> {
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

  async function call(path: string, body?: unknown): Promise<Response> {
    let res: Response;
    try {
      res = await fetchRequest(`${base}${path}`, {
        method: "POST",
        headers: {
          Host: `127.0.0.1:${port}`,
          Origin: base,
          // Resolved per request, not captured when the client was built. A client can outlive a
          // `glosa token rotate` — the shim's push-stream client is held for the whole session, and
          // a pending delivery acknowledgement uses the client that was current when its delivery
          // arrived — and the daemon accepts only the current credential, with no grace period.
          // Pinning it here turned the next call on any such client into a silent 401.
          Authorization: `Bearer ${loadToken(glosaHome())}`,
          "Content-Type": "application/json",
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
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
    async acknowledge(sessionId, deliveryId, outcome, error) {
      await call(`/api/sessions/${encodeURIComponent(sessionId)}/deliveries/${encodeURIComponent(deliveryId)}/ack`, {
        outcome,
        ...(error ? { error } : {}),
      });
    },
    async acknowledgeConversation(sessionId, messageId, outcome) {
      await call(`/api/sessions/${encodeURIComponent(sessionId)}/conversation/${encodeURIComponent(messageId)}/ack`, {
        outcome,
      });
    },
    async openConversationPush(sessionId, onEntry, signal, onOpen) {
      const res = await fetchRequest(`${base}/api/sessions/${encodeURIComponent(sessionId)}/push-stream`, {
        headers: {
          Host: `127.0.0.1:${port}`,
          Origin: base,
          // Resolved when the stream is opened, for the same reason as `call` above. A push
          // stream is long-lived, but its credential is only checked at open.
          Authorization: `Bearer ${loadToken(glosaHome())}`,
        },
        signal,
      });
      if (!res.ok) throw apiError(res.status, (await res.json().catch(() => null)) as ApiProblem | null);
      if (!res.body) throw new Error("push-stream response has no body");
      onOpen?.();
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        let boundary = buffered.indexOf("\n\n");
        while (boundary >= 0) {
          const frame = buffered.slice(0, boundary);
          buffered = buffered.slice(boundary + 2);
          boundary = buffered.indexOf("\n\n");
          const event = frame.match(/^event:\s*(.+)$/m)?.[1];
          const data = frame.match(/^data:\s*(.+)$/m)?.[1];
          if (event !== "conversation_message" || !data) continue;
          await onEntry(JSON.parse(data) as DrainedEntry);
        }
      }
    },
  };
}

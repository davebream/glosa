// SPDX-License-Identifier: Apache-2.0
// @ts-check
// @glosa/spa — R6's ONE data-access module: the SPA reaches the daemon through this file and
// NOTHING else does (no other module calls `fetch` — see test/import-boundary.test.ts, which
// checks that structurally). This is the L0→L3 swappable-data-layer invariant: a future hosted
// shell only ever has to change what this one module does, never anything that calls it.
//
// Every request carries `Authorization: Bearer <sessionStorage.glosa_token>` (the token
// bootstrap.js's `scrubSecrets` already stashed there, P1.4) — same-origin `fetch`, nothing fancier,
// per R6's "same-origin fetch today" v1 scope.
const TOKEN_KEY = "glosa_token";

/** @typedef {{ title?: string, type?: string, status?: number, [key: string]: unknown }} ProblemDetails */
/** @typedef {Pick<Storage, "getItem" | "setItem" | "removeItem">} TokenStorage */
/** @typedef {(path: string, init: RequestInit) => Promise<Response>} FetchFn */
/** @typedef {{ id?: string, event: string, data: string }} SseFrame */
/** @typedef {{ event: string, data: unknown, id?: string }} StreamEvent */
/** @typedef {(frame: StreamEvent) => void} StreamEventHandler */
/** @typedef {(attempt: number, rand?: () => number) => number} BackoffFn */
/** @typedef {(ms: number) => Promise<unknown>} SleepFn */
/** @typedef {{
 *   fetchFn?: FetchFn,
 *   storage?: TokenStorage,
 *   onEvent?: StreamEventHandler,
 *   onReconnect?: () => void,
 *   onStatus?: (status: "down" | "up") => unknown,
 *   onUnauthorized?: () => unknown,
 *   backoffFn?: BackoffFn,
 *   sleepFn?: SleepFn,
 *   randFn?: () => number,
 * }} StreamOptions */
/** @typedef {StreamOptions & { slug: string }} OpenStreamOptions */
/** @typedef {{ contract_version?: unknown, paired?: boolean, install_id?: unknown }} Handshake */
/** @typedef {{
 *   fetchFn?: FetchFn,
 *   storage?: TokenStorage,
 *   onUnauthorized?: () => void,
 *   expectedInstallId?: string | null,
 *   onForeignDaemon?: () => void,
 * }} DataAccessDeps */
/** @typedef {{ method?: string, headers?: Record<string, string>, body?: string }} RequestOptions */

/** Thrown by every data-access call that gets a non-2xx response. Carries the parsed
 * problem+json body (A1 §1) when the daemon sent one, so a caller can branch on `.status`/
 * `.problem.type` without re-parsing anything itself. */
export class DataAccessError extends Error {
  /** @param {number} status @param {ProblemDetails | null | undefined} problem */
  constructor(status, problem) {
    super(problem?.title ?? `request failed with status ${status}`);
    this.name = "DataAccessError";
    this.status = status;
    this.problem = problem ?? null;
  }
}

/** @param {string} path */
function encodePathSegments(path) {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

// ---------------------------------------------------------------------------------------------
// SSE client (A1 §8) — mirrors packages/daemon/src/sse.ts's wire format/parser byte-for-byte.
// Can't be a literal cross-package import of that file: it's TypeScript, and glosa's SPA ships as
// plain, un-transpiled ES modules straight to the browser ("no build step", repo AGENTS.md), so
// no browser can execute it directly. Kept in sync by test/sse-wire-compat.test.ts, which feeds
// THIS parser real frames produced by sse.ts's own `encodeSseFrame` — a genuine cross-package
// wire-compatibility check even though the code itself is necessarily duplicated.
// ---------------------------------------------------------------------------------------------

/** @param {string} raw @returns {SseFrame | null} */
function parseSseFrame(raw) {
  let id;
  let event;
  const dataLines = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("id: ")) id = line.slice(4);
    else if (line.startsWith("event: ")) event = line.slice(7);
    else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
    else if (line === "data:") dataLines.push("");
    // any other line (blank, unrecognized field) is ignored, per the SSE spec's own tolerance
  }
  if (event === undefined) return null; // not a real frame — nothing to yield
  return { id, event, data: dataLines.join("\n") };
}

/** Reads a `response.body.getReader()` reader and yields one parsed frame per blank-line-
 * terminated SSE frame, reassembling frames a chunk boundary split mid-line. Drops `heartbeat`
 * frames silently (A1 §8.3) — no caller ever has to special-case them. */
/** @param {ReadableStreamDefaultReader<Uint8Array>} reader
 *  @returns {AsyncGenerator<SseFrame, void, unknown>} */
export async function* parseSseStream(reader) {
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const rawFrame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const parsed = parseSseFrame(rawFrame);
      if (parsed && parsed.event !== "heartbeat") yield parsed;
    }
    if (done) return;
  }
}

const BACKOFF_BASE_MS = 250;
const BACKOFF_FACTOR = 2;
const BACKOFF_MAX_MS = 5000;
const BACKOFF_JITTER = 0.2;

/** A1 §8.2's client reconnect backoff: 250ms base, ×2 factor, capped at 5s, ±20% jitter. Pure
 * (`rand` injectable) so a test can assert the exact schedule instead of Math.random noise. */
/** @param {number} attempt @param {() => number} [rand] */
export function computeBackoffMs(attempt, rand = Math.random) {
  const raw = Math.min(BACKOFF_BASE_MS * BACKOFF_FACTOR ** attempt, BACKOFF_MAX_MS);
  const jitter = raw * BACKOFF_JITTER * (rand() * 2 - 1);
  return Math.max(0, Math.round(raw + jitter));
}

/** Shared reconnect-loop core behind `openStream`/`openTranscriptStream` (A1 §8.2's algorithm is
 * identical for both cursor spaces — "same wire mechanics" — the only thing that differs between
 * the two callers is which path they open). Opens `GET <path>` and keeps it open, reconnecting
 * with backoff on any drop. `Last-Event-ID` carries the last cursor seen so a reconnect resumes
 * (§8.2 case 2/3) instead of re-snapshotting. `onEvent({event, data, id})` fires for every non-
 * heartbeat frame (`data` is JSON-parsed when present) — deliberately generic over `event` type,
 * so a caller-specific event name (`journal` vs `transcript`, `mirror_unavailable`) never has to be
 * known here. `onReconnect()` fires once a DROPPED connection is successfully re-established —
 * never on the very first connect. Returns a `stop()` function; deps are all injectable for testing
 * (`sleepFn`/`randFn` in particular — a test never wants a real backoff timer running). */
/** @param {string} path @param {StreamOptions} opts */
function openEventStream(
  path,
  {
    fetchFn,
    storage,
    onEvent,
    onReconnect,
    onStatus,
    onUnauthorized,
    backoffFn = computeBackoffMs,
    sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    randFn = Math.random,
  },
) {
  let stopped = false;
  /** @type {string | null} */
  let lastEventId = null;
  let attempt = 0;
  /** @type {null | (() => void)} */
  let cancelReader = null;
  let down = false; // dedupes onStatus: one "down" per outage, one "up" per recovery

  /** @param {boolean} isReconnect */
  async function connectOnce(isReconnect) {
    /** @type {Record<string, string>} */
    const headers = {};
    const token = storage?.getItem(TOKEN_KEY);
    if (token) headers.Authorization = `Bearer ${token}`;
    if (lastEventId !== null) headers["Last-Event-ID"] = lastEventId;

    const res = await /** @type {FetchFn} */ (fetchFn)(path, { headers });
    if (res.status === 401) {
      // Deliberately does NOT drop the credential here. Whether a 401 means "revoked" or "a
      // different daemon holds this port" is one decision, and it lives in `handleUnauthorized`
      // (R6: one data-access module, one place that decides). This loop only stops — the
      // foreign-daemon path recovers by reloading the page, not by resuming a dead stream.
      stopped = true;
      onUnauthorized?.();
      return false;
    }
    if (!res.ok || !res.body) throw new Error(`stream connect failed: ${res.status}`);

    attempt = 0; // any successful connect resets backoff, even before a frame arrives
    if (down) {
      down = false;
      onStatus?.("up");
    }
    if (isReconnect) onReconnect?.();

    const reader = res.body.getReader();
    cancelReader = () => reader.cancel().catch(() => {});
    for await (const frame of parseSseStream(reader)) {
      if (frame.event === "bye") {
        await reader.cancel().catch(() => {});
        return true;
      }
      if (frame.event === "resync_required") {
        lastEventId = null; // next connect is a fresh first-connect (§8.2 case 3)
        continue;
      }
      if (frame.id !== undefined) lastEventId = frame.id;
      /** @type {unknown} */
      let data = frame.data;
      if (frame.data) {
        try {
          data = JSON.parse(frame.data);
        } catch {
          // not JSON — pass the raw string through rather than throwing
        }
      }
      onEvent?.({ event: frame.event, data, id: frame.id });
    }
    return false;
  }

  (async function loop() {
    let isReconnect = false;
    while (!stopped) {
      let retryImmediately = false;
      try {
        retryImmediately = await connectOnce(isReconnect);
      } catch {
        // connect failed, or the stream ended/dropped mid-read — fall through to backoff+retry
      }
      if (stopped) return;
      isReconnect = true;
      if (retryImmediately) continue;
      if (!down) {
        down = true;
        onStatus?.("down"); // fires on drop AND on a failed retry's first drop — deduped above
      }
      const wait = backoffFn(attempt, randFn);
      attempt += 1;
      await sleepFn(wait);
    }
  })();

  return () => {
    stopped = true;
    cancelReader?.();
  };
}

/** Opens `GET /w/:slug/stream` (the artifact/journal cursor space) — see `openEventStream`'s own
 * docstring for the reconnect algorithm. Artifact-change pushes aren't journaled (P3.2's own
 * review note), so a caller's `onReconnect` MUST re-fetch whatever state might have changed while
 * disconnected (the artifact list, the open artifact) rather than trust that live events alone
 * will catch it up. */
/** @param {OpenStreamOptions} opts */
export function openStream({
  fetchFn,
  storage,
  slug,
  onEvent,
  onReconnect,
  onStatus,
  onUnauthorized,
  backoffFn = computeBackoffMs,
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  randFn = Math.random,
}) {
  return openEventStream(`/w/${encodeURIComponent(slug)}/stream`, {
    fetchFn,
    storage,
    onEvent,
    onReconnect,
    onStatus,
    onUnauthorized,
    backoffFn,
    sleepFn,
    randFn,
  });
}

/** Opens `GET /w/:slug/transcript/stream` (P4.2, A1 §5.8/§8, A2 §F16) — the conversation mirror's
 * OWN cursor space, same wire mechanics/reconnect algorithm as `openStream` (`openEventStream`
 * above is the shared core). `onEvent` sees three frame kinds a caller cares about: `event:
 * "transcript"` (a normalized `TranscriptEvent`, `data` already JSON-parsed), `event:
 * "mirror_unavailable"` (fail-soft — conversation.js's cue to show "mirror unavailable — use the
 * terminal" without tearing down anything else), and `resync_required` (already handled generically
 * by `openEventStream` — the connection ends and the next reconnect is a fresh first-connect). */
export function openTranscriptStream(
  /** @type {string} */
  slug,
  {
    fetchFn,
    storage,
    onEvent,
    onReconnect,
    onStatus,
    onUnauthorized,
    backoffFn = computeBackoffMs,
    sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    randFn = Math.random,
  } = /** @type {StreamOptions} */ ({}),
) {
  return openEventStream(`/w/${encodeURIComponent(slug)}/transcript/stream`, {
    fetchFn,
    storage,
    onEvent,
    onReconnect,
    onStatus,
    onUnauthorized,
    backoffFn,
    sleepFn,
    randFn,
  });
}

// ---------------------------------------------------------------------------------------------
// The data-access factory itself.
// ---------------------------------------------------------------------------------------------

/** Builds the one object every other SPA module talks to the daemon through. `fetchFn`/`storage`
 * are injectable (default to the real globals) purely so this is unit-testable without a browser
 * — production code never passes them. */
/** @param {DataAccessDeps} [deps] */
export function createDataAccess(deps = {}) {
  const fetchFn = deps.fetchFn ?? (typeof fetch !== "undefined" ? fetch.bind(globalThis) : undefined);
  const storage = deps.storage ?? (typeof sessionStorage !== "undefined" ? sessionStorage : undefined);
  const expectedInstallId = deps.expectedInstallId ?? null;
  let unauthorizedHandled = false;
  const onUnauthorized =
    deps.onUnauthorized ??
    (() => {
      if (typeof window !== "undefined") window.location.reload();
    });
  const onForeignDaemon = deps.onForeignDaemon ?? onUnauthorized;

  /** Reads the tokenless handshake. Carries NO credential — that is the point: once a 401 is in
   * doubt, nothing authenticated goes to whatever is answering until it is identified. */
  async function readHandshake() {
    try {
      const res = await /** @type {FetchFn} */ (fetchFn)("/api/handshake", {});
      if (!res.ok) return null;
      return /** @type {Handshake} */ (await res.json());
    } catch {
      return null;
    }
  }

  /**
   * What a 401 actually meant. Three outcomes, and only one of them is "your credential is gone":
   *
   * - `unreachable` — nothing answered the handshake either. The daemon is down, not hostile; the
   *   credential is untouched and the caller may classify again on the next attempt.
   * - `foreign` — a daemon is up and paired, but it is NOT the one this tab paired with. Its 401
   *   says nothing about our credential's validity with our own daemon, so discarding it here
   *   would destroy the only thing that can still recover.
   * - `revoked` — same daemon, or one that cannot be told apart, said no. A3 §55 applies.
   */
  async function classifyRejection() {
    const handshake = await readHandshake();
    if (!handshake) return "unreachable";
    if (handshake.paired === false) return "revoked";
    const seen = handshake.install_id;
    if (expectedInstallId && typeof seen === "string" && seen !== expectedInstallId) return "foreign";
    return "revoked";
  }

  function handleUnauthorized() {
    if (unauthorizedHandled) return;
    unauthorizedHandled = true;
    void classifyRejection().then((verdict) => {
      if (verdict === "foreign") {
        onForeignDaemon();
        return;
      }
      if (verdict === "unreachable") {
        // An outage is not a verdict. Re-arm so the next 401 is classified afresh rather than
        // leaving the tab wedged on a transient failure.
        unauthorizedHandled = false;
        return;
      }
      storage?.removeItem(TOKEN_KEY);
      onUnauthorized();
    });
  }

  /** @param {Record<string, string> | undefined} extra */
  function authHeaders(extra) {
    const headers = { ...(extra ?? {}) };
    const token = storage?.getItem(TOKEN_KEY);
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  /** @param {string} path @param {RequestOptions} [init] */
  async function request(path, init = {}) {
    const res = await /** @type {FetchFn} */ (fetchFn)(path, {
      ...init,
      headers: authHeaders(init.headers),
    });
    if (!res.ok) {
      if (res.status === 401) handleUnauthorized();
      let problem = null;
      try {
        problem = await res.json();
      } catch {
        // body wasn't problem+json (or there wasn't one) — DataAccessError tolerates null
      }
      throw new DataAccessError(res.status, problem);
    }
    return res;
  }

  /** @param {string} path @param {RequestOptions} [init] */
  async function requestJson(path, init) {
    return (await request(path, init)).json();
  }

  return {
    /** `GET /api/workspaces` — not one of R6's five named functions, but needed by the sidebar
     * to have ANY slug to call the other five with; without it something else would have to call
     * `fetch` directly, breaking the "ONE data-access module" invariant. */
    getWorkspaces() {
      return requestJson("/api/workspaces");
    },
    /** `GET /api/status` — machine-wide session/workspace data. The viewer derives explicit
     * connected/stale/unbound state from `workspace_binding` + `liveness`; it never infers a
     * binding from cwd fallback. */
    getStatus() {
      return requestJson("/api/status");
    },
    /** @param {string} slug */
    getArtifacts(slug) {
      return requestJson(`/w/${encodeURIComponent(slug)}/artifacts`);
    },
    /** @param {string} slug @param {string} path @param {{ render?: string }} [options] */
    getArtifact(slug, path, { render } = {}) {
      const qs = render ? `?render=${encodeURIComponent(render)}` : "";
      return requestJson(`/w/${encodeURIComponent(slug)}/artifacts/${encodePathSegments(path)}${qs}`);
    },
    /** @param {string} slug @param {unknown} record */
    postAnnotation(slug, record) {
      return requestJson(`/w/${encodeURIComponent(slug)}/annotations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(record),
      });
    },
    /** `GET /w/:slug/annotations?path=…` (A1 §5.6a, authed read) — every annotation still on the
     * record for one artifact, oldest first, each with the payload it was written with plus its
     * status, delivery-attempt count and (once a lease has proven one) the commit an undo would
     * restore to. Notes the human withdrew are not listed: the journal keeps them, but the pane
     * must not put a removed card back on the page. 404 against a daemon that predates the route
     * — callers open the artifact anyway and simply have no cards to repaint. */
    /** @param {string} slug @param {string} [path] */
    getAnnotations(slug, path) {
      const qs = path === undefined ? "" : `?path=${encodeURIComponent(path)}`;
      return requestJson(`/w/${encodeURIComponent(slug)}/annotations${qs}`);
    },
    /** `GET /w/:slug/wiring` (A1 §5.18, authed read) — the 3-state delivery-wiring signal the
     * topbar badge renders: `live` (delivery reaches a session) / `wired` (init installed, no
     * bound session) / `unwired` (init never ran), plus `pending_count`. 404 against a daemon
     * that predates contract 1.4 — callers hide the badge on any failure. */
    /** @param {string} slug */
    getWiringStatus(slug) {
      return requestJson(`/w/${encodeURIComponent(slug)}/wiring`);
    },
    /** `POST /w/:slug/init` (A1 §5.19, state-changing) — the consent-gated init trigger: runs
     * `glosa init` daemon-side for a directory workspace AFTER the user's explicit dialog click.
     * 409 carries the child's conflict code+hint; 400 for loose-file workspaces. */
    /** @param {string} slug */
    triggerInit(slug) {
      return requestJson(`/w/${encodeURIComponent(slug)}/init`, { method: "POST" });
    },
    /** `POST /w/:slug/annotations/:id/withdraw` — terminal `rejected` transition (never a delete;
     * the journal is append-only). 409 once the entry is already terminal. */
    /** @param {string} slug @param {string} id */
    withdrawAnnotation(slug, id) {
      return requestJson(`/w/${encodeURIComponent(slug)}/annotations/${encodeURIComponent(id)}/withdraw`, {
        method: "POST",
      });
    },
    /** @param {string} slug @param {string} path @param {string} content
     *  @param {{ ifMatch?: string }} [options] */
    putArtifact(slug, path, content, { ifMatch } = {}) {
      return requestJson(`/w/${encodeURIComponent(slug)}/artifacts/${encodePathSegments(path)}`, {
        method: "PUT",
        headers: { "Content-Type": "text/plain; charset=utf-8", ...(ifMatch ? { "If-Match": ifMatch } : {}) },
        body: content,
      });
    },
    /** `GET /w/:slug/checkpoints` (A6 §F31, P3.5) — the history/timeline listing. `since` is one
     * of `yesterday|today|<ISO>|<checkpoint-id>` (resolved daemon-side, host-local TZ); `limit`
     * caps the row count. Omitting both fetches full history. */
    /** @param {string} slug @param {{ since?: string, limit?: number }} [options] */
    getCheckpoints(slug, { since, limit } = {}) {
      const params = new URLSearchParams();
      if (since !== undefined) params.set("since", since);
      if (limit !== undefined) params.set("limit", String(limit));
      const qs = params.toString();
      return requestJson(`/w/${encodeURIComponent(slug)}/checkpoints${qs ? `?${qs}` : ""}`);
    },
    /** `GET /w/:slug/diff` (A1 §5.7, extended P3.5) — a unified diff between two checkpoints, or
     * a checkpoint and the live working tree (`to: "working"`). */
    /** @param {string} slug @param {{ from: string, to: string }} range */
    getDiff(slug, { from, to }) {
      const params = new URLSearchParams({ from, to });
      return requestJson(`/w/${encodeURIComponent(slug)}/diff?${params.toString()}`);
    },
    /** `POST /w/:slug/restore` (A6 §F31, P3.5) — restores `path`'s bytes from checkpoint `to`.
     * Without `force`, a dirty artifact (changes since its latest checkpoint) is refused with a
     * `DataAccessError` whose `.problem.would_be_lost_diff` carries what a `force:true` retry
     * would discard — the caller (history.js) shows that diff before retrying with force. */
    /** @param {string} slug @param {{ path?: string, to?: string, force?: boolean }} [options] */
    restore(slug, { path, to, force } = {}) {
      return requestJson(`/w/${encodeURIComponent(slug)}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, to, ...(force ? { force: true } : {}) }),
      });
    },
    /** @param {string} slug */
    getInbox(slug) {
      return requestJson(`/w/${encodeURIComponent(slug)}/inbox`);
    },
    /** @param {string} slug @param {string} id */
    markAttentionSeen(slug, id) {
      return requestJson(`/w/${encodeURIComponent(slug)}/inbox/${encodeURIComponent(id)}/seen`, { method: "POST" });
    },
    /** @param {string} slug @param {string} id
     *  @param {{ outcome?: string, response?: string, revisionId?: string }} [options] */
    respondToAttention(slug, id, { outcome, response, revisionId } = {}) {
      return requestJson(`/w/${encodeURIComponent(slug)}/inbox/${encodeURIComponent(id)}/response`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          outcome,
          ...(response ? { response } : {}),
          ...(revisionId ? { revision_id: revisionId } : {}),
        }),
      });
    },
    /** `GET /api/handshake`, tokenless. The one way any other module may ask who is answering this
     * port — R6 keeps every `fetch` in this file, so the foreign-daemon wait loop cannot poll on
     * its own. Returns null when nothing answers. */
    daemonIdentity() {
      return readHandshake();
    },
    /** @param {string} slug
     *  @param {{ onEvent?: StreamEventHandler, onReconnect?: () => void,
     *            onStatus?: (status: "down" | "up") => unknown }} [options] */
    openStream(slug, { onEvent, onReconnect, onStatus } = {}) {
      return openStream({ fetchFn, storage, slug, onEvent, onReconnect, onStatus, onUnauthorized: handleUnauthorized });
    },
    /** `GET /w/:slug/transcript/stream` (A1 §5.8/§8, P4.2) — the conversation mirror. See
     * `openTranscriptStream`'s own docstring for the frame kinds `onEvent` receives. */
    /** @param {string} slug
     *  @param {{ onEvent?: StreamEventHandler, onReconnect?: () => void,
     *            onStatus?: (status: "down" | "up") => unknown }} [options] */
    openTranscriptStream(slug, { onEvent, onReconnect, onStatus } = {}) {
      return openTranscriptStream(slug, {
        fetchFn,
        storage,
        onEvent,
        onReconnect,
        onStatus,
        onUnauthorized: handleUnauthorized,
      });
    },
    /** `POST /w/:slug/transcript/compose` (F32/R6) — creates or retries one immutable,
     * exact-session conversation message without touching the transcript. `delivered:true` means
     * the target session acknowledged presentation; queueing/transport acceptance stay pending. */
    /** @param {string} slug @param {string} text
     *  @param {{ messageId?: string, sessionHint?: string }} [options] */
    sendComposerMessage(slug, text, { messageId, sessionHint } = {}) {
      return requestJson(`/w/${encodeURIComponent(slug)}/transcript/compose`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          ...(messageId ? { message_id: messageId } : {}),
          ...(sessionHint ? { session_hint: sessionHint } : {}),
        }),
      });
    },

    /** @param {string} slug @param {string} messageId */
    getComposerMessageStatus(slug, messageId) {
      return requestJson(`/w/${encodeURIComponent(slug)}/transcript/compose/${encodeURIComponent(messageId)}`);
    },
    /** `POST /w/:slug/capability/:artifactPath` (A1 §5.13/§7, P4.1) — mints a fresh, directory-
     * scoped capability for a class-F artifact. classf-viewer.js calls this once per iframe
     * open/reload; the response `{url, nonce, expires_in_s}` is exactly what it needs to embed
     * the iframe and complete the nonce-gated MessageChannel handshake (A3 §2). */
    /** @param {string} slug @param {string} artifactPath */
    mintClassFCapability(slug, artifactPath) {
      return requestJson(`/w/${encodeURIComponent(slug)}/capability/${encodePathSegments(artifactPath)}`, {
        method: "POST",
      });
    },
  };
}

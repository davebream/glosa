// SPDX-License-Identifier: Apache-2.0
// @glosa/spa — R6's ONE data-access module: the SPA reaches the daemon through this file and
// NOTHING else does (no other module calls `fetch` — see test/import-boundary.test.ts, which
// checks that structurally). This is the L0→L3 swappable-data-layer invariant: a future hosted
// shell only ever has to change what this one module does, never anything that calls it.
//
// Every request carries `Authorization: Bearer <sessionStorage.glosa_token>` (the token
// bootstrap.js's `scrubToken` already stashed there, P1.4) — same-origin `fetch`, nothing fancier,
// per R6's "same-origin fetch today" v1 scope.
const TOKEN_KEY = "glosa_token";

/** Thrown by every data-access call that gets a non-2xx response. Carries the parsed
 * problem+json body (A1 §1) when the daemon sent one, so a caller can branch on `.status`/
 * `.problem.type` without re-parsing anything itself. */
export class DataAccessError extends Error {
  constructor(status, problem) {
    super(problem?.title ?? `request failed with status ${status}`);
    this.name = "DataAccessError";
    this.status = status;
    this.problem = problem ?? null;
  }
}

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
/** @param {string} path
 *  @param {{fetchFn?: any, storage?: any, onEvent?: (frame: any) => void, onReconnect?: () => void,
 *           onStatus?: (status: "down"|"up") => unknown, backoffFn?: any, sleepFn?: any, randFn?: any}} opts */
function openEventStream(path, {
  fetchFn,
  storage,
  onEvent,
  onReconnect,
  onStatus,
  backoffFn = computeBackoffMs,
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  randFn = Math.random,
}) {
  let stopped = false;
  let lastEventId = null;
  let attempt = 0;
  let cancelReader = null;
  let down = false; // dedupes onStatus: one "down" per outage, one "up" per recovery

  async function connectOnce(isReconnect) {
    const headers = {};
    const token = storage?.getItem(TOKEN_KEY);
    if (token) headers.Authorization = `Bearer ${token}`;
    if (lastEventId !== null) headers["Last-Event-ID"] = lastEventId;

    const res = await fetchFn(path, { headers });
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
      let data = frame.data;
      if (data) {
        try {
          data = JSON.parse(data);
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
/** @param {{fetchFn?: any, storage?: any, slug?: any, onEvent?: (frame: any) => void,
 *           onReconnect?: () => void, onStatus?: (status: "down"|"up") => unknown,
 *           backoffFn?: any, sleepFn?: any, randFn?: any}} opts */
export function openStream({
  fetchFn,
  storage,
  slug,
  onEvent,
  onReconnect,
  onStatus,
  backoffFn = computeBackoffMs,
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  randFn = Math.random,
}) {
  return openEventStream(`/w/${encodeURIComponent(slug)}/stream`, { fetchFn, storage, onEvent, onReconnect, onStatus, backoffFn, sleepFn, randFn });
}

/** Opens `GET /w/:slug/transcript/stream` (P4.2, A1 §5.8/§8, A2 §F16) — the conversation mirror's
 * OWN cursor space, same wire mechanics/reconnect algorithm as `openStream` (`openEventStream`
 * above is the shared core). `onEvent` sees three frame kinds a caller cares about: `event:
 * "transcript"` (a normalized `TranscriptEvent`, `data` already JSON-parsed), `event:
 * "mirror_unavailable"` (fail-soft — conversation.js's cue to show "mirror unavailable — use the
 * terminal" without tearing down anything else), and `resync_required` (already handled generically
 * by `openEventStream` — the connection ends and the next reconnect is a fresh first-connect). */
export function openTranscriptStream(
  slug,
  {
    fetchFn,
    storage,
    onEvent,
    onReconnect,
    onStatus,
    backoffFn = computeBackoffMs,
    sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    randFn = Math.random,
  } = {},
) {
  return openEventStream(`/w/${encodeURIComponent(slug)}/transcript/stream`, {
    fetchFn,
    storage,
    onEvent,
    onReconnect,
    onStatus,
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
export function createDataAccess(deps = {}) {
  const fetchFn = deps.fetchFn ?? (typeof fetch !== "undefined" ? fetch.bind(globalThis) : undefined);
  const storage = deps.storage ?? (typeof sessionStorage !== "undefined" ? sessionStorage : undefined);

  function authHeaders(extra) {
    const headers = { ...(extra ?? {}) };
    const token = storage?.getItem(TOKEN_KEY);
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  async function request(path, init = {}) {
    const res = await fetchFn(path, { ...init, headers: authHeaders(init.headers) });
    if (!res.ok) {
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
    getArtifacts(slug) {
      return requestJson(`/w/${encodeURIComponent(slug)}/artifacts`);
    },
    getArtifact(slug, path, { render } = {}) {
      const qs = render ? `?render=${encodeURIComponent(render)}` : "";
      return requestJson(`/w/${encodeURIComponent(slug)}/artifacts/${encodePathSegments(path)}${qs}`);
    },
    postAnnotation(slug, record) {
      return requestJson(`/w/${encodeURIComponent(slug)}/annotations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(record),
      });
    },
    /** `POST /w/:slug/annotations/:id/withdraw` — terminal `rejected` transition (never a delete;
     * the journal is append-only). 409 once the entry is already terminal. */
    withdrawAnnotation(slug, id) {
      return requestJson(`/w/${encodeURIComponent(slug)}/annotations/${encodeURIComponent(id)}/withdraw`, {
        method: "POST",
      });
    },
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
    getCheckpoints(slug, { since, limit } = {}) {
      const params = new URLSearchParams();
      if (since !== undefined) params.set("since", since);
      if (limit !== undefined) params.set("limit", String(limit));
      const qs = params.toString();
      return requestJson(`/w/${encodeURIComponent(slug)}/checkpoints${qs ? `?${qs}` : ""}`);
    },
    /** `GET /w/:slug/diff` (A1 §5.7, extended P3.5) — a unified diff between two checkpoints, or
     * a checkpoint and the live working tree (`to: "working"`). */
    getDiff(slug, { from, to }) {
      const params = new URLSearchParams({ from, to });
      return requestJson(`/w/${encodeURIComponent(slug)}/diff?${params.toString()}`);
    },
    /** `POST /w/:slug/restore` (A6 §F31, P3.5) — restores `path`'s bytes from checkpoint `to`.
     * Without `force`, a dirty artifact (changes since its latest checkpoint) is refused with a
     * `DataAccessError` whose `.problem.would_be_lost_diff` carries what a `force:true` retry
     * would discard — the caller (history.js) shows that diff before retrying with force. */
    restore(slug, { path, to, force } = {}) {
      return requestJson(`/w/${encodeURIComponent(slug)}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, to, ...(force ? { force: true } : {}) }),
      });
    },
    getInbox(slug) {
      return requestJson(`/w/${encodeURIComponent(slug)}/inbox`);
    },
    markAttentionSeen(slug, id) {
      return requestJson(`/w/${encodeURIComponent(slug)}/inbox/${encodeURIComponent(id)}/seen`, { method: "POST" });
    },
    respondToAttention(slug, id, { outcome, response } = {}) {
      return requestJson(`/w/${encodeURIComponent(slug)}/inbox/${encodeURIComponent(id)}/response`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outcome, ...(response ? { response } : {}) }),
      });
    },
    openStream(slug, { onEvent, onReconnect, onStatus } = {}) {
      return openStream({ fetchFn, storage, slug, onEvent, onReconnect, onStatus });
    },
    /** `GET /w/:slug/transcript/stream` (A1 §5.8/§8, P4.2) — the conversation mirror. See
     * `openTranscriptStream`'s own docstring for the frame kinds `onEvent` receives. */
    openTranscriptStream(slug, { onEvent, onReconnect, onStatus } = {}) {
      return openTranscriptStream(slug, { fetchFn, storage, onEvent, onReconnect, onStatus });
    },
    /** `POST /w/:slug/transcript/compose` (P4.2, F32/R6) — the conversation viewer's out-of-band
     * composer: sends a NEW user message to whichever session is bound to this workspace, without
     * ever touching the transcript file (http.ts's `handleComposerSend` is explicit about this).
     * Real delivery is a `// P4.3:` seam on the daemon side — the response's `delivered` field
     * tells the caller whether to treat the send as more than "accepted". */
    sendComposerMessage(slug, text) {
      return requestJson(`/w/${encodeURIComponent(slug)}/transcript/compose`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
    },
    /** `POST /w/:slug/capability/:artifactPath` (A1 §5.13/§7, P4.1) — mints a fresh, directory-
     * scoped capability for a class-F artifact. classf-viewer.js calls this once per iframe
     * open/reload; the response `{url, nonce, expires_in_s}` is exactly what it needs to embed
     * the iframe and complete the nonce-gated MessageChannel handshake (A3 §2). */
    mintClassFCapability(slug, artifactPath) {
      return requestJson(`/w/${encodeURIComponent(slug)}/capability/${encodePathSegments(artifactPath)}`, {
        method: "POST",
      });
    },
  };
}

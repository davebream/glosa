# glosa v1 — HTTP API contract (resolves F02, F09, F17)

Scope: normative contract for `packages/daemon`'s public HTTP surface. Covers transport,
versioning, routes, status codes, size limits, SSE resync, and class-F capability-URL issuance.
Does NOT redefine the `attention_request` state machine (F12), the class-F bridge/postMessage
protocol or CSP header value (F03/F18), or the jethro adapter's manifest resolution logic (F11) —
those are cross-referenced, not duplicated.

---

## 1. Transport baseline

- Bind `127.0.0.1` only. Every request (including `GET /api/handshake`) is Origin- and
  Host-allowlisted first, before any other processing — a rejected Origin/Host returns `403`
  with no body, regardless of route or auth state.
- All request/response bodies are `application/json` except SSE streams
  (`text/event-stream`) and the class-F document route (`text/html`).
- Errors use a minimal RFC 9457-shaped envelope, `application/problem+json`:
  ```json
  { "type": "https://glosa.local/errors/<slug>", "title": "<human summary>",
    "status": <int>, "detail": "<optional>", "instance": "<request path>" }
  ```
  `<slug>` values used below: `invalid-origin`, `unauthorized`, `contract-mismatch`,
  `invalid-path`, `not-found`, `payload-too-large`, `validation-failed`,
  `capability-expired`, `internal`.

## 2. Auth

- Pairing token: 128-bit, written once to `~/.glosa/token` (0600). SPA reads it once from the
  `#t=<token>` URL fragment (cleared from the URL bar immediately via `history.replaceState`,
  per F24), stores it in memory + `sessionStorage`, sends `Authorization: Bearer <token>` on
  every request thereafter.
- **Exactly one route is tokenless**: `GET /api/handshake`. Every other route, including SSE
  streams, requires the Bearer header. Missing/invalid token → `401 unauthorized`.
- SSE auth is via `fetch()`-streaming, never native `EventSource` (F02) — `EventSource` cannot
  attach custom headers, so it cannot carry the Bearer token. The client opens the stream with
  `fetch(url, {headers: {Authorization, 'Last-Event-ID': cursor}})` and reads
  `response.body.getReader()`, hand-parsing the `id:`/`event:`/`data:` SSE wire format (a ~40
  line parser — no library needed). This is the same mechanism used for every other route, so
  there is no separate auth code path for streaming.
- Class-F documents are the one exception to "Bearer everywhere": iframes cannot attach headers
  either, and F03 forbids exposing the machine token to that origin at all. See §7.

## 3. Versioning & N/N-1 compatibility

- `contract_version` is a plain `"<major>.<minor>"` string (no patch — patch-level daemon
  changes never touch the wire contract). Daemon and SPA ship from the same monorepo build, so
  version skew only happens when a browser tab stays open across a daemon restart onto a newer
  build (or, rarely, an older one after a rollback).
- The SPA sends `X-Contract-Version: <major>.<minor>` (the version it was built against) on
  every request after handshake. The daemon compares:
  - **Major mismatch** → `409 contract-mismatch`, all state-changing and read routes refuse.
    The SPA's handshake screen shows "contract mismatch — reload page" (R5's third failure
    screen) and reloads `/` to fetch fresh assets.
  - **Minor mismatch, same major** → request proceeds normally; daemon adds response header
    `X-Contract-Warning: stale-minor` so the SPA can log it, but does not block. This is the
    N/N-1 tolerance: a minor bump is additive-only by convention (new optional fields, new
    routes), so an N-1 SPA client talking to an N daemon (or vice versa within the same major)
    keeps working.
  - Missing `X-Contract-Version` header (any client that isn't the bundled SPA, e.g. a future
    CLI caller) is treated as "unknown minor, same major assumed" — not rejected — since major
    mismatches are the only breaking case and those are caught by the handshake response itself.
- `GET /api/handshake` returns `{contract_version, daemon_version, paired: boolean}` and is the
  first call the SPA makes on load, before it has a token, so it can render the right one of the
  three failure screens (daemon unreachable / unpaired / contract mismatch) instead of a generic
  error.

## 4. Body size limits

- Global request body cap: **1 MiB**, enforced by the daemon before JSON parsing (reject at the
  `Bun.serve` request-body-read layer once the limit is exceeded, don't buffer past it). Over
  limit → `413 payload-too-large`.
- Annotation payloads (§5.4) are small by construction (quote is ±40 chars context) — the 1 MiB
  cap is generous headroom, not a working limit.
- Artifact content responses are capped by the existing tracked-artifact rule (R1: files >2 MB
  are not artifacts at all, so `GET .../artifacts/:path` never needs to stream more than 2 MB).
- Diff responses (`GET .../diff`) are not capped by the request-body limiter (it's a response,
  and unified diffs can legitimately exceed 1 MiB for a large multi-file range). No enforced
  cap in v1; if a diff response would be pathological (workspace-wide history since "yesterday"
  on a very active project), that's accepted risk for a local single-user tool — revisit only if
  T8 rehearsal actually hits it.

## 5. Route catalog

Base URL: `http://127.0.0.1:<port>`. `:slug` is the workspace slug (R1). Every `:path` /
`:artifactPath` param is validated per §6 before use.

### 5.1 `GET /api/handshake`
No auth, Origin-gated only. **200** always (Origin/Host allowlist is the only rejection path,
which returns 403 per §1).
```json
{ "contract_version": "1.0", "daemon_version": "0.3.1", "paired": true }
```

### 5.2 `GET /api/workspaces`
Bearer required. Lists the live registry (R1 sources: live-session cwds, `.glosa/`-marked
dirs, manually opened dirs).
- **200**
```json
[{ "slug": "glosa-a1b2c3", "path": "/Users/dawid/code/glosa",
   "last_seen": "2026-07-20T10:00:00Z", "has_attention": false }]
```
No POST route to create workspaces in v1 — workspace creation is CLI-only (`glosa open <dir>`,
R8); the registry is read-only from the SPA's perspective. (If a future need arises to open a
new workspace from the SPA, that's an additive route — not required for v1.)

### 5.3 `GET /w/:slug/artifacts`
Bearer required. Sidebar listing, natural-sort order in the no-adapter case (adapter pack may
reorder, R7).
- **200**
```json
[{ "path": "07_manuscript.md", "class": "R", "size_bytes": 4213,
   "mtime": "2026-07-20T09:58:00Z", "source_sha256": "…", "stale": false }]
```
- **404 not-found** — unknown `:slug`.

### 5.4 `GET /w/:slug/artifacts/:path`
Bearer required. `:path` is workspace-relative (§6 confinement). Query param `?render=html`
requests server-rendered HTML with `data-line` stamps for class R; omit for raw source.
Class F artifacts return metadata only — actual HTML is never served through this route (§7).
- **200** (class R, `?render=html`)
```json
{ "source_path": "07_manuscript.md", "source_sha256": "…", "class": "R",
  "content": "<raw markdown>", "rendered_html": "<div data-line=\"1\">…</div>" }
```
- **200** (class F)
```json
{ "source_path": "output/sermon/speech-notes-2026-07-20.html", "source_sha256": "…",
  "class": "F", "manifest_path": "output/sermon/chunks-2026…/manifest.json" }
```
- **400 invalid-path** — path escapes workspace root or fails the tracked-artifact rule.
- **404 not-found** — path within workspace but no such artifact.

### 5.5 `GET /w/:slug/stream`
Bearer required. Artifact/journal SSE stream — full protocol in §7... see §8 (SSE resync).
Query param `?since=<cursor>` is the documented fallback for `Last-Event-ID` (see §8).
- **200**, `Content-Type: text/event-stream`, connection held open.
- **404 not-found** — unknown `:slug`.

### 5.6 `POST /w/:slug/annotations`
Bearer required, Origin-gated (state-changing route, per R5). Body per R3's `annotation`
payload shape.
```json
{ "body": "consider tightening this", "intent": "content",
  "target": { "chunk_id": "chunk-004",
              "quote": { "exact": "…", "prefix": "…", "suffix": "…" },
              "position": { "start": 1204, "end": 1240 } } }
```
- **201**
```json
{ "id": "inb-1721470000-a1c2", "status": "pending" }
```
- **400 validation-failed** — missing `body`/`intent`/`target.quote.exact`, or `intent` not
  one of `content|classification|style`.
- **404 not-found** — unknown `:slug`.
- **413 payload-too-large** — body over 1 MiB (§4).

### 5.7 `GET /w/:slug/diff`
Bearer required. Query params: either `?since=last-annotation|yesterday` or
`?from=<checkpoint_id>&to=<checkpoint_id>`. `from`/`to` are shadow-git checkpoint IDs (opaque
short SHAs from the shadow repo — never surfaced to the human as "commits", per R1's
document-native UI language; the API may use the SHA internally but the SPA never has to).
- **200**
```json
{ "from": "chk_9f21a0", "to": "chk_c81d33",
  "hunks": [{ "path": "07_manuscript.md", "diff": "<unified diff>",
              "attribution": "session:2b7f… | human | unknown" }] }
```
- **400 validation-failed** — unknown `since` token, or `from`/`to` not found in the shadow
  repo's checkpoint history.
- **404 not-found** — unknown `:slug`.

### 5.8 `GET /w/:slug/transcript/stream`
Bearer required. Conversation-mirror SSE stream, separate cursor space from `/stream` (§8).
Same connection/heartbeat/resync mechanics.
- **200**, `text/event-stream`.
- **404 not-found** — unknown `:slug`, or no live/parked session bound to it yet (the SPA shows
  "no session registered" rather than treating this as a stream error).

### 5.9 `GET /w/:slug/inbox`
Bearer required. Summary for the sidebar badge + attention tray. Full `attention_request`
lifecycle payload/response schema is F12's scope — this route's response envelope is stable,
its `attention[]` item shape is not finalized here.
- **200**
```json
{ "pending_count": 2, "attention": [{ "id": "inb-…", "created_at": "…", "status": "pending" }] }
```

### 5.10 `POST /w/:slug/inbox/:id/response`
Bearer required, Origin-gated. Human response to an `attention_request`. Body/response schema
deferred to F12 (this entry only fixes the route's existence, method, and generic status codes).
- **200** on success, **404 not-found** unknown `:id`, **409** if `:id` is already in a terminal
  status (F12 owns the exact transition table).

### 5.11 `POST /w/:slug/session-binding`
Bearer required, Origin-gated. Explicit user pick from the session picker (R2: "the session the
SPA has explicitly bound to the workspace").
```json
{ "session_id": "2b7f19a3-…" }
```
- **200** `{ "bound": true, "session_id": "2b7f19a3-…" }`
- **404 not-found** — `:slug` unknown, or `session_id` not a live registry entry.

### 5.12 `GET /w/:slug/capability/:artifactPath`
Bearer required, Origin-gated. Issues a capability URL for a class-F artifact. Full mechanics in §7.
- **200** `{ "url": "http://127.0.0.1:4647/doc/<token>/<artifactBasename>", "expires_in_s": 600 }`
- **400 invalid-path** — path confinement failure, or artifact is not class F.
- **404 not-found** — no such artifact.

## 6. Path confinement (canonical rule, applies to every `:path`/`:artifactPath`)

1. Reject any path containing a literal `..` segment, a NUL byte, or a leading `/` (must be
   workspace-relative) before touching the filesystem — `400 invalid-path`.
2. Resolve `path.resolve(workspaceRoot, requestedPath)`.
3. `fs.realpath()` both the resolved path and `workspaceRoot`; the resolved realpath MUST start
   with `workspaceRoot realpath + path.sep` — this is what catches a symlink inside the
   workspace pointing outside it (realpath-confine, per F24). Fails → `400 invalid-path`.
4. Re-apply the tracked-artifact rule (R1 include/exclude globs, size ≤2 MB) — a path that
   resolves fine but isn't a tracked artifact is `404 not-found`, not `400`, since path
   validity and artifact-membership are different failure classes worth distinguishing in logs.

## 7. Class-F capability-URL issuance

Locked decisions (F02/F03) require: no Bearer token ever reaches the class-F origin, iframe
`src` navigation can't carry an `Authorization` header anyway, and the document must be served
from a **separate loopback port** with no ambient credential.

- The daemon runs a second `Bun.serve` listener on a second port (`GLOSA_CLASSF_PORT`, default
  `<GLOSA_PORT>+1`), bound `127.0.0.1` only, serving `GET /doc/:token/<path...>`.
- `GET /w/:slug/capability/:artifactPath` (§5.12, main origin, Bearer-authed) mints a token:
  256-bit random, stored server-side in an in-memory map
  `token → {slug, artifactDirRealPath, artifactBasename, expiresAt}`. **TTL 600s (10 min).**
  Restart invalidates all tokens (in-memory only — acceptable for a local tool).
- **The capability is directory-scoped and multi-request, NOT single-use.** This is required
  for correctness: a class-F document (e.g. speech-notes HTML) loads sibling assets — its own
  `sermon-notes.css`, `annotate.js`, images — so the token must serve the document **and** its
  siblings for the whole time the iframe is displayed. A single-use/one-request token cannot
  serve the CSS after the initial HTML load. (This supersedes an earlier single-use draft;
  reconciled with A3 §1, which is authoritative on the class-F origin.)
- `GET /doc/:token/<path...>` checks `exists && now < expiresAt`, then resolves `<path...>`
  **against `artifactDirRealPath` under the canonical realpath confinement of §6** (each request
  re-confined — a sibling request can never escape the artifact's directory). Unknown/expired
  token or a path escaping the dir → `404` (plain text, no daemon-origin details). The document
  itself is `/doc/:token/<artifactBasename>`.
- On success, the class-F listener streams the requested file **source-preserving
  (bridge-augmented)** — for the HTML document, the glosa bridge script is injected and the
  CSP/`sandbox`/`Referrer-Policy` headers set (A3 §1 is the authoritative CSP + postMessage
  contract); sibling assets are streamed with their own content-type and the same
  network-locked CSP, no bridge.
- **Fresh mint per iframe open/reload.** If the artifact re-renders (SSE tells the SPA the
  source changed), the SPA discards the old iframe and requests a fresh capability for a fresh
  iframe; the old token simply expires. No renewal, no cross-origin state sync beyond mint.
- This mint route only ever serves class-F artifacts; a capability request for a class-R path is
  `400 invalid-path` (§5.12) — class R is served in-band via §5.4, never through this listener.

## 8. SSE protocol & resync (F17)

Applies identically to `GET /w/:slug/stream` (artifact/journal events) and
`GET /w/:slug/transcript/stream` (conversation mirror) — two independent cursor spaces, same
wire mechanics.

### 8.1 Wire format
Standard SSE framing, hand-parsed client-side (fetch-streaming, not `EventSource` — §2):
```
id: <cursor>
event: <artifact | journal | heartbeat | snapshot | resync_required>
data: <json>

```
- `id` is a monotonically increasing cursor **scoped to that stream+workspace**. For
  `/w/:slug/stream` it's the journal line's sequence number (the journal is append-only NDJSON,
  R3 — sequence number is just its 0-based line offset, cheap and stable). For
  `/w/:slug/transcript/stream` it's an opaque token encoding `{inode, byte_offset}` of the
  tailed JSONL file — opaque to the client, only round-tripped, so the tailer (F16's scope) is
  free to change its internal representation without an API-contract bump.

### 8.2 Reconnect / resync algorithm
1. **First connect**: no `Last-Event-ID` header and no `?since=` query param. Daemon sends one
   `event: snapshot` (id = current cursor) whose `data` is the full current state needed to
   paint the view from scratch (artifact list + latest `source_sha256` per artifact for the
   artifact stream; the transcript-mirror's already-known entries for the transcript stream),
   then continues emitting live events from that cursor forward.
2. **Reconnect** (network drop, daemon restart, tab backgrounded and resumed): client resends
   the fetch with `Last-Event-ID: <last cursor it saw>` (primary) — `?since=<cursor>` query
   param is the documented fallback for any client that can't set custom headers on a
   `fetch`-streaming reconnect (there isn't one in practice on this stack, but the fallback
   costs nothing and future non-browser clients, e.g. a CLI `glosa tail`, may want it).
3. Daemon checks whether the cursor is still within retained history:
   - **Retained** (the normal case — the journal is append-only and never rotates in v1, so
     every cursor issued while the daemon has been running is always replayable): daemon
     replays every event with `id > cursor` from the journal, then continues live. No
     `event: snapshot` needed — this is a strict resume, not a resync.
   - **Not retained** (only possible if the journal were rotated/truncated — not a v1
     mechanism, but the escape hatch exists so the server never has to promise infinite
     retention): daemon sends `event: resync_required` with no `data`. Client drops its stored
     cursor and immediately re-requests the stream with no `Last-Event-ID`, landing back in
     case 1 (snapshot-then-resume).
4. **Daemon restart** is not a special case in this algorithm: the bus is files (R3/NFR
   "daemon crash loses nothing"), so a restarted daemon replaying its journal from disk sees
   the exact same sequence numbers as before the crash. The client's stored cursor is still
   valid; step 3's "retained" branch fires transparently. `resync_required` is reserved for a
   scenario v1 doesn't create (journal rotation) — documented now so a future rotation feature
   doesn't need an API-contract change.

### 8.3 Heartbeat (defeats Bun's idle-socket close)
- Bun's default HTTP idle timeout closes a connection that's been quiet too long — this bites
  long-open SSE streams with no events. Two independent mitigations, both required:
  1. The daemon explicitly sets a large/disabled idle timeout on SSE responses specifically
     (`Bun.serve({ idleTimeout: 0, ... })` scoped to the stream route, not globally — other
     routes keep a normal timeout so a hung request doesn't leak a socket forever).
  2. **Belt-and-suspenders**: the daemon also emits `event: heartbeat` (empty `data`, no `id` —
     heartbeats don't advance the cursor) every **15s** on every open stream connection,
     regardless of real event traffic. This covers any intermediary (a future reverse proxy, a
     browser's own aggressive socket reaping) that isn't Bun's idle timeout specifically. The
     client's parser drops `heartbeat` events silently; the client's own inactivity watchdog
     considers the connection dead (and triggers §8.2's reconnect) only if it sees no bytes
     (not even a heartbeat) for >45s (3 missed heartbeats).
5. Client reconnect backoff: 250ms base, ×2 factor, capped at 5s, ±20% jitter — standard
   thundering-herd avoidance, irrelevant at single-client scale but free to specify once.

## 9. Status code summary

| Code | Meaning | Used by |
|---|---|---|
| 200 | success | all GETs, POST responses that don't create a resource |
| 201 | resource created | `POST .../annotations` |
| 400 | invalid path / validation failure | path confinement, bad annotation body, bad diff query |
| 401 | missing/invalid Bearer token | every route except `/api/handshake` |
| 403 | Origin/Host not allowlisted | every route, checked first |
| 404 | unknown workspace/artifact/session/capability token | all resource-scoped GETs, capability consumption |
| 409 | contract major-version mismatch; terminal-status conflict on inbox response | any route (contract check runs before route logic), `POST .../inbox/:id/response` |
| 413 | request body over 1 MiB | any POST |
| 500 | unhandled daemon error | any route |

---

## Summary of what's out of scope here (do not re-derive)

- `attention_request` full payload/state machine, `--wait` semantics → F12.
- Exact CSP header value, sandbox token list, postMessage schema/nonce handshake → F03/F18.
- Manifest→source-range resolution algorithm for class-F annotations → F11.
- Transcript tailer's partial-line/rotation/corruption handling → F16 (the API only sees its
  opaque cursor, per §8.1).

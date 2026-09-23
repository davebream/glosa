# glosa v1 — HTTP API contract (resolves F02, F09, F17)

Scope: normative contract for `packages/daemon`'s public HTTP surface. Covers transport,
versioning, routes, status codes, size limits, SSE resync, and class-F capability-URL issuance.
Does NOT redefine the `attention_request` state machine (F12), the class-F bridge/postMessage
protocol or CSP header value (F03/F18), or manifest resolution logic (F11) —
those are cross-referenced, not duplicated.

---

## 1. Transport baseline

- Two TCP listeners bind `127.0.0.1` only. A THIRD listener serves the same API over
  `<GLOSA_HOME>/run/api.sock` (A3 §3.2): CLI, MCP and provider clients use it exclusively, the
  browser cannot, and no other uid can open it. Host and Origin rules below are inapplicable
  there — both defeat browser attacks, and there is no browser — while the Bearer is still
  required, so token rotation and revocation reach socket clients unchanged.
- On the TCP listeners, every request (including `GET /api/handshake`) is Origin- and
  Host-allowlisted first, before any other processing. The Host allowlist is exactly
  `127.0.0.1:<port>` and `glosa.localhost:<port>` on this port (A3 §4 Rule 1, #159); a rejected
  Host returns `400` with no body, and a foreign Origin returns `403`, regardless of route or auth
  state. "Foreign" means anything other than `http://<the request's own Host>`.
- All request/response bodies are `application/json` except SSE streams
  (`text/event-stream`) and the class-F document route (`text/html`).
- Errors use a minimal RFC 9457-shaped envelope, `application/problem+json`:
  ```json
  { "type": "https://glosa.local/errors/<slug>", "title": "<human summary>",
    "status": <int>, "detail": "<optional>", "instance": "<request path>" }
  ```
  Common `<slug>` values, not an exhaustive catalogue — each route's own section and the status
  table below are authoritative, and routes added since have their own (`source-changed` §5.4a,
  `not-utf8` §5.4a, the claim slugs §5.11f): `invalid-origin`, `unauthorized`, `contract-mismatch`,
  `invalid-path`, `not-found`, `payload-too-large`, `validation-failed`,
  `capability-expired`, `internal`, `workspace-forgetting`, `forget-blocked`,

  `forget-stale-preview` (contract 1.8, §5.20), `home-workspace-registered`
  (400 — the workspace that owns this path is the user's home directory or an ancestor of it, from
  a registration of that directory — made before the boundary existed, or made deliberately since,
  because an explicit directory target remains the supported opt-in. The registration is retained;
  the remediation
  text, including that registration's slug, arrives in `title`, which is where every
  `WorkspaceOpenError` puts it, and no `detail` is sent, issue #146).

## 2. Auth

- Pairing token: 128-bit, written once to `~/.glosa/token` (0600). SPA reads it once from the
  `#t=<token>` URL fragment (cleared from the URL bar immediately via `history.replaceState`,
  per F24), stores it in memory + origin-scoped `localStorage` (never a cookie, never the URL),
  sends `Authorization: Bearer <token>` on
  every request thereafter. Presentation URLs from MCP `glosa_present` use `#p=<ephemeral>`
  instead: a short-TTL (60s) single-use token redeemed once via
  `POST /api/presentation-token/redeem` for the current durable pairing token. The durable token
  never appears in MCP output, daemon logs, or subsequent focus URLs. Non-secret fragment state
  (`w`, `a`, `surface`, `mode`, `lock`) is preserved across scrub for refresh-safe deep-links:
  `#…&w=<slug>&a=<artifact>&surface=document|workspace&mode=preview|annotate|edit&lock=preview`.
- **Exactly one route is tokenless**: `GET /api/handshake`. Presentation-token redemption is
  Bearer-less but same-origin + Host-checked (`presentation-redeem` route class). Every other
  route, including SSE streams, requires the Bearer header. Missing/invalid token → `401 unauthorized`.
  Expired, unknown, and replayed presentation tokens also return `401` without revealing which.
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
- `GET /api/handshake` is the first call the SPA makes on load, before it has a token, so it can
  render the right one of the three failure screens (daemon unreachable / unpaired / contract
  mismatch) instead of a generic error. It carries the SPA's three fields
  (`contract_version`, `daemon_version`, `paired`) plus the daemon-lifecycle identity
  `ensureDaemon` matches against the lock (`build_id`, `install_id`, `protocol_version`,
  `instance_id`, `pid`, `started_at`) and `serves_socket`. Two compatibility checks share one
  route — see §5.1 for the full body and A3 §4 for why publishing all of it is safe.

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

Base URL: `http://127.0.0.1:<port>` or `http://glosa.localhost:<port>` (A3 §4 Rule 1). Browsers
are linked to the second; programmatic clients use the first. `:slug` is the workspace slug (R1). Every `:path` /
`:artifactPath` param is validated per §6 before use.

### 5.1 `GET /api/handshake`
No auth, Origin-gated only. **200** always (on the TCP listeners the Host/Origin allowlist is the
only rejection path: 400 for Host, 403 for Origin, per §1; on the socket neither applies).
```json
{ "contract_version": "1.18", "daemon_version": "0.3.1", "paired": true,
  "protocol_version": "1.0", "build_id": "0.3.1-1a2b3c4d5e6f7a8b",
  "install_id": "9f8e7d6c5b4a3210", "instance_id": "gl-2f6c…", "pid": 41822,
  "started_at": "2026-07-20T10:00:00Z", "serves_socket": true }
```
The first three fields are the SPA's; the rest are the daemon-lifecycle identity `ensureDaemon`
matches against `daemon.lock`, which publishes the same values to any local reader (A5 §F13).
Every one is deliberately non-secret — A3 §3.2's guarantee assumes they are public rather than
resting on their being private. `install_id` is a hash and `serves_socket` a boolean for the same
reason: no filesystem path may appear on a tokenless endpoint.

`serves_socket` reports whether this daemon serves `<GLOSA_HOME>/run/api.sock`. A client that
needs it treats an absent field as `false` and fails closed naming the recovery, rather than
falling back to the port — see A3 §3.2 on why a fallback would forfeit the whole defense.

### 5.2 `GET /api/workspaces`
Bearer required. Lists the live registry (R1 sources: live-session cwds, `.glosa/`-marked
dirs, manually opened dirs).
- **200**
```json
[{ "slug": "workspace-a1b2c3", "path": "/Users/example/Documents/workspace", "kind": "directory",
   "last_seen": "2026-07-20T10:00:00Z", "has_attention": false }]
```
`kind` (`"directory"` or `"loose-file"`) was added in contract 1.11. There is no route that creates a
workspace from a path the SPA supplies: a new directory is opened from the terminal (`glosa open
<dir>`, R8). The SPA can reopen a directory only through a star (§5.21), whose path the daemon
recorded from a registration it already held.

### 5.2b `GET /api/status`
Bearer required (authed read). The CLI-facing aggregate behind `glosa status`/`doctor`:
`{daemon:{…}, workspaces:[{slug, path, last_seen, pending_count, has_attention, connect?, live_updates?}],
sessions:[…], orphaned_state:[{registration_id, pending_count}]}`. `orphaned_state` (additive,
issue #79) lists `~/.glosa/state/<id>` buses whose journal still derives pending entries but whose
registration is gone — stranded user work recoverable by re-opening the original path
(deterministic registration ids reclaim the surviving bus). A scan failure degrades to `[]`; the
route never fails over it. The former `wiring` field is gone (#152): connection state is derived
from `sessions[]` (explicit `workspace_binding` + `liveness`) and nothing else.

Contract 1.16 (issue #306) additively adds `push:{connected,transport}` to every session row —
the identical shape `GET /api/sessions/:id/stream/status` (§5.9) already returns, read from
`SessionPushRegistry` alone. `transport` is `monitor`, `codex_app_server`, or `null`. This is a
delivery-transport fact about ONE SESSION, not a workspace-connection fact: it must not be used to
decide whether a workspace is connected, bound, or stale — that derivation remains
`workspace_binding` + `liveness` and nothing else, as above. It answers only whether a durably
queued entry could additionally reach this session by push at the instant of the read, with no
promise it still holds a moment later. `source` is NOT a substitute: an explicit bind overwrites
it with `mcp`, erasing the monitor's only trace. An N-1 daemon omits the field, and an absent
field means "this daemon cannot say" — never `connected:false`.

Contract 1.15 (issue #219) additively adds `live_updates` for an eligible registered workspace:
`{state:"live"|"starting"|"offline_catchup", reason?}`. `reason` is required only for
`offline_catchup` and is one of `workspace_budget`, `tracked_artifact_budget`,
`initial_scan_failed`, `watch_start_failed`, or `watch_error`. It is runtime diagnosis, never
journal truth, and contains no paths, counts, or session identity. An N-1 daemon omits the field;
an N-1 client ignores it.

The two `pending_count` fields in this response are DIFFERENT signals and disagree on purpose
(issue #153, A5 §F23). A workspace row's is BADGE-facing and excludes `external_edit`; it is the
only field the SPA's agent-feedback badge reads. Each
`orphaned_state` entry's is RETENTION-facing and still counts an undismissed `external_edit` — that
is stranded user work, which is exactly what the scanner reports.

Contract 1.8 (issue #156) additively adds `lifecycle: "forgetting"` to a workspace row whose
`glosa forget` deletion is durably committed — possibly mid-resume after a crash. Present ONLY on
a row in that state (absent, never `null`, for every ordinary workspace); a workspace row appears
here even once its on-disk path is gone (`present:false`) while this field is set, so an
interrupted deletion stays discoverable regardless of worktree presence. `doctor` and `glosa
status`'s human output both print the exact resume command, `glosa forget <slug> --yes`, for any
row carrying this field. Contract 1.16 additively adds that same sentence as a `remedy` string on
the row, present only beside `lifecycle`, so a JSON consumer prints the daemon's words instead of
composing a third copy that drifts.

Contract 1.5 additively permits this workspace field (optional for N-1 clients):

```json
{
  "connect": {
    "providers": [
      { "provider": "provider-id", "display_name": "Provider name", "instruction": "Provider-owned current-session binding guidance." }
    ],
    "cli_fallback": "glosa session bind <current-session-id> --workspace <workspace-path>"
  }
}
```

The provider package owns `display_name` and `instruction`; the daemon supplies only workspace
identity and the generic CLI fallback. Reading this field has no registration or binding side effect.
Session rows retain their existing `workspace_binding` and `liveness` fields. A client derives an
explicit connection as follows: any alive row whose `workspace_binding` equals the workspace path is
connected; otherwise any stale explicit row is stale; otherwise it is unbound. Cwd-ancestor routing
does not count as an explicit connection.

A session that registers from a directory INSIDE a registered workspace is given that workspace as
its `workspace_binding` and therefore reads as connected here (#146). That is not cwd-ancestor
routing being promoted: the binding is stored on the row, and the derivation above is unchanged.
Registering does not mint a workspace for the subdirectory, so the alternative would be a session
reachable from nothing — R2's cwd fallback matches a session sitting above a workspace, never one
inside it. `cwd` keeps saying where the process runs, and an explicitly supplied binding always
wins over this inference.

### 5.18 / 5.19 — removed (#152)
`GET /w/:slug/wiring` and `POST /w/:slug/init` (the consent-gated `glosa init` trigger from issue
#80) no longer exist; both answer **404**. There is no installation state to report and nothing for
the daemon to install: connection state (§5.2b `sessions[]`, #95) is the only signal, and Claude is
wired by its plugin, Codex by `codex mcp add`.

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
Bearer required. `:path` is workspace-relative and follows §6's encoding rule and confinement.
Query param `?render=html` requests server-rendered HTML with `data-line` stamps for class R; omit for raw source.
Class F artifacts return metadata only — actual HTML is never served through this route (§7).
- **200** (class R, `?render=html`)
```json
{ "source_path": "07_manuscript.md", "source_sha256": "…", "class": "R", "valid_utf8": true,
  "content": "<raw markdown>", "rendered_html": "<div data-line=\"1\">…</div>" }
```
`valid_utf8` (contract 1.12) is always present on a class-R response, raw and rendered alike, and
never on a class-F one. `false` means the file's bytes are not decodable UTF-8: `content` is then a
lossy decode with every undecodable byte replaced by U+FFFD, and `rendered_html` is rendered from
that same lossy string. Both are **preview only** — `source_sha256` hashes the lossy decode too, so
`If-Match` cannot detect the difference, and a client that writes `content` back destroys the bytes
it could not read. The daemon refuses such a write itself (§5.4a `not-utf8`); a client that also
reads this field can say so before the writer types anything, which is what the SPA does by not
offering Edit at all.
- **200** (class F)
```json
{ "source_path": "output/document/rendered-preview-2026-07-20.html", "source_sha256": "…",
  "class": "F", "manifest_path": "output/document/chunks-2026…/manifest.json" }
```
- **400 invalid-path** — the path is malformed or escapes the workspace root (§6).
- **404 not-found** — path within workspace but no such artifact (including a file the
  tracked-artifact rule excludes).

### 5.4a `PUT /w/:slug/artifacts/:path`
Bearer required, Origin-gated (state-changing route, per R5). `:path` is workspace-relative and
follows §6's encoding rule and confinement. Body is bare source text, or JSON `{"content": "<source>"}`; either form is accepted, and an empty body is rejected. Optional
`If-Match: <source_sha256>` header requests optimistic concurrency: when present and it no longer
matches what is on disk, the write is refused rather than applied — this is what the Edit-mode
stale-save dialog keys on (R6). The comparison is over
`source_sha256`, which normalizes `\r\n`→`\n` before hashing, so a disk change that alters only a
file's line endings does NOT refuse the write; the body is still written verbatim (A4 §F05, #251).
- **200**
```json
{ "source_path": "07_manuscript.md", "source_sha256": "…", "class": "R",
  "content": "<saved source>", "rendered_html": "<div data-line=\"1\">…</div>" }
```
- **400 invalid-path** — the path is malformed or escapes the workspace root (§6).
- **400 validation-failed** — request body is empty.
- **404 not-found** — path within workspace but no such artifact.
- **409 source-changed** — `If-Match`'s `source_sha256` no longer matches what is on disk; nothing
  was written. Distinct from the `workspace-adopting` `409` that can also reach this route (§9) —
  a caller must discriminate on `type`, never on a bare `409` status.
- **409 not-utf8** (#250) — the file on disk is not valid UTF-8, so saving would rewrite bytes
  glosa cannot read; nothing was written. Checked BEFORE `If-Match`, so such a file never answers
  `source-changed` — that slug is what routes a client into a stale-save merge, and every outcome
  of one would write a replacement-character decode back over the original bytes. Refusal is
  unconditional: there is no header or body form that makes this write proceed.
- **409 source-changed**, a second way (contract 1.17, issue #155) — the save WAS written, and when
  re-read the file no longer held the written bytes: another writer landed in the same instant. Disk
  is recorded as `unknown`, no `human` checkpoint is taken, and the client re-runs the same stale-save
  choice against the bytes actually there.
- A save is never refused because an agent holds a claim on `:path` (contract 1.17; `drift-under-lease`
  is retired). The human wins: when the holder's edits are still on disk, the claim is released
  `by:"human"`, those edits are recorded as `unknown`, and the save then proceeds (A4 §F05).

### 5.5 `GET /w/:slug/stream`
Bearer required. Artifact/journal SSE stream — full protocol in §7... see §8 (SSE resync).
Query param `?since=<cursor>` is the documented fallback for `Last-Event-ID` (see §8).
- **200**, `Content-Type: text/event-stream`, connection held open.
- **404 not-found** — unknown `:slug`.

### 5.6a `GET /w/:slug/annotations`
Bearer required. Every annotation still on the record, oldest first (journal order). Optional
`?path=<artifact path>` scopes it to one artifact — what a pane asks for when it opens one.
This is the route that makes the annotation surface durable: cards, in-text underlines, gutter
dots and the offer to undo an applied change are all repainted from it, so they survive a page
reload, a second pane on the same artifact, and a daemon restart.
```json
{ "annotations": [
  { "id": "inb-1721470000-a1c2", "status": "applied", "artifact_path": "07_manuscript.md",
    "body": "consider tightening this", "intent": "content",
    "target": { "quote": { "exact": "…" }, "position": { "start": 1204, "end": 1240 } },
    "captured_rendered_sha256": "<sha256>", "attempts": 1,
    "rollback_pre_sha": "<shadow-git sha>" } ] }
```
- `attempts` counts `delivery_attempt` events — a separate axis from `status` (R3).
- `rollback_pre_sha` is `apply_end.detail.pre_sha` (A4 §F05): present only once a lease has closed
  on the entry and recorded both ends of its interval. Its absence means glosa cannot prove a
  "before", so no undo is offered.
- A note the human withdrew in glosa is **not** listed. The journal keeps it (nothing is deleted);
  the listing is the pane's live view, and putting a removed card back on the page would undo the
  removal. A note a *session* declined — the same terminal `rejected`, distinguished by
  `transition_committed.detail.withdrawn` — **is** listed, because "they said no" is the answer the
  reader was waiting for.
- An entry whose immutable inbox payload cannot be read is skipped rather than failing the
  request: one damaged file must not cost the reader every other note on the page.
- **404 not-found** — unknown `:slug`.

### 5.6 `POST /w/:slug/annotations`
Bearer required, Origin-gated (state-changing route, per R5). Body per R3's `annotation`
payload shape.
```json
{ "artifact_path": "07_manuscript.md",
  "captured_rendered_sha256": "<sha256>",
  "body": "consider tightening this", "intent": "content",
  "target": { "chunk_id": "chunk-004",
              "quote": { "exact": "…", "prefix": "…", "suffix": "…" },
              "position": { "start": 1204, "end": 1240 } } }
```
- **201**
```json
{ "id": "inb-1721470000-a1c2", "status": "pending" }
```
- **400 validation-failed** — missing `artifact_path`/`body`/`intent`/`target.quote.exact`, or `intent` not
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
- **409 session-selection-required** — multiple equally eligible live transcript-bearing sessions;
  the response exposes only `{session_id,provider,last_active_at}` candidates and never guesses.

### 5.9 `GET /w/:slug/inbox`
Bearer required. Summary for the sidebar badge and attention tray. Immutable request fields are
read from the inbox entry; status and terminal detail are derived only from journal replay.
- **200**
```json
{
  "pending_count": 2,
  "attention": [{
    "id": "inb-…", "created_at": "…", "status": "delivered",
    "message": "Please review this draft", "action": "review",
    "target": "draft.md", "target_path": "draft.md", "approval_mode": false
  }]
}
```
`target` remains a compatibility alias. New consumers use `target_path`; legacy immutable entries
that stored `path` are projected into both fields. `approval_mode` is always a boolean.

`POST /api/workspaces/attention-request` accepts the existing workspace `path`, optional `message`,
`action`, and `target_path`, plus optional `approval_mode`. `approval_mode:true` requires
`target_path` to resolve to an existing tracked artifact; the daemon stores its normalized relative
path and permits at most one non-terminal approval-mode request per workspace/path. A duplicate
returns **409 approval-conflict**. Omitting the flag preserves ordinary review behavior.

It also accepts three optional fields that let a session point at a passage and ask about it:

| Field | Shape | Bound |
|---|---|---|
| `agent_label` | string | 64 bytes |
| `target` | `{ "quote": { "exact", "prefix"?, "suffix"? } }` | exact 2048 bytes, context 256 each |
| `answer_options` | array of distinct non-empty strings | 1–8 entries, 96 bytes each |

`target` carries no offsets by design: a session quotes source markdown it just wrote and has no
view of the rendered container, so the SPA resolves the quote source→rendered and reports an
unlocatable or ambiguous quote as unanchored rather than marking a guess.

`agent_label` is CLAIMED, never verified. The daemon stores it verbatim and the SPA renders it
beside — never merged into — the provider identity, which is the only half a session binding
proves.

`answer_options` never closes the human's vocabulary: glosa always offers free text alongside them.
All three are validated before the workspace is registered or an entry id is minted, so a rejected
request leaves nothing behind. Violations return **400 validation-failed**.

### 5.10 `POST /w/:slug/inbox/:id/seen`
Bearer required, Origin-gated. Advances a delivered attention request to `seen`. If presentation and
the user action race, the daemon appends any required `delivered` then `seen` transitions under the
workspace mutex. Repeats are idempotent.
- **200** `{ "id":"inb-…", "status":"seen" }`
- **404 not-found** for an unknown id or a non-attention entry.

### 5.11 `POST /w/:slug/inbox/:id/response`
Bearer required, Origin-gated. Completes attention through `seen→done` and stores the structured result
in `done.detail`.
```json
{ "outcome": "done | approved | changes_requested", "response": "optional bounded text", "chose": "optional option" }
```
For action `review`, only `approved` and `changes_requested` are valid; generic actions require `done`.
The optional response is at most 4096 UTF-8 bytes. `chose` names the option the human picked and is
rejected with **400 validation-failed** unless the request actually offered it — accepting an
unlisted string would let a client invent a verdict the session never wrote. It never replaces the
response text; the two travel together. Repeating a completed request returns its original
terminal result and appends no journal event.
- **200** `{ "id":"inb-…", "status":"done", "detail":{...} }`
- **400 validation-failed** for an invalid action/outcome pair or oversized response.
- **404 not-found** for an unknown id or a non-attention entry.

Approval-mode requests instead accept exactly:
```json
{ "outcome": "approved", "revision_id": "<source_sha256>" }
```
The daemon verifies that `revision_id` still identifies the target artifact, then stores and returns
this exact terminal detail:
```json
{
  "outcome": "approved",
  "target_path": "draft.md",
  "revision_id": "<source_sha256>",
  "completed_at": "<ISO-8601 timestamp>"
}
```
Mismatch returns **409 artifact-revision-changed** without completing the request. Terminal retries
return the original detail without re-validating the later working tree or appending a journal event.

### 5.11a `GET /api/workspaces/entry-status`
Bearer required. Reports one entry's derived status and terminal detail: `?path=<workspace>&entry=<id>`.

The optional `wait_ms` turns the read into a HELD request. The daemon subscribes to the workspace
journal and answers as soon as the entry reaches a terminal status, when the client disconnects, or
when the wait elapses — whichever comes first. This is what makes a blocking agent turn a single
waiting request rather than a poll loop: the journal write that answers the question is what wakes
it, so the turn resumes at the moment the human sends.

- **200** `{ "id", "kind", "status", "detail", "waited" }` — `waited:false` means the entry was
  already terminal when asked, which is the observable difference between "answered before I asked"
  and "I held the connection".
- **400 validation-failed** when `wait_ms` is not an integer in `0…900000`. A wait beyond the cap is
  refused rather than silently shortened, so a caller is never told it waited longer than it did; a
  caller wanting longer reissues the request.

The subscription is taken BEFORE the status is re-read. An entry can go terminal between an initial
read and the subscription, and that gap would otherwise strand the caller until its deadline. Like
every held response on this daemon (§8.3), this route disables Bun's default idle-connection close
for the life of the hold (`server.timeout(req, 0)`) — issue #153 Part 2 found this call missing here
(a latent bug the route's own in-process test could not observe, since it binds no real server) and
added it alongside the new watch route below, which needs the identical fix for the identical reason.

### 5.11b `GET /w/:slug/watch` (issue #153 Part 2)
Bearer required, authed-read. An opt-in held read over `external_edit` entries — the daemon-lifetime
watcher's quiet-window captures (§F153/A4) made actionable for exactly the session that asks, and no
other session. Never a status transition and never a nudge to anyone else: R3 states the product
promise this route implements. It writes nothing at all, and unlike `GET /w/:slug/stream` it does not
reconcile the workspace it reads. Hydration happens when a session attaches (§5.12, and a `register` that carries a `workspace_binding`); a watch that
finds an unhydrated workspace folds the journal read-only before answering, rather than serving the
empty derived state a fresh bus starts with.

`?session=<id>&path=<workspace-relative>&since=<full-sha>&wait_ms=<0…900000>` — `session` is
required and must be a live, registered session **explicitly bound** to this workspace (the same
requirement `POST /w/:slug/session-binding` establishes and the session stream already enforces).
`path` scopes the watch to one artifact; omitted, the whole workspace is in scope. `since` is a full
40-hex shadow-git checkpoint sha, an optional lower bound. `wait_ms` follows §5.11a's own rule exactly
(integer `0…900000`, refused rather than shortened) and this route disables Bun's idle-connection
close the same way (§8.3).

Without `since`, the cursor is authoritative and lossless: every in-scope, non-terminal
`external_edit` this session has not yet had `presented` via a watch, oldest journal order first, up
to the drain cap (eight entries / 32 KiB per response, §5.15's own bounds). `since` additionally
excludes entries whose checkpoint IS `since` or an ancestor OF it — everything at or before the point
the caller is resuming from — and keeps everything that descends from it; when ancestry cannot be
proven (e.g. after a baseline repair) the entry is INCLUDED — this cursor fails toward showing, never toward
silently dropping something the daemon cannot prove was already seen.

- **200**
```json
{ "entries": [ /* external_edit presentations, oldest first */ ], "latest_checkpoint": "3fae…|null", "has_more": false }
```
  `latest_checkpoint` is a SAFE resume watermark, not raw shadow HEAD: the full sha of the newest
  checkpoint every one of whose in-scope entries is now either in this response or already presented
  to this session. A response never advances it past a checkpoint it only partially returns (a
  checkpoint producing more entries than the per-response cap never yields a `since` a caller could
  use to skip the remainder) — `null` when no such checkpoint exists yet. `has_more:true` means: call
  again WITHOUT `since` to drain the rest, rather than resupplying this response's `latest_checkpoint`.
  Presented entries carry the same bounded, cursorable presentation §5.15 uses, with wording that
  states plainly the session is seeing this because it asked to watch. Self-echo is NOT filtered: an
  `external_edit` has unknown origin by construction (A4 §F05) and may be this session's own
  un-leased write.
- **400 validation-failed** — bad `wait_ms`, or `path` outside the workspace.
- **404 not-found** — unknown `:slug`, or `session` names no live registered session.
- **409 conflict** — `session` is registered but not explicitly bound to this workspace.

The hold ends — returning whatever the cursor currently has, honestly, even `entries:[]` — on: the
client disconnecting; `wait_ms` elapsing; `session`'s workspace binding changing or the session
deregistering (the binding this request captured is no longer authoritative); or this workspace's
bus closing (eviction, `glosa forget`). Two concurrent watches by the same session each keep their own
lease hold and neither cancels the other's; a watch never touches the session-stream's push
connection or lease key, so it neither closes nor is closed by a live monitor stream.

A watch never writes — not even the self-heal and checkpoint a reconciliation performs, which is why
it resolves its bus without one. Hydration happens where a session attaches: both
`POST /w/:slug/session-binding` and a `POST /api/sessions/register` that carries a
`workspace_binding` reconcile the workspace once, so offline catch-up lands when a session attaches
rather than waiting for some unrelated writer.

That is not assumed to have succeeded. A binding can outlive its bus (GC, `glosa forget`), and
hydration is best-effort, so a watch that meets an unreconciled bus folds the journal READ-ONLY
before answering — no self-heal, no lease expiry, no catch-up, no write — rather than serving empty
derived state, which a caller cannot tell apart from "nothing to report". Offline catch-up remains
the attach path's job, so drift that landed while the daemon was down is reported once a session
binds or registers, not by the watch. Attach hydration is best-effort: if its reconcile fails, the
drift it would have committed stays absent until the next successful writer reconciliation, and a
watch in the meantime reports the journal honestly without it. See `docs/decisions.md` — "Where a cold workspace gets
hydrated".

The client acknowledges receipt through the two routes below, mirroring the session stream's own
two-phase transport/presented split (§5.16).

### 5.11c `POST /api/sessions/:id/watch/transport-ack` (issue #153 Part 2)
Bearer required, Origin-gated (state-changing). Records that the HTTP body of a prior watch response
actually reached the caller — `delivery_attempt{via:"watch", session, outcome:"transport_accepted"}`
for exactly the named ids.
```json
{ "entries": ["inb-…", "inb-…"] }
```
- **200** `{ "accepted": ["inb-…"] }` — only ids a prior watch response actually emitted to `:id`,
  and that are still an `external_edit` entry belonging to its bound workspace; anything else is
  silently dropped from `accepted` rather than failing the whole call.
- **404 not-found** — `:id` names no session explicitly bound to a workspace.
- **409 conflict** — no named id was emitted to this session by a watch response, or none is an
  in-scope `external_edit`, or the session is no longer bound to this workspace. The last is read
  INSIDE the mutex that guards the append: the binding is captured before the body is read, and a
  rebind (including away and back, which restores every compared value) invalidates the generation
  the request was admitted under, so nothing is appended under authority that has moved.

Emission is tracked per session, in memory, with a short TTL. Scope is not sufficient on its own:
entry ids appear in ordinary reads, so accepting any in-scope `external_edit` would let a token
bearer record a delivery that never happened — and `5.11d` gates on exactly that record. A daemon
restart drops the emissions, which costs an un-ackable window (the entry stays undelivered and is
re-offered on the next watch), never a false attribution.

### 5.11d `POST /api/sessions/:id/watch/ack` (issue #153 Part 2)
Bearer required, Origin-gated (state-changing). Records `presented` (default) or `failed` after the
consumer (the MCP shim's `DeliveryAwareTransport`) has actually written the response carrying these
ids — never merely after the daemon built one. Refuses any id this session's watch never recorded
`transport_accepted` for first, the identical "no attempt without proven transport" rule
`eligibleDeliveryEntriesLocked`'s presented-suppression already assumes for every other `via`.
```json
{ "entries": ["inb-…"], "outcome": "presented", "error": "optional string, only with failed" }
```
- **200** `{ "accepted": ["inb-…"] }`
- **404 not-found** — `:id` names no session explicitly bound to a workspace.
- **409 conflict** — none of the named ids has an accepted watch transport for this session, or the
  session is no longer bound to this workspace (same generation check as §5.11c, read inside the
  append's own mutex).

### 5.11e `POST /api/workspaces/attention-withdraw` (contract 1.13, issue #310)
Bearer required, Origin-gated (state-changing). A session takes back its own open question, because
whoever was waiting on the answer has stopped listening — the MCP `glosa_ask` call was cancelled.
Path-addressed like §5.11a, since the caller holds a workspace directory rather than a slug.
```json
{ "path": "<workspace>", "entry": "inb-…", "session": "<session id>" }
```
- **200** `{ "id", "status", "withdrawn" }` — `withdrawn:true` wrote the terminal `expired` with
  `by: "session:<id>"` and `detail.withdrawn:true`. That `by` is the session's own CLAIM, not a
  lease-proven fact, exactly as `POST /api/workspaces/resolve`'s `deferred` already records one;
  the flag is the same key the annotation withdraw path writes, so a reader has one vocabulary for
  "taken back".
- **200** `{ "withdrawn": false }` on an entry that is already terminal — first-terminal-wins, so a
  human answer that raced the cancellation keeps the answer and nothing is appended. Idempotent on
  retry for the same reason.
- **404 not-found** — no such entry in this workspace, or it is not an attention request.
- **400 validation-failed** — `path`, `entry` or `session` missing or not a non-empty string.

A wait that merely ELAPSES does not call this: the question stays in the margin, which is what
`wait_seconds` promises. Shim shutdown and a crash also leave it open (A6 §F26).

### 5.11f Claims (contract 1.17, issue #155)
Per-resource claims replace the one apply-lease per workspace (A4 §F05). A resource is
`entry:<inbox id>` or `artifact:<workspace-relative path>`; an entry implies the file(s) it is about.
Agent routes are path-addressed and state-changing (Bearer + Origin), like `apply-begin`/`resolve`.
Claims are not authorization: any bearer may claim anything (A3).

**`POST /api/workspaces/claims`**
```json
{ "path": "<workspace>", "session": "<session id>", "resources": ["entry:inb-…", "artifact:notes.md"],
  "mode": "exclusive", "ttl_ms": 900000 }
```
`mode` defaults to `exclusive`; `ttl_ms` is optional and capped at the mode's TTL (15 min exclusive,
5 min presence).
- **201** `{ "claim_id", "fence", "expires_at", "paths", "mode", "renewed": false }` — `paths` are the
  workspace-relative paths covered; `[]` means the whole workspace (an entry that names no file).
- **200** the same body with `renewed: true` — this session already held these resources; the claim
  is extended and keeps its `claim_id` and `fence`.
- **409 claim-held** — another session holds an exclusive claim over overlapping paths. Extension
  members name the holder: `claim_id`, `holder_session`, `holder_principal`, `mode`, `since`,
  `expires_at`, `fence`; the `title` names the session too, since the CLI prints only the title.
- **409 claim-limit** `{scope, limit}` — 32 live claims per session or 256 per workspace.
- **404 not-found** — an `entry:` resource this workspace does not own.
- **400 validation-failed** — missing fields, an empty `resources`, a resource that is not
  `entry:`/`artifact:`, an absolute or escaping artifact path, a bad `mode` or `ttl_ms`.

**`POST /api/workspaces/claims/:id/renew`** `{path, session}` → **200** `{claim_id, fence, expires_at}`;
**409 claim-held** when `session` is not the holder; **409 claim-revoked|claim-expired|claim-superseded**
when the claim already ended; **404** when there is no such claim.

**`POST /api/workspaces/claims/:id/release`** `{path, session}` — the holder gives the claim up; `by`
is fixed to `"session"` by the route. **200** `{claim_id, released}`; `released:false` when it had
already ended (idempotent, never an error); **409 claim-held** when `session` is not the holder. What
the holder left on the claimed paths is recorded as `unknown`.

**`POST /w/:slug/claims/:id/release`** — the SPA's human override. Origin-gated like every SPA write
(no Origin → 403). `by` is fixed to `"human"` by the route and the release is never refused.
**200** `{claim_id, released, holder_session?}`.

**`GET /api/workspaces/claims?path=<workspace>[&artifact=<relative>]`** (authed read) →
**200** `{claims:[{claim_id, resources, artifacts, mode, holder_session, holder_principal, fence, since,
expires_at}], tombstones:[{resource, claim_id, holder_session, fence, ended_at, reason}]}`. Resources
are always `entry:`/`artifact:<relative>` strings, never an absolute path. `artifact` narrows to claims
covering that file.

**`GET /w/:slug/claims[?artifact=<relative>]`** (authed read) — the SPA's read of the same list,
addressed by slug with no `path` parameter; same body. The workbench reads it when a workspace opens
and on stream reconnect, then follows `claim_*` journal frames. **404** for an unknown slug.

**Changes to existing routes in 1.17:**
- `POST /api/workspaces/apply-begin` is an alias for an exclusive claim on `entry:<id>`: **201**
  `{entry, lease_id, pre_sha, fence, expires_at}`; the same session again → **200** with `renewed:true`
  and the same `lease_id`; another session over the same paths → **409 claim-held** (was
  `lease-conflict`; the CLI maps both to exit 12).
- `POST /api/workspaces/resolve` accepts an optional integer `fence`. The same session repeating a
  resolve it completed gets **200** with the original `lease_id`/`post_sha` and `replayed:true`, and
  nothing is appended. Refusals, all evaluated before anything is written: **404 not-found** (unknown
  entry), **409 entry-resolved** `{terminal_by, entry_status}`, **409 claim-revoked | claim-expired |
  claim-superseded** (tombstone members: `claim_id`, `holder_session`, `fence`, `ended_at`, `reason`),
  **409 claim-held** (holder members, as above), **409 no-claim**. Every one is exit 8 in the CLI.
- `POST /api/workspaces/inbox/dismiss` and `POST /w/:slug/annotations/:id/withdraw` answer an already
  closed entry with **409 entry-resolved** (was `conflict`). A dismiss over a claimed entry releases the
  claim `by:"human"` and names it in an additive `released:[{claim_id, holder_session}]`.
- Delivered presentations (§5.15) may carry `claims:[{session, principal, mode, since, fence}]`.
- `GET /api/workspaces/inbox` rows carry `holder` — the session holding a live claim, or `null`.
- `GET /api/status` session rows carry `principal` (reporting only).

### 5.11g Signals (contract 1.17, issue #155)
A signal is a short notice telling one agent session what happened to the claims around it. They are
derived from claim events as the journal appends them, held in memory for 15 minutes, and lost on
restart. The journal event that caused each signal stays the durable record; nothing about a signal
is ever written back to the journal.

| Journal event | Addressee | Kind |
|---|---|---|
| `claim_released` with `by:"human"` | the holder | `conflict`: a person took the files over |
| `claim_expired` | the holder | `info`, naming the reason |
| `claim_taken`, `claim_released` | every other session routed to the workspace | `info` |

Nobody is told about their own action, and the holder of a human-released claim gets the `conflict`
only. Every record has exactly one addressee: "every other session" is resolved to the sessions
routed to the workspace (R2 `forWorkspace`) when the event is appended. At most 64 records are kept
per session, and when the cap is reached the oldest is dropped.

A signal reaches its session in three ways: as an `event: signal` frame on the session stream (§5.16,
sent live, and on connect for anything still unacknowledged); as `signals[]` on a drain response; and
from MCP `glosa_inbox_pull`. The frame is:
```json
{ "id": "sig-…", "kind": "conflict", "workspace": "<canonical path>", "resources": ["entry:inb-…"],
  "claim_id": "01J…", "message": "a person took over entry:inb-…: …", "created_at": "…",
  "expires_at": "…", "ack_token": "<32 hex>" }
```
`ack_token` appears only in the addressee's own copy.

**`POST /api/sessions/:id/signals/:signal_id/ack`** `{ack_token}` (Bearer + Origin) → **200**
`{signal_id, acked:true}`, with `already:true` added on a repeat. **404 not-found** when the signal does
not exist, has expired, is addressed to another session, or the token does not match. These cases
are indistinguishable by design, so the route reveals nothing about another session's signals.
**400 validation-failed** when `ack_token` is missing. An acknowledged signal is no longer offered.

### 5.12 `POST /w/:slug/session-binding`
Bearer required, Origin-gated. Registers or refreshes a session and explicitly binds it to the artifact workspace. This
is the authoritative routing path for CLI, MCP, and SPA callers; cwd ancestry remains a fallback.
```json
{ "session_id": "2b7f19a3-…" }
```
- **200** `{ "bound": true, "session_id": "2b7f19a3-…" }`
Optional body fields: `provider`, `cwd`, and `source` (nonempty strings). CLI/MCP supply process cwd;
a bare request defaults to the target workspace, provider `mcp`, and source `manual`. Known records
retain omitted metadata; generic identity may be enriched, but concrete provider conflicts fail.
- **404 not-found** — `:slug` unknown.
- **400 validation-failed / invalid-path** — malformed metadata or cwd cannot resolve.
- **409 session-provider-conflict** — a concrete provider conflicts with the existing identity.

Session registration (`POST /api/sessions/register`) merges omitted binding/transcript fields and
refreshes the lease. `POST /api/sessions/:id/heartbeat` returns 200 for known sessions, including
expired leases, and **404 session-not-registered** for unknown identities. Unknown-session drain
responses use the same type and title: “session not registered — re-register by calling any glosa
tool”. Clients preserve HTTP application errors; only discovery/connection failures are “daemon
unreachable”. `GET /api/status` session rows also expose `source` and `lease_expiry`.

An authenticated session push stream refreshes the same lease every 20 seconds while open.
Cancellation, replacement, credential revocation, and daemon shutdown release its handle. Closing
stops refreshes rather than immediately ending the session; existing lease expiry remains the truth.

### 5.13 `POST /w/:slug/capability/:artifactPath`
Bearer required, Origin-gated. `:artifactPath` follows §6's encoding rule and confinement. Issues
a capability URL for a class-F artifact. Full mechanics in §7.
- **200** `{ "url": "http://127.0.0.1:4647/doc/<token>/<artifactBasename>", "nonce": "…",
  "expires_in_s": 600 }`. `<artifactBasename>` in `url` is percent-encoded, so a browser requesting
  exactly that URL never mangles or truncates a space, `#` or `?` in the name. `nonce` is the
  bridge handshake secret (A3 §2).
- **400 invalid-path** — path confinement failure, or artifact is not class F.
- **404 not-found** — no such artifact.

### 5.14 Workspace metadata

The descriptor schema is `WorkspaceMetadataDescriptor` v1 from R7. These routes never include the
workspace canonical path or pairing token in their response.

- `GET /w/:slug/metadata` — **200** `{descriptor}`; **404** when none is active.
- `PUT /w/:slug/metadata` — Bearer + Origin; validates the entire descriptor before an atomic replace.
  Same id replaces; different id returns **409 conflict** and leaves the active descriptor unchanged.
- `DELETE /w/:slug/metadata` — Bearer + Origin; idempotently clears the descriptor and returns
  `{cleared:true}`.

Set and clear publish a best-effort `metadata` SSE invalidation without a journal cursor. Clients then
reload artifacts through the normal data-access module. Persisted metadata is reloaded when a workspace
opens, so daemon restart does not require re-registration.

### 5.15 Inbox presentation and delivery transaction

All routes require Bearer authentication; POST routes are Origin-gated.

- `GET /w/:slug/inbox/:id/presentation?cursor=<opaque>` returns one bounded actionable page for
  CLI retrieval. It is read-only and does not append a delivery attempt.
- `POST /api/sessions/:id/drain` prepares up to eight oldest-first actionable entries and returns
  `{delivery_id, drained, count, has_more}`. Prepared entries are reserved for 30 seconds; no
  `presented` event exists yet. An unbound session's request body may additionally carry an optional
  `scope` (a workspace path): when present, it — not the session's current registry `cwd` — decides
  which workspaces this one drain can reach, captured once at the request and used for the whole
  drain regardless of a registration landing on the same session id afterward. Additive and optional
  (issue #205); an explicitly bound session's drain never reads it, and a request with no `scope`
  behaves exactly as before, resolving from the row. The MCP `glosa_inbox_pull` generic path (no
  bound host session, no explicit `session_id`) is the only caller that sends it. On the unbound
  path — the only path that reads it — `scope` is canonicalised by the same rule
  `POST /api/sessions/register` applies to `cwd` (realpath → NFC → strip trailing slash) and must
  name an existing **directory**; anything else is refused with **400 invalid-path**, never
  silently downgraded to row-derived scope, since a caller that asked for an explicit scope must not
  be handed the behaviour it asked to avoid. Canonicalisation alone is realpath-only, so the
  directory check is a separate requirement and not a restatement of it. A bound session's drain
  neither reads nor validates `scope`, so a malformed one is ignored there rather than refused. A
  scoped drain, once admitted (the route has captured the session record and validated `scope`),
  completes on that captured scope even if the requesting session then deregisters or its lease
  expires before selection actually runs (issue #205 A10) — loss of the row afterward is not a
  second admission check, only its later redirection is prevented and its outright disappearance is
  survived the same way.
- `POST /api/sessions/:id/deliveries/:deliveryId/ack` with
  `{outcome:"presented"|"failed", error?:string}` consumes the reservation and appends the attempt.
  Missing/expired tokens return **409 conflict** and the entries remain eligible. A **composite**
  (`cmp_…`) token's acknowledgement does not require the session's registry row to exist (issue #205
  A10): the composite reservation already stores and checks its own session id, so a requester that
  deregistered or lease-expired after an admitted scoped drain completed can still acknowledge the
  transaction that drain produced. This is the composite branch only — an ordinary, non-composite
  delivery id still returns **404 session-not-registered** when the row is gone, since resolving
  which single workspace's bus to acknowledge against still needs it.

Each `drained[]` item is the R3 discriminated presentation object and is capped at 16 KiB UTF-8;
the serialized batch is capped at 32 KiB including separators. Continuations use the same opaque
cursor accepted by the retrieval GET and `glosa_inbox_get` MCP tool. A contract 1.6 daemon always
adds the canonical absolute `workspace` path to each structured presentation and prepends
`workspace: <path>` to its agent-visible text; both the label and separator count inside those
existing byte caps. Same-major N/N-1 client schemas continue to accept its absence from a 1.5 daemon.

A drain response (contract 1.17, issue #155) also carries `signals[]`: the session's unacknowledged
signals (§5.11g), oldest first, at most eight and 8 KiB. That budget is separate from the entry
caps and outside them, so a signal never displaces an entry. The field is present only when there is
at least one signal, so a drain with nothing to report is byte-identical to one from before signals
existed. A drain does not acknowledge a signal. It is offered again until the addressee acks it or
it expires.

An explicitly bound session prepares and acknowledges only its exact workspace. For an unbound
session, the daemon enumerates every present, active workspace for which the R2 `forWorkspace`
predicate includes that session, without selecting one descendant. It first plans candidates without
reserving or discarding them, then sorts by the durable entry-created/adopted timestamp. Ties use the
workspace registration id's raw UTF-8 byte order, followed by local journal order and raw UTF-8 entry
id; locale collation is forbidden. Only after applying the global count/byte caps does it reserve each
exact selected id. A contender, changed presentation that no longer fits, or constituent preparation
failure releases every reservation acquired by that attempt and returns an error; it never substitutes
a different entry or exposes a partial response. Entries omitted by either cap were never reserved.

One `cmp_…` token coordinates the constituent workspace reservations in memory. The coordinator
serializes preparation and acknowledgement, so duplicate acknowledgements cannot consume or cancel
one another's child reservations. Ordinary coordinator activity prunes expired composites and releases
only their unacknowledged children. Acknowledgement appends each workspace's ordinary
`delivery_attempt`; HTTP success is returned only after every append completes. This is coordination,
not a second source of truth and not a cross-file atomic write. If an append fails after a prefix
completed, the same-process retry skips that in-memory completed prefix and continues the suffix with
the same outcome. If the daemon instead crashes, the composite token and all
unacknowledged reservations disappear: completed journal attempts remain true, while the suffix is
eligible for a later drain. Retrying a lost token returns 409. Thus a crash may leave an honest journal
prefix, never a false all-or-nothing claim; no response reports full acknowledgement until all journals
completed.

### 5.16 Conversation composer delivery

`POST /w/:slug/transcript/compose` is Bearer-authenticated and Origin-gated:

```json
{ "message_id": "<client UUID, optional>", "text": "<exact UTF-8 text>", "session_hint": "<optional session id>" }
```

The daemon resolves only live sessions whose explicit `workspace_binding` equals the workspace;
cwd-ancestor fallback is forbidden. No binding returns **404 no-bound-session**; only stale bindings
return **409 bound-session-stale**; ambiguous live bindings return **409
session-selection-required** with only `{session_id,provider,last_active_at}` candidates. Blank or
over-16-KiB presentations return **400 validation-failed** and are never truncated.

The immutable `conversation_message` stores exact text and target session. Reusing an id with
different text or target returns **409 idempotency-conflict**. A failed attempt may re-nudge the same
entry; pending and delivered retries return journal-derived status without another entry. Every
attempt is fsynced before the response. **200** means terminal `presented`; **202** means `queued` or
`transport_accepted`.

`GET /w/:slug/transcript/compose/:message_id` returns the same status for reconnect recovery.
`GET /api/sessions/:id/stream` is the provider-neutral authenticated SSE surface. It emits every
eligible deliverable as the same bounded presentation MCP pull builds, including the parked queue,
and keeps one live connection per exact session. `POST .../stream/:entry_id/transport-ack` records
only transport acceptance; `POST .../stream/:entry_id/ack` records explicit presentation. The
Channel-era `GET /api/sessions/:id/push-stream` and `POST /api/sessions/:id/conversation/:id/ack`
routes are removed (#152): a conversation message reaches its session through the same stream or
through MCP pull, and `presented` comes from `glosa_delivery_ack` or the pull's own acknowledgement.
`POST /api/sessions/:id/drain` accepts only `via:"mcp_pull"`; any other value is **400**.

The same stream also carries `event: signal` frames (contract 1.17, issue #155), whose data is one
signal addressed to this session (§5.11g). They carry no `id:` line and share the stream's single
writer with deliveries, so the two never interleave. On connect the stream first sends every
unacknowledged signal for the session, oldest first, then follows new ones live. A client that does
not recognise the event ignores it, as it ignores any non-`delivery` event.

#### Replacement and ownership (contract 1.9, issue #206)

Registering a second stream for a session id closes the first, which is the documented replacement
path. The displaced connection now receives one terminal frame before that close:

```
event: superseded
data: {"transport":"monitor"}
```

`data.transport` names the transport that took the session. The frame is written **only** on
replacement. Daemon shutdown, token rotation or revocation, client cancellation and a send failure
all close the stream exactly as before, with no frame, so a client can tell "someone else owns this
session now" from "the connection dropped, retry". A client that does not recognise the frame
ignores it, as it ignores any non-`delivery` event, and falls back to its ordinary retry.

`GET /api/sessions/:id/stream/status` answers that question without opening a stream. Bearer
required, read-only: it registers nothing, sends no heartbeat, takes no session lease, and writes
nothing to the journal.

- **200** `{ "connected": true, "transport": "monitor" | "codex_app_server" }` while a live stream
  connection exists for that exact session id, and `{ "connected": false, "transport": null }` when
  none does. The answer comes from the push registry alone, so it is about the connection and not
  about the session's registration: a session id the registry holds no connection for — never
  registered, never streamed, or its stream already closed — answers `connected:false`, while a
  connection that outlives its registration (a `deregister` that leaves the stream open) still
  answers `connected:true` until that stream closes.
- Only a literal boolean `connected` is authoritative. A client that gets anything else — a missing
  field, a non-boolean, a non-2xx status, an unreachable daemon — has learned nothing and must not
  treat it as free.

A displaced client is expected to stop streaming and poll this route until it reports the session
free, rather than reconnecting immediately and displacing the new owner in turn (A2 F06).

### 5.20 `POST /api/workspaces/forget` (contract 1.8, issue #156)

Bearer required, Origin-gated. `glosa forget <slug> [--yes] [--json]`'s daemon-side half — the one
supported whole-bus deletion primitive (R1/R3/R8). Addressed by **slug**, not `path` like
`resolve`/`apply-begin`: the whole point of `forget` is that it must still work once a workspace's
on-disk path is gone, and a slug is the one identifier that survives that.

```json
{ "slug": "workspace-a1b2c3", "confirm": false }
```

`confirm` defaults to `false` — a pure preview: runs the exact same preflight a `confirm:true` call
would and returns the exact set of paths it would remove, but never marks, seals, or deletes
anything.

- **200** (preview, `confirm:false` or omitted):
  ```json
  { "slug": "workspace-a1b2c3", "confirmed": false,
    "would_remove": [{ "registration_id": "…", "slug": "workspace-a1b2c3",
                        "canonical_path": "/Users/example/project", "kind": "directory",
                        "bus_path": "/Users/example/project/.glosa" }],
    "member_fingerprint": "<sha256 hex digest of would_remove>" }
  ```
  `member_fingerprint` (held-review addition, still additive within contract 1.8) is a deterministic
  digest of `would_remove`'s member set. A `confirm:true` call echoes it back as
  `member_fingerprint` in the request body to prove it is acting on EXACTLY the set the human was
  shown — see **409 forget-stale-preview** below. Omitting it (e.g. a `--yes` commit with no
  preceding preview) skips this check entirely; the commit proceeds exactly as it always has.
- **200** (commit or resume, `confirm:true`):
  ```json
  { "slug": "workspace-a1b2c3", "confirmed": true, "removed": [ /* same member shape */ ] }
  ```
  `removed`/`would_remove` always name the COMPLETE provenance unit: the target plus every
  historical sealed loose-file source adopted into it (A4's "loose-to-directory adoption") — never
  a partial set, and never missing a member whose own registration was already removed by an
  earlier interrupted attempt (the daemon's durable operation record survives that). A retry after
  the deletion has fully completed still returns this same `confirmed:true` body (the idempotent
  completion receipt), never a `404`.
- `slug` in the response body always names the resolved TARGET. If the request named a sealed
  adopted source instead of its target, the body additionally carries
  `"requested_slug": "<the-source-slug-actually-named>"` — a source is never treated as an
  independent provenance unit; the daemon resolves it to the owning target and acts on the whole
  unit.
- **404 not-found** — `:slug` unknown and no forget operation (active or completed) matches it.
- **400 validation-failed** — missing/non-string `slug`, a malformed body, a `confirm` value that is
  present but not a boolean (a string/number/null/array/object `confirm` is a validation error, never
  silently reinterpreted as `confirm:false`), or a `member_fingerprint` value that is present but not
  a lowercase SHA-256 hex string (held-review addition — a non-string value was previously silently
  treated as omitted, bypassing the stale-preview check below entirely rather than being rejected).
- **409 forget-blocked** — a live bound session, an unexpired apply lease, or an in-progress
  adoption blocks deletion before any side effect. Body carries a structured `blockers` array
  (`{kind:"live-session",session_id}`, `{kind:"apply-lease",lease_id,expires_at}`, or
  `{kind:"adopting"}`) plus `slug` (the target) and, when applicable, `requested_slug` — same
  resolution rule as the 200 body above.
- **409 forget-stale-preview** (held-review addition) — a `confirm:true` call's `member_fingerprint`
  no longer matches the CURRENT member set for a target whose forget has not yet begun (e.g. an
  adoption committed a new sealed source between the preview and this call). Zero deletions occur.
  Body carries the FRESH `would_remove`/`member_fingerprint` pair inline, so a client can re-confirm
  in a second round trip without a separate preview call. Never reached on a resume — once the
  durable forget operation exists the member set is fixed for its life, so there is nothing left to
  go stale against.
- **500 internal** — a bus path failed confinement (a corrupted or foreign-pointing index record).
  Confinement is proven for the COMPLETE member set before a single destructive step, independently
  of the (possibly corrupted) `worktree_path`/`bus_path` pair itself — both are re-derived from
  `canonical_path` and the entry's `registration_id`/`kind` before either is trusted; refuses the
  whole operation rather than risk deleting the wrong thing.

Once committed, the target and every sealed source enter `lifecycle:"forgetting"` (§5.2b) —
**every other route refuses ordinary routing to any of them** with `409 workspace-forgetting`
until the deletion (or its resume) finishes, including `GET /api/workspaces/inbox?path=` (held-review
addition — this path-addressed route now resolves its path to a registration and checks its, and
its adoption owner's, lifecycle exactly like every slug-addressed route) and every route that shares
`resolveBus` (`resolve`, `apply-begin`, `inbox/dismiss`, a bound session's own drain/delivery-ack, and
conversation acknowledgement — held-review addition, third pass). Session registration and binding
(§5.12, `POST /api/sessions/register`), and a session's own heartbeat/connection-refresh (held-review
addition — extending an expired lease never revives liveness for a forgetting target), share the same
per-target ownership lock/lifecycle check this commit holds while it re-checks liveness and writes
its durable marker, so none of them can land mid-commit and none races the other's liveness check:
all refuse (or, for heartbeat/refresh, silently withhold the lease extension) once a target is
durably being forgotten. Work-tree files are never touched by any of this — only the registration and
its bus (journal, inbox, shadow-git).

This refusal survives past the moment a target's own registration is fully removed but before its
durable operation's completion receipt lands (held-review addition) — `POST /api/sessions/register`,
`POST /api/workspaces/open`, `GET /api/workspaces/inbox?path=`, every route sharing `resolveBus`, an
unbound session's composite drain, and a session's own heartbeat/connection-refresh (held-review
addition, third pass — the owning registration id and the forgetting check both now fall back to the
active operation record when no live registration remains) all additionally check for an active
(uncompleted) forget operation naming the exact canonical path before treating a currently-
unregistered path as brand-new; a completed receipt never blocks a legitimate reopen. Without this,
the gap between deregistration and completion read as "never seen this path before" and let a fresh
registration (or a fresh loose-file/directory registration via `open`, or a revived session lease, or
a self-healed drain registration) land on a path forget was still mid-deleting. For `open` specifically
(held-review addition, final pass) this check runs INSIDE `WorkspaceIndex.resolveOpenTarget`'s own
mutex critical section — the same one that performs the resolve/register mutation — rather than as a
separate pre-check the route ran beforehand: a pre-check outside that critical section could still be
separated from the mutation it gated by an intervening forget step landing in between the two.

Every direct "get-or-register" fallback (the `index.get(path) ?? index.upsertWorkspace(path, source)`
shape) is now routed through one shared boundary, `getOrRegisterWorkspace` (held-review addition,
fourth pass) — an unbound session's composite-drain cwd self-heal, an EXPLICITLY bound session's own
`POST /api/sessions/:id/drain`, and `POST /api/workspaces/attention-request`'s workspace creation all
call it instead of `upsertWorkspace` directly. The active-operation check runs BEFORE the upsert, not
layered on after inside `resolveBus`: a direct `upsertWorkspace` call would otherwise durably recreate
an ACTIVE row the instant it ran, during the exact registration-less window described above, and a
SUBSEQUENT `resolveBus`/`workspaceBus` call would then find that live, non-forgetting row and never
even reach its own registration-less check. The explicitly-bound drain and attention-request routes
return `409 workspace-forgetting`; the composite-drain self-heal (an aggregate route across many
workspaces, not addressed at one) catches the refusal and simply leaves its candidate set empty.

The live-session blocker (`{kind:"live-session",...}` above) also recognizes a session still
explicitly bound to a loose-file source's OWN pre-adoption canonical path once that source has been
sealed into a directory target (held-review addition, third pass) — adoption does not rewrite an
already-bound session's `workspace_binding`, so the preflight liveness check resolves it through the
same provenance-owner alias resolution session register/bind already use, rather than comparing
raw paths.

A resumed commit's deletion candidates are drawn EXCLUSIVELY from the durable operation's own
immutable member snapshot (held-review addition, third pass) — never from a fresh scan of
`lifecycle:"forgetting"` rows, which an inconsistent index state could otherwise use to smuggle an
unrelated bus into the deletion. A live entry marked `"forgetting"` for this target that is not named
by the snapshot fails the whole resume closed (**500 internal**, confinement-failed) rather than
being silently included or silently ignored.

A pending forget operation whose target registration has been fully removed (a crash between
deregistration and the operation's completion receipt) still surfaces in `GET /api/status`
(held-review addition) as a synthesized workspace row — same shape as every other row, `present`
omitted — carrying `lifecycle:"forgetting"` and the target's last-known `path`, so `doctor`'s exact
resume command (`glosa forget <slug> --yes`) remains discoverable even with no live registration
left to anchor a path-keyed lookup on. `path` is always the target's durable WORKTREE path (held-
review addition, final pass) — for a `loose-file` target that is the containing directory `doctor
<dir>` is invoked against, never the raw file path, matching every other row's own `path` field.

### 5.21 Starred workspaces (contract 1.11)

A star is the writer's bookmark for a directory they come back to. Stars live in
`~/.glosa/stars.json` (atomic temp → fsync → rename, 0600), apart from the workspace index, so a
star outlives the index's GC removing the directory's registration. A star's `id` is 16 hex
characters derived from its canonical path, so starring the same directory twice is one star.
Stars list alphabetically by folder name.

**No star route accepts a path.** Starring names a present registration by slug and records that
registration's own canonical path; reopening names the star by id. See A3 §4 "Starred workspaces".

- `GET /api/stars` — Bearer required (authed read). **200**:
```json
[{ "id": "3f9c0a1b2c3d4e5f", "name": "workspace", "path": "/Users/example/Documents/workspace",
   "starred_at": "2026-09-17T10:00:00.000Z", "state": "open", "slug": "workspace-a1b2c3",
   "has_attention": false }]
```
  `state` is `open` (a present directory registration serves exactly this path; `slug` and
  `has_attention` are present only then), `closed` (the folder exists but glosa is not serving it),
  or `missing` (the folder is gone or is no longer a directory).
- `POST /api/stars` `{ "slug": "workspace-a1b2c3" }` — Bearer + Origin (state-changing). Idempotent.
  **200** with the star row. **400** `validation-failed` (no slug), **404** `not-found` (no present
  registration with that slug), **422** `star-not-directory` (a loose-file registration).
- `POST /api/stars/:id/unstar` — Bearer + Origin. **204**; **404** `not-found`.
- `POST /api/stars/:id/open` — Bearer + Origin. Reopens the star's path through the same code path
  as `POST /api/workspaces/open` and answers with its body (`{slug, path, kind}`) and its errors.
  **404** `not-found` (unknown id), **422** `star-folder-missing` (checked before the index is
  touched; the star is kept until the writer unstars it).

### 5.22 Opt-in dictation (contract 1.14)

These routes expose a provider-neutral input capability. They never accept audio, context, transcript,
workspace, artifact, path, session, or participant data. Provider-specific token exchange and browser
wire formats remain in provider packages.

- `GET /api/dictation/status` — Bearer required (authed read), always `Cache-Control: no-store`.
  It checks only local versioned consent and credential presence; it never contacts a provider.
  **200** with exactly one state:
```json
{ "state": "unconfigured" }
{ "state": "ready", "provider": "wispr-flow", "display_name": "Wispr Flow",
  "client_module": "/app/providers/wispr-flow/browser.js" }
{ "state": "error", "provider": "wispr-flow", "display_name": "Wispr Flow",
  "code": "credential-unavailable", "message": "the Wispr Flow organization key is unavailable" }
```
- `POST /api/dictation/session` — Bearer + Origin (state-changing), no request body, always
  `Cache-Control: no-store`. It is the only daemon route that may contact the configured provider:
  for Wispr Flow, it reads the organization key from Keychain and requests a 600-second client JWT
  with only the persisted random client UUID and lifetime. No user, workspace, artifact, document,
  path, filesystem, session, or participant metadata is included. **200**:
```json
{ "provider": "wispr-flow",
  "websocket_url": "wss://platform-api.wisprflow.ai/api/v1/dash/client_ws",
  "access_token": "<short-lived JWT>", "expires_at": "2026-09-21T10:10:00.000Z" }
```
  The response is renderer-memory-only. API keys, JWTs, token-bearing URLs, audio, context, and
  transcripts are never logged. The provider request has a ten-second timeout and no retry.
  Typed failures are `409 dictation-unconfigured`, `429 dictation-rate-limited`,
  `502 dictation-authentication-failed|dictation-invalid-response|dictation-provider-unavailable`,
  `503 dictation-credential-unavailable`, and `504 dictation-timeout`; details never forward provider
  response bodies or credentials. Retry is a new foreground user action.

## 6. Path confinement (canonical rule, applies to every `:path`/`:artifactPath`/`<path...>`)

**Encoding.** A path capture in a URL is percent-encoded per RFC 3986, one `/`-delimited segment at
a time (what `encodeURIComponent` per segment produces). The daemon decodes it exactly once, before
step 1. A malformed escape (a lone `%`, a truncated or invalid UTF-8 sequence) is a path refusal,
never a 500: `400 invalid-path` on the main listener, the plain `404` of §7 on the class-F
listener. Because decoding happens once, `%252e%252e` names the literal file `%2e%2e`, not `..`.

1. Before touching the filesystem, reject an empty path, a path longer than 4096 characters or
   with more than 64 segments, a leading `/` (must be workspace-relative), any ASCII control
   character (C0, including NUL, or DEL), and any `..` segment — `400 invalid-path`.
2. Resolve `path.resolve(workspaceRoot, requestedPath)`.
3. `fs.realpath()` `workspaceRoot` and the resolved path, or, when the leaf does not exist yet, its
   nearest existing ancestor. The result MUST equal the root's realpath or start with it plus
   `path.sep`. This is what catches a symlink inside the workspace pointing outside it
   (realpath-confine, per F24). Fails → `400 invalid-path`.
4. Re-apply the tracked-artifact rule (R1 include/exclude globs, size ≤2 MB) — a path that
   resolves fine but isn't a tracked artifact is `404 not-found`, not `400`, since path
   validity and artifact-membership are different failure classes worth distinguishing in logs.

## 7. Class-F capability-URL issuance

Locked decisions (F02/F03) require: no Bearer token ever reaches the class-F origin, iframe
`src` navigation can't carry an `Authorization` header anyway, and the document must be served
from a **separate loopback port** with no ambient credential.

- The daemon runs a second `Bun.serve` listener on a second port (`GLOSA_CLASSF_PORT`, default
  `<GLOSA_PORT>+1`), bound `127.0.0.1` only, serving `GET /doc/:token/<path...>`. `<path...>` follows §6's
  encoding rule.
- `POST /w/:slug/capability/:artifactPath` (§5.13, main origin, Bearer-authed and Origin-gated) mints a token:
  256-bit random, stored server-side in an in-memory map
  `token → {slug, artifactDirRealPath, artifactBasename, nonce, expiresAt}`. **TTL 600s (10 min).**
  Restart invalidates all tokens (in-memory only — acceptable for a local tool).
- **The capability is directory-scoped and multi-request, NOT single-use.** This is required
  for correctness: a class-F document (e.g. rendered-preview HTML) loads sibling assets — its own
  `document-notes.css`, `annotate.js`, images — so the token must serve the document **and** its
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
  `400 invalid-path` (§5.13) — class R is served in-band via §5.4, never through this listener.

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
   Live filesystem invalidations are advisory and carry no `id`: `event: artifact` contains an
   upserted artifact's `{path,class,source_sha256}`, while `event: artifact_index` contains
   `{changes:[{type:file_tracked,path}|{type:file_untracked,path,reason}]}` so clients can refresh
   their artifact list after additions, deletions, or size-threshold crossings. Older clients may
   ignore either event and recover from the next snapshot.
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
  1. The daemon disables the idle timeout PER REQUEST, on the held ones only: `server.timeout(req, 0)`
     called from the handler that is about to hold (the SSE streams and `GET /w/:slug/watch`). Not a
     `Bun.serve({ idleTimeout })` option — that is server-wide and cannot be scoped to a route, so
     using it would either leak sockets on every hung request or keep closing the held ones. Every
     other request keeps the server's normal timeout.
  2. **Belt-and-suspenders**: the daemon also emits `event: heartbeat` (empty `data`, no `id` —
     heartbeats don't advance the cursor) every **15s** on every open stream connection,
     regardless of real event traffic. This covers any intermediary (a future reverse proxy, a
     browser's own aggressive socket reaping) that isn't Bun's idle timeout specifically. The
     client's parser drops `heartbeat` events silently; the client's own inactivity watchdog
     considers the connection dead (and triggers §8.2's reconnect) only if it sees no bytes
     (not even a heartbeat) for >45s (3 missed heartbeats).
5. Client reconnect backoff: 250ms base, ×2 factor, capped at 5s, ±20% jitter — standard
   thundering-herd avoidance, irrelevant at single-client scale but free to specify once.

A bounded HELD request (§5.11a `entry-status`, §5.11b `watch`) needs only mitigation 1
(`server.timeout(req, 0)` for that one request) and never mitigation 2: it always answers within
its own `wait_ms` cap (≤900s), so there is a fixed upper bound on how "quiet" the connection can ever
be and no heartbeat is needed to keep an intermediary convinced it is alive. Issue #153 Part 2 found
`entry-status` missing mitigation 1 entirely — a latent defect an in-process route test (no bound
`Bun.serve`, so nothing times out) could not observe — and fixed it alongside the new `watch` route,
which needs the identical disable for the identical reason.

## 9. Status code summary

| Code | Meaning | Used by |
|---|---|---|
| 200 | success | all GETs, POST responses that don't create a resource |
| 201 | resource created | `POST .../annotations` |
| 400 | invalid path / validation failure | path confinement, bad annotation body, bad diff query |
| 401 | missing/invalid Bearer token | every route except `/api/handshake` |
| 403 | Origin/Host not allowlisted | every route, checked first |
| 404 | unknown workspace/artifact/session/capability token | all resource-scoped GETs, capability consumption |
| 409 | contract major mismatch; active metadata owned by another id; target adoption in progress (`workspace-adopting`); `If-Match` `source_sha256` stale, or the file changed underneath a save (`source-changed`); the target file's bytes are not valid UTF-8 (`not-utf8`); claims (§5.11f): another session holds it (`claim-held`), the caller's claim ended (`claim-revoked`/`claim-expired`/`claim-superseded`), the entry is already closed (`entry-resolved`), no claim to prove a resolve (`no-claim`), too many live claims (`claim-limit`) | any route, `PUT .../metadata`, ordinary workspace routes (slug- and root-addressed), `PUT .../artifacts/:path` |
| 413 | request body over 1 MiB | any POST |
| 429 | configured dictation provider rate-limited a foreground token request | `POST /api/dictation/session` |
| 502 | configured dictation provider rejected credentials or returned an invalid/failing response | `POST /api/dictation/session` |
| 503 | configured dictation credential unavailable locally | `POST /api/dictation/session` |
| 504 | configured dictation provider token request timed out | `POST /api/dictation/session` |
| 500 | unhandled daemon error | any route |

---

## Summary of what's out of scope here (do not re-derive)

- `attention_request` transition ownership and `--wait` semantics → A5 F23.
- Exact CSP header value, sandbox token list, postMessage schema/nonce handshake → F03/F18.
- Manifest→source-range resolution algorithm for class-F annotations → F11.
- Transcript tailer's partial-line/rotation/corruption handling → F16 (the API only sees its
  opaque cursor, per §8.1).

### Shadow diagnosis and explicit baseline repair (#226)

`GET /w/:slug/shadow/health` is an authenticated read. It resolves the existing canonical registration
(including redirected and loose-file buses), never constructs a writing bus, and returns `slug`,
`registration_id`, `state`, `reason`, `head`, and `census`. States are `healthy`, `uninitialized`,
`lost-history`, `invalid-head`, and `repair-pending`. A pending repair also includes its stable ID,
reason, and checkpoint. Health covers the active HEAD commit, not every historical object.

`census` contains `entries`, `missing_checkpoint_entries`, `unassessable_entries`, and `complete`.
It counts each human/external-edit entry once when any required checkpoint commit is missing;
unreachable but readable commits still count as present. Missing/malformed relevant payloads and
unknown kinds are unassessable. Invalid journal records qualify completeness. It never repairs history.

`POST /w/:slug/shadow/repair-baseline` is state-changing: Bearer, same Origin, contract gate and global
body cap apply. Its body must be `{}` (at most 1024 bytes). It returns the same diagnosis after explicit
repair under the ownership coordinator and shared bus mutex (A4 F21). Unknown slug is 404; malformed
body is 400. Inactive registrations, unsafe paths, leases, unavailable singleton proof, invalid HEAD,
and already-healthy stores are named 409 refusals. Missing history is not recovered; a new baseline
only permits future capture. These additive routes do not change the protocol version.


## Managed agents and chats — contract 1.18

These routes use the existing Host/Origin/Bearer, body-size, token-revocation and contract-version
pipeline. No native credentials are returned. Mutations are POST; reads are GET. JSON responses are
`no-store`. Invalid input returns 422; stale revisions/identity/idempotency conflicts return 409;
unavailable runtime/state returns 503. A UUID request ID is required for profile creation/update,
chat creation/change/draft/send/decision. Repeating the same ID with changed input is refused.

| Route | Contract |
|---|---|
| `/api/agents/status` | Local profiles, cached model catalogs, install/qualification status, recovery state. No native probe. |
| `/api/agents/profiles` and `/profiles/:id` | Create and CAS-update account metadata. One eligible default per provider. |
| `/api/agents/profiles/:id/{login,logout,probe,models,consent,mcp,mcp-login}` | Explicit foreground operation. MCP policy uses workspace query, revision and exact servers. MCP login binds a workspace incarnation and optional server ID to a separately owned native terminal. |
| `/api/agents/runtimes/:provider/install` | Explicit pinned install or verified repair, never an inference warm-up. |
| `/api/agents/logins/:id` and `/{input,resize,finish}` | Memory operation grant in `X-Glosa-Operation`; bounded base64 terminal output with offset/reset. No grant in URL or storage. |
| `/api/agents/quiesce` | Instance-ID-bound replacement fence; refuses while owned/unknown work exists. |
| `/w/:slug/chats` | Local metadata list or create draft. GET `q` searches title and stored messages, `archived=true` includes archived rows, `after` pages 50 matches. Registration epoch scopes every lookup. |
| `/w/:slug/chats/events` | Coalesced sidebar invalidations; closing chat tabs does not lose background status. |
| `/w/:slug/chats/external` | Remember an already registered external session; never revive its native lease. |
| `/w/:slug/chats/:id` | Snapshot or CAS configuration update. GET `before` pages 100 logical messages with stable cursor. |
| `.../:id/{draft,move-draft,turns,feedback,decisions,stop,resume,delete,attachments,mcp}` | Durable draft/send/answer; explicit feedback preview/send; stop/resume; stopped deletion; bounded upload; foreground native MCP status. Draft transfer durably copies the target before CAS-clearing an unchanged source. |
| `.../:id/{events,export}` | SSE snapshot plus sequenced events; complete Markdown export. |

Chat stream IDs are `<chat UUID>:1:<journal sequence>`. Snapshot and listener installation do not
yield. Reconnect replaces local projection from a snapshot; it never replays a native send. Sequence
gaps trigger another snapshot. Slow readers are disconnected; output/history remain durable.
The `before` cursor also applies to stream snapshots. Individual displayed message text is capped
at 128 Ki characters and marked shortened; export retains original stored text.

`POST /api/managed-mcp` is a separate native-only boundary: no browser Origin; an in-memory bearer
grant selects one active run/workspace/session. Only initialize, ping and scoped tools are allowed.
The grant cannot authenticate ordinary APIs. Revocation is rechecked before native writes and under
the workspace mutex before bus mutations. Tool arguments never widen scope. `glosa_present` returns
an already-paired workspace link after the ordinary tracked-artifact check; no browser is launched.

Managed chat panes and the Chats list share the existing workspace SSE connection in the SPA.
The advisory `chats_changed` frame has no journal cursor or transcript payload; notifications
coalesce over 250 ms and each pane reloads its bounded durable snapshot. Reconnect also reloads
snapshots. The direct per-chat event endpoint remains available, but opening more UI tabs does
not allocate more long-lived browser connections. Document-only surfaces do not subscribe to the
chat list. This prevents chat streams from starving document requests at the browser connection limit.

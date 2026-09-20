# glosa v1 — security spec (F03, F18, F24, §5.5)

Threat model: other local/remote websites reachable by the user's browser (drive-by fetch, hostile
iframe/tab, DNS rebinding) — NOT another OS-user process.

## 0. Topology — two fixed listeners, one daemon
- `GLOSA_PORT` (default 4646) — SPA + authenticated API. Two origins, one listener: `http://glosa.localhost:4646` (what `glosa open` links to) and `http://127.0.0.1:4646` (what the CLI, plugin monitor and `GLOSA_OPEN_HOST=127.0.0.1` use). `localStorage` is per origin, so a pairing made on one name is not visible on the other; `glosa open` re-pairs through the fragment either way. Within one origin it IS shared: every tab reads the same credential.
- `GLOSA_CLASSF_PORT` = GLOSA_PORT+1 (default 4647) — class-F foreign HTML only. Origin `http://127.0.0.1:4647`.
- Two ports ≠ two daemons: one process/lock/lifecycle; two ports = two real origins (scheme+host+port).

## 1. F03 — class-F separate origin + CSP
- Serve: `GET /doc/:token/<path...>` on class-F origin ONLY (the class-F listener's only route); never accepts Bearer — the capability IS the auth.
- Mint on SPA origin: `POST /w/:slug/capability/:artifactPath` (Bearer + path-confined). Fresh capability per iframe open/reload; never reused.
- Capability: 256-bit, in-memory `Map<capability,{workspace,artifactRealPath,mintedAt}>`, NOT persisted (restart invalidates — fine). TTL 10 min; expired → 404 (no ambient auth on this origin). One capability scopes one artifact's dir (sibling assets resolve under same capability + realpath check per request).
- CSP on EVERY class-F response:
  `default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; form-action 'none'; frame-ancestors 'self' http://127.0.0.1:<SPA_PORT> http://glosa.localhost:<SPA_PORT>; base-uri 'none'; object-src 'none'; sandbox allow-scripts;` + `Referrer-Policy: no-referrer`.
  - `script-src 'self' 'unsafe-inline'` lets the artifact's inline `<script>` run; no eval, no third-party host.
  - `connect-src 'none' + form-action 'none'` = network lockdown → reconciles "doc JS runs untouched" with "no external calls."
  - **`sandbox allow-scripts` in the CSP header (not just iframe attr)** = the top-level-open fix: applies under ANY load context incl. bare tab; omitting allow-same-origin/popups/top-navigation/forms/modals → every load gets fresh OPAQUE origin. Nothing sensitive lives on this port anyway (token is on SPA port).
  - `frame-ancestors` → only the glosa SPA may embed it, under either of its two names. The class-F origin itself stays `http://127.0.0.1:<CLASSF_PORT>`: capability URLs are minted against the IP, and its Host allowlist is the IP alone (§4 Rule 1). Framed from `glosa.localhost`, the viewer is cross-site to its parent; nothing depends on that, because the frame is already an opaque sandboxed origin with no storage or network.

## 2. F18 — iframe sandbox + postMessage bridge trust
- `<iframe src="<mint url>" sandbox="allow-scripts" referrerpolicy="no-referrer">` — no allow-same-origin + src (not srcdoc) → opaque origin → `event.origin` is `"null"`, so origin checks are useless; use three orthogonal checks:
  1. **event.source identity**: capture `const win = iframeEl.contentWindow` at creation; accept only `event.source === win`.
  2. **per-load nonce**: mint returns 256-bit nonce; daemon injects `window.__glosaNonce` into bridge at serve; every msg carries it; parent rejects mismatches for that iframe instance.
  3. **MessageChannel handshake (load-bearing)**: on iframe `load`, parent does `win.postMessage({type:"glosa:init",nonce}, "<CLASSF origin>", [channel.port2])`; bridge validates nonce once, then communicates EXCLUSIVELY over the private port. A third party without port2 cannot inject. Origin/source checks only guard the single init msg.
- Message schema (over channel): `selection|mark|ready|error` with `seq`, `quote{exact,prefix,suffix}`, `range{start,end}`. Validate with zod every inbound; unknown → drop+log. Size cap 8KB/msg. Rate limit 50 msg/s/iframe (token bucket, drop excess). All strings = plain text, escaped at every render surface.

## 3. F24 — token lifecycle + realpath confinement
- The Claude plugin monitor runs at hook trust and reads the pairing token only after finding a
  registered workspace. Its launcher resolves `$GLOSA_BIN`, glosa's recorded absolute symlink, or a
  sibling source checkout in that order; it never searches `PATH` for glosa and never downloads.
  The monitor's daemon discovery is read-only and never starts, repairs, replaces, or stops a process.
- The Codex attachment opens only the configured local `AF_UNIX` control socket and never uses
  `remoteControl/*`, opens a TCP listener, or starts Codex's app-server. The app-server itself may
  maintain its own remote-control task toward `chatgpt.com`; that process and egress are Codex-owned,
  while the Glosa daemon, SPA, and attachment make no outbound network request.
- Fragment scrub FIRST statement on bootstrap: read `#t=` (durable) or `#p=` (presentation),
  redeem `p` once for the durable token when present, `localStorage.setItem('glosa_token', durable)`,
  `history.replaceState` to pathname+search plus non-secret fragment state
  (`w`/`a`/`surface`/`mode`/`lock`) — before any render/error handler. Secrets never reappear in
  subsequent focus URLs. Preview lock (`lock=preview`) is a UI affordance only — not authorization;
  annotation POSTs remain accepted when authenticated.
- Presentation tokens are distinct from the durable pairing token and from class-F capabilities:
  256-bit, 60s TTL, single-use, in-memory only. Mint via authenticated
  `POST /api/presentation-token/mint`; redeem via same-origin Host-checked
  `POST /api/presentation-token/redeem`. Expired/unknown/replayed collapse to one 401. Token
  rotation/revocation clears outstanding presentation tokens alongside class-F capabilities.
- Storage: **origin-scoped `localStorage`** (never a cookie, never the URL). It was `sessionStorage`
  until alpha.28; #229 moved it because a credential bounded to one tab's lifetime is lost by any host
  that rebuilds its web view, and is never seen by a second tab on the same origin. What bounds the
  credential's life is now the token file, not the tab: `glosa token rotate` / `glosa token revoke`
  produce a 401, and the first 401 the SPA can attribute to its own daemon removes the credential —
  from the shared store, so every tab on the origin unpairs. One `glosa open` after a rotate re-pairs
  them all, without a reload, because the Bearer is read from the store per request. The issuing
  daemon's `install_id` is recorded beside it as `glosa_install`, in the same store and therefore at
  the same scope; it is not a secret (the tokenless handshake publishes it) and exists so a rejection
  can be attributed.
- Token state has two durable forms: **active** = `~/.glosa/token` contains one 128-bit hex token at
  mode 0600; **revoked** = that file is absent. `glosa token rotate` writes a fresh mode-0600 temp,
  fsyncs it, then atomically renames it over the active file. `glosa token revoke` atomically unlinks
  the active file and is idempotent when already revoked. There is no separate epoch file and no
  cross-file transaction: the daemon's in-memory generation increments whenever the complete token
  value changes or becomes absent. Rotation/revocation work while the daemon is down and do not require
  API authentication. A failed pre-commit write/fsync/rename/unlink leaves the previous credential state
  intact; no fallible filesystem operation follows the commit point.
- The running daemon watches the token directory **and** synchronously refreshes at every auth gate
  (the watcher closes long-lived state promptly; request-time refresh is the correctness backstop).
  It compares against CURRENT only, with no grace: every request reaching auth after the atomic commit
  rejects the previous Bearer with 401. A generation change aborts existing SSE/transcript streams and
  clears all in-memory class-F capabilities, so revocation is kill-all across API and browser
  credentials. The SPA treats a 401 as credential invalidation **when the rejecting daemon is the one it
  paired with, or cannot be distinguished from it**: remove `localStorage.glosa_token` — which drops it
  for every tab on the origin — stop
  reconnecting with it, and render the unpaired state. Re-pair only through `glosa open`. A 401
  from a daemon whose `install_id` differs from the one recorded at pairing is NOT evidence about
  this credential — a second install taking the port produces exactly that — so the tab keeps the
  credential, **stops transmitting it entirely**, polls only the tokenless handshake, and reloads
  once its own daemon answers again. Safety comes from not sending it to an unidentified peer, not
  from discarding it. Bounded: after 10 minutes the tab gives up and falls back to the unpaired
  state above. A tab with no recorded pairing identity has nothing to compare and behaves exactly
  as before.
- Both token commands use the stable A6 envelope and never include token material in human or JSON
  output. The daemon stats the token file on refresh and warns once per observed permission drift;
  drift is non-fatal so the warning cannot lock the user out of rotation/revocation.
- SPA-origin CSP (the same string under both SPA hostnames; `'self'` follows whichever the tab loaded): `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src http://127.0.0.1:<CLASSF_PORT>; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none';` + `Referrer-Policy: no-referrer` + `X-Content-Type-Options: nosniff`. (SPA refuses to ever be framed.)
- Log redaction: one `redact()` at logger boundary — strip `Authorization` values; regex-redact token/capability-shaped path segments `[A-Za-z0-9_-]{32,}`. Grep-enforceable single call site.
- **confinePath(workspaceRoot, relPath)**: reject absolute or `..`-containing; `path.resolve`; realpath the nearest EXISTING ancestor (so not-yet-created files still confined); reject if realAncestor not under realRoot. ONE shared utility at every path entry point (HTTP routes, class-F mint/serve, adapter manifest, git pathspec); grep-enforced in CI. Rejects lexical traversal AND symlink escape. Argv safety: git paths as discrete argv elements + `--` before first path → filename `--force` can't be a flag.

## 4. Host/Origin/Auth resolved table
- Rule 1 (every request, both ports): `Host` MUST literally equal one allowlisted name + port. SPA/API port: `127.0.0.1:<port>` or `glosa.localhost:<port>`. Class-F port: `127.0.0.1:<port>` only. No case folding, trailing dot, subdomain or other `.localhost` name. Mismatch → 400, close, no body.
  - Why a name is allowed at all (#159): rebinding needs a hostname an attacker can answer for — first with their own server, then with `127.0.0.1`. Nobody can answer for `glosa.localhost`. RFC 6761 reserves `.localhost` for loopback; Chrome and Firefox resolve it internally, and the macOS system resolver (used by Safari) synthesizes the answer without a query. Verified on macOS 26.2: `dns-sd -G v4v6 glosa.localhost` answers `localhost.` → `127.0.0.1` / `::1` with interface `-1` (local-only) and TTL 1, and `/etc/hosts` cannot produce that (it does not support wildcards). A page on any other name, including one rebound to loopback, still arrives with its own name as `Host` and gets the 400.
  - Why not a public domain pointing at `127.0.0.1` (the `*.plex.direct` pattern): that name is resolved by an outside DNS server that can change its answer, which re-opens rebinding; and each resolution is an outbound query, which invariant 5 / A6 §F33 forbid.
  - Origin is bound to Host: on the SPA port, "self" is `http://<the request's own Host>`, not "any allowlisted origin". A page on one name cannot act on a request addressed to the other.
- Given Host passes, on SPA origin:
  | Route class | Bearer | Origin rule |
  |---|---|---|
  | Tokenless handshake `GET /api/handshake` | No | Reject if Origin present+foreign; allow self/absent. Body non-sensitive `{contract_version,daemon_version,paired}`. |
  | Presentation redeem `POST /api/presentation-token/redeem` | No (redeems for Bearer) | Reject if Origin missing OR foreign; also reject `Sec-Fetch-Site: cross-site`. Returns the durable pairing token once. |
  | Authed reads (GET: artifact, SSE, diff, transcript, inbox, entry-status, watch) | Yes (401) | Reject only if Origin present+foreign; absent allowed (Bearer is the gate). |
  | State-changing (POST/PUT/DELETE: annotations, resolve, attention, apply-begin, presentation mint, token, watch/transport-ack, watch/ack) | Yes (401) | Reject if Origin missing OR foreign (strict, redundant w/ Bearer on purpose). Also reject `Sec-Fetch-Site: cross-site` (defense-in-depth). |
  | Navigation (top GET: `/` SPA shell, `/doc/<cap>/...` class-F) | No (nav can't carry headers) | Origin checks inapplicable; SPA shell is static+non-sensitive, self-auths via fragment post-load; class-F gated by PATH CAPABILITY not headers. |
- Resolves the doc contradiction: "every request validated" = the Host check unconditionally; Origin check is route-class-scoped.

### Starred workspaces (contract 1.11)
The star routes (A1 §5.21) are the one place the SPA can make the daemon open a directory, so they
are shaped so that no request can name one.
- **No path in, ever.** `POST /api/stars` takes a slug and records the path of that present registration,
  which already came from `glosa open`, a live session's cwd or a `.glosa/` marker (R1).
  `POST /api/stars/:id/open` takes only the star id; the path is read from `~/.glosa/stars.json`.
  A page holding the Bearer token therefore gains no way to register an arbitrary directory, only to
  reopen one the writer already worked in and starred.
- **Loose files cannot be starred** (`star-not-directory`): a star reopens a directory, and a loose file's
  containing directory was never itself a registration.
- **Missing folders are refused before the index** (`star-folder-missing`). Otherwise reopening runs the
  same `resolveOpenTarget` path as `glosa open`, including the home-directory boundary (#146) and the
  forget/adoption refusals, so a star is never a way around them.
- `stars.json` is written 0600 in `GLOSA_HOME`, like the token. A corrupt file is moved aside, not overwritten.
- State-changing star routes use the strict Origin rule in the table above; `GET /api/stars` is an authed read.

## 5. §5.5 attacks → defense → test
1. Open class-F in new tab → origin split + CSP sandbox → test: direct-nav minted URL, assert storage empty + fetch throws.
2. Remote img/fetch/WS/form in doc → connect-src/form-action none → test: fixture with each, assert 0 outbound + CSP violation.
3. Forged postMessage → event.source+nonce+MessageChannel → test: 3rd window posts well-formed msg at parent, assert no mutation.
4. Symlink escape → confinePath realpath → test: `workspace/evil->/etc/passwd`, assert 403/404, contents never read.
5. Leading-`-`/control-char filename → `--` + argv array + reject control chars → test: artifact `--force` targeted as path; `\n` name → 400.
6. Injected HTML (name/md/annotation/transcript/tool_result) → contextual escaping + script-src 'self' → test: `<script>` payloads render escaped in class R, class-F overlays, conversation mirror.
7. Local site navigates/frames class-F/handshake → Host literal + Origin table + frame-ancestors → test: foreign origin (a) top-nav handshake non-sensitive + state routes reject, (b) no-Bearer GET → 401, (c) iframe class-F → blocked by frame-ancestors, (d) iframe SPA → blocked.
8. Fragment token in history/URL → replaceState + origin-scoped `localStorage` + rotate/revoke → test: hash empty, no history `t=`, no cookie; the credential survives a reload, a second tab at a token-free URL and a rebuilt web view on the same origin (`pairing-durability-real-engine.test.ts`); revoke → 401, every tab on the origin drops it, old Bearer 401.
9. DNS rebinding against the second SPA hostname (#159) → literal two-name allowlist + Origin bound to Host + class-F IP-only → test: near-miss Hosts (`GLOSA.localhost`, `glosa.localhost.`, `evil.glosa.localhost`, `localhost`, missing port, class-F port) → 400 no body; `glosa.localhost` Host with a `127.0.0.1` Origin (and the reverse) → 403; `glosa.localhost` Host on class-F → 400; class-F `frame-ancestors` names the SPA under both hostnames and nothing else.
10. Page with the Bearer token tries to open an arbitrary directory through stars → no star route accepts a path; open is by daemon-recorded id → test (`workspace-stars.test.ts`): `POST /api/stars` with a `path` body and no slug → 400 and nothing recorded; an id that was never recorded → 404; a star to a loose-file registration → 422; reopening a star whose folder is gone → 422 and the index unchanged.

### Explicit shadow repair (#226)

Shadow health uses the authenticated-read class; baseline repair uses the state-changing class with
Bearer, mandatory same Origin, contract validation and the existing body cap. The repair body is an
empty JSON object, bounded to 1024 bytes. The slug selects an existing canonical registration; no path
or alternate Git directory is accepted from the request. The daemon validates registration/worktree
anchors, bounded loose-file tracking, and local or home-state bus placement before opening a writer,
then repeats the validation under the shared bus mutex. Symlink bus/journal/HEAD/ref paths are refused.
Repair requires singleton ownership and respects apply leases and adoption/forget seals (A4 F21).

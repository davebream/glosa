# glosa v1 — security spec (F03, F18, F24, §5.5)

Threat model: other local/remote websites reachable by the user's browser (drive-by fetch, hostile
iframe/tab, DNS rebinding) — NOT another OS-user process.

## 0. Topology — two fixed listeners, one daemon
- `GLOSA_PORT` (default 4646) — SPA + authenticated API. Origin `http://127.0.0.1:4646`.
- `GLOSA_CLASSF_PORT` = GLOSA_PORT+1 (default 4647) — class-F foreign HTML only. Origin `http://127.0.0.1:4647`.
- Two ports ≠ two daemons: one process/lock/lifecycle; two ports = two real origins (scheme+host+port).

## 1. F03 — class-F separate origin + CSP
- Serve: `GET /doc/<capability>/<artifact-id>/<path...>` on class-F origin ONLY; never accepts Bearer — the capability IS the auth.
- Mint on SPA origin: `POST /w/<slug>/api/classf/mint {artifact_path}` (Bearer + path-confined) → `{url, nonce, expires_at}`. Fresh capability per iframe open/reload; never reused.
- Capability: 256-bit, in-memory `Map<capability,{workspace,artifactRealPath,mintedAt}>`, NOT persisted (restart invalidates — fine). TTL 10 min; expired → 404 (no ambient auth on this origin). One capability scopes one artifact's dir (sibling assets resolve under same capability + realpath check per request).
- CSP on EVERY class-F response:
  `default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; form-action 'none'; frame-ancestors 'self' http://127.0.0.1:<SPA_PORT>; base-uri 'none'; object-src 'none'; sandbox allow-scripts;` + `Referrer-Policy: no-referrer`.
  - `script-src 'self' 'unsafe-inline'` lets the artifact's inline `<script>` run; no eval, no third-party host.
  - `connect-src 'none' + form-action 'none'` = network lockdown → reconciles "doc JS runs untouched" with "no external calls."
  - **`sandbox allow-scripts` in the CSP header (not just iframe attr)** = the top-level-open fix: applies under ANY load context incl. bare tab; omitting allow-same-origin/popups/top-navigation/forms/modals → every load gets fresh OPAQUE origin. Nothing sensitive lives on this port anyway (token is on SPA port).
  - `frame-ancestors` → only the glosa SPA may embed it.

## 2. F18 — iframe sandbox + postMessage bridge trust
- `<iframe src="<mint url>" sandbox="allow-scripts" referrerpolicy="no-referrer">` — no allow-same-origin + src (not srcdoc) → opaque origin → `event.origin` is `"null"`, so origin checks are useless; use three orthogonal checks:
  1. **event.source identity**: capture `const win = iframeEl.contentWindow` at creation; accept only `event.source === win`.
  2. **per-load nonce**: mint returns 256-bit nonce; daemon injects `window.__glosaNonce` into bridge at serve; every msg carries it; parent rejects mismatches for that iframe instance.
  3. **MessageChannel handshake (load-bearing)**: on iframe `load`, parent does `win.postMessage({type:"glosa:init",nonce}, "<CLASSF origin>", [channel.port2])`; bridge validates nonce once, then communicates EXCLUSIVELY over the private port. A third party without port2 cannot inject. Origin/source checks only guard the single init msg.
- Message schema (over channel): `selection|mark|ready|error` with `seq`, `quote{exact,prefix,suffix}`, `range{start,end}`. Validate with zod every inbound; unknown → drop+log. Size cap 8KB/msg. Rate limit 50 msg/s/iframe (token bucket, drop excess). All strings = plain text, escaped at every render surface.

## 3. F24 — token lifecycle + realpath confinement
- Fragment scrub FIRST statement on bootstrap: read `#t=`, `sessionStorage.setItem('glosa_token',t)`, `history.replaceState(null,'',location.pathname+location.search)` — before any render/error handler.
- Storage: **sessionStorage** (not localStorage) — bounded to tab lifetime.
- Rotation: `glosa token rotate` → new 128-bit, atomic temp+rename 0600, bump epoch; daemon compares against CURRENT only (no grace) = immediate hard revoke; stale tabs get 401 → unpaired screen → re-`glosa open`. `glosa token revoke` = kill-all. Daemon stats token file on read, warns (non-fatal) if perms drift.
- SPA-origin CSP: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src http://127.0.0.1:<CLASSF_PORT>; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none';` + `Referrer-Policy: no-referrer` + `X-Content-Type-Options: nosniff`. (SPA refuses to ever be framed.)
- Log redaction: one `redact()` at logger boundary — strip `Authorization` values; regex-redact token/capability-shaped path segments `[A-Za-z0-9_-]{32,}`. Grep-enforceable single call site.
- **confinePath(workspaceRoot, relPath)**: reject absolute or `..`-containing; `path.resolve`; realpath the nearest EXISTING ancestor (so not-yet-created files still confined); reject if realAncestor not under realRoot. ONE shared utility at every path entry point (HTTP routes, class-F mint/serve, adapter manifest, git pathspec); grep-enforced in CI. Rejects lexical traversal AND symlink escape. Argv safety: git paths as discrete argv elements + `--` before first path → filename `--force` can't be a flag.

## 4. Host/Origin/Auth resolved table
- Rule 1 (every request, both ports): `Host` MUST literally equal `127.0.0.1:<port>` (no DNS names ever → strongest anti-rebinding: no hostname to re-resolve). Mismatch → 400, close, no body.
- Given Host passes, on SPA origin:
  | Route class | Bearer | Origin rule |
  |---|---|---|
  | Tokenless handshake `GET /api/handshake` | No | Reject if Origin present+foreign; allow self/absent. Body non-sensitive `{contract_version,daemon_version,paired}`. |
  | Authed reads (GET: artifact, SSE, diff, transcript, inbox) | Yes (401) | Reject only if Origin present+foreign; absent allowed (Bearer is the gate). |
  | State-changing (POST/PUT/DELETE: annotations, resolve, attention, apply-begin, token) | Yes (401) | Reject if Origin missing OR foreign (strict, redundant w/ Bearer on purpose). Also reject `Sec-Fetch-Site: cross-site` (defense-in-depth). |
  | Navigation (top GET: `/` SPA shell, `/doc/<cap>/...` class-F) | No (nav can't carry headers) | Origin checks inapplicable; SPA shell is static+non-sensitive, self-auths via fragment post-load; class-F gated by PATH CAPABILITY not headers. |
- Resolves the doc contradiction: "every request validated" = the Host check unconditionally; Origin check is route-class-scoped.

## 5. §5.5 attacks → defense → test
1. Open class-F in new tab → origin split + CSP sandbox → test: direct-nav minted URL, assert storage empty + fetch throws.
2. Remote img/fetch/WS/form in doc → connect-src/form-action none → test: fixture with each, assert 0 outbound + CSP violation.
3. Forged postMessage → event.source+nonce+MessageChannel → test: 3rd window posts well-formed msg at parent, assert no mutation.
4. Symlink escape → confinePath realpath → test: `workspace/evil->/etc/passwd`, assert 403/404, contents never read.
5. Leading-`-`/control-char filename → `--` + argv array + reject control chars → test: artifact `--force` targeted as path; `\n` name → 400.
6. Injected HTML (name/md/annotation/transcript/tool_result) → contextual escaping + script-src 'self' → test: `<script>` payloads render escaped in class R, class-F overlays, conversation mirror.
7. Local site navigates/frames class-F/handshake → Host literal + Origin table + frame-ancestors → test: foreign origin (a) top-nav handshake non-sensitive + state routes reject, (b) no-Bearer GET → 401, (c) iframe class-F → blocked by frame-ancestors, (d) iframe SPA → blocked.
8. Fragment token in history/localStorage → replaceState + sessionStorage + rotate/revoke → test: hash empty, no history `t=`, token in sessionStorage not localStorage, revoke → old Bearer 401.

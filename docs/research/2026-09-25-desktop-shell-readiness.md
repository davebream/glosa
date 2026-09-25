# Desktop shell readiness — what is settled, what was tested, what remains (2026-09-25)

Follow-up to `electron-vs-tauri.md` (July 2026) and the feature map in
`docs/design/2026-09-25-desktop-shell-feature-map.md` (issue #160). The July research chose
Electron and named the two webview-sensitive parts as the reason: the class-F annotation bridge and
embedded terminals. This note records what has been checked since, with dated sources and one local
spike, so the shell work can start from evidence rather than from the July verdict alone. Status:
research; no shell code exists.

## Verdict

**Electron stays the choice, and the class-F bridge is verified inside it.** A local spike (below)
loaded the daemon-served SPA in an Electron 44.4.5 window with default security settings and
confirmed every isolation property the class-F viewer relies on. Electrobun has closed real gaps
since July but is not ready for a product that is itself pre-launch (single maintainer, no
documented remote-origin main window, dock badge unmerged, one real migration bounced back to
Electron). The blocking work is not the framework: it is daemon ownership, which today's livelock
made concrete, and it is specified in
`docs/design/2026-09-25-daemon-ownership-and-pairing-under-a-shell.md`.

## 1. The class-F spike (local, reproducible)

Script: `docs/research/spikes/electron-classf-isolation.js`; probe page:
`docs/research/spikes/electron-classf-probe.html`. Run: put the probe under a fixture workspace,
`glosa open <workspace> classf/probe.html --url` against a daemon run from this checkout with an
isolated `GLOSA_HOME`, install `electron@latest` in a scratch directory, then
`electron electron-classf-isolation.js <file holding the URL>`. The script loads the URL in a
hidden `BrowserWindow` with empty `webPreferences` (Electron's defaults: sandbox, contextIsolation,
no Node), finds the class-F frame through `WebFrameMain`, reads the probe's verdicts from inside the
frame, and logs every request whose host is not loopback.

| Property | Result (Electron 44.4.5, Chromium 152) |
|---|---|
| Top frame secure context at `http://glosa.localhost:<port>` | `isSecureContext === true` |
| Class-F frame | separate origin `http://127.0.0.1:<port+1>`, `frameElement === null` (sandboxed) |
| `localStorage` inside the frame | blocked |
| `fetch("https://example.com/")` from the frame | blocked by `connect-src 'none'` before any request |
| `<img src="https://…">` from the frame | blocked by `img-src 'self' data:` |
| `window.open` from the frame | blocked: sandbox lacks `allow-popups` |
| `top.location.href = …` from the frame | blocked: "unsafe attempt to initiate navigation" |
| `location.href = "mailto:…"` from the frame | no application launched (the CVE-2026-70612 class, fixed before 42) |
| Requests leaving loopback, observed at `session.webRequest` | none |
| Pairing fragment `#p=…` in session history after load | absent (the SPA rewrites the URL after redeeming) |

A second run with **no** main-process handlers at all (no `setWindowOpenHandler`, no
`will-navigate`, no permission handler) gave the same frame verdicts: Chromium's frame sandbox
holds without help. The handlers are still required, because they protect the **top** frame (the
SPA) rather than the class-F frame; see §3.

Not yet exercised, from the isolation report's checklist: a preload attached to the SPA window and
navigated to the class-F origin (assert nothing is exposed there); a deliberate renderer crash with
the fragment present (assert the crash payload carries no token); a forged `Host` header from
outside Electron (the daemon's 400 is already unit-tested, but not under the shell).

## 2. Electrobun, re-evaluated

Sources: GitHub releases and repository (checked 2026-09-25), Blackboard's v1 post (Feb 2026),
the v1.18.0 changelog (2026-05-03), SudoAll's write-up (2026-03-18, single vendor), Rick van
Lieshout's "wanted Electrobun, shipped Electron" (2026-05-10), Electrobun issue #392 (open since
2026-04-23), Bun PRs #25415 and #33239 (`Bun.Terminal`, Bun 1.3.5).

| Question | Finding |
|---|---|
| Version and cadence | v2.0.2-beta.31; bursts of daily betas with multi-week gaps between them. |
| Bus factor | 12.8k stars, 40 contributors, one primary maintainer; README disclaims any expectation of review or response. |
| Webview | System WKWebView by default, optional CEF (+170 MB). Each `<electrobun-webview>` is its own OS process with an explicit sandbox mode that removes RPC entirely. |
| Remote `http://localhost` origin as the main window | **Not documented either way.** The single biggest unconfirmed fact for glosa's daemon-serves-SPA model. |
| PTY | Solved by Bun, not Electrobun: `Bun.Terminal` (Bun 1.3.5+, POSIX only). No example of streaming it into a webview; `node-pty` confirmed incompatible. |
| Distribution | Signing and notarization built into its CLI; 12–14 MB apps; bsdiff updates from static hosting. |
| Native affordances | Notifications, open dialogs, native menus shipped. Dock badge and dock menu requested in #392, unmerged. `glosa://` handler and folder drops on the dock icon undocumented. |
| Real projects | Skillful tried it for a month and went back to Electron over packaging and platform glue. A Claude Cowork migration proposal exists as an issue, not an outcome. |

What would flip it: a documented remote-origin main window; #392 merged; a second consistent
maintainer; a documented `Bun.Terminal` → webview example with a latency figure. Re-check in a
quarter; do not plan on it.

## 3. Electron isolation, beyond the spike

Sources: Electron security guide, `session` and `web-request` API docs, CVE-2026-70612 (GHSA-p2rr-
rvmm-c5fp, published 2026-08-05, fixed in 39.8.8 / 40.9.0 / 41.2.1 / 42.0.0-beta.3), the
top-frame-origin permission bug (fixed 41.0.0 / 40.8.1 / 39.8.1 / 38.8.6), CVE-2022-23597 (Element
Desktop), Chrome Platform Status for `*.localhost` secure contexts.

- **CSP is Chromium's.** `sandbox`, `connect-src 'none'` and `frame-ancestors` behave as in Chrome.
  `*.localhost` resolves to loopback under RFC 6761 with no switch, and the `Host` header is sent
  as typed, so the daemon's Host allowlist behaves as it does in a browser tab.
- **Defaults protect the frame, not the window.** `will-navigate` and `window.open` default to
  allow on the top frame. The main process must deny `setWindowOpenHandler`, prevent `will-navigate`
  away from the SPA origin (parse the URL and compare the origin; never `startsWith`), deny
  `will-download`, and install a `setPermissionRequestHandler` that denies by default. Pin
  Electron at or above the CVE-2026-70612 fix.
- **Egress is a browser-process gate, not a CSP.** `session.webRequest.onBeforeRequest` cancelling
  every non-loopback host is the enforcement point; the daemon's CSP stays as defence in depth.
  `session.setProxy` with `direct://` does not blackhole anything.
- **Preload is a per-origin capability.** Attach it only to the SPA window; expose nothing unless
  `location.origin` equals the SPA origin exactly; and verify `event.senderFrame.origin` in every
  `ipcMain` handler, which is the real boundary. Never attach it to the class-F frame; never use
  `<webview>`.
- **The pairing token should not travel in the fragment under the shell.** The SPA strips it after
  redeeming, and the spike shows it absent from session history, but a crash reporter or any
  `did-navigate` logger sees it first. The shell can hand the token over the preload channel once
  after load instead. Spec in the ownership document.

## 4. Packaging, signing, updates

Sources: electron-vite and electron-builder docs, Electron PR #54193 (Electron's own build scripts on
Node 22 type stripping), Apple notarytool guidance, electron-updater docs, Squirrel.Mac, macOS
15.1 Gatekeeper change (2024-11), Docker and Tailscale client/daemon documentation.

- **Bundle only the shell.** electron-vite for main and preload (small, plain JS output), electron-
  builder for DMG, signing, notarization and the update feed. The daemon and SPA stay unbundled and
  daemon-served; the "no build step" exception is the shell package alone, as feature-map decision 7
  asks. Running the packaged main process as unbundled TypeScript is unproven inside Electron's
  embedded Node; keep a build for the artifact, skip it for local iteration.
- **Signing is mandatory.** Since macOS 15.1 an unsigned, un-notarized download is unlaunchable
  without a Settings override. Needs a paid Developer ID, hardened runtime with the JIT and
  unsigned-memory entitlements, `notarytool`, stapling.
- **Explicit updates are achievable.** electron-updater with `autoDownload: false` and
  `checkForUpdates()` called only from a menu action makes no network request until the click;
  Squirrel.Mac does not poll on its own. A static `latest-mac.yml` plus a zip is the whole feed. The
  zero-code alternative is a button that opens the releases page. Either satisfies A6 §F33 (no
  beacon, no cache that becomes a heartbeat) if the app never schedules a check.
- **The daemon is never the app's to update.** The CLI installs it; the app compares the daemon's
  version against a minimum it was built with and shows the exact CLI command when too old, the
  Docker pattern. A6 §F30's never-downgrade rule holds because the app never writes the install.

## 5. What the shell adds that still needs a decision

From feature-map §4, with what this note changes:

| Decision | State |
|---|---|
| 1. Install of truth | Confirmed by precedent (Docker, Tailscale): CLI owns the daemon; app checks compatibility only. |
| 2. Daemon outlives the app | Now specified, with the livelock found on 2026-09-25 as its first regression. |
| 3. Layout per window | Untouched. |
| 4. Attention daemon-wide, workspace window-scoped | Untouched. |
| 5. Face at registration | Untouched. |
| 6. Origin `http://glosa.localhost:4646` | Confirmed secure context and Host fidelity under Electron. |
| 7. No-build-step exception scoped to the shell | Confirmed feasible with electron-vite + electron-builder. |
| 8. Keyboard ownership | Untouched; needs the accessibility matrix against native chords. |
| New: launchd agent vs detached child | Open. A detached child that the app tracks by PID satisfies "never kill what you did not spawn"; launchd gives supervision across logins at the cost of owning the plist. Spike, do not assume. |

## 6. Order of work

1. Fix the stale-client eviction (the livelock) in `decideDaemonBuild`, with its ablation test.
   Every long-lived client, and a shell most of all, hits it after any source change.
2. Land the ownership and pairing spec as the contract the shell is built against.
3. Spike the four unexercised isolation checks from §1 in the same script.
4. Only then a `packages/shell` skeleton: window, deny-all handlers, egress gate, preload with the
   three calls, compatibility check, explicit update action, signing pipeline.
5. Re-check Electrobun in a quarter against the flip conditions in §2.

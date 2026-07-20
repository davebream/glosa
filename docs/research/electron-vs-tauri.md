# Electron vs Tauri for the desk's future shell — research synthesis (2026-07-20)

**Question**: If/when the artifact desk gets a standalone desktop shell (post-decision-point), Electron
or Tauri? And for personal use, can either run permanently in "dev server" mode — unpackaged, unsigned?

**Method**: 3 research agents (Tauri deep-dive, Electron deep-dive, comparable-tools survey). The
comparable-tools report is training-knowledge-only with explicit gaps (its sub-searches failed to
return); the two deep-dives are live-sourced. Requirements evaluated are the desk's own (options doc
§10–§11).

## TL;DR

**For personal use: you don't need either framework — and both fully support the "dev mode forever"
path if you want one.** For the eventual shell: **Electron**, because the desk's two most
webview-sensitive components — the foreign-HTML annotation bridge (class-F viewer) and embedded
terminals — are precisely where Tauri is weakest, while Electron's costs (RAM, bundle size) are
noise next to the agent CLIs the desk exists to serve. The architecture already decided (SPA served
by the Bun daemon at a fixed localhost port, all logic in the daemon) keeps the shell a swappable
~2-week decision either way.

## 1. Requirements scorecard

| Desk requirement | Electron 43 (Chromium 150) | Tauri 2.11 (WKWebView on macOS) |
|---|---|---|
| Foreign-HTML iframe/srcdoc + postMessage bridge (class-F annotation — **most critical**) | Stock Chromium, identical to Chrome. One spec quirk (opaque-origin srcdoc → use MessageChannel handshake, `targetOrigin:'*'`) | Works, but WebKit: init-script/subframe injection quirks (wry#1313, tauri#8158), timing differences vs Chromium. Budget a debugging tax on our most delicate component |
| SSE from Bun daemon | Perfect in page code (one trap: not in preload — keep it in the page) | **~60s idle timeout kills quiet connections** — needs sub-60s server heartbeat + auto-reconnect. Manageable, permanent |
| localStorage / pairing token | Normal, origin = fixed localhost port | Same IF window loads from the daemon URL; `tauri://` scheme storage is a separate bucket with persistence bugs and no clear-data API |
| Service workers (L2 offline shell) | Fine on localhost | **Broken on `tauri://`**; fine if window loads `http://localhost:<port>` |
| Embedded terminals (xterm.js + PTY) | node-pty — canonical, VS Code-grade maturity; utilityProcess hosting pattern | 0.x plugins (tauri-plugin-pty v0.1.1); viable, likely vendor ~200 lines yourself. One vendor claim of ~40% lower PTY latency in Rust (unverified) |
| Bun daemon sidecar | `child_process.spawn` the real system Bun (utilityProcess can NOT host Bun — Electron-Node only); ship outside asar if ever packaged | First-class sidecar (`bun build --compile` fits well) **but Tauri doesn't reliably kill sidecars/grandchildren** — process-group kill + daemon dead-man's switch required |
| Rendering feel (a WRITING app) | Chromium — smooth, 120 Hz fine | **Documented scroll jank / 60 Hz lock / blurry-text-on-external-monitor complaints; structural (Apple's webview), no workaround** |
| AI-agent buildability (kombajn, TS-first) | One language end-to-end; enormous training corpus | Fine while Rust stays boilerplate; agents stumble on novel Rust + v1/v2 ACL/plugin churn |
| Idle memory | ~100–300 MB single-window reality | ~50–90 MB. **Irrelevant here: the agent CLIs the desk serves eat 1–4 GB each** |
| Maturity/cadence | v43.1.1 (Jul 14 2026), 8-week majors, dominant (~1.66M weekly downloads vs Tauri ~85K) | v2.11.5, healthy cadence, 120+ plugins; WKWebView complaints are structural |

## 2. "Dev server" personal use — YES for both, and a third path

- **Electron**: `electron .` (electron-vite recommended, HMR) run permanently is a legitimate personal
  deployment. macOS quarantine only attaches to *downloaded* files — locally built/run apps never
  trigger Gatekeeper/notarization. Apple Silicon needs *a* signature; ad-hoc happens automatically.
  Paid Developer ID is exclusively a distribution concern. Minor annoyance: TCC permission grants
  keyed to the generic "Electron" identity.
- **Tauri**: `tauri dev` forever is equally legitimate. Frontend hot-reloads instantly; Rust
  recompiles only on Rust changes (10–15s incremental once the rust-analyzer/targetDir cache fix is
  applied; the "300 crates every save" horror is a fixable misconfiguration). Ad-hoc signing
  supported; same no-notarization rule.
- **Third path — no framework at all** (comparable-tools survey): the field's local-daemon tools
  increasingly ship *no shell* (Vibe Kanban `npx`→browser, Plannotator, Jupyter, Syncthing,
  open-webui), growing optional wrappers only after product-fit. On macOS Sonoma+, **Safari "Add to
  Dock"** turns `http://desk.localhost` into a standalone web app: own dock icon, own window, Web
  Push + badging. Costs: isolated storage container (one-time re-pair), out-of-scope links bounce to
  the default browser, no custom menus/global hotkeys/tray. Chrome `--app=` similar, notification
  identity = Chrome.

## 3. Recommendation

1. **Now → decision point**: no shell. L0 (cmux browser pane) as planned; add **Safari Add-to-Dock
   as "L1.5"** the day a standalone window is wanted — zero code, real dock presence.
2. **If the shell decision fires**: **Electron 43+**, electron-vite, window pointed at the daemon's
   fixed `http://127.0.0.1:<port>`; daemon = spawned system Bun; ready-signal before `loadURL`;
   kill children on quit; renderer sandboxed + contextIsolation (defaults). Everything already in
   the desk design (fixed port, daemon-served SPA, browser-grade auth) transfers unchanged.
3. **Tauri remains the fallback**, viable only with its two de-risking moves (window loaded from
   daemon URL; Rust as thin shell) — choose it only if distribution size/RAM ever becomes a product
   requirement AND the annotation bridge has been verified against WKWebView first. The scroll-feel
   issue is disqualifying-by-default for a writing-first app until re-tested.
4. **Watch: Electrobun** (v1, Feb 2026 — TypeScript+Zig, Bun-native, ~14 MB apps). Conceptually the
   perfect fit for a Bun-daemon app, but too young (no PTY story, thin docs). Re-evaluate at the
   decision point.

## 4. Design invariants this confirms (already in the options doc — now doubly justified)

- SPA served **by the daemon** at a **fixed port** (kills Tauri's scheme problems, Electron's origin
  churn, and browser-mode storage identity in one decision).
- All logic in the daemon; any shell stays a thin window. The Electron-vs-Tauri choice is therefore
  reversible at ~2 weeks' cost, and the no-shell mode remains permanently supported.
- SSE with heartbeat < 30s and client auto-reconnect (needed for Tauri, harmless everywhere).

## Gaps / unverified

Comparable-tools specifics unconfirmed (its sub-agents failed): Conductor's and Sculptor's stacks,
named Tauri↔Electron migrations, opcode's specific WKWebView issue threads, Claude Code desktop's
shell. None are decision-critical: the two live-sourced deep-dives carry the verdict. Single-vendor
claims flagged inline (PTY latency, idle-RAM figures from agents-ui.com).

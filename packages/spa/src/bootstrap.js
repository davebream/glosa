// SPDX-License-Identifier: Apache-2.0
// @glosa/spa — bootstrap module, served byte-for-byte as `/app/bootstrap.js` (packages/daemon/src/
// http.ts's static allowlist). Hand-written plain JS, deliberately — glosa's "no build step"
// invariant (docs/requirements.md) means no bundle/transpile step exists between this file and
// what the browser executes, so it can't be TypeScript. `scrubToken`/`selectScreen` are pure and
// take their environment as parameters, so `bun test` exercises them directly by importing this
// file — no browser, no fakes-vs-reality gap between test and prod.
//
// Kept in lockstep with the daemon's CONTRACT_VERSION (packages/daemon/src/contract.ts) — bump
// alongside a real wire-contract change, not on every daemon restart.
export const CONTRACT_VERSION = "1.0";

// P3.3 — the class-R viewer (workspace/artifact sidebar + Preview/Annotate/Edit). A static
// top-level import, same as every other module here: no dynamic `import()` needed since this
// file itself is only ever loaded once, by the shell, so there's no "only load it if reached"
// case to optimize for. Safe to import even when `main()` never calls `mountApp` (e.g. this
// file's own bun-test importers) — viewer.js/data-access.js/annotate.js/vendor/idiomorph.js all
// touch `window`/`document` only inside function bodies, never at module load.
import { mountApp } from "./viewer.js";
import { createAppearanceController } from "./appearance.js";

// Constructed before `main()` performs its handshake so all four screens inherit appearance.
// appearance-preload.js already applied the same resolution synchronously before first paint;
// this controller takes over persistence and live system-theme changes for the page lifetime.
const appearance = typeof window === "undefined" ? null : createAppearanceController();

const MESSAGES = {
  down: "glosa daemon isn't running — run `glosa open`.",
  unpaired: "not paired — run `glosa open` to open this workspace.",
  mismatch: "contract mismatch — reload the page.",
};

/**
 * The FIRST thing bootstrap does (A3 §3/F24): read the pairing token out of the `#t=<token>` URL
 * fragment (A1 §2), stash it in sessionStorage — never localStorage, it's bounded to the tab's
 * lifetime — and strip the fragment from the address bar via `history.replaceState` before
 * anything else (render, error handling) runs. Takes `location`/`storage`/`history` as params so
 * a test can pass fakes instead of touching a real browser. No `#t=` present → returns whatever
 * token is already stored, or null; never throws.
 */
export function scrubToken(loc, storage, history) {
  const hash = loc.hash.startsWith("#") ? loc.hash.slice(1) : loc.hash;
  const token = new URLSearchParams(hash).get("t");
  if (token) {
    storage.setItem("glosa_token", token);
    history.replaceState(null, "", loc.pathname + loc.search);
    return token;
  }
  return storage.getItem("glosa_token");
}

/**
 * The CLI's deep-link (`glosa open <file>` → `#t=…&w=<slug>&a=<artifact>`): which workspace to
 * select and which artifact to focus on load. MUST be read before `scrubToken` strips the
 * fragment. Absent params → both null (plain `glosa open <dir>` behavior).
 */
export function readFocus(loc) {
  const hash = loc.hash.startsWith("#") ? loc.hash.slice(1) : loc.hash;
  const params = new URLSearchParams(hash);
  return { slug: params.get("w"), artifact: params.get("a") };
}

/**
 * Pure: which of R5's four screens to render. `handshake` is the parsed `/api/handshake` body,
 * or null if the fetch failed/threw. `token` is whatever `scrubToken` returned.
 */
export function selectScreen(handshake, token) {
  if (!handshake) return "down";
  const daemonMajor = String(handshake.contract_version).split(".")[0];
  const spaMajor = CONTRACT_VERSION.split(".")[0];
  if (daemonMajor !== spaMajor) return "mismatch";
  if (!token || handshake.paired === false) return "unpaired";
  return "ready";
}

function render(screen) {
  const app = document.getElementById("app");
  for (const el of app.querySelectorAll("[data-screen]")) {
    const isMatch = el.dataset.screen === screen;
    el.hidden = !isMatch;
    if (isMatch && MESSAGES[screen]) {
      // The failure screens carry static teaching markup in shell.html; the dynamic status line
      // goes into their [data-message] slot (textContent — never innerHTML).
      const slot = el.querySelector("[data-message]") ?? el;
      slot.textContent = MESSAGES[screen];
    }
  }
}

async function main() {
  const focus = readFocus(window.location); // before scrubToken — it strips the fragment
  const token = scrubToken(window.location, window.sessionStorage, window.history);

  let handshake = null;
  try {
    const res = await fetch("/api/handshake");
    if (res.ok) handshake = await res.json();
  } catch {
    handshake = null; // daemon unreachable → "down" screen
  }

  const screen = selectScreen(handshake, token);
  render(screen);
  if (screen === "mismatch") {
    // R5's third failure screen reloads to fetch the fresh shell + bootstrap the daemon
    // just advertised (A1 §3).
    setTimeout(() => window.location.reload(), 2000);
  }
  if (screen === "ready") {
    const readyEl = document.querySelector('[data-screen="ready"]');
    mountApp(readyEl, {
      initialSlug: focus.slug ?? undefined,
      initialArtifact: focus.artifact ?? undefined,
      appearance,
    });
  }
}

// Guarded so importing this module (bun test, importing scrubToken/selectScreen directly) never
// tries to touch a real window/document — only an actual browser load runs main().
if (typeof window !== "undefined") main();

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
export const CONTRACT_VERSION = "1.2";

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

const SURFACES = new Set(["document", "workspace"]);
const MODES = new Set(["preview", "annotate", "edit"]);

/**
 * Read non-secret route state and pairing secrets from the URL fragment. MUST run before
 * `scrubSecrets` strips `t`/`p`. Absent params → nulls (plain workspace open behavior).
 */
export function readRoute(loc) {
  const hash = loc.hash.startsWith("#") ? loc.hash.slice(1) : loc.hash;
  const params = new URLSearchParams(hash);
  const surfaceRaw = params.get("surface");
  const modeRaw = params.get("mode");
  const lockRaw = params.get("lock");
  return {
    slug: params.get("w"),
    artifact: params.get("a"),
    surface: SURFACES.has(surfaceRaw) ? surfaceRaw : null,
    mode: MODES.has(modeRaw) ? modeRaw : null,
    previewLock: lockRaw === "preview",
    durableToken: params.get("t"),
    presentationToken: params.get("p"),
  };
}

/** @deprecated Prefer `readRoute` — kept as a thin alias for existing tests/callers. */
export function readFocus(loc) {
  const route = readRoute(loc);
  return { slug: route.slug, artifact: route.artifact };
}

/**
 * The FIRST thing bootstrap does (A3 §3/F24): read pairing secrets (`t=` durable or `p=`
 * presentation) out of the URL fragment, stash the durable token in sessionStorage — never
 * localStorage — and rewrite the address bar to keep only non-secret route state before anything
 * else (render, error handling) runs. Takes `location`/`storage`/`history` as params so a test
 * can pass fakes instead of touching a real browser.
 *
 * When `p=` is present, the caller must redeem it first and pass the durable token as
 * `redeemedToken`; this function never performs network I/O itself.
 *
 * @param {string | null} [redeemedToken]
 */
export function scrubSecrets(loc, storage, history, route = readRoute(loc), redeemedToken = null) {
  const durable = redeemedToken || route.durableToken;
  const hadSecret = Boolean(route.durableToken || route.presentationToken || redeemedToken);
  if (durable) storage.setItem("glosa_token", durable);
  if (hadSecret) {
    const nextHash = focusHash({
      slug: route.slug,
      artifact: route.artifact,
      surface: route.surface,
      mode: route.mode,
      previewLock: route.previewLock,
    });
    history.replaceState(null, "", loc.pathname + loc.search + nextHash);
  }
  return durable || storage.getItem("glosa_token");
}

/** @deprecated Prefer `scrubSecrets`. */
export function scrubToken(loc, storage, history) {
  return scrubSecrets(loc, storage, history);
}

/**
 * The inverse of `readRoute`'s non-secret fields: rebuild `#w=&a=&surface=&mode=&lock=` (never
 * `t=` / `p=`). That is the load-bearing guard: live-reflecting focus into the address bar can't
 * re-expose pairing secrets that bootstrap deliberately stripped (A3 §3/F24).
 */
export function focusHash({ slug, artifact, surface, mode, previewLock } = {}) {
  const params = new URLSearchParams();
  if (slug) params.set("w", slug);
  if (artifact) params.set("a", artifact);
  if (surface) params.set("surface", surface);
  if (mode) params.set("mode", mode);
  if (previewLock) params.set("lock", "preview");
  const query = params.toString();
  return query ? `#${query}` : "";
}

/**
 * Reflect the on-screen focus into the address bar via `history.replaceState` — no new history
 * entry per artifact, so reload/refresh restores the view and the URL stays shareable. Rebuilds
 * `pathname + search + focusHash(...)` from scratch (same shape scrub leaves behind), which is
 * why secrets can never reappear.
 */
export function writeFocus(loc, history, focus) {
  history.replaceState(null, "", loc.pathname + loc.search + focusHash(focus));
}

/**
 * Pure: which of R5's four screens to render. `handshake` is the parsed `/api/handshake` body,
 * or null if the fetch failed/threw. `token` is whatever scrub returned.
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

async function redeemPresentationToken(presentationToken) {
  const res = await fetch("/api/presentation-token/redeem", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: window.location.origin,
    },
    body: JSON.stringify({ token: presentationToken }),
  });
  if (!res.ok) return null;
  const body = await res.json();
  return typeof body?.token === "string" ? body.token : null;
}

async function main() {
  const route = readRoute(window.location); // before scrub — it strips secrets from the fragment
  let redeemed = null;
  if (route.presentationToken) {
    try {
      redeemed = await redeemPresentationToken(route.presentationToken);
    } catch {
      redeemed = null;
    }
  }
  const token = scrubSecrets(window.location, window.sessionStorage, window.history, route, redeemed);

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
    const surface = route.surface ?? "workspace";
    const initialMode = route.mode ?? "preview";
    const previewLock = Boolean(route.previewLock);
    mountApp(readyEl, {
      initialSlug: route.slug ?? undefined,
      initialArtifact: route.artifact ?? undefined,
      surface,
      initialMode,
      previewLock,
      appearance,
      onFocusChange: (next) =>
        writeFocus(window.location, window.history, {
          ...next,
          surface,
          mode: next.mode ?? initialMode,
          previewLock,
        }),
    });
  }
}

// Guarded so importing this module (bun test, importing scrubToken/selectScreen directly) never
// tries to touch a real window/document — only an actual browser load runs main().
if (typeof window !== "undefined") main();

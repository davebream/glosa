// SPDX-License-Identifier: Apache-2.0
// @glosa/spa — what the page says when the daemon it was served by changes (#432).
//
// Contract: docs/design/2026-09-29-install-lifetime-and-restart.md, rules R-L6 and R-L8. The data
// layer reports two facts, once each: `install-changed` (the daemon said goodbye because its
// install changed under it) and `build-changed` (the daemon answering now is another build than
// the one that served this page). This module turns them into one notice in the workbench's
// banner row, and it reloads only when the person clicks. In the desktop app it also asks the shell
// to bring its own install's daemon back (R-L8); in a plain browser it says how.

/** Every string the notice can show. No em dash anywhere (AGENTS.md "Naming and copy"). */
export const UPDATE_COPY = Object.freeze({
  restarting: "glosa was updated and is restarting.",
  reload: "glosa was updated. Reload to use the new version.",
  reloadButton: "Reload",
  terminal: "glosa was updated. Run glosa open in a terminal to start it again.",
  removed: "glosa was removed or updated. Quit glosa and open it again.",
  foreign: "Another glosa install is answering. Quit glosa and open it again.",
});

/** How long after `install-changed` the desktop app asks its shell for a daemon (R-L8), and how long
 *  a plain browser waits before telling the person to start glosa themselves. */
export const ENSURE_DAEMON_AFTER_MS = 3000;
export const TERMINAL_HINT_AFTER_MS = 10_000;

/**
 * @param {{
 *   document: Document,
 *   reload: () => void,
 *   shell?: { ensureDaemon?: () => Promise<{ ok: boolean, reason?: string, message?: string }> } | null,
 *   setTimeout?: (fn: () => void, ms: number) => unknown,
 *   clearTimeout?: (handle: unknown) => void,
 * }} deps
 */
export function createUpdateNotice(deps) {
  const doc = deps.document;
  const schedule = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = deps.clearTimeout ?? ((handle) => clearTimeout(/** @type {any} */ (handle)));
  /** @type {HTMLElement | null} */
  let el = null;
  /** @type {HTMLElement | null} */
  let text = null;
  /** @type {HTMLButtonElement | null} */
  let button = null;
  /** @type {unknown} */
  let timer = null;
  let rebuilt = false;

  function ensureElement() {
    if (el) return;
    el = doc.createElement("div");
    el.className = "glosa-update-notice";
    el.setAttribute("role", "status");
    text = doc.createElement("span");
    button = doc.createElement("button");
    button.type = "button";
    button.textContent = UPDATE_COPY.reloadButton;
    button.hidden = true;
    button.addEventListener("click", () => deps.reload());
    el.append(text, button);
    // The workbench's banner row when the viewer is mounted; otherwise the top of the page.
    const row = doc.querySelector(".glosa-banners");
    if (row) row.prepend(el);
    else doc.body.prepend(el);
  }

  /** @param {string} message @param {boolean} withReload */
  function say(message, withReload) {
    ensureElement();
    /** @type {HTMLElement} */ (text).textContent = message;
    /** @type {HTMLButtonElement} */ (button).hidden = !withReload;
  }

  function clearTimer() {
    if (timer !== null) cancel(timer);
    timer = null;
  }

  async function askShell() {
    const ensure = deps.shell?.ensureDaemon;
    if (typeof ensure !== "function") return;
    try {
      const result = await ensure();
      if (rebuilt) return;
      if (result.ok) return; // a daemon answers again; the reconnect reports `build-changed`
      if (result.reason === "removed") say(UPDATE_COPY.removed, false);
      else if (result.reason === "foreign") say(UPDATE_COPY.foreign, false);
      else say(result.message || UPDATE_COPY.terminal, false);
    } catch {
      if (!rebuilt) say(UPDATE_COPY.removed, false);
    }
  }

  return {
    /** @param {"install-changed" | "build-changed"} kind */
    show(kind) {
      if (kind === "build-changed") {
        rebuilt = true;
        clearTimer();
        say(UPDATE_COPY.reload, true);
        return;
      }
      if (rebuilt) return;
      say(UPDATE_COPY.restarting, false);
      clearTimer();
      if (typeof deps.shell?.ensureDaemon === "function") {
        timer = schedule(() => {
          timer = null;
          void askShell();
        }, ENSURE_DAEMON_AFTER_MS);
      } else {
        timer = schedule(() => {
          timer = null;
          if (!rebuilt) say(UPDATE_COPY.terminal, false);
        }, TERMINAL_HINT_AFTER_MS);
      }
    },
    /** For tests and teardown. */
    get element() {
      return el;
    },
  };
}

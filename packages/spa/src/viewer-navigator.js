// SPDX-License-Identifier: Apache-2.0
// Navigator visibility and the collapsible Starred section at its foot. Transport-free — mountApp injects
// the elements and storage this needs.
//
// The navigator has ONE control and ONE behaviour: the corner toggle shows or hides a column,
// at every width. It is never an overlay.
//
// It used to become a drawer over the manuscript below 1024px, on the theory that a 260px column
// would push the manuscript under its reading floor. The workbench replaced that theory with a
// floor: the app keeps a minimum width, the navigator keeps its column, every pane keeps its own
// minimum, and a viewport narrower than the sum clips the workbench rather than restacking it —
// the way a desktop editor does. A drawer that covers the work the moment the window narrows is
// a worse answer than a column the reader can close themselves, and closing it is one click they
// were always able to make.
//
// The shown/hidden choice is therefore a single preference, remembered at every width, because it
// now means the same thing at every width.

export const NAV_OPEN_STORAGE_KEY = "glosa_nav_open";
export const NAV_STARRED_STORAGE_KEY = "glosa_nav_starred";

function defaultStorage() {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function readFlag(storage, key, fallback) {
  try {
    const stored = storage?.getItem(key);
    if (stored === "true") return true;
    if (stored === "false") return false;
  } catch {
    // Storage can be disabled by browser policy; the default is still a usable navigator.
  }
  return fallback;
}

function writeFlag(storage, key, value) {
  try {
    storage?.setItem(key, String(value));
  } catch {
    // Applying the choice for this page remains useful when persistence is unavailable.
  }
}

/**
 * @param {{
 *   root: any,
 *   elements: any,
 *   storage?: any,
 *   enabled?: boolean,
 *   desk?: boolean,
 * }} options
 */
export function createNavigatorController({
  root,
  elements,
  storage = defaultStorage(),
  enabled = true,
  desk = true,
} = {}) {
  const { navToggle, sidebarEl, artifactList, starredToggle, starredSection, starredList } = elements;

  let starredExpanded = readFlag(storage, NAV_STARRED_STORAGE_KEY, true);
  let starredAvailable = false;
  // A presented single document has no workspace to navigate, so there is nothing to show and no
  // preference to honour.
  let open = enabled && readFlag(storage, NAV_OPEN_STORAGE_KEY, true);

  function syncInteractivity() {
    // A hidden navigator is display:none, and therefore already out of the focus order; `inert`
    // and `aria-hidden` state it anyway so nothing depends on the CSS having loaded.
    const unreachable = enabled && !open;
    sidebarEl.inert = unreachable;
    if (unreachable) sidebarEl.setAttribute("aria-hidden", "true");
    else sidebarEl.removeAttribute("aria-hidden");
  }

  /**
   * @param {boolean} next
   * @param {{ restoreFocus?: boolean, persist?: boolean }} [options]
   */
  function setOpen(next, { restoreFocus = false, persist = false } = {}) {
    open = Boolean(next);
    root.setAttribute("data-nav-open", String(open));
    navToggle.setAttribute("aria-expanded", String(open));
    navToggle.setAttribute("aria-label", open ? "Hide navigator" : "Show navigator");
    navToggle.title = open ? "Hide navigator" : "Show navigator"; /* the same name the tools beside it show */
    if (persist) writeFlag(storage, NAV_OPEN_STORAGE_KEY, open);
    syncInteractivity();
    // A column appearing beside the work must not pull the reader out of the text, so showing it
    // never moves focus. Hiding it returns focus to the control that hid it.
    if (!open && restoreFocus) queueMicrotask(() => navToggle.focus({ preventScroll: true }));
  }

  function applyStarred() {
    // Nothing starred, nothing shown: the star beside the Documents heading is how a first star is
    // taken, so an empty section would only be a label with nothing under it.
    starredSection.hidden = !starredAvailable || !desk;
    starredToggle.setAttribute("aria-expanded", String(starredExpanded));
    starredList.hidden = !starredExpanded;
  }

  function toggleStarred() {
    starredExpanded = !starredExpanded;
    writeFlag(storage, NAV_STARRED_STORAGE_KEY, starredExpanded);
    applyStarred();
  }

  function onNavToggle() {
    setOpen(!open, { restoreFocus: true, persist: true });
  }

  navToggle.addEventListener("click", onNavToggle);
  starredToggle.addEventListener("click", toggleStarred);

  applyStarred();
  setOpen(open);

  return {
    isOpen: () => open,
    setOpen,

    /** Moves keyboard focus into the tree — the current artifact's row when there is one. Used by
     * the toggle's keyboard path, never by showing the column itself. */
    focusTree() {
      const target =
        artifactList.querySelector('[role="treeitem"][aria-current="page"]') ??
        artifactList.querySelector('[role="treeitem"][tabindex="0"]') ??
        starredList.querySelector('button[aria-current="true"]') ??
        starredList.querySelector("button");
      target?.focus();
    },

    /** @param {boolean} available */
    setStarredAvailable(available) {
      starredAvailable = Boolean(available);
      applyStarred();
    },

    isStarredExpanded: () => starredExpanded,

    destroy() {
      navToggle.removeEventListener("click", onNavToggle);
      starredToggle.removeEventListener("click", toggleStarred);
    },
  };
}

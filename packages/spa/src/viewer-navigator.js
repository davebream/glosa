// SPDX-License-Identifier: Apache-2.0
// Navigator visibility and the collapsible workspace switcher. Transport-free — mountApp injects
// the elements and storage this needs.
//
// The navigator has ONE control and ONE behaviour: the top-bar toggle shows or hides a column,
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
export const NAV_WORKSPACES_STORAGE_KEY = "glosa_nav_workspaces";

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
 * }} options
 */
export function createNavigatorController({ root, elements, storage = defaultStorage(), enabled = true } = {}) {
  const { navToggle, sidebarEl, sidebarList, artifactList, workspacesToggle, workspacesSection } = elements;

  let workspacesExpanded = readFlag(storage, NAV_WORKSPACES_STORAGE_KEY, true);
  let workspacesAvailable = false;
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
    navToggle.setAttribute("aria-label", open ? "Hide artifacts" : "Show artifacts");
    if (persist) writeFlag(storage, NAV_OPEN_STORAGE_KEY, open);
    syncInteractivity();
    // A column appearing beside the work must not pull the reader out of the text, so showing it
    // never moves focus. Hiding it returns focus to the control that hid it.
    if (!open && restoreFocus) queueMicrotask(() => navToggle.focus({ preventScroll: true }));
  }

  function applyWorkspaces() {
    // MCP/CLI single-workspace mode: a "list of one" is noise — you're already scoped. The whole
    // section (its disclosure included) stands down until a SECOND workspace is live. Buttons stay
    // in the DOM for markCurrent.
    workspacesSection.hidden = !workspacesAvailable;
    workspacesToggle.setAttribute("aria-expanded", String(workspacesExpanded));
    sidebarList.hidden = !workspacesExpanded;
  }

  function toggleWorkspaces() {
    workspacesExpanded = !workspacesExpanded;
    writeFlag(storage, NAV_WORKSPACES_STORAGE_KEY, workspacesExpanded);
    applyWorkspaces();
  }

  function onNavToggle() {
    setOpen(!open, { restoreFocus: true, persist: true });
  }

  navToggle.addEventListener("click", onNavToggle);
  workspacesToggle.addEventListener("click", toggleWorkspaces);

  applyWorkspaces();
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
        sidebarList.querySelector('button[aria-current="true"]') ??
        sidebarList.querySelector("button");
      target?.focus();
    },

    /** @param {boolean} available */
    setWorkspacesAvailable(available) {
      workspacesAvailable = Boolean(available);
      applyWorkspaces();
    },

    destroy() {
      navToggle.removeEventListener("click", onNavToggle);
      workspacesToggle.removeEventListener("click", toggleWorkspaces);
    },
  };
}

// SPDX-License-Identifier: Apache-2.0
// Navigator visibility and the collapsible workspace switcher. Transport-free — mountApp injects
// the elements and storage this needs.
//
// The navigator has ONE control: the top-bar toggle. What that toggle produces depends on whether
// the viewport can host a column beside the manuscript:
//   * 1024px and wider — a persistent column, like an editor's file tree. Never an overlay, so it
//     survives opening an artifact, and the shown/hidden choice is remembered per browser.
//   * narrower — an overlay drawer, because a 260px column would push the manuscript under the
//     ~60ch floor the design brief sets. A drawer is transient: it starts closed, and opening an
//     artifact, Escape, or the backdrop dismisses it. Nothing about it is persisted, so a narrow
//     session can never leave the desk-width column hidden.

export const NAV_OPEN_STORAGE_KEY = "glosa_nav_open";
export const NAV_WORKSPACES_STORAGE_KEY = "glosa_nav_workspaces";

// Paired with app.css's `@media (min-width: 1024px)` column rules.
export const DRAWER_ONLY_QUERY = "(max-width: 1023px)";

function defaultStorage() {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function defaultMedia(query) {
  if (typeof window === "undefined") return false;
  return Boolean(window.matchMedia?.(query)?.matches);
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
 *   media?: (query: string) => boolean,
 *   enabled?: boolean,
 * }} options
 */
export function createNavigatorController({
  root,
  elements,
  storage = defaultStorage(),
  media = defaultMedia,
  enabled = true,
} = {}) {
  const { navToggle, sidebarEl, sidebarList, artifactList, workspacesToggle, workspacesSection } = elements;

  let workspacesExpanded = readFlag(storage, NAV_WORKSPACES_STORAGE_KEY, true);
  let workspacesAvailable = false;

  const isDocked = () => enabled && !media(DRAWER_ONLY_QUERY);
  const naturalOpen = () => isDocked() && readFlag(storage, NAV_OPEN_STORAGE_KEY, true);

  let open = naturalOpen();
  let wasDocked = isDocked();

  function syncInteractivity() {
    // A hidden navigator is out of the focus order either way: the drawer is translated
    // off-screen and the column is display:none.
    const unreachable = enabled && !open;
    sidebarEl.inert = unreachable;
    if (unreachable) sidebarEl.setAttribute("aria-hidden", "true");
    else sidebarEl.removeAttribute("aria-hidden");
  }

  /**
   * @param {boolean} next
   * @param {{ restoreFocus?: boolean, focusDrawer?: boolean, persist?: boolean }} [options]
   */
  function setOpen(next, { restoreFocus = false, focusDrawer = false, persist = false } = {}) {
    open = Boolean(next);
    root.setAttribute("data-nav-open", String(open));
    navToggle.setAttribute("aria-expanded", String(open));
    navToggle.setAttribute("aria-label", open ? "Hide artifacts" : "Show artifacts");
    // Only the desk-width column is a preference. Persisting a drawer's state would let a narrow
    // session's transient dismissal hide the column on the next wide one.
    if (persist && isDocked()) writeFlag(storage, NAV_OPEN_STORAGE_KEY, open);
    syncInteractivity();
    // Only a drawer takes focus with it — a column appearing beside the manuscript must not pull
    // the reader out of the text.
    if (open && focusDrawer && !isDocked()) {
      queueMicrotask(() => {
        const target =
          artifactList.querySelector('[role="treeitem"][aria-current="page"]') ??
          artifactList.querySelector('[role="treeitem"][tabindex="0"]') ??
          sidebarList.querySelector('button[aria-current="true"]') ??
          sidebarList.querySelector("button");
        target?.focus();
      });
    } else if (!open && restoreFocus) {
      queueMicrotask(() => navToggle.focus({ preventScroll: true }));
    }
  }

  function applyWorkspaces() {
    // MCP/CLI single-workspace mode: a "list of one" is noise — you're already scoped. The whole
    // section (its disclosure included) stands down until a SECOND workspace is live. Buttons stay
    // in the DOM for markCurrent and the drawer's focus fallback.
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
    setOpen(!open, { focusDrawer: true, restoreFocus: true, persist: true });
  }

  navToggle.addEventListener("click", onNavToggle);
  workspacesToggle.addEventListener("click", toggleWorkspaces);

  applyWorkspaces();
  setOpen(open);

  return {
    isDocked,
    isOpen: () => open,
    setOpen,

    /** Crossing the column breakpoint resets the navigator to that width's natural state: the
     * remembered column where there is room for one, a closed drawer where there is not. */
    handleResize() {
      const dockedNow = isDocked();
      if (dockedNow === wasDocked) {
        syncInteractivity();
        return;
      }
      wasDocked = dockedNow;
      setOpen(naturalOpen());
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

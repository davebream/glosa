// SPDX-License-Identifier: Apache-2.0
// @glosa/spa — the workbench dock: tabs, splits, and layout persistence for several artifacts at
// once (design brief docs/design/2026-09-04-multi-artifact-workbench-brief.md §5, §9, §10).
//
// dockview-core 8.2.0 is vendored under vendor/dockview.js and themed entirely through its CSS
// custom properties (app.css's `.glosa-dock-theme` block). glosa keeps ownership of everything
// INSIDE a pane: this module only decides which panes exist, where they sit, and what their tabs
// say. Tabs and splits are furniture — an index tab on a manuscript, never IDE chrome.
//
// Deliberately NOT used, per §9 and §12: floating groups, popout windows, and every
// dockview-enterprise feature (keyboard docking, spatial keyboard navigation, multi-row tabs,
// pinned tabs, DnD compass, smart guides, edge groups, layout history, tab context menus). The
// non-drag alternative WCAG 2.2 SC 2.5.7 requires is built here on the free movement API.

import { createDockview } from "./vendor/dockview.js";
import { createElement as el } from "./viewer-shell.js";

/** A pane cannot be dragged narrower than this. It is where the compact annotation tray ladder
 * bottoms out, and it is the whole constraint on nesting: a physical floor on usable width
 * rather than an arbitrary cap on depth (§9). */
export const MIN_PANE_WIDTH = 360;

export const LAYOUT_STORAGE_PREFIX = "glosa:layout:";

/**
 * Tab labels. The label is the filename; when two open tabs share one, both grow the shortest
 * distinguishing parent segment (`drafts/index.md` and `final/index.md`), the way an editor does
 * (§5). Pure, and exported so the rule is testable without a dock.
 *
 * @param {string[]} paths workspace-relative artifact paths
 * @returns {Map<string, string>} path → label
 */
export function disambiguateLabels(paths) {
  const labels = new Map();
  /** @type {Map<string, string[]>} */
  const byBasename = new Map();
  for (const path of paths) {
    const segments = path.split("/");
    const basename = segments[segments.length - 1];
    const group = byBasename.get(basename);
    if (group) group.push(path);
    else byBasename.set(basename, [path]);
  }
  for (const group of byBasename.values()) {
    if (group.length === 1) {
      labels.set(group[0], group[0].split("/").pop());
      continue;
    }
    const split = group.map((path) => path.split("/"));
    const deepest = Math.max(...split.map((segments) => segments.length));
    // Grow the whole group together: two tabs distinguished by different depths would read as
    // unrelated files rather than as the same name in two places.
    let depth = 1;
    for (; depth < deepest; depth++) {
      const tails = split.map((segments) => segments.slice(-1 - depth).join("/"));
      if (new Set(tails).size === group.length) break;
    }
    for (const [index, path] of group.entries()) {
      labels.set(path, split[index].slice(-1 - depth).join("/"));
    }
  }
  return labels;
}

/** A diff tab's id is the pair it shows, so asking for the same comparison twice focuses the tab
 * that already holds it rather than opening a second one (§5). */
export function diffPanelId(path, from, to) {
  return `diff:${path}:${from}:${to}`;
}

/** Shortens an opaque checkpoint token for a tab label. `working` is the live file, and says so
 * in the reader's own words rather than leaking the token vocabulary (R1). */
export function describeVersion(token) {
  if (token === "working") return "now";
  return typeof token === "string" ? token.slice(0, 7) : String(token);
}

const CLASS_GLYPHS = {
  // The same two marks the navigator tree uses for artifact class, at tab scale. Shape, not
  // color: R is a page with a fold, F is a page with a frame.
  R: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.2 1.8H4.4a1.3 1.3 0 0 0-1.3 1.3v9.8a1.3 1.3 0 0 0 1.3 1.3h7.2a1.3 1.3 0 0 0 1.3-1.3V5.6Z"/><path d="M9.2 1.8v3.8h3.7"/></svg>',
  F: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.4" y="2.8" width="11.2" height="10.4" rx="1.3"/><path d="M2.4 6.1h11.2"/></svg>',
};

const DIFF_GLYPH =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.6 2.6H3.5a1.1 1.1 0 0 0-1.1 1.1v8.6a1.1 1.1 0 0 0 1.1 1.1h2.1M10.4 2.6h2.1a1.1 1.1 0 0 1 1.1 1.1v8.6a1.1 1.1 0 0 1-1.1 1.1h-2.1M8 1.4v13.2"/></svg>';

const CLOSE_GLYPH = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.6 4.6 6.8 6.8M11.4 4.6l-6.8 6.8"/></svg>';

/**
 * Creates the dock inside `host`.
 *
 * `deps.createPane(id, params, host)` builds the pane body for a panel and returns a handle with
 * `{ element, destroy(), confirmClose?() }` plus whatever the tab renderer needs. The dock never
 * looks inside a pane beyond `deps.getTabState`.
 */
export function createDock(host, deps) {
  const {
    slug,
    appearance,
    createPane,
    destroyPane,
    getTabState = () => ({}),
    onActivePanelChange = () => {},
    onLayoutChange = () => {},
    confirmClosePanel = () => Promise.resolve(true),
    storage = defaultStorage(),
    emptyState,
  } = deps;

  /** @type {Map<string, { element: HTMLElement, refresh: () => void }>} */
  const tabViews = new Map();
  let restoring = false;
  const closingGuard = new Set();

  const theme = {
    name: "glosa-workbench",
    className: "glosa-dock-theme",
    colorScheme: appearance?.getSnapshot?.().resolved ?? "light",
    // One pixel of gap so a sash reads as the same quiet rule as every other border in the
    // workbench, rather than as a raised divider.
    gap: 1,
    dndOverlayMounting: "relative",
    dndPanelOverlay: "content",
    dndTabIndicator: "line",
    dndOverlayBorder: "2px solid var(--primary)",
    tabGroupIndicator: "none",
  };

  const api = createDockview(host, {
    theme,
    className: "glosa-dock",
    // HTML5 drag-and-drop is unreliable on Safari, which is inside glosa's browser floor (§9).
    dndStrategy: "pointer",
    // Floating groups are shadowed cards over the work, which DESIGN.md §4's
    // Flat-Until-Floating Rule forbids. Popout windows would need a second route and a CSP
    // amendment; the desktop shell is their honest home.
    disableFloatingGroups: true,
    noPanelsOverlay: "watermark",
    // Required so a class-F pane's iframe survives a tab switch without re-minting (§11).
    defaultRenderer: "always",
    disableTabsOverflowList: false,
    createComponent: ({ id }) => {
      const element = el("div", { className: "glosa-panel" });
      let pane = null;
      return {
        element,
        init(parameters) {
          pane = createPane(id, parameters.params ?? {}, element, parameters.api);
        },
        dispose() {
          destroyPane(id, pane);
          tabViews.delete(id);
        },
      };
    },
    createTabComponent: ({ id }) => {
      const element = el("div", { className: "glosa-tab" });
      const glyph = el("span", { className: "glosa-tab-glyph", "aria-hidden": "true" });
      const label = el("span", { className: "glosa-tab-label" });
      const badges = el("span", { className: "glosa-tab-badges" });
      const close = el("button", {
        className: "glosa-tab-close",
        type: "button",
        "aria-label": "Close tab",
        onClick: (event) => {
          event.stopPropagation();
          void requestClose(id);
        },
      });
      close.innerHTML = CLOSE_GLYPH;
      element.append(glyph, label, badges, close);

      function refresh() {
        const state = getTabState(id) ?? {};
        glyph.innerHTML = state.kind === "diff" ? DIFF_GLYPH : (CLASS_GLYPHS[state.artifactClass] ?? CLASS_GLYPHS.R);
        label.textContent = state.label ?? id;
        element.title = state.tooltip ?? id;
        element.setAttribute("data-missing", String(Boolean(state.missing)));
        badges.textContent = "";
        // Every badge reuses the navigator tree's vocabulary rather than inventing a second one
        // (§12), and every one of them carries text as well as a shape — DESIGN.md §2's Status
        // Needs Shape Rule holds inside a 28px tab too.
        if (state.stale) {
          badges.append(
            el("span", {
              className: "glosa-tab-stale",
              title: "Generated artifact is out of date",
              "aria-label": "Out of date",
            }),
          );
        }
        if (state.unresolved > 0) {
          const count = el("span", {
            className: "glosa-tab-count",
            textContent: String(state.unresolved),
            "aria-label": `${state.unresolved} open ${state.unresolved === 1 ? "annotation" : "annotations"}`,
          });
          count.title = `${state.unresolved} open ${state.unresolved === 1 ? "annotation" : "annotations"}`;
          badges.append(count);
        }
        if (state.dirty) {
          badges.append(
            el("span", { className: "glosa-tab-dirty", title: "Unsaved edits", "aria-label": "Unsaved edits" }),
          );
        }
      }

      tabViews.set(id, { element, refresh });
      return {
        element,
        init() {
          refresh();
        },
        update() {
          refresh();
        },
        dispose() {
          tabViews.delete(id);
        },
      };
    },
    createWatermarkComponent: () => {
      const element = el("div", { className: "glosa-watermark" });
      return {
        element,
        init() {
          element.textContent = "";
          element.append(emptyState());
        },
      };
    },
  });

  const stopAppearance = appearance?.subscribe?.(({ resolved }) => {
    // §9: the dock's appearance comes from the app's resolved value, never from
    // `prefers-color-scheme` — otherwise the dock disagrees with the workbench whenever the
    // reader has chosen an explicit Light or Dark override.
    api.updateOptions({ theme: { ...theme, colorScheme: resolved } });
  });

  function refreshTabs() {
    for (const view of tabViews.values()) view.refresh();
  }

  /** Relabels every tab: opening or closing one can make a filename ambiguous, or unambiguous
   * again, for tabs that did not themselves change (§5). */
  function relabel() {
    refreshTabs();
  }

  async function requestClose(id) {
    if (closingGuard.has(id)) return;
    closingGuard.add(id);
    try {
      const panel = api.getPanel(id);
      if (!panel) return;
      if (!(await confirmClosePanel(id))) return;
      panel.api.close();
    } finally {
      closingGuard.delete(id);
    }
  }

  api.onDidActivePanelChange((event) => {
    onActivePanelChange(event?.panel?.id ?? null);
  });
  api.onDidLayoutChange(() => {
    relabel();
    if (!restoring) saveLayout();
    onLayoutChange();
  });
  api.onDidAddPanel(() => relabel());
  api.onDidRemovePanel(() => relabel());

  function storageKey() {
    return `${LAYOUT_STORAGE_PREFIX}${slug}`;
  }

  function saveLayout() {
    if (!storage) return;
    try {
      storage.setItem(storageKey(), JSON.stringify(api.toJSON()));
    } catch {
      // Storage can be disabled by browser policy; the arrangement still works for this visit.
    }
  }

  /**
   * Restores the saved arrangement. Defensive by requirement (§10): a panel whose artifact no
   * longer exists is dropped, and if restore throws for any reason the caller falls back to a
   * single pane. A corrupt saved layout must never make a workspace unopenable.
   *
   * @param {(id: string, params: any) => boolean} isStillValid
   * @returns {boolean} whether a layout was restored
   */
  function restoreLayout(isStillValid) {
    if (!storage) return false;
    let raw;
    try {
      raw = storage.getItem(storageKey());
    } catch {
      return false;
    }
    if (!raw) return false;
    restoring = true;
    try {
      const saved = JSON.parse(raw);
      const panels = saved?.panels;
      if (!panels || typeof panels !== "object") return false;
      for (const [id, panel] of Object.entries(panels)) {
        if (!isStillValid(id, panel?.params ?? {})) delete panels[id];
      }
      if (Object.keys(panels).length === 0) return false;
      pruneGrid(saved.grid?.root, new Set(Object.keys(panels)));
      api.fromJSON(saved);
      return api.panels.length > 0;
    } catch {
      try {
        api.clear();
      } catch {
        // A half-restored dock is still replaced wholesale by the caller's fallback panel.
      }
      return false;
    } finally {
      restoring = false;
      saveLayout();
    }
  }

  function clearLayout() {
    try {
      storage?.removeItem(storageKey());
    } catch {
      // Nothing to clean up if storage is unavailable.
    }
  }

  /** Left/Right/Up/Down join the adjacent pane when there is one and split when there is not —
   * the same two outcomes dragging offers (center joins, an edge splits), reachable with a single
   * pointer. WCAG 2.2 SC 2.5.7 makes this a release requirement, not a nicety (§9). */
  function moveActivePanel(direction) {
    const panel = api.activePanel;
    if (!panel) return;
    const group = panel.api.group;
    if (direction === "new") {
      panel.api.moveTo({ group, position: "right" });
      return;
    }
    const adjacent = api.adjacentGroupInDirection(group, direction);
    if (adjacent && adjacent !== group) panel.api.moveTo({ group: adjacent, position: "center" });
    else panel.api.moveTo({ group, position: directionToPosition(direction) });
  }

  function directionToPosition(direction) {
    if (direction === "up") return "top";
    if (direction === "down") return "bottom";
    return direction;
  }

  function focusAdjacentGroup(direction) {
    const group = api.activeGroup;
    if (!group) return;
    const adjacent = api.adjacentGroupInDirection(group, direction);
    if (adjacent && adjacent !== group) adjacent.api.setActive();
  }

  return {
    api,
    relabel,
    refreshTabs,
    saveLayout,
    restoreLayout,
    clearLayout,
    requestClose,
    moveActivePanel,
    focusAdjacentGroup,
    activatePreviousTab: () => api.activatePrevious({ includePanel: true }),
    activateNextTab: () => api.activateNext({ includePanel: true }),
    /** The single-pointer equivalents §9 requires, offered in every pane's `⋯` menu. */
    moveCommands: () => [
      { id: "left", label: "Left", run: () => moveActivePanel("left") },
      { id: "right", label: "Right", run: () => moveActivePanel("right") },
      { id: "up", label: "Up", run: () => moveActivePanel("up") },
      { id: "down", label: "Down", run: () => moveActivePanel("down") },
      { id: "new", label: "New tab group", run: () => moveActivePanel("new") },
    ],
    destroy() {
      stopAppearance?.();
      api.dispose();
      tabViews.clear();
    },
  };
}

/** Drops references to pruned panels out of a saved grid tree, collapsing any branch left empty.
 * dockview refuses a layout whose grid names a panel its `panels` map no longer carries, so a
 * single deleted artifact would otherwise cost the reader their whole arrangement (§10). */
export function pruneGrid(node, keep) {
  if (!node || typeof node !== "object") return node;
  if (node.type === "leaf") {
    const views = Array.isArray(node.data?.views) ? node.data.views.filter((id) => keep.has(id)) : [];
    if (views.length === 0) return null;
    node.data.views = views;
    if (node.data.activeView && !keep.has(node.data.activeView)) node.data.activeView = views[0];
    return node;
  }
  if (Array.isArray(node.data)) {
    node.data = node.data.map((child) => pruneGrid(child, keep)).filter(Boolean);
    if (node.data.length === 0) return null;
    // A branch with one surviving child is a branch that no longer divides anything. Hoisting the
    // child keeps the sash count honest instead of leaving a sash with nothing on one side.
    if (node.data.length === 1 && node.data[0].type === node.type) return node.data[0];
  }
  return node;
}

function defaultStorage() {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

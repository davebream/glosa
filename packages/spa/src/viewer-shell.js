// SPDX-License-Identifier: Apache-2.0
// Static viewer composition. The shell owns markup and child-component lifecycles; mountApp injects
// every behavior callback and dependency so this module has no daemon or application-state access.
//
// Since the multi-artifact workbench (design brief 2026-09-04 §6) the top bar is WORKSPACE chrome
// and nothing else. The artifact name, the mode control, History, Copy source and Print all live
// inside the pane that holds their artifact — one bar cannot honestly speak for two documents.
// What stays here is true of the whole workspace: the navigator and its toggle, the brand mark, the
// workspace name, the attention tray, Agent feedback, Conversation, Appearance, Keyboard
// shortcuts, and the connection banner.

export function createElement(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "onClick") node.addEventListener("click", value);
    else if (key === "onInput") node.addEventListener("input", value);
    else if (key === "className") node.className = value;
    else if (key.startsWith("data-") || key.startsWith("aria-")) node.setAttribute(key, value);
    else node[key] = value;
  }
  for (const child of children) node.append(child);
  return node;
}

export function createViewerShell(
  root,
  {
    dataAccess,
    surface,
    appearance,
    mountAppearanceControl,
    mountAttentionTray,
    mountAgentFeedback,
    createArtifactTreeNavigator,
    onAttentionEntriesChange,
    onOpenArtifact,
    getCurrentArtifact,
    dictationController,
  },
) {
  const el = createElement;
  const navToggle = el("button", {
    className: "glosa-nav-toggle",
    type: "button",
    "aria-label": "Show artifacts",
    "aria-expanded": "false",
    "aria-controls": "glosa-sidebar",
  });
  // A panel glyph rather than a hamburger: this shows and hides one persistent side panel, and the
  // filled column is the shown state's shape, so it reads without relying on color.
  navToggle.innerHTML =
    '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2.5" y="4" width="15" height="12" rx="2"/><path d="M7.5 4v12"/><path class="glosa-nav-toggle-fill" d="M4.25 5h2.5v10h-2.5z"/></svg>';
  const brandMark = el("span", { className: "glosa-brand-mark", role: "img", "aria-label": "glosa" });
  brandMark.innerHTML =
    '<svg viewBox="0 0 32 32" aria-hidden="true"><path class="glosa-logo-under" transform="translate(1.6 1.4) scale(0.92)" d="M 10.94 3.21 C 11.23 3.19 11.78 3.21 12.09 3.21 L 14.15 3.21 C 17.28 3.2 22.41 3 25.19 4.31 C 26.19 4.78 27 5.56 27.37 6.61 C 28.33 9.35 26.38 14.58 25.2 17.08 C 22.68 22.39 17.31 26.56 11.85 28.51 C 11.34 28.69 10.77 28.85 10.25 29 C 10.13 28.75 10.02 28.5 9.91 28.24 C 11.77 27.37 13.39 26.34 14.72 24.75 C 15.04 24.36 15.38 23.97 15.65 23.55 C 20.86 15.29 9.97 16.08 5.24 17.56 C 4.57 17.77 3.82 17.28 3.71 16.56 C 3.67 16.33 3.7 16.1 3.79 15.89 C 3.92 15.57 4.34 15.09 4.57 14.79 C 4.81 14.46 5.05 14.12 5.27 13.78 C 6.77 11.48 8.15 8.87 8.94 6.23 C 9.33 4.9 9.17 3.49 10.94 3.21Z"/><path class="glosa-logo-accent" transform="scale(0.92)" d="M 10.94 3.21 C 11.23 3.19 11.78 3.21 12.09 3.21 L 14.15 3.21 C 17.28 3.2 22.41 3 25.19 4.31 C 26.19 4.78 27 5.56 27.37 6.61 C 28.33 9.35 26.38 14.58 25.2 17.08 C 22.68 22.39 17.31 26.56 11.85 28.51 C 11.34 28.69 10.77 28.85 10.25 29 C 10.13 28.75 10.02 28.5 9.91 28.24 C 11.77 27.37 13.39 26.34 14.72 24.75 C 15.04 24.36 15.38 23.97 15.65 23.55 C 20.86 15.29 9.97 16.08 5.24 17.56 C 4.57 17.77 3.82 17.28 3.71 16.56 C 3.67 16.33 3.7 16.1 3.79 15.89 C 3.92 15.57 4.34 15.09 4.57 14.79 C 4.81 14.46 5.05 14.12 5.27 13.78 C 6.77 11.48 8.15 8.87 8.94 6.23 C 9.33 4.9 9.17 3.49 10.94 3.21Z"/></svg>';
  // The bar's title is the artifact in the active pane — the document the reader is looking at —
  // and falls back to the workspace when no pane is open.
  const titleEl = el("span", { className: "glosa-topbar-name", textContent: "glosa" });
  // The title is also the way in to Go to (⌘K): shaped like a field so it reads as "find something
  // here", but a button, because clicking it opens the palette rather than accepting text.
  const goToTrigger = el(
    "button",
    {
      className: "glosa-goto-trigger",
      type: "button",
      "aria-haspopup": "dialog",
      "aria-keyshortcuts": "Meta+K",
      title: "Go to a section, a file or a command (⌘K)",
    },
    [titleEl, el("kbd", { className: "glosa-goto-key", "aria-hidden": "true", textContent: "⌘K" })],
  );
  const topbarOverlays = el("div", { className: "glosa-topbar-overlays" });
  const appearanceHost = el("div", { className: "glosa-appearance" });
  const attentionHost = el("div", { className: "glosa-attention" });
  const attentionTray = mountAttentionTray(attentionHost, {
    dataAccess,
    overlayHost: topbarOverlays,
    onEntriesChange: onAttentionEntriesChange,
    onOpenArtifact,
    getCurrentArtifact,
    dictationController,
  });
  const toolsTrigger = el("button", {
    className: "glosa-tools-trigger",
    type: "button",
    title: "More",
    "aria-label": "More",
    "aria-expanded": "false",
    "aria-controls": "glosa-tools-menu",
  });
  toolsTrigger.innerHTML =
    '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="4" cy="10" r="1"/><circle cx="10" cy="10" r="1"/><circle cx="16" cy="10" r="1"/></svg><span class="glosa-visually-hidden">More</span>';
  const shortcutsToggle = el("button", {
    className: "glosa-shortcuts-toggle",
    type: "button",
    "aria-label": "Keyboard shortcuts",
    "aria-expanded": "false",
    "aria-controls": "glosa-shortcuts",
  });
  shortcutsToggle.innerHTML =
    '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2.5" y="5.5" width="15" height="9.5" rx="1.5"/><path d="M5.5 8.5h.01M8.5 8.5h.01M11.5 8.5h.01M14.5 8.5h.01M6.5 12h7"/></svg><span>Keyboard shortcuts</span>';
  const stopAppearance = appearance
    ? mountAppearanceControl(appearanceHost, appearance, { overlayHost: topbarOverlays, returnFocus: toolsTrigger })
    : null;
  const toolsMenu = el(
    "div",
    { id: "glosa-tools-menu", className: "glosa-tools-menu", role: "group", "aria-label": "Workspace tools" },
    [attentionHost, appearanceHost, shortcutsToggle],
  );
  const tools = el("div", { className: "glosa-tools", "data-open": "false" }, [toolsTrigger, toolsMenu]);

  // One star shape for every star control, drawn rather than typed: outlined until pressed, filled
  // once starred (the CSS fills it), so the state reads without colour.
  const STAR_SVG =
    '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.9l2.13 4.32 4.77.69-3.45 3.36.81 4.75L10 13.78l-4.26 2.24.81-4.75L3.1 7.91l4.77-.69L10 2.9z"/></svg>';
  const starToggle = el("button", {
    className: "glosa-tree-tool glosa-star-toggle",
    type: "button",
    hidden: true,
    "aria-pressed": "false",
    "aria-label": "Star this workspace",
  });
  starToggle.innerHTML = STAR_SVG;
  const artifactList = el("ul", { className: "glosa-artifact-list" });
  const artifactHeading = el("div", { className: "glosa-sidebar-heading" }, [
    el("h2", { textContent: "Artifacts" }),
    starToggle,
  ]);
  const artifactListEmpty = el("p", {
    className: "glosa-sidebar-empty",
    textContent: "Markdown, HTML, and text files in this workspace appear here.",
    hidden: true,
  });
  // The writer's starred folders sit at the navigator's foot, collapsible, out of the tree's way:
  // the tree is what the navigator is for, and a list you come back to is not what you read.
  const starredToggle = el("button", {
    id: "glosa-starred-toggle",
    className: "glosa-sidebar-section-toggle",
    type: "button",
    "aria-expanded": "true",
    "aria-controls": "glosa-starred-list",
  });
  const starredCount = el("span", { className: "glosa-starred-count" });
  starredToggle.innerHTML =
    '<span class="glosa-sidebar-section-chevron" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg></span><span>Starred</span>';
  starredToggle.append(starredCount);
  const starredList = el("ul", { id: "glosa-starred-list", className: "glosa-starred-list" });
  const starredSection = el("section", { className: "glosa-sidebar-section glosa-starred", hidden: true }, [
    el("h2", {}, [starredToggle]),
    starredList,
  ]);
  // One banner for the whole workspace, above the dock — never one per pane (§11). The connection
  // either holds or it does not; saying so six times would not make it truer.
  const bannerEl = el("div", { className: "glosa-banner", hidden: true, role: "status", textContent: "Reconnecting…" });
  const dockHost = el("div", { className: "glosa-dock-host" });
  const mainEl = el("div", { className: "glosa-main" }, [dockHost]);
  const shortcutsEl = el("section", {
    id: "glosa-shortcuts",
    className: "glosa-shortcuts",
    hidden: true,
    "aria-labelledby": "glosa-shortcuts-toggle",
  });
  const sidebarEl = el(
    "nav",
    { id: "glosa-sidebar", className: "glosa-sidebar", "aria-label": "Workspace navigation" },
    [
      el("div", { className: "glosa-sidebar-scroll" }, [artifactHeading, artifactList, artifactListEmpty]),
      starredSection,
    ],
  );
  const agentFeedbackHost = el("div", { className: "glosa-agent-feedback" });
  const agentFeedback = mountAgentFeedback(agentFeedbackHost, { overlayHost: topbarOverlays });

  root.append(
    el("header", { className: "glosa-topbar" }, [
      el("div", { className: "glosa-topbar-lead" }, [brandMark]),
      el("div", { className: "glosa-topbar-title" }, [goToTrigger]),
      el("div", { className: "glosa-topbar-actions" }, [agentFeedbackHost, tools]),
      topbarOverlays,
    ]),
    bannerEl,
    sidebarEl,
    // The navigator's toggle lives in the desk's bottom-left corner, not in the top bar: on a footer
    // strip at the foot of the navigator while it is shown, and in the same spot once it is hidden,
    // so the control that brings it back never moves and never pushes the mark around.
    el("div", { className: "glosa-nav-foot" }, [navToggle]),
    mainEl,
    shortcutsEl,
  );
  if (surface === "document") {
    // A presented single document has no workspace to navigate: the navigator is not hidden
    // behind a toggle, it does not exist.
    navToggle.hidden = true;
    sidebarEl.hidden = true;
    root.setAttribute("data-nav-open", "false");
  }
  const artifactNavigator = createArtifactTreeNavigator(artifactList, { onOpen: onOpenArtifact });

  return {
    starIcon: STAR_SVG,
    elements: {
      navToggle,
      titleEl,
      goToTrigger,
      shortcutsToggle,
      topbarOverlays,
      appearanceHost,
      attentionHost,
      toolsTrigger,
      toolsMenu,
      tools,
      starToggle,
      starredToggle,
      starredCount,
      starredSection,
      starredList,
      artifactList,
      artifactListEmpty,
      shortcutsEl,
      bannerEl,
      dockHost,
      mainEl,
      sidebarEl,
    },
    attentionTray,
    agentFeedback,
    artifactNavigator,
    destroy() {
      stopAppearance?.();
      attentionTray.destroy();
      agentFeedback.destroy();
      artifactNavigator.destroy();
    },
  };
}

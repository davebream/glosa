// SPDX-License-Identifier: Apache-2.0
// Static viewer composition. The shell owns markup and child-component lifecycles; mountApp injects
// every behavior callback and dependency so this module has no daemon or application-state access.
//
// Since the multi-artifact workbench (design brief 2026-09-04 §6) the top bar is WORKSPACE chrome
// and nothing else. The artifact name, the mode control, History, Copy source and Print all live
// inside the pane that holds their artifact — one bar cannot honestly speak for two documents.
// What stays here is true of the whole workspace: the navigator toggle, the brand mark, the
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
    onWireWorkspace,
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
    '<svg viewBox="0 0 32 32" aria-hidden="true"><path class="glosa-logo-ink" fill-rule="evenodd" d="M14 4C8.48 4 4 8.48 4 14s4.48 10 10 10c2.1 0 4.05-.65 5.65-1.75v-5.1A5.76 5.76 0 0 1 14 19.75 5.75 5.75 0 1 1 19.65 13V5.75A9.93 9.93 0 0 0 14 4Z"/><path class="glosa-logo-accent" d="M19.5 4H24v18.35C24 27.3 20.9 30 15.5 30H11v-4h4.5c2.75 0 4-1.16 4-3.72V4Z"/></svg>';
  // The bar's title slot now names what the bar actually controls: the workspace.
  const workspaceNameEl = el("span", { className: "glosa-workspace-name", textContent: "glosa" });
  const conversationToggle = el("button", {
    id: "glosa-conversation-toggle",
    className: "glosa-conversation-toggle",
    type: "button",
    "aria-expanded": "false",
    "aria-controls": "glosa-conversation",
  });
  conversationToggle.setAttribute("aria-label", "Conversation");
  conversationToggle.innerHTML =
    '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 4.5h14v9H8l-4.5 3v-3H3v-9Z"/></svg><span>Conversation</span>';
  const topbarOverlays = el("div", { className: "glosa-topbar-overlays" });
  const appearanceHost = el("div", { className: "glosa-appearance" });
  const attentionHost = el("div", { className: "glosa-attention" });
  const attentionTray = mountAttentionTray(attentionHost, {
    dataAccess,
    overlayHost: topbarOverlays,
    onEntriesChange: onAttentionEntriesChange,
    onOpenArtifact,
    getCurrentArtifact,
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
    [attentionHost, conversationToggle, appearanceHost, shortcutsToggle],
  );
  const tools = el("div", { className: "glosa-tools", "data-open": "false" }, [toolsTrigger, toolsMenu]);

  const workspacesToggle = el("button", {
    id: "glosa-workspaces-toggle",
    className: "glosa-sidebar-section-toggle",
    type: "button",
    "aria-expanded": "true",
    "aria-controls": "glosa-workspace-list",
  });
  workspacesToggle.innerHTML =
    '<span class="glosa-sidebar-section-chevron" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg></span><span>Workspaces</span>';
  const sidebarList = el("ul", { id: "glosa-workspace-list", className: "glosa-workspace-list" });
  const workspacesSection = el("div", { className: "glosa-sidebar-section", hidden: true }, [
    el("h2", {}, [workspacesToggle]),
    sidebarList,
  ]);
  const artifactList = el("ul", { className: "glosa-artifact-list" });
  const artifactHeading = el("div", { className: "glosa-sidebar-heading" }, [el("h2", { textContent: "Artifacts" })]);
  const artifactListEmpty = el("p", {
    className: "glosa-sidebar-empty",
    textContent: "Markdown, HTML, and text files in this workspace appear here.",
    hidden: true,
  });
  // One banner for the whole workspace, above the dock — never one per pane (§11). The connection
  // either holds or it does not; saying so six times would not make it truer.
  const bannerEl = el("div", { className: "glosa-banner", hidden: true, role: "status", textContent: "Reconnecting…" });
  const dockHost = el("div", { className: "glosa-dock-host" });
  const mainEl = el("div", { className: "glosa-main" }, [dockHost]);
  const conversationEl = el("section", {
    id: "glosa-conversation",
    className: "glosa-conversation",
    hidden: true,
    "aria-labelledby": "glosa-conversation-toggle",
  });
  const shortcutsEl = el("section", {
    id: "glosa-shortcuts",
    className: "glosa-shortcuts",
    hidden: true,
    "aria-labelledby": "glosa-shortcuts-toggle",
  });
  const sidebarEl = el(
    "nav",
    { id: "glosa-sidebar", className: "glosa-sidebar", "aria-label": "Workspace navigation" },
    [workspacesSection, artifactHeading, artifactList, artifactListEmpty],
  );
  const agentFeedbackHost = el("div", { className: "glosa-agent-feedback" });
  const agentFeedback = mountAgentFeedback(agentFeedbackHost, { overlayHost: topbarOverlays, onWire: onWireWorkspace });

  root.append(
    el("header", { className: "glosa-topbar" }, [
      navToggle,
      brandMark,
      el("div", { className: "glosa-topbar-title" }, [workspaceNameEl]),
      el("div", { className: "glosa-topbar-actions" }, [agentFeedbackHost, tools]),
      topbarOverlays,
    ]),
    bannerEl,
    sidebarEl,
    mainEl,
    conversationEl,
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
    elements: {
      navToggle,
      workspaceNameEl,
      conversationToggle,
      shortcutsToggle,
      topbarOverlays,
      appearanceHost,
      attentionHost,
      toolsTrigger,
      toolsMenu,
      tools,
      workspacesToggle,
      workspacesSection,
      sidebarList,
      artifactList,
      artifactListEmpty,
      conversationEl,
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

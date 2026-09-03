// SPDX-License-Identifier: Apache-2.0
// Static viewer composition. The shell owns markup and child-component lifecycles; mountApp injects
// every behavior callback and dependency so this module has no daemon or application-state access.

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
  const artifactNameEl = el("span", { className: "glosa-artifact-name", textContent: "glosa" });
  const artifactDirEl = el("span", { className: "glosa-artifact-dir" });
  const modeBar = el("div", { className: "glosa-modebar", role: "group", "aria-label": "View mode" });
  const historyToggle = el("button", {
    id: "glosa-history-toggle",
    className: "glosa-history-toggle",
    type: "button",
    textContent: "History",
    "aria-expanded": "false",
    "aria-controls": "glosa-history",
  });
  const conversationToggle = el("button", {
    id: "glosa-conversation-toggle",
    className: "glosa-conversation-toggle",
    type: "button",
    textContent: "Conversation",
    "aria-expanded": "false",
    "aria-controls": "glosa-conversation",
  });
  historyToggle.setAttribute("aria-label", "History");
  historyToggle.innerHTML =
    '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 5.5V2.8M3.5 5.5h2.7M3.7 5.3A7 7 0 1 1 3 12M10 6.2V10l2.7 1.7"/></svg><span>History</span>';
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
  const copySourceButton = el("button", {
    className: "glosa-tools-copy-source",
    type: "button",
    "aria-label": "Copy source",
    hidden: true,
  });
  copySourceButton.innerHTML =
    '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="7.5" y="7.5" width="9" height="9" rx="1.5"/><path d="M4.5 12.5H4A1.5 1.5 0 0 1 2.5 11V4A1.5 1.5 0 0 1 4 2.5h7A1.5 1.5 0 0 1 12.5 4v.5"/></svg><span>Copy source</span>';
  const printArtifactButton = el("button", {
    className: "glosa-tools-print",
    type: "button",
    "aria-label": "Print / Save as PDF",
    hidden: true,
  });
  printArtifactButton.innerHTML =
    '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 7.5v-4h8v4M6 14.5H4.5A1.5 1.5 0 0 1 3 13V9a1.5 1.5 0 0 1 1.5-1.5h11A1.5 1.5 0 0 1 17 9v4a1.5 1.5 0 0 1-1.5 1.5H14"/><rect x="6" y="12" width="8" height="5" rx="1"/></svg><span>Print / Save as PDF</span>';
  const toolsStatus = el("p", { className: "glosa-tools-status", role: "status", "aria-live": "polite", hidden: true });
  const stopAppearance = appearance
    ? mountAppearanceControl(appearanceHost, appearance, { overlayHost: topbarOverlays, returnFocus: toolsTrigger })
    : null;
  const toolsMenu = el(
    "div",
    { id: "glosa-tools-menu", className: "glosa-tools-menu", role: "group", "aria-label": "Workspace tools" },
    [
      attentionHost,
      historyToggle,
      conversationToggle,
      copySourceButton,
      printArtifactButton,
      appearanceHost,
      shortcutsToggle,
      toolsStatus,
    ],
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
  const backdrop = el("div", { className: "glosa-backdrop" });
  const contentEl = el("div", { className: "glosa-content", role: "region", "aria-label": "Artifact preview" });
  const emptyEl = el("div", { className: "glosa-empty", hidden: true, role: "status", "aria-live": "polite" });
  const skeletonEl = el("div", { className: "glosa-skeleton", hidden: true, "aria-hidden": "true" });
  for (let i = 0; i < 8; i++) skeletonEl.append(el("i"));
  const editArea = el("textarea", { className: "glosa-edit-area", hidden: true, "aria-label": "Artifact source" });
  const saveButton = el("button", { className: "glosa-save", type: "button", textContent: "Save" });
  const editStatus = el("p", { className: "glosa-edit-status", role: "status", "aria-live": "polite" });
  const richEl = el("div", { className: "glosa-rich", hidden: true });
  const faceRichBtn = el("button", { className: "glosa-face-rich", type: "button", textContent: "Rich" });
  const faceSourceBtn = el("button", { className: "glosa-face-source", type: "button", textContent: "Source" });
  const faceToggle = el("div", { className: "glosa-editor-face", role: "group", "aria-label": "Editor mode" }, [
    faceRichBtn,
    faceSourceBtn,
  ]);
  const editWrap = el("div", { className: "glosa-edit-wrap", hidden: true }, [
    el("div", { className: "glosa-edit-topbar" }, [faceToggle]),
    richEl,
    editArea,
    el("div", { className: "glosa-edit-actions" }, [editStatus, saveButton]),
  ]);
  const classFEl = el("div", {
    className: "glosa-classf",
    hidden: true,
    role: "region",
    "aria-label": "Artifact preview",
  });
  const historyEl = el("section", {
    id: "glosa-history",
    className: "glosa-history",
    hidden: true,
    "aria-labelledby": "glosa-history-toggle",
  });
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
  const marginEl = el("aside", { className: "glosa-margin", "aria-label": "Annotations" });
  const markersEl = el("div", { className: "glosa-markers", "aria-hidden": "true" });
  const bannerEl = el("div", { className: "glosa-banner", hidden: true, role: "status", textContent: "Reconnecting…" });
  const approvalStrip = el("section", {
    className: "glosa-approval-strip",
    hidden: true,
    "aria-label": "Final approval",
  });
  const annotateInstructions = el("p", {
    id: "glosa-annotate-instructions",
    className: "glosa-visually-hidden",
    textContent: "Use Up and Down arrow keys to move between passages. Press Enter or Space to annotate.",
    hidden: true,
  });
  const mainEl = el("main", { className: "glosa-main" }, [
    bannerEl,
    approvalStrip,
    annotateInstructions,
    emptyEl,
    skeletonEl,
    contentEl,
    classFEl,
    editWrap,
    marginEl,
    markersEl,
  ]);
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
      el("div", { className: "glosa-topbar-title" }, [artifactNameEl, artifactDirEl]),
      modeBar,
      el("div", { className: "glosa-topbar-actions" }, [agentFeedbackHost, tools]),
      topbarOverlays,
    ]),
    sidebarEl,
    backdrop,
    mainEl,
    historyEl,
    conversationEl,
    shortcutsEl,
  );
  if (surface === "document") {
    navToggle.hidden = true;
    sidebarEl.hidden = true;
    backdrop.hidden = true;
    root.setAttribute("data-nav-open", "false");
  }
  const artifactNavigator = createArtifactTreeNavigator(artifactList, { onOpen: onOpenArtifact });

  return {
    elements: {
      navToggle,
      artifactNameEl,
      artifactDirEl,
      modeBar,
      historyToggle,
      conversationToggle,
      shortcutsToggle,
      topbarOverlays,
      appearanceHost,
      attentionHost,
      toolsTrigger,
      toolsMenu,
      tools,
      copySourceButton,
      printArtifactButton,
      toolsStatus,
      workspacesToggle,
      workspacesSection,
      sidebarList,
      artifactList,
      artifactListEmpty,
      backdrop,
      contentEl,
      emptyEl,
      skeletonEl,
      editArea,
      saveButton,
      editStatus,
      richEl,
      faceRichBtn,
      faceSourceBtn,
      editWrap,
      classFEl,
      historyEl,
      conversationEl,
      shortcutsEl,
      marginEl,
      markersEl,
      bannerEl,
      approvalStrip,
      annotateInstructions,
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

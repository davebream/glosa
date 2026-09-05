// SPDX-License-Identifier: Apache-2.0
// @glosa/spa — the workspace surface (R6). Since the multi-artifact workbench (design brief
// docs/design/2026-09-04-multi-artifact-workbench-brief.md) this module owns everything that is
// true of a WORKSPACE — the navigator, the workspace switcher, the SSE stream, the attention
// tray, agent feedback, Conversation, Appearance, the keyboard sheet, and the connection banner —
// and hands every artifact to a pane of its own (artifact-pane.js) inside the dock (dock.js).
//
// Talks to the daemon ONLY through data-access.js (R6's ONE data-access module) — never `fetch`
// directly (see test/import-boundary.test.ts, which checks this structurally across this file
// and annotate.js).
//
// Visual system: app.css. Topology: top bar (workspace chrome) / connection banner / navigator /
// dock. Each dock pane carries its own artifact bar, manuscript, contextual margin, and history.

import { mountAgentFeedback } from "./agent-feedback.js";
import { mountAppearanceControl } from "./appearance.js";
import { selectRequestToReveal } from "./agent-request.js";
import { createArtifactPane, MODES } from "./artifact-pane.js";
import { createArtifactTreeNavigator } from "./artifact-tree.js";
import { mountAttentionTray } from "./attention-tray.js";
import { createDataAccess } from "./data-access.js";
import { createDiffPane } from "./diff-pane.js";
import { createDock, describeVersion, diffPanelId, disambiguateLabels, MIN_PANE_WIDTH } from "./dock.js";
import { confirmDialog, noticeDialog } from "./dialog.js";
import { createContextSurfaceController } from "./viewer-context-surfaces.js";
import { createViewerFeedbackController } from "./viewer-feedback.js";
import { createNavigatorController } from "./viewer-navigator.js";
import { createViewerShell, createElement as el } from "./viewer-shell.js";

/** How long the workbench waits for a gap in typing before an agent-caused switch. */
const REVEAL_TYPING_IDLE_MS = 900;
/** ...and how long it will wait at most, so steady typing cannot suppress a question forever. */
const REVEAL_MAX_WAIT_MS = 15_000;

let historyPaneLoader;
let conversationPaneLoader;
let richEditorLoader;

function loadHistoryPane() {
  historyPaneLoader ??= import("./history.js").then((module) => module.mountHistoryPane);
  return historyPaneLoader;
}

function loadConversationPane() {
  conversationPaneLoader ??= import("./conversation.js").then((module) => module.mountConversationPane);
  return conversationPaneLoader;
}

function loadRichEditor() {
  richEditorLoader ??= import("./rich-editor.js").then((module) => module.mountRichEditor);
  return richEditorLoader;
}

// Re-exported so importers (and tests) keep one name for the mode vocabulary even though the
// state machine itself now lives per pane.
export { MODES, INTENTS, initialModeState, isParked, modeReducer, morphArtifactContent } from "./artifact-pane.js";

/**
 * Mounts the whole ready-state app (top bar + navigator + dock) into `root`. `dataAccess`
 * defaults to a real `createDataAccess()` — a test passes a fake one so nothing here ever needs a
 * real daemon. Returns an `unmount()` that tears down the SSE subscription and every open pane.
 *
 * @param {any} root
 * @param {{
 *   dataAccess?: any,
 *   initialSlug?: string,
 *   initialArtifact?: string,
 *   surface?: string,
 *   initialMode?: string,
 *   readLock?: boolean,
 *   appearance?: any,
 *   onFocusChange?: (focus: any) => void,
 *   layoutStorage?: any,
 * }} [options]
 */
export function mountApp(
  root,
  {
    dataAccess = createDataAccess(),
    initialSlug,
    initialArtifact,
    surface = "workspace",
    initialMode = "read",
    readLock = false,
    appearance,
    onFocusChange,
    layoutStorage,
  } = {},
) {
  root.textContent = "";
  root.classList.add("glosa-app");
  root.setAttribute("data-surface", surface === "document" ? "document" : "workspace");
  if (readLock) root.setAttribute("data-preview-lock", "true");
  let attentionEntries = [];
  /** Request ids already seen, so an arrival is distinguishable from a refresh. */
  const seenRequestIds = new Set();
  let seenAnyInbox = false;
  let lastKeystrokeAt = 0;
  // NOT pre-seeded from initialSlug: selection is an act (selectWorkspace), not a default —
  // pre-seeding made refreshWorkspaces' "already selected" guard skip the deep-link entirely.
  let currentSlug = null;
  let stopStream = null;
  let dock = null;
  let knownArtifacts = new Map(); // path → summary, for restore validation and tab state
  /** @type {Map<string, any>} */
  const panes = new Map(); // panel id → pane handle
  let activePanelId = null;
  let requestedMode = MODES.includes(initialMode) ? initialMode : "read";

  // A single presented document is one document: no tab strip, no dock (brief §4).
  const singlePane = surface === "document";

  const shell = createViewerShell(root, {
    dataAccess,
    surface,
    appearance,
    mountAppearanceControl,
    mountAttentionTray,
    mountAgentFeedback,
    createArtifactTreeNavigator,
    onAttentionEntriesChange: setAttentionEntries,
    onOpenArtifact: (path) => void openArtifact(path),
    getCurrentArtifact: () => activePane()?.path ?? null,
    onWireWorkspace: wireWorkspace,
  });
  const { attentionTray, agentFeedback, artifactNavigator } = shell;
  const {
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
    sidebarEl,
  } = shell.elements;

  const toolControls = () =>
    [
      attentionHost.querySelector(".glosa-attention-trigger"),
      conversationToggle,
      appearanceHost.querySelector(".glosa-appearance-trigger"),
      shortcutsToggle,
    ].filter((control) => control && !control.disabled && !control.hidden);

  function setToolsOpen(open, { restoreFocus = false } = {}) {
    tools.setAttribute("data-open", String(open));
    toolsTrigger.setAttribute("aria-expanded", String(open));
    if (open) {
      queueMicrotask(() => toolControls()[0]?.focus({ preventScroll: true }));
    } else if (restoreFocus) {
      queueMicrotask(() => toolsTrigger.focus({ preventScroll: true }));
    }
  }

  toolsTrigger.addEventListener("click", () => {
    setToolsOpen(tools.getAttribute("data-open") !== "true", { restoreFocus: true });
  });
  toolsMenu.addEventListener("click", (event) => {
    if (
      event.target instanceof Element &&
      event.target.closest(".glosa-conversation-toggle, .glosa-shortcuts-toggle")
    ) {
      setToolsOpen(false, { restoreFocus: true });
    }
  });
  toolsMenu.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setToolsOpen(false, { restoreFocus: true });
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const controls = toolControls();
    if (controls.length === 0) return;
    event.preventDefault();
    const current = Math.max(0, controls.indexOf(document.activeElement));
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? controls.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + controls.length) % controls.length;
    controls[next].focus();
  });

  const onDocumentClick = (event) => {
    if (tools.getAttribute("data-open") !== "true") return;
    if (event.target instanceof Node && (tools.contains(event.target) || topbarOverlays.contains(event.target))) return;
    setToolsOpen(false);
  };
  document.addEventListener("click", onDocumentClick);

  // Capture phase, so a keystroke inside an editor or a composer counts even though those
  // handlers stop propagation. Records a timestamp and nothing else — never the key.
  const onDocumentKeydown = () => {
    lastKeystrokeAt = Date.now();
  };
  document.addEventListener("keydown", onDocumentKeydown, true);

  /** One polite live region for changes the reader did not initiate. */
  const announcerEl = el("p", {
    className: "glosa-visually-hidden",
    role: "status",
    "aria-live": "polite",
  });
  root.append(announcerEl);

  function announce(text) {
    // Cleared first: an identical message twice in a row is otherwise silent, and "another
    // question arrived" is exactly the message that repeats.
    announcerEl.textContent = "";
    queueMicrotask(() => {
      announcerEl.textContent = text;
    });
  }

  function setAttentionEntries(entries) {
    const next = Array.isArray(entries) ? entries : [];
    const arrival = selectRequestToReveal(seenRequestIds, next, { firstLoad: !seenAnyInbox });
    seenAnyInbox = true;
    for (const entry of next) seenRequestIds.add(entry.id);
    attentionEntries = next;
    for (const pane of panes.values()) {
      pane.refreshApproval?.();
      // The rail carries the session's asks now, so a changed inbox has to repaint it too.
      pane.refreshAgentRequests?.();
    }
    if (arrival) revealWhenIdle(arrival);
  }

  /**
   * Brings a newly-arrived question to the reader.
   *
   * This is the one place glosa moves someone who did not ask to be moved, so it is bounded on
   * both sides. Nothing is ever lost: the pane parks an unsaved draft and a half-written note
   * before the mode changes, and one control puts the reader back. And it waits for a gap in
   * typing — a switch that lands mid-sentence is hostile even when it costs nothing, and people
   * pause constantly, so the wait is short in practice. The cap exists for the case where they do
   * not: a question that never arrives because someone is typing steadily is a worse failure than
   * a slightly rude interruption.
   */
  function revealWhenIdle(request) {
    const path = request.target_path ?? request.target;
    if (!path) return;
    const deadline = Date.now() + REVEAL_MAX_WAIT_MS;
    const attempt = () => {
      const typingRecently = Date.now() - lastKeystrokeAt < REVEAL_TYPING_IDLE_MS;
      if (typingRecently && Date.now() < deadline) {
        setTimeout(attempt, REVEAL_TYPING_IDLE_MS);
        return;
      }
      void openArtifact(path, { mode: "review" }).then((opened) => {
        if (!opened) return;
        panes.get(path)?.revealRequest?.(request.id);
        // Said out loud, because the view moved on its own. Screen readers get it from the live
        // region; everyone else gets the mode control and the sideline they are now looking at.
        announce(
          `A session is asking about ${path.split("/").pop()}. Switched to Review; your unsaved work is kept.`,
        );
      });
    };
    attempt();
  }

  // Not `navigator` — that name is the browser's own global, which a pane's copy-source reads.
  const sidebarNav = createNavigatorController({
    root,
    elements: { navToggle, sidebarEl, sidebarList, artifactList, workspacesToggle, workspacesSection },
    enabled: surface !== "document",
  });

  function activePane() {
    return activePanelId ? (panes.get(activePanelId) ?? null) : null;
  }

  /** With several artifacts open, the reader has to be able to tell at a glance which pane the
   * mode control, the shortcuts, and the address bar are all talking about. The active tab's
   * olive edge says it in the strip; this says it in the pane, by letting the others go quiet. */
  function markActivePane() {
    for (const [id, pane] of panes) {
      pane.element?.setAttribute("data-active", String(id === activePanelId));
    }
  }

  function isArtifactPanel(id) {
    return !id.startsWith("diff:");
  }

  // ---------- tab state (§5: reuse the navigator tree's vocabulary, never a second one) ----------

  /** Ids the DOCK currently holds, which is not always the same as the panes we have built: a
   * layout operation can remove a panel underneath us. Everything the reader is told about what
   * is open reads from here, so a stranded pane can never put a marker on the navigator or a
   * label on a tab strip for something that is not on screen. */
  function openPanelIds() {
    return dock ? dock.api.panels.map((panel) => panel.id) : [...panes.keys()];
  }

  function tabLabels() {
    return disambiguateLabels(openPanelIds().filter(isArtifactPanel));
  }

  function tabStateFor(id) {
    const pane = panes.get(id);
    if (!pane) return { label: id, tooltip: id };
    if (!isArtifactPanel(id)) {
      const [, path, from, to] = splitDiffId(id);
      const filename = path.split("/").pop();
      return {
        kind: "diff",
        label: `${filename} · ${describeVersion(from)}…${describeVersion(to)}`,
        tooltip: `${path} — comparing ${describeVersion(from)} with ${describeVersion(to)}`,
      };
    }
    const summary = knownArtifacts.get(id);
    return {
      kind: "artifact",
      label: tabLabels().get(id) ?? id.split("/").pop(),
      tooltip: id,
      artifactClass: pane.artifactClass() ?? summary?.class ?? "R",
      stale: pane.isStale() || Boolean(summary?.stale),
      unresolved: pane.annotationCount(),
      dirty: pane.isDirty(),
      missing: pane.isMissing(),
    };
  }

  function splitDiffId(id) {
    // `diff:<path>:<from>:<to>` — a path can contain colons, so split from the right.
    const body = id.slice("diff:".length);
    const lastColon = body.lastIndexOf(":");
    const prevColon = body.lastIndexOf(":", lastColon - 1);
    return ["diff", body.slice(0, prevColon), body.slice(prevColon + 1, lastColon), body.slice(lastColon + 1)];
  }

  function refreshTabs() {
    dock?.refreshTabs();
    // A tab's label can change because a SIBLING opened or closed, and the artifact bar shows
    // whatever the label leaves out — so the bars follow the strip.
    for (const pane of panes.values()) pane.refreshTitle?.();
  }

  // ---------- panes ----------

  function paneEmptyState() {
    const wrap = el("div", { className: "glosa-empty" });
    if (knownArtifacts.size === 0) {
      wrap.append(
        el("p", { className: "glosa-empty-title", textContent: "No artifacts yet." }),
        el("p", { className: "glosa-empty-hint", textContent: "Add a document to begin." }),
      );
      return wrap;
    }
    wrap.append(
      el("p", { className: "glosa-empty-title", textContent: "Choose an artifact to review." }),
      el("p", {
        className: "glosa-empty-hint",
        textContent:
          "Its rendered manuscript opens here — switch to Annotate and select any passage to comment on it. Drag a tab to a pane edge to read two artifacts side by side.",
      }),
    );
    return wrap;
  }

  function createPane(id, params, host, panelApi) {
    if (!isArtifactPanel(id)) {
      const [, path, from, to] = splitDiffId(id);
      const pane = createDiffPane(host, { dataAccess, slug: currentSlug, path, from, to, describeVersion });
      panes.set(id, pane);
      return pane;
    }
    const pane = createArtifactPane(host, {
      dataAccess,
      slug: currentSlug,
      path: id,
      initialMode: params.mode ?? requestedMode,
      readLock,
      loadHistoryPane,
      loadRichEditor,
      getAttentionEntries: () => attentionEntries,
      refreshAttention: () => attentionTray.refresh(),
      getProviderName: () => feedbackController.providerName() ?? "An agent session",
      maybeOfferWiring,
      openArtifactInThisPane: (nextPath) => replacePanel(id, nextPath),
      // A presented single document has no tab strip, so its pane carries the whole identity.
      getTabLabel: () => (singlePane ? null : (tabLabels().get(id) ?? id.split("/").pop())),
      openDiffTab: openDiff,
      claimWidth: (target) => dock?.claimWidth(id, target),
      releaseWidth: () => dock?.releaseWidth(id),
      paneCommands: singlePane ? [] : (dock?.moveCommands() ?? []),
      onStateChange: () => {
        refreshTabs();
        if (id === activePanelId) reflectFocus();
      },
    });
    panes.set(id, pane);
    pane.element.setAttribute("data-active", String(id === activePanelId));
    void pane.ready.then(() => {
      refreshTabs();
      panelApi?.setTitle?.(tabStateFor(id).label ?? id);
      if (id === activePanelId) reflectFocus();
    });
    return pane;
  }

  function destroyPane(id, pane) {
    pane?.destroy?.();
    panes.delete(id);
    if (activePanelId === id) activePanelId = null;
    markNavigatorOpenSet();
  }

  /** Class-F Edit follows the derived-from edge: the SOURCE artifact opens where the reader was
   * already looking. Panel ids are paths, so that is a close-and-open of this one pane rather
   * than a mutation — and it goes through openArtifact so the global no-duplicates rule holds. */
  async function replacePanel(id, nextPath) {
    const panel = dock?.api.getPanel(id);
    const group = panel?.api.group;
    panel?.api.close();
    await openArtifact(nextPath, { mode: "edit", group });
    return true;
  }

  // ---------- opening ----------

  /**
   * §5: a tab's identity is its artifact path, and dockview enforces panel-id uniqueness, so
   * "one tab per file, no duplicates" needs no bookkeeping of its own. Opening a file that is
   * already visible focuses the pane that holds it; it never copies the file into another one.
   */
  async function openArtifact(path, { mode, group } = {}) {
    if (!path || !currentSlug) return false;
    if (mode) requestedMode = mode;
    const existing = dock?.api.getPanel(path);
    if (existing) {
      existing.api.setActive();
      const pane = panes.get(path);
      if (mode && pane) pane.setMode(mode);
      return true;
    }
    if (!dock) return false;
    if (singlePane) {
      for (const openId of [...panes.keys()]) dock.api.getPanel(openId)?.api.close();
    }
    dock.api.addPanel({
      id: path,
      component: "pane",
      tabComponent: "pane",
      title: path.split("/").pop(),
      params: { kind: "artifact", path, mode: mode ?? requestedMode },
      renderer: "always",
      minimumWidth: singlePane ? undefined : MIN_PANE_WIDTH,
      ...(group ? { position: { referenceGroup: group } } : {}),
    });
    markActivePane();
    markNavigatorOpenSet();
    return true;
  }

  function openDiff({ path, from, to }) {
    if (!dock || singlePane) return;
    const id = diffPanelId(path, from, to);
    const existing = dock.api.getPanel(id);
    if (existing) {
      existing.api.setActive();
      return;
    }
    dock.api.addPanel({
      id,
      component: "pane",
      tabComponent: "pane",
      title: path.split("/").pop(),
      params: { kind: "diff", path, from, to },
      renderer: "always",
      minimumWidth: MIN_PANE_WIDTH,
    });
  }

  /** The navigator marks every OPEN artifact quietly and the active pane's artifact as current,
   * so the tree says what is already on screen instead of only where you last clicked. */
  function markNavigatorOpenSet() {
    artifactNavigator.setOpenPaths?.(openPanelIds().filter(isArtifactPanel));
    artifactNavigator.setCurrent(activePanelId && isArtifactPanel(activePanelId) ? activePanelId : null, {
      reveal: false,
    });
  }

  function reflectFocus() {
    const pane = activePane();
    // §10: the URL keeps describing ONE focused artifact — the active pane — which preserves the
    // `glosa open <file>` deep-link contract and keeps a shared URL short and legible. The
    // arrangement itself is never serialized into the address bar.
    onFocusChange?.({
      slug: currentSlug,
      artifact: pane && isArtifactPanel(pane.path) ? pane.path : null,
      mode: pane?.getMode?.() ?? requestedMode,
    });
    document.title = documentTitle();
  }

  function documentTitle() {
    const pane = activePane();
    if (!pane) return currentSlug ?? "glosa";
    const name = pane.path.split("/").pop();
    return surface === "document" || !currentSlug ? name : `${currentSlug} — ${name}`;
  }

  // ---------- keyboard (§9) ----------

  function onShortcut(e) {
    const meta = e.metaKey || e.ctrlKey;
    // Tab cycling inside the active pane's group. Ctrl-based so it survives a focused textarea.
    if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === "Tab") {
      e.preventDefault();
      if (e.shiftKey) dock?.activatePreviousTab();
      else dock?.activateNextTab();
      return;
    }
    if (!meta) return;
    if (e.altKey && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
      e.preventDefault();
      dock?.focusAdjacentGroup(e.key === "ArrowRight" ? "right" : "left");
      return;
    }
    if (!e.altKey && e.key === "\\") {
      // Moves rather than copies: splitting must never produce the same file twice (§5).
      e.preventDefault();
      dock?.moveActivePanel("new");
      return;
    }
    if (!e.altKey && (e.key === "w" || e.key === "W")) {
      if (!activePanelId) return;
      e.preventDefault();
      void dock?.requestClose(activePanelId);
      return;
    }
    const idx = ["1", "2", "3"].indexOf(e.key);
    if (idx === -1) return;
    e.preventDefault();
    if (readLock && idx !== 0) return; // preview lock: only ⌘1 (Preview) remains meaningful
    activePane()?.setMode?.(MODES[idx]);
  }
  document.addEventListener("keydown", onShortcut);

  const contextSurfaces = createContextSurfaceController({
    dataAccess,
    elements: { conversationEl, shortcutsEl, conversationToggle, shortcutsToggle },
    getState: () => ({ slug: currentSlug, mode: activePane()?.getMode?.() ?? "read" }),
    loadConversationPane,
    createElement: el,
    returnFocus: () => toolsTrigger.focus({ preventScroll: true }),
  });
  const { renderConversation } = contextSurfaces;

  function markCurrent(listEl, key) {
    for (const btn of listEl.querySelectorAll("button")) {
      btn.setAttribute("aria-current", String(btn.getAttribute("data-key") === key));
    }
  }

  // ---------- workspace data ----------

  async function refreshArtifactList() {
    const artifacts = await dataAccess.getArtifacts(currentSlug);
    knownArtifacts = new Map(artifacts.map((artifact) => [artifact.path, artifact]));
    artifactListEmpty.hidden = artifacts.length > 0;
    artifactNavigator.setArtifacts(artifacts);
    markNavigatorOpenSet();
    refreshTabs();
    return artifacts;
  }

  /** §11: a tab whose artifact was deleted dims and says the file is gone. glosa never closes a
   * tab the reader opened — that silently destroys the layout they built. */
  async function refreshArtifactIndex() {
    await refreshArtifactList();
    for (const [id, pane] of panes) {
      if (!isArtifactPanel(id)) continue;
      if (!knownArtifacts.has(id)) pane.markMissing();
    }
    refreshTabs();
  }

  function refreshOpenArtifact(path) {
    const pane = panes.get(path);
    if (pane) void pane.refreshArtifact();
    for (const [id, diffPane] of panes) {
      if (!isArtifactPanel(id) && splitDiffId(id)[1] === path) void diffPane.refreshArtifact();
    }
  }

  const feedbackController = createViewerFeedbackController({
    dataAccess,
    view: agentFeedback,
    getWorkspaceSlug: () => currentSlug,
    confirmDialog,
    noticeDialog,
  });

  function refreshAgentFeedback() {
    return feedbackController.refresh();
  }

  function wireWorkspace() {
    return feedbackController.wireWorkspace();
  }

  function maybeOfferWiring() {
    return feedbackController.maybeOfferWiring();
  }

  function startStream() {
    stopStream?.();
    stopStream = dataAccess.openStream(currentSlug, {
      onStatus: (status) => {
        bannerEl.hidden = status !== "down";
      },
      onReconnect: () => {
        void refreshArtifactList();
        for (const pane of panes.values()) void pane.refreshArtifact();
        void attentionTray.refresh();
        void refreshAgentFeedback();
      },
      onEvent: (frame) => {
        if (frame.event === "artifact" && frame.data?.path) refreshOpenArtifact(frame.data.path);
        if (frame.event === "artifact_index") void refreshArtifactIndex();
        if (frame.event === "journal") {
          for (const pane of panes.values()) {
            if (pane.applyJournalEvent(frame.data)) break;
          }
        }
        if (frame.event === "journal" || frame.event === "metadata") void attentionTray.refresh();
        if (frame.event === "metadata") {
          void refreshArtifactList();
          for (const pane of panes.values()) void pane.refreshArtifact();
        }
        // Any existing workspace-stream activity may coincide with a bind/heartbeat. No new SSE
        // event is needed: refresh the aggregate through the same bounded status read.
        void refreshAgentFeedback();
      },
    });
  }

  function mountDock() {
    dock?.destroy();
    for (const pane of panes.values()) pane.destroy?.();
    panes.clear();
    activePanelId = null;
    dockHost.textContent = "";
    dock = createDock(dockHost, {
      slug: currentSlug,
      appearance,
      storage: layoutStorage,
      createPane,
      destroyPane,
      getTabState: tabStateFor,
      emptyState: paneEmptyState,
      confirmClosePanel: (id) => panes.get(id)?.confirmClose?.() ?? Promise.resolve(true),
      onActivePanelChange: (id) => {
        activePanelId = id;
        markActivePane();
        markNavigatorOpenSet();
        reflectFocus();
        panes.get(id)?.remeasure?.();
      },
      onLayoutChange: () => {
        for (const pane of panes.values()) {
          pane.remeasure?.();
          pane.refreshTitle?.();
        }
        markNavigatorOpenSet();
      },
    });
  }

  async function selectWorkspace(slug) {
    currentSlug = slug;
    workspaceNameEl.textContent = slug ?? "glosa";
    attentionTray.setWorkspace(slug);
    artifactNavigator.setWorkspace(slug);
    markCurrent(sidebarList, slug);
    feedbackController.selectWorkspace();
    await refreshArtifactList();
    mountDock();
    startStream();
    void renderConversation(); // the open pane, if any, should follow the newly selected workspace

    // §10: the arrangement is restored per workspace, defensively. A panel whose artifact no
    // longer exists is dropped; if restore throws for ANY reason the workspace still opens with
    // one pane. A corrupt saved layout must never make a workspace unopenable.
    const restored =
      !singlePane &&
      dock.restoreLayout((id) =>
        id.startsWith("diff:") ? knownArtifacts.has(splitDiffId(id)[1]) : knownArtifacts.has(id),
      );

    // CLI deep-link (`glosa open <file>`): the first workspace selection focuses the named
    // artifact, once — after that, navigation is the user's.
    if (initialArtifact) {
      const focus = initialArtifact;
      initialArtifact = undefined;
      await openArtifact(focus, { mode: requestedMode });
    } else if (!restored) {
      reflectFocus();
    } else {
      markNavigatorOpenSet();
      reflectFocus();
    }
  }

  function showWorkspaceError(error) {
    dockHost.textContent = "";
    dockHost.append(
      el("div", { className: "glosa-empty" }, [
        el("p", { className: "glosa-empty-title", textContent: "This workspace couldn't be opened." }),
        el("p", {
          className: "glosa-empty-hint",
          textContent: error instanceof Error ? error.message : "Try again, or reopen the workspace from the terminal.",
        }),
      ]),
    );
  }

  async function refreshWorkspaces() {
    const workspaces = await dataAccess.getWorkspaces();
    sidebarList.textContent = "";
    for (const w of workspaces) {
      sidebarList.append(
        el("li", {}, [
          el("button", {
            type: "button",
            textContent: w.slug,
            "data-key": w.slug,
            onClick: () => void selectWorkspace(w.slug).catch(showWorkspaceError),
          }),
        ]),
      );
    }
    // A lone workspace auto-selects below, so the switcher only earns its space once a SECOND
    // workspace is live (the machine-wide singleton daemon can serve several at once).
    sidebarNav.setWorkspacesAvailable(workspaces.length > 1);
    if (workspaces.length === 0) {
      dockHost.textContent = "";
      dockHost.append(
        el("div", { className: "glosa-empty" }, [
          el("p", { className: "glosa-empty-title", textContent: "No workspaces yet." }),
          el("p", { className: "glosa-empty-hint" }, [
            "In a terminal, run ",
            el("code", { textContent: "glosa open <directory>" }),
            " to start reviewing its artifacts here.",
          ]),
        ]),
      );
      return;
    }
    if (currentSlug) {
      markCurrent(sidebarList, currentSlug);
      return;
    }
    if (initialSlug) {
      await selectWorkspace(initialSlug);
    } else if (workspaces.length === 1) {
      await selectWorkspace(workspaces[0].slug);
    }
  }

  void refreshWorkspaces().catch(showWorkspaceError);

  return () => {
    document.removeEventListener("keydown", onShortcut);
    document.removeEventListener("click", onDocumentClick);
    document.removeEventListener("keydown", onDocumentKeydown, true);
    sidebarNav.destroy();
    feedbackController.destroy();
    stopStream?.();
    for (const pane of panes.values()) pane.destroy?.();
    panes.clear();
    dock?.destroy();
    contextSurfaces.destroy();
    shell.destroy();
  };
}

// SPDX-License-Identifier: Apache-2.0
// @glosa/spa — the workspace surface (R6). Since the multi-artifact workbench (design brief
// docs/design/2026-09-04-multi-artifact-workbench-brief.md) this module owns everything that is
// true of a WORKSPACE — the navigator and its Starred folders, the SSE stream, the attention
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
import { isQuestion, selectArrivals } from "./agent-request.js";
import { mountAppearanceControl } from "./appearance.js";
import { createArtifactPane, MODES } from "./artifact-pane.js";
import { createArtifactTreeNavigator } from "./artifact-tree.js";
import { mountAttentionTray } from "./attention-tray.js";
import { createDataAccess } from "./data-access.js";
import { confirmDialog, noticeDialog } from "./dialog.js";
import { createDictationController } from "./dictation.js";
import { createDiffPane } from "./diff-pane.js";
import { createDock, describeVersion, diffPanelId, disambiguateLabels, MIN_PANE_WIDTH } from "./dock.js";
import { createFaceStore } from "./face.js";
import { createCommandPalette } from "./palette.js";
import { createContextSurfaceController } from "./viewer-context-surfaces.js";
import { createViewerFeedbackController } from "./viewer-feedback.js";
import { createNavigatorController } from "./viewer-navigator.js";
import { createViewerShell, createElement as el } from "./viewer-shell.js";

/** The workspace this browser last had selected, so a reload with several live lands back on it. */
export const LAST_WORKSPACE_STORAGE_KEY = "glosa_last_workspace";

function defaultStorage() {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function readStored(storage, key) {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStored(storage, key, value) {
  try {
    storage?.setItem(key, value);
  } catch {
    // Remembering is a convenience; the selection itself already happened.
  }
}

/** Where a workspace's folder sits, short enough to tell two of the same name apart: the last two
 * folders above it. */
function parentFolder(path) {
  if (typeof path !== "string" || !path.includes("/")) return undefined;
  const parts = path.replace(/\/+$/, "").split("/").slice(0, -1).filter(Boolean);
  if (parts.length === 0) return "/";
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : `/${parts.join("/")}`;
}

/** A folder's own name, which is what the writer calls a workspace. */
function folderName(path, fallback) {
  const trimmed = typeof path === "string" ? path.replace(/\/+$/, "") : "";
  const name = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return name || fallback;
}

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
export { INTENTS, initialModeState, isParked, MODES, modeReducer, morphArtifactContent } from "./artifact-pane.js";

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
 *   faceStore?: any,
 *   dictationController?: any,
 * }} [options]
 */
export function mountApp(
  root,
  {
    dataAccess = createDataAccess(),
    initialSlug,
    initialArtifact,
    surface = "workspace",
    initialMode = "review",
    readLock = false,
    appearance,
    onFocusChange,
    layoutStorage,
    // The writer's per-artifact face (face.js). One store for every pane; a test passes its own.
    faceStore = createFaceStore({ storage: layoutStorage ?? undefined }),
    dictationController: injectedDictationController,
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
  /** Whether this app is still mounted. Going to a question in an artifact that was not open is
   * async and reaches back into the dock, so it must not outlive the dock. */
  let unmounted = false;
  // NOT pre-seeded from initialSlug: selection is an act (selectWorkspace), not a default —
  // pre-seeding made refreshWorkspaces' "already selected" guard skip the deep-link entirely.
  let currentSlug = null;
  let stopStream = null;
  let dock = null;
  let knownArtifacts = new Map(); // path → summary, for restore validation and tab state
  /** @type {Map<string, any>} */
  const panes = new Map(); // panel id → pane handle
  let activePanelId = null;
  let requestedMode = MODES.includes(initialMode) ? initialMode : "review";

  // A single presented document is one document: no tab strip, no dock (brief §4).
  const singlePane = surface === "document";
  const dictationController = injectedDictationController ?? createDictationController({ dataAccess });
  const ownsDictationController = !injectedDictationController;

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
    dictationController,
  });
  const { attentionTray, agentFeedback, artifactNavigator } = shell;
  const {
    navToggle,
    titleEl,
    goToTrigger,
    conversationToggle,
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
    const arrivals = selectArrivals(seenRequestIds, next, { firstLoad: !seenAnyInbox });
    seenAnyInbox = true;
    for (const entry of next) seenRequestIds.add(entry.id);
    attentionEntries = next;
    const arrived = arrivals.map((entry) => entry.id);
    for (const pane of panes.values()) {
      pane.refreshApproval?.();
      // The rail carries the session's asks now, so a changed inbox has to repaint it too — and a
      // mark that is new draws itself in once.
      pane.refreshAgentRequests?.({ arrived });
    }
    const question = arrivals.find(isQuestion);
    if (question) announceQuestion(question);
  }

  /**
   * Tells the reader a question arrived. It does NOT take them to it.
   *
   * This used to switch the pane to Review and scroll to the passage once typing paused. #308
   * removed that: moving someone who is reading or writing is its own failure, however carefully it
   * is timed, and when the timing logic declined to move them they were left with nothing at all.
   * Now every pane derives a "Go to it" notice from what is open and where the reader is, and the
   * only thing an arrival adds is being said out loud, politely, without taking focus.
   *
   * With no artifact open there is no pane to raise a notice in; the workspace's own Attention
   * tray lists the request and opens its artifact. Opening it FOR the reader was tried here and
   * removed: during boot the inbox can land before the first pane, and "nothing is open" was
   * indistinguishable from "nothing is open yet", which threw a reader who had asked for Read into
   * Review on load.
   */
  function announceQuestion(request) {
    const path = request.target_path ?? request.target;
    if (!path) return;
    announce(
      `${feedbackController.providerName() ?? "A session"} is asking about a passage in ${path.split("/").pop()}.`,
    );
  }

  /** The reader pressed "Go to it" for a question about an artifact that was not open. */
  async function goToRequestIn(request) {
    const path = request.target_path ?? request.target;
    if (!path) return false;
    const opened = await openArtifact(path, { mode: "review" });
    // The open is async, so the workspace can be torn down between the press and the result.
    if (!opened || unmounted) return false;
    const pane = panes.get(path);
    await pane?.ready;
    if (unmounted) return false;
    pane?.revealRequest?.(request.id);
    return true;
  }

  // Not `navigator` — that name is the browser's own global, which a pane's copy-source reads.
  const sidebarNav = createNavigatorController({
    root,
    elements: { navToggle, sidebarEl, artifactList, starredToggle, starredSection, starredList },
    enabled: surface !== "document",
  });

  function activePane() {
    return activePanelId ? (panes.get(activePanelId) ?? null) : null;
  }

  /** The top bar names the document in the active pane, by its workspace-relative path, and the
   * workspace itself only while nothing is open. */
  function refreshTopbarTitle() {
    const path = activePanelId && isArtifactPanel(activePanelId) ? activePanelId : activePane()?.path;
    titleEl.textContent = path || currentSlug || "glosa";
  }

  // Go to (⌘K): the active pane's sections and every file in the workspace, in one list. The
  // sections come from the pane, which knows which face is showing; the files from the same map
  // the navigator draws, so the two never disagree about what exists.
  const palette = createCommandPalette({
    host: root,
    getFiles: () => [...knownArtifacts.keys()],
    getSections: () => {
      const pane = activePane();
      const outline = pane?.getOutline?.();
      if (!pane || !outline?.entries.length || !isArtifactPanel(pane.path)) return null;
      return { title: pane.path, entries: outline.entries, current: outline.current };
    },
    onOpenFile: (path) => void openArtifact(path),
    getCommands: () => paletteCommands(),
    // Every workspace glosa is serving, once there is more than one to choose between.
    getWorkspaces: () =>
      workspaces.length > 1
        ? workspaces.map((w) => ({
            slug: w.slug,
            name: folderName(w.path, w.slug),
            detail: parentFolder(w.path),
            current: w.slug === currentSlug,
            starred: stars.some((star) => star.slug === w.slug),
          }))
        : [],
    onOpenWorkspace: (slug) => {
      if (slug !== currentSlug) void selectWorkspace(slug).catch(showWorkspaceError);
    },
    starIcon: shell.starIcon,
  });
  goToTrigger.addEventListener("click", () => palette.open());
  goToTrigger.setAttribute("aria-label", "Go to");

  /** What the reader can do to the page in front of them, in a fixed order. Only what applies right
   * now is listed, so the palette never offers an action that would do nothing. */
  function paletteCommands() {
    const pane = activePane();
    const commands = [];
    if (pane && isArtifactPanel(pane.path) && !readLock) {
      const mode = pane.getMode?.();
      if (mode === "edit") {
        commands.push({ id: "done", label: "Done editing", detail: "⌘E", run: () => pane.toggleEdit?.() });
      } else {
        commands.push({
          id: "notes",
          label: mode === "review" ? "Hide notes" : "Show notes",
          run: () => pane.toggleNotes?.(),
        });
        if (pane.canEdit?.())
          commands.push({ id: "edit", label: "Edit", detail: "⌘E", run: () => pane.toggleEdit?.() });
      }
    }
    if (canStarCurrent()) {
      commands.push({
        id: "star",
        label: currentStar() ? "Unstar this workspace" : "Star this workspace",
        run: () => void toggleCurrentStar(),
      });
    }
    return commands;
  }

  /** The workspace's apply lease as the journal stream reports it (A4 §F05: at most one per
   * workspace). While a session holds one, every pane pauses Edit. A lease that began before this
   * page connected is not known here; the save guard still refuses a stale save in that case. */
  let applyLease = null;
  let applyLeaseTimer = null;
  function setApplyLease(lease) {
    applyLease = lease;
    if (applyLeaseTimer) clearTimeout(applyLeaseTimer);
    applyLeaseTimer = null;
    if (lease?.expires_at) {
      const ms = Date.parse(lease.expires_at) - Date.now();
      if (ms > 0) applyLeaseTimer = setTimeout(() => setApplyLease(null), ms);
      else applyLease = null;
    }
    for (const pane of panes.values()) pane.setApplyPause?.(applyLease);
  }
  function trackApplyLease(frame) {
    if (frame?.event === "apply_begin" && frame.detail?.lease_id) {
      setApplyLease({ lease_id: frame.detail.lease_id, expires_at: frame.detail.expires_at ?? null });
    } else if (
      (frame?.event === "apply_end" || frame?.event === "apply_expired") &&
      (!applyLease || !frame.detail?.lease_id || frame.detail.lease_id === applyLease.lease_id)
    ) {
      setApplyLease(null);
    }
  }

  /** With several artifacts open, the reader has to be able to tell at a glance which pane the
   * mode control, the shortcuts, and the address bar are all talking about. The active tab's
   * olive edge says it in the strip; this says it in the pane, by letting the others go quiet. */
  function markActivePane() {
    for (const [id, pane] of panes) {
      pane.element?.setAttribute("data-active", String(id === activePanelId));
      // Only the active pane offers questions about artifacts nobody has open, and the set of open
      // artifacts just changed or the focus just moved — either can change who should say it.
      pane.refreshNotice?.();
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

  /** The mode last written into each panel's saved params, so a state change that did not move
   * the mode never rewrites the arrangement. */
  const persistedModes = new Map();

  /**
   * §10: a pane's mode is part of the arrangement, so it rides in that panel's own params.
   * The address bar cannot carry it — the URL describes ONE artifact, the active pane
   * (`reflectFocus`), so without this every other pane reopened in the state it was FIRST opened
   * with.
   *
   * The save is explicit because dockview BUFFERS the layout-change event a parameter update
   * raises: left to that event, the write lands a tick after the reader flipped the mode, and a
   * reload in that gap keeps the old state. Saving here puts it in the same tick as the click.
   */
  function persistPaneMode(id, panelApi) {
    if (!panelApi?.updateParameters) return;
    // Read the pane back out of the map rather than closing over it: this runs from a callback
    // the pane can fire while it is still being constructed.
    const mode = panes.get(id)?.getMode?.();
    if (!mode || persistedModes.get(id) === mode) return;
    persistedModes.set(id, mode);
    panelApi.updateParameters({ mode });
    dock?.saveLayout();
  }

  function createPane(id, params, host, panelApi) {
    if (!isArtifactPanel(id)) {
      const [, path, from, to] = splitDiffId(id);
      const pane = createDiffPane(host, { dataAccess, slug: currentSlug, path, from, to, describeVersion });
      panes.set(id, pane);
      if (applyLease) pane.setApplyPause?.(applyLease);
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
      isArtifactOpen: (artifactPath) => panes.has(artifactPath),
      goToRequestElsewhere: (request) => goToRequestIn(request),
      openArtifactInThisPane: (nextPath) => replacePanel(id, nextPath),
      // A presented single document has no tab strip, so its pane carries the whole identity.
      getTabLabel: () => (singlePane ? null : (tabLabels().get(id) ?? id.split("/").pop())),
      faceStore,
      dictationController,
      openDiffTab: openDiff,
      claimWidth: (target) => dock?.claimWidth(id, target),
      releaseWidth: () => dock?.releaseWidth(id),
      paneCommands: singlePane ? [] : (dock?.moveCommands() ?? []),
      onStateChange: () => {
        refreshTabs();
        persistPaneMode(id, panelApi);
        if (id === activePanelId) reflectFocus();
      },
    });
    panes.set(id, pane);
    // Seeded from what this panel was restored (or opened) with, so restoring a layout does not
    // immediately write the same arrangement back over itself.
    persistedModes.set(id, pane.getMode?.() ?? params.mode ?? requestedMode);
    if (applyLease) pane.setApplyPause?.(applyLease);
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
    persistedModes.delete(id);
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
    if (!e.altKey && (e.key === "k" || e.key === "K")) {
      e.preventDefault();
      palette.toggle();
      return;
    }
    if (!e.altKey && !e.shiftKey && (e.key === "e" || e.key === "E")) {
      if (readLock || !activePane()) return;
      e.preventDefault();
      activePane().toggleEdit?.();
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
    dictationController,
  });
  const { renderConversation } = contextSurfaces;

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
  });

  function refreshAgentFeedback() {
    return feedbackController.refresh();
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
          trackApplyLease(frame.data);
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
      storage: singlePane ? null : layoutStorage,
      createPane,
      destroyPane,
      getTabState: tabStateFor,
      emptyState: paneEmptyState,
      confirmClosePanel: (id) => panes.get(id)?.confirmClose?.() ?? Promise.resolve(true),
      onActivePanelChange: (id) => {
        activePanelId = id;
        refreshTopbarTitle();
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
    refreshTopbarTitle();
    attentionTray.setWorkspace(slug);
    artifactNavigator.setWorkspace(slug);
    writeStored(layoutStorage ?? defaultStorage(), LAST_WORKSPACE_STORAGE_KEY, slug);
    renderStars();
    renderStarToggle();
    feedbackController.selectWorkspace();
    await refreshArtifactList();
    mountDock();
    // The dock was just emptied, so the bar must stop naming the previous workspace's document.
    refreshTopbarTitle();
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

  // ---------- workspaces and stars ----------

  /** Every workspace glosa is serving, as last read. The navigator no longer lists them: the
   * palette does, and the Starred section keeps the writer's own few at hand. */
  let workspaces = [];
  /** The starred folders (A1 §5.21), as last read. */
  let stars = [];
  /** False when the daemon predates stars (contract < 1.11): every star control stands down. */
  let starsSupported = false;
  /** Per-star progress the list shows while a reopen runs or after one fails. */
  const starProgress = new Map();

  function currentWorkspace() {
    return workspaces.find((w) => w.slug === currentSlug) ?? null;
  }

  function currentStar() {
    return currentSlug ? (stars.find((star) => star.state === "open" && star.slug === currentSlug) ?? null) : null;
  }

  function canStarCurrent() {
    return starsSupported && !singlePane && currentWorkspace()?.kind === "directory";
  }

  function renderStarToggle() {
    const workspace = currentWorkspace();
    starToggle.hidden = !canStarCurrent();
    if (starToggle.hidden || !workspace) return;
    const starred = Boolean(currentStar());
    const name = folderName(workspace.path, workspace.slug);
    starToggle.setAttribute("aria-pressed", String(starred));
    starToggle.setAttribute("aria-label", starred ? "Unstar this workspace" : "Star this workspace");
    starToggle.title = starred ? `Unstar ${name}` : `Star ${name}`;
  }

  function starRow(star) {
    const progress = starProgress.get(star.id);
    const state = progress?.state ?? star.state;
    const current = star.state === "open" && star.slug === currentSlug;
    const open = el("button", {
      type: "button",
      className: "glosa-starred-open",
      title: star.path,
      "aria-current": String(current),
    });
    open.append(el("span", { className: "glosa-starred-name", textContent: star.name }));
    if (star.state === "open" && star.has_attention) {
      open.append(
        el("span", { className: "glosa-starred-dot", "aria-hidden": "true" }),
        el("span", { className: "glosa-visually-hidden", textContent: ", a session is asking" }),
      );
    }
    const meta =
      state === "missing"
        ? "Folder not found"
        : state === "opening"
          ? "Opening…"
          : state === "error"
            ? "Couldn't open"
            : state === "closed"
              ? "Not open"
              : null;
    if (meta) open.append(el("span", { className: "glosa-starred-meta", textContent: meta }));
    if (state === "error" && progress?.message) open.title = `${star.path}\n${progress.message}`;
    if (state === "missing" || state === "opening") open.setAttribute("aria-disabled", "true");
    if (state === "opening") open.setAttribute("aria-busy", "true");
    open.addEventListener("click", () => void chooseStar(star));

    const unstar = el("button", {
      type: "button",
      className: "glosa-tree-tool glosa-starred-unstar",
      title: "Unstar",
      "aria-label": `Unstar ${star.name}`,
    });
    unstar.innerHTML = shell.starIcon;
    unstar.addEventListener("click", () => void unstarById(star.id, star.name));

    return el("li", { className: "glosa-starred-row", "data-state": state, "data-star": star.id }, [open, unstar]);
  }

  function renderStars() {
    const focusedStar = document.activeElement?.closest?.(".glosa-starred-row")?.getAttribute("data-star") ?? null;
    const focusedUnstar = Boolean(document.activeElement?.classList?.contains("glosa-starred-unstar"));
    starredList.textContent = "";
    for (const star of stars) starredList.append(starRow(star));
    starredCount.textContent = String(stars.length);
    sidebarNav.setStarredAvailable(starsSupported && stars.length > 0);
    // A re-render must not drop the keyboard out of the list it was in.
    if (focusedStar) {
      const row = starredList.querySelector(`[data-star="${focusedStar}"]`);
      row
        ?.querySelector(focusedUnstar ? ".glosa-starred-unstar" : ".glosa-starred-open")
        ?.focus({ preventScroll: true });
    }
  }

  async function loadWorkspaces() {
    workspaces = await dataAccess.getWorkspaces();
    return workspaces;
  }

  async function refreshStars() {
    try {
      stars = await dataAccess.getStars();
      starsSupported = Array.isArray(stars);
      if (!starsSupported) stars = [];
    } catch {
      // An older daemon has no star routes; the navigator simply has no Starred section.
      stars = [];
      starsSupported = false;
    }
    renderStars();
    renderStarToggle();
  }

  async function chooseStar(star) {
    const progress = starProgress.get(star.id)?.state;
    if (star.state === "missing" || progress === "opening") return;
    if (star.state === "open" && star.slug) {
      if (star.slug !== currentSlug) await selectWorkspace(star.slug).catch(showWorkspaceError);
      return;
    }
    starProgress.set(star.id, { state: "opening" });
    renderStars();
    try {
      const opened = await dataAccess.openStar(star.id);
      starProgress.delete(star.id);
      await loadWorkspaces();
      await refreshStars();
      await selectWorkspace(opened.slug);
      announce(`Opened ${star.name}.`);
    } catch (error) {
      starProgress.set(star.id, {
        state: "error",
        message: error instanceof Error ? error.message : "Try again, or run glosa open in a terminal.",
      });
      // The folder may have gone while the list was showing; say so rather than "couldn't open".
      await refreshStars();
      if (stars.find((s) => s.id === star.id)?.state === "missing") {
        starProgress.delete(star.id);
        renderStars();
        announce(`${star.name} could not be opened: its folder is gone.`);
      } else {
        announce(`${star.name} could not be opened. ${starProgress.get(star.id)?.message ?? ""}`.trim());
      }
    }
  }

  async function unstarById(id, name) {
    try {
      await dataAccess.unstarWorkspace(id);
      starProgress.delete(id);
      announce(`Unstarred ${name}.`);
    } finally {
      await refreshStars();
    }
  }

  async function toggleCurrentStar() {
    const workspace = currentWorkspace();
    if (!workspace || !canStarCurrent()) return;
    const existing = currentStar();
    const name = folderName(workspace.path, workspace.slug);
    if (existing) {
      await unstarById(existing.id, name);
      return;
    }
    try {
      await dataAccess.starWorkspace(workspace.slug);
      announce(`Starred ${name}.`);
    } finally {
      await refreshStars();
    }
  }

  starToggle.addEventListener("click", () => void toggleCurrentStar().catch(() => {}));

  function showNoWorkspaces() {
    dockHost.textContent = "";
    dockHost.append(
      el("div", { className: "glosa-empty" }, [
        el("p", { className: "glosa-empty-title", textContent: "No workspaces yet." }),
        el(
          "p",
          { className: "glosa-empty-hint" },
          starsSupported && stars.length > 0
            ? [
                "Reopen a starred folder from the navigator, or run ",
                el("code", { textContent: "glosa open <directory>" }),
                " in a terminal.",
              ]
            : [
                "In a terminal, run ",
                el("code", { textContent: "glosa open <directory>" }),
                " to start reviewing its artifacts here.",
              ],
        ),
      ]),
    );
  }

  async function refreshWorkspaces() {
    const [live] = await Promise.all([loadWorkspaces(), refreshStars()]);
    renderStarToggle();
    if (live.length === 0) {
      showNoWorkspaces();
      return;
    }
    if (currentSlug) return;
    if (initialSlug) {
      await selectWorkspace(initialSlug);
      return;
    }
    // With the switcher gone from the navigator, a page with several live workspaces opens on the
    // one this browser last had, then on the most recently active; Go to (⌘K, @) switches.
    const remembered = readStored(layoutStorage ?? defaultStorage(), LAST_WORKSPACE_STORAGE_KEY);
    const pick =
      live.find((w) => w.slug === remembered) ??
      [...live].sort((a, b) => String(b.last_seen ?? "").localeCompare(String(a.last_seen ?? "")))[0];
    await selectWorkspace(pick.slug);
  }

  // Coming back to the tab is when another workspace may have been opened or closed in a terminal.
  const onWindowFocus = () => {
    if (singlePane || unmounted) return;
    void loadWorkspaces()
      .then(() => refreshStars())
      .catch(() => {});
  };
  window.addEventListener("focus", onWindowFocus);

  void refreshWorkspaces().catch(showWorkspaceError);

  const unmount = () => {
    unmounted = true;
    document.removeEventListener("keydown", onShortcut);
    document.removeEventListener("click", onDocumentClick);
    window.removeEventListener("focus", onWindowFocus);
    sidebarNav.destroy();
    feedbackController.destroy();
    stopStream?.();
    for (const pane of panes.values()) pane.destroy?.();
    panes.clear();
    dock?.destroy();
    contextSurfaces.destroy();
    palette.destroy();
    shell.destroy();
    if (ownsDictationController) dictationController.destroy();
  };
  // Keep the callable cleanup contract for existing hosts. URL navigation closes the whole
  // view, so every pane must consent before bootstrap reloads it with another surface/layout.
  unmount.confirmClose = async () => {
    for (const pane of panes.values()) {
      if (!(await (pane.confirmClose?.() ?? true))) return false;
    }
    return true;
  };
  return unmount;
}

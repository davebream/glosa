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

import { addressProblem, parseAddress } from "./browser-address.js";
import { createBrowserPane } from "./browser-pane.js";
import { createChatLogPane } from "./chat-log-pane.js";
import { createReadOnlyPane } from "./read-only-pane.js";
import { createFileViewControls } from "./file-view.js";
import { createImagePane } from "./image-pane.js";
import { createFileActions } from "./file-actions.js";
import { droppedImages } from "./image-insertion.js";
import { mountAgentFeedback } from "./agent-feedback.js";
import { needsResponse, requestNotice, selectArrivals } from "./agent-request.js";
import { mountAgentSettings } from "./agent-settings.js";
import { actionMenu, agentName } from "./agent-ui.js";
import { mountAppearanceControl } from "./appearance.js";
import { createArtifactPane, highlightsAvailable, MODES } from "./artifact-pane.js";
import { createArtifactTreeNavigator } from "./artifact-tree.js";
import { mountAttentionTray } from "./attention-tray.js";
import { createAttentionWatch } from "./attention-watch.js";
import { createChatPane } from "./chat-pane.js";
import { createDataAccess } from "./data-access.js";
import { createDictationController } from "./dictation.js";
import { createDiffPane } from "./diff-pane.js";
import { createDock, describeVersion, diffPanelId, disambiguateLabels, MIN_PANE_WIDTH } from "./dock.js";
import { createStyleStore } from "./style.js";
import { createTextSizeStore } from "./text-size.js";
import { createCommandPalette } from "./palette.js";
import {
  artifactPanelId,
  browserPanelId,
  chatLogPanelId,
  chatPanelId,
  decodePanelId,
  externalPanelId,
  settingsPanelId,
} from "./panel-identity.js";
import { createContextSurfaceController } from "./viewer-context-surfaces.js";
import { createViewerFeedbackController } from "./viewer-feedback.js";
import { createNavigatorController, NAV_OPEN_DOCUMENT_STORAGE_KEY, NAV_OPEN_STORAGE_KEY } from "./viewer-navigator.js";
import { createElement as el, createSectionToggle, createViewerShell } from "./viewer-shell.js";

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
 *   surfaceKind?: "desk" | "companion",
 *   appearance?: any,
 *   onFocusChange?: (focus: any) => void,
 *   layoutStorage?: any,
 *   styleStore?: any,
 *   textSize?: any,
 *   dictationController?: any,
 *   shell?: { revealInFinder?: () => Promise<unknown>, notify?: (message: any) => Promise<unknown> } | null,
 *   highlightsAvailable?: () => boolean,
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
    // "desk" (a person opened this surface: chat, stars, projects) or "companion" (a terminal
    // agent presented it: its connection, the margin, the inbox). Fixed for the surface's life.
    surfaceKind = "companion",
    appearance,
    onFocusChange,
    layoutStorage,
    // Each document's style (style.js), with its folder's default read and written through
    // dataAccess. One store for every pane; a test passes its own.
    styleStore = createStyleStore({
      storage: layoutStorage ?? undefined,
      loadFolderStyle: dataAccess.getFolderStyle ? (slug) => dataAccess.getFolderStyle(slug) : undefined,
      saveFolderStyle: dataAccess.setFolderStyle ? (slug, style) => dataAccess.setFolderStyle(slug, style) : undefined,
    }),
    // The text size step (#406), one per page: every pane's More menu and Settings share it.
    textSize = createTextSizeStore({ storage: layoutStorage ?? undefined }),
    dictationController: injectedDictationController,
    // The desktop shell's bridge (`window.glosaShell`), or null in a browser. The SPA reaches the
    // daemon only through dataAccess (R6); this is the one other way out, and only in the shell.
    shell: desktopShell = null,
    // Whether this browser paints marks: artifact-pane.js's feature test. Injected so a test DOM
    // with no highlight registry, which is every happy-dom test, can stand in for a browser that
    // has one instead of raising the notice below in tests about something else.
    highlightsAvailable: browserPaintsMarks = highlightsAvailable,
  } = {},
) {
  root.textContent = "";
  root.classList.add("glosa-app");
  root.setAttribute("data-surface", surface === "document" ? "document" : "workspace");
  root.setAttribute("data-kind", surfaceKind);
  const desk = surfaceKind === "desk";
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
  // The Dock badge and OS notifications (#391): only inside the desktop shell, never in a tab.
  const attentionWatch =
    typeof desktopShell?.notify === "function"
      ? createAttentionWatch({
          dataAccess,
          bridge: /** @type {any} */ (desktopShell),
          desk,
          currentSlug: () => currentSlug,
          hasFocus: () => document.hasFocus(),
        })
      : null;
  let dock = null;
  let knownImages = new Map();
  let knownReadOnly = new Map(),
    knownDirectories = [];
  let fileView = { mode: "all", show_ignored: false };
  let readOnlyGeneration = 0;

  let knownArtifacts = new Map(); // path → summary, for restore validation and tab state
  /** @type {Map<string, any>} */
  const panes = new Map(); // panel id → pane handle
  let activePanelId = null;
  let requestedMode = MODES.includes(initialMode) ? initialMode : "review";
  // While an open is switching documents, the path it is switching to, and whether the address
  // it lands on is a new history entry (#455) or a description of the view that replaces one.
  let switchingTo = null;
  let historyIntent = "replace";

  // A single presented document is one document at a time: no tab strip, no dock (brief §4). The
  // navigator still reaches the rest of the workspace, closed until the reader opens it (#455).
  const singlePane = surface === "document";
  // Desk browser tabs (#440): web pages open in the dock only in a desktop app whose shell hosts
  // them, and says which version it is; in a plain browser the same actions hand the address to
  // the person's own browser. A companion surface has none of it.
  const browserTabs = desk && !singlePane && Number(desktopShell?.browserTabs) >= 1;
  /** A page that belongs outside glosa: the desktop shell hands it to the system; a plain browser
   * opens a tab of its own. */
  function openOutside(url) {
    if (typeof desktopShell?.openExternal === "function") {
      void Promise.resolve(desktopShell.openExternal(url)).catch(() => {});
    } else window.open(url, "_blank", "noopener,noreferrer");
  }
  const dictationController =
    injectedDictationController ??
    createDictationController({ dataAccess, onSettings: () => openAgentSettings("dictation") });
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
  // The connection chip is the companion surface's: it names the terminal agent that presented
  // this surface. A desk surface has no such agent, and its chat pane says what its chat is doing.
  const agentFeedbackHost = root.querySelector(".glosa-agent-feedback");
  if (agentFeedbackHost && desk) agentFeedbackHost.hidden = true;
  const {
    navToggle,
    titleEl,
    goToTrigger,
    shortcutsToggle,
    topbarOverlays,
    appearanceHost,
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
    marksNoticeEl,
    dockHost,
    sidebarEl,
  } = shell.elements;
  // A browser without the highlight API paints no mark on any document, and every pane finds that
  // out for itself. The page says it once (#412). Only where this page's own check agrees: that
  // check is the one a test can replace.
  const onMarksUnavailable = browserPaintsMarks()
    ? undefined
    : () => {
        marksNoticeEl.hidden = false;
      };

  let chatList = [],
    externalSessions = [],
    rememberedExternal = [],
    agentStatus,
    chatsRefreshTimer,
    chatsRefreshGeneration = 0,
    workspaceSelectionGeneration = 0,
    stopChatsStream,
    /** @type {undefined | (() => void)} */ stopBrowserRequests,
    creatingChat = false;
  // Chats belong to the desk surface: a companion surface already has its agent in a terminal.
  const chatsHost = el("section", {
    className: "glosa-sidebar-chats",
    hidden: !desk || singlePane || !dataAccess.getChats,
  });
  const chatsRows = el("div", { className: "glosa-chat-list" });
  const chatNotice = el("p", { role: "status", className: "glosa-sidebar-empty" });
  const listMenu = actionMenu("Chat list options");
  // Drawn, like the star and the menu's dots, so the three header tools share one stroke.
  const newChatButton = el("button", {
    type: "button",
    className: "glosa-tree-tool glosa-new-chat",
    "aria-label": "New chat",
    title: "New chat",
    onClick: () => void newChat().catch(chatFailed("Couldn't start a chat")),
  });
  newChatButton.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12"/></svg>';
  const chatsBody = el("div", { id: `chat-list-${crypto.randomUUID()}` }, [chatsRows, chatNotice]);
  const { button: chatToggle, label: chatToggleLabel } = createSectionToggle({
    className: "glosa-chat-list-toggle",
    text: "Chats",
    controls: chatsBody.id,
  });
  chatToggle.addEventListener("click", () => {
    chatsBody.hidden = !chatsBody.hidden;
    chatToggle.setAttribute("aria-expanded", String(!chatsBody.hidden));
  });
  // What the sidebar says when a chat action fails: the action it was doing, then the reason —
  // never the bare reason, which read as a label the interface had lost the front half of.
  const chatFailed = (doing) => (error) => {
    if (!unmounted) chatNotice.textContent = `${doing}: ${error.message}`;
  };
  chatsHost.append(
    el("div", { className: "glosa-sidebar-heading" }, [el("h2", {}, [chatToggle]), listMenu.element, newChatButton]),
    chatsBody,
  );
  sidebarEl.querySelector(".glosa-sidebar-scroll").append(chatsHost);
  // Settings rides the foot strip beside the navigator's toggle: one row, one rule.
  const settingsLink = el("button", {
    type: "button",
    className: "glosa-sidebar-settings",
    "aria-label": "Settings",
    title: "Settings",
    onClick: openAgentSettings,
  });
  settingsLink.innerHTML =
    '<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="M8.4 2.5h3.2l.5 2a6 6 0 0 1 1.2.7l2-.6 1.6 2.8-1.5 1.4a6 6 0 0 1 0 1.4l1.5 1.4-1.6 2.8-2-.6a6 6 0 0 1-1.2.7l-.5 2H8.4l-.5-2a6 6 0 0 1-1.2-.7l-2 .6-1.6-2.8 1.5-1.4a6 6 0 0 1 0-1.4L3.1 7.4l1.6-2.8 2 .6a6 6 0 0 1 1.2-.7z"/><circle cx="10" cy="9.5" r="2.5"/></svg><span>Settings</span>';
  shell.elements.navFoot.append(settingsLink);
  const archivedChats = el("input", { type: "checkbox", "aria-label": "Include archived chats" });
  archivedChats.addEventListener("change", scheduleChatsRefresh);
  listMenu.popup.append(
    el("label", {}, [archivedChats, document.createTextNode(" Include archived chats")]),
    el("button", {
      type: "button",
      textContent: "Refresh chats",
      onClick: () => void refreshChats().catch(chatFailed("Couldn't refresh chats")),
    }),
  );
  function renderChats() {
    chatToggleLabel.textContent = "Chats";
    const focusedId = chatsRows.contains(document.activeElement) ? document.activeElement.dataset.panelId : null;
    const item = ({ id, title, pinned, archived, onClick, chat }) => {
      const row = el(
        "button",
        {
          type: "button",
          className: "glosa-chat-list-item",
          "data-panel-id": id,
          "aria-current": activePanelId === id ? "page" : "false",
          title,
          "aria-label": `${title}${pinned ? " · Pinned" : ""}${archived ? " · Archived" : ""}`,
          onClick,
        },
        [el("span", { className: "glosa-chat-list-title", textContent: title })],
      );
      const wrapper = el("div", { className: "glosa-chat-list-row", "data-pinned": String(!!pinned) }, [row]);
      if (chat) {
        const actions = actionMenu(`Actions for ${title}`);
        actions.popup.append(
          el("button", {
            type: "button",
            textContent: pinned ? "Unpin chat" : "Pin chat",
            onClick: async () => {
              const slug = currentSlug;
              try {
                const current = await dataAccess.getChat(slug, chat.id);
                await dataAccess.changeChat(slug, chat.id, {
                  requestId: crypto.randomUUID(),
                  revision: current.configRevision,
                  pinned: !current.pinned,
                });
                if (slug === currentSlug && !unmounted) await refreshChats();
              } catch (error) {
                chatFailed("Couldn't change that chat")(error);
              }
            },
          }),
        );
        wrapper.append(actions.element);
      }
      return wrapper;
    };
    chatsRows.replaceChildren(
      ...chatList
        .filter((chat) => !chat.archived || archivedChats.checked)
        .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 20)
        .map((chat) =>
          item({
            chat,
            id: chatPanelId(chat.id),
            provider: chat.provider,
            title: chat.title,
            detail: `${agentStatus?.profiles.find((p) => p.id === chat.profileId)?.label ?? "Account unavailable"} · ${chat.pendingDecisions ? `${chat.pendingDecisions} awaiting reply` : chat.status.replaceAll("_", " ")}`,
            pinned: chat.pinned,
            archived: chat.archived,
            onClick: () => openChat(chat.id),
          }),
        ),
    );
    const visibleExternal = externalSessions.slice(0, Math.max(0, 20 - Math.min(chatList.length, 20)));
    if (visibleExternal.length)
      chatsRows.append(el("p", { className: "glosa-chat-list-group", textContent: "Terminal sessions" }));
    for (const session of visibleExternal)
      chatsRows.append(
        item({
          id: externalPanelId(session.session_id),
          provider: session.provider,
          title: `${agentName(session.provider)} · ${session.session_id.slice(-8)}`,
          detail: `External · ${session.liveness}`,
          onClick: () => void openExternalChat(session.session_id).catch(chatFailed("Couldn't open that chat")),
        }),
      );
    if (!chatsRows.children.length)
      chatsRows.append(
        el("p", {
          className: "glosa-chat-list-empty",
          textContent: "No chats yet. Start one with New chat.",
        }),
      );
    if (focusedId) [...chatsRows.querySelectorAll("button")].find((row) => row.dataset.panelId === focusedId)?.focus();
  }
  function scheduleChatsRefresh() {
    clearTimeout(chatsRefreshTimer);
    chatsRefreshTimer = setTimeout(() => void refreshChats().catch(() => {}), 300);
  }
  async function refreshChats() {
    if (!dataAccess.getChats || !currentSlug || singlePane) return;
    const slug = currentSlug;
    const generation = ++chatsRefreshGeneration;
    const identity = workspaceLayoutIdentity();
    const stale = () =>
      slug !== currentSlug ||
      unmounted ||
      generation !== chatsRefreshGeneration ||
      identity !== workspaceLayoutIdentity();
    const result = await dataAccess.getChats(slug, {
      archived: archivedChats.checked,
    });
    if (stale()) return;
    const [aggregate, accounts] = await Promise.all([dataAccess.getStatus?.(), dataAccess.getAgentStatus?.()]);
    if (stale()) return;
    chatList = result.chats;
    rememberedExternal = result.external ?? [];
    agentStatus = accounts;
    const workspace = workspaces.find((entry) => entry.slug === slug);
    externalSessions = (aggregate?.sessions ?? []).filter(
      (session) => session.workspace_binding === workspace?.path && session.source !== "managed-chat",
    );
    for (const remembered of rememberedExternal)
      if (!externalSessions.some((session) => session.session_id === remembered.sessionId))
        externalSessions.push({
          session_id: remembered.sessionId,
          provider: remembered.provider,
          liveness: "disconnected",
        });
    renderChats();
  }
  async function openExternalChat(sessionId) {
    if (!dock || unmounted) return;
    const id = externalPanelId(sessionId),
      panel = dock.api.getPanel(id);
    if (panel) {
      panel.api.setActive();
      return;
    }
    dock.api.addPanel({
      id,
      component: "pane",
      tabComponent: "pane",
      title: "External session",
      params: { kind: "external-chat", sessionId },
    });
  }
  function openChat(chatId, sourceChatId, group) {
    if (!dock) return;
    const id = chatPanelId(chatId),
      panel = dock.api.getPanel(id);
    if (panel) {
      panel.api.setActive();
      return;
    }
    dock.api.addPanel({
      id,
      component: "pane",
      tabComponent: "pane",
      title: "Chat",
      params: { kind: "chat", chatId, sourceChatId },
      ...(group && dock.api.groups.includes(group) ? { position: { referenceGroup: group } } : {}),
    });
  }

  /** A chat's protocol log opens once, beside the chat that asked for it. */
  function openChatLog(chatId) {
    if (!dock) return;
    const id = chatLogPanelId(chatId),
      panel = dock.api.getPanel(id);
    if (panel) {
      panel.api.setActive();
      return;
    }
    const beside = dock.api.getPanel(chatPanelId(chatId))?.group;
    dock.api.addPanel({
      id,
      component: "pane",
      tabComponent: "pane",
      title: "Protocol log",
      params: { kind: "chat-log", chatId },
      ...(beside ? { position: { referenceGroup: beside, direction: "right" } } : {}),
    });
  }

  // ---------- desk browser tabs (#440) ----------

  /** A new browser tab, in `group` or the active one, and its panel id. In a plain browser there is
   * no tab to open: the address goes to the person's own browser instead (`askAddress`). An agent's
   * tab opens `inactive`: it joins the strip, marked, without taking the pane from the person. */
  function openBrowserTab({ url = "", group, inactive = false } = {}) {
    if (!dock || !desk || singlePane) return null;
    if (!browserTabs) {
      if (url) openOutside(url);
      else askAddress();
      return null;
    }
    const target = group && dock.api.groups.includes(group) ? group : dock.api.activeGroup;
    const id = browserPanelId(crypto.randomUUID());
    dock.api.addPanel({
      id,
      component: "pane",
      tabComponent: "pane",
      title: "New browser tab",
      params: { kind: "browser", url },
      renderer: "always",
      minimumWidth: MIN_PANE_WIDTH,
      ...(target ? { position: { referenceGroup: target } } : {}),
      ...(inactive ? { inactive: true } : {}),
    });
    markActivePane();
    // A blank tab is for typing an address: its field takes focus once dockview has attached it.
    if (!url && !inactive) requestAnimationFrame(() => panes.get(id)?.focusAddress?.());
    return id;
  }

  /**
   * A chat agent's request for this window's browser tabs (#440), sent by the daemon on this
   * workspace's stream because this is a desk window in the desktop app. Open and navigate wait for
   * the page to settle; read asks the shell for the page's text. The tab says who is at work on it
   * (brief C2) while the request runs, then that the agent opened it, until the person navigates.
   * The daemon holds the rules (which tabs this chat may use, which addresses); this answers.
   */
  async function handleBrowserRequest(slug, request) {
    const answer = (result) => dataAccess.answerBrowserRequest?.(slug, request.id, result).catch(() => {});
    if (unmounted || slug !== currentSlug || !dock) {
      return answer({ ok: false, reason: "This window is showing another workspace." });
    }
    const who = agentName(request.provider);
    const tabOf = (id) => decodePanelId(id)[1];
    try {
      if (request.action === "open") {
        // Opened blank, then navigated as the agent's: the page it lands on stays marked as the
        // agent's until the person takes the tab somewhere else.
        const id = openBrowserTab({ inactive: true });
        const pane = id ? panes.get(id) : null;
        if (!id || !pane) return answer({ ok: false, reason: "This window cannot open a browser tab." });
        pane.markAgent(who, "working", "opening");
        pane.navigate(String(request.url ?? ""));
        const page = await pane.waitForLoad();
        pane.markAgent(who, "done");
        return answer({ ok: true, tab: tabOf(id), ...page });
      }
      const pane = panes.get(browserPanelId(String(request.tab ?? "")));
      if (!pane) return answer({ ok: false, reason: "That tab has been closed." });
      if (request.action === "navigate") {
        pane.markAgent(who, "working", "opening");
        pane.navigate(String(request.url ?? ""));
        const page = await pane.waitForLoad();
        pane.markAgent(who, "done");
        return answer({ ok: true, tab: request.tab, ...page });
      }
      if (request.action === "read") {
        const guest = pane.guestId();
        if (guest === null || pane.state !== "page" || typeof desktopShell?.readBrowserTab !== "function") {
          return answer({ ok: false, reason: "That tab has no page loaded to read." });
        }
        pane.markAgent(who, "working", "reading");
        try {
          const read = await desktopShell.readBrowserTab(guest, request.max_chars);
          return answer({ ok: true, tab: request.tab, ...read });
        } finally {
          pane.markAgent(who, "done");
        }
      }
      return answer({ ok: false, reason: "That is not something a browser tab can do." });
    } catch {
      return answer({ ok: false, reason: "The browser tab could not do that." });
    }
  }

  /** The plain-browser hand-off (brief S7): Go to asks for an address, and Return opens it in a new
   * tab of this browser. glosa's own page stays where it was. */
  function askAddress() {
    palette.prompt({
      label: "Open a web page",
      placeholder: "Web address, or localhost and a port",
      hint: "Browser tabs inside glosa need the desktop app. Here, pages open in your own browser.",
      describe: (text) => {
        const parsed = parseAddress(text);
        if (parsed.ok) return { ok: true, label: `Open ${text.trim()}`, detail: "in a new tab of this browser" };
        return parsed.reason === "empty" ? null : { ok: false, message: addressProblem(parsed) };
      },
      submit: (text) => {
        const parsed = parseAddress(text);
        if (parsed.ok) window.open(parsed.url, "_blank", "noopener,noreferrer");
      },
    });
  }

  function newBrowserTab(group) {
    if (browserTabs) openBrowserTab({ group });
    else askAddress();
  }

  /** The dock group a node sits in, found through the pane that holds it. */
  function groupHolding(node) {
    for (const [id, pane] of panes) {
      if (pane.element?.contains?.(node)) return dock?.api.getPanel(id)?.api.group;
    }
    return undefined;
  }

  // Web links on the desk (#440). A link in a chat or a document opens a browser tab beside the
  // pane it is in; in a plain browser, and anywhere else (Settings, a companion surface), it opens
  // outside glosa. Nothing here follows a link inside glosa's own page: before this, the desktop
  // app dropped every such click and a plain browser navigated away from glosa.
  function onLinkActivate(event) {
    if (event.defaultPrevented) return;
    if (event.type === "click" ? event.button !== 0 : event.button !== 1) return;
    const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!anchor || !root.contains(anchor)) return;
    let target;
    try {
      target = new URL(anchor.getAttribute("href") ?? "", window.location.href);
    } catch {
      return;
    }
    if (target.protocol === "mailto:") {
      if (typeof desktopShell?.openExternal !== "function") return;
      event.preventDefault();
      openOutside(target.href);
      return;
    }
    if ((target.protocol !== "http:" && target.protocol !== "https:") || target.origin === window.location.origin)
      return;
    event.preventDefault();
    const inWriting = anchor.closest(".glosa-chat-markdown, .glosa-content, .glosa-conv-feed");
    if (inWriting && browserTabs) openBrowserTab({ url: target.href, group: groupHolding(anchor) });
    else openOutside(target.href);
  }
  root.addEventListener("click", onLinkActivate);
  root.addEventListener("auxclick", onLinkActivate);

  /** What the shell saw in one of this window's browser tabs (packages/shell/src/preload.cjs). */
  function onBrowserEvent(event) {
    if (unmounted) return;
    if (event.type === "key") {
      // A glosa chord pressed with a page focused: the same shortcut the document would have had.
      onShortcut({
        key: event.key,
        metaKey: Boolean(event.meta),
        ctrlKey: Boolean(event.control),
        shiftKey: Boolean(event.shift),
        altKey: Boolean(event.alt),
        preventDefault() {},
      });
      return;
    }
    for (const [id, pane] of panes) {
      if (pane.kind !== "browser" || pane.guestId?.() !== event.guestId) continue;
      if (event.type === "open-tab") openBrowserTab({ url: event.url, group: dock?.api.getPanel(id)?.api.group });
      else pane.handleShellEvent?.(event);
      return;
    }
  }
  const stopBrowserEvents = browserTabs ? (desktopShell?.onBrowserEvent?.(onBrowserEvent) ?? null) : null;

  const TOOL_ICONS = {
    chat: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 2.5h9v6.5H6l-3.5 2.8z"/><path d="M13 9.5v4M11 11.5h4"/></svg>',
    browser:
      '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="5"/><path d="M2 7h10M7 2c-1.8 2-1.8 8 0 10M7 2c1.8 2 1.8 8 0 10"/><path d="M13 10.5v4M11 12.5h4"/></svg>',
  };

  /** The tools at the right end of a desk group's tab strip (brief E3b): a new chat and a new
   * browser tab, each opening in this group. */
  function stripTools(group) {
    const tool = (className, label, icon, onClick) => {
      const button = el("button", {
        type: "button",
        className: `glosa-strip-tool ${className}`,
        "aria-label": label,
        title: label,
        onClick,
      });
      button.innerHTML = icon;
      return button;
    };
    const tools = el("div", { className: "glosa-strip-tools", role: "group", "aria-label": "New tab in this pane" });
    if (dataAccess.getChats)
      tools.append(
        tool("glosa-strip-new-chat", "New chat", TOOL_ICONS.chat, () =>
          newChat(undefined, undefined, undefined, group).catch(chatFailed("Couldn't start a chat")),
        ),
      );
    tools.append(
      tool(
        "glosa-strip-new-browser",
        browserTabs ? "New browser tab (⌘T)" : "Open a web page in your browser",
        TOOL_ICONS.browser,
        () => newBrowserTab(group),
      ),
    );
    return tools;
  }
  function openAgentSettings(section) {
    if (!dock) return;
    const id = settingsPanelId(),
      panel = dock.api.getPanel(id);
    if (panel) {
      panel.api.setActive();
      if (section === "dictation") panes.get(id)?.showDictation?.();
      return;
    }
    dock.api.addPanel({
      id,
      component: "pane",
      tabComponent: "pane",
      title: "Settings",
      params: { kind: "agent-settings", section: section === "dictation" ? section : undefined },
    });
  }
  async function newChat(profile, settings, sourceChatId, group) {
    if (creatingChat) return;
    creatingChat = true;
    try {
      agentStatus = await dataAccess.getAgentStatus();
      const slug = currentSlug;
      const providerKey = `glosa.chat-provider:${slug}`;
      const lastProvider = readStored(layoutStorage, providerKey);
      const eligible = agentStatus.profiles.filter((p) => p.enabled && !p.removed && p.auth?.state === "authenticated");
      let chosen = profile ?? eligible.find((p) => p.isDefault && p.provider === lastProvider);
      if (!chosen && !lastProvider && eligible.filter((p) => p.isDefault).length === 1)
        chosen = eligible.find((p) => p.isDefault);
      if (!chosen && eligible.length) {
        chosen = await new Promise((resolve) => {
          const previous = document.activeElement;
          const dialog = el("dialog", { className: "glosa-dialog", "aria-label": "Choose agent account" });
          dialog.append(el("h2", { textContent: "Choose an account for this chat" }));
          for (const account of eligible)
            dialog.append(
              el("button", {
                type: "button",
                textContent: `${agentName(account.provider)} · ${account.label}`,
                onClick: () => {
                  dialog.choice = account;
                  dialog.close();
                },
              }),
            );
          dialog.append(el("button", { type: "button", textContent: "Cancel", onClick: () => dialog.close() }));
          dialog.addEventListener(
            "close",
            () => {
              resolve(dialog.choice);
              dialog.remove();
              previous?.focus();
            },
            { once: true },
          );
          document.body.append(dialog);
          dialog.showModal();
        });
        if (!chosen) return;
      }
      if (!chosen) {
        // Settings opens in the main area, which is the whole answer; a second sentence in the
        // sidebar under the empty state only said it again.
        openAgentSettings();
        return;
      }
      if (slug !== currentSlug || unmounted) return;
      writeStored(layoutStorage, providerKey, chosen.provider);
      const model = agentStatus.capabilities?.[chosen.id]?.models[0];
      const chat = await dataAccess.createChat(slug, {
        requestId: crypto.randomUUID(),
        id: crypto.randomUUID(),
        provider: chosen.provider,
        profileId: chosen.id,
        settings: settings ?? { model: model?.id ?? "", effort: model?.efforts[0] ?? "", permissionMode: "default" },
      });
      if (slug !== currentSlug || unmounted) return;
      await refreshChats();
      if (slug !== currentSlug || unmounted) return;
      openChat(chat.id, sourceChatId, group);
    } finally {
      creatingChat = false;
    }
  }

  const toolControls = () =>
    [appearanceHost.querySelector(".glosa-appearance-trigger"), shortcutsToggle].filter(
      (control) => control && !control.disabled && !control.hidden,
    );

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
    const question = arrivals.find(needsResponse);
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
    announce(requestNotice(request, { file: path.split("/").pop() }));
  }

  /** The reader pressed "Go to it" for a question about an artifact that was not open. */
  async function goToRequestIn(request) {
    const path = request.target_path ?? request.target;
    if (!path) return false;
    const opened = await openArtifact(path, { mode: "review" });
    // The open is async, so the workspace can be torn down between the press and the result.
    if (!opened || unmounted) return false;
    const pane = panes.get(artifactPanelId(path));
    await pane?.ready;
    if (unmounted) return false;
    pane?.revealRequest?.(request.id);
    return true;
  }

  // Not `navigator` — that name is the browser's own global, which a pane's copy-source reads.
  const sidebarNav = createNavigatorController({
    root,
    elements: { navToggle, sidebarEl, artifactList, starredToggle, starredSection, starredList },
    // Its own preference, closed by default: a desk reader's open navigator must not open in every
    // document an agent presents.
    preferenceKey: singlePane ? NAV_OPEN_DOCUMENT_STORAGE_KEY : NAV_OPEN_STORAGE_KEY,
    defaultOpen: !singlePane,
    // Stars are a desk affordance (decision 2026-09-25); a companion surface never lists them.
    desk,
  });

  function activePane() {
    return activePanelId ? (panes.get(activePanelId) ?? null) : null;
  }

  /** The top bar names the document in the active pane, by its workspace-relative path, and the
   * workspace itself only while nothing is open. */
  function refreshTopbarTitle() {
    titleEl.textContent = "Search documents and chats";
    goToTrigger.title = `Search in ${currentSlug || "Glosa"} (⌘K)`;
  }

  // Go to (⌘K): the active pane's sections and every file in the workspace, in one list. The
  // sections come from the pane, which knows which face is showing; the files from the same map
  // the navigator draws, so the two never disagree about what exists.
  const palette = createCommandPalette({
    host: root,
    getFiles: () => [...knownArtifacts.keys()],
    getChats: () => [
      ...chatList,
      ...externalSessions.map((session) => ({
        id: `external:${session.session_id}`,
        title: `${agentName(session.provider)} · ${session.session_id.slice(-8)}`,
      })),
    ],
    searchChats: dataAccess.getChats
      ? async (q, after) => {
          const slug = currentSlug;
          if (!slug) return { chats: [] };
          const result = await dataAccess.getChats(slug, { q, after, archived: true });
          if (slug !== currentSlug || unmounted) return { chats: [] };
          const terminals = after
            ? []
            : externalSessions
                .map((session) => ({
                  id: `external:${session.session_id}`,
                  title: `${agentName(session.provider)} · ${session.session_id.slice(-8)}`,
                }))
                .filter((session) => session.title.toLowerCase().includes(q.trim().toLowerCase()));
          return { ...result, chats: [...result.chats, ...terminals] };
        }
      : undefined,
    onOpenChat: (id) => {
      if (id.startsWith("external:")) void openExternalChat(id.slice(9)).catch(showWorkspaceError);
      else openChat(id);
    },
    getSections: () => {
      const pane = activePane();
      const outline = pane?.getOutline?.();
      if (!pane || !outline?.entries.length || pane.kind !== "artifact") return null;
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
    if (!singlePane)
      commands.push({
        id: "settings",
        label: "Settings",
        detail: "Agents & accounts · Appearance",
        run: openAgentSettings,
      });
    if (desk && !singlePane && dataAccess.getChats)
      commands.push({
        id: "new-chat",
        label: "New chat",
        run: () => void newChat().catch(chatFailed("Couldn't start a chat")),
      });
    if (desk && !singlePane)
      commands.push({
        id: "new-browser-tab",
        label: "New browser tab",
        detail: browserTabs ? "⌘T" : "Opens in your browser",
        run: () => newBrowserTab(),
      });
    if (pane && pane.kind === "artifact" && !readLock) {
      const mode = pane.getMode?.();
      if (mode === "edit") {
        if (/\.md$/i.test(pane.path))
          commands.push({ id: "insert-image", label: "Insert image", run: () => pane.insertImage?.() });
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

  /** Claims as the journal stream reports them (issue #155; before claims, the one apply lease per
   * workspace). Hydrated from `GET /w/:slug/claims` when a workspace opens and followed from
   * `claim_*` journal frames after that. An exclusive claim over a file pauses that file's Edit; a
   * legacy lease, or a claim with no recorded paths, covers the whole workspace and pauses every
   * pane, exactly as the lease did. Presence claims pause nothing and only show who is looking. */
  const liveClaims = new Map();
  let claimTimer = null;
  function covers(claim, path) {
    return claim.paths.length === 0 || (Boolean(path) && claim.paths.includes(path));
  }
  function claimsFor(path) {
    const now = Date.now();
    return [...liveClaims.values()]
      .filter((claim) => !(claim.expires_at && Date.parse(claim.expires_at) <= now) && covers(claim, path))
      .sort((a, b) => (a.mode === b.mode ? 0 : a.mode === "exclusive" ? -1 : 1));
  }
  function claimFor(path) {
    const exclusive = claimsFor(path).filter((claim) => claim.mode === "exclusive");
    return exclusive.at(-1) ?? null;
  }
  function clockOf(iso) {
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return "";
    return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  }
  /** "Claude Code · session 1a2b3c4d · editing since 14:02". The provider is named only when this
   * workspace's explicit binding proves it; otherwise "An agent session" — never a guess. */
  function holderName(claim) {
    return feedbackController?.providerNameFor(claim.holder_session) ?? "An agent session";
  }
  /** The short form for sentences: "Claude Code (session 1a2b3c4d)". */
  function holderWho(claim) {
    return `${holderName(claim)} (session ${String(claim.holder_session ?? "").slice(0, 8)})`;
  }
  function describeClaim(claim) {
    const who = holderName(claim);
    const doing = claim.mode === "presence" ? "looking at this" : "editing";
    const since = claim.since ? clockOf(claim.since) : "";
    return `${who} · session ${String(claim.holder_session ?? "").slice(0, 8)} · ${doing}${since ? ` since ${since}` : ""}`;
  }
  function refreshClaims() {
    const now = Date.now();
    for (const [id, claim] of liveClaims) {
      if (claim.expires_at && Date.parse(claim.expires_at) <= now) liveClaims.delete(id);
    }
    if (claimTimer) clearTimeout(claimTimer);
    claimTimer = null;
    const soonest = Math.min(
      ...[...liveClaims.values()].map((claim) => (claim.expires_at ? Date.parse(claim.expires_at) : Infinity)),
    );
    if (Number.isFinite(soonest)) claimTimer = setTimeout(refreshClaims, Math.max(0, soonest - now));
    for (const pane of panes.values()) applyClaimsTo(pane, pane.path);
    refreshTabs();
  }
  function applyClaimsTo(pane, path) {
    const pause = claimFor(path);
    pane.setApplyPause?.(pause ? { ...pause, label: describeClaim(pause), who: holderWho(pause) } : null);
    pane.setClaims?.(claimsFor(path).map((claim) => ({ resources: claim.resources, label: describeClaim(claim) })));
  }
  function claimRecord(id, detail, fallbackSession) {
    const strings = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === "string") : []);
    return {
      lease_id: id,
      expires_at: detail.expires_at ?? null,
      paths: strings(detail.paths),
      resources: strings(detail.resources),
      mode: detail.mode === "presence" ? "presence" : "exclusive",
      holder_session: typeof detail.session === "string" ? detail.session : fallbackSession,
      since: typeof detail.since === "string" ? detail.since : null,
    };
  }
  function trackClaims(frame) {
    const detail = frame?.detail ?? {};
    const id = typeof detail.claim_id === "string" ? detail.claim_id : detail.lease_id;
    if (frame?.event === "claim_taken" && id) {
      liveClaims.set(id, claimRecord(id, detail, ""));
    } else if (frame?.event === "apply_begin" && id) {
      liveClaims.set(id, {
        ...claimRecord(id, { ...detail, paths: [] }, detail.session ?? ""),
        since: frame.at ?? null,
        resources: frame.entry ? [`entry:${frame.entry}`] : [],
      });
    } else if (frame?.event === "claim_renewed" && liveClaims.has(id)) {
      liveClaims.set(id, { ...liveClaims.get(id), expires_at: detail.expires_at ?? null });
    } else if (["claim_released", "claim_expired", "apply_end", "apply_expired"].includes(frame?.event)) {
      // An end naming no claim cannot be matched to one; clearing is the side that cannot leave a
      // pane paused forever.
      if (id) liveClaims.delete(id);
      else liveClaims.clear();
    } else {
      return;
    }
    refreshClaims();
  }
  /** Who already holds what, when a workspace opens. Best effort: a daemon that predates the route
   * just leaves the badges to the next journal frame. */
  async function hydrateClaims() {
    const slug = currentSlug;
    let listed;
    try {
      listed = await dataAccess.getClaims?.(slug);
    } catch {
      return;
    }
    if (!listed || slug !== currentSlug) return;
    liveClaims.clear();
    for (const claim of listed.claims ?? []) {
      liveClaims.set(claim.claim_id, {
        lease_id: claim.claim_id,
        expires_at: claim.expires_at ?? null,
        paths: (claim.artifacts ?? []).map((resource) => String(resource).replace(/^artifact:/, "")),
        resources: claim.resources ?? [],
        mode: claim.mode === "presence" ? "presence" : "exclusive",
        holder_session: claim.holder_session,
        since: claim.since ?? null,
      });
    }
    refreshClaims();
  }

  /** With several artifacts open, the reader has to be able to tell at a glance which pane the
   * mode control, the shortcuts, and the address bar are all talking about. The active tab's
   * olive edge says it in the strip; this says it in the pane, by letting the others go quiet. */
  function markActivePane() {
    for (const row of chatsRows.querySelectorAll("[data-panel-id]"))
      row.setAttribute("aria-current", row.dataset.panelId === activePanelId ? "page" : "false");
    for (const [id, pane] of panes) {
      pane.element?.setAttribute("data-active", String(id === activePanelId));
      // Only the active pane offers questions about artifacts nobody has open, and the set of open
      // artifacts just changed or the focus just moved — either can change who should say it.
      pane.refreshNotice?.();
    }
  }

  function isArtifactPanel(id) {
    return decodePanelId(id)[0] === "artifact";
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
    return disambiguateLabels(
      openPanelIds()
        .filter((id) => ["artifact", "image", "read-only"].includes(decodePanelId(id)[0]))
        .map((id) => decodePanelId(id)[1]),
    );
  }

  function tabStateFor(id) {
    const pane = panes.get(id);
    if (!pane) return { label: id, tooltip: id };
    if (pane.kind === "image" || pane.kind === "read-only")
      return {
        kind: pane.kind,
        label: tabLabels().get(pane.path) ?? pane.title,
        tooltip: `${pane.path}${pane.kind === "read-only" ? ", read-only" : ""}`,
        missing: pane.isMissing(),
      };
    if (pane.kind === "browser")
      return {
        kind: "browser",
        label: pane.title,
        tooltip: pane.url || pane.title,
        loading: pane.loading,
        // A chat agent at work on the tab (brief C2), as a chat tab shows its own activity.
        activityLabel: pane.agentActivity,
      };
    if (pane.kind === "chat-log") return { kind: "chat-log", label: pane.title, tooltip: pane.title };
    if (["chat", "external-chat", "agent-settings"].includes(pane.kind))
      return {
        kind: pane.kind,
        provider: pane.provider,
        label: pane.title,
        tooltip: [pane.title, pane.attentionCount ? `${pane.attentionCount} awaiting reply` : pane.activityLabel]
          .filter(Boolean)
          .join(" · "),
        attentionCount: pane.attentionCount,
        activityLabel: pane.activityLabel,
      };
    if (!isArtifactPanel(id)) {
      const [, path, from, to] = splitDiffId(id);
      const filename = path.split("/").pop();
      return {
        kind: "diff",
        label: `${filename} · ${describeVersion(from)}…${describeVersion(to)}`,
        tooltip: `${path}: comparing ${describeVersion(from)} with ${describeVersion(to)}`,
      };
    }
    const path = decodePanelId(id)[1];
    const summary = knownArtifacts.get(path);
    // Issue #155: who is working on this file — the exclusive holder first, else whoever is looking.
    const holder = claimFor(path) ?? claimsFor(path)[0] ?? null;
    return {
      kind: "artifact",
      ...(holder ? { claim: { mode: holder.mode, label: describeClaim(holder) } } : {}),
      label: tabLabels().get(decodePanelId(id)[1]) ?? decodePanelId(id)[1].split("/").pop(),
      tooltip: path,
      artifactClass: pane.artifactClass() ?? summary?.class ?? "R",
      stale: pane.isStale() || Boolean(summary?.stale),
      unresolved: pane.annotationCount(),
      dirty: pane.isDirty(),
      missing: pane.isMissing(),
    };
  }

  function splitDiffId(id) {
    return decodePanelId(id);
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
    if (knownReadOnly.size > 0 && knownArtifacts.size + knownImages.size === 0) {
      wrap.append(el("p", { className: "glosa-empty-title", textContent: "Choose a file to read." }));
      return wrap;
    }
    if (knownArtifacts.size + knownImages.size === 0) {
      wrap.append(
        el("p", { className: "glosa-empty-title", textContent: "No documents yet." }),
        el("p", { className: "glosa-empty-hint", textContent: "Add a document to begin." }),
      );
      return wrap;
    }
    wrap.append(
      el("p", { className: "glosa-empty-title", textContent: "Choose a document to review." }),
      el("p", {
        className: "glosa-empty-hint",
        textContent:
          "Its rendered manuscript opens here: switch to Annotate and select any passage to comment on it. Drag a tab to a pane edge to read two artifacts side by side.",
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

  const paneTransfers = new Map();
  const retainedPanes = new Set();
  function createPane(id, params, host, panelApi, { restoring = false } = {}) {
    const transferred = paneTransfers.get(id);
    if (transferred) {
      paneTransfers.delete(id);
      host.append(transferred.element);
      transferred.rebindPanel(id, panelApi);
      panes.set(id, transferred);
      return transferred;
    }
    if (params.kind === "browser") {
      /** @type {any} */ let pane = null;
      let savedUrl = typeof params.url === "string" ? params.url : "";
      pane = createBrowserPane(host, {
        url: savedUrl,
        restored: restoring,
        openOutside,
        // The page's address rides in the panel's params, so the saved layout brings it back.
        onNavigate: ({ url }) => {
          if (!pane) return;
          if (url && url !== savedUrl && panelApi?.updateParameters) {
            savedUrl = url;
            panelApi.updateParameters({ url });
            dock?.saveLayout();
          }
          panelApi?.setTitle?.(pane.title);
        },
        onStateChange: () => {
          if (pane) refreshTabs();
        },
        // A click into the page never reaches this document, so the pane is chosen from here.
        onFocusPage: () => {
          if (activePanelId !== id) panelApi?.setActive?.();
        },
        closeTab: () => void dock?.requestClose(id),
        paneCommands: dock?.moveCommands() ?? [],
      });
      panes.set(id, pane);
      const visibility = panelApi?.onDidVisibilityChange?.((event) => {
        if (!event.isVisible) pane.hidden?.();
      });
      pane.releaseVisibility = () => visibility?.dispose?.();
      pane.element.setAttribute("data-active", String(id === activePanelId));
      panelApi?.setTitle?.(pane.title);
      return pane;
    }
    if (params.kind === "read-only") {
      const pane = createReadOnlyPane(host, {
        dataAccess,
        slug: currentSlug,
        path: params.path,
        onStateChange: refreshTabs,
      });
      panes.set(id, pane);
      return pane;
    }
    if (params.kind === "image") {
      const pane = createImagePane(host, {
        dataAccess,
        slug: currentSlug,
        path: params.path,
        onStateChange: refreshTabs,
      });
      pane.rebindPanel = () => {};
      panes.set(id, pane);
      void pane.ready.then(refreshTabs);
      return pane;
    }
    if (params.kind === "external-chat") {
      let disposed = false,
        unmount;
      const paneSlug = currentSlug;
      const paneSelection = workspaceSelectionGeneration;
      const paneIdentity = workspaceLayoutIdentity();
      const stale = () =>
        disposed || paneSelection !== workspaceSelectionGeneration || paneIdentity !== workspaceLayoutIdentity();
      const element = el("section", { className: "glosa-external-chat", "data-session-id": params.sessionId });
      host.append(element);
      const pane = {
        kind: "external-chat",
        title: `External · ${params.sessionId.slice(-8)}`,
        element,
        destroy() {
          disposed = true;
          unmount?.();
          element.remove();
        },
      };
      const load = async () => {
        element.replaceChildren(el("p", { role: "status", textContent: "Opening this terminal session…" }));
        try {
          if (!rememberedExternal.some((item) => item.sessionId === params.sessionId))
            await dataAccess.rememberExternalChat(paneSlug, params.sessionId);
          if (stale()) return;
          const mount = await loadConversationPane();
          if (stale()) return;
          element.replaceChildren();
          unmount = mount(element, {
            dataAccess,
            slug: paneSlug,
            sessionId: params.sessionId,
            embedded: true,
            dictationController,
          });
        } catch (error) {
          if (stale()) return;
          element.replaceChildren(
            el("p", { role: "alert", textContent: `Couldn't open this session: ${error.message}` }),
            el("button", { type: "button", textContent: "Retry", onClick: () => void load() }),
          );
        }
      };
      void load();
      panes.set(id, pane);
      return pane;
    }
    if (params.kind === "agent-settings") {
      const pane = mountAgentSettings(host, {
        dataAccess,
        appearance,
        textSize,
        openOutside,
        onChange: () => void refreshChats().catch(() => {}),
      });
      if (params.section === "dictation") pane.showDictation();
      panes.set(id, pane);
      return pane;
    }
    if (params.kind === "chat-log") {
      const pane = createChatLogPane(host, {
        dataAccess,
        slug: currentSlug,
        chatId: params.chatId,
        title: chatList.find((chat) => chat.id === params.chatId)?.title ?? "Chat",
      });
      panes.set(id, pane);
      return pane;
    }
    if (params.kind === "chat") {
      const pane = createChatPane(host, {
        dataAccess,
        slug: currentSlug,
        chatId: params.chatId,
        getFiles: () => [...knownArtifacts.keys()],
        sourceChatId: params.sourceChatId,
        onDeleted: () => {
          const panel = dock?.api.getPanel(chatPanelId(params.chatId));
          if (panel) dock.api.removePanel(panel);
          scheduleChatsRefresh();
        },
        onSettings: openAgentSettings,
        onOpenLog: () => openChatLog(params.chatId),
        onNewChat: (profile, settings) =>
          newChat(profile, settings, params.chatId).catch(chatFailed("Couldn't start a chat")),
        onChange: () => {
          refreshTabs();
          scheduleChatsRefresh();
        },
      });
      panes.set(id, pane);
      return pane;
    }
    if (!isArtifactPanel(id)) {
      const [, path, from, to] = splitDiffId(id);
      const pane = createDiffPane(host, { dataAccess, slug: currentSlug, path, from, to, describeVersion });
      pane.kind = "diff";
      panes.set(id, pane);
      applyClaimsTo(pane, path);
      return pane;
    }
    const pane = createArtifactPane(host, {
      dataAccess,
      slug: currentSlug,
      path: params.path ?? decodePanelId(id)[1],
      initialMode: params.mode ?? requestedMode,
      readLock,
      loadHistoryPane,
      loadRichEditor,
      getAttentionEntries: () => attentionEntries,
      getProviderName: () => feedbackController.providerName() ?? "An agent session",
      refreshAttention: () => attentionTray.refresh(),
      isArtifactOpen: (artifactPath) => panes.has(artifactPanelId(artifactPath)),
      goToRequestElsewhere: (request) => goToRequestIn(request),
      openArtifactInThisPane: (nextPath) => replacePanel(id, nextPath),
      // A presented single document has no tab strip, so its pane carries the whole identity.
      getTabLabel: () =>
        singlePane ? null : (tabLabels().get(decodePanelId(id)[1]) ?? decodePanelId(id)[1].split("/").pop()),
      styleStore,
      textSizeStore: textSize,
      dictationController,
      onMarksUnavailable,
      // The shell reveals the document the window's route names, and the route follows the active
      // pane (reflectFocus). So a pane's own "Reveal in Finder" makes that pane active first, then
      // yields a turn so the address bar has caught up before the shell reads it (#160).
      revealInFinder: desktopShell?.revealInFinder
        ? async () => {
            if (activePanelId !== id) panelApi?.setActive?.();
            await new Promise((resolve) => setTimeout(resolve, 0));
            return desktopShell.revealInFinder?.();
          }
        : null,
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
    pane.kind = "artifact";
    pane.rebindPanel = (nextId, nextApi) => {
      id = nextId;
      panelApi = nextApi;
      const visibility = panelApi?.onDidVisibilityChange?.((event) => {
        if (!event.isVisible) pane.hidden?.();
      });
      pane.releaseVisibility = () => visibility?.dispose?.();
      persistedModes.set(id, pane.getMode());
    };
    panes.set(id, pane);
    // A tab that is left, by any means, tells its pane, which closes its More menu.
    const visibility = panelApi?.onDidVisibilityChange?.((event) => {
      if (!event.isVisible) pane.hidden?.();
    });
    pane.releaseVisibility = () => visibility?.dispose?.();
    // Seeded from what this panel was restored (or opened) with, so restoring a layout does not
    // immediately write the same arrangement back over itself.
    persistedModes.set(id, pane.getMode?.() ?? params.mode ?? requestedMode);
    applyClaimsTo(pane, pane.path);
    pane.element.setAttribute("data-active", String(id === activePanelId));
    void pane.ready.then(() => {
      refreshTabs();
      panelApi?.setTitle?.(tabStateFor(id).label ?? id);
      if (id === activePanelId) reflectFocus();
    });
    return pane;
  }

  function destroyPane(id, pane) {
    pane?.releaseVisibility?.();
    if (!retainedPanes.has(pane)) pane?.destroy?.();
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
    await openArtifact(nextPath, { mode: "edit", group, history: "replace" });
    return true;
  }

  // ---------- opening ----------

  /**
   * §5: a tab's identity is its artifact path, and dockview enforces panel-id uniqueness, so
   * "one tab per file, no duplicates" needs no bookkeeping of its own. Opening a file that is
   * already visible focuses the pane that holds it; it never copies the file into another one.
   */
  function openImage(path, group, kind = "image") {
    if (!dock) return false;
    const id = JSON.stringify([kind, path]);
    const existing = dock.api.getPanel(id);
    if (existing) {
      existing.api.setActive();
      return true;
    }
    closeSinglePane();
    dock.api.addPanel({
      id,
      component: "pane",
      tabComponent: "pane",
      title: path.split("/").pop(),
      params: { kind, path },
      renderer: "always",
      minimumWidth: MIN_PANE_WIDTH,
      ...(group ? { position: { referenceGroup: group } } : {}),
    });
    markActivePane();
    markNavigatorOpenSet();
    return true;
  }

  /** A presented document holds one pane, so before another opens every open pane must agree to
   * close; a draft is never dropped by opening the next document. */
  async function makeRoomFor(panelId) {
    if (!dock || dock.api.getPanel(panelId)) return "ready";
    const current = dock;
    for (const pane of [...panes.values()]) {
      if (!(await (pane.confirmClose?.() ?? true))) return "declined";
      if (unmounted || dock !== current) return "failed";
    }
    return "ready";
  }

  /** Opening a document is the one focus change a person asks for, so by default it adds a history
   * entry (#455): Back returns to the document it replaced. Restoring and replacing a pane pass
   * `history: "replace"`. */
  async function openArtifact(path, options = {}) {
    return (await openArtifactOutcome(path, options)) === "opened";
  }

  async function openArtifactOutcome(path, { mode, group, history = "push" } = {}) {
    if (!path || !currentSlug) return "failed";
    const kind = knownImages.has(path) ? "image" : knownReadOnly.has(path) ? "read-only" : "artifact";
    const panelId = kind === "artifact" ? artifactPanelId(path) : JSON.stringify([kind, path]);
    if (singlePane) {
      const room = await makeRoomFor(panelId);
      if (room !== "ready") return room;
      if (unmounted) return "failed";
    }
    const previous = focusedPath();
    switchingTo = path;
    historyIntent = history === "push" && path !== previous ? "push" : "replace";
    try {
      const opened = kind === "artifact" ? addArtifactPanel(path, { mode, group }) : openImage(path, group, kind);
      return opened ? "opened" : "failed";
    } finally {
      switchingTo = null;
      historyIntent = "replace";
    }
  }

  function addArtifactPanel(path, { mode, group }) {
    if (mode) requestedMode = mode;
    const existing = dock?.api.getPanel(artifactPanelId(path));
    if (existing) {
      existing.api.setActive();
      const pane = panes.get(artifactPanelId(path));
      if (mode && pane) pane.setMode(mode);
      return true;
    }
    if (!dock) return false;
    closeSinglePane();
    dock.api.addPanel({
      id: artifactPanelId(path),
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

  function closeSinglePane() {
    if (!singlePane || !dock) return;
    for (const openId of [...panes.keys()]) dock.api.getPanel(openId)?.api.close();
  }

  function openDiff({ path, from, to }) {
    if (!dock || singlePane) return false;
    const id = diffPanelId(path, from, to);
    const existing = dock.api.getPanel(id);
    if (existing) {
      existing.api.setActive();
      return true;
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
    return true;
  }

  /** The navigator marks every OPEN artifact quietly and the active pane's artifact as current,
   * so the tree says what is already on screen instead of only where you last clicked. */
  function markNavigatorOpenSet() {
    artifactNavigator.setOpenPaths?.(
      openPanelIds()
        .filter((id) => ["artifact", "image", "read-only"].includes(decodePanelId(id)[0]))
        .map((id) => decodePanelId(id)[1]),
    );
    artifactNavigator.setCurrent(
      activePanelId && ["artifact", "image", "read-only"].includes(decodePanelId(activePanelId)[0])
        ? decodePanelId(activePanelId)[1]
        : null,
      {
        reveal: false,
      },
    );
  }

  /** The workspace file the active pane shows: a document, an image or a read-only file. */
  function focusedPath() {
    if (!activePanelId) return null;
    const [kind, path] = decodePanelId(activePanelId);
    return ["artifact", "image", "read-only"].includes(kind) ? path : null;
  }

  function reflectFocus() {
    const pane = activePane();
    const artifact = focusedPath();
    // Mid-switch, the dock can report the pane being closed or nothing at all before the new one
    // is active. Reflecting that would overwrite the entry Back must return to.
    if (switchingTo !== null && artifact !== switchingTo) return;
    const history = historyIntent;
    historyIntent = "replace";
    // §10: the URL keeps describing ONE focused file — the active pane — which preserves the
    // `glosa open <file>` deep-link contract and keeps a shared URL short and legible. The
    // arrangement itself is never serialized into the address bar.
    onFocusChange?.({
      slug: currentSlug,
      artifact,
      mode: pane?.getMode?.() ?? requestedMode,
      history,
    });
    document.title = documentTitle();
  }

  /** What a person reads in the tab or window title: the file, then the folder it lives in, the
   *  way an editor's title bar reads. Never the slug: that is the registration's identity for URLs
   *  and the CLI, not a name anyone chose. */
  function documentTitle() {
    const pane = activePane();
    const folder = currentSlug
      ? folderName(workspaces.find((entry) => entry.slug === currentSlug)?.path, currentSlug)
      : null;
    if (!pane) return folder ?? "glosa";
    const name = pane.title ?? pane.path?.split("/").pop() ?? "glosa";
    return surface === "document" || !folder ? name : `${name} · ${folder}`;
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
    // ⌘T: a new browser tab (#440). A plain browser keeps ⌘T for itself; there Go to offers it.
    if (!e.altKey && !e.shiftKey && (e.key === "t" || e.key === "T") && desk && !singlePane) {
      e.preventDefault();
      newBrowserTab();
      return;
    }
    // ⌘L: the active browser tab's address, as in every browser.
    if (!e.altKey && !e.shiftKey && (e.key === "l" || e.key === "L") && activePane()?.kind === "browser") {
      e.preventDefault();
      activePane().focusAddress();
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
    elements: { shortcutsEl, shortcutsToggle },
    getState: () => ({ slug: currentSlug, mode: activePane()?.getMode?.() ?? "read" }),
    createElement: el,
    returnFocus: () => toolsTrigger.focus({ preventScroll: true }),
    dictationController,
  });

  const fileViewControls = createFileViewControls(artifactList, {
    change: async (view) => {
      const slug = currentSlug;
      await dataAccess.setFileView(slug, view);
      if (slug === currentSlug) await refreshReadOnlyFiles();
    },
    retry: () => void refreshReadOnlyFiles(),
  });
  const imageImportStatus = el("p", { className: "glosa-image-import-status", hidden: true, role: "status" });
  const within = (path, parent) => !parent || path === parent || path.startsWith(`${parent}/`);
  async function renameOpenPanes(from, to) {
    if (!from || !to || from === to) return;
    styleStore.rename(currentSlug, from, to);
    const active = activePanelId;
    let nextActive = active;
    for (const [id, pane] of [...panes]) {
      const decoded = decodePanelId(id);
      if (!["artifact", "image", "read-only", "diff"].includes(decoded[0]) || !within(decoded[1], from)) continue;
      const nextPath = to + decoded[1].slice(from.length),
        nextId = JSON.stringify([decoded[0], nextPath, ...decoded.slice(2)]);
      const panel = dock?.api.getPanel(id);
      if (!panel || dock.api.getPanel(nextId)) continue;
      await pane.pauseFileOperation?.();
      const group = panel.api.group,
        index = group.panels.indexOf(panel);
      if (id === active) nextActive = nextId;
      if (pane.retarget) {
        pane.retarget(nextPath);
        retainedPanes.add(pane);
        paneTransfers.set(nextId, pane);
      }
      // Insert next to the old panel first: removing the last panel must not destroy its group.
      dock.api.addPanel({
        id: nextId,
        component: "pane",
        tabComponent: "pane",
        title: nextPath.split("/").pop(),
        params: { ...panel.params, kind: decoded[0], path: nextPath },
        renderer: "always",
        minimumWidth: MIN_PANE_WIDTH,
        position: { referencePanel: id, direction: "within", index },
      });
      dock.api.removePanel(panel);
      retainedPanes.delete(pane);
      pane.resumeFileOperation?.();
    }
    if (nextActive) dock?.api.getPanel(nextActive)?.api.setActive();
    markNavigatorOpenSet();
    dock?.saveLayout();
  }
  const fileActions = createFileActions({
    tree: artifactList,
    navigator: artifactNavigator,
    dataAccess,
    enabled: desk && !singlePane && !readLock,
    getSlug: () => currentSlug,
    open: openArtifact,
    dirty: (path) => [...panes.values()].some((pane) => pane.path && within(pane.path, path) && pane.isDirty?.()),
    prepare: async (path) => {
      const affected = [...panes.values()].filter((pane) => pane.path && within(pane.path, path));
      await Promise.all(affected.map((pane) => pane.pauseFileOperation?.()));
      return () => {
        for (const pane of affected) pane.resumeFileOperation?.();
      };
    },
    changed: async (action, body, result) => {
      const rename =
        action === "rename"
          ? { from: body.from, to: body.to }
          : result.undone?.op === "rename"
            ? { from: result.undone.to, to: result.undone.path }
            : null;
      if (rename) await renameOpenPanes(rename.from, rename.to);
      if (action === "trash")
        for (const [id, pane] of [...panes]) {
          if (!pane.path || !within(pane.path, body.path)) continue;
          if (pane.isDirty?.()) pane.markMissing?.();
          else {
            const panel = dock?.api.getPanel(id);
            if (panel) dock.api.removePanel(panel);
          }
        }
      if (action === "restore")
        for (const pane of panes.values())
          if (pane.path && within(pane.path, body.destination_path ?? body.path)) pane.putBack?.();
      if (action === "undo")
        for (const pane of panes.values())
          if (pane.path && within(pane.path, result.undone?.path ?? body.path)) pane.putBack?.();
      await refreshArtifactList();
    },
  });
  artifactList.after(imageImportStatus);
  artifactList.addEventListener("dragover", (event) => {
    if (!event.dataTransfer?.types.includes("Files") || readLock) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  });
  artifactList.addEventListener("drop", (event) => {
    const files = droppedImages(event);
    if (!files.length || readLock || !currentSlug) return;
    event.preventDefault();
    const item = event.target.closest('[role="treeitem"]');
    const nodeId = item?.getAttribute("data-node-id");
    const targetPath = nodeId?.slice(2) ?? "";
    const directory =
      item?.getAttribute("data-kind") === "directory"
        ? targetPath
        : targetPath.includes("/")
          ? targetPath.slice(0, targetPath.lastIndexOf("/"))
          : "";
    const targetSlug = currentSlug;
    void (async () => {
      for (const file of files) {
        imageImportStatus.hidden = false;
        imageImportStatus.textContent = `Adding ${file.name}…`;
        try {
          await dataAccess.importImage(targetSlug, file, { directory_path: directory });
          imageImportStatus.textContent = `Added ${file.name}.`;
        } catch (error) {
          imageImportStatus.textContent = `${file.name}: ${error.message}`;
        }
      }
      if (targetSlug === currentSlug) await refreshArtifactList();
    })();
  });

  // ---------- workspace data ----------

  function supportsReadOnly() {
    return desk && !singlePane && currentWorkspace()?.kind === "directory" && !!dataAccess.getReadOnlyFiles;
  }
  function paintFileTree() {
    const files = [
      ...knownArtifacts.values(),
      ...knownImages.values(),
      ...(fileView.mode === "all" ? knownReadOnly.values() : []),
    ];
    artifactListEmpty.hidden = files.length > 0;
    artifactNavigator.setArtifacts(files, fileView.mode === "documents" ? [] : knownDirectories);
    markNavigatorOpenSet();
    refreshTabs();
  }
  async function refreshReadOnlyFiles() {
    const slug = currentSlug,
      ticket = ++readOnlyGeneration;
    const heading = root.querySelector(".glosa-artifact-list-toggle");
    if (!supportsReadOnly()) {
      knownReadOnly.clear();
      fileViewControls.update(null, {});
      return;
    }
    try {
      const view = await dataAccess.getFileView(slug);
      const listing = await dataAccess.getReadOnlyFiles(slug);
      if (slug !== currentSlug || ticket !== readOnlyGeneration || unmounted) return;
      fileView = view;
      knownReadOnly = new Map(listing.files.map((file) => [file.path, file]));
      fileViewControls.update(view, listing);
      // Preserve the section toggle's disclosure glyph.
      const label = heading?.querySelector(".glosa-sidebar-section-label");
      if (label) label.textContent = "Files";
      artifactListEmpty.textContent =
        view.mode === "documents" ? "No documents or images in this folder." : "No files match this view.";
      paintFileTree();
      for (const pane of panes.values()) void pane.refreshReadOnly?.();
    } catch (error) {
      if (slug !== currentSlug || ticket !== readOnlyGeneration || unmounted) return;
      if (error.status === 404) {
        knownReadOnly.clear();
        fileViewControls.update(null, {});
        paintFileTree();
      } else fileViewControls.fail(`Could not refresh files: ${error.message}`);
    }
  }
  async function refreshArtifactList() {
    const slug = currentSlug;
    const imageRequest = dataAccess.getImages?.(slug);
    const artifacts = await dataAccess.getArtifacts(slug);
    const assets = imageRequest ? await imageRequest : { images: [], directories: [] };
    if (slug !== currentSlug) return artifacts;
    knownImages = new Map(assets.images.map((image) => [image.path, image]));
    knownArtifacts = new Map(artifacts.map((artifact) => [artifact.path, artifact]));
    knownDirectories = assets.directories ?? [];
    if (supportsReadOnly()) await refreshReadOnlyFiles();
    else fileViewControls.update(null, {});
    if (slug !== currentSlug) return artifacts;
    paintFileTree();
    return artifacts;
  }

  /** §11: a tab whose artifact was deleted dims and says the file is gone. glosa never closes a
   * tab the reader opened — that silently destroys the layout they built. */
  async function refreshArtifactIndex() {
    await refreshArtifactList();
    if (fileActions.busy) return;
    for (const [id, pane] of panes) {
      if (!isArtifactPanel(id)) continue;
      if (!knownArtifacts.has(pane.path)) pane.markMissing();
      else void pane.refreshAnnotationsFor?.();
    }
    refreshTabs();
  }

  function refreshOpenArtifact(path) {
    const pane = panes.get(artifactPanelId(path));
    if (pane) void pane.refreshArtifact?.();
    for (const [id, diffPane] of panes) {
      if (diffPane !== pane) void diffPane.refreshAnnotationsFor?.(path);
      if (decodePanelId(id)[0] === "diff" && splitDiffId(id)[1] === path) void diffPane.refreshArtifact();
    }
  }

  const feedbackController = createViewerFeedbackController({
    dataAccess,
    view: {
      setState(state) {
        agentFeedback.setState(state);
        // A claim's holder is named from this same connection data, so its badges are
        // re-described whenever the data changes rather than waiting for the next claim frame.
        if (liveClaims.size > 0) refreshClaims();
      },
    },
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
        scheduleChatsRefresh();
        // A folder default set elsewhere while the stream was down sent its frame to nobody.
        void styleStore.loadFolder(currentSlug);
        void hydrateClaims();
        void refreshArtifactList();
        for (const pane of panes.values()) {
          void pane.refreshArtifact?.();
          void pane.refreshImages?.();
        }
        void attentionTray.refresh();
        void refreshAgentFeedback();
        attentionWatch?.resync();
      },
      onEvent: (frame) => {
        attentionWatch?.handleFrame(frame);
        if (frame.event === "artifact" && frame.data?.path)
          fileActions.defer(() => refreshOpenArtifact(frame.data.path));
        if (frame.event === "read_only_files" || frame.event === "file_view") void refreshReadOnlyFiles();
        if (frame.event === "image") {
          void refreshArtifactList();
          for (const pane of panes.values()) void pane.refreshImages?.();
        }
        if (frame.event === "artifact_index") void refreshArtifactIndex();
        if (frame.event === "journal") {
          if (frame.data?.event === "paths_renamed")
            fileActions.defer(async () => {
              await renameOpenPanes(frame.data.detail?.from, frame.data.detail?.to);
              await refreshArtifactList();
            });
          trackClaims(frame.data);
          for (const pane of panes.values()) {
            if (pane.applyJournalEvent?.(frame.data)) break;
          }
        }
        if (frame.event === "journal" || frame.event === "metadata") void attentionTray.refresh();
        if (frame.event === "metadata") {
          void refreshArtifactList();
          for (const pane of panes.values()) void pane.refreshArtifact?.();
        }
        // Another window set or cleared this folder's default style (A1 §5.23): read it again, and
        // every document here that follows the folder takes it without a reload.
        if (frame.event === "folder_style") void styleStore.loadFolder(currentSlug);
        // Any existing workspace-stream activity may coincide with a bind/heartbeat. No new SSE
        // event is needed: refresh the aggregate through the same bounded status read.
        void refreshAgentFeedback();
      },
    });
  }

  function workspaceLayoutIdentity() {
    const workspace = workspaces.find((entry) => entry.slug === currentSlug);
    return workspace?.registration_id && workspace?.registration_epoch
      ? `${workspace.registration_id}:${workspace.registration_epoch}`
      : null;
  }

  function mountDock() {
    dock?.destroy();
    for (const pane of panes.values()) pane.destroy?.();
    panes.clear();
    activePanelId = null;
    dockHost.textContent = "";
    dock = createDock(dockHost, {
      slug: currentSlug,
      workspaceIdentity: workspaceLayoutIdentity(),
      appearance,
      storage: singlePane ? null : layoutStorage,
      createPane,
      destroyPane,
      getTabState: tabStateFor,
      emptyState: paneEmptyState,
      createHeaderTools: desk && !singlePane ? stripTools : null,
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
    const selection = ++workspaceSelectionGeneration;
    const stale = () => unmounted || selection !== workspaceSelectionGeneration;
    palette.close();
    stopChatsStream?.();
    clearTimeout(chatsRefreshTimer);
    chatsRefreshGeneration++;
    currentSlug = slug;
    // The Dock badge is this window's own workspace: a move to another is a new count.
    attentionWatch?.refresh();
    readOnlyGeneration++;
    knownReadOnly.clear();
    const fileHeading = root.querySelector(".glosa-artifact-list-toggle .glosa-sidebar-section-label");
    if (fileHeading) fileHeading.textContent = "Documents";
    fileViewControls.update(null, {});
    imageImportStatus.hidden = true;
    imageImportStatus.textContent = "";
    chatList = [];
    externalSessions = [];
    rememberedExternal = [];
    chatNotice.textContent = "";
    renderChats();
    stopChatsStream = singlePane ? undefined : dataAccess.openChatsStream?.(slug, { onEvent: scheduleChatsRefresh });
    stopBrowserRequests?.();
    stopBrowserRequests = browserTabs
      ? dataAccess.openBrowserRequests?.(slug, { onRequest: (request) => void handleBrowserRequest(slug, request) })
      : undefined;
    refreshTopbarTitle();
    attentionTray.setWorkspace(slug);
    artifactNavigator.setWorkspace(slug);
    void fileActions.setWorkspace();
    writeStored(layoutStorage ?? defaultStorage(), LAST_WORKSPACE_STORAGE_KEY, slug);
    renderStars();
    renderStarToggle();
    feedbackController.selectWorkspace();
    // The folder's default style is read before any pane mounts, so a document that follows it is
    // set in it from its first paint rather than repainted once the answer arrives.
    await Promise.all([refreshArtifactList(), styleStore.loadFolder(slug)]);
    if (stale()) return;
    await refreshChats().catch(chatFailed("Couldn't load chats"));
    if (stale()) return;
    mountDock();
    // The dock was just emptied, so the bar must stop naming the previous workspace's document.
    refreshTopbarTitle();
    startStream();
    void hydrateClaims();

    // §10: the arrangement is restored per workspace, defensively. A panel whose artifact no
    // longer exists is dropped; if restore throws for ANY reason the workspace still opens with
    // one pane. A corrupt saved layout must never make a workspace unopenable.
    const restored =
      !singlePane &&
      dock.restoreLayout(
        (_id, params) =>
          params.kind === "agent-settings" ||
          (params.kind === "browser" && browserTabs) ||
          (params.kind === "image" && knownImages.has(params.path)) ||
          (params.kind === "read-only" && supportsReadOnly() && typeof params.path === "string") ||
          (params.kind === "external-chat" &&
            externalSessions.some((session) => session.session_id === params.sessionId)) ||
          (params.kind === "chat" && chatList.some((chat) => chat.id === params.chatId)) ||
          (params.kind === "chat-log" && chatList.some((chat) => chat.id === params.chatId)) ||
          ((params.kind === "diff" || params.kind === "artifact") && knownArtifacts.has(params.path)),
      );

    // CLI deep-link (`glosa open <file>`): the first workspace selection focuses the named
    // artifact, once — after that, navigation is the user's.
    if (initialArtifact) {
      const focus = initialArtifact;
      initialArtifact = undefined;
      await openArtifact(focus, { mode: requestedMode, history: "replace" });
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
    return desk && starsSupported && !singlePane && currentWorkspace()?.kind === "directory";
  }

  function renderStarToggle() {
    const workspace = currentWorkspace();
    starToggle.hidden = !canStarCurrent();
    if (starToggle.hidden || !workspace) return;
    const starred = Boolean(currentStar());
    const name = folderName(workspace.path, workspace.slug);
    starToggle.setAttribute("aria-pressed", String(starred));
    // One name, spoken and shown: the tooltip and the accessible name say the same thing.
    const starName = starred ? `Unstar ${name}` : `Star ${name}`;
    starToggle.setAttribute("aria-label", starName);
    starToggle.title = starName;
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
    // The count is painted for the folded section; spoken, "Starred0" is not a name. The toggle
    // carries the number in words instead.
    starredToggle.setAttribute("aria-label", stars.length ? `Starred, ${stars.length}` : "Starred");
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
    attentionWatch?.refresh();
    if (singlePane || unmounted) return;
    void loadWorkspaces()
      .then(() => refreshStars())
      .catch(() => {});
  };
  window.addEventListener("focus", onWindowFocus);
  attentionWatch?.start();

  void refreshWorkspaces().catch(showWorkspaceError);

  const unmount = () => {
    unmounted = true;
    attentionWatch?.destroy();
    clearTimeout(chatsRefreshTimer);
    stopChatsStream?.();
    stopBrowserRequests?.();
    document.removeEventListener("keydown", onShortcut);
    document.removeEventListener("click", onDocumentClick);
    root.removeEventListener("click", onLinkActivate);
    root.removeEventListener("auxclick", onLinkActivate);
    stopBrowserEvents?.();
    window.removeEventListener("focus", onWindowFocus);
    sidebarNav.destroy();
    fileActions.destroy();
    fileViewControls.destroy();
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
  // Back and Forward to another document in this view (#455): shown in place, replacing the entry
  // the browser moved to rather than adding one. "unhandled" hands the address to a reload.
  unmount.followRoute = async ({ artifact, mode } = {}) => {
    if (unmounted || !dock || !currentSlug || !artifact) return "unhandled";
    const outcome = await openArtifactOutcome(artifact, {
      mode: MODES.includes(mode) ? mode : undefined,
      history: "replace",
    });
    if (outcome === "opened") return "handled";
    return outcome === "declined" ? "declined" : "unhandled";
  };
  return unmount;
}

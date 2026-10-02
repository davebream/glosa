// SPDX-License-Identifier: Apache-2.0

import { createComposerPicker } from "./composer-picker.js";
import { mountAgentLogin } from "./agent-login.js";
import { mountMcpSettings } from "./agent-mcp-settings.js";
import {
  actionMenu,
  agentIcon,
  agentName,
  effortIcon,
  effortLadder,
  effortPresentation,
  modelPicker,
} from "./agent-ui.js";
import { chatQueue, elapsedLabel, turnActivity } from "./chat-activity.js";
import { loadChatMarkdown } from "./chat-markdown.js";
import { confirmDialog, noticeDialog } from "./dialog.js";
import { createElement as el } from "./viewer-shell.js";

/** Pure stream projection. Durable snapshots restore prompt/blob content; delta frames never start work. */
export function applyChatEvent(state, record) {
  if (!state || record.seq <= state.revision) return state;
  if (record.seq !== state.revision + 1) return null;
  const event = record.data;
  state.revision = record.seq;
  if (event.type === "content") {
    const prior = state.content.find((c) => c.id === event.content.id && c.turnId === event.content.turnId);
    if (prior && event.content.kind !== "tool") {
      const combined = prior.text + event.content.text;
      prior.text = combined.slice(0, 131072);
      prior.truncated ||= combined.length > 131072;
    } else if (prior) Object.assign(prior, event.content);
    else if (!state.page?.hasLater) state.content.push({ ...event.content });
  } else if (event.type === "decision") state.decisions.push(event.decision);
  else if (event.type === "decision_status") {
    const value = state.decisions.find((d) => d.id === event.id);
    if (value) value.status = event.status;
  } else if (event.type === "turn_status") {
    const value = state.turns.find((t) => t.id === event.turnId);
    if (value) {
      value.status = event.status;
      value.error = event.error;
    }
  } else if (event.type === "effective_settings") {
    const turn = state.turns.find((t) => t.id === event.turnId);
    if (turn) turn.effective = { model: event.model, effort: event.effort };
  } else if (event.type === "usage") state.usage = { ...state.usage, ...event.value };
  else if (event.type === "runtime") state.runtime = event;
  else return null; // Blob references, draft conflicts and settings require an authoritative snapshot.
  return state;
}

/** A step's state, drawn: done, failed, stopped before it finished. A running step pulses (app.css). */
/** How many messages may wait in a chat; the daemon holds the same line (A5). */
const MAX_WAITING = 5;
const STEP_MARKS = {
  completed: '<svg viewBox="0 0 12 12"><path d="M2.5 6.4l2.3 2.3 4.7-5.2"/></svg>',
  failed: '<svg viewBox="0 0 12 12"><path d="M3 3l6 6M9 3l-6 6"/></svg>',
  stopped: '<svg viewBox="0 0 12 12"><path d="M3 6h6"/></svg>',
};

export function createChatPane(
  host,
  {
    dataAccess,
    slug,
    chatId,
    sourceChatId = /** @type {string | undefined} */ (undefined),
    onChange,
    onNewChat,
    onSettings,
    onDeleted = () => {},
    getFiles = () => [],
  },
) {
  let state,
    catalog,
    disposed = false,
    dirty = false,
    timer,
    saving = Promise.resolve(),
    pending = false,
    readyToSend = false;
  let attachments = [],
    lastDraft = "",
    baseDraftRevision = 0,
    stopStream;
  let renderMarkdown,
    feedbackIntent,
    pageBefore,
    wantedRows = new Set(),
    paging = false,
    nativeLogin,
    lastContentSignature = "",
    accountGeneration = 0,
    changingAccount = false,
    changingSettings = false,
    liveTimer = 0,
    effortSaving = false,
    effortTarget = null,
    uploading = false,
    stopping = false,
    stopTarget = null;
  // Messages the person has sent that the daemon has not yet taken, oldest first. The composer is
  // theirs again the moment they press Enter; each entry is posted in turn behind the scenes.
  const outbox = [];
  // Messages stopped before they reached the agent that should stay in the thread to be reused.
  const keptCancelled = new Set();
  const lifetime = new AbortController();
  const executionAvailable = () =>
    catalog?.providers?.find((provider) => provider.id === state?.provider)?.available ?? catalog?.available;
  // A reply's table keeps its words whole unless one is too long for any column; then its cells
  // break words so it fits the reply's column, as a document's tables do (`fitTables` in
  // artifact-pane.js, DESIGN.md's Cell Break Rule). A reply is marked again whenever it renders or
  // changes size: the pane resized, a text size step, the faces arriving.
  const tableFit =
    typeof ResizeObserver === "function"
      ? new ResizeObserver((entries) => {
          for (const entry of entries) fitTables(entry.target);
        })
      : null;
  // What each step acted on, remembered from its start, and each turn's status at the last render.
  const stepSubjects = new Map(),
    turnStatuses = new Map();
  const rows = new Map(),
    trayRows = new Map(),
    decisionRows = new Map(),
    decisionIntents = new Map(),
    dialogs = new Set();
  const root = el("section", { className: "glosa-chat-pane" });
  const status = el("p", { className: "glosa-chat-status", role: "status" });
  const title = el("input", { className: "glosa-chat-title", "aria-label": "Chat title", maxLength: 120 });
  const controls = el("div", { className: "glosa-chat-controls" });
  const identity = el("div", { className: "glosa-chat-identity" });
  const activity = el("span", { className: "glosa-chat-activity", role: "status" });
  const menu = actionMenu("Chat actions");
  const transfer = el("div", { className: "glosa-chat-transfer", hidden: !sourceChatId });
  const empty = el("div", { className: "glosa-chat-empty" }, [
    el("h2", { textContent: "What would you like to work on?" }),
    el("p", { textContent: "Ask a question, work on a document, or give your agent a task in this workspace." }),
  ]);
  const readiness = el("div", { className: "glosa-chat-readiness", hidden: true });
  const readinessText = el("span");
  const loadModels = el("button", {
    type: "button",
    textContent: "Load models",
    onClick: () =>
      void act(async () => {
        loadModels.disabled = true;
        status.textContent = "Loading this account’s models…";
        try {
          await dataAccess.discoverAgentModels(state.profileId);
          catalog = await dataAccess.getAgentStatus();
          status.textContent = "Models refreshed.";
        } finally {
          loadModels.disabled = false;
        }
      }),
  });
  const manageAccount = el("button", { type: "button", textContent: "Manage account", onClick: onSettings });
  readiness.append(readinessText, loadModels, manageAccount);
  const picker = modelPicker({
    onModel: (id) => changeSettings(id),
    onProfile: (id) => changeAccount(id),
    onSettings,
  });
  // Effort is a short ladder, so the control steps rather than opens: each press climbs one level
  // and the top wraps to the bottom. The label holds the width of the longest level, which keeps
  // the button still under the pointer through a run of presses.
  const effortMark = effortIcon("");
  const effortLabel = el("span", { className: "glosa-chat-effort-label" });
  const effortTip = el("span", {
    className: "glosa-control-tooltip",
    role: "tooltip",
    id: `effort-tip-${crypto.randomUUID()}`,
  });
  const effort = el(
    "button",
    {
      type: "button",
      className: "glosa-chat-effort",
      "aria-describedby": effortTip.id,
      onClick: () => void stepEffort(1),
    },
    [el("span", { className: "glosa-visually-hidden", textContent: "Effort" }), effortMark, effortLabel],
  );
  effort.addEventListener("keydown", (event) => {
    const step = { ArrowUp: 1, ArrowDown: -1 }[event.key];
    if (!step || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    void stepEffort(step);
  });
  const effortAnnounce = el("span", { className: "glosa-visually-hidden", role: "status" });
  const effortField = el("span", { className: "glosa-chat-field glosa-chat-effort-field" }, [
    effort,
    effortTip,
    effortAnnounce,
  ]);
  const tooltipFields = [effortField];
  for (const field of tooltipFields) {
    field.addEventListener("mouseenter", () => delete field.dataset.tooltipDismissed);
    field.addEventListener("focusin", () => delete field.dataset.tooltipDismissed);
  }
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape") for (const field of tooltipFields) field.dataset.tooltipDismissed = "true";
    },
    { signal: lifetime.signal },
  );
  // A log: what arrives is announced politely, and held back while a turn is still writing.
  const history = el("div", {
    className: "glosa-chat-history",
    tabIndex: 0,
    role: "log",
    "aria-label": "Chat messages",
  });
  const older = el("button", {
    type: "button",
    textContent: "Earlier messages",
    onClick: () => void changePage(state.page?.first),
  });
  const recent = el("button", {
    type: "button",
    textContent: "Recent messages",
    onClick: () => void changePage(undefined),
  });
  const pageControls = el("nav", { className: "glosa-chat-actions", "aria-label": "Message history" }, [older, recent]);
  async function changePage(before) {
    if (paging) return;
    paging = true;
    stopStream?.();
    pageBefore = before;
    try {
      await refresh();
      history.scrollTop = 0;
    } catch (error) {
      failure(error);
      renderControls();
    } finally {
      paging = false;
      if (!disposed) connectStream();
    }
  }
  history.append(empty);
  const decisions = el("div", { className: "glosa-chat-decisions" });
  const draft = el("textarea", {
    className: "glosa-chat-draft",
    placeholder: "What would you like to work on?",
    "aria-label": "Message",
    maxLength: 65536,
    rows: 3,
  });
  const files = el("input", {
    type: "file",
    multiple: true,
    accept: ".md,.txt,image/png,image/jpeg,image/webp",
    "aria-label": "Attach files",
    hidden: true,
  });
  const attachmentList = el("div", { className: "glosa-chat-attachments" });
  const send = el("button", {
    type: "button",
    textContent: "↑",
    className: "glosa-agent-primary glosa-chat-send",
    "aria-label": "Send message",
    onClick: () => void submit(),
  });
  const stop = el("button", {
    type: "button",
    textContent: "Stop",
    className: "glosa-chat-stop",
    onClick: () => {
      if (stopping) return;
      stopping = true;
      render();
      const target = stopTarget;
      // Stopped before it reached the agent, the message stays in the thread to be used again.
      if (target && !target.started) keptCancelled.add(target.id);
      void act(() => dataAccess.stopChat(slug, chatId, target?.id)).finally(() => {
        stopping = false;
        render();
      });
    },
  });
  const jump = el("button", {
    className: "glosa-chat-jump",
    type: "button",
    textContent: "Jump to latest",
    hidden: true,
    onClick: () => {
      history.scrollTop = history.scrollHeight;
      jump.hidden = true;
    },
  });
  // Zero-height, at the history's bottom edge: the button rides just above whatever sits below it.
  const jumpAnchor = el("div", { className: "glosa-chat-jump-anchor" }, [jump]);
  history.addEventListener("scroll", () => {
    if (history.scrollHeight - history.scrollTop - history.clientHeight < 64) jump.hidden = true;
  });
  const header = el("header", { className: "glosa-chat-header" }, [identity, title, activity, menu.element]);
  menu.popup.append(
    el("button", { type: "button", textContent: "Agents & accounts", onClick: onSettings }),
    el("button", {
      type: "button",
      textContent: "Export",
      onClick: () =>
        void act(async () => {
          const text = await dataAccess.exportChat(slug, chatId),
            url = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
          const link = el("a", { href: url, download: `chat-${chatId}.md` });
          link.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }),
    }),
  );
  const feedback = el("button", {
    type: "button",
    textContent: "Send feedback",
    onClick: () =>
      void act(async () => {
        if (changingAccount || changingSettings || uploading) return;
        feedbackIntent ??= {
          requestId: crypto.randomUUID(),
          turnId: crypto.randomUUID(),
          configRevision: state.configRevision,
        };
        try {
          await dataAccess.sendChatFeedback(slug, chatId, feedbackIntent);
          feedbackIntent = null;
        } catch (error) {
          if (error.status >= 400 && error.status < 500) feedbackIntent = null;
          throw error;
        }
        await refreshFeedback();
      }),
  });
  if (sourceChatId) {
    let moveIntent;
    transfer.append(
      el("button", {
        type: "button",
        textContent: "Move previous draft here",
        onClick: () => {
          if (uploading || changingAccount || changingSettings || outbox.length) return;
          uploading = true;
          render();
          void act(async () => {
            await save();
            const source = await dataAccess.getChat(slug, sourceChatId);
            moveIntent ??= {
              requestId: crypto.randomUUID(),
              sourceId: sourceChatId,
              sourceRevision: source.draftRevision,
              targetRevision: state.draftRevision,
            };
            let result;
            try {
              result = await dataAccess.moveChatDraft(slug, chatId, moveIntent);
            } catch (error) {
              // This refusal happens before either journal is written. A lost response may
              // follow a durable copy, so every other failure retains its original receipt.
              if (error.problem?.type?.endsWith("/stale-draft")) moveIntent = null;
              throw error;
            }
            moveIntent = null;
            status.textContent = result.sourceCleared
              ? "Draft moved. Nothing has been sent."
              : "Draft copied. A newer draft remains in the previous chat.";
          }).finally(() => {
            uploading = false;
            renderControls();
            render();
          });
        },
      }),
    );
    transfer.append(
      el("button", {
        type: "button",
        textContent: "Attach previous conversation",
        onClick: () => {
          if (uploading || changingAccount || changingSettings || outbox.length) return;
          uploading = true;
          render();
          void act(async () => {
            const destination = catalog.profiles.find((profile) => profile.id === state.profileId);
            const preview = await dataAccess.previewChatTranscript(slug, sourceChatId);
            if (disposed) return;
            const { text } = preview;
            const file = new File([text], "previous-conversation.md", { type: "text/markdown" });
            if (file.size > 10 * 1024 * 1024)
              throw new Error("The transcript exceeds 10 MiB. Export it and attach a shorter excerpt.");
            const accepted = await new Promise((resolve) => {
              const previous = document.activeElement,
                dialog = el("dialog", { className: "glosa-dialog", "aria-label": "Preview conversation attachment" });
              dialogs.add(dialog);
              dialog.append(
                el("h2", { textContent: "Attach this frozen transcript?" }),
                el("p", {
                  textContent: `From “${preview.title}” · ${preview.turnCount} ${preview.turnCount === 1 ? "turn" : "turns"} · ${file.size.toLocaleString()} bytes`,
                }),
                el("p", {
                  textContent: `To ${agentName(destination.provider)} · ${destination.label}. This account receives the copy only when you send. Tool output, reasoning and approvals are excluded.`,
                }),
                el("textarea", { readOnly: true, value: text, rows: 12, "aria-label": "Transcript preview" }),
                el("button", {
                  type: "button",
                  textContent: "Attach transcript",
                  onClick: () => {
                    dialog.accepted = true;
                    dialog.close();
                  },
                }),
                el("button", { type: "button", textContent: "Cancel", onClick: () => dialog.close() }),
              );
              dialog.addEventListener(
                "close",
                () => {
                  resolve(dialog.accepted);
                  dialogs.delete(dialog);
                  dialog.remove();
                  previous?.focus();
                },
                { once: true },
              );
              document.body.append(dialog);
              dialog.showModal();
            });
            if (!accepted || disposed) return;
            if (state.profileId !== destination.id)
              throw new Error("The destination account changed. Preview the transcript again.");
            const attachment = await dataAccess.uploadChatAttachment(slug, chatId, file);
            if (disposed) return;
            attachments = [...attachments, attachment];
            dirty = true;
            renderAttachments();
            await save();
          }).finally(() => {
            uploading = false;
            renderControls();
            render();
          });
        },
      }),
    );
  }
  async function refreshFeedback() {
    if (!dataAccess.getChatFeedback) return;
    const value = await dataAccess.getChatFeedback(slug, chatId);
    if (!disposed) {
      feedback.textContent = `Send feedback · ${value.entryIds.length}${value.hasMore ? "+" : ""}`;
      feedback.hidden = value.entryIds.length === 0;
    }
  }
  menu.popup.append(
    el("button", {
      type: "button",
      textContent: "Delete chat",
      onClick: async () => {
        if (
          !(await confirmDialog({
            title: "Delete this chat and its draft?",
            body: "Delete Glosa's messages and attachments. The coding agent may retain its own native history. This cannot be undone.",
            confirmLabel: "Delete chat",
            danger: true,
          }))
        )
          return;
        try {
          await dataAccess.deleteChat(slug, chatId);
          onDeleted?.();
        } catch (error) {
          failure(error);
        }
      },
    }),
  );

  // Tools and access are settings of the chat, not part of writing a message: a dialog the chat's
  // menu and one quiet line under the composer open, never a panel beneath the draft.
  const mcpHost = el("div"),
    mcpTitle = `chat-tools-${crypto.randomUUID()}`;
  const mcp = el("dialog", { className: "glosa-dialog glosa-chat-tools", "aria-labelledby": mcpTitle }, [
    el("h2", { id: mcpTitle, textContent: "Tools and workspace access" }),
    mcpHost,
  ]);
  mcp.addEventListener("click", (event) => {
    if (event.target === mcp) mcp.close();
  });
  // In the document only while it is open, so it is never a second dialog for anything to find.
  mcp.addEventListener("close", () => {
    mcp.remove();
    if (!nativeLogin) return;
    void nativeLogin.destroy();
    nativeLogin = null;
  });
  const toolsLine = el("button", {
    type: "button",
    className: "glosa-chat-tools-line",
    textContent: "Tools and access",
    onClick: () => void openTools(),
  });
  /** How many tool servers this chat's account has switched on here, for the line under the composer. */
  async function refreshToolsLine() {
    let enabled;
    try {
      const policy = await dataAccess.getMcpPolicy?.(slug, state.profileId);
      enabled = policy?.servers.filter((server) => server.enabled).length;
    } catch {
      // The line still opens the dialog; only its count is unknown.
    }
    if (disposed) return;
    toolsLine.textContent =
      enabled === undefined
        ? "Tools and access"
        : enabled === 0
          ? "No extra tools on"
          : `${enabled} ${enabled === 1 ? "tool" : "tools"} on`;
  }
  function openTools() {
    if (!state) return;
    return act(async () => {
      const profileId = state.profileId,
        policy = await dataAccess.getMcpPolicy(slug, profileId);
      if (disposed || state.profileId !== profileId) return;
      mcpHost.replaceChildren();
      const saved = () => {
        mcp.close();
        void refreshToolsLine();
      };
      mountMcpSettings(mcpHost, {
        servers: policy.servers,
        onSave: async (servers) => {
          await dataAccess.setMcpPolicy(slug, profileId, { revision: policy.revision, servers });
          saved();
        },
        onReset: async () => {
          await dataAccess.setMcpPolicy(slug, profileId, { revision: policy.revision, servers: null });
          saved();
        },
      });
      if (mcp.open) return;
      root.append(mcp);
      mcp.showModal();
    });
  }
  async function openMcpManager(serverId) {
    if (nativeLogin) throw new Error("Finish the current native sign-in first.");
    const profile = catalog.profiles.find((p) => p.id === state.profileId);
    if (profile.provider === "codex" && !serverId) {
      const policy = await dataAccess.getMcpPolicy(slug, profile.id),
        servers = policy.servers.filter((server) => server.enabled && server.transport === "http");
      if (!servers.length) throw new Error("Configure an enabled HTTP server first.");
      serverId = await new Promise((resolve) => {
        const previous = document.activeElement,
          dialog = el("dialog", { className: "glosa-dialog", "aria-label": "Choose MCP server" });
        dialog.append(el("h2", { textContent: "Choose a server to sign in" }));
        for (const server of servers)
          dialog.append(
            el("button", {
              type: "button",
              textContent: server.label,
              onClick: () => {
                dialog.selected = server.id;
                dialog.close();
              },
            }),
          );
        dialog.append(el("button", { type: "button", textContent: "Cancel", onClick: () => dialog.close() }));
        dialog.addEventListener(
          "close",
          () => {
            resolve(dialog.selected);
            dialog.remove();
            previous?.focus();
          },
          { once: true },
        );
        document.body.append(dialog);
        dialog.showModal();
      });
      if (!serverId) return;
    }
    if (
      !(await confirmDialog({
        title: "Sign in to a tool server?",
        body: "Stop this account's active chats first. The agent will connect the enabled servers using this workspace's approved configuration. Credentials stay in this account's own private storage.",
        confirmLabel: "Open sign-in",
      }))
    )
      return;
    nativeLogin = await mountAgentLogin(mcpHost, {
      dataAccess,
      profile,
      workspace: slug,
      serverId,
      signal: lifetime.signal,
      onFinished: () => {
        nativeLogin = null;
        mcp.close();
      },
    });
  }
  mcp.append(
    el("section", { className: "glosa-chat-tools-section" }, [
      el("h3", { textContent: "Connections" }),
      el("p", {
        textContent:
          "See which tools the agent has connected in this chat, or sign in to one that asks for it. Signing in is handled by the agent itself.",
      }),
      el("div", { className: "glosa-chat-tools-actions" }, [
        el("button", {
          type: "button",
          textContent: "Check connections",
          onClick: () =>
            void act(async () => {
              const result = await dataAccess.nativeChatMcp(slug, chatId);
              const inventory = el("div", { role: "status" });
              for (const server of result.servers) {
                const row = el("p", {
                  textContent: `${server.name} · ${server.source === "native" ? "From the agent's own settings · " : ""}${server.status} · sign-in ${server.auth}`,
                });
                if (server.login && server.name !== "glosa")
                  row.append(
                    el("button", {
                      type: "button",
                      textContent: "Sign in / reconnect",
                      onClick: () =>
                        void act(async () => {
                          await openMcpManager(server.name.replace(/^glosa-user-/, ""));
                        }),
                    }),
                  );
                inventory.append(row);
              }
              mcpHost.querySelector("[data-native-mcp]")?.remove();
              inventory.dataset.nativeMcp = "true";
              mcpHost.append(inventory);
            }),
        }),
        el("button", {
          type: "button",
          textContent: "Sign in to a server",
          onClick: () => void act(() => openMcpManager(undefined)),
        }),
      ]),
    ]),
    el("section", { className: "glosa-chat-tools-section" }, [
      el("h3", { textContent: "Workspace access" }),
      el("p", {
        textContent:
          "This account may read this folder and receive your messages. Revoking stops its running chats here, and you are asked again before the next message.",
      }),
      el("div", { className: "glosa-chat-tools-actions" }, [
        el("button", {
          type: "button",
          className: "glosa-chat-danger",
          textContent: "Revoke access",
          onClick: () =>
            void act(async () => {
              if (
                !(await confirmDialog({
                  title: "Revoke workspace access?",
                  body: "This account's running chats in this folder will stop. You will be asked to allow access again before the next message.",
                  confirmLabel: "Revoke access",
                  danger: true,
                }))
              )
                return;
              await dataAccess.setAgentConsent(state.profileId, slug, false);
              mcp.close();
              status.textContent = "Workspace access revoked. Its runs have stopped.";
            }),
        }),
      ]),
    ]),
    el("div", { className: "glosa-dialog-actions" }, [
      el("button", { type: "button", textContent: "Close", onClick: () => mcp.close() }),
    ]),
  );
  async function showNativeConnections() {
    let result;
    try {
      result = await dataAccess.nativeChatMcp(slug, chatId);
    } catch (error) {
      if (!error.problem?.type?.endsWith("/runtime-closed")) throw error;
      result = { servers: [] };
    }
    status.textContent = result.servers.length
      ? result.servers.map((server) => `${server.name}: ${server.status}`).join(" · ")
      : "No agent is running. Connections will be listed while a chat is active.";
  }
  async function allowWorkspace(confirmLabel) {
    const policy = await dataAccess.getMcpPolicy?.(slug, state.profileId);
    const profile = catalog.profiles.find((item) => item.id === state.profileId);
    const servers = (policy?.servers ?? [])
      .filter((server) => server.enabled)
      .map((server) => `${server.label}: ${server.transport === "http" ? server.url : server.command}`)
      .join("\n");
    const accepted = await confirmDialog({
      title: "Allow this account to work in this workspace?",
      body:
        "The coding agent can read workspace files and receive your messages and attachments through its configured provider. File changes and commands follow its approval mode." +
        // Browser tools (#440): existing permissions are asked once more for this sentence
        // (CONSENT_DISCLOSURE in packages/daemon/src/chats/store.ts).
        " In the glosa desktop app it can also open web pages in this window's browser tabs and read them while it answers you. The text of those pages, including pages you are signed in to, goes to its provider." +
        (profile?.configuration
          ? " Its native settings, permission rules, plugins, hooks and MCP servers will also run, including startup hooks before a message is sent. Configuration changes require renewed permission."
          : " This permission lasts until revoked in this workspace.") +
        (servers ? `\nEnabled MCP servers may receive this content:\n${servers}` : ""),
      confirmLabel,
    });
    if (accepted) await dataAccess.setAgentConsent(state.profileId, slug, true);
    return accepted;
  }
  controls.append(picker.element, effortField);
  // Usage is the chat's own bookkeeping, not part of the conversation: it opens from the chat's menu.
  const usageAction = el("button", {
    type: "button",
    textContent: "Usage and limits",
    "data-chat-action": "usage",
    hidden: true,
    onClick: () => void noticeDialog({ title: "Usage and limits", body: usageText(), dismissLabel: "Close" }),
  });
  menu.popup.append(
    el("button", {
      type: "button",
      textContent: "Refresh accounts",
      onClick: () =>
        void act(async () => {
          catalog = await dataAccess.getAgentStatus();
        }),
    }),
  );
  menu.popup.append(
    usageAction,
    el("button", {
      type: "button",
      textContent: "Tools and workspace access",
      "data-chat-action": "tools",
      onClick: () => void openTools(),
    }),
    el("button", {
      type: "button",
      textContent: "Pin chat",
      "data-chat-action": "pin",
      onClick: () =>
        void act(() =>
          dataAccess.changeChat(slug, chatId, {
            requestId: crypto.randomUUID(),
            revision: state.configRevision,
            pinned: !state.pinned,
          }),
        ),
    }),
    el("button", {
      type: "button",
      textContent: "Archive chat",
      "data-chat-action": "archive",
      onClick: () =>
        void act(async () => {
          if (
            state.archived ||
            (await confirmDialog({
              title: "Archive this chat?",
              body: "The chat leaves the active list. Its history remains available.",
              confirmLabel: "Archive",
            }))
          )
            await dataAccess.changeChat(slug, chatId, {
              requestId: crypto.randomUUID(),
              revision: state.configRevision,
              archived: !state.archived,
            });
        }),
    }),
  );
  const attach = el("button", {
    type: "button",
    className: "glosa-chat-attach glosa-icon-button",
    textContent: "+",
    "aria-label": "Add attachments",
    title: "Attach documents or images",
    onClick: () => files.click(),
  });
  // What waits to be sent, at the top of the composer: one line each, oldest first, with its way
  // out beside it. A change in how many wait is announced once, politely.
  const trayList = el("ol", { className: "glosa-chat-tray", "aria-label": "Waiting messages", hidden: true });
  const trayAnnounce = el("span", { className: "glosa-visually-hidden", role: "status" });
  const composer = el("div", { className: "glosa-chat-composer" }, [
    trayList,
    trayAnnounce,
    draft,
    attachmentList,
    el("div", { className: "glosa-chat-compose-actions" }, [
      attach,
      files,
      controls,
      el("span", { className: "glosa-chat-action-spacer" }),
      // Stop and send wrap as one, and keep to the composer's right edge when they do.
      el("span", { className: "glosa-chat-send-group" }, [stop, send]),
    ]),
  ]);
  const completion = createComposerPicker(draft, {
    getFiles,
    enabled: () => !changingAccount && !changingSettings,
    getCatalog: () => dataAccess.getChatCommands?.(slug, chatId) ?? Promise.resolve({ commands: [], loaded: false }),
    loadCatalog: async () => {
      try {
        return await dataAccess.refreshChatCommands(slug, chatId);
      } catch (error) {
        if (!error.problem?.type?.endsWith("/consent-required")) throw error;
        if (!(await allowWorkspace("Allow and load commands")))
          throw new Error("Command loading was cancelled. Your draft has been kept.");
        return dataAccess.refreshChatCommands(slug, chatId);
      }
    },
    onAction: async (action) => {
      if (attachments.length)
        throw new Error("Remove attachments before using a workspace action. Your draft has been kept.");
      if (action === "mcp") await openTools();
      else await showNativeConnections();
      return true;
    },
    onChange: () => {
      dirty = true;
      scheduleSave();
    },
  });

  // One quiet line under the composer. What the pane has to say (a save that failed, a message
  // accepted) is said above the composer, beside the work, and only while there is something to say.
  const footer = el("div", { className: "glosa-chat-footer" }, [
    toolsLine,
    feedback,
    el("span", { className: "glosa-chat-key-hint", textContent: "Enter to send · Shift Enter for a new line" }),
  ]);
  root.append(header, transfer, pageControls, history, jumpAnchor, decisions, readiness, status, composer, footer);
  host.append(root);
  void loadChatMarkdown()
    .then((render) => {
      if (!disposed) {
        renderMarkdown = render;
        renderMessages();
      }
    })
    .catch(() => {});
  const handle = {
    element: root,
    kind: "chat",
    title: "Chat",
    ready: null,
    destroy() {
      disposed = true;
      clearInterval(liveTimer);
      accountGeneration++;
      lifetime.abort();
      tableFit?.disconnect();
      picker.destroy();
      completion.destroy();
      clearTimeout(timer);
      stopStream?.();
      document.removeEventListener("selectionchange", selectionChanged);
      for (const dialog of dialogs) {
        dialog.close();
        dialog.remove();
      }
      dialogs.clear();
      root.remove();
    },
    async confirmClose() {
      await save();
      return (
        (!dirty && !uploading && !changingSettings && !outbox.length) ||
        (await confirmDialog({
          title:
            uploading || changingSettings || outbox.length
              ? "Close with unfinished changes?"
              : "Close with an unsaved draft?",
          body: outbox.length
            ? "A message has not been sent yet. Closing now discards it."
            : uploading || changingSettings
              ? "An attachment or setting is still being saved. Keep this tab open to finish. Closing now may leave the change unfinished."
              : "Copy the draft first if you want to keep it. The agent keeps running when its tab closes.",
          confirmLabel: "Close tab",
          danger: true,
        }))
      );
    },
  };
  function failure(error) {
    status.textContent = error.message || "The chat could not be updated.";
    picker.error(status.textContent);
  }
  async function act(fn, current = () => !disposed) {
    try {
      await fn();
      if (current()) {
        await refresh();
        return true;
      }
      return false;
    } catch (error) {
      if (!current()) return false;
      failure(error);
      renderControls();
      return false;
    }
  }
  function renderControls() {
    if (!state) return;
    const models = catalog?.capabilities?.[state.profileId]?.models ?? [];
    const profile = catalog?.profiles?.find((p) => p.id === state.profileId);
    const accountReady =
      !!profile?.enabled && !profile.removed && (!profile.auth || profile.auth.state === "authenticated");
    const selectedModel = models.find((m) => m.id === state.settings.model);
    readyToSend =
      accountReady &&
      !!selectedModel &&
      (!state.settings.effort || selectedModel.efforts.includes(state.settings.effort));
    // The control stays live while its own save is in flight, so a run of presses is not dropped.
    effort.disabled = changingAccount || (changingSettings && !effortSaving) || !selectedModel?.efforts.length;
    readiness.hidden = readyToSend || !executionAvailable() || state.archived;
    readinessText.textContent = !accountReady
      ? "This account needs attention before it can send."
      : !models.length
        ? "Load this account’s models to continue."
        : "Choose an available model and effort to continue.";
    loadModels.hidden = !accountReady;
    manageAccount.hidden = accountReady;
    identity.replaceChildren(agentIcon(state.provider));
    identity.title = agentName(state.provider);
    picker.render({
      state,
      catalog,
      disabled: changingSettings || uploading || outbox.length > 0 || !!state.archived,
      busy: changingAccount || changingSettings,
      subscriptionBlocked:
        state.turns.some((turn) => !["completed", "failed", "cancelled", "outcome_unknown"].includes(turn.status)) ||
        (!!state.runtime && state.runtime.state !== "stopped"),
    });
    const levels = effortLevels();
    const shown = effortTarget ?? state.settings.effort;
    const selectedEffort = effortPresentation(shown);
    const next = levels[(levels.indexOf(shown) + 1) % levels.length];
    effort.dataset.effort = shown;
    effortLabel.textContent = selectedEffort.label;
    effortLabel.dataset.widest = [shown, ...levels]
      .map((id) => effortPresentation(id).label)
      .reduce((widest, label) => (label.length > widest.length ? label : widest));
    effortIcon(shown, effortMark);
    effortTip.textContent =
      `${selectedEffort.label} effort · ${selectedEffort.description} Applies to your next message.` +
      (levels.length > 1 && next !== shown ? ` Press for ${effortPresentation(next).label}.` : "");
    menu.popup.querySelector('[data-chat-action="pin"]').textContent = state.pinned ? "Unpin chat" : "Pin chat";
    menu.popup.querySelector('[data-chat-action="archive"]').textContent = state.archived
      ? "Restore chat"
      : "Archive chat";
    if (document.activeElement !== title) title.value = state.title;
  }
  function textRow(key, label, text, collapsible = false, markdown = false, rowKind) {
    wantedRows.add(key);
    let row = rows.get(key);
    if (!row) {
      const node = el(collapsible ? "details" : "article", {
        className: "glosa-chat-message",
        "data-kind":
          rowKind ??
          (key.startsWith("user:") ? "human" : key.startsWith("error:") ? "error" : collapsible ? "detail" : "agent"),
      });
      const heading = el(collapsible ? "summary" : "h3", {
        textContent: label,
        className: !collapsible && !key.startsWith("error:") ? "glosa-visually-hidden" : "",
      });
      const content = el("div", { className: "glosa-chat-text" });
      const copy = el("button", {
        type: "button",
        className: "glosa-icon-button",
        textContent: "⧉",
        title: "Copy message",
        "aria-label": `Copy ${label}`,
        onClick: () => {
          void navigator.clipboard
            .writeText(row.text)
            .then(() => {
              status.textContent = "Message copied.";
            })
            .catch(() => {
              status.textContent = "Copy failed. Select the message text to copy it.";
            });
        },
      });
      node.append(heading, content, copy);
      history.append(node);
      row = { node, heading, content, copy, text: "" };
      rows.set(key, row);
    }
    row.heading.textContent = label;
    row.copy.setAttribute("aria-label", `Copy ${label}`);
    const selection = window.getSelection?.();
    const selected =
      selection &&
      !selection.isCollapsed &&
      (row.content.contains(selection.anchorNode) || row.content.contains(selection.focusNode));
    if (selected && row.markdown) return;
    if (markdown && renderMarkdown && !selected) {
      if (row.text !== text || !row.markdown) row.content.innerHTML = renderMarkdown(text);
      row.text = text;
      row.markdown = true;
      row.content.classList.add("glosa-chat-markdown");
      if (row.content.querySelector("table")) {
        tableFit?.observe(row.content);
        fitTables(row.content);
      }
      return;
    }
    if (row.text !== text) {
      // Append a delta to the existing text node: selection and scroll survive streaming.
      if (text.startsWith(row.text) && row.content.firstChild?.nodeType === Node.TEXT_NODE)
        row.content.firstChild.appendData(text.slice(row.text.length));
      else row.content.textContent = text;
      row.text = text;
    }
  }
  /** Marks each table in a reply that is wider than its room however its columns share it, and
   * only those: `data-fit="break"` lets its cells break words anywhere (app.css). Every mark comes
   * off before any width is read, so one layout serves every table.
   * @param {Element} reply */
  function fitTables(reply) {
    const tables = [...reply.querySelectorAll("table")];
    for (const table of tables) table.removeAttribute("data-fit");
    const overflowing = tables.filter((table) => {
      const parent = /** @type {HTMLElement} */ (table.parentElement);
      const style = getComputedStyle(parent);
      const room = parent.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
      return table.offsetWidth > room + 0.5;
    });
    for (const table of overflowing) table.setAttribute("data-fit", "break");
  }
  function selectionChanged() {
    if (window.getSelection?.()?.isCollapsed) render();
  }
  document.addEventListener("selectionchange", selectionChanged);
  /** The chat's token totals and account limits as the agent last reported them, in plain lines. */
  function usageText() {
    const value = state.usage;
    const labels = {
      input_tokens: "Input tokens",
      inputTokens: "Input tokens",
      output_tokens: "Output tokens",
      outputTokens: "Output tokens",
      totalTokens: "Total tokens",
      cachedInputTokens: "Cached input tokens",
      reasoningOutputTokens: "Reasoning output tokens",
      cache_read_input_tokens: "Cache-read tokens",
      cache_creation_input_tokens: "Cache-write tokens",
      contextWindow: "Context capacity (tokens)",
      estimatedCostUsd: "Estimated cost (USD)",
      primaryUsedPercent: "Primary limit used (%)",
      secondaryUsedPercent: "Secondary limit used (%)",
      primaryResetsAt: "Primary limit resets",
      secondaryResetsAt: "Secondary limit resets",
      quota_status: "Status",
      quota_resetsAt: "Resets",
      quota_utilization: "Reported utilization",
      quota_rateLimitType: "Limit type",
    };
    const observedAt = (date) => {
      const parsed = new Date(typeof date === "number" ? date * 1000 : date);
      return Number.isNaN(parsed.getTime()) ? String(date) : parsed.toLocaleString();
    };
    const metrics = [];
    const limits = [];
    for (const [key, item] of Object.entries(value)) {
      if (["source", "scope", "asOf", "quotaSource", "quotaAsOf"].includes(key)) continue;
      const label = labels[key] ?? key.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ");
      const formatted =
        item == null
          ? "Not reported"
          : /resetsAt$/i.test(key)
            ? observedAt(item)
            : typeof item === "number"
              ? item.toLocaleString(undefined, { maximumFractionDigits: 6 })
              : String(item);
      const target = key.startsWith("quota_") || /^(primary|secondary)/.test(key) ? limits : metrics;
      target.push(`${label}: ${formatted}`);
    }
    const profile = catalog?.profiles.find((item) => item.id === state.profileId);
    const sections = [`Account: ${profile?.label ?? agentName(state.provider)}`];
    if (metrics.length)
      sections.push(
        [
          `Token usage · ${value.scope === "native-thread" ? "current session totals" : "agent-reported totals"}`,
          `Source: ${value.source ?? agentName(state.provider)}`,
          `Observed: ${value.asOf ? observedAt(value.asOf) : "Not reported"}`,
          ...metrics,
          "Current context use: Not reported",
        ].join("\n"),
      );
    if (limits.length)
      sections.push(
        [
          "Account limits",
          `Source: ${value.quotaSource ?? agentName(state.provider)}`,
          `Observed: ${value.quotaAsOf ? observedAt(value.quotaAsOf) : "Not reported"}`,
          ...limits,
        ].join("\n"),
      );
    if (value.estimatedCostUsd != null) sections.push("Cost estimates are not subscription charges or invoices.");
    return sections.join("\n\n");
  }
  /** Null when a turn ran on what the person chose, or the agent did not say. An alias and the
   * model it resolves to are the same choice. */
  function settingsMismatch(turn) {
    const asked = turn.settings;
    const ran = turn.effective;
    if (!asked || !ran) return null;
    const resolved = catalog?.capabilities?.[state.profileId]?.models.find((m) => m.id === asked.model)?.resolvedModel;
    const model = !!ran.model && ran.model !== asked.model && ran.model !== resolved;
    const effort = !!ran.effort && !!asked.effort && ran.effort !== asked.effort;
    if (!model && !effort) return null;
    return {
      label: model ? "Ran on a different model" : "Ran at a different effort",
      text: `You chose: ${asked.model} · ${asked.effort || "default"}\nThe agent reported: ${ran.model ?? "no model"} · ${ran.effort ?? "no effort"}`,
    };
  }
  /** A turn's tool steps as one closed row: a count, then each step with its state and, on
   * request, what the tool reported. Steps are updated in place so an open one stays open. */
  function stepsRow(turnId, work) {
    const key = `${turnId}:steps`;
    wantedRows.add(key);
    let row = rows.get(key);
    if (!row) {
      const summary = el("summary");
      const list = el("ol", { className: "glosa-chat-step-list" });
      const node = el("details", { className: "glosa-chat-message glosa-chat-steps", "data-kind": "steps" }, [
        summary,
        list,
      ]);
      history.append(node);
      row = { node, summary, list, steps: new Map() };
      rows.set(key, row);
    }
    if (row.summary.textContent !== work.summary) row.summary.textContent = work.summary;
    for (const step of work.steps) {
      let entry = row.steps.get(step.id);
      if (!entry) {
        const mark = el("span", { className: "glosa-chat-step-mark", "aria-hidden": "true" });
        const label = el("span");
        const detail = el("pre", { className: "glosa-chat-step-detail" });
        const item = el("li", {}, [el("details", {}, [el("summary", {}, [mark, label]), detail])]);
        row.list.append(item);
        entry = { item, mark, label, detail };
        row.steps.set(step.id, entry);
      }
      if (entry.item.dataset.state !== step.state) {
        entry.item.dataset.state = step.state;
        entry.mark.innerHTML = STEP_MARKS[step.state] ?? "";
      }
      // The state is said in words too: the mark's colour is never the only signal.
      const text = step.label + (["failed", "stopped"].includes(step.state) ? ` · ${step.state}` : "");
      if (entry.label.textContent !== text) entry.label.textContent = text;
      if (entry.detail.textContent !== step.detail) entry.detail.textContent = step.detail;
    }
    return row;
  }
  /** The line under a turn that is still at work: what it is doing now and for how long. It goes
   * when the turn ends; the header's status says the same to a screen reader, so this is silent. */
  function liveRow(turn, work, tail) {
    const before = turnStatuses.get(turn.id);
    turnStatuses.set(turn.id, turn.status);
    if (!work.live) return;
    const key = `live:${turn.id}`;
    wantedRows.add(key);
    let row = rows.get(key);
    if (!row) {
      const label = el("span");
      const time = el("span", { className: "glosa-chat-live-time" });
      const node = el("div", { className: "glosa-chat-live", "aria-hidden": "true" }, [
        el("span", { className: "glosa-chat-live-mark" }),
        label,
        time,
      ]);
      history.append(node);
      // Counted from when it started here; a turn found already at work counts from its own time.
      const sent = Date.parse(turn.at);
      row = { node, label, time, since: before || Number.isNaN(sent) ? Date.now() : sent };
      rows.set(key, row);
    }
    if (row.label.textContent !== work.live) row.label.textContent = work.live;
    row.node.dataset.status = turn.status;
    if (tail && row.node.previousSibling !== tail) tail.after(row.node);
    tickLive();
    liveTimer ||= setInterval(tickLive, 1000);
  }
  function tickLive() {
    let live = false;
    for (const [key, row] of rows) {
      if (!key.startsWith("live:")) continue;
      live = true;
      const seconds = (Date.now() - row.since) / 1000;
      // A wait on the person is not the agent's time, and the first moments need no count.
      const text = row.node.dataset.status === "waiting" || seconds < 2 ? "" : elapsedLabel(seconds);
      if (row.time.textContent !== text) row.time.textContent = text;
    }
    if (live) return;
    clearInterval(liveTimer);
    liveTimer = 0;
  }
  /** Asks before a message taken back into the composer overwrites what is being written there. */
  async function confirmReplace(body) {
    return (
      (!draft.value.trim() && !attachments.length) ||
      (await confirmDialog({ title: "Replace this draft?", body, confirmLabel: "Replace draft", danger: true }))
    );
  }
  async function fillDraft(message) {
    if (disposed) return;
    draft.value = message.text;
    completion.setReferences(message.references ?? []);
    attachments = [...(message.attachments ?? [])];
    dirty = true;
    renderAttachments();
    await save();
    draft.focus();
  }
  /** A send whose answer was lost may have landed. Asks the daemon before the row is taken back. */
  async function stillUnsent(entry) {
    if (entry.intent) await refresh().catch(() => {});
    if (outbox.includes(entry)) return true;
    status.textContent = "That message was sent after all.";
    return false;
  }
  function trayVerbs(row) {
    const verb = (textContent, label, onClick, more = {}) =>
      el("button", {
        type: "button",
        className: "glosa-chat-verb",
        textContent,
        "aria-label": label,
        onClick,
        ...more,
      });
    const waitingBody = "The waiting message will replace the current unsent draft and its attachments.";
    const remove = verb(
      "Remove",
      "Remove waiting message",
      () => {
        const { turn, entry } = row.item;
        if (turn) return void act(() => dataAccess.stopChat(slug, chatId, turn.id));
        void (async () => {
          if (!(await stillUnsent(entry))) return;
          outbox.splice(outbox.indexOf(entry), 1);
          render();
          void drainOutbox();
        })();
      },
      { "data-verb": "remove" },
    );
    const edit = verb("Edit", "Edit waiting message", () => {
      const { turn, entry } = row.item;
      if (uploading || changingAccount || changingSettings) return;
      if (turn)
        return void act(async () => {
          if (!(await confirmReplace(waitingBody))) return;
          await dataAccess.stopChat(slug, chatId, turn.id);
          await fillDraft(turn);
        });
      void (async () => {
        if (!(await confirmReplace(waitingBody)) || !(await stillUnsent(entry))) return;
        outbox.splice(outbox.indexOf(entry), 1);
        await fillDraft(entry);
        render();
        void drainOutbox();
      })();
    });
    if (row.kind === "failed")
      return [
        verb("Retry", "Retry sending message", () => {
          for (const entry of outbox) entry.state = "sending";
          status.textContent = "";
          render();
          void drainOutbox();
        }),
        edit,
        remove,
      ];
    if (row.kind === "held")
      return [
        verb(
          "Continue",
          "Continue held message",
          () => void act(() => dataAccess.resumeChatTurn(slug, chatId, row.item.id)),
          { "data-continue-turn": "true" },
        ),
        edit,
        remove,
      ];
    // Selected notes sent as feedback are not the person's own words to rewrite.
    if (row.kind === "feedback") return [remove];
    if (row.kind !== "queued") return [];
    return [
      edit,
      remove,
      verb(
        "Send now",
        "Send this message now",
        () => {
          // Send now stops what is at work. Stopped before it reached the agent, that message
          // stays in the thread to be used again.
          if (stopTarget && !stopTarget.started) keptCancelled.add(stopTarget.id);
          void act(() => dataAccess.sendChatTurnNow(slug, chatId, row.item.id));
        },
        { title: "Stops the current reply" },
      ),
    ];
  }
  function renderTray(queue) {
    let previous = null;
    for (const item of queue.tray) {
      let row = trayRows.get(item.id);
      if (!row) {
        const place = el("span", { className: "glosa-chat-tray-state" });
        const words = el("span", { className: "glosa-chat-tray-words" });
        const verbs = el("span", { className: "glosa-chat-tray-verbs" });
        row = { node: el("li", {}, [place, words, verbs]), place, words, verbs, kind: "", item };
        trayRows.set(item.id, row);
      }
      row.item = item;
      const text = typeof item.text === "string" ? item.text.replace(/\s+/gu, " ").trim() : "Waiting message";
      if (row.place.textContent !== item.label) row.place.textContent = item.label;
      if (row.words.textContent !== text) row.words.textContent = text;
      // Why a message is held or was not sent is said in words, on the row.
      const reason = item.turn?.error ?? item.entry?.error ?? "";
      row.words.title = reason ? `${text}\n${reason}` : text;
      const kind = item.kind === "queued" && item.turn?.origin === "feedback" ? "feedback" : item.kind;
      row.node.dataset.kind = item.kind;
      if (row.kind !== kind) {
        row.kind = kind;
        row.verbs.replaceChildren(...trayVerbs(row));
      }
      if (previous ? previous.nextSibling !== row.node : trayList.firstChild !== row.node) {
        if (previous) previous.after(row.node);
        else trayList.prepend(row.node);
      }
      previous = row.node;
    }
    const wanted = new Set(queue.tray.map((item) => item.id));
    for (const [id, row] of trayRows) {
      if (wanted.has(id)) continue;
      // The row under the keyboard is going: the composer is where its message went.
      if (row.node.contains(document.activeElement)) draft.focus();
      row.node.remove();
      trayRows.delete(id);
    }
    trayList.hidden = !queue.tray.length;
    const said = queue.tray.length
      ? `${queue.tray.length} ${queue.tray.length === 1 ? "message" : "messages"} waiting`
      : "";
    if (trayAnnounce.textContent !== said) trayAnnounce.textContent = said;
  }
  function renderMessages() {
    render();
  }
  function render() {
    if (!state || disposed) return;
    renderControls();
    const following = history.scrollHeight - history.scrollTop - history.clientHeight < 64;
    handle.title = state.title;
    handle.provider = state.provider;
    if (sourceChatId && state.turns.length && transfer.children.length) {
      menu.popup.append(...transfer.children);
      transfer.hidden = true;
    }
    wantedRows = new Set();
    // A send whose answer was lost may have landed after all: the daemon's turn then stands for it.
    for (let i = outbox.length - 1; i >= 0; i--)
      if (outbox[i].state === "failed" && state.turns.some((turn) => turn.id === outbox[i].id)) outbox.splice(i, 1);
    const queue = chatQueue(state.turns, outbox, keptCancelled);
    const sent = queue.localHead?.entry;
    // A message sent with nothing ahead of it is in the thread at once, before the daemon has it.
    const drawn = sent
      ? [...state.turns, { id: sent.id, text: sent.text, references: sent.references, status: "sending", local: true }]
      : state.turns;
    empty.hidden = queue.tray.length > 0 || drawn.some((turn) => !queue.hidden.has(turn.id));
    pageControls.hidden = !state.page?.hasEarlier && !state.page?.hasLater;
    older.disabled = !state.page?.hasEarlier || paging;
    recent.hidden = !state.page?.hasLater;
    for (const turn of drawn) {
      // A waiting message is a row in the tray; one removed from there was never in the thread.
      if (queue.hidden.has(turn.id)) continue;
      if (typeof turn.text === "string") {
        textRow(`user:${turn.id}`, `You · ${turn.status.replaceAll("_", " ")}`, turn.text);
        const row = rows.get(`user:${turn.id}`);
        if (turn.references?.length && row && !row.references) {
          row.content.replaceChildren();
          let offset = 0;
          for (const ref of [...turn.references].sort((a, b) => a.start - b.start)) {
            row.content.append(
              document.createTextNode(turn.text.slice(offset, ref.start)),
              el("span", {
                className: "glosa-chat-reference",
                textContent: turn.text.slice(ref.start, ref.end),
                title: ref.kind === "file" ? `Workspace file: ${ref.id}` : "Selected native command",
              }),
            );
            offset = ref.end;
          }
          row.content.append(document.createTextNode(turn.text.slice(offset)));
          row.references = true;
        }
      }
      // What a turn ran on is said only when it is not what the person chose: the composer already
      // shows the choice, so repeating it under every message is noise.
      const ranOn = typeof turn.text === "string" ? settingsMismatch(turn) : null;
      if (ranOn) textRow(`settings:${turn.id}`, ranOn.label, ranOn.text, true);
      const shortened = (item) =>
        item.text + (item.truncated ? "\n\nDisplay shortened. Export the chat for the complete message." : "");
      const items = state.content.filter((c) => c.turnId === turn.id);
      const work = turnActivity(turn, items, stepSubjects);
      // The message on its way has no reply yet, and the wait for the agent to start is the long
      // one: the thread says so from the moment it is sent.
      if (turn.local) work.live = "Sending";
      else if (turn === queue.head) work.live = "Starting";
      // The last row this turn has drawn: its live line sits right under it.
      let tail = rows.get(ranOn ? `settings:${turn.id}` : `user:${turn.id}`)?.node;
      // A session reports its reasoning in fragments and its tools one by one; a turn shows one
      // summary of each, where the first of its kind arrived.
      const reasoning = items.filter((item) => item.kind === "reasoning");
      let reasoned = false;
      let stepped = false;
      for (const item of items) {
        if (item.kind === "tool") {
          if (!stepped) tail = stepsRow(turn.id, work).node;
          stepped = true;
          continue;
        }
        if (item.kind === "reasoning") {
          if (!reasoned) {
            textRow(
              `${turn.id}:reasoning`,
              "Reasoning summary",
              reasoning.map(shortened).join("\n\n"),
              true,
              true,
              "reasoning",
            );
            tail = rows.get(`${turn.id}:reasoning`).node;
          }
          reasoned = true;
          continue;
        }
        textRow(`${turn.id}:${item.id}`, "Assistant", shortened(item), false, item.kind === "text");
        tail = rows.get(`${turn.id}:${item.id}`).node;
      }
      liveRow(turn, work, tail);
      if (turn.error && (typeof turn.text === "string" || state.content.some((item) => item.turnId === turn.id)))
        textRow(`error:${turn.id}`, "Needs attention", turn.error);
      const bubble = rows.get(`user:${turn.id}`)?.node;
      const reuseKey = `reuse:${turn.id}`;
      if (turn.status === "cancelled" && typeof turn.text === "string" && turn.origin !== "feedback") {
        wantedRows.add(reuseKey);
        if (!rows.has(reuseKey)) {
          const node = el("div", { className: "glosa-chat-turn-state" }, [
            el("span", { textContent: "Cancelled" }),
            el("button", {
              type: "button",
              className: "glosa-chat-verb",
              textContent: "Use as draft",
              "aria-label": "Use message as draft",
              onClick: () =>
                void act(async () => {
                  if (uploading || changingAccount || changingSettings) return;
                  if (
                    !(await confirmReplace(
                      "The cancelled message will replace the current unsent draft and its attachments.",
                    ))
                  )
                    return;
                  await fillDraft(turn);
                }),
            }),
          ]);
          if (bubble) bubble.after(node);
          else history.append(node);
          rows.set(reuseKey, { node });
        }
      }
    }
    for (const decision of state.decisions) {
      let card = decisionRows.get(decision.id);
      if (!card) {
        card = el("section", { className: "glosa-chat-decision" }, [
          el("h3", { textContent: decision.title }),
          el("pre", { textContent: decision.detail }),
        ]);
        const answer = el("textarea", {
          rows: 2,
          "aria-label": "Answer",
          hidden: !decision.allowText || !!decision.questions,
        });
        card.append(answer);
        const fields = new Map();
        for (const question of decision.questions ?? []) {
          const group = el("fieldset", {}, [el("legend", { textContent: question.question })]);
          const options = [];
          for (const option of question.options) {
            const input = el("input", {
              type: question.multiple ? "checkbox" : "radio",
              name: `${decision.id}:${question.id}`,
              value: option.label,
            });
            options.push(input);
            group.append(
              el("label", {}, [
                input,
                document.createTextNode(option.label),
                ...(option.description ? [el("small", { textContent: option.description })] : []),
              ]),
            );
          }
          const free = el("textarea", {
            rows: 2,
            "aria-label": `${question.question}: your answer`,
            placeholder: "Your answer",
          });
          free.addEventListener("input", () => {
            if (!question.multiple && free.value.trim()) for (const option of options) option.checked = false;
          });
          for (const option of options)
            option.addEventListener("change", () => {
              if (!question.multiple && option.checked) free.value = "";
            });
          group.append(free);
          card.append(group);
          fields.set(question.id, { options, free });
        }
        const remaining = el("p", { className: "glosa-decision-expiry" });
        card.append(remaining);
        card.expiryLabel = remaining;
        for (const choice of decision.choices)
          card.append(
            el("button", {
              type: "button",
              textContent: choice.label,
              onClick: () => {
                card.querySelectorAll("button").forEach((b) => {
                  b.disabled = true;
                });
                const answers = Object.fromEntries(
                  [...fields].map(([key, field]) => [
                    key,
                    [
                      ...field.options.filter((option) => option.checked).map((option) => option.value),
                      ...(field.free.value.trim() ? [field.free.value.trim()] : []),
                    ],
                  ]),
                );
                if (choice.id !== "deny" && fields.size && Object.values(answers).some((values) => !values.length)) {
                  status.textContent = "Answer each question before submitting.";
                  card.querySelectorAll("button").forEach((button) => {
                    button.disabled = false;
                  });
                  return;
                }
                const intent = decisionIntents.get(decision.id) ?? {
                  requestId: crypto.randomUUID(),
                  decisionId: decision.id,
                  generation: decision.generation,
                  choice: choice.id,
                  ...(fields.size ? { text: JSON.stringify(answers) } : answer.value ? { text: answer.value } : {}),
                };
                decisionIntents.set(decision.id, intent);
                answer.disabled = true;
                card.querySelectorAll("fieldset input, fieldset textarea").forEach((input) => {
                  input.disabled = true;
                });
                void dataAccess
                  .answerChatDecision(slug, chatId, intent)
                  .then(refresh)
                  .catch((error) => {
                    failure(error);
                    status.textContent += " Retry your original response if the connection was lost.";
                    card.querySelectorAll("button").forEach((button, index) => {
                      button.disabled = decision.choices[index].id !== intent.choice;
                    });
                  });
              },
            }),
          );
        decisionRows.set(decision.id, card);
        decisions.append(card);
      }
      card.hidden = decision.status !== "pending";
      card.expiryLabel.textContent = `Expires in ${Math.max(0, Math.ceil((Date.parse(decision.expiresAt) - Date.now()) / 60000))} min`;
    }
    renderTray(queue);
    const unconfirmedStop = ["unknown", "stopping"].includes(state.runtime?.state);
    // Stop ends the reply at work, or the message that is starting. What waits behind it stays.
    stopTarget = queue.active ?? queue.head;
    stop.disabled = stopping || (!stopTarget && !unconfirmedStop);
    stop.hidden = !stopTarget && !unconfirmedStop && !stopping;
    stop.textContent = stopping ? "Stopping…" : unconfirmedStop && !stopTarget ? "Retry stop" : "Stop";
    const active = state.turns.findLast((t) => ["dispatching", "running", "waiting"].includes(t.status));
    const working = active ?? queue.head ?? (sent ? { status: "sending" } : null);
    activity.textContent = state.archived
      ? "Archived"
      : unconfirmedStop && !stopTarget
        ? "Stop not confirmed"
        : working
          ? working.status === "waiting"
            ? "Needs your reply"
            : "Working…"
          : "";
    activity.dataset.working = String(!!working);
    history.setAttribute("aria-busy", String(!!working && working.status !== "waiting"));
    handle.attentionCount = state.decisions.filter((decision) => decision.status === "pending").length;
    handle.activityLabel = activity.textContent;
    const editing = changingAccount || changingSettings || uploading;
    const queued = queue.tray.length > 0 || !!queue.head || !!sent;
    feedback.disabled = editing || !executionAvailable() || state.archived || queued;
    // Sending never locks the composer: a message sent while another is at work waits in the tray.
    send.disabled = editing || !executionAvailable() || !!state.archived || !readyToSend;
    send.textContent = uploading ? "Attaching…" : changingSettings ? "Saving…" : "↑";
    const behind = !!working;
    send.setAttribute("aria-label", behind ? "Queue message" : "Send message");
    send.title = behind ? "Queue next message" : "Send message";
    draft.disabled = !!state.archived;
    draft.placeholder = state.archived ? "Restore this chat to send a message." : "What would you like to work on?";
    files.disabled = editing || !!state.archived;
    attach.disabled = files.disabled;
    usageAction.hidden = !state.usage;
    const selection = window.getSelection?.();
    for (const [key, row] of rows)
      if (
        !wantedRows.has(key) &&
        !row.node.contains(document.activeElement) &&
        !(
          selection &&
          !selection.isCollapsed &&
          (row.node.contains(selection.anchorNode) || row.node.contains(selection.focusNode))
        )
      ) {
        // Only a message row is watched; a live line or a turn's state line has no content to unwatch.
        if (row.content) tableFit?.unobserve(row.content);
        row.node.remove();
        rows.delete(key);
      }
    if (rows.size > 200 && !paging && selection?.isCollapsed !== false) void changePage(pageBefore);
    const signature = `${state.turns.length}:${state.content.map((item) => `${item.id}:${item.text.length}`).join(",")}`;
    if (following) {
      history.scrollTop = history.scrollHeight;
      jump.hidden = true;
    } else if (lastContentSignature && signature !== lastContentSignature) jump.hidden = false;
    lastContentSignature = signature;
    onChange?.(state);
  }
  async function refresh() {
    const next = await dataAccess.getChat(slug, chatId, pageBefore);
    if (disposed || (state && next.revision < state.revision)) return;
    state = next;
    if (!dirty && !outbox.length) {
      draft.value = next.draft;
      completion.setReferences(next.draftReferences);
      lastDraft = next.draft;
      attachments = next.draftAttachments;
      baseDraftRevision = next.draftRevision;
      renderAttachments();
    }
    completion.setScope(`${state.provider}:${state.profileId}`);
    renderControls();
    render();
  }
  function renderAttachments() {
    attachmentList.replaceChildren(
      ...attachments.map((a) =>
        el("button", {
          type: "button",
          textContent: `${a.name} ×`,
          "aria-label": `Remove ${a.name}`,
          onClick: () => {
            attachments = attachments.filter((item) => item !== a);
            dirty = true;
            renderAttachments();
            scheduleSave();
          },
        }),
      ),
    );
  }
  function scheduleSave() {
    clearTimeout(timer);
    timer = setTimeout(() => void save(), 500);
  }
  async function save() {
    clearTimeout(timer);
    saving = saving.then(async () => {
      if (!dirty || !state || pending) return;
      const text = draft.value,
        sentAttachments = [...attachments],
        references = completion.references,
        revision = baseDraftRevision;
      try {
        const result = await dataAccess.saveChatDraft(slug, chatId, {
          requestId: crypto.randomUUID(),
          revision,
          text,
          attachments: sentAttachments,
          references,
        });
        state.draftRevision = result.draftRevision;
        state.draftReferences = references;
        baseDraftRevision = result.draftRevision;
        lastDraft = text;
        dirty =
          draft.value !== text ||
          JSON.stringify(attachments) !== JSON.stringify(sentAttachments) ||
          JSON.stringify(completion.references) !== JSON.stringify(references);
        // Why a message was not sent stays said until it is retried or taken back.
        if (!outbox.some((entry) => entry.state === "failed"))
          status.textContent = dirty ? "Draft changed while saving" : "Draft saved";
      } catch (error) {
        failure(error);
      }
    });
    await saving;
  }
  /** Enter takes the message out of the composer at once. It goes into the thread when nothing is
   * ahead of it, and into the tray when something is; the daemon is told behind the scenes. */
  function submit() {
    if (!state || changingAccount || changingSettings || uploading) return;
    if (!executionAvailable() || state.archived || !readyToSend || !draft.value.trim()) return;
    const waiting = state.turns.filter((turn) => ["accepted", "queued", "held"].includes(turn.status)).length;
    if (waiting + outbox.length >= MAX_WAITING) {
      status.textContent = "Five messages are already waiting. Remove one, or wait for a reply.";
      return;
    }
    completion.resolveTyped();
    outbox.push({
      id: crypto.randomUUID(),
      text: draft.value,
      references: completion.references,
      attachments: [...attachments],
      state: "sending",
      intent: null,
      // Words the daemon has not saved yet are saved as the draft first, so a send that fails
      // cannot lose them, and a draft changed in another window is never sent over.
      unsaved:
        dirty ||
        draft.value !== lastDraft ||
        JSON.stringify(completion.references) !== JSON.stringify(state.draftReferences ?? []),
    });
    clearTimeout(timer);
    draft.value = "";
    completion.setReferences([]);
    attachments = [];
    dirty = false;
    renderAttachments();
    status.textContent = "";
    render();
    void drainOutbox();
  }
  /** Posts what was sent, one message at a time and in order. A draft save never runs alongside:
   * the daemon ties each send to the draft revision it consumes. */
  async function drainOutbox() {
    if (pending || disposed) return;
    pending = true;
    try {
      await saving;
      while (!disposed && outbox[0]?.state === "sending") {
        const entry = outbox[0];
        try {
          if (entry.unsaved) {
            const saved = await dataAccess.saveChatDraft(slug, chatId, {
              requestId: crypto.randomUUID(),
              revision: baseDraftRevision,
              text: entry.text,
              attachments: entry.attachments,
              references: entry.references,
            });
            baseDraftRevision = saved.draftRevision;
            state.draftRevision = saved.draftRevision;
            lastDraft = entry.text;
            entry.unsaved = false;
          }
          // A retry of a send whose answer was lost repeats the same request, so it cannot duplicate.
          entry.intent ??= {
            requestId: crypto.randomUUID(),
            turnId: entry.id,
            configRevision: state.configRevision,
            draftRevision: baseDraftRevision,
            text: entry.text,
            references: entry.references,
            attachments: entry.attachments,
          };
          try {
            await dataAccess.sendChatTurn(slug, chatId, entry.intent);
          } catch (error) {
            if (!error.problem?.type?.endsWith("/consent-required")) throw error;
            if (!(await allowWorkspace("Allow and send")))
              throw Object.assign(new Error("This account is not allowed to work in this workspace yet."), {
                refused: true,
              });
            await dataAccess.sendChatTurn(slug, chatId, entry.intent);
          }
        } catch (error) {
          if (disposed) return;
          const refusal = error.problem?.type?.split("/").pop();
          const refused =
            !entry.intent ||
            error.refused ||
            [
              "stale-chat",
              "stale-draft",
              "account-disabled",
              "account-unavailable",
              "unsupported-model",
              "queue-full",
              "chat-read-only",
              "consent-required",
              "runtime-unqualified",
              "managed-unavailable",
            ].includes(refusal);
          // A refusal was not sent, so the next try is a new request. Anything else may have landed.
          if (refused) entry.intent = null;
          entry.error = error.message;
          failure(error);
          if (refused && outbox.length === 1 && !draft.value.trim() && !attachments.length) {
            // Refused with nothing written since: the words go back where they were typed.
            outbox.length = 0;
            draft.value = entry.text;
            completion.setReferences(entry.references);
            attachments = [...entry.attachments];
            renderAttachments();
            status.textContent += " Your message has been kept.";
            break;
          }
          // Nothing behind a message that did not go is sent ahead of it.
          for (const waiting of outbox) waiting.state = "failed";
          if (!refused) status.textContent += " Retry sends the same request; it will not create a duplicate.";
          break;
        }
        outbox.shift();
        // The daemon took the draft with the message: its next revision is the empty one.
        baseDraftRevision = entry.intent.draftRevision + 1;
        state.draftRevision = baseDraftRevision;
        state.draftReferences = [];
        lastDraft = "";
        await refresh().catch(failure);
      }
    } finally {
      pending = false;
      if (!disposed) {
        dirty ||=
          draft.value !== lastDraft ||
          JSON.stringify(completion.references) !== JSON.stringify(state?.draftReferences ?? []);
        if (dirty) scheduleSave();
        render();
      }
    }
  }
  draft.addEventListener("input", () => {
    dirty =
      draft.value !== lastDraft ||
      JSON.stringify(completion.references) !== JSON.stringify(state?.draftReferences ?? []);
    scheduleSave();
  });
  draft.addEventListener("keydown", (event) => {
    if (
      !event.defaultPrevented &&
      !event.isComposing &&
      event.keyCode !== 229 &&
      event.key === "Enter" &&
      !event.shiftKey
    ) {
      event.preventDefault();
      void submit();
    }
  });
  files.addEventListener("change", () => {
    if (uploading || changingAccount || changingSettings) return;
    const selectedFiles = [...files.files];
    uploading = true;
    render();
    void act(async () => {
      files.value = "";
      for (const file of selectedFiles) {
        const attachment = await dataAccess.uploadChatAttachment(slug, chatId, file);
        if (disposed) return;
        attachments = [...attachments, attachment];
        dirty = true;
        renderAttachments();
        await save();
      }
    }).finally(() => {
      uploading = false;
      renderControls();
      render();
    });
  });
  title.addEventListener(
    "change",
    () =>
      void act(() =>
        dataAccess.changeChat(slug, chatId, {
          requestId: crypto.randomUUID(),
          revision: state.configRevision,
          title: title.value,
        }),
      ),
  );
  function effortLevels() {
    const models = catalog?.capabilities?.[state.profileId]?.models ?? [];
    return effortLadder(models.find((m) => m.id === state.settings.model)?.efforts ?? []);
  }
  // A press moves the shown level at once and the save follows it: presses made while a save is in
  // flight retarget it, and one that fails puts the control back on the level the chat really has.
  async function stepEffort(step) {
    const levels = effortLevels();
    if (effort.disabled || levels.length < 2) return;
    const at = levels.indexOf(effortTarget ?? state.settings.effort);
    effortTarget = levels[at < 0 ? 0 : (at + step + levels.length) % levels.length];
    renderControls();
    effortAnnounce.textContent = `Effort: ${effortPresentation(effortTarget).label}`;
    if (effortSaving) return;
    effortSaving = true;
    try {
      while (effortTarget !== null && effortTarget !== state.settings.effort)
        if (!(await changeSettings(state.settings.model, effortTarget))) break;
    } finally {
      effortSaving = false;
      if (effortTarget !== state.settings.effort)
        effortAnnounce.textContent = `Effort: ${effortPresentation(state.settings.effort).label}`;
      effortTarget = null;
      renderControls();
    }
  }
  async function changeSettings(modelId, desiredEffort) {
    if (changingAccount || changingSettings || outbox.length) return false;
    changingSettings = true;
    const supported =
      catalog?.capabilities?.[state.profileId]?.models.find((entry) => entry.id === modelId)?.efforts ?? [];
    const settings = {
      model: modelId,
      effort:
        desiredEffort ?? (supported.includes(state.settings.effort) ? state.settings.effort : (supported[0] ?? "")),
      permissionMode: state.settings.permissionMode,
    };
    render();
    try {
      return await act(() =>
        dataAccess.changeChat(slug, chatId, {
          requestId: crypto.randomUUID(),
          revision: state.configRevision,
          settings,
        }),
      );
    } finally {
      changingSettings = false;
      renderControls();
      render();
    }
  }
  async function changeAccount(profileId) {
    if (changingAccount || changingSettings || uploading || outbox.length) return false;
    const generation = ++accountGeneration;
    changingAccount = true;
    render();
    try {
      return await act(
        async () => {
          const profile = catalog.profiles.find((entry) => entry.id === profileId);
          if (
            !profile ||
            !profile.enabled ||
            profile.removed ||
            (profile.auth && profile.auth.state !== "authenticated")
          )
            throw new Error("Sign in to this subscription in Settings first.");
          let models = catalog.capabilities?.[profile.id]?.models ?? [];
          if (!models.length && dataAccess.discoverAgentModels) {
            status.textContent = `Loading ${agentName(profile.provider)} models…`;
            await dataAccess.discoverAgentModels(profile.id);
            if (disposed || generation !== accountGeneration) return;
            const nextCatalog = await dataAccess.getAgentStatus();
            if (disposed || generation !== accountGeneration) return;
            catalog = nextCatalog;
            models = catalog.capabilities?.[profile.id]?.models ?? [];
          }
          const current = catalog.capabilities?.[state.profileId]?.models.find(
            (entry) => entry.id === state.settings.model,
          );
          const sameProvider = profile.provider === state.provider;
          if (!models.length)
            throw new Error("Load this subscription’s models in Settings first. Your chat is unchanged.");
          const target = sameProvider
            ? (models.find(
                (entry) =>
                  entry.id === state.settings.model &&
                  (!current?.resolvedModel || entry.resolvedModel === current.resolvedModel),
              ) ??
              (current?.resolvedModel && models.find((entry) => entry.resolvedModel === current.resolvedModel)))
            : models[0];
          const settings = {
            model: target ? target.id : "",
            effort: target
              ? target.efforts.includes(state.settings.effort)
                ? state.settings.effort
                : (target.efforts[0] ?? "")
              : "",
            permissionMode: state.settings.permissionMode,
          };
          if (state.turns.length && !sameProvider) {
            await save();
            if (disposed || generation !== accountGeneration) return;
            await onNewChat?.(profile, settings);
          } else {
            await dataAccess.changeChat(slug, chatId, {
              requestId: crypto.randomUUID(),
              revision: state.configRevision,
              provider: profile.provider,
              profileId: profile.id,
              settings,
            });
            status.textContent = target
              ? `Using ${profile.label} for this chat.`
              : `Using ${profile.label}. Choose a model available on this subscription.`;
          }
        },
        () => !disposed && generation === accountGeneration,
      );
    } finally {
      if (!disposed && generation === accountGeneration) {
        changingAccount = false;
        renderControls();
        render();
      }
    }
  }
  handle.ready = (async () => {
    catalog = await dataAccess.getAgentStatus();
    await refresh();
    await refreshFeedback();
    if (disposed) return;
    void refreshToolsLine();
    status.textContent = catalog.reason ?? "";
    connectStream();
  })().catch(failure);
  function connectStream() {
    stopStream?.();
    stopStream = dataAccess.openChatStream(
      slug,
      chatId,
      {
        onEvent(frame) {
          if (disposed) return;
          if (frame.event === "chat_snapshot") {
            if (state && frame.data.revision <= state.revision) return;
            if (!dirty && !outbox.length) {
              state = frame.data;
              if (draft.value !== state.draft) draft.value = state.draft;
              completion.setReferences(state.draftReferences);
              lastDraft = state.draft;
              attachments = state.draftAttachments;
              baseDraftRevision = state.draftRevision;
              renderAttachments();
            } else state = frame.data;
            renderControls();
            render();
          } else if (frame.event === "chat_event") {
            const next = applyChatEvent(state, frame.data);
            if (next) {
              state = next;
              render();
            } else void refresh().catch(failure);
          }
        },
        onStatus(value) {
          const reconnecting = "Reconnecting · no messages are sent automatically";
          if (value === "down") status.textContent = reconnecting;
          else if (status.textContent === reconnecting) status.textContent = catalog.reason ?? "";
        },
      },
      pageBefore,
    );
  }
  return handle;
}

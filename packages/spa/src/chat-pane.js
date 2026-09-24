// SPDX-License-Identifier: Apache-2.0

import { mountAgentLogin } from "./agent-login.js";
import { mountMcpSettings } from "./agent-mcp-settings.js";
import { actionMenu, agentIcon, agentName, effortIcon, effortPresentation, modelPresentation } from "./agent-ui.js";
import { loadChatMarkdown } from "./chat-markdown.js";
import { confirmDialog } from "./dialog.js";
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
  },
) {
  let state,
    catalog,
    disposed = false,
    dirty = false,
    timer,
    saving = Promise.resolve(),
    sendIntent,
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
    uploading = false,
    stopping = false;
  const lifetime = new AbortController();
  const rows = new Map(),
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
  const field = (label, input) =>
    el("label", { className: "glosa-chat-field" }, [
      el("span", { className: "glosa-visually-hidden", textContent: label }),
      input,
    ]);
  const account = el("select", { "aria-label": "Agent account" });
  const model = el("select", { "aria-label": "Model" });
  const effort = el("select", { "aria-label": "Effort" });
  const modelField = field("Model", model),
    effortField = field("Effort", effort);
  effortField.classList.add("glosa-chat-effort-field");
  const modelTip = el("span", {
    className: "glosa-control-tooltip",
    role: "tooltip",
    id: `model-tip-${crypto.randomUUID()}`,
  });
  const effortTip = el("span", {
    className: "glosa-control-tooltip",
    role: "tooltip",
    id: `effort-tip-${crypto.randomUUID()}`,
  });
  model.setAttribute("aria-describedby", modelTip.id);
  effort.setAttribute("aria-describedby", effortTip.id);
  modelField.append(modelTip);
  effortField.append(effortTip);
  const tooltipFields = [modelField, effortField];
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
  const history = el("div", { className: "glosa-chat-history", tabIndex: 0, "aria-label": "Chat messages" });
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
    textContent: "Send ↑",
    className: "glosa-agent-primary",
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
      void act(() => dataAccess.stopChat(slug, chatId)).finally(() => {
        stopping = false;
        render();
      });
    },
  });
  const jump = el("button", {
    className: "glosa-chat-jump",
    type: "button",
    textContent: "New activity ↓",
    hidden: true,
    onClick: () => {
      history.scrollTop = history.scrollHeight;
      jump.hidden = true;
    },
  });
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
          if (uploading || changingAccount || changingSettings || pending || sendIntent) return;
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
          if (uploading || changingAccount || changingSettings || pending || sendIntent) return;
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

  const mcp = el("details", { className: "glosa-chat-mcp" }, [
      el("summary", { textContent: "Tools & workspace access" }),
    ]),
    mcpHost = el("div");
  mcp.append(mcpHost);
  mcp.addEventListener("toggle", () => {
    if (!mcp.open && nativeLogin) {
      void nativeLogin.destroy();
      nativeLogin = null;
    }
    if (!mcp.open || !state) return;
    void act(async () => {
      const profileId = state.profileId,
        policy = await dataAccess.getMcpPolicy(slug, profileId);
      if (disposed || state.profileId !== profileId) return;
      mcpHost.replaceChildren();
      mountMcpSettings(mcpHost, {
        servers: policy.servers,
        onSave: async (servers) => {
          await dataAccess.setMcpPolicy(slug, profileId, { revision: policy.revision, servers });
          mcp.open = false;
        },
        onReset: async () => {
          await dataAccess.setMcpPolicy(slug, profileId, { revision: policy.revision, servers: null });
          mcp.open = false;
        },
      });
    });
  });
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
        title: "Open native MCP sign-in?",
        body: "Stop this account's active chats first. The agent will connect the enabled servers using this workspace's approved configuration. Credentials stay in this account's private native storage.",
        confirmLabel: "Open native sign-in",
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
        mcp.open = false;
      },
    });
  }
  mcp.append(
    el("button", {
      type: "button",
      textContent: "Check native connections",
      onClick: () =>
        void act(async () => {
          const result = await dataAccess.nativeChatMcp(slug, chatId);
          const inventory = el("div", { role: "status" });
          for (const server of result.servers) {
            const row = el("p", { textContent: `${server.name} · ${server.status} · authentication ${server.auth}` });
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
      textContent: "Open native MCP sign-in",
      onClick: () => void act(() => openMcpManager(undefined)),
    }),
    el("button", {
      type: "button",
      textContent: "Revoke workspace access",
      onClick: () =>
        void act(async () => {
          await dataAccess.setAgentConsent(state.profileId, slug, false);
          status.textContent = "Workspace access revoked. Its runs have stopped.";
        }),
    }),
  );
  controls.append(field("Account", account), modelField, effortField);
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
  const queueNotice = el("p", { className: "glosa-chat-queue-notice", hidden: true });
  const attach = el("button", {
    type: "button",
    className: "glosa-chat-attach glosa-icon-button",
    textContent: "+",
    "aria-label": "Add attachments",
    title: "Attach documents or images",
    onClick: () => files.click(),
  });
  const composer = el("div", { className: "glosa-chat-composer" }, [
    draft,
    attachmentList,
    queueNotice,
    el("div", { className: "glosa-chat-compose-actions" }, [
      attach,
      files,
      el("span", { className: "glosa-chat-action-spacer" }),
      controls,
      stop,
      send,
    ]),
  ]);
  const footer = el("div", { className: "glosa-chat-footer" }, [
    status,
    el("span", { className: "glosa-chat-key-hint", textContent: "Enter to send · Shift Enter for a new line" }),
  ]);
  root.append(
    header,
    transfer,
    pageControls,
    history,
    jump,
    decisions,
    readiness,
    composer,
    el("div", { className: "glosa-chat-utilities" }, [mcp, feedback]),
    footer,
  );
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
      accountGeneration++;
      lifetime.abort();
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
        (!dirty && !uploading && !changingSettings) ||
        (await confirmDialog({
          title: uploading || changingSettings ? "Close with unfinished changes?" : "Close with an unsaved draft?",
          body:
            uploading || changingSettings
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
  }
  async function act(fn, current = () => !disposed) {
    try {
      await fn();
      if (current()) await refresh();
    } catch (error) {
      if (!current()) return;
      failure(error);
      renderControls();
    }
  }
  function pick(select, values, selected, fallbackLabel = selected || "Choose…") {
    const entries = values.some((v) => v.id === selected) ? values : [{ id: selected, name: fallbackLabel }, ...values];
    const options = [...select.options];
    if (
      options.length !== entries.length ||
      entries.some((entry, index) => options[index]?.value !== entry.id || options[index]?.textContent !== entry.name)
    )
      select.replaceChildren(...entries.map((v) => el("option", { value: v.id, textContent: v.name })));
    if (select.value !== selected) select.value = selected;
    // Size to the selected label, not the longest option in the account catalog.
    const selectedLabel = select.selectedOptions[0]?.textContent ?? "Choose…";
    select.parentElement.dataset.selection = selectedLabel;
  }
  function renderControls() {
    if (!state) return;
    pick(
      account,
      (catalog?.profiles ?? []).filter((p) => p.enabled && !p.removed).map((p) => ({ id: p.id, name: p.label })),
      state.profileId,
    );
    const models = catalog?.capabilities?.[state.profileId]?.models ?? [];
    pick(
      model,
      models.map((entry) => ({ ...entry, name: modelPresentation(entry).label })),
      state.settings.model,
      modelPresentation({ id: state.settings.model, name: state.settings.model }).label,
    );
    pick(
      effort,
      (models.find((m) => m.id === state.settings.model)?.efforts ?? []).map((id) => ({
        id,
        name: effortPresentation(id).label,
      })),
      state.settings.effort,
      effortPresentation(state.settings.effort).label,
    );
    const profile = catalog?.profiles?.find((p) => p.id === state.profileId);
    const accountReady =
      !!profile?.enabled && !profile.removed && (!profile.auth || profile.auth.state === "authenticated");
    const selectedModel = models.find((m) => m.id === state.settings.model);
    readyToSend =
      accountReady &&
      !!selectedModel &&
      (!state.settings.effort || selectedModel.efforts.includes(state.settings.effort));
    account.disabled = changingSettings || uploading || pending || !!sendIntent;
    model.disabled = changingAccount || changingSettings || !models.length;
    effort.disabled = changingAccount || changingSettings || !selectedModel?.efforts.length;
    readiness.hidden = readyToSend || !catalog?.available || state.archived;
    readinessText.textContent = !accountReady
      ? "This account needs attention before it can send."
      : !models.length
        ? "Load this account’s models to continue."
        : "Choose an available model and effort to continue.";
    loadModels.hidden = !accountReady;
    manageAccount.hidden = accountReady;
    identity.replaceChildren(agentIcon(state.provider));
    identity.title = agentName(state.provider);
    account.title = state.turns.length
      ? "Changing account starts a fresh chat. You can move your draft there."
      : "Choose the account for this chat";
    const selectedModelDisplay = modelPresentation(
      selectedModel ?? { id: state.settings.model, name: state.settings.model },
    );
    modelTip.textContent = `${selectedModelDisplay.label} · ${selectedModelDisplay.description} Applies to your next message.`;
    const selectedEffort = effortPresentation(state.settings.effort);
    effortTip.textContent = `${selectedEffort.label} effort · ${selectedEffort.description} Applies to your next message.`;
    for (const option of effort.options) option.title = effortPresentation(option.value).description;
    effortField.querySelector(".glosa-effort-mark")?.remove();
    effortField.append(effortIcon(state.settings.effort));
    menu.popup.querySelector('[data-chat-action="pin"]').textContent = state.pinned ? "Unpin chat" : "Pin chat";
    menu.popup.querySelector('[data-chat-action="archive"]').textContent = state.archived
      ? "Restore chat"
      : "Archive chat";
    if (document.activeElement !== title) title.value = state.title;
  }
  function textRow(key, label, text, collapsible = false, markdown = false) {
    wantedRows.add(key);
    let row = rows.get(key);
    if (!row) {
      const node = el(collapsible ? "details" : "article", {
        className: "glosa-chat-message",
        "data-kind": key.startsWith("user:")
          ? "human"
          : key.startsWith("error:")
            ? "error"
            : collapsible
              ? "detail"
              : "agent",
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
  function selectionChanged() {
    if (window.getSelection?.()?.isCollapsed) render();
  }
  document.addEventListener("selectionchange", selectionChanged);
  function renderMessages() {
    render();
  }
  function render() {
    if (!state || disposed) return;
    const following = history.scrollHeight - history.scrollTop - history.clientHeight < 64;
    handle.title = state.title;
    handle.provider = state.provider;
    if (sourceChatId && state.turns.length && transfer.children.length) {
      menu.popup.append(...transfer.children);
      transfer.hidden = true;
    }
    wantedRows = new Set();
    empty.hidden = !!state.turns.length;
    pageControls.hidden = !state.page?.hasEarlier && !state.page?.hasLater;
    older.disabled = !state.page?.hasEarlier || paging;
    recent.hidden = !state.page?.hasLater;
    for (const turn of state.turns) {
      if (typeof turn.text === "string")
        textRow(`user:${turn.id}`, `You · ${turn.status.replaceAll("_", " ")}`, turn.text);
      if (typeof turn.text === "string" && turn.settings)
        textRow(
          `settings:${turn.id}`,
          "Model and effort",
          `Requested: ${turn.settings.model} · ${turn.settings.effort || "default"}\nReported: ${turn.effective?.model ?? "unknown"} · effort ${turn.effective?.effort ?? "unknown"}`,
          true,
        );
      for (const item of state.content.filter((c) => c.turnId === turn.id))
        textRow(
          `${turn.id}:${item.id}`,
          item.kind === "tool"
            ? `${item.name} · ${item.status}`
            : item.kind === "reasoning"
              ? "Reasoning summary"
              : "Assistant",
          item.text + (item.truncated ? "\n\nDisplay shortened. Export the chat for the complete message." : ""),
          ["tool", "reasoning"].includes(item.kind),
          item.kind === "text",
        );
      if (turn.error && (typeof turn.text === "string" || state.content.some((item) => item.turnId === turn.id)))
        textRow(`error:${turn.id}`, "Needs attention", turn.error);
      const waiting = ["accepted", "queued", "held"].includes(turn.status);
      const waitingKey = `pending:${turn.id}`;
      if (waiting) wantedRows.add(waitingKey);
      if (waiting && !rows.has(waitingKey)) {
        const node = el("div", { className: "glosa-chat-actions" }, [
          el("button", {
            textContent: "Continue held message",
            "data-continue-turn": "true",
            type: "button",
            onClick: () => void act(() => dataAccess.resumeChatTurn(slug, chatId, turn.id)),
          }),
          el("button", {
            textContent: "Cancel queued message",
            type: "button",
            onClick: () => void act(() => dataAccess.stopChat(slug, chatId, turn.id)),
          }),
        ]);
        history.append(node);
        rows.set(waitingKey, { node });
      }
      if (waiting) {
        rows.get(waitingKey).node.querySelector("[data-continue-turn]").hidden = turn.status !== "held";
      } else {
        rows.get(waitingKey)?.node.remove();
        rows.delete(waitingKey);
      }
      const reuseKey = `reuse:${turn.id}`;
      if (turn.status === "cancelled" && typeof turn.text === "string" && turn.origin !== "feedback") {
        wantedRows.add(reuseKey);
        if (!rows.has(reuseKey)) {
          const node = el("div", { className: "glosa-chat-actions" }, [
            el("button", {
              type: "button",
              textContent: "Use message as draft",
              onClick: () =>
                void act(async () => {
                  if (pending || sendIntent || uploading || changingAccount || changingSettings) return;
                  if (
                    (draft.value.trim() || attachments.length) &&
                    !(await confirmDialog({
                      title: "Replace this draft?",
                      body: "The cancelled message will replace the current unsent draft and its attachments.",
                      confirmLabel: "Replace draft",
                      danger: true,
                    }))
                  )
                    return;
                  if (disposed) return;
                  draft.value = turn.text;
                  attachments = [...(turn.attachments ?? [])];
                  dirty = true;
                  renderAttachments();
                  await save();
                  draft.focus();
                }),
            }),
          ]);
          history.append(node);
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
            "aria-label": `${question.question} — your answer`,
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
    const unconfirmedStop = ["unknown", "stopping"].includes(state.runtime?.state);
    const hasWork = state.turns.some((t) =>
      ["accepted", "queued", "held", "dispatching", "running", "waiting", "stopping"].includes(t.status),
    );
    stop.disabled = stopping || (!hasWork && !unconfirmedStop);
    stop.hidden = !hasWork && !unconfirmedStop && !stopping;
    stop.textContent = stopping ? "Stopping…" : unconfirmedStop ? "Retry stop" : "Stop";
    const active = state.turns.findLast((t) => ["dispatching", "running", "waiting"].includes(t.status));
    activity.textContent = state.archived
      ? "Archived"
      : unconfirmedStop
        ? "Stop not confirmed"
        : active
          ? active.status === "waiting"
            ? "Needs your reply"
            : "Working…"
          : "";
    activity.dataset.working = String(!!active);
    handle.attentionCount = state.decisions.filter((decision) => decision.status === "pending").length;
    handle.activityLabel = activity.textContent;
    const editing = changingAccount || changingSettings || uploading;
    const queued = state.turns.some((turn) => ["accepted", "queued", "held"].includes(turn.status));
    queueNotice.hidden = !queued;
    queueNotice.textContent = "A message is waiting. Model and effort changes apply after it.";
    feedback.disabled = pending || editing || !catalog?.available || state.archived || queued;
    send.disabled =
      pending || editing || (!sendIntent && (!catalog?.available || state.archived || !readyToSend || queued));
    send.textContent = pending
      ? "Sending…"
      : uploading
        ? "Attaching…"
        : changingSettings
          ? "Saving…"
          : sendIntent
            ? "Retry ↑"
            : active
              ? "Queue ↑"
              : "Send ↑";
    send.setAttribute("aria-label", active ? "Queue message" : "Send message");
    draft.disabled = !!state.archived;
    draft.placeholder = state.archived ? "Restore this chat to send a message." : "What would you like to work on?";
    files.disabled = pending || !!sendIntent || editing || !!state.archived;
    attach.disabled = files.disabled;
    account.disabled = changingSettings || uploading || pending || !!sendIntent;
    for (const button of attachmentList.querySelectorAll("button")) button.disabled = pending || !!sendIntent;
    if (state.usage) {
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
            `Token usage · ${value.scope === "native-thread" ? "conversation totals" : "agent-reported totals"}`,
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
      textRow("usage", "Usage & limits", sections.join("\n\n"), true);
    }
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
    if (!dirty && !sendIntent) {
      draft.value = next.draft;
      lastDraft = next.draft;
      attachments = next.draftAttachments;
      baseDraftRevision = next.draftRevision;
      renderAttachments();
    }
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
      if (!dirty || !state || sendIntent) return;
      const text = draft.value,
        sentAttachments = [...attachments],
        revision = baseDraftRevision;
      try {
        const result = await dataAccess.saveChatDraft(slug, chatId, {
          requestId: crypto.randomUUID(),
          revision,
          text,
          attachments: sentAttachments,
        });
        state.draftRevision = result.draftRevision;
        baseDraftRevision = result.draftRevision;
        lastDraft = text;
        dirty = draft.value !== text || JSON.stringify(attachments) !== JSON.stringify(sentAttachments);
        status.textContent = dirty ? "Draft changed while saving" : "Draft saved";
      } catch (error) {
        failure(error);
      }
    });
    await saving;
  }
  async function submit() {
    if (
      pending ||
      changingAccount ||
      changingSettings ||
      uploading ||
      !state ||
      (!sendIntent &&
        (!catalog?.available ||
          state.archived ||
          !readyToSend ||
          state.turns.some((turn) => ["accepted", "queued", "held"].includes(turn.status)))) ||
      !draft.value.trim()
    )
      return;
    pending = true;
    render();
    try {
      await save();
      if (dirty) throw new Error("Save or reconcile the draft before sending. Your local text has been kept.");
      sendIntent ??= {
        requestId: crypto.randomUUID(),
        turnId: crypto.randomUUID(),
        configRevision: state.configRevision,
        draftRevision: state.draftRevision,
        text: draft.value,
        attachments: [...attachments],
      };
      try {
        await dataAccess.sendChatTurn(slug, chatId, sendIntent);
      } catch (error) {
        if (!error.problem?.type?.endsWith("/consent-required")) throw error;
        const policy = await dataAccess.getMcpPolicy?.(slug, state.profileId);
        const servers = (policy?.servers ?? [])
          .filter((server) => server.enabled)
          .map((server) => `${server.label}: ${server.transport === "http" ? server.url : server.command}`)
          .join("\n");
        if (
          !(await confirmDialog({
            title: "Allow this account to work in this workspace?",
            body:
              "The coding agent can read workspace files and receive your messages and attachments through its configured provider. File changes and commands remain subject to its approval mode. This permission lasts until revoked in this workspace." +
              (servers ? `\nEnabled MCP servers may receive this content:\n${servers}` : ""),
            confirmLabel: "Allow and send",
          }))
        ) {
          sendIntent = null;
          return;
        }
        await dataAccess.setAgentConsent(state.profileId, slug, true);
        await dataAccess.sendChatTurn(slug, chatId, sendIntent);
      }
      sendIntent = null;
      dirty = false;
      draft.value = "";
      lastDraft = "";
      attachments = [];
      renderAttachments();
      status.textContent = "Message accepted";
      await refresh();
    } catch (error) {
      const refusal = error.problem?.type?.split("/").pop();
      if (
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
        ].includes(refusal)
      )
        sendIntent = null;
      failure(error);
      if (sendIntent) status.textContent += " Use Send to retry the same request; it will not create a duplicate.";
    } finally {
      pending = false;
      render();
    }
  }
  draft.addEventListener("input", () => {
    if (sendIntent) {
      status.textContent = "The previous submission is unresolved. Retry it before editing this draft.";
      draft.value = sendIntent.text;
      return;
    }
    dirty = draft.value !== lastDraft;
    scheduleSave();
  });
  draft.addEventListener("keydown", (event) => {
    if (!event.isComposing && event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  });
  files.addEventListener("change", () => {
    if (uploading || pending || sendIntent || changingAccount || changingSettings) return;
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
  for (const select of [model, effort])
    select.addEventListener("change", () => {
      if (changingAccount || changingSettings || pending || sendIntent) {
        renderControls();
        return;
      }
      changingSettings = true;
      const settings = {
        model: model.value,
        effort:
          select === model
            ? (catalog?.capabilities?.[state.profileId]?.models.find((m) => m.id === model.value)?.efforts[0] ?? "")
            : effort.value,
        permissionMode: state.settings.permissionMode,
      };
      for (const control of [account, model, effort]) control.disabled = true;
      render();
      void act(() =>
        dataAccess.changeChat(slug, chatId, {
          requestId: crypto.randomUUID(),
          revision: state.configRevision,
          settings,
        }),
      ).finally(() => {
        changingSettings = false;
        renderControls();
        render();
      });
    });
  account.addEventListener("change", () => {
    if (changingSettings || uploading || pending || sendIntent) {
      renderControls();
      return;
    }
    const generation = ++accountGeneration;
    changingAccount = true;
    for (const control of [model, effort]) control.disabled = true;
    render();
    void act(
      async () => {
        const profile = catalog.profiles.find((p) => p.id === account.value);
        if (!profile || (profile.auth && profile.auth.state !== "authenticated"))
          throw new Error("Sign in to this account in Agents & accounts first.");
        let target = catalog.capabilities?.[profile.id]?.models[0];
        if (!target && dataAccess.discoverAgentModels) {
          status.textContent = `Loading ${agentName(profile.provider)} models…`;
          await dataAccess.discoverAgentModels(profile.id);
          if (disposed || generation !== accountGeneration) return;
          const nextCatalog = await dataAccess.getAgentStatus();
          if (disposed || generation !== accountGeneration) return;
          catalog = nextCatalog;
          target = catalog.capabilities?.[profile.id]?.models[0];
        }
        if (!target)
          throw new Error("Load this account’s models in Agents & accounts first. Your current chat is unchanged.");
        const settings = {
          model: target.id,
          effort: target.efforts[0] ?? "",
          permissionMode: state.settings.permissionMode,
        };
        if (state.turns.length) {
          await save();
          if (disposed || generation !== accountGeneration) return;
          await onNewChat?.(profile, settings);
        } else
          await dataAccess.changeChat(slug, chatId, {
            requestId: crypto.randomUUID(),
            revision: state.configRevision,
            provider: profile.provider,
            profileId: profile.id,
            settings,
          });
      },
      () => !disposed && generation === accountGeneration,
    ).finally(() => {
      if (disposed || generation !== accountGeneration) return;
      changingAccount = false;
      renderControls();
      render();
    });
  });
  handle.ready = (async () => {
    catalog = await dataAccess.getAgentStatus();
    await refresh();
    await refreshFeedback();
    if (disposed) return;
    status.textContent = catalog.reason ?? "Drafts save automatically.";
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
            if (!dirty && !sendIntent) {
              state = frame.data;
              if (draft.value !== state.draft) draft.value = state.draft;
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
          else if (status.textContent === reconnecting)
            status.textContent = catalog.reason ?? "Drafts save automatically.";
        },
      },
      pageBefore,
    );
  }
  return handle;
}

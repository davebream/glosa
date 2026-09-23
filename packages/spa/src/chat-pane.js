// SPDX-License-Identifier: Apache-2.0
import { createElement as el } from "./viewer-shell.js";
import { loadChatMarkdown } from "./chat-markdown.js";
import { confirmDialog } from "./dialog.js";
import { mountMcpSettings } from "./agent-mcp-settings.js";
import { mountAgentLogin } from "./agent-login.js";

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
  { dataAccess, slug, chatId, sourceChatId = undefined, onChange, onNewChat, onSettings, onDeleted = () => {} },
) {
  let state,
    catalog,
    disposed = false,
    dirty = false,
    timer,
    saving = Promise.resolve(),
    sendIntent,
    pending = false;
  let attachments = [],
    lastDraft = "",
    baseDraftRevision = 0,
    stopStream;
  let renderMarkdown,
    feedbackIntent,
    pageBefore,
    wantedRows = new Set(),
    paging = false,
    nativeLogin;
  const lifetime = new AbortController();
  const rows = new Map(),
    decisionRows = new Map(),
    decisionIntents = new Map();
  const root = el("section", { className: "glosa-chat-pane" });
  const status = el("p", { className: "glosa-chat-status", role: "status" });
  const title = el("input", { className: "glosa-chat-title", "aria-label": "Chat title", maxLength: 120 });
  const controls = el("div", { className: "glosa-chat-controls" });
  const account = el("select", { "aria-label": "Agent account" });
  const model = el("select", { "aria-label": "Model" });
  const effort = el("select", { "aria-label": "Effort" });
  const mode = el("select", { "aria-label": "Permissions" }, [
    el("option", { value: "default", textContent: "Ask for approval" }),
    el("option", { value: "plan", textContent: "Plan only" }),
  ]);
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
    } finally {
      paging = false;
      if (!disposed) connectStream();
    }
  }
  const decisions = el("div", { className: "glosa-chat-decisions" });
  const draft = el("textarea", {
    className: "glosa-chat-draft",
    placeholder: "What would you like to work on?",
    "aria-label": "Message",
    maxLength: 65536,
    rows: 4,
  });
  const files = el("input", {
    type: "file",
    multiple: true,
    accept: ".md,.txt,image/png,image/jpeg,image/webp",
    "aria-label": "Attach files",
  });
  const attachmentList = el("div", { className: "glosa-chat-attachments" });
  const send = el("button", {
    type: "button",
    textContent: "Send · ↵",
    "aria-label": "Send message",
    onClick: () => void submit(),
  });
  const stop = el("button", {
    type: "button",
    textContent: "Stop",
    onClick: () => void act(() => dataAccess.stopChat(slug, chatId)),
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
  const header = el("header", { className: "glosa-chat-header" }, [
    title,
    el("button", { type: "button", textContent: "Agents", onClick: onSettings }),
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
  ]);
  const feedback = el("button", {
    type: "button",
    textContent: "Send feedback",
    onClick: () =>
      void act(async () => {
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
    header.append(
      el("button", {
        type: "button",
        textContent: "Move previous draft here",
        onClick: () =>
          void act(async () => {
            await save();
            const source = await dataAccess.getChat(slug, sourceChatId);
            moveIntent ??= {
              requestId: crypto.randomUUID(),
              sourceId: sourceChatId,
              sourceRevision: source.draftRevision,
              targetRevision: state.draftRevision,
            };
            const result = await dataAccess.moveChatDraft(slug, chatId, moveIntent);
            moveIntent = null;
            status.textContent = result.sourceCleared
              ? "Draft moved. Nothing has been sent."
              : "Draft copied. A newer draft remains in the previous chat.";
          }),
      }),
    );
    header.append(
      el("button", {
        type: "button",
        textContent: "Attach previous conversation",
        onClick: () =>
          void act(async () => {
            const text = await dataAccess.exportChat(slug, sourceChatId);
            const file = new File([text], "previous-conversation.md", { type: "text/markdown" });
            if (file.size > 10 * 1024 * 1024)
              throw new Error("The transcript exceeds 10 MiB. Export it and attach a shorter excerpt.");
            const accepted = await new Promise((resolve) => {
              const previous = document.activeElement,
                dialog = el("dialog", { className: "glosa-dialog", "aria-label": "Preview conversation attachment" });
              dialog.append(
                el("h2", { textContent: "Attach this frozen transcript?" }),
                el("p", { textContent: "The selected agent receives this copy only when you send your next message." }),
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
                  dialog.remove();
                  previous?.focus();
                },
                { once: true },
              );
              document.body.append(dialog);
              dialog.showModal();
            });
            if (!accepted || disposed) return;
            attachments.push(await dataAccess.uploadChatAttachment(slug, chatId, file));
            dirty = true;
            renderAttachments();
            await save();
          }),
      }),
    );
  }
  async function refreshFeedback() {
    if (!dataAccess.getChatFeedback) return;
    const value = await dataAccess.getChatFeedback(slug, chatId);
    if (!disposed) feedback.textContent = `Send feedback · ${value.entryIds.length}${value.hasMore ? "+" : ""}`;
  }
  header.append(
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
  controls.append(feedback);
  const mcp = el("details", { className: "glosa-chat-mcp" }, [el("summary", { textContent: "Workspace MCP servers" })]),
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
  controls.append(
    account,
    model,
    effort,
    mode,
    el("button", {
      type: "button",
      textContent: "Refresh accounts",
      onClick: () =>
        void act(async () => {
          catalog = await dataAccess.getAgentStatus();
        }),
    }),
  );
  header.append(
    el("button", {
      type: "button",
      textContent: "Pin / unpin",
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
      textContent: "Archive / restore",
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
  root.append(
    header,
    pageControls,
    history,
    jump,
    decisions,
    status,
    controls,
    mcp,
    draft,
    attachmentList,
    el("div", { className: "glosa-chat-actions" }, [files, stop, send]),
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
      lifetime.abort();
      clearTimeout(timer);
      stopStream?.();
      document.removeEventListener("selectionchange", selectionChanged);
      root.remove();
    },
    async confirmClose() {
      await save();
      return (
        !dirty ||
        (await confirmDialog({
          title: "Close with an unsaved draft?",
          body: "Copy the draft first if you want to keep it. The agent keeps running when its tab closes.",
          confirmLabel: "Close tab",
          danger: true,
        }))
      );
    },
  };
  function failure(error) {
    status.textContent = error.message || "The chat could not be updated.";
  }
  async function act(fn) {
    try {
      await fn();
      await refresh();
    } catch (error) {
      failure(error);
    }
  }
  function pick(select, values, selected) {
    const entries = values.some((v) => v.id === selected)
      ? values
      : [{ id: selected, name: `${selected || "Unavailable"} · unavailable` }, ...values];
    const options = [...select.options];
    if (
      options.length !== entries.length ||
      entries.some((entry, index) => options[index]?.value !== entry.id || options[index]?.textContent !== entry.name)
    )
      select.replaceChildren(...entries.map((v) => el("option", { value: v.id, textContent: v.name })));
    if (select.value !== selected) select.value = selected;
  }
  function renderControls() {
    if (!state) return;
    pick(
      account,
      (catalog?.profiles ?? [])
        .filter((p) => p.enabled && !p.removed)
        .map((p) => ({ id: p.id, name: `${p.provider} · ${p.label}` })),
      state.profileId,
    );
    const models = catalog?.capabilities?.[state.profileId]?.models ?? [];
    pick(model, models, state.settings.model);
    pick(
      effort,
      (models.find((m) => m.id === state.settings.model)?.efforts ?? []).map((id) => ({ id, name: id })),
      state.settings.effort,
    );
    mode.value = state.settings.permissionMode;
    if (document.activeElement !== title) title.value = state.title;
  }
  function textRow(key, label, text, collapsible = false, markdown = false) {
    wantedRows.add(key);
    let row = rows.get(key);
    if (!row) {
      const node = el(collapsible ? "details" : "article", { className: "glosa-chat-message" });
      const heading = el(collapsible ? "summary" : "h3", { textContent: label });
      const content = el("div", { className: "glosa-chat-text" });
      const copy = el("button", {
        type: "button",
        textContent: "Copy",
        "aria-label": `Copy ${label}`,
        onClick: () => {
          void navigator.clipboard.writeText(row.text).catch(() => {
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
    wantedRows = new Set();
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
      if (turn.status === "held") wantedRows.add(`held:${turn.id}`);
      if (turn.status === "held" && !rows.has(`held:${turn.id}`)) {
        const node = el("div", { className: "glosa-chat-actions" }, [
          el("button", {
            textContent: "Continue held message",
            type: "button",
            onClick: () => void act(() => dataAccess.resumeChatTurn(slug, chatId, turn.id)),
          }),
          el("button", {
            textContent: "Cancel message",
            type: "button",
            onClick: () => void act(() => dataAccess.stopChat(slug, chatId, turn.id)),
          }),
        ]);
        history.append(node);
        rows.set(`held:${turn.id}`, { node });
      } else if (turn.status !== "held") {
        rows.get(`held:${turn.id}`)?.node.remove();
        rows.delete(`held:${turn.id}`);
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
    stop.disabled = !state.turns.some((t) =>
      ["accepted", "queued", "held", "dispatching", "running", "waiting"].includes(t.status),
    );
    feedback.disabled = pending || !catalog?.available || state.archived;
    send.disabled = pending || !catalog?.available || state.archived;
    files.disabled = pending || !!sendIntent;
    for (const button of attachmentList.querySelectorAll("button")) button.disabled = pending || !!sendIntent;
    if (state.usage) {
      const usage = Object.entries(state.usage)
        .map(([key, value]) => `${key}: ${value ?? "unavailable"}`)
        .join(" · ");
      textRow("usage", "Usage · reported by the agent · cost estimates are not invoices", usage, true);
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
    if (following) history.scrollTop = history.scrollHeight;
    else jump.hidden = false;
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
    if (pending || !state || !draft.value.trim()) return;
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
  files.addEventListener(
    "change",
    () =>
      void act(async () => {
        for (const file of files.files) attachments.push(await dataAccess.uploadChatAttachment(slug, chatId, file));
        files.value = "";
        dirty = true;
        renderAttachments();
        await save();
      }),
  );
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
  for (const select of [model, effort, mode])
    select.addEventListener(
      "change",
      () =>
        void act(() =>
          dataAccess.changeChat(slug, chatId, {
            requestId: crypto.randomUUID(),
            revision: state.configRevision,
            settings: {
              model: model.value,
              effort:
                select === model
                  ? (catalog?.capabilities?.[state.profileId]?.models.find((m) => m.id === model.value)?.efforts[0] ??
                    "")
                  : effort.value,
              permissionMode: mode.value,
            },
          }),
        ),
    );
  account.addEventListener(
    "change",
    () =>
      void act(async () => {
        const profile = catalog.profiles.find((p) => p.id === account.value);
        const target = catalog.capabilities?.[profile.id]?.models[0];
        if (!target) throw new Error("Load this account's models in Agents first.");
        const settings = {
          model: target.id,
          effort: target.efforts[0] ?? "",
          permissionMode: state.settings.permissionMode,
        };
        if (state.turns.length) {
          await save();
          await onNewChat?.(profile, settings);
        } else
          await dataAccess.changeChat(slug, chatId, {
            requestId: crypto.randomUUID(),
            revision: state.configRevision,
            provider: profile.provider,
            profileId: profile.id,
            settings,
          });
      }),
  );
  handle.ready = (async () => {
    catalog = await dataAccess.getAgentStatus();
    await refresh();
    await refreshFeedback();
    if (disposed) return;
    status.textContent = catalog.reason ?? "Changes to model and effort apply to your next message.";
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
            status.textContent = catalog.reason ?? "Changes to model and effort apply to your next message.";
        },
      },
      pageBefore,
    );
  }
  return handle;
}

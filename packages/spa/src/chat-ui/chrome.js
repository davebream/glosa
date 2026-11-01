// SPDX-License-Identifier: Apache-2.0
// Established desk controls live in opaque React slots; their descendants have one DOM owner.

import { mountAgentLogin } from "../agent-login.js";
import { mountMcpSettings } from "../agent-mcp-settings.js";
import {
  actionMenu,
  agentIcon,
  agentName,
  effortIcon,
  effortLadder,
  effortPresentation,
  modelPicker,
} from "../agent-ui.js";
import { confirmDialog, noticeDialog } from "../dialog.js";
import { createElement as el } from "../viewer-shell.js";

export function createChatChrome(
  store,
  { dataAccess, slug, chatId, sourceChatId, onSettings, onNewChat, onOpenLog, onDeleted },
) {
  const lifetime = new AbortController();
  const dialogs = new Set();
  let disposed = false,
    nativeLogin,
    effortTarget = null,
    effortSaving = false,
    moveIntent;
  const run = async (work) => {
    try {
      return await work();
    } catch (error) {
      if (!disposed) {
        store.fail(error);
        picker.error(error.message);
      }
      return false;
    }
  };
  const current = () => store.getSnapshot();
  const title = el("input", { className: "glosa-chat-title", "aria-label": "Chat title", maxLength: 120 });
  title.addEventListener("change", () => void run(() => store.change({ title: title.value })));
  const identity = el("span", { className: "glosa-chat-identity" });
  const activity = el("span", { className: "glosa-chat-activity", role: "status" });
  const menu = actionMenu("Chat actions");
  const header = el("header", { className: "glosa-chat-header" }, [identity, title, activity, menu.element]);
  const controls = el("div", { className: "glosa-chat-controls" });
  const picker = modelPicker({ onModel: (id) => changeSettings(id), onProfile: (id) => changeAccount(id), onSettings });
  const effortMark = effortIcon("");
  const effortLabel = el("span", { className: "glosa-chat-effort-label" });
  const effortTip = el("span", {
    className: "glosa-control-tooltip",
    role: "tooltip",
    id: `effort-${crypto.randomUUID()}`,
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
  for (const event of ["mouseenter", "focusin"])
    effortField.addEventListener(event, () => delete effortField.dataset.tooltipDismissed);
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape") effortField.dataset.tooltipDismissed = "true";
    },
    { signal: lifetime.signal },
  );
  controls.append(picker.element, effortField);
  const footer = el("div", { className: "glosa-chat-footer" });
  const toolsLine = el("button", {
    type: "button",
    className: "glosa-chat-tools-line",
    textContent: "Tools and access",
    onClick: () => void openTools(),
  });
  const feedback = el("button", {
    type: "button",
    textContent: "Send feedback",
    hidden: !dataAccess.getChatFeedback,
    onClick: () =>
      void run(async () => {
        await store.feedback();
        await refreshFeedback();
      }),
  });
  const keyHint = el("span", { className: "glosa-chat-key-hint" });
  footer.append(toolsLine, feedback, keyHint);
  const toolsHost = el("div");
  const tools = el(
    "dialog",
    { className: "glosa-dialog glosa-chat-tools", "aria-label": "Tools and workspace access" },
    [el("h2", { textContent: "Tools and workspace access" }), toolsHost],
  );
  tools.addEventListener("close", () => {
    tools.remove();
    void nativeLogin?.destroy();
    nativeLogin = null;
  });
  tools.addEventListener("click", (event) => {
    if (event.target === tools) tools.close();
  });
  dialogs.add(tools);
  const usage = el("button", {
    type: "button",
    textContent: "Usage and limits",
    "data-chat-action": "usage",
    hidden: true,
    onClick: () => void noticeDialog({ title: "Usage and limits", body: usageText(current()), dismissLabel: "Close" }),
  });
  const pin = el("button", {
    type: "button",
    textContent: "Pin chat",
    "data-chat-action": "pin",
    onClick: () => void run(() => store.change({ pinned: !current().chat.pinned })),
  });
  const archive = el("button", {
    type: "button",
    textContent: "Archive chat",
    "data-chat-action": "archive",
    onClick: () =>
      void run(async () => {
        if (
          current().chat.archived ||
          (await confirmDialog({
            title: "Archive this chat?",
            body: "The chat leaves the active list. Its history remains available.",
            confirmLabel: "Archive",
          }))
        )
          await store.change({ archived: !current().chat.archived });
      }),
  });
  menu.popup.append(
    el("button", { type: "button", textContent: "Agents & accounts", onClick: onSettings }),
    el("button", { type: "button", textContent: "Protocol log", hidden: !onOpenLog, onClick: () => onOpenLog?.() }),
    el("button", {
      type: "button",
      textContent: "Export",
      onClick: () =>
        void run(async () => {
          const content = await dataAccess.exportChat(slug, chatId);
          const url = URL.createObjectURL(new Blob([content], { type: "text/markdown" }));
          el("a", { href: url, download: `chat-${chatId}.md` }).click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }),
    }),
    el("button", {
      type: "button",
      textContent: "Refresh accounts",
      onClick: () => void run(() => store.refreshCatalog()),
    }),
    usage,
    el("button", {
      type: "button",
      textContent: "Tools and workspace access",
      "data-chat-action": "tools",
      onClick: () => void openTools(),
    }),
    pin,
    archive,
    el("button", {
      type: "button",
      textContent: "Delete chat",
      onClick: () =>
        void run(async () => {
          if (
            !(await confirmDialog({
              title: "Delete this chat and its draft?",
              body: "Delete Glosa's messages and attachments. The coding agent may retain its own native history. This cannot be undone.",
              confirmLabel: "Delete chat",
              danger: true,
            }))
          )
            return;
          await dataAccess.deleteChat(slug, chatId);
          onDeleted?.();
        }),
    }),
  );
  const transfer = el("div", { className: "glosa-chat-transfer", hidden: !sourceChatId });
  if (sourceChatId)
    transfer.append(
      el("button", {
        type: "button",
        textContent: "Move previous draft here",
        onClick: () =>
          void run(async () => {
            await store.save();
            const source = await dataAccess.getChat(slug, sourceChatId);
            moveIntent ??= {
              requestId: crypto.randomUUID(),
              sourceId: sourceChatId,
              sourceRevision: source.draftRevision,
              targetRevision: current().draft.baseRevision,
            };
            let result;
            try {
              result = await dataAccess.moveChatDraft(slug, chatId, moveIntent);
            } catch (error) {
              if (error.problem?.type?.endsWith("/stale-draft")) {
                moveIntent = null;
                await store.refresh();
              }
              throw error;
            }
            moveIntent = null;
            await store.refresh();
            store.tell(
              result.sourceCleared
                ? "Draft moved. Nothing has been sent."
                : "Draft copied. A newer draft remains in the previous chat.",
            );
          }),
      }),
      el("button", {
        type: "button",
        textContent: "Attach previous conversation",
        onClick: () =>
          void run(async () => {
            const destination = current().chat.profileId;
            const destinationProfile = current().catalog.profiles.find((profile) => profile.id === destination);
            const preview = await dataAccess.previewChatTranscript(slug, sourceChatId);
            if (disposed) return;
            const file = new File([preview.text], "previous-conversation.md", { type: "text/markdown" });
            if (file.size > 10 * 1024 * 1024)
              throw new Error("The transcript exceeds 10 MiB. Export it and attach a shorter excerpt.");
            const dialog = el("dialog", { className: "glosa-dialog", "aria-label": "Preview conversation attachment" });
            const accepted = await new Promise((resolve) => {
              const previous = document.activeElement;
              dialog.append(
                el("h2", { textContent: "Attach this frozen transcript?" }),
                el("p", {
                  textContent: `From “${preview.title}” · ${preview.turnCount} ${preview.turnCount === 1 ? "turn" : "turns"} · ${file.size.toLocaleString()} bytes. This copy is sent only with your next message. Tool output, reasoning and approvals are excluded.`,
                }),
                el("p", {
                  textContent: `To ${agentName(destinationProfile?.provider ?? current().chat.provider)} · ${destinationProfile?.label ?? "Selected account"}. This account receives the copy only when you send.`,
                }),
                el("textarea", { readOnly: true, value: preview.text, rows: 12, "aria-label": "Transcript preview" }),
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
              dialogs.add(dialog);
              document.body.append(dialog);
              dialog.showModal();
            });
            if (!accepted || disposed) return;
            if (current().chat.profileId !== destination)
              throw new Error("The destination account changed. Preview the transcript again.");
            await store.attach([file]);
          }),
      }),
    );

  function levels() {
    const { chat, catalog } = current();
    return effortLadder(
      catalog?.capabilities?.[chat.profileId]?.models.find((model) => model.id === chat.settings.model)?.efforts ?? [],
    );
  }
  async function changeSettings(model, desiredEffort) {
    const { chat, catalog } = current();
    const offered = catalog?.capabilities?.[chat.profileId]?.models.find((entry) => entry.id === model)?.efforts ?? [];
    return run(() =>
      store.change({
        settings: {
          model,
          effort: desiredEffort ?? (offered.includes(chat.settings.effort) ? chat.settings.effort : (offered[0] ?? "")),
          permissionMode: chat.settings.permissionMode,
        },
      }),
    );
  }
  async function stepEffort(step) {
    const choices = levels();
    if (effort.disabled || choices.length < 2) return;
    const at = choices.indexOf(effortTarget ?? current().chat.settings.effort);
    effortTarget = choices[(at + step + choices.length) % choices.length];
    render();
    effortAnnounce.textContent = `Effort: ${effortPresentation(effortTarget).label}`;
    if (effortSaving) return;
    effortSaving = true;
    try {
      while (effortTarget !== null && effortTarget !== current().chat.settings.effort)
        if (!(await changeSettings(current().chat.settings.model, effortTarget))) break;
    } finally {
      effortSaving = false;
      effortTarget = null;
      render();
    }
  }
  async function changeAccount(id) {
    if (current().changing) return;
    return run(async () => {
      const { chat, catalog } = current();
      const profile = catalog.profiles.find((entry) => entry.id === id);
      if (!profile?.enabled || profile.removed || (profile.auth && profile.auth.state !== "authenticated"))
        throw new Error("Sign in to this subscription in Settings first.");
      let models = catalog.capabilities?.[id]?.models ?? [];
      if (!models.length && dataAccess.discoverAgentModels) {
        store.setChanging(true);
        try {
          await dataAccess.discoverAgentModels(id);
          await store.refreshCatalog();
          models = current().catalog.capabilities?.[id]?.models ?? [];
        } finally {
          store.setChanging(false);
        }
      }
      if (!models.length) throw new Error("Load this subscription’s models in Settings first. Your chat is unchanged.");
      const prior = catalog.capabilities?.[chat.profileId]?.models.find((entry) => entry.id === chat.settings.model);
      const same = profile.provider === chat.provider;
      const target = same
        ? (models.find(
            (entry) =>
              entry.id === chat.settings.model &&
              (!prior?.resolvedModel || entry.resolvedModel === prior.resolvedModel),
          ) ??
          (prior?.resolvedModel && models.find((entry) => entry.resolvedModel === prior.resolvedModel)))
        : models[0];
      const settings = {
        model: target?.id ?? "",
        effort: target
          ? target.efforts.includes(chat.settings.effort)
            ? chat.settings.effort
            : (target.efforts[0] ?? "")
          : "",
        permissionMode: chat.settings.permissionMode,
      };
      if (chat.turns.length && !same) {
        await store.save();
        await onNewChat?.(profile, settings);
      } else {
        await store.change({ provider: profile.provider, profileId: profile.id, settings });
        store.tell(`Using ${profile.label} for this chat.`);
      }
      return true;
    });
  }
  async function refreshFeedback() {
    if (!dataAccess.getChatFeedback) return;
    const value = await dataAccess.getChatFeedback(slug, chatId);
    if (!disposed) {
      feedback.hidden = !value.entryIds.length;
      feedback.textContent = `Send feedback · ${value.entryIds.length}${value.hasMore ? "+" : ""}`;
    }
  }
  async function refreshTools() {
    try {
      const policy = await dataAccess.getMcpPolicy?.(slug, current().chat.profileId);
      const count = policy?.servers.filter((server) => server.enabled).length;
      if (!disposed && count !== undefined)
        toolsLine.textContent = count ? `${count} ${count === 1 ? "tool" : "tools"} on` : "No extra tools on";
    } catch {
      /* The dialog remains available when its count cannot be read. */
    }
  }
  async function openTools() {
    return run(async () => {
      const profileId = current().chat.profileId;
      const policy = await dataAccess.getMcpPolicy(slug, profileId);
      if (disposed || current().chat.profileId !== profileId) return;
      toolsHost.replaceChildren();
      const saved = () => {
        tools.close();
        void refreshTools();
      };
      mountMcpSettings(toolsHost, {
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
      toolsHost.append(
        el("section", { className: "glosa-chat-tools-section" }, [
          el("h3", { textContent: "Connections" }),
          el("button", {
            type: "button",
            textContent: "Check connections",
            onClick: () =>
              void run(async () => {
                const result = await dataAccess.nativeChatMcp(slug, chatId);
                const inventory = el("div", { role: "status", "data-native-mcp": "true" });
                for (const server of result.servers)
                  inventory.append(
                    el("p", { textContent: `${server.name} · ${server.status} · sign-in ${server.auth}` }),
                  );
                toolsHost.querySelector("[data-native-mcp]")?.remove();
                toolsHost.append(inventory);
              }),
          }),
          el("button", {
            type: "button",
            textContent: "Sign in to a server",
            onClick: () =>
              void run(async () => {
                if (nativeLogin) throw new Error("Finish the current native sign-in first.");
                const profile = current().catalog.profiles.find((entry) => entry.id === profileId);
                let serverId;
                if (profile.provider === "codex") {
                  const servers = policy.servers.filter((server) => server.enabled && server.transport === "http");
                  if (!servers.length) throw new Error("Configure an enabled HTTP server first.");
                  const chooser = el("select", { "aria-label": "Tool server" });
                  for (const server of servers)
                    chooser.append(el("option", { value: server.id, textContent: server.label }));
                  toolsHost.append(chooser);
                  serverId = chooser.value;
                }
                if (
                  !(await confirmDialog({
                    title: "Sign in to a tool server?",
                    body: "Stop this account's active chats first. Credentials stay in this account's own private storage.",
                    confirmLabel: "Open sign-in",
                  }))
                )
                  return;
                nativeLogin = await mountAgentLogin(toolsHost, {
                  dataAccess,
                  profile,
                  workspace: slug,
                  serverId,
                  signal: lifetime.signal,
                  onFinished: () => {
                    nativeLogin = null;
                    tools.close();
                  },
                });
              }),
          }),
        ]),
        el("section", { className: "glosa-chat-tools-section" }, [
          el("h3", { textContent: "Workspace access" }),
          el("p", {
            textContent:
              "This account may read this folder and receive your messages wherever experimental chat is on. Manage access under Agents & accounts.",
          }),
          el("label", {}, [
            document.createTextNode("For future messages "),
            (() => {
              const access = el("select", { "aria-label": "Agent permissions" });
              for (const [value, label] of [
                ["workspace", "Workspace access"],
                ["default", "Ask before edits"],
                ["plan", "Plan only"],
              ])
                access.append(el("option", { value, textContent: label }));
              access.value = current().chat.settings.permissionMode;
              access.addEventListener(
                "change",
                () =>
                  void run(async () => {
                    access.disabled = true;
                    try {
                      await store.change({ settings: { ...current().chat.settings, permissionMode: access.value } });
                    } finally {
                      access.disabled = false;
                      access.value = current().chat.settings.permissionMode;
                    }
                  }),
              );
              return access;
            })(),
          ]),
          el("p", {
            textContent:
              "Workspace access allows edits in this folder. Private files outside it and network actions still ask for permission. System files needed to run tools remain readable. Plan only keeps files read-only.",
          }),
        ]),
        el("button", { type: "button", textContent: "Close", onClick: () => tools.close() }),
      );
      if (!tools.open) {
        document.body.append(tools);
        tools.showModal();
      }
    });
  }
  function render() {
    const view = current(),
      { chat, catalog } = view;
    if (!chat || disposed) return;
    if (document.activeElement !== title) title.value = chat.title;
    identity.replaceChildren(agentIcon(chat.provider));
    identity.title = agentName(chat.provider);
    const working = view.queue.active ?? view.queue.head;
    activity.textContent = chat.archived
      ? "Archived"
      : working
        ? working.status === "waiting"
          ? "Needs your reply"
          : "Working…"
        : "";
    activity.dataset.working = String(!!working);
    picker.render({
      state: chat,
      catalog,
      disabled:
        (view.changing && !effortSaving) || view.uploading || view.checking || view.outbox.length > 0 || chat.archived,
      busy: view.changing || view.checking,
      subscriptionBlocked:
        chat.turns.some((turn) => !["completed", "failed", "cancelled", "outcome_unknown"].includes(turn.status)) ||
        (!!chat.runtime && chat.runtime.state !== "stopped"),
    });
    const choices = levels(),
      shown = effortTarget ?? chat.settings.effort;
    effort.disabled = (view.changing && !effortSaving) || choices.length < 1;
    effort.dataset.effort = shown;
    effortIcon(shown, effortMark);
    effortLabel.textContent = effortPresentation(shown).label;
    effortLabel.dataset.widest = choices
      .map((id) => effortPresentation(id).label)
      .reduce((a, b) => (a.length > b.length ? a : b), effortLabel.textContent);
    const next = choices[(choices.indexOf(shown) + 1) % choices.length];
    effortTip.textContent = `${effortPresentation(shown).label} effort · ${effortPresentation(shown).description} Applies to your next message.${choices.length > 1 ? ` Press for ${effortPresentation(next).label}.` : ""}`;
    pin.textContent = chat.pinned ? "Unpin chat" : "Pin chat";
    archive.textContent = chat.archived ? "Restore chat" : "Archive chat";
    usage.hidden = !chat.usage;
    keyHint.textContent = working
      ? "Enter to queue · Shift Enter for a new line"
      : "Enter to send · Shift Enter for a new line";
    feedback.disabled = view.changing || view.uploading || view.queue.tray.length > 0 || !!view.queue.head;
    if (sourceChatId && chat.turns.length && transfer.children.length) {
      menu.popup.append(...transfer.children);
      transfer.hidden = true;
    }
  }
  const unsubscribe = store.subscribe(render);
  render();
  void refreshFeedback().catch(store.fail);
  void refreshTools();
  return {
    header,
    controls,
    footer,
    transfer,
    openTools,
    async showNativeConnections() {
      const result = await dataAccess.nativeChatMcp(slug, chatId);
      store.tell(
        result.servers.length
          ? result.servers.map((server) => `${server.name}: ${server.status}`).join(" · ")
          : "No agent is running. Connections will be listed while a chat is active.",
      );
    },
    destroy() {
      disposed = true;
      unsubscribe();
      lifetime.abort();
      picker.destroy();
      void nativeLogin?.destroy();
      for (const dialog of dialogs) {
        dialog.close();
        dialog.remove();
      }
    },
  };
}

function usageText({ chat, catalog }) {
  const value = chat.usage,
    metrics = [],
    limits = [];
  const labels = {
    input_tokens: "Input tokens",
    inputTokens: "Input tokens",
    output_tokens: "Output tokens",
    outputTokens: "Output tokens",
    totalTokens: "Total tokens",
    cachedInputTokens: "Cached input tokens",
    reasoningOutputTokens: "Reasoning output tokens",
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
  const date = (input) => {
    const result = new Date(typeof input === "number" ? input * 1000 : input);
    return Number.isNaN(result.getTime()) ? String(input) : result.toLocaleString();
  };
  for (const [key, item] of Object.entries(value)) {
    if (["source", "scope", "asOf", "quotaSource", "quotaAsOf"].includes(key)) continue;
    const label = labels[key] ?? key.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ");
    const formatted =
      item == null
        ? "Not reported"
        : /resetsAt$/i.test(key)
          ? date(item)
          : typeof item === "number"
            ? item.toLocaleString(undefined, { maximumFractionDigits: 6 })
            : String(item);
    (key.startsWith("quota_") || /^(primary|secondary)/.test(key) ? limits : metrics).push(`${label}: ${formatted}`);
  }
  const sections = [
    `Account: ${catalog.profiles.find((item) => item.id === chat.profileId)?.label ?? agentName(chat.provider)}`,
  ];
  if (metrics.length)
    sections.push(
      [
        `Token usage · ${value.scope === "native-thread" ? "current session totals" : "agent-reported totals"}`,
        `Source: ${value.source ?? agentName(chat.provider)}`,
        `Observed: ${value.asOf ? date(value.asOf) : "Not reported"}`,
        ...metrics,
        "Current context use: Not reported",
      ].join("\n"),
    );
  if (limits.length)
    sections.push(
      [
        "Account limits",
        `Source: ${value.quotaSource ?? agentName(chat.provider)}`,
        `Observed: ${value.quotaAsOf ? date(value.quotaAsOf) : "Not reported"}`,
        ...limits,
      ].join("\n"),
    );
  if (value.estimatedCostUsd != null) sections.push("Cost estimates are not subscription charges or invoices.");
  return sections.join("\n\n");
}

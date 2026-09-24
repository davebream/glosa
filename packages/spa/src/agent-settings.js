// SPDX-License-Identifier: Apache-2.0

import { mountMcpSettings } from "./agent-mcp-settings.js";
import { actionMenu, agentIcon, agentName } from "./agent-ui.js";
import { confirmDialog } from "./dialog.js";
import { createElement as el } from "./viewer-shell.js";

export function mountAgentSettings(host, { dataAccess, onChange, appearance }) {
  let disposed = false,
    login,
    busy = false,
    selectedProvider;
  let installTimer,
    installGeneration = 0,
    localInstallation,
    remoteInstallation = false;
  const runtimeRows = new Map();
  const installing = (progress) => progress && !["complete", "failed"].includes(progress.phase);
  const duration = (milliseconds) => {
    const seconds = Math.max(0, Math.floor(milliseconds / 1000));
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  };
  const selectedAccounts = new Map();
  const accountDrafts = new Map();
  const accountState = (profile) =>
    profile.cleanup
      ? "Cleanup needed"
      : !profile.enabled
        ? "Disabled"
        : ({
            authenticated: "Connected",
            expired: "Sign-in expired",
            probe_failed: "Could not verify",
            identity_mismatch: "Different account detected",
            unknown: "Not checked",
          }[profile.auth.state] ?? "Not connected");
  const loginAbort = new AbortController();
  const root = el("section", { className: "glosa-agent-settings" });
  const message = el("p", { role: "status", className: "glosa-agent-status" });
  const retry = el("button", {
    type: "button",
    textContent: "Refresh settings",
    hidden: true,
    onClick: () => void act(async () => {}, "Refreshing settings…", retry, true),
  });
  const notice = el("div", { className: "glosa-agent-notice" }, [message, retry]);
  const showError = (error) => {
    message.textContent = error.message || "Could not complete this action. Refresh settings, then try again.";
    message.setAttribute("role", "alert");
    retry.hidden = false;
  };
  const body = el("div", { className: "glosa-agent-settings-body" }),
    loginHost = el("div", { className: "glosa-agent-login-host" }),
    tabs = el("nav", { className: "glosa-agent-tabs", "aria-label": "Coding agents" });
  const agents = el("section", { className: "glosa-settings-content" });
  agents.append(
    el("h2", { className: "glosa-settings-title", textContent: "Agents & accounts" }),
    el("p", {
      textContent: "Connect your accounts and choose which one new chats use.",
      className: "glosa-agent-intro",
    }),
    tabs,
    notice,
    loginHost,
    body,
  );
  const navigation = el("nav", { className: "glosa-settings-nav", "aria-label": "Settings" });
  const appearancePage = el("section", { className: "glosa-settings-content", hidden: true }, [
    el("h2", { className: "glosa-settings-title", textContent: "Appearance" }),
    el("p", { className: "glosa-agent-intro", textContent: "Choose how Glosa looks on this device." }),
  ]);
  for (const [label, panel] of [
    ["Agents & accounts", agents],
    ...(appearance ? [["Appearance", appearancePage]] : []),
  ]) {
    const item = el("button", {
      type: "button",
      textContent: label,
      "aria-current": panel === agents ? "page" : "false",
      onClick: () => {
        agents.hidden = panel !== agents;
        appearancePage.hidden = panel !== appearancePage;
        for (const button of navigation.children)
          button.setAttribute("aria-current", String(button === item ? "page" : "false"));
      },
    });
    navigation.append(item);
  }
  const appearanceOptions = el("div", {
    className: "glosa-settings-appearance",
    role: "group",
    "aria-label": "Color theme",
  });
  for (const value of ["system", "light", "dark"]) {
    appearanceOptions.append(
      el("button", {
        type: "button",
        "data-theme-choice": value,
        textContent: value === "system" ? "Use system setting" : value === "light" ? "Light" : "Dark",
        onClick: () => appearance.setPreference(value),
      }),
    );
  }
  appearancePage.append(appearanceOptions);
  const stopAppearance = appearance?.subscribe(({ preference }) => {
    for (const button of appearanceOptions.children)
      button.setAttribute("aria-pressed", String(button.dataset.themeChoice === preference));
  });
  root.append(
    el("h1", { textContent: "Settings" }),
    el("div", { className: "glosa-settings-layout" }, [navigation, agents, appearancePage]),
  );
  host.append(root);
  function paintInstallation(row, progress, connectionLost = false) {
    if (!progress) return;
    const active = installing(progress);
    const names = {
      preparing: "Preparing installation",
      downloading: "Downloading runtime",
      installing: "Installing packages",
      verifying: "Verifying runtime",
      complete: "Installed",
      failed: "Installation failed",
    };
    row.title.textContent = `${agentName(row.provider)} runtime · ${names[progress.phase] ?? "Installing"}`;
    row.element.dataset.attention = String(active || progress.phase === "failed");
    if (row.disclosure) {
      row.summary.textContent = active
        ? (names[progress.phase] ?? "Installing runtime")
        : progress.phase === "failed"
          ? "Runtime needs attention"
          : `${agentName(row.provider)} runtime installed`;
      if (active || progress.phase === "failed") row.disclosure.open = true;
    }
    row.progress.hidden = !active;
    row.metrics.hidden = !active;
    row.detail.textContent = active
      ? connectionLost
        ? "Waiting for a progress update from Glosa. Installation may still be running."
        : Date.now() - progress.updatedAt >= 30_000
          ? `No installer update for ${duration(Date.now() - progress.updatedAt)}. Large downloads can be quiet.`
          : "Your terminal setup stays separate. Accounts will be available after installation."
      : progress.phase === "failed"
        ? "Installation did not finish. Check your connection and try again."
        : row.installedDetail;
    row.metrics.textContent = [
      `${duration(Date.now() - progress.startedAt)} elapsed`,
      ...(progress.packagesCompleted
        ? [
            `${progress.packagesCompleted} ${progress.packagesCompleted === 1 ? "package" : "packages"} downloaded`,
            `≈ ${(progress.bytesCompleted / 1e6).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB received`,
          ]
        : []),
      `Last update ${duration(Date.now() - progress.updatedAt)} ago`,
      ...(connectionLost ? ["Progress connection interrupted"] : []),
    ].join(" · ");
    if (active) {
      row.button.disabled = true;
      row.button.textContent = "Installing runtime…";
      row.button.setAttribute("aria-busy", "true");
    }
  }
  function stopInstallationPolling() {
    clearInterval(installTimer);
    installTimer = undefined;
    installGeneration++;
  }
  function watchInstallations() {
    if (installTimer || disposed) return;
    const generation = ++installGeneration;
    let inFlight = false,
      lastResponse = Date.now(),
      connectionLost = false;
    const tick = () => {
      for (const row of runtimeRows.values())
        if (installing(row.installation))
          paintInstallation(row, row.installation, connectionLost || Date.now() - lastResponse > 5000);
      if (inFlight) return;
      inFlight = true;
      void dataAccess
        .getAgentStatus()
        .then(async (state) => {
          if (disposed || generation !== installGeneration) return;
          connectionLost = false;
          lastResponse = Date.now();
          remoteInstallation = state.providers.some((provider) => installing(provider.installation));
          for (const provider of state.providers) {
            const row = runtimeRows.get(provider.id);
            if (row && provider.installation) {
              row.installation = provider.installation;
              paintInstallation(row, row.installation);
            }
          }
          if (!remoteInstallation && !localInstallation) {
            await refresh();
          }
        })
        .catch(() => {
          if (disposed || generation !== installGeneration) return;
          connectionLost = true;
        })
        .finally(() => {
          inFlight = false;
        });
    };
    installTimer = setInterval(tick, 1000);
    tick();
  }
  const act = async (fn, progress = "Saving changes…", trigger, readOnly = false) => {
    if (busy || (remoteInstallation && !readOnly) || disposed) return;
    busy = true;
    root.setAttribute("aria-busy", "true");
    retry.hidden = true;
    message.setAttribute("role", "status");
    message.textContent = progress;
    const locked = [...root.querySelectorAll("button,input,select,textarea")].map((control) => [
      control,
      control.disabled,
    ]);
    for (const [control] of locked) control.disabled = true;
    const originalLabel = trigger?.textContent;
    if (trigger) {
      trigger.textContent = progress;
      trigger.setAttribute("aria-busy", "true");
    }
    try {
      await fn();
      await refresh();
      onChange?.();
    } catch (error) {
      showError(error);
    } finally {
      busy = false;
      root.removeAttribute("aria-busy");
      for (const [control, disabled] of locked)
        control.disabled = disabled || (remoteInstallation && body.contains(control));
      if (trigger?.isConnected && (!remoteInstallation || readOnly)) {
        trigger.textContent = originalLabel;
        trigger.removeAttribute("aria-busy");
      }
    }
  };
  const button = (label, fn, disabled = false) => {
    const control = el("button", { type: "button", textContent: label, disabled });
    control.addEventListener(
      "click",
      () =>
        void act(
          fn,
          label.includes("runtime")
            ? "Installing runtime…"
            : label === "Load models"
              ? "Loading models…"
              : "Saving changes…",
          control,
        ),
    );
    return control;
  };
  const update = (profile, changes) =>
    dataAccess.updateAgentProfile(profile.id, {
      requestId: crypto.randomUUID(),
      revision: profile.revision,
      ...changes,
    });
  async function refresh() {
    const state = await dataAccess.getAgentStatus();
    if (disposed) return;
    stopInstallationPolling();
    remoteInstallation = state.providers.some((provider) => installing(provider.installation));
    runtimeRows.clear();
    const focused = root.contains(document.activeElement) ? document.activeElement : null;
    const focusedProfile = focused?.closest("[data-profile-id]")?.dataset.profileId;
    const focusedLabel = focused?.getAttribute("aria-label") ?? focused?.textContent;
    message.textContent = state.recovery ?? (state.available ? "" : "Chat support is not available in this build yet.");
    retry.hidden = true;
    message.setAttribute("role", "status");
    selectedProvider ??= state.providers[0]?.id;
    for (const panel of body.querySelectorAll("[data-provider-panel]")) {
      const draft = panel.querySelector(".glosa-agent-add-account input");
      if (draft) accountDrafts.set(panel.dataset.providerPanel, draft.value);
    }
    tabs.replaceChildren();
    body.replaceChildren();
    if (state.unreadableChats?.length)
      body.append(
        el("p", {
          role: "alert",
          textContent: `Chat history needs recovery: ${state.unreadableChats.join(", ")}. These chats cannot run. Their journals were preserved; other documents and chats remain available.`,
        }),
      );
    for (const provider of state.providers) {
      const tab = el(
        "button",
        {
          type: "button",
          "aria-pressed": String(provider.id === selectedProvider),
          onClick: () => {
            selectedProvider = provider.id;
            for (const panel of body.querySelectorAll("[data-provider-panel]"))
              panel.hidden = panel.dataset.providerPanel !== selectedProvider;
            for (const item of tabs.children) item.setAttribute("aria-pressed", String(item === tab));
          },
        },
        [agentIcon(provider.id), el("span", { textContent: agentName(provider.id) })],
      );
      tabs.append(tab);
      const section = el("section", {
        className: "glosa-agent-settings-provider",
        "data-provider-panel": provider.id,
        hidden: provider.id !== selectedProvider,
      });
      const sectionHeader = el("div", { className: "glosa-agent-section-heading" }, [
        el("div", {}, [
          el("h2", { textContent: "Accounts" }),
          el("p", { textContent: "The default is used for new chats. Existing chats keep their account." }),
        ]),
      ]);
      section.append(sectionHeader);
      const installedDetail = provider.qualified
        ? `Glosa uses a separate copy of ${agentName(provider.id)}. Verify or reinstall it if the agent stops working.`
        : "Installed. Chat support is not available in this build yet.";
      const runtimeTitle = el("strong", {
        role: "status",
        textContent: `${agentName(provider.id)} runtime · ${provider.installed ? "Installed" : "Not installed"}`,
      });
      const runtimeDetail = el("p", {
        textContent: provider.installed
          ? installedDetail
          : "Install the runtime first. Then add an account and sign in. Your terminal setup stays separate.",
      });
      const runtimeProgress = el("progress", {
        className: "glosa-runtime-progress",
        "aria-label": `${provider.name} installation`,
        hidden: true,
      });
      const runtimeMetrics = el("p", { className: "glosa-runtime-metrics", hidden: true });
      const runtimeButton = button(provider.installed ? "Verify / repair runtime" : "Install runtime", async () => {
        if (
          await confirmDialog({
            title: `Install ${provider.name}?`,
            body: "Download Glosa's pinned runtime from the npm registry. Your system CLI and its settings stay separate.",
            confirmLabel: "Install",
          })
        ) {
          localInstallation = provider.id;
          message.textContent = "";
          const row = runtimeRows.get(provider.id);
          row.installation = {
            phase: "preparing",
            startedAt: Date.now(),
            updatedAt: Date.now(),
            packagesCompleted: 0,
            bytesCompleted: 0,
          };
          paintInstallation(row, row.installation);
          try {
            const request = dataAccess.installAgent(provider.id);
            watchInstallations();
            await request;
          } finally {
            localInstallation = undefined;
            // Reconcile even on a dropped POST response: a server-side install may still be running.
            try {
              await refresh();
            } catch (error) {
              remoteInstallation = true;
              watchInstallations();
              showError(error);
            }
          }
        }
      });
      const runtime = el("div", { className: "glosa-agent-runtime", "data-installed": String(provider.installed) }, [
        runtimeTitle,
        runtimeDetail,
        runtimeButton,
        runtimeProgress,
        runtimeMetrics,
      ]);
      const healthyRuntime =
        provider.installed &&
        provider.qualified &&
        !installing(provider.installation) &&
        provider.installation?.phase !== "failed";
      const runtimeSummary = el("summary", { textContent: `${agentName(provider.id)} runtime installed` });
      const runtimeDisclosure = healthyRuntime
        ? el("details", { className: "glosa-agent-runtime-maintenance" }, [runtimeSummary, runtime])
        : null;
      if (runtimeDisclosure) runtimeTitle.hidden = true;
      const runtimeRow = {
        provider: provider.id,
        title: runtimeTitle,
        detail: runtimeDetail,
        progress: runtimeProgress,
        metrics: runtimeMetrics,
        button: runtimeButton,
        installedDetail,
        installation: provider.installation,
        element: runtime,
        disclosure: runtimeDisclosure,
        summary: runtimeSummary,
      };
      runtimeRows.set(provider.id, runtimeRow);
      paintInstallation(runtimeRow, provider.installation);
      section.prepend(runtimeDisclosure ?? runtime);
      const accountArea = el("fieldset", {
        className: "glosa-agent-account-area",
        disabled: !provider.installed || !state.available || remoteInstallation,
      });
      const blockedReason = el("p", {
        className: "glosa-agent-recovery",
        hidden: provider.installed && state.available,
        textContent: !provider.installed
          ? "Accounts become available after installation."
          : "Account setup is unavailable in this build.",
      });
      accountArea.setAttribute("aria-label", `${provider.name} accounts`);
      section.append(blockedReason, accountArea);
      const profiles = state.profiles.filter((p) => p.provider === provider.id && !p.removed);
      if (!profiles.some((p) => p.id === selectedAccounts.get(provider.id)))
        selectedAccounts.set(provider.id, profiles[0]?.id);
      const accountList = el("nav", {
        className: "glosa-agent-account-list",
        "aria-label": `${provider.name} accounts`,
      });
      const accountDetail = el("div", { className: "glosa-agent-account-detail" });
      const selectedAccount = profiles.find((profile) => profile.id === selectedAccounts.get(provider.id));
      const chooseAccount = el("button", {
        type: "button",
        className: "glosa-agent-account-chooser",
        textContent: selectedAccount?.label ?? "Choose account",
        "aria-label": `Choose account: ${selectedAccount?.label ?? provider.name}`,
        "aria-expanded": "false",
        onClick: () => {
          const expanded = chooseAccount.getAttribute("aria-expanded") !== "true";
          chooseAccount.setAttribute("aria-expanded", String(expanded));
          accountBrowser.dataset.expanded = String(expanded);
        },
      });
      const accountBrowser = el(
        "div",
        {
          className: "glosa-agent-account-browser",
          "data-expanded": "false",
          hidden: !profiles.length,
        },
        [chooseAccount, accountList],
      );
      const accountLayout = el("div", { className: "glosa-agent-account-layout" }, [accountBrowser, accountDetail]);
      accountArea.append(accountLayout);
      if (!profiles.length)
        accountDetail.append(
          el("div", { className: "glosa-agent-empty" }, [
            el("h3", { textContent: `Connect ${agentName(provider.id)}` }),
            el("p", {
              textContent:
                "Give your account a name below, then sign in through the agent’s own login. You can add more accounts later.",
            }),
          ]),
        );
      for (const profile of profiles) {
        const card = el("article", {
          className: "glosa-agent-account",
          "data-profile-id": profile.id,
          hidden: selectedAccounts.get(provider.id) !== profile.id,
        });
        const accountRow = el(
          "button",
          {
            type: "button",
            "data-account-choice": profile.id,
            title: [profile.label, profile.auth.label, accountState(profile)].filter(Boolean).join(" · "),
            "aria-current": card.hidden ? "false" : "page",
            onClick: () => {
              selectedAccounts.set(provider.id, profile.id);
              chooseAccount.textContent = profile.label;
              chooseAccount.setAttribute("aria-label", `Choose account: ${profile.label}`);
              chooseAccount.setAttribute("aria-expanded", "false");
              accountBrowser.dataset.expanded = "false";
              for (const article of accountDetail.querySelectorAll("[data-profile-id]"))
                article.hidden = article !== card;
              for (const row of accountList.children)
                row.setAttribute("aria-current", row === accountRow ? "page" : "false");
              if (chooseAccount.getClientRects().length) chooseAccount.focus({ preventScroll: true });
            },
          },
          [
            el("span", { className: "glosa-agent-account-label", textContent: profile.label }),
            ...(profile.auth.label
              ? [el("small", { className: "glosa-agent-account-identity", textContent: profile.auth.label })]
              : []),
            el("small", { className: "glosa-agent-account-list-state" }, [
              el("span", { textContent: accountState(profile) }),
              ...(profile.isDefault ? [el("span", { textContent: "Default", className: "glosa-agent-default" })] : []),
            ]),
          ],
        );
        accountList.append(accountRow);
        const name = el("input", {
          value: profile.label,
          maxLength: 80,
          "aria-label": `Account label: ${profile.label}`,
          title: "Rename account",
        });
        name.addEventListener("change", () => void act(() => update(profile, { label: name.value })));
        name.addEventListener("keydown", (event) => {
          if (event.key === "Escape") name.value = profile.label;
          if (event.key === "Enter" || event.key === "Escape") {
            event.preventDefault();
            name.blur();
          }
        });
        const connected = profile.auth.state === "authenticated";
        const badge = el("span", {
          className: "glosa-agent-state",
          "data-connected": String(connected && profile.enabled),
          textContent: accountState(profile),
        });
        const summary = el("div", { className: "glosa-agent-account-summary" }, [
          name,
          el("div", { className: "glosa-agent-account-meta" }, [
            badge,
            ...(profile.auth.plan
              ? [el("span", { textContent: profile.auth.plan[0].toUpperCase() + profile.auth.plan.slice(1) })]
              : []),
            ...(profile.isDefault ? [el("span", { className: "glosa-agent-default", textContent: "Default" })] : []),
          ]),
        ]);
        const details = el("details", { className: "glosa-agent-account-details", open: true }, [
          el("summary", { textContent: "Account details & connections" }),
        ]);
        const identity = el("dl", { className: "glosa-agent-facts" });
        for (const [label, value] of [
          ["Signed in as", profile.auth.label ?? "Not identified"],
          ["Login", profile.auth.method ?? "Not connected"],
          [
            "Last checked",
            profile.auth.observedAt ? new Date(profile.auth.observedAt).toLocaleString() : "Not checked",
          ],
          ["Active chats", String(state.profileActivity?.[profile.id]?.active ?? 0)],
        ]) {
          identity.append(el("dt", { textContent: label }), el("dd", { textContent: value }));
        }
        details.append(identity);
        const actions = el("div", { className: "glosa-agent-account-actions" });
        actions.append(
          button(
            profile.enabled ? "Disable" : "Enable",
            async () => {
              if (
                !profile.enabled ||
                (await confirmDialog({
                  title: `Disable ${profile.label} and stop ${state.profileActivity?.[profile.id]?.active ?? 0} active chats?`,
                  body: "Active chats using this account will stop. Queued messages will be held for review.",
                  confirmLabel: "Disable",
                }))
              )
                await update(profile, { enabled: !profile.enabled });
            },
            !!profile.cleanup,
          ),
          button(
            profile.isDefault ? "Clear default" : "Make default",
            () => update(profile, { isDefault: !profile.isDefault }),
            !profile.enabled || profile.auth.state !== "authenticated",
          ),
          button("Check account", () => dataAccess.probeAgent(profile.id), !profile.enabled || !state.available),
          button(
            connected ? "Sign in again" : "Sign in",
            async () => {
              await login?.destroy();
              const { mountAgentLogin } = await import("./agent-login.js");
              login = await mountAgentLogin(loginHost, {
                dataAccess,
                profile,
                signal: loginAbort.signal,
                onFinished: () => {
                  login = null;
                  void refresh().catch((error) => {
                    showError(error);
                  });
                },
              });
              loginHost.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
            },
            !profile.enabled || !state.available,
          ),
          button(
            "Load models",
            () => dataAccess.discoverAgentModels(profile.id),
            !state.available || !profile.enabled || profile.auth.state !== "authenticated",
          ),
          button(profile.cleanup ? "Retry account cleanup" : "Sign out", async () => {
            if (
              profile.cleanup ||
              (await confirmDialog({
                title: `Sign out of ${profile.label}?`,
                body: "Stop its chats and sign out through the agent. Private configuration and chat history stay available for reconnecting.",
                confirmLabel: "Sign out",
              }))
            )
              await dataAccess.signOutAgent(profile.id, {
                requestId: crypto.randomUUID(),
                revision: profile.revision,
                remove: profile.cleanup === "remove",
              });
          }),
          button(
            "Remove account",
            async () => {
              if (
                await confirmDialog({
                  title: `Remove ${profile.label}?`,
                  body: "Stop its chats and remove this account's login and private configuration. Existing chat history stays available.",
                  confirmLabel: "Remove account",
                })
              )
                await update(profile, { remove: true });
            },
            !!profile.cleanup,
          ),
        );
        const mcp = el("details", { className: "glosa-agent-connections" }, [
          el("summary", { textContent: "Tools & connections" }),
          el("p", {
            className: "glosa-agent-help",
            textContent:
              "Connect external tools through MCP (Model Context Protocol). These connections belong to this account.",
          }),
        ]);
        mountMcpSettings(mcp, {
          servers: profile.mcpServers ?? [],
          onSave: async (servers) => {
            await update(profile, { mcpServers: servers });
            await refresh();
          },
        });
        details.append(mcp);
        const accountMenu = actionMenu(`Actions for ${profile.label}`);
        const [enable, defaultButton, check, signIn, models, signOut, remove] = [...actions.children];
        const verify = ["probe_failed", "unknown"].includes(profile.auth.state);
        if (verify) check.textContent = "Retry verification";
        if (profile.auth.state === "identity_mismatch") signIn.textContent = "Sign in to original account";
        const primary = profile.cleanup
          ? signOut
          : !profile.enabled
            ? enable
            : verify
              ? check
              : !connected
                ? signIn
                : !state.capabilities?.[profile.id]?.models?.length
                  ? models
                  : check;
        if (!connected || !profile.enabled || profile.cleanup) primary.classList.add("glosa-agent-primary");
        enable.textContent = profile.enabled ? "Disable account…" : "Enable account";
        const rename = el("button", {
          type: "button",
          textContent: "Rename account",
          onClick: () => {
            accountMenu.popup.hidePopover?.();
            name.focus({ preventScroll: true });
            name.select();
          },
        });
        const showDefault = profile.enabled && connected && !profile.isDefault && !profile.cleanup;
        const maintenance = [rename, defaultButton, check, signIn, models].filter(
          (item) => item !== primary && !(showDefault && item === defaultButton),
        );
        const destructive = [enable, signOut, remove].filter((item) => item !== primary);
        accountMenu.popup.append(
          el(
            "div",
            { className: "glosa-agent-menu-group", role: "group", "aria-label": "Account settings" },
            maintenance,
          ),
          el("hr"),
          el(
            "div",
            { className: "glosa-agent-menu-group", role: "group", "aria-label": "Account access" },
            destructive,
          ),
        );
        actions.replaceChildren(...(showDefault ? [defaultButton] : []), primary, accountMenu.element);
        card.append(el("div", { className: "glosa-agent-account-heading" }, [summary, actions]));
        if (!profile.enabled && !profile.cleanup)
          card.append(
            el("p", {
              className: "glosa-agent-help",
              textContent:
                "Enable this account to sign in or use it in chats. Enabling it will not restart stopped chats.",
            }),
          );
        if (verify || profile.auth.state === "identity_mismatch")
          card.append(
            el("p", {
              className: "glosa-agent-recovery",
              textContent:
                profile.auth.state === "identity_mismatch"
                  ? "This login belongs to a different account. Sign in to the original account to continue its chats, or add a separate account below."
                  : "Glosa could not confirm this account’s current sign-in. Retry verification before signing in again; this does not mean you are signed out.",
            }),
          );
        card.append(details);
        accountDetail.append(card);
      }
      const label = el("input", {
        value: accountDrafts.get(provider.id) ?? "",
        placeholder: "e.g. Personal or Work",
        maxLength: 80,
        required: true,
        "aria-label": `${provider.name} account label`,
      });
      const form = el("form", { className: "glosa-agent-add-account" }, [
        el("label", {}, [el("span", { textContent: "Add an account" }), label]),
        el("button", { type: "submit", textContent: "Add account" }),
      ]);
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        if (!provider.installed || !state.available || busy || remoteInstallation) return;
        if (label.value.trim())
          void act(async () => {
            const created = await dataAccess.createAgentProfile({
              requestId: crypto.randomUUID(),
              provider: provider.id,
              label: label.value.trim(),
            });
            if (created?.id) selectedAccounts.set(provider.id, created.id);
            label.value = "";
            accountDrafts.delete(provider.id);
          });
      });
      accountArea.append(form);
      body.append(section);
    }
    if (remoteInstallation) {
      for (const control of body.querySelectorAll("button,input,select,textarea")) control.disabled = true;
      watchInstallations();
    }
    if (focusedProfile) {
      const card = [...body.querySelectorAll("[data-profile-id]")].find(
        (item) => item.dataset.profileId === focusedProfile,
      );
      const replacement = [...(card?.querySelectorAll("button,input,summary") ?? [])].find(
        (item) => (item.getAttribute("aria-label") ?? item.textContent) === focusedLabel,
      );
      (replacement?.closest("[popover]")
        ? card?.querySelector(".glosa-agent-menu-trigger")
        : (replacement ?? card?.querySelector("input"))
      )?.focus();
    }
  }
  const ready = refresh().catch((error) => {
    showError(error);
  });
  return {
    element: root,
    kind: "agent-settings",
    title: "Settings",
    ready,
    destroy() {
      disposed = true;
      stopInstallationPolling();
      stopAppearance?.();
      loginAbort.abort();
      void login?.destroy().catch(() => {});
      root.remove();
    },
  };
}

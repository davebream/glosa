// SPDX-License-Identifier: Apache-2.0
import { createElement as el } from "./viewer-shell.js";
import { confirmDialog } from "./dialog.js";
import { mountMcpSettings } from "./agent-mcp-settings.js";
import { agentIcon, agentName, actionMenu } from "./agent-ui.js";

export function mountAgentSettings(host, { dataAccess, onChange }) {
  let disposed = false,
    login,
    busy = false,
    selectedProvider;
  const loginAbort = new AbortController();
  const root = el("section", { className: "glosa-agent-settings" });
  const message = el("p", { role: "status", className: "glosa-agent-status" });
  const body = el("div", { className: "glosa-agent-settings-body" }),
    loginHost = el("div", { className: "glosa-agent-login-host" }),
    tabs = el("nav", { className: "glosa-agent-tabs", "aria-label": "Coding agents" });
  root.append(
    el("h1", { textContent: "Agents & accounts" }),
    el("p", {
      textContent:
        "Your coding agents, at your writing desk. Connect accounts, choose a default, and keep each login separate from your terminal.",
      className: "glosa-agent-intro",
    }),
    tabs,
    message,
    loginHost,
    body,
  );
  host.append(root);
  const act = async (fn) => {
    if (busy || disposed) return;
    busy = true;
    root.setAttribute("aria-busy", "true");
    message.textContent = "Working…";
    try {
      await fn();
      await refresh();
      onChange?.();
    } catch (error) {
      message.textContent = error.message;
    } finally {
      busy = false;
      root.removeAttribute("aria-busy");
    }
  };
  const button = (label, fn, disabled = false) =>
    el("button", { type: "button", textContent: label, disabled, onClick: () => void act(fn) });
  const update = (profile, changes) =>
    dataAccess.updateAgentProfile(profile.id, {
      requestId: crypto.randomUUID(),
      revision: profile.revision,
      ...changes,
    });
  async function refresh() {
    const state = await dataAccess.getAgentStatus();
    if (disposed) return;
    const focused = root.contains(document.activeElement) ? document.activeElement : null;
    const focusedProfile = focused?.closest("[data-profile-id]")?.dataset.profileId;
    const focusedLabel = focused?.getAttribute("aria-label") ?? focused?.textContent;
    message.textContent = state.recovery ?? state.reason ?? "";
    selectedProvider ??= state.providers[0]?.id;
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
      const runtime = el("details", { className: "glosa-agent-runtime" }, [
        el("summary", {
          textContent: `${agentName(provider.id)} runtime · ${provider.installed ? "Installed" : "Not installed"}`,
        }),
      ]);
      runtime.append(
        el("p", {
          textContent: provider.installed
            ? provider.qualified
              ? "Tested runtime installed"
              : "Installed · compatibility qualification pending"
            : "Runtime not installed",
        }),
      );
      runtime.append(
        button(provider.installed ? "Verify / repair runtime" : "Install runtime", async () => {
          if (
            await confirmDialog({
              title: `Install ${provider.name}?`,
              body: "Download Glosa's pinned runtime from the npm registry. Your system CLI and its settings stay separate.",
              confirmLabel: "Install",
            })
          )
            await dataAccess.installAgent(provider.id);
        }),
      );
      const profiles = state.profiles.filter((p) => p.provider === provider.id && !p.removed);
      if (!profiles.length)
        section.append(
          el("div", { className: "glosa-agent-empty" }, [
            el("h3", { textContent: `Connect ${agentName(provider.id)}` }),
            el("p", {
              textContent:
                "Give your account a name below, then sign in through the agent’s own login. You can add more accounts later.",
            }),
          ]),
        );
      for (const profile of profiles) {
        const card = el("article", { className: "glosa-agent-account", "data-profile-id": profile.id });
        const name = el("input", {
          value: profile.label,
          maxLength: 80,
          "aria-label": `Account label: ${profile.label}`,
          title: "Rename account",
        });
        name.addEventListener("change", () => void act(() => update(profile, { label: name.value })));
        const connected = profile.auth.state === "authenticated";
        const badge = el("span", {
          className: "glosa-agent-state",
          "data-connected": String(connected && profile.enabled),
          textContent: profile.cleanup
            ? "Cleanup needed"
            : !profile.enabled
              ? "Disabled"
              : connected
                ? "Connected"
                : profile.auth.state === "expired"
                  ? "Sign-in expired"
                  : profile.auth.state === "probe_failed"
                    ? "Could not verify"
                    : profile.auth.state === "identity_mismatch"
                      ? "Different account detected"
                      : profile.auth.state === "unknown"
                        ? "Not checked"
                        : "Not connected",
        });
        const summary = el("div", { className: "glosa-agent-account-summary" }, [
          name,
          el("div", { className: "glosa-agent-account-meta" }, [
            badge,
            ...(profile.auth.plan ? [el("span", { textContent: profile.auth.plan })] : []),
            ...(profile.isDefault ? [el("span", { className: "glosa-agent-default", textContent: "Default" })] : []),
          ]),
        ]);
        const details = el("details", { className: "glosa-agent-account-details" }, [
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
                    message.textContent = error.message;
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
        const mcp = el("details", {}, [el("summary", { textContent: "Account MCP servers" })]);
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
        const primary = verify
          ? check
          : !connected
            ? signIn
            : !state.capabilities?.[profile.id]?.models?.length
              ? models
              : check;
        if (!connected) primary.classList.add("glosa-agent-primary");
        enable.textContent = profile.enabled ? "Enabled" : "Disabled";
        enable.setAttribute("aria-label", `${profile.enabled ? "Disable" : "Enable"} ${profile.label}`);
        enable.setAttribute("aria-pressed", String(profile.enabled));
        enable.classList.add("glosa-agent-enable");
        accountMenu.popup.append(
          ...[defaultButton, check, signIn, models, signOut, remove].filter((item) => item !== primary),
        );
        actions.replaceChildren(enable, primary, accountMenu.element);
        card.append(el("div", { className: "glosa-agent-account-heading" }, [summary, actions]));
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
        section.append(card);
      }
      const label = el("input", {
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
        if (label.value.trim())
          void act(() =>
            dataAccess.createAgentProfile({
              requestId: crypto.randomUUID(),
              provider: provider.id,
              label: label.value.trim(),
            }),
          );
      });
      section.append(form, runtime);
      body.append(section);
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
    message.textContent = error.message;
  });
  return {
    element: root,
    kind: "agent-settings",
    title: "Agents",
    ready,
    destroy() {
      disposed = true;
      loginAbort.abort();
      void login?.destroy().catch(() => {});
      root.remove();
    },
  };
}

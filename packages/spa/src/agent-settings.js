// SPDX-License-Identifier: Apache-2.0
import { createElement as el } from "./viewer-shell.js";
import { confirmDialog } from "./dialog.js";
import { mountMcpSettings } from "./agent-mcp-settings.js";

export function mountAgentSettings(host, { dataAccess, onChange }) {
  let disposed = false,
    login,
    busy = false;
  const loginAbort = new AbortController();
  const root = el("section", { className: "glosa-agent-settings" });
  const message = el("p", { role: "status", className: "glosa-agent-status" });
  const body = el("div"),
    loginHost = el("div");
  root.append(
    el("h1", { textContent: "Agents" }),
    el("p", {
      textContent:
        "Connect your coding subscriptions. Each account has its own settings and login, separate from your terminal accounts.",
    }),
    message,
    body,
    loginHost,
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
      const loginAbort = new AbortController();
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
    message.textContent = state.recovery ?? state.reason ?? "Accounts are ready when signed in and enabled.";
    body.replaceChildren();
    if (state.unreadableChats?.length)
      body.append(
        el("p", {
          role: "alert",
          textContent: `Chat history needs recovery: ${state.unreadableChats.join(", ")}. These chats cannot run. Their journals were preserved; other documents and chats remain available.`,
        }),
      );
    for (const provider of state.providers) {
      const section = el("section", { className: "glosa-agent-provider" });
      section.append(el("h2", { textContent: provider.name }));
      section.append(
        el("p", {
          textContent: provider.installed
            ? provider.qualified
              ? "Tested runtime installed"
              : "Installed · compatibility qualification pending"
            : "Runtime not installed",
        }),
      );
      section.append(
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
      for (const profile of state.profiles.filter((p) => p.provider === provider.id && !p.removed)) {
        const card = el("article", { className: "glosa-agent-account" });
        const name = el("input", { value: profile.label, maxLength: 80, "aria-label": "Account label" });
        name.addEventListener("change", () => void act(() => update(profile, { label: name.value })));
        card.append(
          name,
          el("p", {
            textContent: `${profile.auth.label ?? "Not identified"} · ${profile.auth.state.replaceAll("_", " ")}${profile.auth.plan ? ` · ${profile.auth.plan}` : ""}${profile.auth.method ? ` · ${profile.auth.method}` : ""} · Checked ${new Date(profile.auth.observedAt).toLocaleString()}`,
          }),
        );
        const actions = el("div", { className: "glosa-agent-actions" });
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
            profile.isDefault ? "Default · clear" : "Make default",
            () => update(profile, { isDefault: !profile.isDefault }),
            !profile.enabled || profile.auth.state !== "authenticated",
          ),
          button("Check account", () => dataAccess.probeAgent(profile.id), !profile.enabled || !state.available),
          button(
            "Sign in again",
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
        card.append(actions, mcp);
        section.append(card);
      }
      const label = el("input", {
        placeholder: "Account label, e.g. Personal",
        maxLength: 80,
        required: true,
        "aria-label": `${provider.name} account label`,
      });
      const form = el("form", { className: "glosa-agent-actions" }, [
        label,
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
      section.append(form);
      body.append(section);
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

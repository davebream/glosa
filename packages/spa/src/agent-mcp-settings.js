// SPDX-License-Identifier: Apache-2.0
import { createElement as el } from "./viewer-shell.js";
import { confirmDialog } from "./dialog.js";

/** Editable MCP configuration. Saving consents to configuration, never launches a server. A person
 * reads "tool server": MCP is the protocol's name, not theirs. */
export function mountMcpSettings(host, { servers = [], onSave, onReset = null }) {
  let values = structuredClone(servers),
    busy = false;
  const root = el("section", { className: "glosa-mcp-settings" });
  const list = el("div"),
    status = el("p", { role: "status" });
  root.append(
    el("p", {
      textContent:
        "Tool servers give the agent extra abilities, such as looking something up. They connect only when you send a message, and may read what the agent passes to them. glosa's own tools for notes and documents are always available.",
    }),
    list,
    status,
  );
  const label = (text, input) => el("label", {}, [document.createTextNode(text), input]);
  function render() {
    list.replaceChildren();
    values.forEach((server) => {
      const card = el("fieldset"),
        enabled = el("input", { type: "checkbox", checked: server.enabled });
      enabled.addEventListener("change", () => {
        server.enabled = enabled.checked;
      });
      const name = el("input", { value: server.label, maxLength: 80 });
      name.addEventListener("input", () => {
        server.label = name.value;
      });
      const transport = el("select", {}, [
        el("option", { value: "stdio", textContent: "Local program" }),
        el("option", { value: "http", textContent: "HTTP endpoint" }),
      ]);
      transport.value = server.transport;
      transport.addEventListener("change", () => {
        const common = { id: server.id, label: server.label, enabled: server.enabled };
        values = values.map((item) =>
          item === server
            ? {
                ...common,
                transport: transport.value,
                ...(transport.value === "http" ? { url: "" } : { command: "", args: [] }),
              }
            : item,
        );
        render();
      });
      card.append(
        el("legend", { textContent: "Tool server" }),
        label("Enabled", enabled),
        label("Name", name),
        label("Connection", transport),
      );
      if (server.transport === "http") {
        const url = el("input", { type: "url", value: server.url, placeholder: "https://example.com/mcp" });
        url.addEventListener("input", () => {
          server.url = url.value;
        });
        card.append(label("Endpoint · no credentials in the URL", url));
      } else {
        const command = el("input", { value: server.command, placeholder: "/absolute/path/to/server" });
        command.addEventListener("input", () => {
          server.command = command.value;
        });
        const args = el("textarea", { rows: 3, value: server.args.join("\n") });
        args.addEventListener("input", () => {
          server.args = args.value ? args.value.split("\n") : [];
        });
        card.append(label("Executable", command), label("Arguments · one per line, without shell quoting", args));
      }
      card.append(
        el("button", {
          type: "button",
          textContent: "Remove server",
          onClick: () => {
            values = values.filter((item) => item !== server);
            render();
          },
        }),
      );
      list.append(card);
    });
  }
  const run = async (fn) => {
    if (busy) return;
    busy = true;
    root.setAttribute("aria-busy", "true");
    try {
      await fn();
      status.textContent = "Saved. Review workspace access before sending the next message.";
    } catch (error) {
      status.textContent = error.message;
    } finally {
      busy = false;
      root.removeAttribute("aria-busy");
    }
  };
  const actions = el("div", { className: "glosa-chat-tools-actions" });
  root.append(actions);
  actions.append(
    el("button", {
      type: "button",
      textContent: "Add a tool server",
      onClick: () => {
        if (values.length >= 8) {
          status.textContent = "At most eight tool servers can be configured.";
          return;
        }
        values.push({
          id: `server-${crypto.randomUUID().slice(0, 8)}`,
          label: "New server",
          enabled: false,
          transport: "stdio",
          command: "",
          args: [],
        });
        render();
      },
    }),
    el("button", {
      type: "button",
      className: "glosa-agent-primary",
      textContent: "Save",
      onClick: () =>
        void run(async () => {
          const configured = values
            .filter((server) => server.enabled)
            .map((server) => `${server.label}: ${server.transport === "http" ? server.url : server.command}`)
            .join("\n");
          if (
            !(await confirmDialog({
              title: "Save tool access?",
              body: `Affected chats will stop. Enabled servers can receive workspace content when you next send a message.\n${configured || "No external servers enabled."}`,
              confirmLabel: "Save configuration",
            }))
          )
            return;
          await onSave(structuredClone(values));
        }),
    }),
  );
  if (onReset)
    actions.append(
      el("button", {
        type: "button",
        textContent: "Use account defaults",
        onClick: () =>
          void run(async () => {
            if (
              await confirmDialog({
                title: "Use this account's default tools?",
                body: "Affected chats will stop. The next send requires you to review workspace access again.",
                confirmLabel: "Use defaults",
              })
            )
              await onReset();
          }),
      }),
    );
  host.append(root);
  render();
  return {
    destroy() {
      root.remove();
    },
  };
}

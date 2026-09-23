// SPDX-License-Identifier: Apache-2.0
// Login credentials remain inside the provider's unmodified terminal. Operation grants are memory-only.
import { createElement as el } from "./viewer-shell.js";

export function validLoginUrl(value, hosts, mcp = false) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      (mcp || hosts.includes(url.hostname))
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export async function mountAgentLogin(
  host,
  { dataAccess, profile, onFinished, signal, workspace = undefined, serverId = undefined },
) {
  const { Terminal } = await import("./vendor/xterm.mjs");
  if (!document.querySelector("link[data-agent-terminal]")) {
    document.head.append(
      el("link", { rel: "stylesheet", href: "/app/vendor/xterm.css", "data-agent-terminal": "true" }),
    );
  }
  if (signal?.aborted) return { destroy: async () => {} };
  const operation = workspace
    ? await dataAccess.loginAgentMcp(profile.id, workspace, serverId)
    : await dataAccess.loginAgent(profile.id);
  if (signal?.aborted) {
    await dataAccess.finishAgentLogin(operation.id, operation.secret);
    return { destroy: async () => {} };
  }
  let closed = false,
    inactive = false,
    offset = 0,
    timer,
    pending = Promise.resolve();
  const status = el("p", {
    role: "status",
    textContent: workspace
      ? `MCP connections for ${profile.label}. Complete server sign-in in the native manager below.`
      : `Signing in to ${profile.label}. Complete the agent's own login below.`,
  });
  const surface = el("div", { className: "glosa-agent-terminal", "aria-label": "Agent login terminal" });
  const browserLink = el("a", {
    textContent: "Open the agent's sign-in page",
    target: "_blank",
    rel: "noopener noreferrer",
    hidden: true,
  });
  let loginText = "";
  const terminal = new Terminal({
    cols: 88,
    rows: 18,
    scrollback: 1000,
    convertEol: false,
    fontSize: 13,
    allowProposedApi: false,
    screenReaderMode: true,
  });
  const finish = async () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    resizeObserver?.disconnect();
    signal?.removeEventListener("abort", abort);
    terminal.dispose();
    try {
      await pending;
      await dataAccess.finishAgentLogin(operation.id, operation.secret);
    } finally {
      host.replaceChildren();
      onFinished?.();
    }
  };
  const abort = () => void finish().catch(() => {});
  signal?.addEventListener("abort", abort, { once: true });
  let resizeObserver;
  const done = el("button", {
    type: "button",
    textContent: "Finish login",
    onClick: () =>
      void finish().catch((error) => {
        status.textContent = error.message;
      }),
  });
  const endLogin = (message) => {
    if (closed || inactive) return;
    inactive = true;
    clearTimeout(timer);
    resizeObserver?.disconnect();
    loginText = "";
    browserLink.hidden = true;
    browserLink.removeAttribute("href");
    terminal.options.disableStdin = true;
    status.textContent = message;
    done.textContent = "Close terminal";
  };
  const loginError = (error) => {
    if (closed || inactive) return;
    const ended = ["login-not-found", "login-expired", "login-cancelled"].some((code) =>
      error.problem?.type?.endsWith(`/errors/${code}`),
    );
    endLogin(
      ended
        ? "This login expired or was cancelled. Close this terminal and choose Sign in again for a new link."
        : "The connection to this login was lost. Close this terminal and choose Sign in again.",
    );
  };
  host.replaceChildren(status, browserLink, surface, done);
  terminal.parser.registerOscHandler(52, () => true);
  terminal.options.linkHandler = {
    activate(_event, uri) {
      const safe = validLoginUrl(uri, operation.authHosts ?? [], !!workspace);
      if (safe && !closed && !inactive) {
        if (workspace) {
          browserLink.href = safe;
          browserLink.textContent = `Continue sign-in at ${new URL(safe).hostname}`;
          browserLink.hidden = false;
        } else window.open(safe, "_blank", "noopener,noreferrer");
      }
    },
  };
  terminal.open(surface);
  terminal.focus();
  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(() => {
      if (closed || inactive || surface.clientWidth < 80) return;
      const cols = Math.max(20, Math.min(240, Math.floor(surface.clientWidth / 8)));
      const rows = 18;
      if (cols === terminal.cols) return;
      terminal.resize(cols, rows);
      pending = pending
        .then(() =>
          closed || inactive ? undefined : dataAccess.resizeAgentLogin(operation.id, operation.secret, cols, rows),
        )
        .catch(loginError);
    });
    resizeObserver.observe(surface);
  }
  terminal.onData((data) => {
    pending = pending
      .then(() => (closed || inactive ? undefined : dataAccess.writeAgentLogin(operation.id, operation.secret, data)))
      .catch(loginError);
  });
  const poll = async () => {
    if (closed || inactive) return;
    try {
      const result = await dataAccess.readAgentLogin(operation.id, operation.secret, offset);
      if (closed || inactive) return;
      if (result.state === "stopping") {
        endLogin("Login is stopping. Close this terminal; wait for cleanup before signing in again.");
        return;
      }
      if (result.reset) terminal.reset();
      for (const chunk of result.output.trim().split("\n").filter(Boolean)) {
        const bytes = Uint8Array.from(atob(chunk), (c) => c.charCodeAt(0));
        terminal.write(bytes);
        loginText = (loginText + new TextDecoder().decode(bytes)).slice(-32768);
      }
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Remove native ANSI escape sequences before finding browser links.
      const plain = loginText.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r?\n[ \t]*/g, "\n");
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Terminal control bytes must terminate a candidate URL.
      for (const candidate of plain.match(/https:\/\/[^\s<>\x00-\x1f]+/g) ?? []) {
        const safe = validLoginUrl(candidate, operation.authHosts ?? [], !!workspace);
        if (safe) {
          browserLink.href = safe;
          browserLink.textContent = `Continue sign-in at ${new URL(safe).hostname}`;
          browserLink.hidden = false;
        }
      }
      offset = result.offset;
      if (["completed", "failed"].includes(result.state)) {
        endLogin(
          result.state === "completed"
            ? "Login finished. Close this terminal, then check the account."
            : "Login ended. Close this terminal to try again.",
        );
        return;
      }
      timer = setTimeout(poll, 350);
    } catch (error) {
      loginError(error);
    }
  };
  void poll();
  return { destroy: finish };
}

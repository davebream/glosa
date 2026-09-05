// SPDX-License-Identifier: Apache-2.0
// Issue #95 — one explicit agent-feedback control. Connection state is derived only from
// `/api/status`'s explicit workspace_binding + liveness fields. Cwd fallback is deliberately
// invisible here: it may route a turn, but it never proves that a session chose this workspace.

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "onClick") node.addEventListener("click", value);
    else if (key === "onChange") node.addEventListener("change", value);
    else if (key === "className") node.className = value;
    else if (key.startsWith("data-") || key.startsWith("aria-")) node.setAttribute(key, value);
    else node[key] = value;
  }
  for (const child of children) node.append(child);
  return node;
}

function byRecentActivity(a, b) {
  return Date.parse(b.last_active_at ?? "") - Date.parse(a.last_active_at ?? "");
}

/** Pure state derivation for tests and for keeping explicit-binding semantics out of rendering. */
export function deriveAgentConnection(status, slug) {
  const workspace = status?.workspaces?.find((candidate) => candidate.slug === slug);
  if (!workspace) return null;

  const explicit = (status.sessions ?? [])
    .filter((session) => session.workspace_binding === workspace.path)
    .sort(byRecentActivity);
  const live = explicit.filter((session) => session.liveness === "alive");
  const stale = explicit.filter((session) => session.liveness === "stale");

  return {
    state: live.length > 0 ? "connected" : stale.length > 0 ? "stale" : "unbound",
    workspace,
    sessions: [...live, ...stale],
    live,
    stale,
  };
}

/**
 * The provider's own display name for the session bound to this workspace, or null.
 *
 * Null whenever it cannot be proven: no explicit binding, or more than one provider bound and
 * therefore no single answer to "who is asking". A margin card falls back to the generic phrase
 * in that case rather than picking the likelier provider — the same rule the connection banner
 * follows, and the reason cwd fallback is invisible there.
 *
 * The name itself is the PROVIDER's word for itself (R7), not the daemon's and not the SPA's.
 */
export function boundProviderName(connection) {
  const providers = new Set((connection?.sessions ?? []).map((session) => session.provider).filter(Boolean));
  if (providers.size !== 1) return null;
  const [id] = [...providers];
  const match = connection?.workspace?.connect?.providers?.find((candidate) => candidate.provider === id);
  return typeof match?.display_name === "string" && match.display_name.length > 0 ? match.display_name : null;
}

/** The wrapper is generic; the identity-discovery sentence comes verbatim from the provider. */
export function buildAgentConnectPrompt(connection, providerId) {
  const provider = connection?.workspace?.connect?.providers?.find((candidate) => candidate.provider === providerId);
  if (!provider) return "";
  const fallback = connection.workspace.connect?.cli_fallback;
  return [
    "Connect this agent session to glosa.",
    "",
    `Workspace: ${connection.workspace.slug}`,
    `Path: ${connection.workspace.path}`,
    "",
    provider.instruction,
    ...(fallback ? ["", "If the glosa MCP tool is unavailable, use the CLI fallback:", fallback] : []),
  ].join("\n");
}

function providerLabel(connection, providerId) {
  return (
    connection?.workspace?.connect?.providers?.find((provider) => provider.provider === providerId)?.display_name ??
    providerId
  );
}

function initialProvider(connection) {
  const providers = connection?.workspace?.connect?.providers ?? [];
  const staleProvider = connection?.stale?.[0]?.provider;
  if (staleProvider && providers.some((provider) => provider.provider === staleProvider)) return staleProvider;
  return providers.length === 1 ? providers[0].provider : "";
}

function shortSessionId(sessionId) {
  if (!sessionId || sessionId.length <= 18) return sessionId ?? "Unknown session";
  return `${sessionId.slice(0, 8)}…${sessionId.slice(-6)}`;
}

/**
 * Mount the non-modal control. `setState` accepts independently fetched wiring and aggregate
 * status bodies; an absent body renders an honest unavailable state instead of retaining green.
 */
export function mountAgentFeedback(host, { overlayHost = host, onWire = async () => {}, clipboard } = {}) {
  const trigger = el("button", {
    className: "glosa-agent-feedback-trigger",
    type: "button",
    textContent: "Agent feedback unavailable",
    "data-state": "unknown",
    "aria-expanded": "false",
    "aria-controls": "glosa-agent-feedback-popover",
  });
  const popover = el("section", {
    id: "glosa-agent-feedback-popover",
    className: "glosa-agent-feedback-popover",
    role: "region",
    "aria-labelledby": "glosa-agent-feedback-title",
    hidden: true,
  });
  host.append(trigger);
  overlayHost.append(popover);

  let wiring = null;
  let connection = null;
  let selectedProvider = "";
  let selectedSlug = null;
  let copyStatus = "";
  let copyError = false;

  function isOpen() {
    return trigger.getAttribute("aria-expanded") === "true";
  }

  function close({ restoreFocus = true } = {}) {
    trigger.setAttribute("aria-expanded", "false");
    popover.hidden = true;
    if (restoreFocus) queueMicrotask(() => trigger.focus({ preventScroll: true }));
  }

  function setOpen(open) {
    if (!open || !connection || !wiring) {
      close({ restoreFocus: open === false });
      return;
    }
    renderPopover();
    trigger.setAttribute("aria-expanded", "true");
    popover.hidden = false;
    queueMicrotask(() => {
      const first =
        popover.querySelector(".glosa-agent-feedback-provider") ?? popover.querySelector(".glosa-agent-feedback-close");
      first?.focus({ preventScroll: true });
    });
  }

  function renderTrigger() {
    if (!connection || !wiring) {
      trigger.textContent = "Agent feedback unavailable";
      trigger.setAttribute("data-state", "unknown");
      trigger.setAttribute("aria-label", "Agent feedback status unavailable");
      trigger.title = "Agent feedback status unavailable";
      trigger.disabled = true;
      close({ restoreFocus: false });
      return;
    }

    const stateLabels = {
      connected: "Agent connected",
      stale: "Agent stale",
      unbound: "Connect agent",
    };
    const feedbackOff = wiring.state === "unwired" ? " · feedback off" : "";
    const pendingCount = connection.workspace.pending_count ?? wiring.pending_count ?? 0;
    const pending = pendingCount > 0 ? ` · ${pendingCount} queued` : "";
    const label = `● ${stateLabels[connection.state]}${feedbackOff}${pending}`;

    trigger.disabled = false;
    trigger.textContent = label;
    trigger.setAttribute("data-state", connection.state);
    trigger.setAttribute("data-wiring", wiring.state);
    trigger.setAttribute("aria-label", label.replace("● ", "Agent feedback: "));
    trigger.title = label.replace("● ", "");
  }

  function renderSessions(container) {
    const list = el("ul", { className: "glosa-agent-feedback-sessions" });
    for (const session of connection.sessions) {
      list.append(
        el("li", {}, [
          el("span", { textContent: providerLabel(connection, session.provider) }),
          el("code", { textContent: shortSessionId(session.session_id), title: session.session_id }),
          el("span", {
            className: "glosa-agent-feedback-liveness",
            "data-liveness": session.liveness,
            textContent: session.liveness === "alive" ? "live" : "stale",
          }),
        ]),
      );
    }
    container.append(list);
  }

  function renderConnectControls(container) {
    const providers = connection.workspace.connect?.providers ?? [];
    const select = el("select", {
      id: "glosa-agent-feedback-provider",
      className: "glosa-agent-feedback-provider",
      "aria-label": "Agent provider",
      onChange: (event) => {
        selectedProvider = event.currentTarget.value;
        copyStatus = "";
        copyError = false;
        renderPopover();
        queueMicrotask(() => popover.querySelector("#glosa-agent-feedback-provider")?.focus());
      },
    });
    if (providers.length !== 1 && connection.state === "unbound") {
      select.append(el("option", { value: "", textContent: "Choose an agent…" }));
    }
    for (const provider of providers) {
      select.append(el("option", { value: provider.provider, textContent: provider.display_name }));
    }
    select.value = selectedProvider;

    const prompt = buildAgentConnectPrompt(connection, selectedProvider);
    const textarea = el("textarea", {
      className: "glosa-agent-feedback-prompt",
      readOnly: true,
      rows: 9,
      value: prompt,
      placeholder: providers.length === 0 ? "No provider connect prompts are available." : "Choose an agent first.",
      "aria-label": "Agent connection prompt",
    });
    const status = el("p", {
      className: "glosa-agent-feedback-copy-status",
      role: "status",
      "aria-live": "polite",
      textContent: copyStatus,
      hidden: !copyStatus,
      "data-error": String(copyError),
    });
    const copyButton = el("button", {
      className: "glosa-primary-button glosa-agent-feedback-copy",
      type: "button",
      textContent: "Copy prompt",
      disabled: !prompt,
      onClick: async () => {
        try {
          const targetClipboard = clipboard ?? (typeof navigator === "undefined" ? null : navigator.clipboard);
          if (!targetClipboard?.writeText) throw new Error("Clipboard unavailable");
          await targetClipboard.writeText(prompt);
          copyStatus = "Connect prompt copied.";
          copyError = false;
          status.textContent = copyStatus;
          status.hidden = false;
          status.setAttribute("data-error", "false");
        } catch {
          copyStatus = "Couldn't copy automatically. The prompt is selected so you can copy it manually.";
          copyError = true;
          status.textContent = copyStatus;
          status.hidden = false;
          status.setAttribute("data-error", "true");
          textarea.focus();
          textarea.select?.();
          textarea.setSelectionRange?.(0, textarea.value.length);
        }
      },
    });

    container.append(
      el("label", { className: "glosa-agent-feedback-provider-label", htmlFor: select.id, textContent: "Agent" }),
      select,
      textarea,
      el("div", { className: "glosa-agent-feedback-actions" }, [copyButton]),
      status,
    );
  }

  function renderPopover() {
    if (!connection || !wiring) return;
    popover.textContent = "";
    const closeButton = el("button", {
      className: "glosa-agent-feedback-close",
      type: "button",
      "aria-label": "Close agent feedback",
      textContent: "×",
      onClick: () => close(),
    });
    popover.append(
      el("div", { className: "glosa-agent-feedback-heading" }, [
        el("h2", { id: "glosa-agent-feedback-title", textContent: "Agent feedback" }),
        closeButton,
      ]),
    );

    if (connection.state === "connected") {
      const count = connection.live.length;
      popover.append(
        el("p", {
          className: "glosa-agent-feedback-summary",
          textContent:
            count === 1 ? "An explicitly bound agent session is connected." : `${count} agent sessions are connected.`,
        }),
      );
      renderSessions(popover);
    } else {
      popover.append(
        el("p", {
          className: "glosa-agent-feedback-summary",
          textContent:
            connection.state === "stale"
              ? "The previous explicit session is stale. Paste this prompt into the session you want to reconnect."
              : "No agent session is explicitly bound. Choose an agent, then paste this prompt into it.",
        }),
      );
      if (connection.state === "stale") renderSessions(popover);
      renderConnectControls(popover);
    }

    if (wiring.state === "unwired") {
      popover.append(
        el("div", { className: "glosa-agent-feedback-wiring" }, [
          el("p", {
            textContent:
              "Feedback integration is off. Prompts can still bind a session after the integration is installed.",
          }),
          el("button", {
            className: "glosa-secondary-button",
            type: "button",
            textContent: "Wire it now",
            onClick: async () => {
              close();
              await onWire();
            },
          }),
        ]),
      );
    }
  }

  trigger.addEventListener("click", () => setOpen(!isOpen()));
  const onKeyDown = (event) => {
    if (event.key !== "Escape" || !isOpen()) return;
    event.preventDefault();
    close();
  };
  const onDocumentClick = (event) => {
    if (!isOpen() || !(event.target instanceof Node)) return;
    if (host.contains(event.target) || popover.contains(event.target)) return;
    close();
  };
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("click", onDocumentClick);

  renderTrigger();
  return {
    /** Proven provider name for the bound session, or null. See `boundProviderName`. */
    providerName() {
      return boundProviderName(connection);
    },
    setState(next) {
      wiring = next.wiring ?? null;
      connection = deriveAgentConnection(next.status, next.slug);
      const slug = connection?.workspace?.slug ?? null;
      const providers = connection?.workspace?.connect?.providers ?? [];
      if (slug !== selectedSlug) {
        selectedSlug = slug;
        selectedProvider = initialProvider(connection);
        copyStatus = "";
        copyError = false;
      } else if (!providers.some((provider) => provider.provider === selectedProvider)) {
        selectedProvider = initialProvider(connection);
      } else if (!selectedProvider && connection?.state === "stale") {
        selectedProvider = initialProvider(connection);
      }
      renderTrigger();
      if (isOpen()) renderPopover();
    },
    close,
    destroy() {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("click", onDocumentClick);
      trigger.remove();
      popover.remove();
    },
  };
}

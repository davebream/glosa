// SPDX-License-Identifier: Apache-2.0
// Workspace-scoped attention badge and tray. It never changes the active workspace.
function node(tag, props = {}, children = []) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "className") element.className = value;
    else if (key.startsWith("aria-") || key.startsWith("data-")) element.setAttribute(key, value);
    else element[key] = value;
  }
  for (const child of children) element.append(child);
  return element;
}

const STATUS_LABELS = { open: "Waiting", delivered: "Delivered", seen: "Seen" };

export function mountAttentionTray(host, { dataAccess }) {
  let slug = null;
  let open = false;
  let entries = [];
  let loading = false;
  let loadError = "";
  let destroyed = false;
  let refreshPromise = null;

  const trigger = node("button", {
    className: "glosa-attention-trigger",
    type: "button",
    "aria-expanded": "false",
    "aria-controls": "glosa-attention-tray",
    "aria-label": "Attention requests",
  });
  trigger.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3.2a4.6 4.6 0 0 0-4.6 4.6v2.5L4 12.7h12l-1.4-2.4V7.8A4.6 4.6 0 0 0 10 3.2ZM8.2 15a2 2 0 0 0 3.6 0"/></svg><span class="glosa-attention-label">Attention</span><span class="glosa-attention-badge" hidden>0</span>';
  const tray = node("section", {
    id: "glosa-attention-tray",
    className: "glosa-attention-tray",
    hidden: true,
    "aria-labelledby": "glosa-attention-title",
  });
  host.append(trigger, tray);

  function updateTrigger() {
    const badge = trigger.querySelector(".glosa-attention-badge");
    badge.textContent = String(entries.length);
    badge.hidden = entries.length === 0;
    trigger.disabled = !slug;
    trigger.setAttribute("aria-expanded", String(open));
    trigger.setAttribute("aria-label", entries.length > 0 ? `Attention requests, ${entries.length} pending` : "Attention requests, none pending");
  }

  function render() {
    tray.textContent = "";
    tray.hidden = !open;
    updateTrigger();
    if (!open) return;

    const close = node("button", { className: "glosa-attention-close", type: "button", textContent: "Close", "aria-label": "Close attention requests" });
    close.addEventListener("click", () => setOpen(false, true));
    tray.append(node("div", { className: "glosa-attention-heading" }, [node("h2", { id: "glosa-attention-title", textContent: "Attention" }), close]));

    if (loading) {
      tray.append(node("p", { className: "glosa-attention-state", textContent: "Loading requests…", role: "status" }));
      return;
    }
    if (loadError) {
      const retry = node("button", { className: "glosa-secondary-button", type: "button", textContent: "Try again" });
      retry.addEventListener("click", () => void refresh());
      tray.append(node("div", { className: "glosa-attention-state", role: "alert" }, [node("p", { textContent: loadError }), retry]));
      return;
    }
    if (entries.length === 0) {
      tray.append(node("p", { className: "glosa-attention-state", textContent: "No requests need your attention.", role: "status" }));
      return;
    }

    const list = node("ul", { className: "glosa-attention-list" });
    for (const entry of entries) {
      const response = node("textarea", { className: "glosa-attention-response", rows: 2, maxLength: 4096, placeholder: "Optional response", "aria-label": `Response to ${entry.message ?? entry.target ?? "request"}` });
      const status = node("p", { className: "glosa-attention-response-status", role: "status", "aria-live": "polite" });
      const actions = node("div", { className: "glosa-attention-actions" });

      const submit = async (outcome, button) => {
        status.textContent = "";
        response.disabled = true;
        for (const candidate of actions.querySelectorAll("button")) candidate.disabled = true;
        button.textContent = "Saving…";
        try {
          await dataAccess.respondToAttention(slug, entry.id, { outcome, response: response.value });
          await refresh();
          if (open) tray.querySelector("button, textarea")?.focus({ preventScroll: true });
        } catch (error) {
          response.disabled = false;
          for (const candidate of actions.querySelectorAll("button")) candidate.disabled = false;
          status.textContent = error instanceof Error ? error.message : "The response could not be saved.";
          button.textContent = button.dataset.label;
          response.focus();
        }
      };

      const specs = entry.action === "review"
        ? [["approved", "Approve"], ["changes_requested", "Request changes"]]
        : [["done", "Done"]];
      for (const [outcome, label] of specs) {
        const button = node("button", { className: outcome === "approved" || outcome === "done" ? "glosa-primary-button" : "glosa-secondary-button", type: "button", textContent: label, "data-label": label });
        button.addEventListener("click", () => void submit(outcome, button));
        actions.append(button);
      }

      list.append(node("li", { className: "glosa-attention-item" }, [
        node("div", { className: "glosa-attention-meta" }, [
          node("span", { textContent: STATUS_LABELS[entry.status] ?? entry.status }),
          ...(entry.target ? [node("code", { textContent: entry.target })] : []),
        ]),
        node("p", { className: "glosa-attention-message", textContent: entry.message ?? "A session requested your attention." }),
        response,
        actions,
        status,
      ]));
    }
    tray.append(list);
  }

  function focusedControl() {
    const active = document.activeElement;
    if (!active || !tray.contains(active)) return null;
    if (active.classList.contains("glosa-attention-close")) return ".glosa-attention-close";
    const ariaLabel = active.getAttribute("aria-label");
    if (ariaLabel) return `[aria-label="${CSS.escape(ariaLabel)}"]`;
    const dataLabel = active.getAttribute("data-label");
    if (dataLabel) return `[data-label="${CSS.escape(dataLabel)}"]`;
    return null;
  }

  async function performRefresh() {
    if (!slug || destroyed) return;
    const restoreFocus = focusedControl();
    loading = true;
    loadError = "";
    render();
    try {
      const result = await dataAccess.getInbox(slug);
      entries = result.attention ?? [];
      if (open) {
        await Promise.all(entries.filter((entry) => entry.status === "open" || entry.status === "delivered").map((entry) => dataAccess.markAttentionSeen(slug, entry.id)));
        const seen = await dataAccess.getInbox(slug);
        entries = seen.attention ?? [];
      }
    } catch (error) {
      loadError = error instanceof Error ? error.message : "Attention requests could not be loaded.";
    } finally {
      loading = false;
      render();
      if (restoreFocus) tray.querySelector(restoreFocus)?.focus({ preventScroll: true });
    }
  }

  function refresh() {
    if (refreshPromise) return refreshPromise;
    refreshPromise = performRefresh().finally(() => {
      refreshPromise = null;
    });
    return refreshPromise;
  }

  function setOpen(next, restoreFocus = false) {
    open = next;
    render();
    if (open) {
      void refresh().then(() => tray.querySelector("button, textarea")?.focus());
    } else if (restoreFocus) {
      trigger.focus({ preventScroll: true });
    }
  }

  trigger.addEventListener("click", () => setOpen(!open, open));
  tray.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false, true);
    }
  });
  updateTrigger();

  return {
    setWorkspace(nextSlug) {
      slug = nextSlug;
      open = false;
      entries = [];
      render();
      void refresh();
    },
    refresh,
    destroy() {
      destroyed = true;
      host.textContent = "";
    },
  };
}

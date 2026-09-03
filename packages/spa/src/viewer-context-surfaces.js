// SPDX-License-Identifier: Apache-2.0
// Contextual History, Conversation, and keyboard-shortcut surfaces. This controller is deliberately
// transport-free: mountApp injects its one data-access instance, lazy module loaders, and live state.

export function createContextSurfaceController({
  dataAccess,
  elements,
  getState,
  loadHistoryPane,
  loadConversationPane,
  createElement,
  returnFocus,
}) {
  const { historyEl, conversationEl, shortcutsEl, historyToggle, conversationToggle, shortcutsToggle } = elements;
  let historyVisible = false;
  let conversationVisible = false;
  let shortcutsVisible = false;
  let stopConversation = null;

  function closeContextSurfaces(except = null) {
    if (except !== "history") {
      historyVisible = false;
      historyEl.hidden = true;
      historyToggle.setAttribute("aria-expanded", "false");
    }
    if (except !== "conversation") setConversationVisible(false);
    if (except !== "shortcuts") {
      shortcutsVisible = false;
      shortcutsEl.hidden = true;
      shortcutsToggle.setAttribute("aria-expanded", "false");
    }
  }

  async function renderHistory() {
    const { slug } = getState();
    if (!historyVisible || !slug) return;
    try {
      const mountHistoryPane = await loadHistoryPane();
      if (!historyVisible || getState().slug !== slug) return;
      const { artifactPath, mode } = getState();
      mountHistoryPane(historyEl, {
        dataAccess,
        slug,
        path: artifactPath,
        canRestore: mode === "edit",
        onClose: () => {
          historyVisible = false;
          historyEl.hidden = true;
          historyToggle.setAttribute("aria-expanded", "false");
          returnFocus();
        },
      });
      queueMicrotask(() => historyEl.querySelector("h3")?.focus({ preventScroll: true }));
    } catch {
      if (!historyVisible || getState().slug !== slug) return;
      historyEl.setAttribute("role", "alert");
      historyEl.textContent = "History couldn't be loaded. Close this panel and try again.";
    }
  }

  function setConversationVisible(visible) {
    conversationVisible = visible;
    conversationEl.hidden = !conversationVisible;
    conversationToggle.setAttribute("aria-expanded", String(conversationVisible));
    void renderConversation();
  }

  async function renderConversation() {
    stopConversation?.();
    stopConversation = null;
    const { slug } = getState();
    if (!conversationVisible || !slug) return;
    try {
      const mountConversationPane = await loadConversationPane();
      if (!conversationVisible || getState().slug !== slug) return;
      const { mode } = getState();
      stopConversation = mountConversationPane(conversationEl, {
        dataAccess,
        slug,
        readOnly: mode === "preview",
        onClose: () => {
          setConversationVisible(false);
          returnFocus();
        },
      });
    } catch {
      if (!conversationVisible || getState().slug !== slug) return;
      conversationEl.setAttribute("role", "alert");
      conversationEl.textContent = "Conversation couldn't be loaded. Close this panel and use the terminal.";
    }
  }

  function onHistoryToggle() {
    const nextVisible = !historyVisible;
    if (nextVisible) closeContextSurfaces("history");
    historyVisible = nextVisible;
    historyEl.hidden = !historyVisible;
    historyToggle.setAttribute("aria-expanded", String(historyVisible));
    void renderHistory();
  }

  function onConversationToggle() {
    const nextVisible = !conversationVisible;
    if (nextVisible) closeContextSurfaces("conversation");
    setConversationVisible(nextVisible);
  }

  function onShortcutsToggle() {
    const nextVisible = !shortcutsVisible;
    if (nextVisible) closeContextSurfaces("shortcuts");
    shortcutsVisible = nextVisible;
    shortcutsEl.hidden = !nextVisible;
    shortcutsToggle.setAttribute("aria-expanded", String(nextVisible));
    if (!nextVisible) return;

    shortcutsEl.textContent = "";
    const close = createElement("button", {
      type: "button",
      className: "glosa-context-close",
      textContent: "Close keyboard shortcuts",
      onClick: () => {
        shortcutsVisible = false;
        shortcutsEl.hidden = true;
        shortcutsToggle.setAttribute("aria-expanded", "false");
        returnFocus();
      },
    });
    shortcutsEl.append(
      createElement("h3", { tabIndex: -1, textContent: "Keyboard shortcuts" }),
      createElement("p", { textContent: "⌘/Ctrl+1 Preview · ⌘/Ctrl+2 Annotate · ⌘/Ctrl+3 Edit" }),
      close,
    );
    queueMicrotask(() => shortcutsEl.querySelector("h3")?.focus({ preventScroll: true }));
  }

  historyToggle.addEventListener("click", onHistoryToggle);
  conversationToggle.addEventListener("click", onConversationToggle);
  shortcutsToggle.addEventListener("click", onShortcutsToggle);

  return {
    closeContextSurfaces,
    renderHistory,
    renderConversation,
    destroy() {
      historyToggle.removeEventListener("click", onHistoryToggle);
      conversationToggle.removeEventListener("click", onConversationToggle);
      shortcutsToggle.removeEventListener("click", onShortcutsToggle);
      stopConversation?.();
    },
  };
}

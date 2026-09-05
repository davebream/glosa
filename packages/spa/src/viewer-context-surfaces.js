// SPDX-License-Identifier: Apache-2.0
// The workspace's contextual surfaces: Conversation and the keyboard-shortcut sheet. This
// controller is deliberately transport-free: mountApp injects its one data-access instance, lazy
// module loaders, and live state.
//
// History used to live here too. It is artifact-scoped — history.js keys on slug AND path — so
// the 2026-09-04 workbench brief §6 moved it inside the pane that holds its artifact, where it
// can honestly describe one document. artifact-pane.js owns it now.

/** Every binding the workbench answers to, in the reader's own words. §9 makes documenting the
 * single-pointer equivalents to dragging a release requirement, not a nicety — this sheet and
 * each pane's "Move tab to" menu are where they are findable. */
export const SHORTCUTS = [
  ["\u2318 / Ctrl + 1", "Preview"],
  ["\u2318 / Ctrl + 2", "Annotate"],
  ["\u2318 / Ctrl + 3", "Edit"],
  ["Ctrl + Tab", "Next tab in this pane"],
  ["Ctrl + Shift + Tab", "Previous tab in this pane"],
  ["\u2318 / Ctrl + \u2325 + \u2192", "Focus the pane to the right"],
  ["\u2318 / Ctrl + \u2325 + \u2190", "Focus the pane to the left"],
  ["\u2318 / Ctrl + \\", "Move this tab into a new split"],
  ["\u2318 / Ctrl + W", "Close this tab"],
  ["Esc", "Close the artifact drawer"],
];

export function createContextSurfaceController({
  dataAccess,
  elements,
  getState,
  loadConversationPane,
  createElement,
  returnFocus,
}) {
  const { conversationEl, shortcutsEl, conversationToggle, shortcutsToggle } = elements;
  let conversationVisible = false;
  let shortcutsVisible = false;
  let stopConversation = null;

  function closeContextSurfaces(except = null) {
    if (except !== "conversation") setConversationVisible(false);
    if (except !== "shortcuts") {
      shortcutsVisible = false;
      shortcutsEl.hidden = true;
      shortcutsToggle.setAttribute("aria-expanded", "false");
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
        readOnly: mode === "read",
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
    const sheet = createElement("dl", { className: "glosa-shortcut-list" });
    for (const [keys, action] of SHORTCUTS) {
      sheet.append(createElement("dt", { textContent: keys }), createElement("dd", { textContent: action }));
    }
    shortcutsEl.append(createElement("h3", { tabIndex: -1, textContent: "Keyboard shortcuts" }), sheet, close);
    queueMicrotask(() => shortcutsEl.querySelector("h3")?.focus({ preventScroll: true }));
  }

  conversationToggle.addEventListener("click", onConversationToggle);
  shortcutsToggle.addEventListener("click", onShortcutsToggle);

  return {
    closeContextSurfaces,
    renderConversation,
    destroy() {
      conversationToggle.removeEventListener("click", onConversationToggle);
      shortcutsToggle.removeEventListener("click", onShortcutsToggle);
      stopConversation?.();
    },
  };
}

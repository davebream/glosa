// SPDX-License-Identifier: Apache-2.0
// The workspace keyboard-shortcut sheet. Chats live in dock panels. This
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
  ["\u2318 / Ctrl + E", "Edit this page, or Done"],
  ["\u2318 / Ctrl + 1", "Hide notes"],
  ["\u2318 / Ctrl + 2", "Show notes"],
  ["\u2318 / Ctrl + K", "Go to a section, a file or a command"],
  ["Ctrl + Tab", "Next tab in this pane"],
  ["Ctrl + Shift + Tab", "Previous tab in this pane"],
  ["\u2318 / Ctrl + \u2325 + \u2192", "Focus the pane to the right"],
  ["\u2318 / Ctrl + \u2325 + \u2190", "Focus the pane to the left"],
  ["\u2318 / Ctrl + \\", "Move this tab into a new split"],
  ["\u2318 / Ctrl + W", "Close this tab"],
  ["Esc", "Close the artifact drawer"],
];

export function createContextSurfaceController({ elements, createElement, returnFocus }) {
  const { shortcutsEl, shortcutsToggle } = elements;
  let shortcutsVisible = false;
  function closeContextSurfaces() {
    shortcutsVisible = false;
    shortcutsEl.hidden = true;
    shortcutsToggle.setAttribute("aria-expanded", "false");
  }
  function onShortcutsToggle() {
    const nextVisible = !shortcutsVisible;
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

  shortcutsToggle.addEventListener("click", onShortcutsToggle);

  return {
    closeContextSurfaces,
    destroy() {
      shortcutsToggle.removeEventListener("click", onShortcutsToggle);
      closeContextSurfaces();
    },
  };
}

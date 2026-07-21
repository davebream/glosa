// SPDX-License-Identifier: Apache-2.0
// @glosa/spa — the one confirm dialog (native <dialog>, app.css-styled): a titled question, a
// plain-sentence body, Cancel, and one clearly-named action. Replaces window.confirm so
// destructive choices read like the rest of the workbench instead of a browser alert.
//
// Talks to the daemon through NOTHING — pure DOM; environments without <dialog>.showModal
// (very old engines, some headless DOMs) fall back to window.confirm so the flow never blocks.

/**
 * Shows a modal question. Resolves true when the user confirms, false otherwise (cancel, Esc,
 * or backdrop light-dismiss).
 *
 * @param {{title: string, body?: string, confirmLabel?: string, danger?: boolean}} opts
 * @returns {Promise<boolean>}
 */
export function confirmDialog({ title, body, confirmLabel = "Continue", danger = false }) {
  const dialog = document.createElement("dialog");
  if (typeof dialog.showModal !== "function") {
    const ok = typeof window !== "undefined" && window.confirm ? window.confirm(body ? `${title}\n\n${body}` : title) : true;
    return Promise.resolve(ok);
  }

  return new Promise((resolve) => {
    dialog.className = "glosa-dialog";
    const heading = document.createElement("h2");
    heading.textContent = title;
    dialog.append(heading);
    if (body) {
      const p = document.createElement("p");
      p.textContent = body;
      dialog.append(p);
    }
    const actions = document.createElement("div");
    actions.className = "glosa-dialog-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "glosa-btn glosa-btn-ghost";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => dialog.close("cancel"));
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = danger ? "glosa-btn glosa-btn-danger" : "glosa-save";
    confirm.textContent = confirmLabel;
    confirm.addEventListener("click", () => dialog.close("confirm"));
    actions.append(cancel, confirm);
    dialog.append(actions);

    // Backdrop click = light dismiss (the dialog itself swallows clicks on its own surface).
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) dialog.close("cancel");
    });
    dialog.addEventListener("close", () => {
      resolve(dialog.returnValue === "confirm");
      dialog.remove();
    });

    document.body.append(dialog);
    dialog.showModal();
    confirm.focus();
  });
}

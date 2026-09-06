// SPDX-License-Identifier: Apache-2.0
// @glosa/spa — the workbench's dialogs (native <dialog>, app.css-styled): a titled question, a
// plain-sentence body, Cancel, and one or two clearly-named actions. Replaces window.confirm so
// destructive choices read like the rest of the workbench instead of a browser alert.
//
// Talks to the daemon through NOTHING — pure DOM; environments without <dialog>.showModal
// (very old engines, some headless DOMs) fall back to window.confirm so the flow never blocks.

let dialogId = 0;

/**
 * Shows a modal question. Resolves true when the user confirms, false otherwise (cancel, Esc,
 * or backdrop light-dismiss).
 *
 * @param {{title: string, body?: string, confirmLabel?: string, danger?: boolean}} opts
 * @returns {Promise<boolean>}
 */
/**
 * Single-button informational variant of confirmDialog (issue #81) — for telling, not asking:
 * a mandatory Cancel next to pure information reads wrong. Same native <dialog> + window.alert
 * fallback scaffolding; resolves when dismissed (button, Esc, or backdrop).
 *
 * @param {{title: string, body?: string, dismissLabel?: string}} opts
 * @returns {Promise<void>}
 */
export function noticeDialog({ title, body, dismissLabel = "Got it" }) {
  const dialog = document.createElement("dialog");
  if (typeof dialog.showModal !== "function") {
    if (typeof window !== "undefined" && window.alert) window.alert(body ? `${title}\n\n${body}` : title);
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const previousFocus = document.activeElement;
    const id = `glosa-dialog-${++dialogId}`;
    dialog.className = "glosa-dialog";
    const heading = document.createElement("h2");
    heading.id = `${id}-title`;
    heading.textContent = title;
    dialog.setAttribute("aria-labelledby", heading.id);
    dialog.append(heading);
    if (body) {
      const p = document.createElement("p");
      p.id = `${id}-description`;
      p.textContent = body;
      dialog.setAttribute("aria-describedby", p.id);
      dialog.append(p);
    }
    const actions = document.createElement("div");
    actions.className = "glosa-dialog-actions";
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "glosa-save";
    dismiss.textContent = dismissLabel;
    dismiss.addEventListener("click", () => dialog.close("dismiss"));
    actions.append(dismiss);
    dialog.append(actions);

    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) dialog.close("dismiss");
    });
    dialog.addEventListener("close", () => {
      resolve();
      dialog.remove();
      queueMicrotask(() => {
        if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
          previousFocus.focus({ preventScroll: true });
        }
      });
    });

    document.body.append(dialog);
    dialog.showModal();
    dismiss.focus();
  });
}

export function confirmDialog({ title, body, confirmLabel = "Continue", danger = false }) {
  const dialog = document.createElement("dialog");
  if (typeof dialog.showModal !== "function") {
    const ok =
      typeof window !== "undefined" && window.confirm ? window.confirm(body ? `${title}\n\n${body}` : title) : true;
    return Promise.resolve(ok);
  }

  return new Promise((resolve) => {
    const previousFocus = document.activeElement;
    const id = `glosa-dialog-${++dialogId}`;
    dialog.className = "glosa-dialog";
    const heading = document.createElement("h2");
    heading.id = `${id}-title`;
    heading.textContent = title;
    dialog.setAttribute("aria-labelledby", heading.id);
    dialog.append(heading);
    if (body) {
      const p = document.createElement("p");
      p.id = `${id}-description`;
      p.textContent = body;
      dialog.setAttribute("aria-describedby", p.id);
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
      queueMicrotask(() => {
        if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
          previousFocus.focus({ preventScroll: true });
        }
      });
    });

    document.body.append(dialog);
    dialog.showModal();
    (danger ? cancel : confirm).focus();
  });
}

/**
 * Two named actions next to Cancel, for a question with a real fork in it — "save this anyway" and
 * "let me fix it by hand" are different answers, not one answer and its refusal.
 *
 * `choices` is `[{id, label, danger?}]`, resolved to the chosen `id`. Cancel, Esc, the backdrop,
 * and the no-`showModal` fallback all resolve to `null`: every way of not answering means the
 * caller does nothing, which is what makes this safe to gate a write on.
 *
 * `detail` is shown verbatim in a scrollable block under the body — for showing the reader the
 * exact bytes at issue rather than describing them.
 *
 * @param {{title: string, body?: string, detail?: string, choices: {id: string, label: string,
 *          danger?: boolean}[]}} opts
 * @returns {Promise<string | null>}
 */
export function choiceDialog({ title, body, detail, choices }) {
  const dialog = document.createElement("dialog");
  // No modal support (headless DOMs, very old engines) means the reader cannot actually be asked,
  // and a question nobody answered is a "no".
  if (typeof dialog.showModal !== "function") return Promise.resolve(null);

  return new Promise((resolve) => {
    const previousFocus = document.activeElement;
    const id = `glosa-dialog-${++dialogId}`;
    dialog.className = "glosa-dialog";
    const heading = document.createElement("h2");
    heading.id = `${id}-title`;
    heading.textContent = title;
    dialog.setAttribute("aria-labelledby", heading.id);
    dialog.append(heading);
    if (body) {
      const p = document.createElement("p");
      p.id = `${id}-description`;
      p.textContent = body;
      dialog.setAttribute("aria-describedby", p.id);
      dialog.append(p);
    }
    if (detail) {
      const pre = document.createElement("pre");
      pre.className = "glosa-dialog-detail";
      pre.tabIndex = 0; // a scrollable region has to be reachable without a pointer
      pre.textContent = detail;
      dialog.append(pre);
    }
    const actions = document.createElement("div");
    actions.className = "glosa-dialog-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "glosa-btn glosa-btn-ghost";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => dialog.close(""));
    actions.append(cancel);
    for (const choice of choices) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = choice.danger ? "glosa-btn glosa-btn-danger" : "glosa-btn glosa-btn-ghost";
      button.textContent = choice.label;
      button.addEventListener("click", () => dialog.close(choice.id));
      actions.append(button);
    }
    // The last choice is the one the workbench leads with, so it wears the primary button.
    actions.lastElementChild?.setAttribute("class", "glosa-save");
    dialog.append(actions);

    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) dialog.close("");
    });
    dialog.addEventListener("close", () => {
      resolve(choices.some((choice) => choice.id === dialog.returnValue) ? dialog.returnValue : null);
      dialog.remove();
      queueMicrotask(() => {
        if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
          previousFocus.focus({ preventScroll: true });
        }
      });
    });

    document.body.append(dialog);
    dialog.showModal();
    // Cancel takes focus: the reader is being warned, so the safe answer is the one under the hand.
    cancel.focus();
  });
}

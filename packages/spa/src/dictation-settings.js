// SPDX-License-Identifier: Apache-2.0
import { createElement as el } from "./viewer-shell.js";
export function mountDictationSettings(host, dataAccess) {
  let disposed = false,
    state,
    busy = false;
  const key = el("input", {
    type: "password",
    autocomplete: "off",
    maxLength: 8192,
    "aria-label": "OpenAI API key",
    placeholder: "Paste your OpenAI API key",
  });
  const enabled = el("input", { type: "checkbox" });
  const context = el("input", { type: "checkbox", checked: true });
  const cleanup = el("input", { type: "checkbox" });
  const status = el("p", { role: "status", "aria-live": "polite", className: "glosa-agent-help" });
  const save = el("button", { type: "submit", textContent: "Save settings" });
  const refresh = el("button", { type: "button", textContent: "Refresh settings" });
  const remove = el("button", { type: "button", textContent: "Remove key" });
  const form = el("form", { className: "glosa-dictation-settings" }, [
    el("h2", { className: "glosa-settings-title", textContent: "Dictation" }),
    el("p", {
      textContent: "Speak in English, Polish, German or Spanish. Text appears in your draft after you stop recording.",
    }),
    el("label", {}, [el("span", { textContent: "OpenAI API key" }), key]),
    el("label", {}, [enabled, el("span", { textContent: "Enable dictation" })]),
    el("label", {}, [context, el("span", { textContent: "Use visible context" })]),
    el("label", {}, [cleanup, el("span", { textContent: "Clean up dictated text" })]),
    el("p", {
      className: "glosa-agent-help",
      textContent:
        "Enabling dictation lets glosa send your recording to OpenAI after you stop. Visible context includes up to 8 KiB of the current field, visible document text and conversation. Cleanup sends the transcript and enabled context in an additional request to remove fillers and fix punctuation. Text stays a draft and is never sent automatically.",
    }),
    el("p", {
      className: "glosa-agent-help",
      textContent:
        "OpenAI API usage is billed separately from ChatGPT. Your key is stored in this device’s secure credential store. Saving settings makes no OpenAI request.",
    }),
    el("div", { className: "glosa-agent-account-actions" }, [save, remove, refresh]),
    status,
  ]);
  host.append(form);
  const controls = [...form.querySelectorAll("input,button")];
  function paint(next) {
    state = next;
    enabled.checked = next.enabled;
    context.checked = next.context;
    cleanup.checked = next.cleanup;
    key.placeholder = next.credential_error
      ? "Unlock secure storage and refresh settings."
      : next.credential_present
        ? "Key saved. Paste a key to replace it."
        : "Paste your OpenAI API key";
  }
  async function act(operation) {
    if (busy || disposed) return;
    busy = true;
    for (const control of controls) control.disabled = true;
    try {
      const next = await operation();
      if (disposed) return;
      paint(next);
      status.textContent =
        next.credential_error ??
        (next.credential_present ? "Key saved. API access is checked when you dictate." : "No API key saved.");
    } catch (error) {
      if (!disposed) status.textContent = error.message || "Could not save dictation settings.";
      // A failed key removal can still have disabled dictation. Refresh the authoritative revision.
      try {
        const next = await dataAccess.getDictationSettings();
        if (!disposed) paint(next);
      } catch {
        /* Keep error visible. */
      }
    } finally {
      key.value = "";
      busy = false;
      if (!disposed) for (const control of controls) control.disabled = false;
    }
  }
  function changed() {
    host.ownerDocument.dispatchEvent(new Event("glosa-dictation-settings-changed"));
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!state) return;
    const input = {
      revision: state.revision,
      consent_version: state.consent_version,
      enabled: enabled.checked,
      context: context.checked,
      cleanup: cleanup.checked,
      ...(key.value ? { api_key: key.value } : {}),
    };
    key.value = "";
    changed();
    void act(async () => {
      try {
        return await dataAccess.saveDictationSettings(input);
      } finally {
        changed();
      }
    });
  });
  remove.addEventListener("click", () => {
    if (!state) return;
    changed();
    void act(async () => {
      try {
        return await dataAccess.removeDictationKey(state.revision);
      } finally {
        changed();
      }
    });
  });
  refresh.addEventListener("click", () => void act(() => dataAccess.getDictationSettings()));
  if (dataAccess?.getDictationSettings) void act(() => dataAccess.getDictationSettings());
  else {
    for (const control of controls) control.disabled = true;
    status.textContent = "Dictation settings are unavailable in this build.";
  }
  return {
    destroy() {
      disposed = true;
      key.value = "";
      form.remove();
    },
  };
}

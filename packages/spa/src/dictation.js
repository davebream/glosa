// SPDX-License-Identifier: Apache-2.0
// Provider-neutral dictation coordinator. One instance belongs to one SPA and one active prose
// field at a time. Provider wire formats stay in fixed browser modules served by provider packages.

export const DICTATION_CONTEXT_LIMIT_BYTES = 262_144;
export const DICTATION_MAX_DURATION_MS = 345_000;

const ALLOWED_CLIENT_MODULES = new Map([["wispr-flow", "/app/providers/wispr-flow/browser.js"]]);
const encoder = new TextEncoder();

function bytes(value) {
  return encoder.encode(value).length;
}

function takePrefix(value, allowance) {
  if (allowance <= 0 || !value) return "";
  if (bytes(value) <= allowance) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const midpoint = Math.ceil((low + high) / 2);
    if (bytes(value.slice(0, midpoint)) <= allowance) low = midpoint;
    else high = midpoint - 1;
  }
  return value.slice(0, low).replace(/[\uD800-\uDBFF]$/, "");
}

function takeSuffix(value, allowance) {
  if (allowance <= 0 || !value) return "";
  if (bytes(value) <= allowance) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const length = Math.ceil((low + high) / 2);
    if (bytes(value.slice(value.length - length)) <= allowance) low = length;
    else high = length - 1;
  }
  return value.slice(value.length - low).replace(/^[\uDC00-\uDFFF]/, "");
}

function appendBlock(target, value, remaining) {
  const normalized = String(value ?? "").trim();
  if (!normalized || remaining <= 0) return { remaining, appended: false };
  const separator = target.length > 0 ? "\n\n" : "";
  if (bytes(separator) >= remaining) return { remaining, appended: false };
  const text = takePrefix(normalized, remaining - bytes(separator));
  if (!text) return { remaining, appended: false };
  target.push(`${separator}${text}`);
  return { remaining: remaining - bytes(separator) - bytes(text), appended: true };
}

/** Builds the provider-neutral plaintext context and enforces the cap before any network call. */
export function buildDictationContext(field, raw = {}, limit = DICTATION_CONTEXT_LIMIT_BYTES) {
  let remaining = Math.max(0, limit);
  const start = Math.max(0, field.selectionStart ?? field.value.length);
  const end = Math.max(start, field.selectionEnd ?? start);
  const selectedSource = field.value.slice(start, end);
  const selectedText = takePrefix(selectedSource, remaining);
  remaining -= bytes(selectedText);

  const beforeSource = field.value.slice(0, start);
  const afterSource = field.value.slice(end);
  const beforeBudget = Math.min(bytes(beforeSource), Math.ceil(remaining / 2));
  const afterBudget = Math.min(bytes(afterSource), remaining - beforeBudget);
  let beforeText = takeSuffix(beforeSource, beforeBudget);
  let afterText = takePrefix(afterSource, afterBudget);
  remaining -= bytes(beforeText) + bytes(afterText);
  if (remaining > 0 && bytes(beforeText) < bytes(beforeSource)) {
    beforeText = takeSuffix(beforeSource, bytes(beforeText) + remaining);
    remaining = limit - bytes(selectedText) - bytes(beforeText) - bytes(afterText);
  }
  if (remaining > 0 && bytes(afterText) < bytes(afterSource)) {
    afterText = takePrefix(afterSource, bytes(afterText) + remaining);
    remaining = limit - bytes(selectedText) - bytes(beforeText) - bytes(afterText);
  }

  const contentParts = [];
  for (const block of raw.surfaceBlocks ?? []) {
    const result = appendBlock(contentParts, block, remaining);
    remaining = result.remaining;
    if (remaining <= 0) break;
  }

  const chronological = [];
  const messages = Array.isArray(raw.conversationMessages) ? raw.conversationMessages : [];
  for (let index = messages.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const message = messages[index];
    if (!message || !["user", "human", "assistant"].includes(message.role)) continue;
    const content = String(message.content ?? "").trim();
    if (!content) continue;
    const roleCost = bytes(message.role);
    if (roleCost >= remaining) break;
    const text = takePrefix(content, remaining - roleCost);
    if (!text) continue;
    chronological.unshift({ role: message.role, content: text });
    remaining -= roleCost + bytes(text);
  }

  return {
    textboxContents: { beforeText, selectedText, afterText },
    contentText: contentParts.join(""),
    conversationMessages: chronological,
  };
}

function browserSupported(scope) {
  return Boolean(
    scope.navigator?.mediaDevices?.getUserMedia && scope.AudioContext && scope.AudioWorkletNode && scope.WebSocket,
  );
}

function statusText(error) {
  if (error?.name === "NotAllowedError") return "Microphone permission was not granted.";
  if (error?.name === "AbortError") return "";
  return error instanceof Error ? error.message : "Dictation could not be completed.";
}

/**
 * @param {{
 *   dataAccess?: any,
 *   scope?: any,
 *   document?: any,
 *   loadModule?: (specifier: string) => Promise<any>,
 *   maximumDurationMs?: number,
 * }} [options]
 */
export function createDictationController({
  dataAccess,
  scope = globalThis,
  document = globalThis.document,
  loadModule = (specifier) => import(specifier),
  maximumDurationMs = DICTATION_MAX_DURATION_MS,
} = {}) {
  const bindings = new Set();
  let availability = null;
  let active = null;
  let destroyed = false;

  const readiness =
    browserSupported(scope) && typeof dataAccess?.getDictationStatus === "function"
      ? dataAccess
          .getDictationStatus()
          .then((status) => {
            if (status?.state === "ready" && ALLOWED_CLIENT_MODULES.get(status.provider) === status.client_module) {
              availability = status;
            }
            refreshBindings();
            return availability;
          })
          .catch(() => null)
      : Promise.resolve(null);

  function pruneBindings() {
    for (const binding of bindings) {
      if (!binding.field.isConnected && binding !== active?.binding) {
        binding.host.remove();
        bindings.delete(binding);
      }
    }
  }

  function refreshBindings() {
    pruneBindings();
    for (const binding of bindings) {
      binding.host.hidden = !availability;
      const isActive = binding === active?.binding;
      binding.button.disabled = Boolean(active && !isActive) || active?.state === "finalizing";
      const label = !isActive ? "Start dictation" : active.state === "finalizing" ? "Transcribing…" : "Stop dictation";
      binding.button.textContent = label;
      binding.button.setAttribute("aria-label", label);
      binding.button.setAttribute("aria-pressed", String(isActive && active.state === "recording"));
    }
  }

  function controlsFor(binding) {
    const value = typeof binding.controls === "function" ? binding.controls() : binding.controls;
    return [...(value ?? [])].filter((control) => control?.nodeType === 1 && control !== binding.button);
  }

  function lock(activeSession) {
    const { binding } = activeSession;
    activeSession.fieldReadOnly = binding.field.readOnly;
    binding.field.readOnly = true;
    activeSession.controlStates = controlsFor(binding).map((control) => [control, control.disabled]);
    for (const [control] of activeSession.controlStates) control.disabled = true;
  }

  function restore(activeSession, { inserted = false } = {}) {
    const { binding, snapshot } = activeSession;
    binding.field.readOnly = activeSession.fieldReadOnly;
    for (const [control, disabled] of activeSession.controlStates ?? []) control.disabled = disabled;
    if (!inserted && binding.field.value !== snapshot.value) {
      binding.field.value = snapshot.value;
      binding.field.dispatchEvent(new scope.Event("input", { bubbles: true }));
    }
    if (binding.field.isConnected && (document.activeElement === binding.field || snapshot.focused)) {
      binding.field.focus({ preventScroll: true });
      if (!inserted) binding.field.setSelectionRange(snapshot.start, snapshot.end, snapshot.direction);
    }
  }

  async function cancel(reason = "cancelled") {
    const session = active;
    if (!session) return;
    active = null;
    clearTimeout(session.maximumTimer);
    session.abort.abort(reason);
    await session.providerSession?.cancel?.().catch(() => {});
    if (!session.providerSession) {
      for (const track of session.stream?.getTracks?.() ?? []) track.stop();
    }
    restore(session);
    session.binding.status.textContent = "";
    refreshBindings();
  }

  async function finalize(session) {
    if (active !== session || session.state === "finalizing") return;
    session.state = "finalizing";
    clearTimeout(session.maximumTimer);
    refreshBindings();
    try {
      const transcript = String((await session.providerSession.stop()) ?? "").trim();
      if (active !== session) return;
      if (!session.binding.field.isConnected || session.binding.field.value !== session.snapshot.value) {
        throw new Error("The draft changed during dictation, so no text was inserted.");
      }
      if (!transcript) throw new Error("No speech was detected.");
      session.binding.field.setRangeText(transcript, session.snapshot.start, session.snapshot.end, "end");
      session.binding.field.dispatchEvent(new scope.Event("input", { bubbles: true }));
      active = null;
      restore(session, { inserted: true });
      session.binding.status.textContent = "Dictation inserted. Review the draft before sending.";
      refreshBindings();
    } catch (error) {
      if (active !== session) return;
      active = null;
      restore(session);
      session.binding.status.textContent = statusText(error);
      refreshBindings();
    }
  }

  async function fail(session, error) {
    if (active !== session) return;
    active = null;
    clearTimeout(session.maximumTimer);
    session.abort.abort("provider error");
    await session.providerSession?.cancel?.().catch(() => {});
    restore(session);
    session.binding.status.textContent = statusText(error);
    refreshBindings();
  }

  async function start(binding) {
    if (destroyed || active || !availability) return;
    binding.status.textContent = "Requesting microphone access…";
    const invocation = binding.invocation;
    binding.invocation = null;
    const snapshot = {
      value: binding.field.value,
      start: invocation?.start ?? binding.field.selectionStart ?? binding.field.value.length,
      end: invocation?.end ?? binding.field.selectionEnd ?? binding.field.value.length,
      direction: invocation?.direction ?? binding.field.selectionDirection ?? "none",
      focused: invocation?.focused ?? document.activeElement === binding.field,
    };
    const session = {
      binding,
      snapshot,
      state: "permission",
      abort: new AbortController(),
      providerSession: null,
      stream: null,
      maximumTimer: null,
    };
    active = session;
    lock(session);
    refreshBindings();
    try {
      const stream = await scope.navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 }, video: false });
      session.stream = stream;
      if (active !== session) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      const [grant, module] = await Promise.all([
        dataAccess.createDictationSession(),
        loadModule(availability.client_module),
      ]);
      if (active !== session) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      const rawContext = binding.getContext?.() ?? {};
      session.providerSession = await module.createWisprFlowSession({
        grant,
        stream,
        context: buildDictationContext(binding.field, rawContext),
        signal: session.abort.signal,
      });
      if (active !== session) {
        await session.providerSession.cancel?.().catch(() => {});
        return;
      }
      session.providerSession.error?.catch((error) => void fail(session, error));
      session.state = "recording";
      binding.status.textContent = "Listening…";
      session.maximumTimer = setTimeout(() => void finalize(session), maximumDurationMs);
      refreshBindings();
    } catch (error) {
      if (active !== session) return;
      if (!session.providerSession) {
        for (const track of session.stream?.getTracks?.() ?? []) track.stop();
      }
      active = null;
      restore(session);
      binding.status.textContent = statusText(error);
      refreshBindings();
    }
  }

  const onKeydown = (event) => {
    if (event.key !== "Escape" || !active) return;
    event.preventDefault();
    event.stopPropagation();
    void cancel();
  };
  document.addEventListener("keydown", onKeydown, true);

  const removalObserver = new scope.MutationObserver(() => {
    if (active && !active.binding.field.isConnected) void cancel("field removed");
    pruneBindings();
  });
  removalObserver.observe(document.documentElement, { childList: true, subtree: true });

  return {
    readiness,
    attachField(field, { controls = [], getContext = () => ({}) } = {}) {
      const host = document.createElement("span");
      host.className = "glosa-dictation";
      host.hidden = true;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "glosa-dictation-toggle";
      button.textContent = "Start dictation";
      button.setAttribute("aria-label", "Start dictation");
      button.setAttribute("aria-pressed", "false");
      const status = document.createElement("span");
      status.className = "glosa-dictation-status";
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");
      host.append(button, status);
      field.insertAdjacentElement("afterend", host);
      const binding = { field, controls, getContext, host, button, status, invocation: null };
      bindings.add(binding);
      button.addEventListener("pointerdown", () => {
        binding.invocation = {
          start: field.selectionStart ?? field.value.length,
          end: field.selectionEnd ?? field.value.length,
          direction: field.selectionDirection ?? "none",
          focused: document.activeElement === field,
        };
      });
      button.addEventListener("click", () => {
        if (active?.binding === binding && active.state === "recording") void finalize(active);
        else if (active?.binding === binding) void cancel();
        else void start(binding);
      });
      refreshBindings();
      return () => {
        if (active?.binding === binding) void cancel("field removed");
        bindings.delete(binding);
        host.remove();
      };
    },
    async cancel() {
      await cancel();
    },
    destroy() {
      destroyed = true;
      void cancel();
      document.removeEventListener("keydown", onKeydown, true);
      removalObserver.disconnect();
      for (const binding of bindings) binding.host.remove();
      bindings.clear();
    },
  };
}

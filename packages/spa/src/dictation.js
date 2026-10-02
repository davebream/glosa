// SPDX-License-Identifier: Apache-2.0
// Provider-neutral dictation coordinator. One instance belongs to one SPA and one active prose
// field at a time. Audio uses native recording; provider transport stays in the daemon.

export const DICTATION_CONTEXT_LIMIT_BYTES = 8192;
export const DICTATION_MAX_DURATION_MS = 345_000;

const encoder = new TextEncoder();
const AUDIO_LIMIT = 12 * 1024 * 1024;
const ICONS = {
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  cancel: '<path d="m6 6 12 12M6 18 18 6"/>',
};
function icon(name) {
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">${ICONS[name]}</svg>`;
}
function recordingMime(scope) {
  return ["audio/webm;codecs=opus", "audio/webm", "audio/mp4;codecs=mp4a.40.2", "audio/mp4"].find((type) =>
    scope.MediaRecorder?.isTypeSupported(type),
  );
}
function contextText(field, raw) {
  // Reserve space for the JSON labels before enforcing the final serialized UTF-8 cap.
  let budget = DICTATION_CONTEXT_LIMIT_BYTES - 256;
  let text = JSON.stringify(buildDictationContext(field, raw, budget));
  while (bytes(text) > DICTATION_CONTEXT_LIMIT_BYTES && budget > 0) {
    budget = Math.max(0, budget - (bytes(text) - DICTATION_CONTEXT_LIMIT_BYTES));
    text = JSON.stringify(buildDictationContext(field, raw, budget));
  }
  return text;
}

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
  return Boolean(scope.navigator?.mediaDevices?.getUserMedia && recordingMime(scope));
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
 *   onSettings?: () => void,
 *   maximumDurationMs?: number,
 * }} [options]
 */
export function createDictationController({
  dataAccess,
  scope = globalThis,
  document = globalThis.document,
  onSettings = () => {},
  maximumDurationMs = DICTATION_MAX_DURATION_MS,
} = {}) {
  const bindings = new Set();
  let availability = null;
  let active = null;
  let destroyed = false;
  let statusGeneration = 0;
  const shell = scope.glosaShell;
  const unsubscribeShell = shell?.onDictationEnded?.((id) => {
    if (active?.shellId === id) void cancel();
  });
  function releaseShell(session) {
    if (!session.shellId) return;
    const id = session.shellId;
    session.shellId = null;
    void shell.endDictation(id).catch(() => {});
  }

  async function refreshStatus() {
    if (destroyed || !browserSupported(scope) || typeof dataAccess?.getDictationStatus !== "function") return null;
    const generation = ++statusGeneration;
    try {
      const status = await dataAccess.getDictationStatus();
      if (destroyed || generation !== statusGeneration) return null;
      if (active && active.revision !== status.revision) await cancel("settings changed");
      availability = status;
    } catch {
      availability = null;
    }
    refreshBindings();
    return availability;
  }
  const readiness = refreshStatus();
  const onSettingsChanged = () => {
    void cancel("settings changed");
    void refreshStatus();
  };
  scope.addEventListener?.("focus", refreshStatus);
  document.addEventListener("glosa-dictation-settings-changed", onSettingsChanged);

  /** Drops the bindings whose field has left the page — and ONLY those.
   *
   * "Not in the document" answers two different questions and this used to conflate them. A field
   * that was on the page and is gone is abandoned, and its button has to go with it. A field that
   * has never been on the page is not abandoned, it is not born yet: its caller is still building
   * the subtree it belongs to and will append the whole thing in a moment.
   *
   * Conflating them made dictation unreachable everywhere it was offered. `attachField` ends by
   * refreshing, refreshing begins by pruning, and the annotation composer builds its form detached
   * and returns it (artifact-pane.js) — so the binding was created and deleted inside the same
   * call, and the composer opened with no button, for every reader, with the provider reporting
   * `ready` the whole time. `seen` is what tells the two apart. */
  function pruneBindings() {
    for (const binding of bindings) {
      if (binding.field.isConnected) {
        binding.seen = true;
        continue;
      }
      if (!binding.seen) continue;
      if (binding === active?.binding) continue;
      binding.host.remove();
      bindings.delete(binding);
    }
  }

  function refreshBindings() {
    pruneBindings();
    for (const binding of bindings) {
      binding.host.hidden = !browserSupported(scope);
      const isActive = binding === active?.binding;
      binding.button.disabled = Boolean(active && !isActive);
      const label = !isActive
        ? availability?.state === "ready"
          ? "Start dictation"
          : "Set up dictation"
        : active.state === "recording"
          ? "Stop dictation"
          : "Cancel dictation";
      binding.button.innerHTML = icon(!isActive ? "mic" : active.state === "recording" ? "stop" : "cancel");
      binding.button.title = label;
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
    if (binding.field.isConnected && (document.activeElement === binding.field || snapshot.focused)) {
      binding.field.focus({ preventScroll: true });
      if (!inserted && binding.field.value === snapshot.value)
        binding.field.setSelectionRange(snapshot.start, snapshot.end, snapshot.direction);
    }
  }

  async function cancel(reason = "cancelled") {
    const session = active;
    if (!session) return;
    active = null;
    clearTimeout(session.maximumTimer);
    clearInterval(session.elapsedTimer);
    session.abort.abort(reason);
    releaseShell(session);
    releaseRecording(session);
    restore(session);
    session.binding.status.textContent = "";
    refreshBindings();
  }

  async function finalize(session) {
    if (active !== session || session.state === "finalizing") return;
    session.state = "finalizing";
    clearTimeout(session.maximumTimer);
    clearInterval(session.elapsedTimer);
    refreshBindings();
    try {
      session.binding.status.textContent = "Transcribing…";
      session.finishTimer = setTimeout(
        () => void fail(session, new Error("The recording could not be finalized. Please try again.")),
        5000,
      );
      session.recorder.stop();
      const audio = await session.recorded;
      releaseRecording(session);
      releaseShell(session);
      if (active !== session) return;
      if (!audio.size || audio.size > AUDIO_LIMIT)
        throw new Error("The recording is empty or too large. Please record again.");
      const result = await dataAccess.transcribeDictation(
        audio,
        session.context,
        session.revision,
        session.abort.signal,
      );
      const transcript = String(result.text ?? "").trim();
      if (active !== session) return;
      if (!session.binding.field.isConnected || session.binding.field.value !== session.snapshot.value) {
        throw new Error("The draft changed during dictation, so no text was inserted.");
      }
      if (!transcript) throw new Error("No speech was detected.");
      session.binding.field.setRangeText(transcript, session.snapshot.start, session.snapshot.end, "end");
      session.binding.field.dispatchEvent(new scope.Event("input", { bubbles: true }));
      active = null;
      releaseShell(session);
      restore(session, { inserted: true });
      session.binding.status.textContent =
        result.cleanup === "failed"
          ? "Transcript inserted. Cleanup was unavailable; review the draft."
          : "Dictation inserted. Review the draft before sending.";
      refreshBindings();
    } catch (error) {
      if (active !== session) return;
      active = null;
      session.abort.abort("dictation failed");
      releaseShell(session);
      releaseRecording(session);
      restore(session);
      session.binding.status.textContent = statusText(error);
      refreshBindings();
    }
  }

  async function fail(session, error) {
    if (active !== session) return;
    active = null;
    clearTimeout(session.maximumTimer);
    clearInterval(session.elapsedTimer);
    session.abort.abort("provider error");
    releaseShell(session);
    releaseRecording(session);
    restore(session);
    session.binding.status.textContent = statusText(error);
    refreshBindings();
  }

  function releaseRecording(session) {
    clearTimeout(session.maximumTimer);
    clearTimeout(session.finishTimer);
    clearInterval(session.elapsedTimer);
    if (session.recorder && session.recorder.state !== "inactive") {
      try {
        session.recorder.stop();
      } catch {
        /* Already stopped by device loss. */
      }
    }
    for (const track of session.stream?.getTracks() ?? []) track.stop();
    session.chunks = [];
  }

  async function start(binding) {
    if (destroyed || active) return;
    if (availability?.state !== "ready") {
      onSettings();
      binding.status.textContent = availability?.message ?? "Enable OpenAI dictation in Settings → Dictation.";
      return;
    }
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
      stream: null,
      recorder: null,
      chunks: [],
      size: 0,
      revision: availability?.revision,
      context: availability?.context ? contextText(binding.field, binding.getContext?.() ?? {}) : undefined,
      shellId: shell?.beginDictation ? globalThis.crypto.randomUUID() : null,
    };
    active = session;
    lock(session);
    refreshBindings();
    binding.status.textContent = "Requesting microphone access…";
    try {
      // Begin the shell grant synchronously with the click, preserving transient user activation.
      const permission = session.shellId
        ? shell.beginDictation(session.shellId).catch(() => false)
        : Promise.resolve(true);
      ++statusGeneration;
      const status = await dataAccess.getDictationStatus();
      if (active !== session) return;
      availability = status;
      if (status.state !== "ready") {
        onSettings();
        throw new Error(status.message ?? "Enable OpenAI dictation in Settings → Dictation.");
      }
      if (status.revision !== session.revision) throw new Error("Dictation settings changed. Please start again.");
      const allowed = await permission;
      if (active !== session) return;
      if (!allowed) throw new DOMException("Microphone permission was not granted.", "NotAllowedError");
      const stream = await scope.navigator.mediaDevices.getUserMedia({
        audio: { channelCount: { ideal: 1 }, echoCancellation: true, noiseSuppression: true },
        video: false,
      });
      session.stream = stream;
      if (active !== session) {
        releaseRecording(session);
        return;
      }
      const recorder = new scope.MediaRecorder(stream, { mimeType: recordingMime(scope), audioBitsPerSecond: 64000 });
      session.recorder = recorder;
      session.recorded = new Promise((resolve, reject) => {
        recorder.addEventListener("dataavailable", (event) => {
          if (active !== session || !event.data.size) return;
          session.size += event.data.size;
          if (session.size > AUDIO_LIMIT) {
            void fail(session, new Error("The recording is too large. Please record a shorter message."));
            return;
          }
          session.chunks.push(event.data);
        });
        recorder.addEventListener("stop", () => resolve(new scope.Blob(session.chunks, { type: recorder.mimeType })), {
          once: true,
        });
        recorder.addEventListener(
          "error",
          () => {
            const error = new Error("Microphone recording failed. Please try again.");
            reject(error);
            void fail(session, error);
          },
          { once: true },
        );
      });
      session.recorded.catch(() => {});
      for (const track of stream.getTracks())
        track.addEventListener(
          "ended",
          () => {
            if (session.state === "recording")
              void fail(session, new Error("The microphone disconnected. Please record again."));
          },
          { once: true },
        );
      recorder.start(1000);
      session.started = performance.now();
      session.state = "recording";
      const elapsed = () => {
        if (active !== session || session.state !== "recording") return;
        const seconds = Math.floor((performance.now() - session.started) / 1000);
        binding.status.textContent = `Listening · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
        if (performance.now() - session.started >= maximumDurationMs) void finalize(session);
      };
      elapsed();
      session.elapsedTimer = setInterval(elapsed, 1000);
      session.maximumTimer = setTimeout(() => void finalize(session), maximumDurationMs);
      refreshBindings();
    } catch (error) {
      await fail(session, error);
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
      button.innerHTML = icon("mic");
      button.setAttribute("aria-label", "Start dictation");
      button.setAttribute("aria-pressed", "false");
      const status = document.createElement("span");
      status.className = "glosa-dictation-status";
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");
      host.append(button, status);
      field.insertAdjacentElement("afterend", host);
      // `seen` starts false on purpose: a field is almost always attached before its subtree is in
      // the document, and `pruneBindings` must not read that as abandonment. It flips the first
      // time the field is observed connected and never flips back.
      const binding = { field, controls, getContext, host, button, status, invocation: null, seen: false };
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
      unsubscribeShell?.();
      scope.removeEventListener?.("focus", refreshStatus);
      document.removeEventListener("glosa-dictation-settings-changed", onSettingsChanged);
      document.removeEventListener("keydown", onKeydown, true);
      removalObserver.disconnect();
      for (const binding of bindings) binding.host.remove();
      bindings.clear();
    },
  };
}

// SPDX-License-Identifier: Apache-2.0
// @glosa/spa — P4.2: the conversation viewer (R6/F32) — a READ-ONLY mirror of the registered
// session's transcript, rendered from the daemon's normalized `TranscriptEvent`s (never raw
// transcript JSON — that isolation is normalize.ts's whole point, A2 §F16), plus an out-of-band
// composer. Talks to the daemon ONLY through data-access.js (R6's ONE data-access module) — never
// `fetch` directly (see test/import-boundary.test.ts).
//
// Fail-soft (A2 §F16): a `mirror_unavailable` frame flips the pane to "mirror unavailable — use
// the terminal" WITHOUT tearing down anything else in the app — the artifact/annotation workflow
// this pane sits beside stays fully usable regardless of transcript-mirror health.

/** Folds a flat list of normalized `TranscriptEvent`s into render items: `meta` events are
 * dropped entirely (F16/R6: "meta hidden" — never rendered, not even collapsed), and consecutive
 * `subagent` events are collapsed into one `{type: "subagent_group", items: [...]}` — the "grouped
 * subagents" normalized kind the task brief calls for. Every other event passes through
 * unchanged. Pure — no DOM — so this is the one piece of rendering LOGIC this module unit-tests
 * directly; `renderItem` below (DOM-producing) is exercised only lightly by comparison. */
export function groupEvents(events) {
  const out = [];
  let currentGroup = null;
  for (const ev of events) {
    if (ev.type === "meta") {
      currentGroup = null; // a meta event breaks a run of subagent turns, same as any other kind
      continue;
    }
    if (ev.type === "subagent") {
      if (!currentGroup) {
        currentGroup = { type: "subagent_group", items: [] };
        out.push(currentGroup);
      }
      currentGroup.items.push(ev);
      continue;
    }
    currentGroup = null;
    out.push(ev);
  }
  return out;
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "onClick") node.addEventListener("click", value);
    else if (key === "onKeydown") node.addEventListener("keydown", value);
    else if (key === "className") node.className = value;
    else if (key.startsWith("data-") || key.startsWith("aria-") || key === "role") node.setAttribute(key, value);
    else node[key] = value;
  }
  for (const child of children) node.append(child);
  return node;
}

function renderProse(ev) {
  return el("p", { className: `glosa-conv-prose glosa-conv-${ev.role}`, textContent: ev.content });
}

function renderToolUse(ev) {
  const summary = el("summary", { textContent: `🔧 ${ev.tool_name}` });
  const body = el("pre", { className: "glosa-conv-tool-input", textContent: JSON.stringify(ev.input, null, 2) });
  return el("details", { className: "glosa-conv-tool-use" }, [summary, body]);
}

function renderToolResult(ev) {
  const label = ev.truncated ? `Result (truncated, ${ev.size_original} bytes)` : "Result";
  const summary = el("summary", { textContent: label });
  const body = el("pre", { className: "glosa-conv-tool-result", textContent: ev.content });
  return el("details", { className: "glosa-conv-tool-result-wrap" }, [summary, body]);
}

function renderSubagentGroup(group) {
  const summary = el("summary", { textContent: `Subagent (${group.items.length} turn${group.items.length === 1 ? "" : "s"})` });
  const body = group.items.map((item) => el("p", { className: "glosa-conv-subagent-turn", textContent: item.summary }));
  return el("details", { className: "glosa-conv-subagent-group" }, [summary, ...body]);
}

function newMessageId() {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues?.(bytes);
  if (bytes.every((byte) => byte === 0)) {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Renders one grouped item (the output of `groupEvents`) to a DOM node. `unknown` events (the
 * normalizer's own quarantine kind, A2 §F16) render as a small, clearly-marked placeholder rather
 * than being silently dropped — the human should be able to tell "the mirror skipped something
 * here" apart from "there was nothing here", even though neither is actionable. */
function renderItem(item) {
  switch (item.type) {
    case "prose":
      return renderProse(item);
    case "tool_use":
      return renderToolUse(item);
    case "tool_result":
      return renderToolResult(item);
    case "subagent_group":
      return renderSubagentGroup(item);
    case "unknown":
      return el("p", { className: "glosa-conv-unknown", textContent: "⚠ unrecognized transcript line — skipped" });
    default:
      return el("p", { className: "glosa-conv-unknown", textContent: "⚠ unrecognized event" });
  }
}

/**
 * Mounts the conversation viewer into `container` for `slug`'s workspace. `dataAccess` is
 * caller-injected (viewer.js passes its own instance, same DI shape as history.js/classf-viewer.js)
 * — this module never constructs its own, per R6's ONE-data-access-module invariant. Returns
 * `unmount()`, which tears down the SSE subscription.
 */
export function mountConversationPane(container, { dataAccess, slug }) {
  container.textContent = "";

  const statusEl = el("p", { className: "glosa-conv-status", hidden: true, role: "status", "aria-live": "polite" });
  const mirrorStatusEl = el("p", { className: "glosa-conv-mirror-status", hidden: true, role: "status", "aria-live": "polite" });
  const listEl = el("div", { className: "glosa-conv-list", role: "region", "aria-label": "Conversation transcript" });
  const sessionPickerLabel = el("label", {
    className: "glosa-conv-session-picker",
    hidden: true,
    textContent: "Send to ",
  });
  const sessionPicker = el("select", { "aria-label": "Agent session" });
  sessionPickerLabel.append(sessionPicker);
  const composerInput = el("textarea", {
    className: "glosa-conv-composer-input",
    name: "conversation-message",
    placeholder: "Send a message (out of band — does not edit the transcript)",
    "aria-label": "Message to the agent session",
  });
  const composerSend = el("button", { className: "glosa-conv-composer-send", type: "button", textContent: "Send" });
  // P4.3 seam: attention state (e.g. "Claude is waiting for input") comes from the provider's own
  // Notification hook, NOT a heuristic derived from transcript activity/staleness — this element
  // exists as the mount point a future P4.3 wiring flips, never inferred here (R6: "Attention
  // state from the provider's Notification hook, not a transcript stall heuristic").
  const attentionEl = el("p", { className: "glosa-conv-attention", hidden: true, role: "status", "aria-live": "polite" });

  container.append(
    el("h3", { textContent: "Conversation" }),
    mirrorStatusEl,
    statusEl,
    attentionEl,
    listEl,
    sessionPickerLabel,
    el("div", { className: "glosa-conv-composer" }, [composerInput, composerSend]),
  );

  let events = [];
  let mirrorAvailable = true;
  let stopStream = null;
  let stopDeliveryStream = null;
  let pending = null;
  let waitingForPresentation = false;
  const pendingStorageKey = `glosa:conversation-pending:${slug ?? "unknown"}`;

  function readStoredPending() {
    try {
      const parsed = JSON.parse(globalThis.sessionStorage?.getItem(pendingStorageKey) ?? "null");
      return parsed && typeof parsed.id === "string" && typeof parsed.text === "string" ? parsed : null;
    } catch {
      return null;
    }
  }

  function storePending(value) {
    try {
      if (value) globalThis.sessionStorage?.setItem(pendingStorageKey, JSON.stringify(value));
      else globalThis.sessionStorage?.removeItem(pendingStorageKey);
    } catch {
      // Tab storage is an optional resilience layer; delivery still remains durable in the daemon.
    }
  }

  function setDeliveryStatus(text, isError = false) {
    statusEl.hidden = false;
    statusEl.textContent = text;
    if (isError) statusEl.setAttribute("data-error", "true");
    else statusEl.removeAttribute("data-error");
  }

  function showSessionPicker(candidates) {
    sessionPicker.textContent = "";
    sessionPicker.append(el("option", { value: "", textContent: "Choose a session…" }));
    for (const candidate of candidates) {
      const suffix = String(candidate.session_id ?? "").slice(-8);
      sessionPicker.append(
        el("option", {
          value: candidate.session_id,
          textContent: `${candidate.provider ?? "agent"} · …${suffix}`,
        }),
      );
    }
    sessionPickerLabel.hidden = false;
    sessionPicker.focus();
  }

  function markWaiting(result) {
    waitingForPresentation = true;
    composerSend.disabled = true;
    setDeliveryStatus(
      result?.state === "transport_accepted"
        ? "Message reached the session transport. Waiting for the agent to acknowledge it…"
        : "Message queued. Waiting for the agent…",
    );
    storePending(pending);
  }

  function markPresented() {
    if (!pending) return;
    if (composerInput.value === pending.text) composerInput.value = "";
    pending = null;
    waitingForPresentation = false;
    composerSend.disabled = false;
    sessionPickerLabel.hidden = true;
    storePending(null);
    setDeliveryStatus("Message sent.");
  }

  function markFailed(message) {
    waitingForPresentation = false;
    composerSend.disabled = false;
    setDeliveryStatus(message, true);
    storePending(pending);
  }

  function render() {
    listEl.textContent = "";
    if (!mirrorAvailable) return; // statusEl already shows the fail-soft message
    for (const item of groupEvents(events)) listEl.append(renderItem(item));
  }

  function showMirrorUnavailable() {
    mirrorAvailable = false;
    mirrorStatusEl.hidden = false;
    mirrorStatusEl.textContent = "mirror unavailable — use the terminal";
    render();
  }

  function showMirrorAvailable() {
    if (mirrorAvailable) return;
    mirrorAvailable = true;
    mirrorStatusEl.hidden = true;
    mirrorStatusEl.textContent = "";
    render();
  }

  async function send() {
    const text = composerInput.value;
    if (!text.trim() || !slug || composerSend.disabled || waitingForPresentation) return;
    const selectedSession = sessionPicker.value || pending?.sessionHint || undefined;
    if (!pending || pending.text !== text) {
      pending = {
        id: newMessageId(),
        text,
        ...(selectedSession ? { sessionHint: selectedSession } : {}),
      };
    } else if (selectedSession) {
      pending.sessionHint = selectedSession;
    }
    storePending(pending);
    composerSend.disabled = true;
    setDeliveryStatus("Sending…");
    try {
      const result = await dataAccess.sendComposerMessage(slug, text, {
        messageId: pending.id,
        sessionHint: pending.sessionHint,
      });
      if (result?.delivered) markPresented();
      else markWaiting(result);
    } catch (error) {
      const candidates = error?.problem?.candidates;
      if (Array.isArray(candidates) && candidates.length > 1) {
        showSessionPicker(candidates);
        markFailed("Choose which live agent session should receive this message.");
      } else {
        const type = String(error?.problem?.type ?? "");
        const message =
          type.endsWith("/no-bound-session")
            ? "No live agent session is bound to this workspace. Start or resume it, bind it, then try again."
            : type.endsWith("/bound-session-stale")
              ? "The bound agent session is stale. Resume it, then try again."
              : error instanceof Error
                ? error.message
                : "Try again.";
        markFailed(`Message couldn't be sent: ${message}`);
      }
    } finally {
      if (!waitingForPresentation) composerSend.disabled = false;
    }
  }
  composerSend.addEventListener("click", () => void send());
  composerInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send(); // Cmd/Ctrl+Enter to send
  });

  function startStream() {
    stopStream?.();
    stopStream = dataAccess.openTranscriptStream(slug, {
      onEvent: (frame) => {
        if (frame.event === "mirror_unavailable") {
          showMirrorUnavailable();
          return;
        }
        if (frame.event === "transcript") {
          showMirrorAvailable();
          events.push(frame.data);
          render();
        }
      },
      onReconnect: () => {
        // No full-history refetch route exists for the transcript mirror (unlike the artifact
        // stream's `getArtifacts`/`getArtifact` — A1 §5.8 has no analogous GET). A plain network-
        // drop reconnect strict-resumes past everything already rendered (A1 §8.2 case 2) — safe
        // to do nothing here. A resync_required-driven reconnect (A2 §F16's /clear or /resume
        // case) re-reads the transcript file from byte 0 instead, which — since
        // `openEventStream`/`openTranscriptStream` intercept `resync_required` internally and
        // never surface it to `onEvent` — this pane has no way to distinguish from a plain
        // reconnect; its accumulated `events` are therefore NOT cleared, so a real resync can
        // render as "old history followed by the post-clear history" rather than a clean reset.
        // Known, accepted v1 gap (the resync case itself is rare — a live `/clear` or file
        // rotation mid-session) rather than plumbing a new signal through the data-access surface
        // for it.
      },
      onStatus: (status) => {
        if (status === "down") showMirrorUnavailable();
      },
    });
  }

  async function refreshPendingStatus() {
    if (!pending || typeof dataAccess.getComposerMessageStatus !== "function") return;
    try {
      const result = await dataAccess.getComposerMessageStatus(slug, pending.id);
      if (result?.delivered) markPresented();
      else if (result?.state === "failed" || result?.delivery?.outcome === "failed") {
        markFailed("Message delivery failed. Try again.");
      } else markWaiting(result);
    } catch (error) {
      if (error?.status === 404) {
        markFailed("The pending message is no longer available. Send it again.");
      }
    }
  }

  function startDeliveryStream() {
    if (typeof dataAccess.openStream !== "function") return;
    stopDeliveryStream?.();
    stopDeliveryStream = dataAccess.openStream(slug, {
      onEvent: (frame) => {
        if (!pending || frame.event !== "journal" || frame.data?.entry !== pending.id) return;
        if (frame.data.event === "delivery_attempt" && frame.data.detail?.outcome === "presented") {
          markPresented();
        } else if (frame.data.event === "delivery_attempt" && frame.data.detail?.outcome === "failed") {
          markFailed("Message delivery failed. Try again.");
        } else if (frame.data.event === "transition_committed" && frame.data.detail?.to === "delivered") {
          markPresented();
        }
      },
      onReconnect: () => void refreshPendingStatus(),
      onStatus: () => {},
    });
  }

  pending = readStoredPending();
  if (pending) {
    composerInput.value = pending.text;
    markWaiting({ state: "queued" });
  }
  render();
  startStream();
  startDeliveryStream();
  if (pending) void refreshPendingStatus();

  return function unmount() {
    stopStream?.();
    stopDeliveryStream?.();
  };
}

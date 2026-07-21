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
    else if (key.startsWith("data-")) node.setAttribute(key, value);
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

  const statusEl = el("p", { className: "glosa-conv-status", hidden: true });
  const listEl = el("div", { className: "glosa-conv-list" });
  const composerInput = el("textarea", { className: "glosa-conv-composer-input", placeholder: "Send a message (out of band — does not edit the transcript)" });
  const composerSend = el("button", { className: "glosa-conv-composer-send", type: "button", textContent: "Send" });
  // P4.3 seam: attention state (e.g. "Claude is waiting for input") comes from the provider's own
  // Notification hook, NOT a heuristic derived from transcript activity/staleness — this element
  // exists as the mount point a future P4.3 wiring flips, never inferred here (R6: "Attention
  // state from the provider's Notification hook, not a transcript stall heuristic").
  const attentionEl = el("p", { className: "glosa-conv-attention", hidden: true });

  container.append(
    el("h3", { textContent: "Conversation" }),
    statusEl,
    attentionEl,
    listEl,
    el("div", { className: "glosa-conv-composer" }, [composerInput, composerSend]),
  );

  let events = [];
  let mirrorAvailable = true;
  let stopStream = null;

  function render() {
    listEl.textContent = "";
    if (!mirrorAvailable) return; // statusEl already shows the fail-soft message
    for (const item of groupEvents(events)) listEl.append(renderItem(item));
  }

  function showMirrorUnavailable() {
    mirrorAvailable = false;
    statusEl.hidden = false;
    statusEl.textContent = "mirror unavailable — use the terminal";
    render();
  }

  function showMirrorAvailable() {
    if (mirrorAvailable) return;
    mirrorAvailable = true;
    statusEl.hidden = true;
    statusEl.textContent = "";
    render();
  }

  async function send() {
    const text = composerInput.value.trim();
    if (!text || !slug) return;
    composerSend.disabled = true;
    try {
      await dataAccess.sendComposerMessage(slug, text);
      composerInput.value = "";
    } finally {
      composerSend.disabled = false;
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
    });
  }

  render();
  startStream();

  return function unmount() {
    stopStream?.();
  };
}

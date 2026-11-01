// SPDX-License-Identifier: Apache-2.0

import { elapsedLabel, turnActivity } from "../chat-activity.js";
import { loadChatMarkdown } from "../chat-markdown.js";
import { useChatRuntime } from "../chat-runtime.js";
import { createComposerPicker } from "../composer-picker.js";
import { confirmDialog } from "../dialog.js";
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  createRoot,
  flushSync,
  MessagePrimitive,
  React,
  ThreadPrimitive,
} from "../vendor/chat-ui.js";
import { createChatChrome } from "./chrome.js";

const h = React.createElement;
const ACTIVE = new Set(["dispatching", "running", "waiting", "stopping", "sending"]);
const MARKS = { completed: "M2.5 6.4l2.3 2.3 4.7-5.2", failed: "M3 3l6 6M9 3l-6 6", stopped: "M3 6h6" };

function Slot({ element, className }) {
  const host = React.useRef(null);
  React.useLayoutEffect(() => {
    host.current.append(element);
    return () => element.remove();
  }, [element]);
  return h("div", { ref: host, className });
}

// The safe existing parser remains the sole markdown policy. Never render remote image URLs.
function Markdown({ text, renderMarkdown, reasoning = false }) {
  const content = React.useRef(null);
  const painted = React.useRef(null);
  React.useLayoutEffect(() => {
    const element = content.current;
    const paint = () => {
      const selection = window.getSelection?.();
      if (
        selection &&
        !selection.isCollapsed &&
        (element.contains(selection.anchorNode) || element.contains(selection.focusNode))
      )
        return;
      const next = renderMarkdown ? renderMarkdown(text) : text;
      if (next === painted.current) return;
      if (renderMarkdown) element.innerHTML = next;
      else if (element.firstChild?.nodeType === Node.TEXT_NODE && text.startsWith(painted.current ?? ""))
        element.firstChild.appendData(text.slice((painted.current ?? "").length));
      else element.textContent = text;
      painted.current = next;
      for (const table of element.querySelectorAll("table")) {
        table.removeAttribute("data-fit");
        if (table.offsetWidth > element.clientWidth + 0.5) table.dataset.fit = "break";
      }
    };
    paint();
    const observer =
      typeof ResizeObserver === "function" && element.querySelector("table") ? new ResizeObserver(paint) : null;
    observer?.observe(element);
    document.addEventListener("selectionchange", paint);
    return () => {
      observer?.disconnect();
      document.removeEventListener("selectionchange", paint);
    };
  }, [text, renderMarkdown]);
  return h("div", {
    ref: content,
    className: `glosa-chat-text${renderMarkdown ? " glosa-chat-markdown" : ""}${reasoning ? " glosa-chat-reasoning-text" : ""}`,
  });
}

function CopyButton({ text, store, label }) {
  return h(
    "button",
    {
      type: "button",
      className: "glosa-icon-button",
      title: "Copy message",
      "aria-label": `Copy ${label}`,
      onClick: () =>
        void navigator.clipboard
          .writeText(text)
          .then(() => store.tell("Message copied."))
          .catch(() => store.tell("Copy failed. Select the message text to copy it.")),
    },
    "⧉",
  );
}

function Steps({ work }) {
  return h(
    "details",
    { className: "glosa-chat-message glosa-chat-steps", "data-kind": "steps" },
    h("summary", null, work.summary),
    h(
      "ol",
      { className: "glosa-chat-step-list" },
      work.steps.map((step) =>
        h(
          "li",
          { key: step.id, "data-state": step.state },
          h(
            "details",
            null,
            h(
              "summary",
              null,
              h(
                "span",
                { className: "glosa-chat-step-mark", "aria-hidden": "true" },
                MARKS[step.state] ? h("svg", { viewBox: "0 0 12 12" }, h("path", { d: MARKS[step.state] })) : null,
              ),
              h("span", null, `${step.label}${["failed", "stopped"].includes(step.state) ? ` · ${step.state}` : ""}`),
            ),
            h("pre", { className: "glosa-chat-step-detail" }, step.detail),
          ),
        ),
      ),
    ),
  );
}

function Live({ turn, label, lastEventAt }) {
  const [now, setNow] = React.useState(Date.now());
  const since = React.useRef(Number.isFinite(Date.parse(turn.at)) ? Date.parse(turn.at) : Date.now());
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, (now - since.current) / 1000);
  const quiet = Math.max(0, Math.floor((now - lastEventAt) / 1000));
  return h(
    "div",
    { className: "glosa-chat-live", "data-status": turn.status, "aria-hidden": "true" },
    h("span", { className: "glosa-chat-live-mark" }),
    h("span", null, label),
    h(
      "span",
      { className: "glosa-chat-live-time" },
      turn.status === "waiting" || seconds < 2 ? "" : elapsedLabel(seconds),
    ),
    quiet >= 30 && turn.status !== "waiting"
      ? h("span", { className: "glosa-chat-quiet" }, `No update for ${elapsedLabel(quiet)}`)
      : null,
  );
}

function TurnEnd({ turn, parts, store, onSettings, runtime, oauth }) {
  if (ACTIVE.has(turn.status)) return null;
  const failure = turn.failure;
  const unknown = turn.status === "outcome_unknown" || failure?.dispatchCertainty === "unknown";
  const failed = turn.status === "failed" || unknown;
  const ownsCleanup =
    ["unknown", "stopping"].includes(runtime?.state) &&
    (runtime.turnId
      ? runtime.turnId === turn.id
      : runtime.attemptId
        ? runtime.attemptId === turn.attemptId
        : !turn.attemptId || !runtime.runId || runtime.runId === turn.attemptId);
  const label = unknown
    ? "Outcome not confirmed"
    : turn.status === "cancelled"
      ? "Cancelled"
      : failed
        ? "Reply failed"
        : "Completed";
  return h(
    "div",
    {
      className: `glosa-chat-turn-result${turn.status === "cancelled" ? " glosa-chat-turn-state" : ""}${failed ? " glosa-chat-turn-failure" : ""}`,
      "data-status": turn.status,
    },
    h("span", { className: "glosa-chat-result-label" }, failure?.title || label),
    failed
      ? h("p", null, failure?.detail || turn.error || "The agent ended without completing this reply.")
      : !parts.length && turn.status === "completed"
        ? h("p", null, "The agent finished without a message.")
        : null,
    h(
      "div",
      { className: "glosa-chat-recovery-actions" },
      unknown
        ? h("button", { type: "button", onClick: () => void store.refresh().catch(store.fail) }, "Refresh status")
        : null,
      failure?.category === "quota" && oauth
        ? h(
            "a",
            { href: "https://chatgpt.com/settings/usage", target: "_blank", rel: "noopener noreferrer" },
            "Manage usage",
          )
        : failure?.recoveryAction === "sign_in"
          ? h("button", { type: "button", onClick: onSettings }, "Sign in again")
          : failure?.recoveryAction === "change_settings"
            ? h("button", { type: "button", onClick: onSettings }, "Review settings")
            : unknown || failure?.recoveryAction === "retry_stop"
              ? h(
                  "button",
                  {
                    type: "button",
                    hidden: !ownsCleanup,
                    onClick: () => void store.stop(turn.id).catch(store.fail),
                  },
                  "Retry stop",
                )
              : failed && typeof turn.text === "string"
                ? h(
                    "button",
                    { type: "button", onClick: () => void store.retryTurn(turn).catch(store.fail) },
                    "Use as draft",
                  )
                : null,
      turn.status === "cancelled" && typeof turn.text === "string"
        ? h(
            "button",
            {
              type: "button",
              className: "glosa-chat-verb",
              "aria-label": "Use message as draft",
              onClick: () => void store.replaceDraft(turn).catch(store.fail),
            },
            "Use as draft",
          )
        : null,
    ),
  );
}

function Message({ message, view, store, renderMarkdown, onSettings }) {
  const subjects = React.useRef(new Map());
  const data = message.metadata.custom.glosa,
    { turn } = data;
  if (data.kind === "user")
    return h(
      MessagePrimitive.Root,
      { className: "glosa-chat-message", "data-kind": "human" },
      h("h3", { className: "glosa-visually-hidden" }, "You"),
      turn.retryOf ? h("p", { className: "glosa-chat-retry-source" }, "Retry of an earlier message") : null,
      h("div", { className: "glosa-chat-text" }, renderReferences(turn.text, turn.references)),
      turn.attachments?.length
        ? h(
            "ul",
            { className: "glosa-chat-sent-attachments", "aria-label": "Attachments" },
            turn.attachments.map((item) => h("li", { key: item.hash }, item.name)),
          )
        : null,
      h(CopyButton, { text: turn.text, store, label: "You" }),
    );
  const { parts } = data;
  const work = turnActivity(turn, parts, subjects.current);
  const reasoning = parts.filter((part) => part.kind === "reasoning");
  const rows = [];
  let reasoned = false,
    stepped = false;
  const shortened = (part) =>
    `${part.text}${part.truncated ? "\n\nDisplay shortened. Export the chat for the complete message." : ""}`;
  for (const part of parts) {
    if (part.kind === "tool") {
      if (!stepped) rows.push(h(Steps, { key: "steps", work }));
      stepped = true;
    } else if (part.kind === "reasoning") {
      if (!reasoned)
        rows.push(
          h(
            "details",
            { key: "reasoning", className: "glosa-chat-message", "data-kind": "reasoning" },
            h("summary", null, "Reasoning summary"),
            h(Markdown, { text: reasoning.map(shortened).join("\n\n"), renderMarkdown, reasoning: true }),
          ),
        );
      reasoned = true;
    } else
      rows.push(
        h(
          "article",
          { key: part.id, className: "glosa-chat-message", "data-kind": "agent" },
          h("h3", { className: "glosa-visually-hidden" }, "Assistant"),
          h(Markdown, { text: shortened(part), renderMarkdown }),
          h(CopyButton, { text: part.text, store, label: "Assistant" }),
        ),
      );
  }
  const asked = turn.settings,
    ran = turn.effective;
  const resolved = view.catalog?.capabilities?.[view.chat.profileId]?.models.find(
    (item) => item.id === asked?.model,
  )?.resolvedModel;
  const modelMismatch = asked && ran?.model && ran.model !== asked.model && ran.model !== resolved;
  const effortMismatch = asked?.effort && ran?.effort && asked.effort !== ran.effort;
  return h(
    MessagePrimitive.Root,
    { className: "glosa-chat-assistant-turn" },
    modelMismatch || effortMismatch
      ? h(
          "details",
          { className: "glosa-chat-message", "data-kind": "detail" },
          h("summary", null, modelMismatch ? "Ran on a different model" : "Ran at a different effort"),
          h(
            "div",
            { className: "glosa-chat-text" },
            `You chose: ${asked.model} · ${asked.effort || "default"}\nThe agent reported: ${ran.model ?? "no model"} · ${ran.effort ?? "no effort"}`,
          ),
        )
      : null,
    ...rows,
    work.live || data.starting || turn.local
      ? h(Live, {
          turn,
          label: turn.local ? "Sending" : data.starting ? "Starting" : work.live,
          lastEventAt: view.lastEventAt,
        })
      : null,
    h(TurnEnd, {
      turn,
      parts,
      store,
      onSettings,
      runtime: view.chat.runtime,
      oauth:
        view.catalog?.profiles?.find((profile) => profile.id === (turn.profileId ?? view.chat.profileId))
          ?.authentication?.mode === "oauth",
    }),
  );
}

function renderReferences(text, references = []) {
  const nodes = [];
  let offset = 0;
  for (const ref of [...references].sort((a, b) => a.start - b.start)) {
    nodes.push(
      text.slice(offset, ref.start),
      h(
        "span",
        {
          key: `${ref.start}:${ref.id}`,
          className: "glosa-chat-reference",
          title: ref.kind === "file" ? `Workspace file: ${ref.id}` : "Selected native command",
        },
        text.slice(ref.start, ref.end),
      ),
    );
    offset = ref.end;
  }
  nodes.push(text.slice(offset));
  return nodes;
}

function QueueItem({ item, store }) {
  const element = React.useRef(null),
    wasEditing = React.useRef(false);
  const [editing, setEditing] = React.useState(false),
    [value, setValue] = React.useState(item.text ?? "");
  const [busy, setBusy] = React.useState(false),
    [error, setError] = React.useState("");
  React.useLayoutEffect(() => {
    if (wasEditing.current && !editing)
      element.current?.querySelector('button[aria-label="Edit waiting message"]')?.focus();
    wasEditing.current = editing;
  }, [editing]);
  React.useLayoutEffect(
    () => () => {
      if (!element.current?.contains(document.activeElement)) return;
      const pane = element.current.closest(".glosa-chat-pane");
      queueMicrotask(() => {
        if (pane?.isConnected) pane.querySelector('[aria-label="Message"]')?.focus();
      });
    },
    [],
  );
  const run = async (work) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (problem) {
      setError(problem.message);
    } finally {
      setBusy(false);
    }
  };
  return h(
    "li",
    { ref: element, "data-kind": item.kind, "data-queue-id": item.id },
    h("span", { className: "glosa-chat-tray-state" }, item.label),
    editing
      ? h(
          "div",
          { className: "glosa-chat-queue-editor" },
          h("textarea", {
            autoFocus: true,
            "aria-label": "Edit waiting message",
            value,
            maxLength: 65536,
            onChange: (event) => setValue(event.target.value),
            disabled: busy,
          }),
          h(
            "button",
            {
              type: "button",
              disabled: busy || !value.trim(),
              onClick: () =>
                void run(async () => {
                  await store.editQueued(item.id, value);
                  setEditing(false);
                }),
            },
            busy ? "Saving…" : "Save message",
          ),
          h("button", { type: "button", disabled: busy, onClick: () => setEditing(false) }, "Cancel edit"),
        )
      : h("span", { className: "glosa-chat-tray-words", title: item.text }, item.text),
    h(
      "span",
      { className: "glosa-chat-tray-verbs" },
      item.kind === "failed"
        ? h(
            "button",
            {
              type: "button",
              className: "glosa-chat-verb",
              disabled: busy,
              "aria-label": item.entry?.authorityChanged ? "Use waiting message as draft" : "Retry sending message",
              title: item.entry?.authorityChanged ? "Replaces your current draft for review before sending" : undefined,
              onClick: () =>
                void run(() =>
                  item.entry?.authorityChanged ? store.restoreOutboxDraft(item.id) : store.retryOutbox(),
                ),
            },
            item.entry?.authorityChanged ? "Use as draft" : "Retry",
          )
        : null,
      item.kind === "held"
        ? h(
            "button",
            {
              type: "button",
              className: "glosa-chat-verb",
              disabled: busy,
              "aria-label": "Continue held message",
              "data-continue-turn": "true",
              onClick: () => void run(() => store.continueTurn(item.id)),
            },
            "Continue",
          )
        : null,
      !editing
        ? h(
            "button",
            {
              type: "button",
              className: "glosa-chat-verb",
              disabled: busy,
              "aria-label": "Edit waiting message",
              onClick: () => {
                setValue(item.text ?? "");
                setEditing(true);
              },
            },
            "Edit",
          )
        : null,
      h(
        "button",
        {
          type: "button",
          className: "glosa-chat-verb",
          disabled: busy,
          "aria-label": "Remove waiting message",
          onClick: () => void run(() => store.removeQueued(item.id)),
        },
        "Remove",
      ),
      item.kind === "queued"
        ? h(
            "button",
            {
              type: "button",
              className: "glosa-chat-verb",
              disabled: busy,
              "aria-label": "Send this message now",
              title: "Stops the current reply",
              onClick: () => void run(() => store.sendNow(item.id)),
            },
            "Send now",
          )
        : null,
    ),
    error || item.entry?.error || item.turn?.error
      ? h(
          "p",
          { className: "glosa-chat-tray-why", role: error ? "alert" : undefined },
          error || item.entry?.error || item.turn?.error,
        )
      : null,
  );
}

function Decision({ decision, store, runtime }) {
  const element = React.useRef(null);
  const [, expire] = React.useReducer((value) => value + 1, 0);
  const [text, setText] = React.useState(""),
    [answers, setAnswers] = React.useState({});
  const [sending, setSending] = React.useState(false),
    [error, setError] = React.useState("");
  const receipt = store.getDecisionIntent(decision.id, decision.generation);
  const expired = Date.parse(decision.expiresAt) <= Date.now();
  const stale = runtime?.generation !== undefined && runtime.generation !== decision.generation;
  const unavailable = expired || stale;
  React.useEffect(() => {
    const remaining = Date.parse(decision.expiresAt) - Date.now();
    if (remaining <= 0 || !Number.isFinite(remaining)) return;
    const timer = setTimeout(expire, Math.min(remaining, 2147483647));
    return () => clearTimeout(timer);
  }, [decision.expiresAt]);
  React.useLayoutEffect(
    () => () => {
      // Only return focus when the removed request actually owned it. An arriving or disappearing
      // request must never interrupt someone typing or reading another part of the conversation.
      if (!element.current?.contains(document.activeElement)) return;
      const pane = element.current.closest(".glosa-chat-pane");
      queueMicrotask(() => {
        if (pane?.isConnected)
          pane.querySelector('.glosa-chat-decision button:not(:disabled), [aria-label="Message"]')?.focus();
      });
    },
    [],
  );
  const change = (id, answer) => setAnswers((previous) => ({ ...previous, [id]: answer }));
  const respond = async (choice) => {
    if (unavailable || sending) return;
    const values = Object.fromEntries(
      (decision.questions ?? []).map((question) => {
        const answer = answers[question.id] ?? { selected: [], free: "" };
        return [question.id, [...answer.selected, ...(answer.free.trim() ? [answer.free.trim()] : [])]];
      }),
    );
    if (choice.id !== "deny" && Object.values(values).some((value) => !value.length)) {
      setError("Answer each question before submitting.");
      return;
    }
    setSending(true);
    setError("");
    try {
      await store.answerDecision(decision, choice.id, decision.questions?.length ? JSON.stringify(values) : text);
    } catch (problem) {
      setError(`${problem.message} Retry your original response if the connection was lost.`);
    } finally {
      setSending(false);
    }
  };
  return h(
    "section",
    { ref: element, className: "glosa-chat-decision", "aria-label": decision.title, "data-decision-id": decision.id },
    h("h3", { tabIndex: -1 }, decision.title),
    h("pre", null, decision.detail),
    ...(decision.questions ?? []).map((question) => {
      const answer = answers[question.id] ?? { selected: [], free: "" };
      return h(
        "fieldset",
        { key: question.id, disabled: sending || unavailable || !!receipt },
        h("legend", null, question.question),
        ...question.options.map((option) =>
          h(
            "label",
            { key: option.label },
            h("input", {
              type: question.multiple ? "checkbox" : "radio",
              name: `${decision.id}:${question.id}`,
              checked: answer.selected.includes(option.label),
              onChange: (event) =>
                change(question.id, {
                  free: question.multiple ? answer.free : "",
                  selected: question.multiple
                    ? event.target.checked
                      ? [...answer.selected, option.label]
                      : answer.selected.filter((value) => value !== option.label)
                    : [option.label],
                }),
            }),
            option.label,
            option.description ? h("small", null, option.description) : null,
          ),
        ),
        h("textarea", {
          rows: 2,
          "aria-label": `${question.question}: your answer`,
          placeholder: "Your answer",
          value: answer.free,
          onChange: (event) =>
            change(question.id, { selected: question.multiple ? answer.selected : [], free: event.target.value }),
        }),
      );
    }),
    decision.allowText && !decision.questions
      ? h("textarea", {
          rows: 2,
          "aria-label": "Answer",
          value: text,
          disabled: sending || unavailable || !!receipt,
          onChange: (event) => setText(event.target.value),
        })
      : null,
    h(
      "p",
      { className: "glosa-decision-expiry" },
      stale
        ? "This request belongs to an earlier connection. Refresh status for a current request."
        : expired
          ? "This request expired. Refresh status for a current request."
          : `Expires in ${Math.max(1, Math.ceil((Date.parse(decision.expiresAt) - Date.now()) / 60000))} min`,
    ),
    error ? h("p", { role: "alert" }, error) : null,
    ...decision.choices.map((choice) =>
      h(
        "button",
        {
          key: choice.id,
          type: "button",
          disabled: sending || unavailable || (!!receipt && receipt.choice !== choice.id),
          onClick: () => void respond(choice),
        },
        sending ? "Sending…" : choice.label,
      ),
    ),
  );
}

function NativeDraft({ store, view, options, chrome }) {
  const host = React.useRef(null),
    input = React.useRef(null),
    completion = React.useRef(null),
    context = React.useRef(view);
  context.current = view;
  React.useLayoutEffect(() => {
    const field = document.createElement("textarea");
    field.className = "glosa-chat-draft";
    field.setAttribute("aria-label", "Message");
    field.maxLength = 65536;
    field.rows = 3;
    input.current = field;
    host.current.append(field);
    const picker = createComposerPicker(field, {
      getFiles: options.getFiles ?? (() => []),
      enabled: () => !context.current.changing,
      getCatalog: () =>
        options.dataAccess.getChatCommands?.(options.slug, options.chatId) ??
        Promise.resolve({ commands: [], loaded: false }),
      loadCatalog: () => options.dataAccess.refreshChatCommands(options.slug, options.chatId),
      onAction: async (action) => {
        if (context.current.draft.attachments.length)
          throw new Error("Remove attachments before using a workspace action. Your draft has been kept.");
        if (action === "mcp") await chrome.openTools();
        else await chrome.showNativeConnections();
        return true;
      },
      onChange: () => store.setDraft(field.value, picker.references),
    });
    completion.current = picker;
    field.addEventListener("input", () => store.setDraft(field.value, picker.references));
    field.addEventListener("keydown", (event) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229 ||
        event.key !== "Enter" ||
        event.shiftKey
      )
        return;
      event.preventDefault();
      picker.resolveTyped();
      store.setDraft(field.value, picker.references);
      void store.submit().catch(store.fail);
    });
    return () => {
      picker.destroy();
      host.current?.replaceChildren();
    };
  }, [store, options, chrome]);
  React.useLayoutEffect(() => {
    if (!input.current) return;
    if (input.current.value !== view.draft.text) input.current.value = view.draft.text;
    completion.current?.setReferences(view.draft.references);
    completion.current?.setScope(`${view.chat.provider}:${view.chat.profileId}`);
    input.current.disabled = !!view.chat.archived;
    input.current.placeholder = view.chat.archived
      ? "Restore this chat to send a message."
      : "What would you like to work on?";
  }, [view]);
  return h("div", { ref: host, className: "glosa-chat-native-draft" });
}

function Composer({ store, view, options, chrome }) {
  const files = React.useRef(null),
    { chat, catalog } = view;
  const available = catalog?.providers?.find((entry) => entry.id === chat.provider)?.available ?? catalog?.available;
  const profile = catalog?.profiles?.find((entry) => entry.id === chat.profileId);
  const ready = profile?.enabled && !profile.removed && (!profile.auth || profile.auth.state === "authenticated");
  const models = catalog?.capabilities?.[chat.profileId]?.models ?? [];
  const model = models.find((entry) => entry.id === chat.settings.model);
  const supported =
    !models.length || (!!model && (!chat.settings.effort || model.efforts.includes(chat.settings.effort)));
  const working = view.queue.active ?? view.queue.head ?? view.queue.localHead;
  const unconfirmed = ["unknown", "stopping"].includes(chat.runtime?.state);
  const blocked =
    view.changing ||
    view.uploading ||
    view.checking ||
    view.connection === "unavailable" ||
    !available ||
    !ready ||
    !supported ||
    chat.archived;
  return h(
    React.Fragment,
    null,
    h(
      "div",
      { className: "glosa-chat-readiness", hidden: ready && supported },
      h(
        "span",
        null,
        !ready
          ? "This account needs attention before it can send."
          : "Choose an available model and effort to continue.",
      ),
      !ready
        ? h(
            "button",
            { type: "button", onClick: options.onSettings },
            profile?.auth?.state === "expired" ? "Sign in again" : "Manage account",
          )
        : null,
    ),
    profile?.authentication?.mode === "oauth"
      ? h(
          "div",
          { className: "glosa-chat-plan" },
          h(
            "span",
            null,
            catalog.oauthAccounts?.[chat.provider]?.planEnabled === true ? "Using ChatGPT plan" : "ChatGPT account",
          ),
          " · ",
          h(
            "a",
            { href: "https://chatgpt.com/settings/usage", target: "_blank", rel: "noopener noreferrer" },
            "Manage usage",
          ),
        )
      : null,
    h(
      ComposerPrimitive.Root,
      {
        className: "glosa-chat-composer",
        onSubmit: (event) => {
          event.preventDefault();
          void store.submit().catch(store.fail);
        },
      },
      h(
        "ol",
        { className: "glosa-chat-tray", "aria-label": "Waiting messages", hidden: !view.queue.tray.length },
        view.queue.tray.map((item) => h(QueueItem, { key: item.id, item, store })),
      ),
      h(
        "span",
        { className: "glosa-visually-hidden", role: "status" },
        view.queue.tray.length
          ? `${view.queue.tray.length} ${view.queue.tray.length === 1 ? "message" : "messages"} waiting`
          : "",
      ),
      view.draft.retryOfTurnId
        ? h("p", { className: "glosa-chat-retry-source" }, "Retry of an earlier message. Review before sending.")
        : null,
      h(NativeDraft, { store, view, options, chrome }),
      h(
        "div",
        { className: "glosa-chat-attachments" },
        view.draft.attachments.map((attachment) =>
          h(
            "button",
            {
              key: attachment.hash,
              type: "button",
              "aria-label": `Remove ${attachment.name}`,
              onClick: () => store.removeAttachment(attachment.hash),
            },
            `${attachment.name} ×`,
          ),
        ),
      ),
      h(
        "div",
        { className: "glosa-chat-compose-actions" },
        h(
          "button",
          {
            type: "button",
            className: "glosa-chat-attach glosa-icon-button",
            "aria-label": "Add attachments",
            title: "Attach documents or images",
            disabled: view.uploading || chat.archived,
            onClick: () => files.current.click(),
          },
          "+",
        ),
        h("input", {
          ref: files,
          type: "file",
          hidden: true,
          multiple: true,
          accept: ".md,.txt,image/png,image/jpeg,image/webp",
          "aria-label": "Attach files",
          onChange: (event) => {
            const selected = [...event.target.files];
            event.target.value = "";
            void store.attach(selected).catch(store.fail);
          },
        }),
        h(Slot, { element: chrome.controls }),
        h("span", { className: "glosa-chat-action-spacer" }),
        h(
          "span",
          { className: "glosa-chat-send-group" },
          h(
            "button",
            {
              type: "button",
              className: "glosa-chat-stop",
              hidden: !working && !unconfirmed && !view.stopping,
              disabled: view.stopping,
              onClick: () => void store.stop().catch(store.fail),
            },
            view.stopping ? "Stopping…" : unconfirmed && !working ? "Retry stop" : "Stop",
          ),
          h(
            "button",
            {
              type: "button",
              className: "glosa-agent-primary glosa-chat-send",
              "data-mode": working ? "queue" : "send",
              "aria-label": working ? "Queue message" : "Send message",
              title: working ? "Queue next message: it goes after the reply at work" : "Send message",
              disabled: !!blocked || !view.draft.text.trim(),
              onClick: () => void store.submit().catch(store.fail),
            },
            view.uploading
              ? "Attaching…"
              : view.changing
                ? "Saving…"
                : view.checking
                  ? "Checking…"
                  : working
                    ? "Queue"
                    : "↑",
          ),
        ),
      ),
    ),
    h(Slot, { element: chrome.footer }),
  );
}

function ChatSurface({ store, chrome, options, renderMarkdown }) {
  const { runtime, view } = useChatRuntime(store);
  const viewport = React.useRef(null);
  const transcript = React.useRef(null);
  const following = React.useRef(true);
  const detailsPaused = React.useRef(false);
  const [jump, setJump] = React.useState(false);
  const [clock, setClock] = React.useState(Date.now());
  const decisionRows = React.useRef(null);
  const [offscreen, setOffscreen] = React.useState(0);
  const firstOffscreen = React.useRef(null);
  React.useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 15000);
    return () => clearInterval(timer);
  }, []);
  const decisions = view.chat.decisions.filter((decision) => decision.status === "pending");
  const alignViewport = () => {
    const node = viewport.current;
    if (!node?.clientHeight) return;
    const selection = window.getSelection?.();
    const selecting = selection && !selection.isCollapsed && node.contains(selection.anchorNode);
    if (following.current && !selecting) node.scrollTop = node.scrollHeight;
    setJump(node.scrollHeight - node.scrollTop - node.clientHeight >= 64);
  };
  React.useLayoutEffect(alignViewport, [view]);
  React.useLayoutEffect(() => {
    // assistant-ui's automatic bottom detection treats a display:none desk tab as a zero-height
    // viewport. Own following here so a hidden tab cannot erase the person's reading position.
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(alignViewport) : null;
    observer?.observe(viewport.current);
    observer?.observe(transcript.current);
    return () => observer?.disconnect();
  }, []);
  React.useLayoutEffect(() => {
    const node = viewport.current;
    const update = () => {
      const bounds = node.getBoundingClientRect();
      const hidden = [...decisionRows.current.querySelectorAll(".glosa-chat-decision")].filter((row) => {
        const box = row.getBoundingClientRect();
        return box.top < bounds.top || box.bottom > bounds.bottom;
      });
      firstOffscreen.current = hidden[0];
      setOffscreen(hidden.length);
    };
    update();
    node.addEventListener("scroll", update, { passive: true });
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(update) : null;
    observer?.observe(node);
    observer?.observe(decisionRows.current);
    return () => {
      node.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, [view.chat.decisions]);
  const run = (work) => void work().catch(store.fail);
  return h(
    AssistantRuntimeProvider,
    { runtime },
    h(
      ThreadPrimitive.Root,
      { className: "glosa-chat-island" },
      h(Slot, { element: chrome.header }),
      h(Slot, { element: chrome.transfer }),
      h(
        ThreadPrimitive.Viewport,
        {
          ref: viewport,
          className: "glosa-chat-history",
          role: "log",
          "aria-label": "Chat messages",
          "aria-live": "off",
          tabIndex: 0,
          "aria-busy":
            !!(view.queue.active || view.queue.head || view.queue.localHead) && view.queue.active?.status !== "waiting",
          autoScroll: false,
          turnAnchor: "bottom",
          scrollToBottomOnRunStart: false,
          onScroll: (event) => {
            const node = event.currentTarget;
            if (!node.clientHeight) return;
            const away = node.scrollHeight - node.scrollTop - node.clientHeight >= 64;
            following.current = !away && !detailsPaused.current;
            setJump(away);
          },
          onToggleCapture: (event) => {
            if (event.target.tagName === "DETAILS" && event.target.open) {
              detailsPaused.current = true;
              following.current = false;
            }
          },
          onClickCapture: (event) => {
            const details = event.target.closest?.("summary")?.parentElement;
            if (details?.tagName === "DETAILS" && !details.open) {
              detailsPaused.current = true;
              following.current = false;
            }
          },
        },
        view.chat.page?.hasEarlier
          ? h(
              "button",
              {
                type: "button",
                className: "glosa-chat-earlier",
                disabled: view.paging,
                onClick: () => {
                  const node = viewport.current,
                    top = node.scrollTop,
                    height = node.scrollHeight;
                  run(async () => {
                    await store.loadEarlier(view.chat.page.first);
                    requestAnimationFrame(() => {
                      node.scrollTop = top + node.scrollHeight - height;
                    });
                  });
                },
              },
              view.paging ? "Loading earlier messages…" : "Earlier messages",
            )
          : null,
        view.chat.page?.hasLater
          ? h(
              "button",
              { type: "button", className: "glosa-chat-earlier", onClick: () => run(() => store.loadRecent()) },
              "Recent messages",
            )
          : null,
        !view.chat.turns.length && !view.queue.localHead
          ? h(
              "div",
              { className: "glosa-chat-empty", hidden: !!view.queue.tray.length },
              h("h2", null, "What would you like to work on?"),
              h("p", null, "Ask a question, work on a document, or give your agent a task in this workspace."),
            )
          : null,
        h(
          "div",
          { ref: transcript },
          h(ThreadPrimitive.Messages, null, ({ message }) =>
            h(Message, { message, view, store, renderMarkdown, onSettings: options.onSettings }),
          ),
          h(
            "div",
            { ref: decisionRows, className: "glosa-chat-decisions", "data-clock": Math.floor(clock / 15000) },
            decisions.map((decision) =>
              h(Decision, {
                key: `${decision.id}:${decision.generation}`,
                decision,
                store,
                runtime: view.chat.runtime,
              }),
            ),
          ),
        ),
      ),
      h(
        "div",
        { className: "glosa-chat-jump-anchor" },
        h(
          "button",
          {
            type: "button",
            className: "glosa-chat-jump",
            hidden: !jump,
            onClick: () => {
              const node = viewport.current;
              detailsPaused.current = false;
              following.current = true;
              node.scrollTop = node.scrollHeight;
              setJump(false);
            },
          },
          "Jump to latest",
        ),
      ),
      offscreen
        ? h(
            "div",
            { className: "glosa-chat-attention" },
            h(
              "span",
              { role: "status" },
              `${offscreen} ${offscreen === 1 ? "request needs" : "requests need"} your reply`,
            ),
            h(
              "button",
              {
                type: "button",
                onClick: () => {
                  const row = firstOffscreen.current;
                  row?.scrollIntoView({ block: "start" });
                  row?.querySelector("h3")?.focus({ preventScroll: true });
                },
              },
              "Review request",
            ),
          )
        : null,
      h(
        "p",
        { className: "glosa-chat-status", role: "status", "data-error": !!view.error },
        view.connection === "down" ? "Reconnecting · no messages are sent automatically" : view.notice,
      ),
      view.connection !== "up"
        ? h(
            "div",
            { className: "glosa-chat-connection-recovery" },
            h("button", { type: "button", onClick: () => run(() => store.refresh()) }, "Refresh status"),
          )
        : null,
      h(Composer, { store, view, options, chrome }),
    ),
  );
}

export async function mountChatSurface(host, store, options) {
  const chrome = createChatChrome(store, options);
  const root = createRoot(host);
  let renderMarkdown;
  let disposed = false;
  const paint = () => flushSync(() => root.render(h(ChatSurface, { store, chrome, options, renderMarkdown })));
  paint();
  void loadChatMarkdown()
    .then((renderer) => {
      if (!disposed) {
        renderMarkdown = renderer;
        paint();
      }
    })
    .catch((error) =>
      store.fail(new Error(`Markdown formatting could not load: ${error.message}. Your messages are shown as text.`)),
    );
  return {
    focus() {
      host.querySelector('[aria-label="Message"]')?.focus();
    },
    async confirmClose() {
      let saved = true;
      await store.save().catch(() => {
        saved = false;
      });
      const view = store.getSnapshot();
      if (!view.draft.dirty && !view.uploading && !view.changing && !view.outbox.length) return true;
      return confirmDialog({
        title: "Close with unfinished changes?",
        body: saved
          ? "Unsent text and messages are kept on this device for recovery. Nothing will be sent automatically when you return. The agent keeps running when its tab closes."
          : "The draft could not be saved. Copy your text before closing to keep it. Nothing will be sent automatically when you return. The agent keeps running when its tab closes.",
        confirmLabel: "Close tab",
      });
    },
    destroy() {
      disposed = true;
      flushSync(() => root.unmount());
      chrome.destroy();
    },
  };
}

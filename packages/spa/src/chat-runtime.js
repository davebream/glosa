// SPDX-License-Identifier: Apache-2.0
import { React, useExternalStoreRuntime } from "./vendor/chat-ui.js";

const ACTIVE = new Set(["dispatching", "running", "waiting", "stopping"]);

/** Only journal-owned messages reach assistant-ui. Queue and recovery are separate UI state. */
export function projectChatMessages(view, cache = new Map()) {
  const chat = view.chat;
  if (!chat) return [];
  const result = [];
  const partsByTurn = new Map();
  for (const part of chat.content) {
    let parts = partsByTurn.get(part.turnId);
    if (!parts) partsByTurn.set(part.turnId, (parts = []));
    parts.push(part);
  }
  const turns = view.queue.localHead
    ? [...chat.turns, { ...view.queue.localHead.entry, status: "sending", local: true }]
    : chat.turns;
  for (const turn of turns) {
    if (view.queue.hidden.has(turn.id)) continue;
    const createdAt = new Date(turn.at ?? 0);
    const parts = partsByTurn.get(turn.id) ?? [];
    const prior = cache.get(turn.id);
    const unchanged =
      prior?.turn === turn &&
      prior.parts.length === parts.length &&
      prior.parts.every((part, index) => part === parts[index]) &&
      prior.starting === (turn === view.queue.head);
    if (unchanged) {
      result.push(...prior.messages);
      continue;
    }
    const messages = [];
    if (typeof turn.text === "string")
      messages.push({
        id: `user:${turn.id}`,
        role: "user",
        createdAt,
        content: [{ type: "text", text: turn.text }],
        metadata: { custom: { glosa: { turn, kind: "user" } } },
      });
    // Include a terminal row even for a completed turn with no output.
    messages.push({
      id: `assistant:${turn.id}`,
      role: "assistant",
      createdAt,
      content: [
        {
          type: "text",
          text: parts
            .filter((part) => part.kind === "text")
            .map((part) => part.text)
            .join("\n\n"),
        },
      ],
      status:
        ACTIVE.has(turn.status) || turn.local || turn === view.queue.head
          ? { type: "running" }
          : turn.status === "failed" || turn.status === "outcome_unknown"
            ? { type: "incomplete", reason: "error", error: turn.error }
            : turn.status === "cancelled"
              ? { type: "incomplete", reason: "cancelled" }
              : { type: "complete", reason: "stop" },
      metadata: { custom: { glosa: { turn, parts, kind: "assistant", starting: turn === view.queue.head } } },
    });
    cache.set(turn.id, { turn, parts, starting: turn === view.queue.head, messages });
    result.push(...messages);
  }
  const ids = new Set(turns.map((turn) => turn.id));
  for (const id of cache.keys()) if (!ids.has(id)) cache.delete(id);
  return result;
}

export function useChatRuntime(store) {
  const subscribe = React.useCallback((listener) => store.subscribe(listener), [store]);
  const view = React.useSyncExternalStore(subscribe, store.getSnapshot, store.getSnapshot);
  const cache = React.useRef(new Map());
  const messages = React.useMemo(() => projectChatMessages(view, cache.current), [view]);
  const runtime = useExternalStoreRuntime({
    messages,
    isRunning: !!view.queue.active || !!view.queue.head || !!view.queue.localHead,
    activeRunId: view.queue.active?.attemptId ?? view.queue.active?.id ?? view.queue.head?.id,
    isSendDisabled: !!view.chat?.archived || view.uploading || view.changing || view.checking,
    onNew: () => store.submit(),
    onCancel: () => store.stop(),
    onRefetch: () => store.refresh(),
    hasEarlier: !!view.chat?.page?.hasEarlier,
    onLoadEarlier: () => store.loadEarlier(view.chat?.page?.first),
    // No local/cloud history, frontend tool execution, branching, or inferred native resume.
  });
  return { runtime, view };
}

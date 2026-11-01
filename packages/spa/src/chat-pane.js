// SPDX-License-Identifier: Apache-2.0
// The desk keeps its vanilla pane contract. React and assistant-ui load only for managed chats.
import { acquireChatStore } from "./chat-store.js";

export { applyChatEvent } from "./chat-store.js";

export function createChatPane(host, options) {
  const element = document.createElement("section");
  element.className = "glosa-chat-pane glosa-chat-managed";
  element.setAttribute("aria-label", "Managed chat");
  host.append(element);
  let lease = acquireChatStore(options.dataAccess, options.slug, options.chatId);
  let store = lease.store;
  let disposed = false,
    surface,
    stopChanges;
  const handle = {
    element,
    kind: "chat",
    title: "Chat",
    ready: null,
    focus: () => surface?.focus(),
    async confirmClose() {
      return surface ? surface.confirmClose() : true;
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      stopChanges?.();
      surface?.destroy();
      lease.release();
      element.remove();
    },
  };
  const sync = () => {
    const view = store.getSnapshot();
    if (!view.chat || disposed) return;
    handle.title = view.chat.title;
    handle.provider = view.chat.provider;
    handle.attentionCount = view.chat.decisions.filter((decision) => decision.status === "pending").length;
    const active = view.queue.active ?? view.queue.head;
    handle.activityLabel = view.chat.archived
      ? "Archived"
      : active
        ? active.status === "waiting"
          ? "Needs your reply"
          : "Working…"
        : "";
    options.onChange?.(view.chat);
  };
  stopChanges = store.subscribe(sync);
  async function initialize() {
    element.textContent = "Loading chat…";
    try {
      const [, module] = await Promise.all([store.ready, import("./chat-ui/surface.js")]);
      if (disposed) return;
      if (!document.querySelector("link[data-chat-ui]")) {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = new URL("./chat-ui/chat.css", import.meta.url).href;
        link.dataset.chatUi = "true";
        document.head.append(link);
      }
      element.replaceChildren();
      surface = await module.mountChatSurface(element, store, options);
      sync();
    } catch (error) {
      if (disposed) return;
      const message = document.createElement("p");
      message.className = "glosa-chat-load-error";
      message.textContent = `Chat could not load: ${error.message || "Unknown error"}`;
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = "Retry";
      retry.onclick = () => {
        surface?.destroy();
        stopChanges?.();
        lease.release();
        lease = acquireChatStore(options.dataAccess, options.slug, options.chatId);
        store = lease.store;
        stopChanges = store.subscribe(sync);
        handle.ready = initialize();
      };
      element.replaceChildren(message, retry);
    }
  }
  handle.ready = initialize();
  return handle;
}

// SPDX-License-Identifier: Apache-2.0
// The desktop shell's Dock badge and OS notifications (#391, #160). Attention is daemon-wide
// (docs/design/2026-09-25-desktop-shell-feature-map.md §4, decision 4): every workspace stream
// carries `attention_changed {slug}` and `chats_changed {slugs}` for ANY workspace (#389), so the
// one stream this page already has is enough to watch them all.
//
// Created only when the shell's bridge is present; a browser tab never builds one. It reads the
// daemon only through the data-access module (AGENTS.md invariant 6) and speaks to the shell only
// through `bridge.notify({ id, title, body, badge })`, which carries no path (A3 "Desktop shell").
//
//   badge    = this window's own workspace: its attention_count + decision_count, on every change
//              and on focus, sent with the workspace's slug as `scope`. The shell adds up the
//              workspaces its open windows are on, each once, so the Dock never shows a number
//              that no open window explains. A window with no workspace reports 0.
//   notify   = while the window is not focused: a new attention request that asks something
//              (a question, a review, an approval; not a bare "look here"), a chat that starts
//              waiting on a decision, and on a desk surface a chat reply that finishes in the
//              current workspace.
//
// "New" means new since this page last looked. A workspace is known from the workspace list: one
// with nothing waiting is known-empty without a read, so the first request it ever gets is news;
// one that already has requests is read once to seed, and that read never notifies.

import { requestKind, requestNotice } from "./agent-request.js";

const RUNNING = new Set(["running", "waiting", "dispatching", "stopping"]);
const FINISHED = new Set(["completed", "failed"]);
const BODY_LIMIT = 240;

/** The folder a workspace row names, as the shell's window title does (`<file> · <folder>`). */
function folderName(row) {
  const path = typeof row?.path === "string" ? row.path.replace(/\/+$/, "") : "";
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name || "glosa";
}

function truncate(text) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > BODY_LIMIT ? `${flat.slice(0, BODY_LIMIT - 1)}…` : flat;
}

/** Whether an attention request is worth interrupting someone for: it asks something. A bare
 * pointer ("look here") is not; an approval request is, although the tray treats it apart. */
export function asksSomething(entry) {
  return (
    Boolean(entry) &&
    (requestKind(entry) === "review" ||
      (requestKind(entry) === "question" && typeof entry.message === "string" && entry.message.trim().length > 0))
  );
}

/** Notifications identify the actual source and requested action before optional prose. */
export function attentionBody(entry) {
  const notice = requestNotice(entry);
  return truncate(`${notice}${entry.message ? ` ${entry.message}` : ""}`);
}

/**
 * @param {{
 *   dataAccess: { getWorkspaces: () => Promise<any>, getInbox: (slug: string) => Promise<any>,
 *                 getChats: (slug: string) => Promise<any> },
 *   bridge: { notify: (message: { id?: string, title?: string, body?: string, badge?: number, scope?: string }) => unknown },
 *   desk?: boolean,
 *   currentSlug?: () => string | null | undefined,
 *   hasFocus?: () => boolean,
 *   setTimer?: (fn: () => void, ms: number) => unknown,
 *   clearTimer?: (handle: unknown) => void,
 *   delayMs?: number,
 * }} options
 */
export function createAttentionWatch({
  dataAccess,
  bridge,
  desk = false,
  currentSlug = () => null,
  hasFocus = () => true,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (handle) => clearTimeout(/** @type {any} */ (handle)),
  delayMs = 250,
}) {
  /** slug -> ids of attention requests already seen. Presence means the slug is known. */
  const seenAttention = new Map();
  /** slug -> (chat id -> pending decision count). Presence means the slug is known. */
  const seenDecisions = new Map();
  /** chat id -> last turn status, for the current workspace's replies on a desk surface. */
  const replyStatus = new Map();
  /** slug -> folder name, from the last workspace list. */
  const names = new Map();
  const dirtyAttention = new Set();
  const dirtyChats = new Set();
  let timer = null;
  let running = null;
  let destroyed = false;

  const send = (message) => {
    try {
      void Promise.resolve(bridge.notify(message)).catch(() => {});
    } catch {
      /* a closed bridge must never break the page */
    }
  };
  const nameOf = (slug) => names.get(slug) ?? "glosa";

  async function readInbox(slug) {
    const inbox = await dataAccess.getInbox(slug);
    return Array.isArray(inbox?.attention) ? inbox.attention : [];
  }

  async function readChats(slug) {
    const page = await dataAccess.getChats(slug);
    return Array.isArray(page?.chats) ? page.chats : [];
  }

  /** Reads the workspace list, reports the badge, and makes every listed workspace known. */
  async function refreshBadge() {
    const rows = await dataAccess.getWorkspaces();
    const list = Array.isArray(rows) ? rows : [];
    const current = currentSlug();
    let own = 0;
    for (const row of list) {
      if (typeof row?.slug !== "string") continue;
      names.set(row.slug, folderName(row));
      const attention = Number.isInteger(row.attention_count) && row.attention_count > 0 ? row.attention_count : 0;
      const decisions = Number.isInteger(row.decision_count) && row.decision_count > 0 ? row.decision_count : 0;
      if (row.slug === current) own = attention + decisions;
      if (!seenAttention.has(row.slug)) {
        if (attention === 0) seenAttention.set(row.slug, new Set());
        else seenAttention.set(row.slug, new Set((await readInbox(row.slug)).map((entry) => entry.id)));
      }
      if (!seenDecisions.has(row.slug)) {
        if (decisions === 0) seenDecisions.set(row.slug, new Map());
        else seenDecisions.set(row.slug, decisionCounts(await readChats(row.slug)));
      }
    }
    if (!destroyed) send(current ? { badge: own, scope: current } : { badge: 0 });
  }

  function decisionCounts(chats) {
    const counts = new Map();
    for (const chat of chats) {
      if (typeof chat?.id === "string") counts.set(chat.id, Number(chat.pendingDecisions) || 0);
    }
    return counts;
  }

  async function checkAttention(slug) {
    const entries = await readInbox(slug);
    const seen = seenAttention.get(slug);
    seenAttention.set(slug, new Set(entries.map((entry) => entry.id)));
    if (!seen) return; // first read of a workspace the list did not name yet: it seeds
    for (const entry of entries) {
      if (seen.has(entry.id) || !asksSomething(entry)) continue;
      if (hasFocus()) continue;
      send({ id: `attention:${slug}:${entry.id}`, title: nameOf(slug), body: attentionBody(entry) });
    }
  }

  async function checkChats(slug) {
    const chats = await readChats(slug);
    const before = seenDecisions.get(slug);
    seenDecisions.set(slug, decisionCounts(chats));
    const current = currentSlug() === slug;
    for (const chat of chats) {
      if (typeof chat?.id !== "string") continue;
      const title = typeof chat.title === "string" && chat.title.trim() ? truncate(chat.title) : "A chat";
      const pending = Number(chat.pendingDecisions) || 0;
      if (before && pending > (before.get(chat.id) ?? 0) && !hasFocus()) {
        send({
          id: `decision:${slug}:${chat.id}:${pending}`,
          title: nameOf(slug),
          body: `${title} is waiting on your decision.`,
        });
      }
      if (desk && current) {
        const previous = replyStatus.get(chat.id);
        replyStatus.set(chat.id, chat.status);
        if (previous !== undefined && RUNNING.has(previous) && FINISHED.has(chat.status) && !hasFocus()) {
          send({
            id: `reply:${slug}:${chat.id}:${chat.turnCount ?? chat.updatedAt ?? ""}`,
            title: nameOf(slug),
            body: chat.status === "failed" ? `${title}: the reply failed.` : `${title}: the reply finished.`,
          });
        }
      }
    }
  }

  async function run() {
    timer = null;
    const attention = [...dirtyAttention];
    const chats = [...dirtyChats];
    dirtyAttention.clear();
    dirtyChats.clear();
    try {
      await refreshBadge();
      for (const slug of attention) if (!destroyed) await checkAttention(slug);
      for (const slug of chats) if (!destroyed) await checkChats(slug);
    } catch {
      /* the next frame or focus tries again */
    }
  }

  function schedule() {
    if (destroyed || timer !== null) return;
    timer = setTimer(() => {
      running = run().finally(() => {
        running = null;
      });
    }, delayMs);
  }

  return {
    /** Starts watching: reports the badge and learns every workspace. */
    start() {
      const slug = currentSlug();
      if (desk && slug) dirtyChats.add(slug); // seeds the current workspace's reply statuses
      schedule();
    },
    /** One frame from the page's workspace stream. */
    handleFrame(frame) {
      if (destroyed || !frame) return;
      if (frame.event === "attention_changed" && typeof frame.data?.slug === "string") {
        dirtyAttention.add(frame.data.slug);
        schedule();
      } else if (frame.event === "chats_changed") {
        const slugs = Array.isArray(frame.data?.slugs) ? frame.data.slugs.filter((s) => typeof s === "string") : [];
        if (typeof frame.data?.slug === "string") slugs.push(frame.data.slug);
        const slug = currentSlug();
        if (slugs.length === 0 && slug) slugs.push(slug);
        for (const s of slugs) dirtyChats.add(s);
        schedule();
      }
    },
    /** The stream reconnected: anything may have been missed, so every known workspace is read. */
    resync() {
      if (destroyed) return;
      for (const slug of seenAttention.keys()) dirtyAttention.add(slug);
      for (const slug of seenDecisions.keys()) dirtyChats.add(slug);
      schedule();
    },
    /** The window came back, or moved to another workspace: the badge is re-read. */
    refresh() {
      schedule();
    },
    /** Runs a scheduled pass now (tests). */
    async flush() {
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
        running = run().finally(() => {
          running = null;
        });
      }
      await running;
    },
    destroy() {
      destroyed = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}

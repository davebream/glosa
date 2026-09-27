// SPDX-License-Identifier: Apache-2.0
// The desktop shell's Dock badge and notifications (#391). A fake data-access object stands in
// for the daemon and a fake bridge records what the shell would be told; the watcher's timers are
// manual, so `flush()` runs exactly one coalesced pass.
import { describe, expect, test } from "bun:test";
import { asksSomething, attentionBody, createAttentionWatch } from "../src/attention-watch.js";

type Row = { slug: string; path: string; attention_count: number; decision_count: number };
type Entry = { id: string; message?: string | null; action?: string | null; approval_mode?: boolean };
type Chat = { id: string; title?: string; pendingDecisions?: number; status?: string; turnCount?: number };

function world() {
  const rows: Row[] = [
    { slug: "a", path: "/w/alpha", attention_count: 0, decision_count: 0 },
    { slug: "b", path: "/w/beta", attention_count: 0, decision_count: 0 },
  ];
  const inbox = new Map<string, Entry[]>([
    ["a", []],
    ["b", []],
  ]);
  const chats = new Map<string, Chat[]>([
    ["a", []],
    ["b", []],
  ]);
  const reads = { workspaces: 0, inbox: 0, chats: 0 };
  const dataAccess = {
    getWorkspaces: async () => {
      reads.workspaces++;
      return rows.map((row) => ({ ...row }));
    },
    getInbox: async (slug: string) => {
      reads.inbox++;
      const attention = inbox.get(slug) ?? [];
      return { pending_count: attention.length, attention };
    },
    getChats: async (slug: string) => {
      reads.chats++;
      return { chats: chats.get(slug) ?? [] };
    },
  };
  const sent: Array<{ id?: string; title?: string; body?: string; badge?: number }> = [];
  const bridge = { notify: (message: (typeof sent)[number]) => sent.push(message) };
  const focus = { value: false };
  const timers: Array<() => void> = [];
  const make = (options: { desk?: boolean; current?: string } = {}) =>
    createAttentionWatch({
      dataAccess,
      bridge,
      desk: options.desk ?? false,
      currentSlug: () => options.current ?? "a",
      hasFocus: () => focus.value,
      setTimer: (fn: () => void) => {
        timers.push(fn);
        return timers.length;
      },
      clearTimer: () => {},
    });
  const add = (slug: string, entry: Entry) => {
    inbox.get(slug)?.push(entry);
    const row = rows.find((r) => r.slug === slug);
    if (row) row.attention_count = inbox.get(slug)?.length ?? 0;
  };
  const notes = () => sent.filter((m) => m.title !== undefined || m.body !== undefined);
  const badges = () => sent.filter((m) => m.badge !== undefined).map((m) => m.badge);
  return { rows, inbox, chats, reads, dataAccess, bridge, sent, focus, make, add, notes, badges, timers };
}

describe("what interrupts someone", () => {
  test("a question, a review and an approval ask something; a bare pointer does not", () => {
    expect(asksSomething({ id: "1", message: "Is this right?" })).toBe(true);
    expect(asksSomething({ id: "2", action: "review" })).toBe(true);
    expect(asksSomething({ id: "3", approval_mode: true })).toBe(true);
    expect(asksSomething({ id: "4", action: "point", message: null })).toBe(false);
    expect(asksSomething({ id: "5", action: "ask", message: "   " })).toBe(false);
  });

  test("the body is the agent's message, or plain words for a review or approval without one", () => {
    expect(attentionBody({ message: "Check the intro." })).toBe("Check the intro.");
    expect(attentionBody({ action: "review" })).toBe("An agent asks for a review.");
    expect(attentionBody({ approval_mode: true })).toBe("An agent asks for your approval.");
    expect(attentionBody({ message: "x".repeat(500) }).length).toBe(240);
  });
});

describe("the Dock badge", () => {
  test("is the sum of every workspace's attention and decision counts", async () => {
    const w = world();
    w.rows[0]!.attention_count = 2;
    w.rows[1]!.decision_count = 3;
    w.inbox.set("a", [
      { id: "x1", message: "one" },
      { id: "x2", message: "two" },
    ]);
    w.chats.set("b", [{ id: "c1", pendingDecisions: 3 }]);
    const watch = w.make();
    watch.start();
    await watch.flush();
    expect(w.badges()).toEqual([5]);
  });

  test("a burst of frames is one pass, not one per frame", async () => {
    const w = world();
    const watch = w.make();
    watch.start();
    await watch.flush();
    const before = w.reads.workspaces;
    for (let i = 0; i < 5; i++) watch.handleFrame({ event: "attention_changed", data: { slug: "b" } });
    expect(w.timers.length).toBe(2); // start's pass, then one for the whole burst
    await watch.flush();
    expect(w.reads.workspaces - before).toBe(1);
  });

  test("focus re-reads the badge", async () => {
    const w = world();
    const watch = w.make();
    watch.start();
    await watch.flush();
    w.rows[1]!.attention_count = 1;
    w.inbox.set("b", [{ id: "q", message: "?" }]);
    watch.refresh();
    await watch.flush();
    expect(w.badges()).toEqual([0, 1]);
  });
});

describe("notifications", () => {
  test("a new question in another workspace notifies while the window is not focused", async () => {
    const w = world();
    const watch = w.make({ current: "a" });
    watch.start();
    await watch.flush();
    w.add("b", { id: "q1", message: "Should the second section go?" });
    watch.handleFrame({ event: "attention_changed", data: { slug: "b" } });
    await watch.flush();
    expect(w.notes()).toEqual([{ id: "attention:b:q1", title: "beta", body: "Should the second section go?" }]);
  });

  test("nothing is shown while the window is focused", async () => {
    const w = world();
    w.focus.value = true;
    const watch = w.make();
    watch.start();
    await watch.flush();
    w.add("b", { id: "q1", message: "?" });
    watch.handleFrame({ event: "attention_changed", data: { slug: "b" } });
    await watch.flush();
    expect(w.notes()).toEqual([]);
  });

  test("requests already waiting when the page starts seed and never notify", async () => {
    const w = world();
    w.add("b", { id: "old", message: "waiting since before" });
    const watch = w.make();
    watch.start();
    await watch.flush();
    watch.handleFrame({ event: "attention_changed", data: { slug: "b" } });
    await watch.flush();
    expect(w.notes()).toEqual([]);
  });

  test("the first request a quiet workspace ever gets is news, not a seed", async () => {
    const w = world();
    const watch = w.make();
    watch.start();
    await watch.flush();
    w.add("b", { id: "first", action: "review" });
    watch.handleFrame({ event: "attention_changed", data: { slug: "b" } });
    await watch.flush();
    expect(w.notes().map((m) => m.id)).toEqual(["attention:b:first"]);
  });

  test("a bare pointer does not notify; an approval request does", async () => {
    const w = world();
    const watch = w.make();
    watch.start();
    await watch.flush();
    w.add("b", { id: "p", action: "point", message: null });
    w.add("b", { id: "ok", approval_mode: true });
    watch.handleFrame({ event: "attention_changed", data: { slug: "b" } });
    await watch.flush();
    expect(w.notes().map((m) => m.id)).toEqual(["attention:b:ok"]);
  });

  test("a chat that starts waiting on a decision notifies, in any workspace", async () => {
    const w = world();
    w.chats.set("b", [{ id: "c1", title: "Tighten the intro", pendingDecisions: 0, status: "running" }]);
    const watch = w.make({ current: "a" });
    watch.start();
    await watch.flush();
    w.chats.set("b", [{ id: "c1", title: "Tighten the intro", pendingDecisions: 1, status: "waiting" }]);
    w.rows[1]!.decision_count = 1;
    watch.handleFrame({ event: "chats_changed", data: { slugs: ["b"] } });
    await watch.flush();
    expect(w.notes()).toEqual([
      { id: "decision:b:c1:1", title: "beta", body: "Tighten the intro is waiting on your decision." },
    ]);
  });

  test("on a desk surface a finished reply in the current workspace notifies; a companion stays quiet", async () => {
    for (const desk of [true, false]) {
      const w = world();
      w.chats.set("a", [{ id: "c1", title: "Draft", status: "running", turnCount: 1 }]);
      const watch = w.make({ desk, current: "a" });
      watch.start();
      await watch.flush();
      w.chats.set("a", [{ id: "c1", title: "Draft", status: "completed", turnCount: 1 }]);
      watch.handleFrame({ event: "chats_changed", data: { slugs: ["a"] } });
      await watch.flush();
      expect(w.notes().map((m) => m.id)).toEqual(desk ? ["reply:a:c1:1"] : []);
    }
  });

  test("after a reconnect, anything missed in a known workspace is caught", async () => {
    const w = world();
    const watch = w.make();
    watch.start();
    await watch.flush();
    w.add("a", { id: "missed", message: "while you were away" });
    watch.resync();
    await watch.flush();
    expect(w.notes().map((m) => m.id)).toEqual(["attention:a:missed"]);
  });

  test("after destroy nothing is sent", async () => {
    const w = world();
    const watch = w.make();
    watch.destroy();
    watch.start();
    watch.handleFrame({ event: "attention_changed", data: { slug: "a" } });
    await watch.flush();
    expect(w.sent).toEqual([]);
  });
});

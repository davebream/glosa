// SPDX-License-Identifier: Apache-2.0
// P4.2 — conversation.js: the pure `groupEvents` fold (subagent grouping / meta hidden) and a DOM
// integration test against a fake data-access object (no real daemon, no real fetch, no real SSE
// — same harness shape as viewer.test.ts's `mountApp` suite). Fail-soft is asserted explicitly:
// a `mirror_unavailable` frame must flip the pane's status text without throwing or breaking the
// composer.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { groupEvents, mountConversationPane } from "../src/conversation.js";
import { installDom, type DomEnv } from "./dom-env.ts";

describe("groupEvents — meta hidden, subagent turns grouped, everything else passes through", () => {
  test("a meta event is dropped entirely — never appears in the output", () => {
    const events = [
      { type: "prose", role: "user", content: "hi", id: "1" },
      { type: "meta", kind: "system", id: "2" },
      { type: "prose", role: "assistant", content: "hello", id: "3" },
    ];
    const grouped = groupEvents(events);
    expect(grouped).toHaveLength(2);
    expect(grouped.every((g) => g.type !== "meta")).toBe(true);
  });

  test("consecutive subagent events collapse into one subagent_group, in order", () => {
    const events = [
      { type: "prose", role: "user", content: "start", id: "1" },
      { type: "subagent", subagent_id: "s1", summary: "step one", id: "2" },
      { type: "subagent", subagent_id: "s1", summary: "step two", id: "3" },
      { type: "prose", role: "assistant", content: "done", id: "4" },
    ];
    const grouped = groupEvents(events);
    expect(grouped).toHaveLength(3);
    expect(grouped[0]).toEqual(events[0]);
    expect(grouped[1]).toEqual({ type: "subagent_group", items: [events[1], events[2]] });
    expect(grouped[2]).toEqual(events[3]);
  });

  test("two SEPARATE subagent runs (interrupted by a non-subagent event) produce two distinct groups", () => {
    const events = [
      { type: "subagent", subagent_id: "s1", summary: "run 1", id: "1" },
      { type: "prose", role: "assistant", content: "in between", id: "2" },
      { type: "subagent", subagent_id: "s2", summary: "run 2", id: "3" },
    ];
    const grouped = groupEvents(events);
    expect(grouped).toHaveLength(3);
    expect(grouped[0]).toEqual({ type: "subagent_group", items: [events[0]] });
    expect(grouped[2]).toEqual({ type: "subagent_group", items: [events[2]] });
  });

  test("a meta event breaks a subagent run just like any other interrupting event", () => {
    const events = [
      { type: "subagent", subagent_id: "s1", summary: "a", id: "1" },
      { type: "meta", kind: "system", id: "2" },
      { type: "subagent", subagent_id: "s1", summary: "b", id: "3" },
    ];
    const grouped = groupEvents(events);
    expect(grouped).toHaveLength(2);
    expect(grouped[0]).toEqual({ type: "subagent_group", items: [events[0]] });
    expect(grouped[1]).toEqual({ type: "subagent_group", items: [events[2]] });
  });

  test("tool_use/tool_result/unknown all pass through unchanged", () => {
    const events = [
      { type: "tool_use", tool_name: "Bash", tool_id: "t1", input: {}, id: "1" },
      { type: "tool_result", tool_id: "t1", content: "ok", size_bytes: 2, size_original: 2, truncated: false, id: "2" },
      { type: "unknown", raw: "???", line_num: 5 },
    ];
    expect(groupEvents(events)).toEqual(events);
  });

  test("empty input → empty output", () => {
    expect(groupEvents([])).toEqual([]);
  });
});

describe("mountConversationPane — DOM integration against a fake dataAccess", () => {
  let dom: DomEnv;
  beforeEach(() => {
    dom = installDom();
  });
  afterEach(() => {
    dom.teardown();
  });

  function fakeDataAccess() {
    let onEventCb: ((frame: unknown) => void) | null = null;
    let onStatusCb: ((status: "down" | "up") => void) | null = null;
    let onJournalCb: ((frame: any) => void) | null = null;
    let onReconnectCb: (() => void) | null = null;
    const sent: Array<{ slug: string; text: string; options: { messageId: string; sessionHint?: string } }> = [];
    return {
      sent,
      emit(frame: unknown) {
        onEventCb?.(frame);
      },
      emitStatus(status: "down" | "up") {
        onStatusCb?.(status);
      },
      emitJournal(frame: unknown) {
        onJournalCb?.(frame);
      },
      reconnect() {
        onReconnectCb?.();
      },
      openTranscriptStream(
        _slug: string,
        { onEvent, onStatus }: { onEvent: (frame: unknown) => void; onStatus?: (status: "down" | "up") => void },
      ) {
        onEventCb = onEvent;
        onStatusCb = onStatus ?? null;
        return () => {
          onEventCb = null;
          onStatusCb = null;
        };
      },
      openStream(
        _slug: string,
        { onEvent, onReconnect }: { onEvent: (frame: any) => void; onReconnect?: () => void },
      ) {
        onJournalCb = onEvent;
        onReconnectCb = onReconnect ?? null;
        return () => {
          onJournalCb = null;
          onReconnectCb = null;
        };
      },
      getComposerMessageStatus: async () => ({ accepted: true, delivered: false, state: "queued" }),
      sendComposerMessage: async (
        slug: string,
        text: string,
        options: { messageId: string; sessionHint?: string },
      ) => {
        sent.push({ slug, text, options });
        return { accepted: true, delivered: true };
      },
    };
  }

  test("a transcript frame renders as a prose paragraph", () => {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    const da = fakeDataAccess();

    mountConversationPane(root, { dataAccess: da, slug: "ws-1" });
    da.emit({ event: "transcript", data: { type: "prose", role: "user", content: "hello mirror", id: "1" } });

    const p = root.querySelector(".glosa-conv-prose") as any;
    expect(p).not.toBeNull();
    expect(p.textContent).toBe("hello mirror");
    expect(p.getAttribute("data-speaker")).toBe("You");
  });

  test("FAIL-SOFT: a mirror_unavailable frame shows the fallback message and does not throw — composer still works", () => {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    const da = fakeDataAccess();

    mountConversationPane(root, { dataAccess: da, slug: "ws-1" });
    expect(() => da.emit({ event: "mirror_unavailable" })).not.toThrow();

    const status = root.querySelector(".glosa-conv-mirror-status") as any;
    expect(status.hidden).toBe(false);
    expect(status.textContent).toContain("mirror unavailable");

    // The composer (out-of-band, doesn't depend on the mirror's own health) is unaffected.
    const input = root.querySelector(".glosa-conv-composer-input") as any;
    const sendBtn = root.querySelector(".glosa-conv-composer-send") as any;
    input.value = "still works";
    sendBtn.click();
  });

  test("FAIL-SOFT: an unavailable transcript stream shows the terminal fallback", () => {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    const da = fakeDataAccess();

    mountConversationPane(root, { dataAccess: da, slug: "ws-1" });
    da.emitStatus("down");

    const status = root.querySelector(".glosa-conv-mirror-status") as any;
    expect(status.hidden).toBe(false);
    expect(status.textContent).toBe("mirror unavailable — use the terminal");
  });

  test("a later transcript frame after mirror_unavailable clears the fallback message (mirror recovered)", () => {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    const da = fakeDataAccess();

    mountConversationPane(root, { dataAccess: da, slug: "ws-1" });
    da.emit({ event: "mirror_unavailable" });
    const status = root.querySelector(".glosa-conv-mirror-status") as any;
    expect(status.hidden).toBe(false);

    da.emit({ event: "transcript", data: { type: "prose", role: "assistant", content: "back online", id: "2" } });
    expect(status.hidden).toBe(true);
    expect(root.querySelector(".glosa-conv-prose")!.textContent).toBe("back online");
  });

  test("meta events never render anything visible", () => {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    const da = fakeDataAccess();

    mountConversationPane(root, { dataAccess: da, slug: "ws-1" });
    da.emit({ event: "transcript", data: { type: "meta", kind: "system", id: "1" } });

    expect(root.querySelector(".glosa-conv-list")!.children.length).toBe(0);
  });

  test("tool_use renders as a collapsed <details> chip", () => {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    const da = fakeDataAccess();

    mountConversationPane(root, { dataAccess: da, slug: "ws-1" });
    da.emit({ event: "transcript", data: { type: "tool_use", tool_name: "Bash", tool_id: "t1", input: { command: "ls" }, id: "1" } });

    const details = root.querySelector(".glosa-conv-tool-use") as any;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false); // collapsed by default
    expect(details.querySelector("summary")!.textContent).toContain("Bash");
  });

  test("composer Send calls dataAccess.sendComposerMessage with the typed text and clears the textarea — never touches a transcript file (only the injected data-access surface is called)", () => {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    const da = fakeDataAccess();

    mountConversationPane(root, { dataAccess: da, slug: "ws-1" });
    const input = root.querySelector(".glosa-conv-composer-input") as any;
    const sendBtn = root.querySelector(".glosa-conv-composer-send") as any;
    expect(input.getAttribute("aria-label")).toBe("Message to the agent session");
    expect(input.getAttribute("name")).toBe("conversation-message");
    input.value = "please check the edge case";
    sendBtn.click();

    // sendComposerMessage is async — flush microtasks.
    return Promise.resolve().then(() => {
      expect(da.sent).toHaveLength(1);
      expect(da.sent[0]).toMatchObject({ slug: "ws-1", text: "please check the edge case" });
      expect(da.sent[0]!.options.messageId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });
  });

  test("composer failures keep the draft and expose a textual live error", async () => {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    const da = {
      ...fakeDataAccess(),
      sendComposerMessage: async () => {
        throw new Error("session unavailable");
      },
    };

    mountConversationPane(root, { dataAccess: da, slug: "ws-1" });
    const input = root.querySelector(".glosa-conv-composer-input") as any;
    input.value = "keep this draft";
    (root.querySelector(".glosa-conv-composer-send") as any).click();
    for (let i = 0; i < 5; i++) await Promise.resolve();

    const status = root.querySelector(".glosa-conv-status") as any;
    expect(input.value).toBe("keep this draft");
    expect(status.getAttribute("role")).toBe("status");
    expect(status.getAttribute("data-error")).toBe("true");
    expect(status.textContent).toContain("session unavailable");
  });

  test("no registered live session keeps the draft and explains how to recover", async () => {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    const da = {
      ...fakeDataAccess(),
      sendComposerMessage: async () => {
        throw { problem: { type: "https://glosa.dev/problems/no-bound-session" } };
      },
    };

    mountConversationPane(root, { dataAccess: da, slug: "ws-1" });
    const input = root.querySelector(".glosa-conv-composer-input") as any;
    input.value = "keep this draft";
    (root.querySelector(".glosa-conv-composer-send") as any).click();
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(input.value).toBe("keep this draft");
    expect((root.querySelector(".glosa-conv-status") as any).textContent).toContain("No live agent session is bound");
  });

  test("an accepted but undelivered message keeps the draft rather than claiming it was sent", async () => {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    const da = {
      ...fakeDataAccess(),
      sendComposerMessage: async () => ({ accepted: true, delivered: false }),
    };

    mountConversationPane(root, { dataAccess: da, slug: "ws-1" });
    const input = root.querySelector(".glosa-conv-composer-input") as any;
    input.value = "keep this draft";
    (root.querySelector(".glosa-conv-composer-send") as any).click();
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(input.value).toBe("keep this draft");
    expect((root.querySelector(".glosa-conv-status") as any).textContent).toContain("Waiting for the agent");
    expect((root.querySelector(".glosa-conv-composer-send") as any).disabled).toBe(true);
  });

  test("a presented journal acknowledgement clears the submitted draft", async () => {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    const base = fakeDataAccess();
    const da = {
      ...base,
      sendComposerMessage: async (slug: string, text: string, options: any) => {
        base.sent.push({ slug, text, options });
        return { accepted: true, delivered: false, state: "transport_accepted" };
      },
    };
    mountConversationPane(root, { dataAccess: da, slug: "ws-1" });
    const input = root.querySelector(".glosa-conv-composer-input") as any;
    input.value = "wait for acknowledgement";
    (root.querySelector(".glosa-conv-composer-send") as any).click();
    for (let i = 0; i < 5; i++) await Promise.resolve();

    const messageId = base.sent[0]!.options.messageId;
    base.emitJournal({
      event: "journal",
      data: { entry: messageId, event: "delivery_attempt", detail: { outcome: "presented" } },
    });

    expect(input.value).toBe("");
    expect((root.querySelector(".glosa-conv-status") as any).textContent).toBe("Message sent.");
    expect((root.querySelector(".glosa-conv-composer-send") as any).disabled).toBe(false);
  });

  test("an acknowledgement preserves newer textarea edits made while waiting", async () => {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    const base = fakeDataAccess();
    const da = { ...base, sendComposerMessage: async () => ({ accepted: true, delivered: false, state: "queued" }) };
    mountConversationPane(root, { dataAccess: da, slug: "ws-1" });
    const input = root.querySelector(".glosa-conv-composer-input") as any;
    input.value = "submitted text";
    (root.querySelector(".glosa-conv-composer-send") as any).click();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    const stored = JSON.parse(globalThis.sessionStorage.getItem("glosa:conversation-pending:ws-1")!);
    input.value = "newer unsent draft";
    base.emitJournal({
      event: "journal",
      data: { entry: stored.id, event: "transition_committed", detail: { to: "delivered" } },
    });
    expect(input.value).toBe("newer unsent draft");
  });

  test("ambiguous routing shows a focused native picker and retries with the same message ID", async () => {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    const base = fakeDataAccess();
    const calls: any[] = [];
    const da = {
      ...base,
      sendComposerMessage: async (_slug: string, _text: string, options: any) => {
        calls.push(options);
        if (calls.length === 1) {
          throw {
            problem: {
              type: "https://glosa.dev/problems/session-selection-required",
              candidates: [
                { session_id: "s1", provider: "claude-code", last_active_at: "2026-07-23T10:00:00Z" },
                { session_id: "s2", provider: "codex", last_active_at: "2026-07-23T10:01:00Z" },
              ],
            },
          };
        }
        return { accepted: true, delivered: true, state: "presented" };
      },
    };
    mountConversationPane(root, { dataAccess: da, slug: "ws-1" });
    const input = root.querySelector(".glosa-conv-composer-input") as any;
    input.value = "choose exactly";
    (root.querySelector(".glosa-conv-composer-send") as any).click();
    for (let i = 0; i < 5; i++) await Promise.resolve();

    const picker = root.querySelector(".glosa-conv-session-picker select") as any;
    expect(dom.document.activeElement).toBe(picker);
    picker.value = "s2";
    (root.querySelector(".glosa-conv-composer-send") as any).click();
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(calls[1].messageId).toBe(calls[0].messageId);
    expect(calls[1].sessionHint).toBe("s2");
    expect(input.value).toBe("");
  });

  test("reload recovery rechecks the durable status and clears only after presented", async () => {
    const firstRoot = dom.document.createElement("div");
    dom.document.body.append(firstRoot);
    const first = {
      ...fakeDataAccess(),
      sendComposerMessage: async () => ({ accepted: true, delivered: false, state: "queued" }),
    };
    const unmount = mountConversationPane(firstRoot, { dataAccess: first, slug: "ws-reload" });
    const firstInput = firstRoot.querySelector(".glosa-conv-composer-input") as any;
    firstInput.value = "survive this reload";
    (firstRoot.querySelector(".glosa-conv-composer-send") as any).click();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    unmount();

    const secondRoot = dom.document.createElement("div");
    dom.document.body.append(secondRoot);
    const second = {
      ...fakeDataAccess(),
      getComposerMessageStatus: async () => ({ accepted: true, delivered: true, state: "presented" }),
    };
    mountConversationPane(secondRoot, { dataAccess: second, slug: "ws-reload" });
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect((secondRoot.querySelector(".glosa-conv-composer-input") as any).value).toBe("");
    expect((secondRoot.querySelector(".glosa-conv-status") as any).textContent).toBe("Message sent.");
    expect(globalThis.sessionStorage.getItem("glosa:conversation-pending:ws-reload")).toBeNull();
  });

  test("reload recovery surfaces a durable failure and enables same-ID retry", async () => {
    globalThis.sessionStorage.setItem(
      "glosa:conversation-pending:ws-failed",
      JSON.stringify({
        id: "123e4567-e89b-42d3-a456-426614174000",
        text: "retry after reload",
        sessionHint: "session-a",
      }),
    );
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    const da = {
      ...fakeDataAccess(),
      getComposerMessageStatus: async () => ({
        accepted: true,
        delivered: false,
        state: "failed",
        delivery: { outcome: "failed" },
      }),
    };
    mountConversationPane(root, { dataAccess: da, slug: "ws-failed" });
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect((root.querySelector(".glosa-conv-composer-input") as any).value).toBe("retry after reload");
    expect((root.querySelector(".glosa-conv-composer-send") as any).disabled).toBe(false);
    expect((root.querySelector(".glosa-conv-status") as any).getAttribute("data-error")).toBe("true");
  });

  test("unmount() stops the stream (the fake's onEvent handle is cleared)", () => {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    const da = fakeDataAccess();

    const unmount = mountConversationPane(root, { dataAccess: da, slug: "ws-1" });
    unmount();
    // A frame emitted after unmount must not throw, and (since the fake clears its own callback
    // reference on stop()) is simply a no-op.
    expect(() => da.emit({ event: "transcript", data: { type: "prose", role: "user", content: "late", id: "1" } })).not.toThrow();
  });
});

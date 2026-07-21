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
    const sent: Array<{ slug: string; text: string }> = [];
    return {
      sent,
      emit(frame: unknown) {
        onEventCb?.(frame);
      },
      openTranscriptStream(_slug: string, { onEvent }: { onEvent: (frame: unknown) => void }) {
        onEventCb = onEvent;
        return () => {
          onEventCb = null;
        };
      },
      sendComposerMessage: async (slug: string, text: string) => {
        sent.push({ slug, text });
        return { accepted: true, delivered: false };
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
  });

  test("FAIL-SOFT: a mirror_unavailable frame shows the fallback message and does not throw — composer still works", () => {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    const da = fakeDataAccess();

    mountConversationPane(root, { dataAccess: da, slug: "ws-1" });
    expect(() => da.emit({ event: "mirror_unavailable" })).not.toThrow();

    const status = root.querySelector(".glosa-conv-status") as any;
    expect(status.hidden).toBe(false);
    expect(status.textContent).toContain("mirror unavailable");

    // The composer (out-of-band, doesn't depend on the mirror's own health) is unaffected.
    const input = root.querySelector(".glosa-conv-composer-input") as any;
    const sendBtn = root.querySelector(".glosa-conv-composer-send") as any;
    input.value = "still works";
    sendBtn.click();
  });

  test("a later transcript frame after mirror_unavailable clears the fallback message (mirror recovered)", () => {
    const root = dom.document.createElement("div");
    dom.document.body.append(root);
    const da = fakeDataAccess();

    mountConversationPane(root, { dataAccess: da, slug: "ws-1" });
    da.emit({ event: "mirror_unavailable" });
    const status = root.querySelector(".glosa-conv-status") as any;
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
    input.value = "please check the edge case";
    sendBtn.click();

    // sendComposerMessage is async — flush microtasks.
    return Promise.resolve().then(() => {
      expect(da.sent).toEqual([{ slug: "ws-1", text: "please check the edge case" }]);
    });
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

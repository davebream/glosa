// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, test } from "bun:test";
import MarkdownIt from "markdown-it";
import { createSafeChatRenderer } from "../src/chat-markdown.js";
import { createChatPane, applyChatEvent } from "../src/chat-pane.js";
import { type DomEnv, installDom } from "./dom-env.ts";
let dom: DomEnv;
beforeEach(() => {
  dom = installDom();
});
afterEach(() => dom.teardown());
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
function fixture() {
  const state = {
    id: "chat",
    profileId: "a",
    provider: "claude-code",
    title: "Draft review",
    revision: 1,
    configRevision: 1,
    draftRevision: 0,
    draft: "",
    draftAttachments: [],
    archived: false,
    settings: { model: "model", effort: "high", permissionMode: "default" },
    turns: [] as any[],
    content: [],
    decisions: [],
  };
  let stream: any;
  const saves: any[] = [],
    sends: any[] = [],
    newChats: any[] = [];
  const catalog = {
    available: true,
    profiles: [
      { id: "a", provider: "claude-code", enabled: true, label: "Personal" },
      { id: "b", provider: "codex", enabled: true, label: "Work" },
    ],
    capabilities: {
      a: { models: [{ id: "model", name: "Model", efforts: ["high"] }] },
      b: { models: [{ id: "codex-model", name: "Codex model", efforts: ["medium"] }] },
    },
  };
  const dataAccess: any = {
    getAgentStatus: async () => structuredClone(catalog),
    getChat: async () => structuredClone(state),
    openChatStream: (_s: string, _id: string, callbacks: any) => {
      stream = callbacks;
      return () => {};
    },
    saveChatDraft: async (_s: string, _id: string, input: any) => {
      saves.push(input);
      if (input.revision !== state.draftRevision) throw new Error("Draft changed in another browser");
      state.draft = input.text;
      state.draftRevision++;
      return structuredClone(state);
    },
    sendChatTurn: async (_s: string, _id: string, input: any) => {
      sends.push(input);
      throw new Error("Connection lost");
    },
  };
  const host = document.createElement("div");
  document.body.append(host);
  const pane = createChatPane(host, {
    dataAccess,
    slug: "ws",
    chatId: "chat",
    onChange() {},
    onNewChat: (...args: any[]) => newChats.push(args),
    onSettings() {},
  });
  return {
    state,
    host,
    pane,
    saves,
    sends,
    newChats,
    status: (value: string) => stream.onStatus(value),
    snapshot: () => stream.onEvent({ event: "chat_snapshot", data: structuredClone(state) }),
  };
}

test("another browser's draft does not overwrite or authorize overwriting an unsaved local draft", async () => {
  const f = fixture();
  await f.pane.ready;
  const draft = f.host.querySelector("textarea")!;
  draft.value = "My local draft";
  draft.dispatchEvent(new Event("input", { bubbles: true }));
  f.state.draft = "Other browser";
  f.state.draftRevision = 1;
  f.snapshot();
  expect(draft.value).toBe("My local draft");
  (f.host.querySelector('[aria-label="Send message"]') as HTMLButtonElement).click();
  await flush();
  expect(f.saves[0].revision).toBe(0);
  expect(f.sends).toHaveLength(0);
  expect(draft.value).toBe("My local draft");
  f.pane.destroy();
});

test("ambiguous send retries its original durable request and does not duplicate or lose the draft", async () => {
  const f = fixture();
  await f.pane.ready;
  const draft = f.host.querySelector("textarea")!;
  draft.value = "Please review";
  draft.dispatchEvent(new Event("input", { bubbles: true }));
  const send = f.host.querySelector('[aria-label="Send message"]') as HTMLButtonElement;
  send.click();
  await flush();
  send.click();
  await flush();
  expect(f.sends).toHaveLength(2);
  expect(f.sends[1]).toEqual(f.sends[0]);
  expect(draft.value).toBe("Please review");
  f.pane.destroy();
});

test("switching provider after a submitted turn requests a fresh chat and leaves history in place", async () => {
  const f = fixture();
  f.state.turns.push({ id: "turn", text: "Hello", status: "completed" });
  await f.pane.ready;
  const select = f.host.querySelector('[aria-label="Agent account"]') as HTMLSelectElement;
  select.value = "b";
  select.dispatchEvent(new Event("change"));
  await flush();
  expect(f.newChats).toHaveLength(1);
  expect(f.newChats[0][0].provider).toBe("codex");
  expect(f.host.textContent).toContain("Hello");
  expect(f.state.provider).toBe("claude-code");
  f.pane.destroy();
});

test("a missing stream record requires a snapshot instead of applying an incomplete projection", () => {
  const f = fixture();
  expect(applyChatEvent(f.state, { seq: 3, data: { type: "usage", value: {} } })).toBeNull();
  f.pane.destroy();
});

test("chat Markdown renders code and lists but cannot execute HTML or fetch remote images", () => {
  const render = createSafeChatRenderer(MarkdownIt);
  const html = render(
    '<img src="https://outside.test/beacon" onerror="alert(1)">\n\n![secret](https://outside.test/beacon)\n\n[x](javascript:alert(1))\n\n- **One**\n- `two`',
  );
  expect(html).not.toContain("<img");
  expect(html).not.toContain('href="javascript:');
  expect(html).toContain("<strong>One</strong>");
  expect(html).toContain("<code>two</code>");
  expect(render("[Docs](https://example.test)")).toContain('rel="noopener noreferrer"');
});

test("native login links keep provider domains strict and require a visible HTTPS destination for MCP", async () => {
  const { validLoginUrl } = await import("../src/agent-login.js");
  expect(validLoginUrl("https://auth.openai.com/authorize?state=x", ["auth.openai.com"])).toContain("auth.openai.com");
  expect(validLoginUrl("https://auth.openai.com.evil.test/login", ["auth.openai.com"])).toBeNull();
  expect(validLoginUrl("https://github.com/login/oauth/authorize", ["claude.ai"], true)).toContain("github.com");
  for (const value of [
    "javascript:alert(1)",
    "http://github.com/login",
    "https://user:secret@github.com/login",
    "https://github.com:8443/login",
  ])
    expect(validLoginUrl(value, [], true)).toBeNull();
});

test("streamed snapshots keep model option nodes and recovery clears only its own status", async () => {
  const f = fixture();
  await f.pane.ready;
  const selects = [...f.host.querySelectorAll("select")];
  const options = selects.map((select) => [...select.children]);
  selects[1]!.focus();
  f.state.revision++;
  f.snapshot();
  for (const [index, select] of selects.entries())
    for (const [optionIndex, option] of [...select.children].entries())
      expect(option).toBe(options[index]![optionIndex]!);
  expect(document.activeElement).toBe(selects[1]!);
  f.status("down");
  expect(f.host.textContent).toContain("Reconnecting");
  f.status("up");
  expect(f.host.textContent).not.toContain("Reconnecting");
  const notice = f.host.querySelector(".glosa-chat-status")!;
  notice.textContent = "Draft changed in another browser";
  f.status("up");
  expect(notice.textContent).toBe("Draft changed in another browser");
  f.pane.destroy();
});

// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import MarkdownIt from "markdown-it";
import { createSafeChatRenderer } from "../src/chat-markdown.js";
import { createChatPane, applyChatEvent } from "../src/chat-pane.js";
import { modelChoices, modelPresentation } from "../src/agent-ui.js";
import { type DomEnv, installDom } from "./dom-env.ts";
let dom: DomEnv;
beforeEach(() => {
  dom = installDom();
});
afterEach(() => dom.teardown());
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

test("model labels retain provider-reported versions and never infer a version from an alias or context size", () => {
  for (const [model, label] of [
    [{ id: "sonnet", name: "Sonnet", resolvedModel: "claude-sonnet-5" }, "Sonnet 5"],
    [{ id: "default", name: "Default (recommended)", resolvedModel: "claude-opus-5-5" }, "Opus 5.5"],
    [{ id: "opus[1m]", name: "Opus (1M context)", resolvedModel: "claude-opus-5-5[1m]" }, "Opus 5.5"],
    [{ id: "claude-sonnet-4-5-20250929", name: "Sonnet" }, "Sonnet 4.5"],
    [{ id: "gpt-6-astra", name: "Astra" }, "GPT-6 Astra"],
    [{ id: "gpt-5.6-sol", name: "Sol" }, "GPT-5.6 Sol"],
    [{ id: "sonnet", name: "Sonnet" }, "Sonnet · version not reported"],
    [{ id: "opus[1m]", name: "Opus (1M context)" }, "Opus (1M context) · version not reported"],
    [{ id: "opus[1m]", name: "Opus 1M context" }, "Opus 1M context · version not reported"],
  ] as const)
    expect(modelPresentation(model).label).toBe(label);
  expect(modelPresentation({ id: "sonnet", name: "Sonnet", resolvedModel: "claude-sonnet-5" }).description).toContain(
    "At last model discovery, alias sonnet resolved to claude-sonnet-5",
  );
});

test("model choices collapse known aliases but preserve distinct versions, contexts and unresolved references", () => {
  const models = [
    { id: "default", name: "Default", resolvedModel: "claude-opus-5-5[1m]" },
    { id: "opus[1m]", name: "Opus 1M", resolvedModel: "claude-opus-5-5[1m]" },
    { id: "claude-opus-4-8", name: "Opus" },
    { id: "claude-opus-4-8[1m]", name: "Opus 1M" },
    { id: "unknown-a", name: "Opus" },
    { id: "unknown-b", name: "Opus" },
  ];
  expect(modelChoices(models, "default").map((choice) => [choice.id, choice.name])).toEqual([
    ["default", "Opus 5.5"],
    ["claude-opus-4-8", "Opus 4.8"],
    ["claude-opus-4-8[1m]", "Opus 4.8 · 1M"],
    ["unknown-a", "Opus · version not reported"],
    ["unknown-b", "Opus · version not reported"],
  ]);
  expect(modelChoices(models, "other")[0]!.id).toBe("opus[1m]");
  expect(modelChoices(models, "default")[0]!.description).toContain("Agent default at last model discovery");
  expect(modelChoices(models, "default")[0]!.description).toContain("1M context");
});

test("the model picker shows one resolved choice without rewriting a saved default or alias", async () => {
  for (const selected of ["default", "opus[1m]"]) {
    const f = fixture();
    await f.pane.ready;
    f.catalog.capabilities.a.models = [
      { id: "default", name: "Default", resolvedModel: "claude-opus-5-5[1m]", efforts: ["high", "low"] },
      { id: "opus[1m]", name: "Opus 1M", resolvedModel: "claude-opus-5-5[1m]", efforts: ["high", "low"] },
      { id: "haiku", name: "Haiku", resolvedModel: "claude-haiku-4-5-20251001", efforts: [] },
    ];
    f.state.settings.model = selected;
    const changes: string[] = [];
    f.dataAccess.changeChat = async (_slug: string, _id: string, input: { settings: typeof f.state.settings }) => {
      changes.push(input.settings.model);
      f.state.settings = input.settings;
      f.state.configRevision++;
    };
    [...f.host.querySelectorAll("button")].find((button) => button.textContent === "Refresh accounts")!.click();
    await flush();
    const select = f.host.querySelector('[aria-label="Model"]') as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual(["Opus 5.5", "Haiku 4.5"]);
    expect(select.value).toBe(selected);
    expect(changes).toEqual([]);
    const effort = f.host.querySelector('[aria-label="Effort"]') as HTMLSelectElement;
    effort.value = "low";
    effort.dispatchEvent(new Event("change"));
    await flush();
    expect(changes).toEqual([selected]);
    select.value = "haiku";
    select.dispatchEvent(new Event("change"));
    await flush();
    expect(select.options[0]!.value).toBe("opus[1m]");
    select.value = "opus[1m]";
    select.dispatchEvent(new Event("change"));
    await flush();
    expect(changes).toEqual([selected, "haiku", "opus[1m]"]);
    expect(select.selectedOptions[0]!.textContent).toBe("Opus 5.5");
    f.pane.destroy();
  }
});

test("an unresolved send remains retryable after the selected account is disabled", async () => {
  const f = fixture();
  await f.pane.ready;
  const draft = f.host.querySelector('[aria-label="Message"]') as HTMLTextAreaElement;
  draft.value = "Preserve this request";
  draft.dispatchEvent(new Event("input", { bubbles: true }));
  const send = f.host.querySelector('[aria-label="Send message"]') as HTMLButtonElement;
  send.click();
  await flush();
  f.catalog.profiles[0]!.enabled = false;
  const refresh = [...f.host.querySelectorAll("button")].find((button) => button.textContent === "Refresh accounts")!;
  refresh.click();
  await flush();
  expect(send.disabled).toBe(false);
  expect(send.textContent).toContain("Retry");
  send.click();
  await flush();
  expect(f.sends).toHaveLength(2);
  expect(f.sends[1]).toEqual(f.sends[0]);
  expect(draft.value).toBe("Preserve this request");
  f.pane.destroy();
});

test("missing model data blocks a fresh keyboard send and exposes local recovery", async () => {
  const f = fixture();
  await f.pane.ready;
  f.catalog.capabilities.a.models = [];
  [...f.host.querySelectorAll("button")].find((button) => button.textContent === "Refresh accounts")!.click();
  await flush();
  const draft = f.host.querySelector('[aria-label="Message"]') as HTMLTextAreaElement;
  draft.value = "Not ready yet";
  draft.dispatchEvent(new Event("input", { bubbles: true }));
  draft.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await flush();
  expect(f.sends).toHaveLength(0);
  expect((f.host.querySelector('[aria-label="Send message"]') as HTMLButtonElement).disabled).toBe(true);
  expect((f.host.querySelector(".glosa-chat-readiness") as HTMLElement).hidden).toBe(false);
  expect(f.host.querySelector(".glosa-chat-readiness")!.textContent).toContain("Load models");
  expect(draft.value).toBe("Not ready yet");
  f.pane.destroy();
});

test("a newer account choice wins over delayed model discovery and its stale error", async () => {
  for (const fails of [false, true]) {
    const f = fixture();
    await f.pane.ready;
    f.state.turns.push({ id: "started", text: "Keep this chat", status: "completed" });
    f.catalog.profiles.push({ id: "c", provider: "codex", enabled: true, label: "Third account" });
    (f.catalog.capabilities as any).c = { models: [{ id: "c-model", name: "Third model", efforts: ["high"] }] };
    f.catalog.capabilities.b.models = [];
    let resolve!: () => void;
    f.dataAccess.discoverAgentModels = () =>
      new Promise<void>((done, reject) => {
        resolve = () => {
          if (fails) reject(new Error("Stale account failure"));
          else {
            f.catalog.capabilities.b.models = [{ id: "b-model", name: "Second model", efforts: ["medium"] }];
            done();
          }
        };
      });
    [...f.host.querySelectorAll("button")].find((button) => button.textContent === "Refresh accounts")!.click();
    await flush();
    const account = f.host.querySelector('[aria-label="Agent account"]') as HTMLSelectElement;
    account.value = "b";
    account.dispatchEvent(new Event("change"));
    const draft = f.host.querySelector('[aria-label="Message"]') as HTMLTextAreaElement;
    draft.value = "Wait for the chosen account";
    draft.dispatchEvent(new Event("input", { bubbles: true }));
    draft.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();
    expect(f.sends).toHaveLength(0);
    [...f.host.querySelectorAll("button")].find((button) => button.textContent === "Send feedback")!.click();
    await flush();
    expect(f.feedbacks).toHaveLength(0);
    account.value = "c";
    account.dispatchEvent(new Event("change"));
    await flush();
    expect(f.newChats.map((args) => args[0].id)).toEqual(["c"]);
    resolve();
    await flush();
    expect(f.newChats.map((args) => args[0].id)).toEqual(["c"]);
    expect(f.host.querySelector(".glosa-chat-status")!.textContent).not.toContain("Stale account failure");
    f.pane.destroy();
  }
});
function fixture(options: { sourceChatId?: string } = {}) {
  const state = {
    id: "chat",
    profileId: "a",
    provider: "claude-code",
    title: "Draft review",
    revision: 1,
    configRevision: 1,
    draftRevision: 0,
    draft: "",
    draftAttachments: [] as { name: string; mime: string; hash: string; size: number }[],
    runtime: undefined as { state: string } | undefined,
    usage: undefined as Record<string, string | number | null> | undefined,
    archived: false,
    settings: { model: "model", effort: "high", permissionMode: "default" },
    turns: [] as any[],
    content: [],
    decisions: [],
  };
  let stream: any;
  const saves: any[] = [],
    sends: any[] = [],
    feedbacks: any[] = [],
    newChats: any[] = [];
  const catalog = {
    available: true,
    profiles: [
      { id: "a", provider: "claude-code", enabled: true, label: "Personal" },
      { id: "b", provider: "codex", enabled: true, label: "Work" },
    ],
    capabilities: {
      a: { models: [{ id: "model", name: "Model", resolvedModel: "claude-sonnet-5", efforts: ["high", "low"] }] },
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
      state.draftAttachments = input.attachments;
      state.draftRevision++;
      return structuredClone(state);
    },
    sendChatTurn: async (_s: string, _id: string, input: any) => {
      sends.push(input);
      throw new Error("Connection lost");
    },
    sendChatFeedback: async (_s: string, _id: string, input: any) => {
      feedbacks.push(input);
    },
  };
  const host = document.createElement("div");
  document.body.append(host);
  const pane = createChatPane(host, {
    dataAccess,
    slug: "ws",
    chatId: "chat",
    ...options,
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
    feedbacks,
    newChats,
    catalog,
    dataAccess,
    status: (value: string) => stream.onStatus(value),
    snapshot: () => stream.onEvent({ event: "chat_snapshot", data: structuredClone(state) }),
  };
}

test("usage separates conversation totals from account limits without inventing current context use", async () => {
  const f = fixture();
  await f.pane.ready;
  f.state.usage = {
    source: "Codex",
    scope: "native-thread",
    asOf: "2026-09-24T10:00:00Z",
    inputTokens: 250000,
    totalTokens: 300000,
    contextWindow: 200000,
    primaryUsedPercent: 12,
    primaryResetsAt: 1790244000,
    quotaSource: "Codex account",
    quotaAsOf: "2026-09-24T10:01:00Z",
  };
  f.state.revision++;
  f.snapshot();
  const usage = [...f.host.querySelectorAll("details")].find((row) => row.textContent!.includes("Usage & limits"))!;
  expect(usage.textContent).toContain("conversation totals");
  expect(usage.textContent).toContain("Context capacity (tokens): 200,000");
  expect(usage.textContent).toContain("Current context use: Not reported");
  expect(usage.textContent).toContain("Account limits");
  expect(usage.textContent).toContain("Primary limit used (%): 12");
  expect(usage.textContent).toContain("Source: Codex account");
  expect(usage.textContent).not.toContain("150%");
  expect(usage.textContent).not.toContain("primaryUsedPercent");
  f.pane.destroy();
});

test("draft transfer refreshes rejected revisions but retains its receipt after an ambiguous failure", async () => {
  for (const definitive of [true, false]) {
    const f = fixture({ sourceChatId: "source" });
    f.state.draft = "Occupied destination";
    await f.pane.ready;
    const getChat = f.dataAccess.getChat;
    f.dataAccess.getChat = (_slug: string, id: string) => (id === "source" ? { draftRevision: 7 } : getChat());
    const attempts: { requestId: string; targetRevision: number }[] = [];
    f.dataAccess.moveChatDraft = (_slug: string, _id: string, intent: any) => {
      attempts.push(structuredClone(intent));
      if (attempts.length === 1)
        throw Object.assign(new Error("Move failed"), {
          problem: definitive ? { type: "https://glosa/errors/stale-draft" } : undefined,
        });
      return { sourceCleared: true };
    };
    const move = [...f.host.querySelectorAll("button")].find(
      (button) => button.textContent === "Move previous draft here",
    )!;
    move.click();
    await flush();
    const draft = f.host.querySelector('[aria-label="Message"]') as HTMLTextAreaElement;
    draft.value = "";
    draft.dispatchEvent(new Event("input", { bubbles: true }));
    move.click();
    await flush();
    expect(attempts).toHaveLength(2);
    expect(attempts[1]!.targetRevision).toBe(definitive ? 1 : 0);
    expect(attempts[1]!.requestId === attempts[0]!.requestId).toBe(!definitive);
    expect(f.host.querySelector(".glosa-chat-status")!.textContent).toContain("Draft moved");
    f.pane.destroy();
  }
});

test("settings must finish saving before an ordinary or feedback turn can be sent", async () => {
  for (const fails of [false, true]) {
    const f = fixture();
    await f.pane.ready;
    const model = f.host.querySelector('[aria-label="Model"]') as HTMLSelectElement;
    expect(model.selectedOptions[0]!.textContent).toBe("Sonnet 5");
    expect(model.value).toBe("model");
    let finish!: () => void;
    f.dataAccess.changeChat = (_slug: string, _id: string, input: { settings: typeof f.state.settings }) =>
      new Promise<void>((resolve, reject) => {
        finish = () => {
          if (fails) reject(new Error("Settings could not be saved"));
          else {
            f.state.settings = input.settings;
            f.state.configRevision++;
            resolve();
          }
        };
      });
    const effort = f.host.querySelector('[aria-label="Effort"]') as HTMLSelectElement;
    effort.value = "low";
    effort.dispatchEvent(new Event("change"));
    const draft = f.host.querySelector('[aria-label="Message"]') as HTMLTextAreaElement;
    draft.value = "Use the selected effort";
    draft.dispatchEvent(new Event("input", { bubbles: true }));
    draft.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    [...f.host.querySelectorAll("button")].find((b) => b.textContent === "Send feedback")!.click();
    await flush();
    expect(f.sends).toHaveLength(0);
    expect(f.feedbacks).toHaveLength(0);
    expect((f.host.querySelector('[aria-label="Send message"]') as HTMLButtonElement).disabled).toBe(true);
    finish();
    await flush();
    expect(effort.value).toBe(fails ? "high" : "low");
    expect(f.state.settings.permissionMode).toBe("default");
    draft.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();
    expect(f.sends).toHaveLength(1);
    expect(f.sends[0].configRevision).toBe(fails ? 1 : 2);
    f.pane.destroy();
  }
});

test("uploads block sending and keep successful attachments when a later file fails", async () => {
  const f = fixture();
  await f.pane.ready;
  let finish!: () => void;
  const uploaded = { name: "brief.md", mime: "text/markdown", hash: "a".repeat(64), size: 5 };
  f.dataAccess.uploadChatAttachment = (_slug: string, _id: string, file: File) =>
    file.name === "brief.md"
      ? new Promise((resolve) => {
          finish = () => resolve(uploaded);
        })
      : Promise.reject(new Error("Second file is not supported"));
  const input = f.host.querySelector('[aria-label="Attach files"]') as HTMLInputElement;
  Object.defineProperty(input, "files", { value: [new File(["brief"], "brief.md"), new File(["bad"], "bad.bin")] });
  input.dispatchEvent(new Event("change"));
  const draft = f.host.querySelector('[aria-label="Message"]') as HTMLTextAreaElement;
  draft.value = "Read my attachment";
  draft.dispatchEvent(new Event("input", { bubbles: true }));
  draft.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await flush();
  expect(f.sends).toHaveLength(0);
  expect((f.host.querySelector('[aria-label="Send message"]') as HTMLButtonElement).disabled).toBe(true);
  finish();
  await flush();
  expect(f.host.querySelector('[aria-label="Remove brief.md"]')).not.toBeNull();
  expect(f.state.draftAttachments).toEqual([uploaded]);
  expect(f.host.querySelector(".glosa-chat-status")!.textContent).toContain("Second file");
  draft.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await flush();
  expect(f.sends[0].attachments).toEqual([uploaded]);
  f.pane.destroy();
});

test("a queued message can be cancelled without stopping the current turn", async () => {
  const f = fixture();
  await f.pane.ready;
  f.state.turns.push(
    { id: "active", text: "First", status: "running" },
    { id: "next", text: "Second", status: "queued" },
  );
  const stopped: string[] = [];
  f.dataAccess.stopChat = (_slug: string, _id: string, turnId: string) => {
    stopped.push(turnId);
    f.state.turns.find((t) => t.id === turnId)!.status = "cancelled";
  };
  f.state.revision++;
  f.snapshot();
  expect(f.host.querySelector(".glosa-chat-queue-notice")!.textContent).toContain("apply after it");
  expect((f.host.querySelector('[aria-label="Queue message"]') as HTMLButtonElement).disabled).toBe(true);
  [...f.host.querySelectorAll("button")].find((b) => b.textContent === "Cancel queued message")!.click();
  await flush();
  expect(stopped).toEqual(["next"]);
  expect(f.state.turns[0].status).toBe("running");
  expect((f.host.querySelector('[aria-label="Queue message"]') as HTMLButtonElement).disabled).toBe(false);
  f.pane.destroy();
});

test("uncertain native cleanup retains Retry stop after the turn has ended", async () => {
  const f = fixture();
  await f.pane.ready;
  f.state.turns.push({ id: "ended", text: "First", status: "outcome_unknown" });
  f.state.runtime = { state: "unknown" };
  let stops = 0;
  f.dataAccess.stopChat = () => {
    stops++;
    f.state.runtime = { state: "stopped" };
  };
  f.state.revision++;
  f.snapshot();
  const stop = [...f.host.querySelectorAll("button")].find((b) => b.textContent === "Retry stop")!;
  expect(stop.hidden).toBe(false);
  stop.click();
  await flush();
  expect(stops).toBe(1);
  expect(stop.hidden).toBe(true);
  f.pane.destroy();
});

test("held messages require Continue and cancelled messages can restore a draft without sending", async () => {
  const f = fixture();
  await f.pane.ready;
  f.state.turns.push({ id: "held", text: "Review this again", status: "held", attachments: [] });
  f.state.revision++;
  const resumed: string[] = [];
  f.dataAccess.resumeChatTurn = (_s: string, _c: string, id: string) => {
    resumed.push(id);
    f.state.turns[0].status = "running";
    f.state.revision++;
  };
  f.snapshot();
  expect(resumed).toHaveLength(0);
  [...f.host.querySelectorAll("button")].find((b) => b.textContent === "Continue held message")!.click();
  await flush();
  expect(resumed).toEqual(["held"]);
  f.state.turns[0].status = "cancelled";
  f.state.revision++;
  f.snapshot();
  [...f.host.querySelectorAll("button")].find((b) => b.textContent === "Use message as draft")!.click();
  await flush();
  expect((f.host.querySelector('[aria-label="Message"]') as HTMLTextAreaElement).value).toBe("Review this again");
  expect(f.saves.at(-1).text).toBe("Review this again");
  expect(f.sends).toHaveLength(0);
  f.pane.destroy();
});

test("closing during an upload requires an explicit choice and keeping the tab preserves the attachment", async () => {
  const f = fixture();
  await f.pane.ready;
  let finish!: () => void;
  const attachment = { name: "brief.md", mime: "text/markdown", hash: "a".repeat(64), size: 5 };
  f.dataAccess.uploadChatAttachment = () =>
    new Promise((resolve) => {
      finish = () => resolve(attachment);
    });
  const input = f.host.querySelector('[aria-label="Attach files"]') as HTMLInputElement;
  Object.defineProperty(input, "files", { value: [new File(["brief"], "brief.md")] });
  input.dispatchEvent(new Event("change"));
  const closing = f.pane.confirmClose();
  await flush();
  const dialog = document.querySelector("dialog")!;
  expect(dialog.textContent).toContain("unfinished changes");
  [...dialog.querySelectorAll("button")].find((b) => b.textContent === "Cancel")!.click();
  expect(await closing).toBe(false);
  finish();
  await flush();
  expect(f.state.draftAttachments).toEqual([attachment]);
  f.pane.destroy();
});

test("a delayed transcript preview cannot open an orphan dialog after its pane closes", async () => {
  const f = fixture({ sourceChatId: "source" });
  await f.pane.ready;
  let finish!: () => void;
  f.dataAccess.previewChatTranscript = () =>
    new Promise((resolve) => {
      finish = () => resolve({ title: "Prior chat", turnCount: 1, text: "Public text" });
    });
  [...f.host.querySelectorAll("button")].find((b) => b.textContent === "Attach previous conversation")!.click();
  await flush();
  f.pane.destroy();
  finish();
  await flush();
  expect(document.querySelector('[aria-label="Preview conversation attachment"]')).toBeNull();
});

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

test("runtime setup disables accounts, reports installation, rejects repeated clicks and unlocks on success", async () => {
  const { mountAgentSettings } = await import("../src/agent-settings.js");
  const host = document.createElement("div");
  document.body.append(host);
  let installed = false,
    installs = 0,
    creates = 0;
  let finish!: () => void;
  const pane = mountAgentSettings(host, {
    appearance: undefined,
    onChange: undefined,
    dataAccess: {
      getAgentStatus: async () => ({
        available: true,
        providers: [
          {
            id: "claude-code",
            name: "Claude Code",
            installed,
            qualified: true,
            installation:
              installs && !installed
                ? {
                    phase: "downloading",
                    startedAt: Date.now() - 70_000,
                    updatedAt: Date.now() - 35_000,
                    packagesCompleted: 2,
                    bytesCompleted: 2_612_000,
                  }
                : undefined,
          },
        ],
        profiles: [],
      }),
      installAgent: async () => {
        installs++;
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        installed = true;
      },
      createAgentProfile: async () => {
        creates++;
      },
    },
  });
  await pane.ready;
  const area = () => host.querySelector(".glosa-agent-account-area") as HTMLFieldSetElement;
  const form = () => host.querySelector("form") as HTMLFormElement;
  const name = () => form().querySelector("input") as HTMLInputElement;
  expect(area().disabled).toBe(true);
  name().value = "Personal";
  form().dispatchEvent(new Event("submit", { cancelable: true }));
  await flush();
  expect(creates).toBe(0);
  const install = host.querySelector(".glosa-agent-runtime button") as HTMLButtonElement;
  install.click();
  await flush();
  (document.querySelector("dialog .glosa-save") as HTMLButtonElement | null)?.click();
  await flush();
  expect(installs).toBe(1);
  expect(install.disabled).toBe(true);
  expect(install.textContent).toBe("Installing runtime…");
  expect(install.getAttribute("aria-busy")).toBe("true");
  expect(host.querySelector(".glosa-agent-runtime strong")!.textContent).toContain("Downloading runtime");
  expect(host.querySelector(".glosa-runtime-metrics")!.textContent).toContain(
    "2 packages downloaded · ≈ 2.6 MB received",
  );
  expect(host.querySelector(".glosa-runtime-metrics")!.textContent).toContain("1m 10s elapsed");
  expect(host.textContent).toContain("No installer update for 35s");
  expect(host.querySelector("progress")!.hasAttribute("value")).toBe(false);
  expect((host.querySelector("progress") as HTMLProgressElement).hidden).toBe(false);
  install.click();
  expect(installs).toBe(1);
  finish();
  await flush();
  expect(area().disabled).toBe(false);
  expect((host.querySelector("progress") as HTMLProgressElement).hidden).toBe(true);
  name().value = "Personal";
  form().dispatchEvent(new Event("submit", { cancelable: true }));
  await flush();
  expect(creates).toBe(1);
  pane.destroy();
});

test("reopened runtime settings recover progress after a disconnect and stop polling when destroyed", async () => {
  const { mountAgentSettings } = await import("../src/agent-settings.js");
  const host = document.createElement("div");
  document.body.append(host);
  let tick!: () => void,
    offline = false,
    reads = 0,
    installed = false;
  let resolvePending: (() => void) | undefined;
  const timer = spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void) => {
    tick = callback;
    return 991;
  }) as typeof setInterval);
  const clear = spyOn(globalThis, "clearInterval");
  const pane = mountAgentSettings(host, {
    appearance: undefined,
    onChange: undefined,
    dataAccess: {
      getAgentStatus: async () => {
        reads++;
        if (offline) throw new Error("disconnected");
        if (installed)
          await new Promise<void>((resolve) => {
            resolvePending = resolve;
          });
        return {
          available: true,
          profiles: [],
          providers: [
            {
              id: "codex",
              name: "Codex",
              installed,
              qualified: true,
              installation: {
                phase: installed ? "complete" : "downloading",
                startedAt: Date.now() - 1000,
                updatedAt: Date.now(),
                packagesCompleted: 0,
                bytesCompleted: 0,
              },
            },
          ],
        };
      },
    },
  });
  try {
    await pane.ready;
    await flush();
    expect((host.querySelector(".glosa-agent-runtime button") as HTMLButtonElement).disabled).toBe(true);
    expect(host.querySelector("strong")!.textContent).toContain("Downloading runtime");
    offline = true;
    tick();
    await flush();
    tick();
    expect(host.textContent).toContain("Progress connection interrupted");
    await flush();
    offline = false;
    tick();
    await flush();
    expect(host.textContent).not.toContain("Progress connection interrupted");
    installed = true;
    tick();
    await flush();
    const pendingReads = reads;
    tick();
    tick();
    expect(reads).toBe(pendingReads);
    pane.destroy();
    expect(clear).toHaveBeenCalledWith(991);
    resolvePending!();
    await flush();
    expect(host.childElementCount).toBe(0);
    expect(reads).toBe(pendingReads);
  } finally {
    pane.destroy();
    timer.mockRestore();
    clear.mockRestore();
  }
});

test("an interrupted install request keeps tracking the unknown outcome until status reconnects", async () => {
  const { mountAgentSettings } = await import("../src/agent-settings.js");
  const host = document.createElement("div");
  document.body.append(host);
  let tick!: () => void,
    offline = false,
    installed = false,
    installing = false;
  let rejectInstall!: (error: Error) => void;
  const timer = spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void) => {
    tick = callback;
    return 992;
  }) as typeof setInterval);
  const pane = mountAgentSettings(host, {
    appearance: undefined,
    onChange: undefined,
    dataAccess: {
      getAgentStatus: async () => {
        if (offline) throw new Error("Connection interrupted");
        return {
          available: true,
          profiles: [],
          providers: [
            {
              id: "codex",
              name: "Codex",
              installed,
              qualified: true,
              installation: installing
                ? {
                    phase: "downloading",
                    startedAt: Date.now(),
                    updatedAt: Date.now(),
                    packagesCompleted: 0,
                    bytesCompleted: 0,
                  }
                : undefined,
            },
          ],
        };
      },
      installAgent: async () => {
        installing = true;
        await new Promise<void>((_resolve, reject) => {
          rejectInstall = reject;
        });
      },
    },
  });
  try {
    await pane.ready;
    (host.querySelector(".glosa-agent-runtime button") as HTMLButtonElement).click();
    await flush();
    (document.querySelector("dialog .glosa-save") as HTMLButtonElement).click();
    await flush();
    offline = true;
    rejectInstall(new Error("Connection interrupted"));
    await flush();
    expect((host.querySelector(".glosa-agent-runtime button") as HTMLButtonElement).disabled).toBe(true);
    tick();
    await flush();
    tick();
    await flush();
    expect(host.textContent).toContain("Progress connection interrupted");
    offline = false;
    installing = false;
    installed = true;
    tick();
    await flush();
    expect(host.querySelector("strong")!.textContent).toContain("Installed");
    expect((host.querySelector(".glosa-agent-runtime button") as HTMLButtonElement).disabled).toBe(false);
    expect((host.querySelector("fieldset") as HTMLFieldSetElement).disabled).toBe(false);
    expect((host.querySelector("progress") as HTMLProgressElement).hidden).toBe(true);
  } finally {
    pane.destroy();
    timer.mockRestore();
  }
});

test("failed account creation preserves the label and restores usable controls", async () => {
  const { mountAgentSettings } = await import("../src/agent-settings.js");
  const host = document.createElement("div");
  document.body.append(host);
  const pane = mountAgentSettings(host, {
    appearance: undefined,
    onChange: undefined,
    dataAccess: {
      getAgentStatus: async () => ({
        available: true,
        providers: [{ id: "codex", name: "Codex", installed: true, qualified: true }],
        profiles: [],
      }),
      createAgentProfile: async () => {
        throw new Error("Could not save the account. Try again.");
      },
    },
  });
  await pane.ready;
  const input = host.querySelector(".glosa-agent-add-account input") as HTMLInputElement;
  input.value = "Work";
  host.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
  await flush();
  expect(input.value).toBe("Work");
  expect(input.disabled).toBe(false);
  expect(host.querySelector(".glosa-agent-status")!.textContent).toContain("Try again");
  pane.destroy();
});

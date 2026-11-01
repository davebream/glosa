// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import MarkdownIt from "markdown-it";
import { modelChoices, modelPresentation } from "../src/agent-ui.js";
import { createChatLogPane } from "../src/chat-log-pane.js";
import { createSafeChatRenderer } from "../src/chat-markdown.js";
import { applyChatEvent, createChatPane } from "../src/chat-pane.js";
import { createChatStore } from "../src/chat-store.js";
import { composerToken, createComposerPicker, editReferences } from "../src/composer-picker.js";
import { type DomEnv, installDom } from "./dom-env.ts";

let dom: DomEnv;
const mountedPanes = new Set<{ destroy(): void }>();
beforeEach(() => {
  dom = installDom();
});
afterEach(() => {
  for (const pane of mountedPanes) pane.destroy();
  mountedPanes.clear();
  dom.teardown();
});
const flush = async () => {
  // assistant-ui publishes its external-store projection through React scheduled effects.
  // Yield event-loop tasks, not a timing assertion or a layout simulation.
  for (let turn = 0; turn < 3; turn++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    for (let i = 0; i < 30; i++) await Promise.resolve();
  }
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
    const choices = () => [...f.host.querySelectorAll<HTMLButtonElement>("[data-model-id]")];
    expect(choices().map((button) => button.firstElementChild!.textContent)).toEqual(["Opus 5.5", "Haiku 4.5"]);
    expect(choices().find((button) => button.getAttribute("aria-pressed") === "true")!.dataset.modelId).toBe(selected);
    expect(changes).toEqual([]);
    const effort = f.host.querySelector(".glosa-chat-effort") as HTMLButtonElement;
    effort.click();
    await flush();
    expect(changes).toEqual([selected]);
    modelButton(f.host, "haiku").click();
    await flush();
    expect(choices()[0]!.dataset.modelId).toBe("opus[1m]");
    modelButton(f.host, "opus[1m]").click();
    await flush();
    expect(changes).toEqual([selected, "haiku", "opus[1m]"]);
    expect(f.host.querySelector(".glosa-model-picker-trigger")!.textContent).toContain("Opus 5.5");
    f.pane.destroy();
  }
});

test("subscription choices stay on the chat, preserve its draft and recover from a rejected switch", async () => {
  const f = fixture();
  f.catalog.profiles.push({ id: "c", provider: "claude-code", enabled: true, label: "Second subscription" });
  Object.assign(f.catalog.capabilities, { c: structuredClone(f.catalog.capabilities.a) });
  f.state.turns.push({ id: "prior", status: "completed", settings: f.state.settings });
  await f.pane.ready;
  [...f.host.querySelectorAll("button")].find((button) => button.textContent === "Refresh accounts")!.click();
  await flush();
  const draft = f.host.querySelector('[aria-label="Message"]') as HTMLTextAreaElement;
  draft.value = "Keep this unsent text";
  draft.dispatchEvent(new Event("input", { bubbles: true }));
  const account = f.host.querySelector(".glosa-model-picker-account") as HTMLButtonElement;
  account.click();
  const models = f.host.querySelector(".glosa-model-picker-models") as HTMLElement;
  const accounts = f.host.querySelector(".glosa-model-picker-accounts") as HTMLElement;
  expect(models.hidden).toBe(true);
  expect(accounts.hidden).toBe(false);
  expect((document.activeElement as HTMLElement).dataset.profileId).toBe("a");
  document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  expect((document.activeElement as HTMLElement).dataset.profileId).toBe("c");
  const changes: any[] = [];
  f.dataAccess.changeChat = async (slug: string, id: string, input: any) => {
    changes.push({ slug, id, ...input });
    if (changes.length === 1) throw new Error("Subscription is busy. Try again.");
    f.state.profileId = input.profileId;
    f.state.settings = input.settings;
    f.state.configRevision++;
  };
  profileButton(f.host, "c").click();
  await flush();
  expect(f.host.querySelector(".glosa-model-picker-error")!.textContent).toContain("Subscription is busy");
  expect(profileButton(f.host, "c").disabled).toBe(false);
  expect(f.state.profileId).toBe("a");
  profileButton(f.host, "c").click();
  await flush();
  expect(changes[1]).toMatchObject({
    slug: "ws",
    id: "chat",
    profileId: "c",
    settings: { model: "model", effort: "high" },
  });
  expect(f.newChats).toHaveLength(0);
  expect(draft.value).toBe("Keep this unsent text");
  expect(account.textContent).toBe("Second subscription");
  expect(models.hidden).toBe(false);
  expect(accounts.hidden).toBe(true);
  f.state.revision++;
  await f.snapshot();
  expect(account.textContent).toBe("Second subscription");
  account.click();
  profileButton(f.host, "c").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
  expect(models.hidden).toBe(false);
  expect(document.activeElement === account).toBe(true);
  f.catalog.capabilities.a.models = [{ id: "other", name: "Other 2", resolvedModel: "other-2", efforts: ["low"] }];
  [...f.host.querySelectorAll("button")].find((button) => button.textContent === "Refresh accounts")!.click();
  await flush();
  account.click();
  profileButton(f.host, "a").click();
  await flush();
  expect(f.state.profileId).toBe("a");
  expect(f.state.settings.model).toBe("");
  expect(f.host.querySelector(".glosa-model-picker-trigger")!.textContent).toBe("Choose model");
  f.state.runtime = { state: "unknown" };
  f.state.revision++;
  await f.snapshot();
  expect(account.disabled).toBe(true);
  expect(profileButton(f.host, "a").disabled).toBe(true);
  f.pane.destroy();
});

test("an unresolved send remains retryable after the selected account is disabled", async () => {
  const f = fixture();
  await f.pane.ready;
  const draft = f.host.querySelector('[aria-label="Message"]') as HTMLTextAreaElement;
  draft.value = "Preserve this request";
  draft.dispatchEvent(new Event("input", { bubbles: true }));
  await flush();
  const send = f.host.querySelector('[aria-label="Send message"]') as HTMLButtonElement;
  send.click();
  await flush();
  f.catalog.profiles[0]!.enabled = false;
  const refresh = [...f.host.querySelectorAll("button")].find((button) => button.textContent === "Refresh accounts")!;
  refresh.click();
  await flush();
  // The message left the composer when it was sent. Its answer was lost, so it waits in the tray
  // as not sent, and Retry repeats the same request whatever happened to the account since.
  expect(draft.value).toBe("");
  const row = f.host.querySelector(".glosa-chat-tray li")!;
  // The row says why, under the words, instead of hiding the reason in a tooltip.
  expect(row.textContent).toBe("Not sentPreserve this requestRetryEditRemoveConnection lost");
  expect(row.querySelector(".glosa-chat-tray-why")!.textContent).toBe("Connection lost");
  (row.querySelector('[aria-label="Retry sending message"]') as HTMLButtonElement).click();
  await flush();
  expect(f.sends).toHaveLength(2);
  expect(f.sends[1]).toEqual(f.sends[0]);
  expect(f.host.querySelector(".glosa-chat-tray-words")!.textContent).toBe("Preserve this request");
  f.pane.destroy();
});

test("with no model list yet, the first send asks the agent for its models and then goes", async () => {
  const f = fixture();
  await f.pane.ready;
  f.catalog.capabilities.a.models = [];
  f.state.settings.model = "";
  f.state.revision++;
  const calls: string[] = [];
  let finishDiscovery!: () => void;
  f.dataAccess.discoverAgentModels = async (profileId: string) => {
    calls.push(`discover:${profileId}`);
    await new Promise<void>((resolve) => {
      finishDiscovery = resolve;
    });
    f.catalog.capabilities.a.models = [{ id: "found", name: "Found", efforts: ["medium"] }];
  };
  f.dataAccess.changeChat = async (_s: string, _i: string, input: any) => {
    calls.push(`settings:${input.settings.model}:${input.settings.effort}`);
    f.state.settings = input.settings;
    f.state.configRevision++;
    f.state.revision++;
  };
  f.dataAccess.sendChatTurn = async (_s: string, _i: string, input: any) => {
    f.sends.push(input);
    f.state.turns.push({ id: input.turnId, text: input.text, status: "queued", at: new Date().toISOString() });
    f.state.draft = "";
    f.state.draftRevision++;
    f.state.revision++;
  };
  [...f.host.querySelectorAll("button")].find((button) => button.textContent === "Refresh accounts")!.click();
  await flush();
  // Nothing asks the person to load models: the composer is open, and no such action exists.
  expect((f.host.querySelector(".glosa-chat-readiness") as HTMLElement).hidden).toBe(true);
  expect([...f.host.querySelectorAll("button")].some((button) => button.textContent === "Load models")).toBe(false);
  const draft = f.host.querySelector('[aria-label="Message"]') as HTMLTextAreaElement;
  draft.value = "First words";
  draft.dispatchEvent(new Event("input", { bubbles: true }));
  await flush();
  const send = f.host.querySelector(".glosa-chat-send") as HTMLButtonElement;
  expect(send.disabled).toBe(false);
  draft.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await flush();
  expect(f.host.querySelector(".glosa-chat-status")!.textContent).toContain("Checking which models");
  // The words stay in the composer until the agent has answered.
  expect(draft.value).toBe("First words");
  finishDiscovery();
  await flush();
  await flush();
  expect(calls).toEqual(["discover:a", "settings:found:medium"]);
  expect(f.sends.map((sent) => sent.text)).toEqual(["First words"]);
  expect(draft.value).toBe("");
  f.pane.destroy();
});

test("a chat just started checks its account's models as it opens; a chat with history asks nothing", async () => {
  for (const fresh of [true, false]) {
    const f = fixture({ models: [] });
    if (!fresh) f.state.turns.push({ id: "old", text: "Earlier", status: "completed" });
    const calls: string[] = [];
    f.dataAccess.discoverAgentModels = async (profileId: string) => {
      calls.push(profileId);
      f.catalog.capabilities.a.models = [{ id: "model", name: "Model", efforts: ["high"] }];
    };
    await f.pane.ready;
    await flush();
    expect(calls).toEqual(fresh ? ["a"] : []);
    f.pane.destroy();
  }
});

test("account discovery locks other choices and sending until success or recoverable failure", async () => {
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
    profileButton(f.host, "b").click();
    const draft = f.host.querySelector('[aria-label="Message"]') as HTMLTextAreaElement;
    draft.value = "Wait for the chosen account";
    draft.dispatchEvent(new Event("input", { bubbles: true }));
    draft.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();
    expect(f.sends).toHaveLength(0);
    [...f.host.querySelectorAll("button")].find((button) => button.textContent === "Send feedback")!.click();
    await flush();
    expect(f.feedbacks).toHaveLength(0);
    expect(profileButton(f.host, "c").disabled).toBe(true);
    profileButton(f.host, "c").click();
    await flush();
    expect(f.newChats).toHaveLength(0);
    resolve();
    await flush();
    expect(f.newChats.map((args) => args[0].id)).toEqual(fails ? [] : ["b"]);
    expect(profileButton(f.host, "c").disabled).toBe(false);
    profileButton(f.host, "c").click();
    await flush();
    expect(f.newChats.map((args) => args[0].id)).toEqual(fails ? ["c"] : ["b", "c"]);
    f.pane.destroy();
  }
});
function modelButton(host: HTMLElement, id: string) {
  return [...host.querySelectorAll<HTMLButtonElement>("[data-model-id]")].find(
    (button) => button.dataset.modelId === id,
  )!;
}
function profileButton(host: HTMLElement, id: string) {
  return [...host.querySelectorAll<HTMLButtonElement>("[data-profile-id]")].find(
    (button) => button.dataset.profileId === id,
  )!;
}
function fixture({ models, ...options }: { sourceChatId?: string; models?: any[] } = {}) {
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
      a: {
        models: models ?? [{ id: "model", name: "Model", resolvedModel: "claude-sonnet-5", efforts: ["high", "low"] }],
      },
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
  mountedPanes.add(pane);
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
    snapshot: async () => {
      stream.onEvent({ event: "chat_snapshot", data: structuredClone(state) });
      await flush();
    },
    event: async (data: unknown) => {
      stream.onEvent({ event: "chat_event", data });
      await flush();
    },
  };
}

test("usage separates current session totals from account limits without inventing current context use", async () => {
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
  await f.snapshot();
  // Usage is the chat's bookkeeping: it opens from the chat menu and is never a row in the thread.
  expect(f.host.querySelector(".glosa-chat-history")!.textContent).not.toContain("Token usage");
  const action = f.host.querySelector('[data-chat-action="usage"]') as HTMLButtonElement;
  expect(action.hidden).toBe(false);
  action.click();
  const usage = document.querySelector("dialog.glosa-dialog") as HTMLDialogElement;
  expect(usage.querySelector("h2")!.textContent).toBe("Usage and limits");
  expect(usage.textContent).toContain("current session totals");
  expect(usage.textContent).toContain("Context capacity (tokens): 200,000");
  expect(usage.textContent).toContain("Current context use: Not reported");
  expect(usage.textContent).toContain("Account limits");
  expect(usage.textContent).toContain("Primary limit used (%): 12");
  expect(usage.textContent).toContain("Source: Codex account");
  expect(usage.textContent).not.toContain("150%");
  expect(usage.textContent).not.toContain("primaryUsedPercent");
  usage.close();
  f.pane.destroy();
});

test("a turn names its model only when it ran on something else, and shows its reasoning as one summary", async () => {
  const f = fixture();
  await f.pane.ready;
  expect((f.host.querySelector('[data-chat-action="usage"]') as HTMLButtonElement).hidden).toBe(true);
  const settings = { model: "model", effort: "high", permissionMode: "default" };
  f.state.turns = [
    // The alias resolved to the model the catalog names for it: the person's own choice.
    { id: "same", text: "First", status: "completed", settings, effective: { model: "claude-sonnet-5" } },
    { id: "silent", text: "Second", status: "completed", settings },
    {
      id: "other",
      text: "Third",
      status: "completed",
      settings,
      effective: { model: "claude-haiku-4-5", effort: "high" },
    },
    { id: "effort", text: "Fourth", status: "completed", settings, effective: { model: "model", effort: "low" } },
  ];
  (f.state.content as unknown[]) = [
    { id: "r1", turnId: "same", kind: "reasoning", role: "assistant", text: "Weighing the outline" },
    {
      id: "t1",
      turnId: "same",
      kind: "tool",
      role: "assistant",
      name: "Read",
      status: "completed",
      text: "outline.md",
    },
    { id: "r2", turnId: "same", kind: "reasoning", role: "assistant", text: "Checking the ending" },
    { id: "a1", turnId: "same", kind: "text", role: "assistant", text: "Done." },
  ];
  f.state.revision++;
  await f.snapshot();
  const summaries = [...f.host.querySelectorAll(".glosa-chat-history summary")].map((node) => node.textContent);
  expect(summaries).toEqual([
    "Reasoning summary",
    "1 step",
    "Read a file",
    "Ran on a different model",
    "Ran at a different effort",
  ]);
  expect(f.host.querySelector(".glosa-chat-history")!.textContent).not.toContain("Model and effort");
  const reasoning = f.host.querySelector('.glosa-chat-message[data-kind="reasoning"] .glosa-chat-text')!;
  // Both fragments, in order, in the one row (rendered or plain, by whether a renderer is loaded).
  expect(f.host.querySelectorAll('.glosa-chat-message[data-kind="reasoning"]')).toHaveLength(1);
  expect(reasoning.textContent).toMatch(/Weighing the outline\s+Checking the ending/);
  const mismatch = [...f.host.querySelectorAll("details")].find((row) =>
    row.textContent!.includes("Ran on a different model"),
  )!;
  expect(mismatch.textContent).toContain("You chose: model · high");
  expect(mismatch.textContent).toContain("The agent reported: claude-haiku-4-5 · high");
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
    expect(modelButton(f.host, "model").textContent).toContain("Sonnet 5");
    expect(modelButton(f.host, "model").getAttribute("aria-pressed")).toBe("true");
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
    const effort = f.host.querySelector(".glosa-chat-effort") as HTMLButtonElement;
    effort.click();
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
    expect(effort.dataset.effort).toBe(fails ? "high" : "low");
    expect(f.state.settings.permissionMode).toBe("default");
    draft.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();
    expect(f.sends).toHaveLength(1);
    expect(f.sends[0].configRevision).toBe(fails ? 1 : 2);
    f.pane.destroy();
  }
});

test("effort steps up one level a press, wraps past the top and keeps presses made while saving", async () => {
  const f = fixture();
  await f.pane.ready;
  // Catalog order is not ladder order: the control climbs low → medium → high → max whatever it is handed.
  f.catalog.capabilities.a.models[0]!.efforts = ["max", "high", "low", "medium"];
  [...f.host.querySelectorAll("button")].find((button) => button.textContent === "Refresh accounts")!.click();
  await flush();
  const saved: string[] = [];
  let finish!: () => void;
  let hold = false;
  f.dataAccess.changeChat = (_slug: string, _id: string, input: { settings: typeof f.state.settings }) =>
    new Promise<void>((resolve) => {
      finish = () => {
        saved.push(input.settings.effort);
        f.state.settings = input.settings;
        f.state.configRevision++;
        resolve();
      };
      if (!hold) finish();
    });
  const effort = f.host.querySelector(".glosa-chat-effort") as HTMLButtonElement;
  expect(effort.tagName).toBe("BUTTON");
  expect(f.host.querySelector(".glosa-chat-effort-field select")).toBeNull();
  expect(effort.textContent).toBe("EffortHigh");
  effort.click();
  await flush();
  expect(effort.dataset.effort).toBe("max");
  effort.click();
  await flush();
  expect(effort.dataset.effort).toBe("low");
  expect(saved).toEqual(["max", "low"]);
  // Two more presses land while the first save is still out: the label follows each press at once
  // and the chat ends on the level the person stopped at.
  hold = true;
  effort.click();
  effort.click();
  effort.click();
  expect(effort.dataset.effort).toBe("max");
  expect(effort.disabled).toBe(false);
  finish();
  await flush();
  finish();
  await flush();
  expect(saved).toEqual(["max", "low", "medium", "max"]);
  expect(f.state.settings.effort).toBe("max");
  hold = false;
  effort.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
  await flush();
  expect(f.state.settings.effort).toBe("high");
  expect(f.host.querySelector(".glosa-chat-effort-field [role=status]")!.textContent).toBe("Effort: High");
  expect(effort.querySelector<HTMLElement>(".glosa-chat-effort-label")!.dataset.widest).toBe("Maximum");
  f.pane.destroy();
});

test("a turn at work shows a live line under its last row and it goes when the turn ends", async () => {
  const f = fixture();
  await f.pane.ready;
  const history = f.host.querySelector(".glosa-chat-history")!;
  expect(history.getAttribute("role")).toBe("log");
  const settings = { model: "model", effort: "high", permissionMode: "default" };
  const at = new Date(Date.now() - 65_000).toISOString();
  f.state.turns = [{ id: "t", text: "Review it", status: "running", at, settings }];
  f.state.revision++;
  await f.snapshot();
  const live = () => f.host.querySelector(".glosa-chat-live");
  // Nothing has arrived yet: the thread itself says the agent is at work, and for how long.
  expect(live()!.textContent).toBe("Thinking1m 05s");
  expect(live()!.closest(".glosa-chat-assistant-turn")!.previousElementSibling!.getAttribute("data-kind")).toBe(
    "human",
  );
  expect(history.getAttribute("aria-busy")).toBe("true");
  (f.state.content as unknown[]) = [
    {
      id: "s1",
      turnId: "t",
      kind: "tool",
      role: "tool",
      name: "Read",
      status: "running",
      text: '{"file_path":"a/outline.md"}',
    },
  ];
  f.state.revision++;
  await f.snapshot();
  expect(live()!.textContent).toStartWith("Reading outline.md");
  const steps = f.host.querySelector(".glosa-chat-steps") as HTMLDetailsElement;
  expect(steps.open).toBe(false);
  expect(live()!.previousElementSibling).toBe(steps);
  expect(steps.querySelector("li")!.dataset.state).toBe("running");
  (f.state.content as unknown[]) = [
    { id: "s1", turnId: "t", kind: "tool", role: "tool", name: "Read", status: "failed", text: "No such file" },
    { id: "a1", turnId: "t", kind: "text", role: "assistant", text: "I could not find it." },
  ];
  f.state.turns[0].status = "completed";
  f.state.revision++;
  await f.snapshot();
  expect(live()).toBeNull();
  expect(history.getAttribute("aria-busy")).toBe("false");
  expect(steps.querySelector(":scope > summary")!.textContent).toBe("1 step · 1 failed");
  // The file's name was learned while the step ran, and its failure is said in words.
  expect(steps.querySelector("li")!.textContent).toBe("Read outline.md · failedNo such file");
  f.pane.destroy();
});

test("a finished turn's live line goes, and the next message sends, where the engine has a ResizeObserver", async () => {
  // The test DOM has no ResizeObserver, so the pane never watched a row there. A browser has one,
  // and it refuses anything that is not an element: the live line has no content to unwatch.
  const targets = new Set<unknown>();
  class StrictResizeObserver {
    observe(target: unknown) {
      if (!(target instanceof Element)) throw new TypeError("observe: parameter 1 is not of type 'Element'");
      targets.add(target);
    }
    unobserve(target: unknown) {
      if (!(target instanceof Element)) throw new TypeError("unobserve: parameter 1 is not of type 'Element'");
      targets.delete(target);
    }
    disconnect() {
      targets.clear();
    }
  }
  const scope = globalThis as { ResizeObserver?: unknown };
  const before = scope.ResizeObserver;
  scope.ResizeObserver = StrictResizeObserver;
  try {
    const f = fixture();
    await f.pane.ready;
    const settings = { model: "model", effort: "high", permissionMode: "default" };
    f.state.turns = [{ id: "t", text: "hey", status: "running", at: new Date().toISOString(), settings }];
    f.state.revision++;
    await f.snapshot();
    expect(f.host.querySelector(".glosa-chat-live")).not.toBeNull();
    (f.state.content as unknown[]) = [{ id: "a1", turnId: "t", kind: "text", role: "assistant", text: "Hello." }];
    f.state.turns[0].status = "completed";
    f.state.revision++;
    await f.snapshot();
    expect(f.host.querySelector(".glosa-chat-live")).toBeNull();
    expect(targets.size).toBeGreaterThan(0);
    const draft = f.host.querySelector("textarea")!;
    draft.value = "good, you?";
    draft.dispatchEvent(new Event("input", { bubbles: true }));
    draft.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();
    expect(f.sends.map((send) => send.text)).toEqual(["good, you?"]);
    f.pane.destroy();
  } finally {
    scope.ResizeObserver = before;
  }
});

/** A daemon that takes what is sent: each message becomes a turn, queued behind whatever is there. */
function accepting(f: ReturnType<typeof fixture>) {
  f.dataAccess.sendChatTurn = async (_s: string, _id: string, input: any) => {
    f.sends.push(input);
    if (input.draftRevision !== f.state.draftRevision) throw new Error("stale draft");
    f.state.turns.push({ id: input.turnId, text: input.text, status: "queued", at: new Date().toISOString() });
    f.state.draft = "";
    f.state.draftRevision++;
    f.state.revision++;
  };
}
async function type(f: ReturnType<typeof fixture>, text: string) {
  const draft = f.host.querySelector("textarea")!;
  draft.value = text;
  draft.dispatchEvent(new Event("input", { bubbles: true }));
  draft.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await flush();
  return draft;
}

test("sending never locks the composer: messages line up in the tray behind the reply at work", async () => {
  const f = fixture();
  accepting(f);
  await f.pane.ready;
  f.state.turns = [{ id: "t", text: "First", status: "running", at: new Date().toISOString() }];
  f.state.revision++;
  await f.snapshot();
  const draft = await type(f, "Second");
  // The words leave the composer on Enter, before the daemon has answered, and it is free again.
  expect(draft.value).toBe("");
  expect(draft.disabled).toBe(false);
  // Behind a reply at work the one button says Queue, and the key hint with it.
  const send = f.host.querySelector(".glosa-chat-send") as HTMLButtonElement;
  expect(send.textContent).toBe("Queue");
  expect(send.getAttribute("aria-label")).toBe("Queue message");
  expect(f.host.querySelector(".glosa-chat-key-hint")!.textContent).toBe("Enter to queue · Shift Enter for a new line");
  expect(send.disabled).toBe(true);
  expect(f.host.querySelector(".glosa-chat-tray")!.textContent).toBe("NextSecondEditRemoveSend now");
  await type(f, "Third");
  await flush();
  expect(f.sends.map((sent) => sent.text)).toEqual(["Second", "Third"]);
  expect([...f.host.querySelectorAll(".glosa-chat-tray li")].map((row) => row.textContent)).toEqual([
    "NextSecondEditRemoveSend now",
    "2ndThirdEditRemoveSend now",
  ]);
  expect(f.host.querySelector(".glosa-chat-composer [role=status]")!.textContent).toBe("2 messages waiting");
  // Neither is in the thread: a message joins the conversation when its turn starts.
  expect(f.host.querySelectorAll('.glosa-chat-message[data-kind="human"]')).toHaveLength(1);
  for (const text of ["4", "5", "6"]) await type(f, text);
  await flush();
  expect(f.sends).toHaveLength(5);
  // A sixth has nowhere to wait: it stays in the composer, and the pane says why.
  expect((await type(f, "One too many")).value).toBe("One too many");
  await flush();
  expect(f.sends).toHaveLength(5);
  expect(f.host.querySelector(".glosa-chat-status")!.textContent).toContain("Five messages are already waiting");
  f.pane.destroy();
});

test("a message sent with nothing ahead of it is in the thread at once and says it is starting", async () => {
  const f = fixture();
  accepting(f);
  const taken = f.dataAccess.sendChatTurn;
  let answer!: () => void;
  f.dataAccess.sendChatTurn = async (...args: unknown[]) => {
    await new Promise<void>((done) => {
      answer = done;
    });
    return taken(...args);
  };
  await f.pane.ready;
  await type(f, "hey");
  await flush();
  const live = () => f.host.querySelector(".glosa-chat-live");
  const bubbles = () => f.host.querySelectorAll('.glosa-chat-message[data-kind="human"]');
  // Before the daemon has answered: the bubble is there, with a live line, and nothing is in the tray.
  expect(bubbles()).toHaveLength(1);
  expect(live()!.textContent).toBe("Sending");
  expect((f.host.querySelector(".glosa-chat-tray") as HTMLElement).hidden).toBe(true);
  expect(f.host.querySelector(".glosa-chat-history")!.getAttribute("aria-busy")).toBe("true");
  // While the daemon has not answered, a redraw still leaves the composer and its button free.
  f.state.revision++;
  await f.snapshot();
  // A second message would go behind the one on its way, and the button says so.
  const send = f.host.querySelector(".glosa-chat-send") as HTMLButtonElement;
  expect([send.disabled, send.textContent, send.dataset.mode]).toEqual([true, "Queue", "queue"]);
  expect(f.host.querySelector("textarea")!.value).toBe("");
  answer();
  await flush();
  // Taken, and waiting for its agent to start: the same bubble, and the thread says what the wait is.
  expect(bubbles()).toHaveLength(1);
  expect(live()!.textContent).toBe("Starting");
  expect((f.host.querySelector(".glosa-chat-tray") as HTMLElement).hidden).toBe(true);
  expect((f.host.querySelector(".glosa-chat-stop") as HTMLButtonElement).hidden).toBe(false);
  f.pane.destroy();
});

test("a waiting message can be edited or sent now, and Stop ends only the reply at work", async () => {
  const f = fixture();
  await f.pane.ready;
  f.state.turns = [
    { id: "active", text: "First", status: "running", started: true, at: new Date().toISOString() },
    { id: "a", text: "Second", status: "queued", attachments: [] },
    { id: "b", text: "Third", status: "queued", attachments: [] },
  ];
  const calls: string[] = [];
  f.dataAccess.stopChat = async (_s: string, _id: string, turnId?: string) => {
    calls.push(`stop:${turnId}`);
    const turn = f.state.turns.find((item) => item.id === turnId)!;
    turn.status = "cancelled";
    f.state.revision++;
  };
  f.dataAccess.sendChatTurnNow = async (_s: string, _id: string, turnId: string) => {
    calls.push(`now:${turnId}`);
  };
  f.state.revision++;
  await f.snapshot();
  const rows = () => [...f.host.querySelectorAll(".glosa-chat-tray li")] as HTMLElement[];
  (rows()[1]!.querySelector('[aria-label="Send this message now"]') as HTMLButtonElement).click();
  await flush();
  expect(calls).toEqual(["now:b"]);
  // Editing preserves the queue position and the independent unsent draft.
  f.dataAccess.editQueuedChatTurn = async (_s: string, _id: string, input: any) => {
    calls.push(`edit:${input.turnId}:${input.expectedRevision}`);
    f.state.turns.find((turn) => turn.id === input.turnId)!.text = input.text;
    f.state.revision++;
  };
  const draft = f.host.querySelector('[aria-label="Message"]') as HTMLTextAreaElement;
  draft.value = "My next draft";
  draft.dispatchEvent(new Event("input", { bubbles: true }));
  (rows()[0]!.querySelector('[aria-label="Edit waiting message"]') as HTMLButtonElement).click();
  await flush();
  expect(calls).toEqual(["now:b"]);
  const editor = rows()[0]!.querySelector('textarea[aria-label="Edit waiting message"]') as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(editor, "Second revised");
  editor.dispatchEvent(new Event("input", { bubbles: true }));
  editor.dispatchEvent(new Event("change", { bubbles: true }));
  await flush();
  [...rows()[0]!.querySelectorAll("button")].find((button) => button.textContent === "Save message")!.click();
  await flush();
  expect(calls).toEqual(["now:b", "edit:a:1"]);
  expect(draft.value).toBe("My next draft");
  expect(rows().map((row) => row.querySelector(".glosa-chat-tray-words")!.textContent)).toEqual([
    "Second revised",
    "Third",
  ]);
  (f.host.querySelector(".glosa-chat-stop") as HTMLButtonElement).click();
  await flush();
  expect(calls).toEqual(["now:b", "edit:a:1", "stop:active"]);
  f.pane.destroy();
});

test("a reply stopped in another window keeps its message in the thread here", async () => {
  const f = fixture();
  await f.pane.ready;
  // This window learned of the turn while it still waited, and hears the rest as status events only.
  f.state.turns = [{ id: "t", text: "Review it", status: "queued", at: new Date().toISOString() }];
  f.state.revision++;
  await f.snapshot();
  let seq = f.state.revision;
  for (const status of ["dispatching", "running", "stopping", "cancelled"])
    await f.event({ seq: ++seq, data: { type: "turn_status", turnId: "t", status } });
  const bubble = f.host.querySelector('.glosa-chat-message[data-kind="human"] .glosa-chat-text');
  expect(bubble?.textContent).toBe("Review it");
  expect(f.host.querySelector(".glosa-chat-turn-state")!.textContent).toBe("CancelledUse as draft");
  f.pane.destroy();
});

test("after a draft conflict, Retry sends the waiting messages on the draft as it now is", async () => {
  const f = fixture();
  accepting(f);
  await f.pane.ready;
  f.state.turns = [{ id: "t", text: "First", status: "running", started: true, at: new Date().toISOString() }];
  f.state.revision++;
  await f.snapshot();
  const draft = f.host.querySelector("textarea")!;
  draft.value = "Second";
  draft.dispatchEvent(new Event("input", { bubbles: true }));
  // Another window saves the draft before this one has: this window's save is refused.
  f.state.draft = "Other window";
  f.state.draftRevision = 3;
  draft.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await type(f, "Third");
  await flush();
  expect(f.sends).toHaveLength(0);
  expect([...f.host.querySelectorAll(".glosa-chat-tray-state")].map((node) => node.textContent)).toEqual([
    "Not sent",
    "Not sent",
  ]);
  expect(f.host.querySelector(".glosa-chat-status")!.textContent).toContain("replaces the draft saved elsewhere");
  (f.host.querySelector('[aria-label="Retry sending message"]') as HTMLButtonElement).click();
  await flush();
  expect(f.sends.map((sent) => [sent.text, sent.draftRevision])).toEqual([
    ["Second", 3],
    ["Third", 4],
  ]);
  f.pane.destroy();
});

test("tools and access open as a dialog from the line under the composer, with nothing to revoke per workspace", async () => {
  const f = fixture();
  f.dataAccess.getMcpPolicy = async () => ({
    revision: 1,
    servers: [
      { id: "a", label: "Library", enabled: true, transport: "http", url: "https://example.com/mcp" },
      { id: "b", label: "Off", enabled: false, transport: "stdio", command: "/bin/x", args: [] },
    ],
  });
  await f.pane.ready;
  await flush();
  // Nothing about tools sits under the composer but one line, and no dialog exists until asked for.
  expect(f.host.querySelector(".glosa-chat-footer details")).toBeNull();
  expect(document.querySelector("dialog")).toBeNull();
  const line = f.host.querySelector(".glosa-chat-tools-line") as HTMLButtonElement;
  expect(line.textContent).toBe("1 tool on");
  line.click();
  await flush();
  const tools = document.querySelector("dialog.glosa-chat-tools") as HTMLDialogElement;
  expect(tools.open).toBe(true);
  expect(tools.querySelector("h2")!.textContent).toBe("Tools and workspace access");
  expect(tools.textContent).not.toMatch(/MCP|native/i);
  // Access is the account's, granted once with experimental chat: no per-workspace revoke here.
  expect([...tools.querySelectorAll("button")].map((b) => b.textContent)).not.toContain("Revoke access");
  expect(tools.textContent).toContain("Agents & accounts");
  [...tools.querySelectorAll("button")].find((b) => b.textContent === "Close")!.click();
  await flush();
  expect(document.querySelector("dialog.glosa-chat-tools")).toBeNull();
  f.pane.destroy();
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
  input.dispatchEvent(new Event("change", { bubbles: true }));
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
  await f.snapshot();
  // The waiting message is a row at the top of the composer, not a bubble in the thread, and the
  // composer stays free for the next one.
  const humans = () => [...f.host.querySelectorAll('.glosa-chat-message[data-kind="human"]')];
  expect(humans().map((node) => node.querySelector(".glosa-chat-text")!.textContent)).toEqual(["First"]);
  const tray = f.host.querySelector(".glosa-chat-composer > .glosa-chat-tray") as HTMLElement;
  expect(tray.hidden).toBe(false);
  expect(tray.textContent).toBe("NextSecondEditRemoveSend now");
  expect(f.host.querySelector(".glosa-chat-composer [role=status]")!.textContent).toBe("1 message waiting");
  expect((f.host.querySelector('[aria-label="Queue message"]') as HTMLButtonElement).disabled).toBe(true);
  (tray.querySelector('[aria-label="Remove waiting message"]') as HTMLButtonElement).click();
  await flush();
  expect(stopped).toEqual(["next"]);
  expect(f.state.turns[0].status).toBe("running");
  // Removed before it reached the agent, it was never part of the conversation.
  expect(tray.hidden).toBe(true);
  expect(humans()).toHaveLength(1);
  expect(f.host.querySelector(".glosa-chat-turn-state")).toBeNull();
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
  await f.snapshot();
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
  await f.snapshot();
  expect(resumed).toHaveLength(0);
  expect(f.host.querySelector(".glosa-chat-tray")!.textContent).toBe("HeldReview this againContinueEditRemove");
  [...f.host.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Continue held message")!.click();
  await flush();
  expect(resumed).toEqual(["held"]);
  // Stopped after it reached the agent, it stays in the thread and can be used again.
  f.state.turns[0].started = true;
  f.state.turns[0].status = "cancelled";
  f.state.revision++;
  await f.snapshot();
  [...f.host.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Use message as draft")!.click();
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
  input.dispatchEvent(new Event("change", { bubbles: true }));
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
  await f.snapshot();
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
  await flush();
  const send = f.host.querySelector('[aria-label="Send message"]') as HTMLButtonElement;
  send.click();
  await flush();
  expect(draft.value).toBe("");
  expect(f.host.querySelector(".glosa-chat-status")!.textContent).toContain("it will not create a duplicate");
  (f.host.querySelector('[aria-label="Retry sending message"]') as HTMLButtonElement).click();
  await flush();
  expect(f.sends).toHaveLength(2);
  expect(f.sends[1]).toEqual(f.sends[0]);
  expect(f.host.querySelector(".glosa-chat-tray-words")!.textContent).toBe("Please review");
  f.pane.destroy();
});

test("switching provider after a submitted turn requests a fresh chat and leaves history in place", async () => {
  const f = fixture();
  f.state.turns.push({ id: "turn", text: "Hello", status: "completed" });
  await f.pane.ready;
  profileButton(f.host, "b").click();
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
  const choice = modelButton(f.host, "model");
  choice.focus();
  f.state.revision++;
  await f.snapshot();
  expect(modelButton(f.host, "model")).toBe(choice);
  expect(document.activeElement).toBe(choice);
  f.status("down");
  await flush();
  expect(f.host.textContent).toContain("Reconnecting");
  f.status("up");
  await flush();
  expect(f.host.textContent).not.toContain("Reconnecting");
  const notice = f.host.querySelector(".glosa-chat-status")!;
  notice.textContent = "Draft changed in another browser";
  f.status("up");
  await flush();
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

test("experimental account control requires confirmation and keeps an unqualified runtime visibly experimental", async () => {
  const { mountAgentSettings } = await import("../src/agent-settings.js");
  const host = document.createElement("div");
  document.body.append(host);
  let enabled = false;
  const changes: unknown[] = [];
  const creates: unknown[] = [];
  const pane = mountAgentSettings(host, {
    appearance: undefined,
    onChange: undefined,
    dataAccess: {
      getAgentStatus: async () => ({
        available: enabled,
        providers: [
          {
            id: "codex",
            name: "Codex",
            installed: true,
            qualified: false,
            available: enabled,
            experimental: {
              runtimeId: "codex-v1",
              disclosure: 1,
              revision: enabled ? 1 : 0,
              enabled,
              renewalRequired: false,
            },
          },
        ],
        profiles: [],
      }),
      createAgentProfile: async (input: unknown) => {
        creates.push(input);
      },
      setAgentExperimental: async (input: unknown) => {
        changes.push(input);
        enabled = true;
      },
    },
  });
  try {
    await pane.ready;
    const form = () => host.querySelector(".glosa-agent-add-account") as HTMLFormElement;
    const submit = () => form().querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(submit().disabled, "account submission stays disabled until the provider is admitted").toBe(true);
    expect(host.textContent).toContain("Enable experimental managed chat above to add an account.");
    expect(host.textContent).not.toContain("Account setup is unavailable in this build.");
    expect(host.textContent).not.toContain("Chat support is not available in this build yet.");
    const name = form().querySelector("input") as HTMLInputElement;
    name.value = "Work";
    const configuration = form().querySelector("select") as HTMLSelectElement;
    configuration.value = "linked";
    configuration.dispatchEvent(new Event("change"));
    const path = form().querySelector('[aria-label="Native configuration directory"]') as HTMLInputElement;
    path.value = "/fixture/native-account";
    path.dispatchEvent(new Event("input"));
    submit().click();
    form().dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(creates).toHaveLength(0);
    const control = host.querySelector(".glosa-agent-experimental button") as HTMLButtonElement;
    expect(control.textContent).toBe("Enable experimental managed chat");
    expect(control.getAttribute("aria-pressed")).toBe("false");
    expect(host.textContent).toContain("Native account isolation, process cleanup and release qualification");
    control.click();
    await flush();
    expect(changes).toHaveLength(0);
    (document.querySelector("dialog .glosa-save") as HTMLButtonElement).click();
    await flush();
    expect(changes).toMatchObject([
      { provider: "codex", runtimeId: "codex-v1", disclosure: 1, revision: 0, enabled: true },
    ]);
    expect(host.querySelector(".glosa-agent-experimental button")?.getAttribute("aria-pressed")).toBe("true");
    expect(host.textContent).toContain("Experimental chat is available");
    expect(submit().disabled).toBe(false);
    expect((form().querySelector("input") as HTMLInputElement).value).toBe("Work");
    expect((form().querySelector("select") as HTMLSelectElement).value).toBe("linked");
    expect((form().querySelector('[aria-label="Native configuration directory"]') as HTMLInputElement).value).toBe(
      "/fixture/native-account",
    );
    form().dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(creates).toMatchObject([
      { provider: "codex", label: "Work", configuration: { mode: "linked", path: "/fixture/native-account" } },
    ]);
  } finally {
    pane.destroy();
  }
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
    installing = false,
    reads = 0;
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
        reads++;
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
    const retry = [...host.querySelectorAll("button")].find((button) => button.textContent === "Refresh settings")!;
    const beforeRefresh = reads;
    expect(retry.hidden).toBe(false);
    expect(retry.disabled).toBe(false);
    retry.click();
    await flush();
    expect(reads).toBeGreaterThan(beforeRefresh);
    expect(retry.textContent).toBe("Refresh settings");
    expect((host.querySelector(".glosa-agent-runtime button") as HTMLButtonElement).disabled).toBe(true);
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
  let reads = 0,
    creates = 0;
  const pane = mountAgentSettings(host, {
    appearance: undefined,
    onChange: undefined,
    dataAccess: {
      getAgentStatus: async () => {
        reads++;
        return {
          available: true,
          providers: [{ id: "codex", name: "Codex", installed: true, qualified: true }],
          profiles: [],
        };
      },
      createAgentProfile: async () => {
        creates++;
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
  const retry = [...host.querySelectorAll("button")].find((button) => button.textContent === "Refresh settings")!;
  expect(retry.hidden).toBe(false);
  retry.click();
  await flush();
  expect(reads).toBe(2);
  expect(creates).toBe(1);
  expect(retry.hidden).toBe(true);
  expect(host.querySelector(".glosa-agent-status")!.textContent).toBe("");
  expect((host.querySelector(".glosa-agent-add-account input") as HTMLInputElement).value).toBe("Work");
  pane.destroy();
});

test("account settings expose actionable health, enabling and default selection without changing other accounts", async () => {
  const { mountAgentSettings } = await import("../src/agent-settings.js");
  const host = document.createElement("div");
  document.body.append(host);
  const profiles = [
    {
      id: "off",
      label: "Personal subscription disabled for this device",
      enabled: false,
      isDefault: false,
      auth: { state: "authenticated", label: "personal@example.com" },
    },
    {
      id: "expired",
      label: "Work",
      enabled: true,
      isDefault: true,
      auth: { state: "expired", label: "work@example.com" },
    },
  ].map((p) => ({ ...p, provider: "codex", revision: 1 }));
  const updates: unknown[] = [];
  const pane = mountAgentSettings(host, {
    appearance: undefined,
    onChange: undefined,
    dataAccess: {
      getAgentStatus: async () => ({
        available: true,
        providers: [{ id: "codex", name: "Codex", installed: true, qualified: true }],
        profiles,
        capabilities: { off: { models: [{ id: "model" }] } },
      }),
      updateAgentProfile: async (id: string, changes: object) => {
        updates.push({ id, ...changes });
        Object.assign(profiles.find((p) => p.id === id)!, changes);
      },
    },
  });
  await pane.ready;
  expect((host.querySelector(".glosa-agent-runtime-maintenance") as HTMLDetailsElement).open).toBe(false);
  const row = host.querySelector('[data-account-choice="expired"]')!;
  expect(row.textContent).toContain("Sign-in expired");
  expect(row.textContent).toContain("Default");
  expect(row.getAttribute("title")).toContain("work@example.com");
  const active = () => host.querySelector(".glosa-agent-account:not([hidden])")!;
  const controls = () => [...active().querySelectorAll<HTMLButtonElement>(".glosa-agent-account-actions > button")];
  expect(controls().map((b) => b.textContent)).toEqual(["Enable account"]);
  expect(active().textContent).toContain("will not restart stopped chats");
  controls()[0]!.click();
  await flush();
  expect(updates).toHaveLength(1);
  expect(updates[0]).toMatchObject({ id: "off", enabled: true });
  expect(profiles[1]!.isDefault).toBe(true);
  expect(controls().map((b) => b.textContent)).toContain("Make default");
  const rename = [...active().querySelectorAll("button")].find((b) => b.textContent === "Rename account")!;
  rename.click();
  const name = active().querySelector("input") as HTMLInputElement;
  expect(document.activeElement).toBe(name);
  name.value = "Uncommitted name";
  name.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(name.value).toBe(profiles[0]!.label);
  expect(updates).toHaveLength(1);
  pane.destroy();
});

test("composer picker binds selections, retains focus and consumes Enter without sending", async () => {
  const host = document.createElement("div"),
    input = document.createElement("textarea");
  document.body.append(host);
  host.append(input);
  let starts = 0;
  const picker = createComposerPicker(input, {
    getFiles: () => ["notes.md", "long notes.md"],
    getCatalog: async () => ({
      loaded: true,
      commands: [{ id: "a", name: "review", kind: "skill", description: "Review writing" }],
    }),
    loadCatalog: async () => {
      starts++;
      return { commands: [], loaded: true };
    },
    onAction: async () => true,
    onChange() {},
  });
  try {
    input.focus();
    input.value = "@no";
    input.setSelectionRange(3, 3);
    input.dispatchEvent(new Event("input"));
    expect(input.getAttribute("aria-expanded")).toBe("true");
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    input.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    expect(input.value).toBe("@notes.md ");
    expect(picker.references).toEqual([{ kind: "file", id: "notes.md", start: 0, end: 9, text: "@notes.md" }]);
    expect(document.activeElement).toBe(input);
    input.value = "/rev";
    input.setSelectionRange(4, 4);
    input.dispatchEvent(new Event("input"));
    await flush();
    expect(starts).toBe(0);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
    expect(input.value).toBe("/review ");
    expect(picker.references[0]?.id).toBe("a");
    input.value = "/revXiew ";
    input.dispatchEvent(new Event("input"));
    expect(picker.references).toEqual([]);
  } finally {
    picker.destroy();
    host.remove();
  }
});

test("composer trigger boundaries and UTF-16 reference edits preserve surrounding writing", () => {
  expect(composerToken("mail@example", 12)).toBeNull();
  expect(composerToken("Please /review", 14)).toBeNull();
  expect(composerToken("  /review", 9)?.start).toBe(2);
  const ref = { kind: "file", id: "a", text: "@a", start: 3, end: 5 };
  expect(editReferences("😀 @a", "x😀 @a", [ref])[0]?.start).toBe(4);
  expect(editReferences("😀 @a", "😀 @ab", [ref])).toEqual([]);
  expect(editReferences("😀 @a", "😀 @z", [ref])).toEqual([]);
});

test("the protocol log shows the journal as written, filters by kind, follows the stream and opens one record", async () => {
  const record = (seq: number, type: string, data: Record<string, unknown> = {}) => ({
    seq,
    at: `2026-10-04T10:00:0${seq}.000Z`,
    type,
    bytes: 100 + seq,
    data: { type, ...data },
  });
  const pages: unknown[] = [];
  let stream: any;
  const dataAccess = {
    getChatLog: async (_s: string, _i: string, before?: number) => {
      pages.push(before);
      return before
        ? { total: 4, hasEarlier: false, records: [record(1, "created", { chat: { title: "T" } })] }
        : {
            total: 4,
            hasEarlier: true,
            records: [
              record(2, "turn", { turn: { status: "accepted" } }),
              record(3, "runtime", { state: "spawned" }),
              record(4, "turn_status", { turnId: "t", status: "running" }),
            ],
          };
    },
    openChatStream: (_s: string, _i: string, callbacks: any) => {
      stream = callbacks;
      return () => {};
    },
  };
  const host = document.createElement("div");
  document.body.append(host);
  const pane = createChatLogPane(host, { dataAccess, slug: "ws", chatId: "chat", title: "Draft review" });
  await pane.ready;
  await flush();
  const rows = () => [...host.querySelectorAll(".glosa-chat-log-record")] as HTMLElement[];
  expect(pane.title).toBe("Log · Draft review");
  expect(rows().map((row) => row.querySelector(".glosa-chat-log-seq")!.textContent)).toEqual(["2", "3", "4"]);
  expect(rows()[2]!.querySelector(".glosa-chat-log-gist")!.textContent).toBe("running");
  expect(host.querySelector(".glosa-chat-log-count")!.textContent).toBe("4 records");
  // A record arriving on the stream joins the end; a gap means the page is read again, not guessed.
  stream.onEvent({
    event: "chat_event",
    data: { seq: 5, at: "2026-10-04T10:00:05.000Z", data: { type: "content", content: { kind: "text", text: "hi" } } },
  });
  expect(rows().map((row) => row.querySelector(".glosa-chat-log-seq")!.textContent)).toEqual(["2", "3", "4", "5"]);
  expect(rows()[3]!.querySelector(".glosa-chat-log-gist")!.textContent).toBe("text · 2 chars");
  // One kind at a time, from what the journal holds.
  const select = host.querySelector("select") as HTMLSelectElement;
  expect([...select.options].map((option) => option.value)).toEqual([
    "all",
    "content",
    "runtime",
    "turn",
    "turn_status",
  ]);
  select.value = "turn_status";
  select.dispatchEvent(new Event("change"));
  expect(rows().map((row) => row.querySelector(".glosa-chat-log-seq")!.textContent)).toEqual(["4"]);
  select.value = "all";
  select.dispatchEvent(new Event("change"));
  // The record itself, on request only.
  const first = rows()[0]!;
  expect(first.querySelector("pre")!.textContent).toBe("");
  (first as any).open = true;
  first.dispatchEvent(new Event("toggle"));
  expect(JSON.parse(first.querySelector("pre")!.textContent!)).toMatchObject({ seq: 2, type: "turn" });
  // Earlier records go in front.
  (host.querySelector(".glosa-chat-log-scroll > button") as HTMLButtonElement).click();
  await flush();
  expect(pages).toEqual([undefined, 2]);
  expect(rows().map((row) => row.querySelector(".glosa-chat-log-seq")!.textContent)).toEqual(["1", "2", "3", "4", "5"]);
  expect((host.querySelector(".glosa-chat-log-scroll > button") as HTMLButtonElement).hidden).toBe(true);
  pane.destroy();
  expect(host.children).toHaveLength(0);
});

test("recovery storage finishes before a submitted message leaves the composer or reaches the daemon", async () => {
  const f = fixture();
  let release!: () => void;
  let attempted = false;
  f.dataAccess.writeChatRecovery = async (_slug: string, _id: string, value: any) => {
    if (value.outbox.length && !attempted) {
      attempted = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
  };
  await f.pane.ready;
  const draft = f.host.querySelector('[aria-label="Message"]') as HTMLTextAreaElement;
  draft.value = "Keep these exact words";
  draft.dispatchEvent(new Event("input", { bubbles: true }));
  draft.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await flush();
  expect(attempted).toBe(true);
  expect(draft.value).toBe("Keep these exact words");
  expect(f.saves).toHaveLength(0);
  expect(f.sends).toHaveLength(0);
  release();
  await flush();
  expect(draft.value).toBe("");
  expect(f.sends[0].text).toBe("Keep these exact words");
});

test("a recovery storage refusal keeps text and attachments editable and does not send", async () => {
  const f = fixture();
  const attachment = { name: "brief.md", mime: "text/markdown", hash: "a".repeat(64), size: 5 };
  f.state.draft = "Do not lose this";
  f.state.draftAttachments = [attachment];
  f.dataAccess.writeChatRecovery = async () => {
    throw new Error("Recovery storage is unavailable");
  };
  await f.pane.ready;
  (f.host.querySelector('[aria-label="Send message"]') as HTMLButtonElement).click();
  await flush();
  expect((f.host.querySelector('[aria-label="Message"]') as HTMLTextAreaElement).value).toBe("Do not lose this");
  expect(f.host.querySelector('[aria-label="Remove brief.md"]')).not.toBeNull();
  expect(f.sends).toHaveLength(0);
  expect(f.saves).toHaveLength(0);
  expect(f.host.querySelector(".glosa-chat-status")!.textContent).toContain("storage is unavailable");
});

test("reopening restores an ambiguous send and draft without posting until the person retries the exact receipt", async () => {
  const f = fixture();
  const intent = {
    requestId: "request-original",
    turnId: "turn-original",
    configRevision: 1,
    draftRevision: 0,
    text: "Original request",
    references: [],
    attachments: [],
  };
  f.dataAccess.readChatRecovery = async () => ({
    version: 1,
    draft: { text: "New unsent draft", attachments: [], references: [], baseRevision: 0, dirty: true },
    outbox: [
      {
        id: "turn-original",
        text: "Original request",
        references: [],
        attachments: [],
        state: "sending",
        intent,
        unsaved: false,
      },
    ],
  });
  f.dataAccess.writeChatRecovery = async () => {};
  await f.pane.ready;
  await flush();
  expect(f.sends).toHaveLength(0);
  expect(f.saves).toHaveLength(0);
  expect((f.host.querySelector('[aria-label="Message"]') as HTMLTextAreaElement).value).toBe("New unsent draft");
  expect(f.host.querySelector(".glosa-chat-tray")!.textContent).toContain("Original request");
  (f.host.querySelector('[aria-label="Retry sending message"]') as HTMLButtonElement).click();
  await flush();
  expect(f.sends).toEqual([intent]);
});

test("a recovered message already acknowledged by the journal is reconciled without restoring its consumed draft", async () => {
  const f = fixture();
  f.state.turns.push({ id: "known", text: "Already accepted", status: "completed" });
  f.dataAccess.readChatRecovery = async () => ({
    version: 1,
    draft: { text: "Already accepted", attachments: [], references: [], baseRevision: 0, dirty: true },
    outbox: [
      {
        id: "known",
        text: "Already accepted",
        references: [],
        attachments: [],
        state: "sending",
        intent: { requestId: "known-request", turnId: "known" },
        unsaved: false,
      },
    ],
  });
  await f.pane.ready;
  await flush();
  expect(f.sends).toHaveLength(0);
  expect(f.saves).toHaveLength(0);
  expect((f.host.querySelector('[aria-label="Message"]') as HTMLTextAreaElement).value).toBe("");
  expect(f.host.querySelectorAll(".glosa-chat-tray li")).toHaveLength(0);
  expect(f.host.querySelectorAll('.glosa-chat-message[data-kind="human"]')).toHaveLength(1);
});

test("a streamed acknowledgement before the HTTP response cannot remove the following local message", async () => {
  const f = fixture();
  let answer!: () => void;
  f.dataAccess.sendChatTurn = async (_slug: string, _id: string, input: any) => {
    f.sends.push(input);
    f.state.turns.push({ id: input.turnId, text: input.text, status: "queued", at: new Date().toISOString() });
    f.state.draft = "";
    f.state.draftRevision++;
    f.state.revision++;
    if (f.sends.length === 1)
      await new Promise<void>((resolve) => {
        answer = resolve;
      });
  };
  await f.pane.ready;
  await type(f, "First request");
  await type(f, "Second request");
  expect(f.sends.map((input) => input.text)).toEqual(["First request"]);
  await f.snapshot();
  expect(f.host.querySelector(".glosa-chat-tray")!.textContent).toContain("Second request");
  answer();
  await flush();
  expect(f.sends.map((input) => input.text)).toEqual(["First request", "Second request"]);
  expect(f.state.turns.map((turn) => turn.text)).toEqual(["First request", "Second request"]);
});

test("decision retries retain their original generation and choice while a new generation gets a new receipt", async () => {
  const f = fixture();
  const posts: any[] = [];
  f.dataAccess.answerChatDecision = async (_slug: string, _id: string, input: any) => {
    posts.push(input);
    throw new Error("Response lost");
  };
  const store = createChatStore(f.dataAccess, "ws", "decision-store");
  try {
    await store.ready;
    const decision = { id: "permission", generation: "first" };
    await store.answerDecision(decision, "allow", "Scoped response").catch(() => {});
    await store.answerDecision(decision, "deny", "Changed response").catch(() => {});
    expect(posts[1]).toEqual(posts[0]);
    await store.answerDecision({ ...decision, generation: "second" }, "deny", "New request").catch(() => {});
    expect(posts[2].generation).toBe("second");
    expect(posts[2].choice).toBe("deny");
    expect(posts[2].requestId).not.toBe(posts[0].requestId);
  } finally {
    await store.dispose();
  }
});

test("a saved composer survives the next unrelated journal event with its text, references and attachments", async () => {
  const f = fixture();
  f.state.turns.push({ id: "active", text: "An earlier request", status: "running" });
  f.dataAccess.uploadChatAttachment = async () => ({
    name: "outline.md",
    mime: "text/markdown",
    size: 2,
    hash: "a".repeat(64),
  });
  const store = createChatStore(f.dataAccess, "ws", "saved-draft-store");
  try {
    await store.ready;
    const reference = { start: 5, end: 16, kind: "file", id: "outline.md" };
    store.setDraft("Read @outline.md before continuing", [reference]);
    await store.attach([new File(["ok"], "outline.md")]);
    expect(store.getSnapshot().draft.dirty).toBe(false);
    await f.event({ seq: 2, data: { type: "turn_status", turnId: "active", status: "completed" } });
    expect(store.getSnapshot().draft.text).toBe("Read @outline.md before continuing");
    expect(store.getSnapshot().draft.references).toEqual([reference]);
    expect(store.getSnapshot().draft.attachments.map((item: any) => item.name)).toEqual(["outline.md"]);
  } finally {
    await store.dispose();
  }
});

test("an explicit executed-turn retry survives draft recovery and a lost acknowledgement with one new linked intent", async () => {
  const f = fixture();
  const prior = { id: "previous-turn", attemptId: "previous-attempt", text: "Review the opening", status: "failed" };
  f.state.turns.push(prior);
  let recovery: any;
  f.dataAccess.writeChatRecovery = async (_slug: string, _id: string, value: any) => {
    recovery = structuredClone(value);
  };
  f.dataAccess.readChatRecovery = async () => structuredClone(recovery);
  let store = createChatStore(f.dataAccess, "ws", "linked-retry");
  try {
    await store.ready;
    await store.retryTurn(prior);
    expect(recovery.draft.retryOfTurnId).toBe(prior.id);
    await store.dispose();
    store = createChatStore(f.dataAccess, "ws", "linked-retry");
    await store.ready;
    expect(store.getSnapshot().draft.retryOfTurnId).toBe(prior.id);
    expect(f.sends).toHaveLength(0);
    await store.submit();
    expect(f.sends[0].retryOfTurnId).toBe(prior.id);
    expect(f.sends[0].turnId).not.toBe(prior.id);
    expect(store.getSnapshot().draft.retryOfTurnId).toBeNull();
    await store.retryOutbox();
    expect(f.sends[1]).toEqual(f.sends[0]);
    await store.replaceDraft({ text: "An unrelated request" });
    expect(store.getSnapshot().draft.retryOfTurnId).toBeNull();
    await store.retryTurn(prior);
    store.setDraft("");
    expect(store.getSnapshot().draft.retryOfTurnId).toBeNull();
  } finally {
    await store.dispose();
  }
});

test("a token delta preserves settled message objects and excludes unhydrated historical metadata", async () => {
  const f = fixture();
  f.state.turns = Array.from({ length: 2000 }, (_, index) => ({ id: `old-${index}`, status: "completed" }));
  f.state.turns.push(
    { id: "settled", text: "Previous question", status: "completed" },
    { id: "active", text: "Current question", status: "running" },
  );
  (f.state.content as any[]) = [
    { id: "past", turnId: "settled", kind: "text", text: "Previous reply" },
    { id: "live", turnId: "active", kind: "text", text: "A" },
  ];
  const store = createChatStore(f.dataAccess, "ws", "projection-store");
  try {
    await store.ready;
    const { projectChatMessages } = await import("../src/chat-runtime.js");
    const cache = new Map();
    const first = projectChatMessages(store.getSnapshot(), cache);
    expect(first).toHaveLength(4);
    const old = store.getSnapshot().chat;
    const next = { ...old, content: [old.content[0], { ...old.content[1], text: "AB" }] };
    const second = projectChatMessages({ ...store.getSnapshot(), chat: next }, cache);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
    expect(second[3]).not.toBe(first[3]);
    expect(second[3]!.content).toEqual([{ type: "text", text: "AB" }]);
  } finally {
    await store.dispose();
  }
});

test("journal acknowledgement remains authoritative when the original send HTTP response is lost", async () => {
  const f = fixture();
  let loseResponse!: () => void;
  f.dataAccess.sendChatTurn = async (_slug: string, _id: string, input: any) => {
    f.sends.push(input);
    f.state.turns.push({ id: input.turnId, text: input.text, status: "queued", at: new Date().toISOString() });
    f.state.draft = "";
    f.state.draftRevision++;
    f.state.revision++;
    if (f.sends.length === 1) {
      await new Promise<void>((resolve) => {
        loseResponse = resolve;
      });
      throw new Error("HTTP response lost after acceptance");
    }
  };
  await f.pane.ready;
  await type(f, "Accepted first");
  await type(f, "Keep following message");
  await f.snapshot();
  loseResponse();
  await flush();
  expect(f.sends.map((input) => input.text)).toEqual(["Accepted first", "Keep following message"]);
  expect(f.host.querySelector(".glosa-chat-status")!.textContent).not.toContain("HTTP response lost");
  expect(f.host.querySelectorAll('.glosa-chat-tray li[data-kind="failed"]')).toHaveLength(0);
});

test("opening recovered work with an empty model catalog never starts model discovery", async () => {
  const f = fixture({ models: [] });
  const calls: string[] = [];
  f.dataAccess.readChatRecovery = async () => ({
    version: 1,
    draft: { text: "Recovered prompt", dirty: true, baseRevision: 0, attachments: [], references: [] },
    outbox: [],
  });
  f.dataAccess.discoverAgentModels = async () => {
    calls.push("discover");
  };
  await f.pane.ready;
  await flush();
  expect(calls).toEqual([]);
  expect(f.sends).toHaveLength(0);
  expect(f.saves).toHaveLength(0);
  expect((f.host.querySelector('[aria-label="Message"]') as HTMLTextAreaElement).value).toBe("Recovered prompt");
});

test("hydrated journal changes project draft consumption, queued revision and attempt identity without a snapshot", () => {
  const state: any = {
    revision: 1,
    configRevision: 1,
    title: "New chat",
    draftRevision: 0,
    draft: "",
    turns: [],
    content: [],
    decisions: [],
  };
  expect(
    applyChatEvent(state, {
      seq: 2,
      data: { type: "draft", revision: 1, text: "Original", textHash: "hash", attachments: [], references: [] },
    }),
  ).toBe(state);
  expect(state.draft).toBe("Original");
  applyChatEvent(state, {
    seq: 3,
    data: {
      type: "turn",
      turn: { id: "turn", text: "Original", status: "queued" },
      consumedDraftRevision: 1,
      title: "Original",
    },
  });
  expect([state.draft, state.draftRevision, state.title]).toEqual(["", 2, "Original"]);
  applyChatEvent(state, {
    seq: 4,
    data: { type: "turn_revised", turnId: "turn", revision: 2, text: "Revised", attachments: [], references: [] },
  });
  expect(state.turns[0]).toMatchObject({ text: "Revised", revision: 2 });
  applyChatEvent(state, {
    seq: 5,
    data: { type: "turn_status", turnId: "turn", status: "running", attemptId: "attempt" },
  });
  expect(state.turns[0]).toMatchObject({ status: "running", started: true, attemptId: "attempt" });
  applyChatEvent(state, { seq: 6, data: { type: "changed", pinned: true } });
  expect([state.pinned, state.configRevision]).toEqual([true, 2]);
});

test("Retry after an initial chat read failure creates a fresh read and restores the usable composer", async () => {
  const f = fixture();
  const read = f.dataAccess.getChat;
  let calls = 0;
  f.dataAccess.getChat = async (...args: any[]) => {
    if (++calls === 1) throw new Error("Daemon temporarily unavailable");
    return read(...args);
  };
  await f.pane.ready;
  expect(f.host.textContent).toContain("Daemon temporarily unavailable");
  [...f.host.querySelectorAll("button")].find((button) => button.textContent === "Retry")!.click();
  await f.pane.ready;
  expect(calls).toBe(2);
  expect(f.host.querySelector('[aria-label="Message"]')).not.toBeNull();
  expect(f.sends).toHaveLength(0);
});

test("closing while recovery is being read never opens a later stream or starts model discovery", async () => {
  const f = fixture({ models: [] });
  let finish!: () => void;
  let streams = 0;
  let discoveries = 0;
  f.dataAccess.readChatRecovery = () =>
    new Promise<null>((resolve) => {
      finish = () => resolve(null);
    });
  f.dataAccess.openChatStream = () => {
    streams++;
    return () => {};
  };
  f.dataAccess.discoverAgentModels = async () => {
    discoveries++;
  };
  await flush();
  f.pane.destroy();
  finish();
  await f.pane.ready;
  expect(streams).toBe(0);
  expect(discoveries).toBe(0);
  expect(f.host.children).toHaveLength(0);
});

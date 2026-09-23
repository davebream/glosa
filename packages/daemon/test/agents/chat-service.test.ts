// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentEvent,
  type AgentInput,
  type ManagedAgentAdapter,
  ManagedAgentRegistry,
  type OwnedProcess,
  type ProcessLauncher,
} from "../../src/agents/interface.ts";
import { ManagedChatService, type ChatServiceOptions } from "../../src/chats/service.ts";
import { WorkspaceBus } from "../../src/bus/bus.ts";
import { KeyedMutex } from "../../src/bus/mutex.ts";
import { workspaceRegistrationId } from "../../src/workspace.ts";
import { createManagedTools } from "../../src/agents/managed-tools.ts";
import { AgentStore } from "../../src/chats/store.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function eventually(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await Bun.sleep(2);
  }
  throw new Error("observable boundary was not reached");
}
function setup(options: Partial<ChatServiceOptions> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "glosa-chat-service-")));
  const store = new AgentStore(root),
    registry = new ManagedAgentRegistry();
  const events = new Map<string, (event: AgentEvent) => void>();
  const specs: import("../../src/agents/interface.ts").SessionLaunchSpec[] = [];
  const inputs: AgentInput[] = [],
    writes: string[] = [];
  let spawns = 0,
    observeInterrupt = false,
    holdStart: Promise<void> | undefined;
  const launcher: ProcessLauncher = {
    async spawn() {
      spawns++;
      let end!: (exit: Awaited<OwnedProcess["exited"]>) => void;
      const exited = new Promise<Awaited<OwnedProcess["exited"]>>((resolve) => {
        end = resolve;
      });
      return {
        pid: 123,
        exited,
        async write(data) {
          writes.push(data);
        },
        async fence() {},
        async stop() {
          end({ code: 0, signal: null, groupEmpty: true });
        },
        resize() {},
      };
    },
  };
  const adapter: ManagedAgentAdapter = {
    id: "fixture",
    name: "Fixture",
    authHosts: [],
    loginArgs: () => [],
    logoutArgs: () => [],
    profileEnvironment: (dir) => ({ FIXTURE_HOME: dir }),
    probe: async () => ({
      state: "authenticated",
      identity: "account-a",
      method: "subscription",
      observedAt: new Date().toISOString(),
    }),
    async connect(spec, owner, event) {
      specs.push(spec);
      const child = await owner.spawn({ command: "/fixture", args: [], cwd: spec.cwd, env: spec.env, onData() {} });
      events.set(spec.sessionId, event);
      return {
        capabilities: {
          models: [{ id: "model-a", name: "A", efforts: ["high", "low"] }],
          resume: true,
          images: false,
          permissions: true,
          questions: true,
          mcp: false,
        },
        async startTurn(input) {
          inputs.push(input);
          if (holdStart) await holdStart;
          await child.write(`turn:${input.turnId}`);
        },
        async answer(id, choice) {
          await child.write(`answer:${id}:${choice}`);
        },
        async interrupt() {
          if (observeInterrupt) await child.write("interrupt");
        },
        async close() {
          await child.stop();
        },
      };
    },
  };
  registry.register(adapter);
  const workspace = { id: "b".repeat(64), epoch: "registration-1", path: root };
  let service = new ManagedChatService({
    store,
    registry,
    launcher,
    workspace: () => workspace,
    manifest: () => ({
      id: "fixture",
      provider: "fixture",
      version: "1",
      executable: "/fixture",
      executableSha256: "0".repeat(64),
      qualified: true,
    }),
    releaseEnabled: true,
    ...options,
  });
  const profile = service.createProfile({ requestId: randomUUID(), provider: "fixture", label: "Personal" });
  store.saveProfiles([
    { ...profile, auth: { state: "authenticated", identity: "account-a", observedAt: new Date().toISOString() } },
  ]);
  store.setConsent(profile.id, workspace.id, workspace.epoch, true);
  function chat() {
    return service.create(workspace, {
      id: randomUUID(),
      requestId: randomUUID(),
      provider: "fixture",
      profileId: profile.id,
      settings: { model: "model-a", effort: "high", permissionMode: "default" },
    });
  }
  function send(chatId: string, text = "hello") {
    const state = store.chat(chatId).state;
    const request = {
      requestId: randomUUID(),
      turnId: randomUUID(),
      configRevision: state.configRevision,
      draftRevision: state.draftRevision,
      text,
    };
    service.send(workspace, chatId, request);
    return request;
  }
  cleanup.push(async () => {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    service,
    store,
    workspace,
    profile,
    chat,
    send,
    events,
    inputs,
    specs,
    writes,
    observeInterrupt: () => {
      observeInterrupt = true;
    },
    spawns: () => spawns,
    hold: (promise: Promise<void>) => {
      holdStart = promise;
    },
    replace(next: ManagedChatService) {
      service = next;
    },
    root,
    registry,
    launcher,
  };
}

test("durable duplicate Send never calls the native adapter twice and freezes turn settings", async () => {
  const h = setup(),
    chat = h.chat(),
    request = h.send(chat.id);
  expect(h.service.send(h.workspace, chat.id, request)).toEqual({ turnId: request.turnId });
  h.service.change(h.workspace, chat.id, {
    requestId: randomUUID(),
    revision: 1,
    settings: { model: "model-a", effort: "low", permissionMode: "default" },
  });
  await eventually(() => h.writes.length === 1);
  expect(h.inputs).toHaveLength(1);
  expect(h.inputs[0]?.settings.effort).toBe("high");
  expect(() => h.service.send(h.workspace, chat.id, { ...request, text: "changed" })).toThrow("different input");
});

test("disabling an account while dispatch is paused prevents a later native handoff", async () => {
  const h = setup(),
    chat = h.chat();
  let release!: () => void;
  h.hold(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  h.send(chat.id);
  await eventually(() => h.inputs.length === 1);
  await h.service.updateProfile(h.profile.id, { requestId: randomUUID(), revision: 1, enabled: false });
  release();
  await Bun.sleep(10);
  expect(h.writes).toEqual([]);
  expect(h.store.chat(chat.id).state.turns[0]?.status).toBe("cancelled");
  expect(h.store.profile(h.profile.id).epoch).toBe(1);
});

test("decision reservation admits exactly one response across competing browser requests", async () => {
  const h = setup(),
    chat = h.chat();
  h.send(chat.id);
  await eventually(() => h.writes.length === 1);
  h.events.get(chat.sessionId)!({
    type: "decision",
    decision: {
      id: "native-permission",
      kind: "permission",
      title: "Run command?",
      detail: "A tool needs permission",
      choices: [
        { id: "allow", label: "Allow once" },
        { id: "deny", label: "Deny" },
      ],
    },
  });
  const state = h.store.chat(chat.id).state,
    decision = state.decisions[0]!;
  const answer = { requestId: randomUUID(), decisionId: decision.id, generation: decision.generation, choice: "allow" };
  const first = h.service.answer(h.workspace, chat.id, answer);
  await expect(h.service.answer(h.workspace, chat.id, { ...answer, requestId: randomUUID() })).rejects.toThrow(
    "no longer available",
  );
  await first;
  await h.service.answer(h.workspace, chat.id, answer);
  expect(h.writes.filter((item) => item.startsWith("answer:"))).toEqual(["answer:native-permission:allow"]);
});

test("per-profile admission holds a third chat until a running turn completes", async () => {
  const h = setup(),
    first = h.chat(),
    second = h.chat(),
    third = h.chat();
  h.send(first.id);
  h.send(second.id);
  h.send(third.id);
  await eventually(() => h.writes.length === 2);
  expect(h.spawns()).toBe(2);
  expect(h.store.chat(third.id).state.turns[0]?.status).toBe("queued");
  h.events.get(first.sessionId)!({ type: "completed" });
  await eventually(() => h.writes.length === 3);
  expect(h.spawns()).toBe(3);
});

test("reopening history neither spawns nor replays an uncertain submitted turn", async () => {
  const h = setup(),
    chat = h.chat();
  h.send(chat.id);
  await eventually(() => h.writes.length === 1);
  // Independent replay of the durable file models a killed parent, not graceful shutdown.
  const recoveryRoot = realpathSync(mkdtempSync(join(tmpdir(), "glosa-chat-replay-")));
  cleanup.push(async () => rmSync(recoveryRoot, { recursive: true, force: true }));
  cpSync(h.root, recoveryRoot, { recursive: true });
  const recoveredStore = new AgentStore(recoveryRoot);
  let unexpected = 0;
  const recovered = new ManagedChatService({
    store: recoveredStore,
    registry: h.registry,
    workspace: () => h.workspace,
    launcher: {
      async spawn() {
        unexpected++;
        throw new Error("history must not spawn");
      },
    },
    manifest: () => undefined,
    releaseEnabled: true,
  });
  expect(recovered.snapshot(h.workspace, chat.id).turns[0]?.status).toBe("outcome_unknown");
  expect(unexpected).toBe(0);
  await recovered.close();
  // Replay writes only to the copied crash image; the original owner remains isolated.
});

test("workspace consent does not survive removal and re-registration at the same path", async () => {
  const h = setup();
  expect(h.store.consent(h.profile.id, h.workspace.id, h.workspace.epoch)).toBe(true);
  expect(h.store.consent(h.profile.id, h.workspace.id, "registration-2")).toBe(false);
});

test("managed MCP grants cannot administer accounts, accept browser origins, or survive profile disable", async () => {
  const calls: unknown[] = [];
  const h = setup({
    tools: {
      list: [{ name: "fixture" }],
      async call(context, name, args) {
        context.assertActive();
        calls.push({ session: context.chat.sessionId, name, args });
        return { ok: true };
      },
    },
  });
  h.service.setMcpOrigin("http://127.0.0.1:4646");
  const chat = h.chat();
  h.send(chat.id);
  await eventually(() => h.inputs.length === 1);
  const grant = h.specs[0]!.mcp!.grant;
  const request = (token: string, method: string, origin?: string) =>
    new Request("http://127.0.0.1:4646/api/managed-mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, ...(origin ? { Origin: origin } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { name: "fixture", arguments: {} } }),
    });
  expect((await h.service.managedMcp(request("browser-token", "tools/list"))).status).toBe(403);
  expect((await h.service.managedMcp(request(grant, "tools/list", "http://127.0.0.1:4646"))).status).toBe(403);
  expect(await (await h.service.managedMcp(request(grant, "profiles/create"))).json()).toMatchObject({
    error: { code: -32601 },
  });
  expect(await (await h.service.managedMcp(request(grant, "tools/call"))).json()).toMatchObject({
    result: { content: [{ type: "text", text: '{"ok":true}' }] },
  });
  expect(calls).toEqual([{ session: chat.sessionId, name: "fixture", args: {} }]);
  await h.service.updateProfile(h.profile.id, {
    requestId: randomUUID(),
    revision: h.profile.revision,
    enabled: false,
  });
  expect((await h.service.managedMcp(request(grant, "tools/call"))).status).toBe(403);
  expect(calls).toHaveLength(1);
});

test("failed native sign-out leaves disabled retryable cleanup, then removes only the selected profile", async () => {
  let fail = true;
  const calls: string[] = [];
  const h = setup({
    launcher: {
      async spawn(options) {
        calls.push(options.env.FIXTURE_HOME!);
        return {
          pid: 123,
          exited: Promise.resolve({ code: fail ? 1 : 0, signal: null, groupEmpty: true }),
          async write() {},
          async fence() {},
          async stop() {},
          resize() {},
        };
      },
    },
  });
  const other = h.service.createProfile({ requestId: randomUUID(), provider: "fixture", label: "Other" });
  const firstPath = join(h.root, "profiles", h.profile.id, "native"),
    otherPath = join(h.root, "profiles", other.id, "native");
  for (const path of [firstPath, otherPath]) {
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "credential"), "fixture-secret");
  }
  const request = { requestId: randomUUID(), revision: 1, remove: true };
  await expect(h.service.signOut(h.profile.id, request)).rejects.toThrow("did not complete");
  expect(h.store.profile(h.profile.id)).toMatchObject({ enabled: false, cleanup: "remove" });
  expect(existsSync(firstPath)).toBe(true);
  fail = false;
  expect(await h.service.signOut(h.profile.id, request)).toMatchObject({ removed: true });
  expect(existsSync(firstPath)).toBe(false);
  expect(existsSync(otherPath)).toBe(true);
  await h.service.signOut(h.profile.id, request);
  expect(calls).toEqual([firstPath, firstPath]);
});

test("workspace purge deletes transcript bytes and blobs and its tombstone prevents resurrection", async () => {
  const h = setup(),
    chat = h.chat();
  h.service.saveDraft(h.workspace, chat.id, {
    requestId: randomUUID(),
    revision: 0,
    text: "private draft",
    attachments: [],
  });
  const other = h.store.create(
    {
      id: randomUUID(),
      sessionId: randomUUID(),
      workspaceId: "c".repeat(64),
      workspaceEpoch: chat.workspaceEpoch,
      workspacePath: chat.workspacePath,
      provider: chat.provider,
      profileId: chat.profileId,
      title: chat.title,
      settings: chat.settings,
      origin: "managed",
    },
    randomUUID(),
  );
  await h.service.fenceWorkspace(h.workspace);
  h.service.forgetWorkspace(h.workspace);
  expect(existsSync(join(h.root, "chats", chat.id))).toBe(false);
  expect(() => h.store.chat(chat.id)).toThrow("deleted");
  expect(h.store.chat(other.state.id).state.title).toBe("New chat");
  h.service.forgetWorkspace(h.workspace);
});

test("managed tools reject another target and recheck authority after the workspace mutex wait", async () => {
  const h = setup(),
    chat = h.chat(),
    mutex = new KeyedMutex<string>();
  const bus = new WorkspaceBus(h.root, { mutex });
  cleanup.unshift(async () => {
    await bus.close();
  });
  await bus.createEntry("mine", {
    kind: "conversation_message",
    text: "For me",
    target_session_id: chat.sessionId,
    provider: "fixture",
  });
  await bus.createEntry("other", {
    kind: "conversation_message",
    text: "Private",
    target_session_id: "other-session",
    provider: "fixture",
  });
  const tools = createManagedTools(async () => bus);
  let active = true;
  const context = {
    chat,
    reservations: new Set<string>(),
    assertActive() {
      if (!active) throw new Error("revoked");
    },
  };
  await expect(tools.call(context, "glosa_inbox_get", { id: "other" })).rejects.toThrow("not available");
  await expect(tools.call(context, "glosa_inbox_pull", { session_id: "other-session" })).rejects.toThrow(
    "another session",
  );
  const delivery = (await tools.call(context, "glosa_inbox_pull", {})) as { delivery_id: string; count: number };
  expect(delivery.count).toBe(1);
  let release!: () => void;
  const holding = mutex.runExclusive(
    workspaceRegistrationId(h.root),
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await eventually(() => !!release);
  const ack = tools.call(context, "glosa_delivery_ack", { delivery_id: delivery.delivery_id });
  await Promise.resolve();
  await Promise.resolve();
  active = false;
  release();
  await holding;
  await expect(ack).rejects.toThrow("revoked");
  expect(bus.state.entries.mine?.status).toBe("pending");
  expect(bus.state.entries.mine?.deliveryAttempts).toHaveLength(0);
});

test("pending feedback stays idle until Send feedback freezes its references without consuming the draft", async () => {
  let bus!: WorkspaceBus;
  const h = setup({ tools: createManagedTools(async () => bus) }),
    chat = h.chat();
  bus = new WorkspaceBus(h.root);
  cleanup.unshift(async () => {
    await bus.close();
  });
  await bus.createEntry("feedback-1", {
    kind: "conversation_message",
    text: "Clarify this",
    target_session_id: chat.sessionId,
    provider: "fixture",
  });
  h.service.saveDraft(h.workspace, chat.id, {
    requestId: randomUUID(),
    revision: 0,
    text: "Keep my draft",
    attachments: [],
  });
  expect(await h.service.feedback(h.workspace, chat.id)).toMatchObject({ entryIds: ["feedback-1"] });
  expect(h.spawns()).toBe(0);
  const request = { requestId: randomUUID(), turnId: randomUUID(), configRevision: 1 };
  await h.service.sendFeedback(h.workspace, chat.id, request);
  await eventually(() => h.writes.length === 1);
  await bus.createEntry("feedback-2", {
    kind: "conversation_message",
    text: "Later",
    target_session_id: chat.sessionId,
    provider: "fixture",
  });
  await h.service.sendFeedback(h.workspace, chat.id, request);
  expect(h.inputs).toHaveLength(1);
  expect(h.store.chat(chat.id).state.turns[0]).toMatchObject({ origin: "feedback", feedbackIds: ["feedback-1"] });
  expect(h.service.snapshot(h.workspace, chat.id).draft).toBe("Keep my draft");
  const tools = createManagedTools(async () => bus);
  const prepared = (await tools.call(
    { chat, assertActive() {}, reservations: new Set(), feedbackIds: ["feedback-1"] },
    "glosa_inbox_pull",
    {},
  )) as { drained: { id: string }[] };
  expect(prepared.drained.map((entry) => entry.id)).toEqual(["feedback-1"]);
});

test("MCP scope changes fence the running chat and revoke earlier endpoint consent", async () => {
  const h = setup(),
    chat = h.chat();
  h.send(chat.id);
  await eventually(() => h.writes.length === 1);
  const servers = [
    { id: "docs", label: "Docs", enabled: true, transport: "http" as const, url: "https://tools.example.test/mcp" },
  ];
  await h.service.changeMcpPolicy(h.workspace, h.profile.id, { revision: 0, servers });
  expect(h.store.chat(chat.id).state.runtime?.state).toBe("stopped");
  expect(() => h.send(chat.id)).toThrow("approve this account");
  await h.service.consent(h.workspace, h.profile.id, true);
  h.send(chat.id);
  await eventually(() => h.writes.length === 2);
  expect(h.specs[1]?.servers).toEqual(servers);
  await h.service.consent(h.workspace, h.profile.id, false);
  expect(() => h.send(chat.id)).toThrow("approve this account");
});

test("multi-part answers are validated before reservation and withdrawn questions cannot be answered", async () => {
  const h = setup(),
    chat = h.chat();
  h.send(chat.id);
  await eventually(() => h.inputs.length === 1);
  const emit = h.events.get(chat.sessionId)!;
  emit({
    type: "decision",
    decision: {
      id: "questions",
      kind: "question",
      title: "Choose",
      detail: "",
      allowText: true,
      choices: [
        { id: "answer", label: "Answer" },
        { id: "deny", label: "Cancel" },
      ],
      questions: [
        { id: "one", question: "First?", options: [], multiple: false },
        { id: "two", question: "Second?", options: [], multiple: true },
      ],
    },
  });
  const decision = h.store.chat(chat.id).state.decisions[0]!;
  const input = {
    requestId: randomUUID(),
    decisionId: decision.id,
    generation: decision.generation,
    choice: "answer",
    text: JSON.stringify({ one: ["A"] }),
  };
  await expect(h.service.answer(h.workspace, chat.id, input)).rejects.toThrow("Answer each question");
  expect(h.store.chat(chat.id).state.decisions[0]!.status).toBe("pending");
  expect(h.writes.some((value) => value.startsWith("answer:"))).toBe(false);
  await h.service.answer(h.workspace, chat.id, { ...input, text: JSON.stringify({ one: ["A"], two: ["B", "C"] }) });
  expect(h.writes.filter((value) => value.startsWith("answer:"))).toHaveLength(1);
  emit({
    type: "decision",
    decision: {
      id: "withdrawn",
      kind: "permission",
      title: "Write?",
      detail: "",
      choices: [{ id: "allow", label: "Allow" }],
    },
  });
  emit({ type: "decision_closed", id: "withdrawn" });
  expect(h.store.chat(chat.id).state.decisions.at(-1)!.status).toBe("expired");
});

test("history pages logical messages without truncating exports or starting a runtime", async () => {
  const h = setup(),
    chat = h.chat();
  h.send(chat.id, "original prompt");
  await eventually(() => h.inputs.length === 1);
  const emit = h.events.get(chat.sessionId)!;
  for (let i = 0; i < 135; i++) emit({ type: "text", id: i === 0 ? "user" : `message-${i}`, text: `Text ${i}` });
  emit({ type: "completed" });
  await eventually(() => !h.service.busy);
  const count = h.spawns(),
    latest = h.service.snapshot(h.workspace, chat.id);
  expect(latest.content).toHaveLength(100);
  expect(latest.page.hasEarlier).toBe(true);
  const earlier = h.service.snapshot(h.workspace, chat.id, latest.page.first);
  expect(earlier.content).toHaveLength(35);
  expect(earlier.turns[0]!.text).toBe("original prompt");
  expect(earlier.page.hasLater).toBe(true);
  expect(h.service.snapshot(h.workspace, chat.id, undefined, true).content).toHaveLength(135);
  expect(h.spawns()).toBe(count);
});

test("attachment MIME spoofing, oversized image dimensions and invalid UTF-8 are refused before persistence", () => {
  const h = setup(),
    chat = h.chat();
  expect(() => h.service.upload(h.workspace, chat.id, "fake.png", "image/png", Buffer.from("hello"))).toThrow(
    "valid PNG",
  );
  expect(() => h.service.upload(h.workspace, chat.id, "bad.txt", "text/plain", new Uint8Array([255]))).toThrow("UTF-8");
  const image = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=",
    "base64",
  );
  const attached = h.service.upload(h.workspace, chat.id, "pixel.png", "image/png", image);
  expect(attached.size).toBe(image.length);
  image.writeUInt32BE(100000, 16);
  expect(() => h.service.upload(h.workspace, chat.id, "huge.png", "image/png", image)).toThrow("16 megapixels");
  expect(h.spawns()).toBe(0);
});

test("failed turns hold the queued message until the user explicitly continues", async () => {
  const h = setup(),
    chat = h.chat();
  h.send(chat.id);
  await eventually(() => h.inputs.length === 1);
  h.send(chat.id, "next message");
  h.events.get(chat.sessionId)!({ type: "failed", code: "native-error", message: "Needs review" });
  await eventually(() => !h.service.busy);
  expect(h.inputs).toHaveLength(1);
  const queued = h.store.chat(chat.id).state.turns.at(-1)!;
  expect(queued.status).toBe("held");
  h.service.resume(h.workspace, chat.id, queued.id);
  await eventually(() => h.inputs.length === 2);
  expect(h.inputs[1]!.text).toBe("next message");
});

test("Stop admits the native interrupt while rejecting a delayed prompt from the fenced run", async () => {
  const h = setup(),
    chat = h.chat();
  h.observeInterrupt();
  let release!: () => void;
  h.hold(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  h.send(chat.id);
  await eventually(() => h.inputs.length === 1);
  await h.service.stop(h.workspace, chat.id);
  release();
  await eventually(() => !h.service.busy);
  expect(h.writes).toEqual(["interrupt"]);
  expect(h.store.chat(chat.id).state.turns[0]!.status).toBe("cancelled");
});

test("ordinary sign-out preserves native history while Remove deletes only that account namespace", async () => {
  const h = setup({
    launcher: {
      async spawn() {
        return {
          pid: 123,
          exited: Promise.resolve({ code: 0, signal: null, groupEmpty: true }),
          async write() {},
          async fence() {},
          async stop() {},
          resize() {},
        };
      },
    },
  });
  const native = join(h.root, "profiles", h.profile.id, "native");
  mkdirSync(native, { recursive: true });
  const history = join(native, "history-canary");
  writeFileSync(history, "session-native-id");
  const signedOut = await h.service.signOut(h.profile.id, { requestId: randomUUID(), revision: 1, remove: false });
  expect(signedOut).toMatchObject({ removed: false, enabled: false, auth: { state: "needs_login" } });
  expect(existsSync(history)).toBe(true);
  await h.service.signOut(h.profile.id, { requestId: randomUUID(), revision: signedOut.revision, remove: true });
  expect(existsSync(native)).toBe(false);
});

test("stored-message search paginates and moving a draft is retryable without sending or copying history", async () => {
  const h = setup(),
    source = h.chat(),
    target = h.chat();
  h.send(source.id, "the hidden search phrase");
  await eventually(() => h.inputs.length === 1);
  h.events.get(source.sessionId)!({ type: "completed" });
  await eventually(() => !h.service.busy);
  expect(h.service.search(h.workspace, "hidden search").chats.map((chat) => chat.id)).toEqual([source.id]);
  h.service.saveDraft(h.workspace, source.id, {
    requestId: randomUUID(),
    revision: 1,
    text: "unsent canary",
    attachments: [],
  });
  const request = { requestId: randomUUID(), sourceId: source.id, sourceRevision: 2, targetRevision: 0 };
  expect(h.service.moveDraft(h.workspace, target.id, request)).toEqual({ copied: true, sourceCleared: true });
  expect(h.service.snapshot(h.workspace, target.id).draft).toBe("unsent canary");
  expect(h.service.snapshot(h.workspace, source.id).draft).toBe("");
  expect(h.store.chat(target.id).state.turns).toEqual([]);
  h.service.moveDraft(h.workspace, target.id, request);
  expect(h.inputs).toHaveLength(1);
  for (let i = 0; i < 50; i++) h.chat();
  const first = h.service.search(h.workspace),
    second = h.service.search(h.workspace, "", first.next);
  expect(first.chats).toHaveLength(50);
  expect(second.chats).toHaveLength(2);
  expect(new Set([...first.chats, ...second.chats].map((chat) => chat.id)).size).toBe(52);
});

test("MCP sign-in retains workspace ownership without any chat and is fenced on workspace revocation", async () => {
  const h = setup();
  h.registry.get("fixture").mcpLoginArgs = () => ["mcp", "login"];
  const operation = await h.service.login(h.profile.id, h.workspace);
  expect(h.service.workspaceBlockers(h.workspace.id)).toMatchObject([{ chat_id: "mcp-sign-in", state: "management" }]);
  await h.service.loginInput(operation.id, operation.secret, "login input");
  expect(h.writes).toEqual(["login input"]);
  await h.service.fenceWorkspace(h.workspace);
  await expect(h.service.loginInput(operation.id, operation.secret, "late input")).rejects.toThrow();
  expect(h.writes).toEqual(["login input"]);
});

// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentEvent,
  type AgentInput,
  type ManagedAgentAdapter,
  ManagedAgentRegistry,
  ManagedAgentError,
  type OwnedProcess,
  type ProcessLauncher,
} from "../../src/agents/interface.ts";
import { ManagedChatService, type ChatServiceOptions } from "../../src/chats/service.ts";
import { WorkspaceBus } from "../../src/bus/bus.ts";
import { KeyedMutex } from "../../src/bus/mutex.ts";
import { workspaceRegistrationId } from "../../src/workspace.ts";
import {
  managedToolsUnavailable,
  managedWorkflowInstructions,
  waitForManagedTools,
} from "../../src/agents/managed-bootstrap.ts";
import { createManagedTools } from "../../src/agents/managed-tools.ts";
import type { DeliverableEntry } from "../../src/agent-provider/interface.ts";
import { WorkspaceBusRegistry } from "../../src/bus/workspace-bus-registry.ts";
import { AgentStore, EXPERIMENTAL_DISCLOSURE } from "../../src/chats/store.ts";
import { WorkspaceIndex } from "../../src/registry/workspace-index.ts";
import { runtimeTarget } from "../../src/agents/runtimes.ts";
import { RuntimeSupervisor } from "../../src/agents/supervisor.ts";
import { waitUntil } from "../helpers.ts";
import { ClaudeManagedAdapter } from "../../../providers/claude-code/src/managed.ts";
import { CodexManagedAdapter } from "../../../providers/codex/src/managed.ts";
import { chatRoutes } from "../../src/routes/chats.ts";
import { ChatWatchStreams } from "../../src/chats/watch-stream.ts";
import { createJournalStreamResponse } from "../../src/transport/stream.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

test.each([
  [false, true, "managed-unavailable"],
  [true, false, "runtime-unqualified"],
] as const)(
  "release=%s qualification=%s refuses native login and API activation",
  async (released, qualified, code) => {
    const h = setup({
      releaseEnabled: released,
      manifest: () => ({
        ...runtimeTarget(),
        id: "fixture",
        provider: "fixture",
        version: "1",
        executable: "/fixture",
        executableSha256: "0".repeat(64),
        qualified,
      }),
    });
    // A release-owned activation bit cannot qualify bytes; request flags cannot open execution.
    await expect(h.service.login(h.profile.id)).rejects.toMatchObject({ code });
    await expect(h.service.discoverModels(h.profile.id)).rejects.toMatchObject({ code });
    const path = `/api/agents/profiles/${h.profile.id}/login`;
    const route = chatRoutes(
      {
        service: h.service,
        workspaceIndex: {} as WorkspaceIndex,
        getWorkspaceBus: () => {
          throw new Error("unexpected workspace access");
        },
      },
      "POST",
      path,
    )!;
    const response = await route.handle(
      new Request(`http://127.0.0.1:4646${path}`, {
        method: "POST",
        body: JSON.stringify({ qualified: true, released: true, GLOSA_MANAGED_PREVIEW: "1" }),
      }),
    );
    expect(response.status).toBe(503);
    expect((await response.json()).type).toEndWith(`/errors/${code}`);
    expect(h.spawns()).toBe(0);
  },
);

test("experimental admission is journaled per provider and pinned runtime, then revocation stops execution", async () => {
  let runtimeId = "fixture-v1";
  let manifestId = runtimeId;
  const h = setup({
    releaseEnabled: false,
    runtimeIdentity: () => runtimeId,
    manifest: () => ({
      ...runtimeTarget(),
      id: manifestId,
      provider: "fixture",
      version: "1",
      executable: "/fixture",
      executableSha256: "0".repeat(64),
      qualified: false,
    }),
  });
  const input = (enabled: boolean, revision: number, id = runtimeId) => ({
    requestId: randomUUID(),
    provider: "fixture",
    runtimeId: id,
    disclosure: EXPERIMENTAL_DISCLOSURE,
    revision,
    enabled,
  });
  expect(h.service.status().providers[0]?.qualified).toBe(false);
  expect(h.service.status().available).toBe(false);
  await expect(h.service.login(h.profile.id)).rejects.toMatchObject({ code: "managed-unavailable" });
  await expect(h.service.changeExperimental(input(true, 0, "wrong-runtime"))).rejects.toMatchObject({
    code: "stale-profile",
  });
  const grant = input(true, 0);
  const path = "/api/agents/experimental";
  const route = chatRoutes(
    {
      service: h.service,
      workspaceIndex: {} as WorkspaceIndex,
      getWorkspaceBus: () => {
        throw new Error("unexpected workspace access");
      },
    },
    "POST",
    path,
  )!;
  const enabled = await route.handle(
    new Request(`http://127.0.0.1:4646${path}`, {
      method: "POST",
      body: JSON.stringify(grant),
    }),
  );
  expect(enabled.status).toBe(200);
  expect((await enabled.json()).enabled).toBe(true);
  const count = h.store.control.records.length;
  await h.service.changeExperimental(grant);
  expect(h.store.control.records.length).toBe(count);
  expect(h.service.status().providers[0]).toMatchObject({ qualified: false, available: true });
  expect(new AgentStore(h.root).experimental("fixture")?.enabled).toBe(true);
  manifestId = "different-installed-bytes";
  expect(h.service.status().providers[0]?.available).toBe(false);
  const launchSpec = () => (h.service as unknown as { launchSpec: (id: string) => unknown }).launchSpec(h.profile.id);
  expect(launchSpec).toThrow("Native agent compatibility and release qualification are pending.");
  manifestId = runtimeId;
  const chat = h.chat();
  h.send(chat.id);
  await waitUntil(() => h.service.status().activeTurns === 1);
  const queued = h.chat();
  h.send(queued.id);
  await waitUntil(() => h.store.chat(queued.id).state.turns.at(-1)?.status === "queued");
  await h.service.changeExperimental(input(false, 1));
  expect(h.service.status().available).toBe(false);
  expect(h.service.status().activeTurns).toBe(0);
  expect(h.store.chat(chat.id).state.turns.at(-1)?.status).toBe("cancelled");
  expect(h.store.chat(queued.id).state.turns.at(-1)?.status).toBe("held");
  expect(h.store.previouslyAccepted({ provider: "fixture", runtimeId, ...runtimeTarget() })).toBe(true);
  runtimeId = "fixture-v2";
  manifestId = runtimeId;
  expect(h.service.status().providers[0]?.experimental.renewalRequired).toBe(false);
  await h.service.changeExperimental(input(true, 2));
  expect(h.service.status().providers[0]?.qualified).toBe(false);
  // A pinned runtime that moves on and is installed keeps the acceptance: it is per provider and
  // host, not per version.
  runtimeId = "fixture-v3";
  manifestId = runtimeId;
  expect(h.service.status().available).toBe(true);
  expect(h.service.status().providers[0]?.experimental.renewalRequired).toBe(false);
  h.store.setExperimental(
    {
      type: "experimental",
      provider: "codex",
      runtimeId: "codex-v1",
      ...runtimeTarget(),
      disclosure: EXPERIMENTAL_DISCLOSURE,
      enabled: true,
      revision: 1,
    },
    { id: randomUUID(), input: { provider: "codex" }, result: { provider: "codex" } },
  );
  const replayed = new AgentStore(h.root);
  expect(replayed.experimental("fixture")?.enabled).toBe(true);
  expect(replayed.experimental("codex")?.enabled).toBe(true);
});

test("experimental acceptance refuses a missing integrity-verified runtime", async () => {
  const h = setup({
    releaseEnabled: false,
    runtimeIdentity: () => "fixture-v1",
    manifest: () => undefined,
  });
  const before = h.store.control.records.length;
  await expect(
    h.service.changeExperimental({
      requestId: randomUUID(),
      provider: "fixture",
      runtimeId: "fixture-v1",
      disclosure: EXPERIMENTAL_DISCLOSURE,
      revision: 0,
      enabled: true,
    }),
  ).rejects.toMatchObject({ code: "runtime-unqualified" });
  expect(h.store.control.records).toHaveLength(before);
});

test("revoking experimental chat stops an active native login", async () => {
  const h = setup({
    releaseEnabled: false,
    runtimeIdentity: () => "fixture-v1",
    manifest: () => ({
      ...runtimeTarget(),
      id: "fixture-v1",
      provider: "fixture",
      version: "1",
      executable: "/fixture",
      executableSha256: "0".repeat(64),
      qualified: false,
    }),
  });
  const experimental = (enabled: boolean, revision: number) => ({
    requestId: randomUUID(),
    provider: "fixture",
    runtimeId: "fixture-v1",
    disclosure: EXPERIMENTAL_DISCLOSURE,
    revision,
    enabled,
  });
  await h.service.changeExperimental(experimental(true, 0));
  const login = await h.service.login(h.profile.id);
  expect(h.service.status().management?.state).toBe("running");
  await h.service.changeExperimental(experimental(false, 1));
  expect(h.service.status().management).toBeNull();
  expect(() => h.service.loginOutput(login.id, login.secret, 0)).toThrow("not available");
  expect(h.spawns()).toBe(1);
});

test.each(["claude-code", "codex"])(
  "%s login carries real PTY input, resize and loopback callback, and cancellation releases its owned tree",
  async (provider) => {
    let supervisor!: RuntimeSupervisor,
      executable = "";
    const children: OwnedProcess[] = [];
    const h = setup({
      launcher: {
        async spawn(options) {
          const child = await supervisor.spawn(options);
          children.push(child);
          return child;
        },
      },
      manifest: () => ({
        ...runtimeTarget(),
        id: "fixture",
        provider: "fixture",
        version: "1",
        executable,
        executableSha256: "0".repeat(64),
        qualified: true,
      }),
    });
    supervisor = new RuntimeSupervisor(join(h.root, "owner"));
    executable = join(h.root, "native-login");
    const native = provider === "claude-code" ? new ClaudeManagedAdapter() : new CodexManagedAdapter();
    h.adapter.loginArgs = () => native.loginArgs();
    h.adapter.profileEnvironment = (dir) => native.profileEnvironment(dir);
    // A fake vendor callback/login protocol in a real terminal. No browser or vendor is contacted.
    writeFileSync(
      executable,
      `#!${process.execPath}
import {createInterface} from "node:readline";
const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch(request){
 if(new URL(request.url).searchParams.get("state")!=="fixture-state")return new Response("wrong state",{status:400});
 console.log("CALLBACK_OK"); return new Response("local callback");
}});
Bun.spawn(["/bin/sleep","60"],{stdin:"ignore",stdout:"ignore",stderr:"ignore"});
console.log("ARGS="+JSON.stringify(process.argv.slice(2)));
console.log("TTY="+Boolean(process.stdin.isTTY&&process.stdout.isTTY));
console.log("CALLBACK=http://127.0.0.1:"+server.port+"/?state=fixture-state");
for await(const line of createInterface({input:process.stdin})) {
 if(line==="approved")process.exit(0);
 const size=Bun.spawnSync(["/bin/stty","size"],{stdin:"inherit",stdout:"pipe",stderr:"pipe"});
 console.log("INPUT="+line+" SIZE="+size.stdout.toString().trim());
}
`,
      { mode: 0o700 },
    );
    try {
      for (const complete of [true, false]) {
        const operation = await h.service.login(h.profile.id);
        const output = () =>
          h.service
            .loginOutput(operation.id, operation.secret, 0)
            .output.split("\n")
            .filter(Boolean)
            .map((line) => Buffer.from(line, "base64").toString())
            .join("");
        expect(await waitUntil(() => output().includes("CALLBACK=http"))).toBe(true);
        expect(output()).toContain("TTY=true");
        expect(output()).toContain(`ARGS=${JSON.stringify(native.loginArgs())}`);
        h.service.loginResize(operation.id, operation.secret, 72, 19);
        await h.service.loginInput(operation.id, operation.secret, "native-code\n");
        expect(await waitUntil(() => output().includes("INPUT=native-code SIZE=19 72"))).toBe(true);
        const callback = /CALLBACK=(http:\/\/127\.0\.0\.1:[0-9]+\/\?state=fixture-state)/.exec(output())![1]!;
        if (complete) {
          expect((await fetch(callback.replace("fixture-state", "wrong"))).status).toBe(400);
          expect(output()).not.toContain("CALLBACK_OK");
          expect(await (await fetch(callback)).text()).toBe("local callback");
          expect(await waitUntil(() => output().includes("CALLBACK_OK"))).toBe(true);
          await h.service.loginInput(operation.id, operation.secret, "approved\n");
          expect(
            await waitUntil(() => h.service.loginOutput(operation.id, operation.secret, 0).state === "completed"),
          ).toBe(true);
        }
        await h.service.finishLogin(operation.id, operation.secret);
        expect(() => output()).toThrow("not available");
        await expect(h.service.loginInput(operation.id, operation.secret, "late-code")).rejects.toThrow(
          "not available",
        );
        await expect(fetch(callback)).rejects.toThrow();
        expect((await children.at(-1)!.exited).groupEmpty).toBe(true);
        expect(supervisor.activeCount).toBe(0);
        expect(supervisor.recoveryRequired).toBe(false);
      }
    } finally {
      await h.service.close();
      await supervisor.close();
    }
  },
  15_000,
);

test("model discovery releases management after an exit races its fence, but uncertain cleanup stays blocked", async () => {
  let stops = 0,
    uncertain = false;
  const h = setup({
    launcher: {
      async spawn() {
        return {
          pid: 123,
          exited: Promise.resolve({ code: 0, signal: null, groupEmpty: true }),
          async write() {},
          async fence() {
            throw new Error("runtime exited before fence acknowledgement");
          },
          async stop() {
            stops++;
            // The SDK closes first; management must still prove cleanup independently.
            if (uncertain && stops % 2 === 0) throw new Error("process group exit unconfirmed");
          },
          resize() {},
        };
      },
    },
  });
  expect((await h.service.discoverModels(h.profile.id)).models[0]!.id).toBe("model-a");
  expect(stops).toBe(2);
  expect((await h.service.probeProfile(h.profile.id)).auth.state).toBe("authenticated");
  uncertain = true;
  try {
    await expect(h.service.discoverModels(h.profile.id)).rejects.toThrow("process group exit unconfirmed");
    expect(stops).toBe(4);
    await expect(h.service.probeProfile(h.profile.id)).rejects.toThrow("Finish the current account operation");
  } finally {
    uncertain = false;
  }
});
test("native login survives a browser polling gap but expires at its original deadline even after completion", async () => {
  let now = Date.now(),
    sequence = 0,
    stopped = 0,
    uncertain = true;
  const timers = new Map<number, { at: number; run: () => void }>();
  const time = spyOn(Date, "now").mockImplementation(() => now);
  const schedule = spyOn(globalThis, "setTimeout").mockImplementation(((run: () => void, ms: number) => {
    const id = ++sequence;
    timers.set(id, { at: now + ms, run });
    return id;
  }) as any);
  const cancel = spyOn(globalThis, "clearTimeout").mockImplementation(((id: number) => timers.delete(id)) as any);
  const advance = async (ms: number) => {
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= now && timers.delete(id)) timer.run();
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  try {
    for (const completed of [false, true]) {
      let end!: (exit: Awaited<OwnedProcess["exited"]>) => void;
      const exited = new Promise<Awaited<OwnedProcess["exited"]>>((resolve) => {
        end = resolve;
      });
      const h = setup({
        launcher: {
          async spawn() {
            return {
              pid: 123,
              exited,
              async write() {},
              async fence() {},
              resize() {},
              async stop() {
                stopped++;
                end({ code: 0, signal: null, groupEmpty: true });
              },
            };
          },
        },
      });
      const operation = await h.service.login(h.profile.id);
      const deadline = h.service.loginOutput(operation.id, operation.secret, 0).expiresAt;
      // Logical clock simulates a suspended browser; no polling during native sign-in.
      await advance(60_000);
      expect(h.service.loginOutput(operation.id, operation.secret, 0).state).toBe("running");
      if (completed) end({ code: 0, signal: null, groupEmpty: true });
      await advance(0);
      await advance(deadline - now - 1);
      expect(h.service.loginOutput(operation.id, operation.secret, 0).state).toBe(completed ? "completed" : "running");
      await advance(1);
      expect(() => h.service.loginOutput(operation.id, operation.secret, 0)).toThrow("not available");
      await expect(h.service.loginInput(operation.id, operation.secret, "late code")).rejects.toThrow();
      expect(stopped).toBe(completed ? 2 : 1);
      // Expired output/ownership cannot block a new foreground account operation.
      expect((await h.service.probeProfile(h.profile.id)).auth.state).toBe("authenticated");
    }
    uncertain = true;
    let emit!: (channel: "stdout" | "stderr", bytes: Uint8Array) => void;
    let end!: (exit: Awaited<OwnedProcess["exited"]>) => void;
    const exited = new Promise<Awaited<OwnedProcess["exited"]>>((resolve) => {
      end = resolve;
    });
    const h = setup({
      launcher: {
        async spawn(options) {
          emit = options.onData;
          return {
            pid: 123,
            exited,
            async write() {},
            async fence() {},
            resize() {},
            async stop() {
              end({ code: 0, signal: null, groupEmpty: true });
              if (uncertain) throw new Error("exit unconfirmed");
            },
          };
        },
      },
    });
    const operation = await h.service.login(h.profile.id);
    emit("stdout", new TextEncoder().encode("private login URL"));
    expect(h.service.loginOutput(operation.id, operation.secret, 0).output).not.toBe("");
    await advance(10 * 60_000);
    emit("stdout", new TextEncoder().encode("late private login URL"));
    expect(h.service.loginOutput(operation.id, operation.secret, 0)).toMatchObject({ state: "stopping", output: "" });
    await expect(h.service.loginInput(operation.id, operation.secret, "late code")).rejects.toThrow();
    await expect(h.service.probeProfile(h.profile.id)).rejects.toThrow("Finish the current account operation");
    uncertain = false;
    await h.service.finishLogin(operation.id, operation.secret);
    expect((await h.service.probeProfile(h.profile.id)).auth.state).toBe("authenticated");
    uncertain = true;
    let rejectPreflight!: (error: Error) => void;
    const preflight = new Promise<void>((_resolve, reject) => {
      rejectPreflight = reject;
    });
    const late = setup({
      launcher: {
        async spawn() {
          return {
            pid: 123,
            exited: new Promise(() => {}),
            async write() {},
            async fence() {},
            resize() {},
            async stop() {
              if (uncertain) throw new Error("exit unconfirmed");
            },
          };
        },
      },
    });
    late.registry.get("fixture").preflight = async (spec, launcher) => {
      await launcher.spawn({ command: "/fixture", args: [], cwd: spec.cwd, env: spec.env, onData() {} });
      await preflight;
    };
    const pendingLogin = late.service.login(late.profile.id);
    await advance(0);
    await advance(10 * 60_000);
    rejectPreflight(new Error("preflight failed after deadline"));
    await expect(pendingLogin).rejects.toThrow();
    await expect(late.service.probeProfile(late.profile.id)).rejects.toThrow("Finish the current account operation");
    uncertain = false;
    await late.service.close();
  } finally {
    uncertain = false;
    time.mockRestore();
    schedule.mockRestore();
    cancel.mockRestore();
  }
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
        async prepareTurn() {},
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
      ...runtimeTarget(),
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
    adapter,
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

test("the first accepted prompt names a chat locally without overwriting an explicit title", async () => {
  const h = setup(),
    chat = h.chat();
  h.send(chat.id, "Review\n   the opening paragraph");
  expect(h.store.chat(chat.id).state.title).toBe("Review the opening paragraph");
  expect(h.store.chat(chat.id).state.configRevision).toBe(1);
  const renamed = h.chat();
  h.service.change(h.workspace, renamed.id, { requestId: randomUUID(), revision: 1, title: "New chat" });
  h.send(renamed.id, "Leave the chosen title alone");
  expect(h.store.chat(renamed.id).state.title).toBe("New chat");
  const emoji = h.chat();
  h.send(emoji.id, "a" + "🙂".repeat(100));
  expect(h.store.chat(emoji.id).state.title.length).toBeLessThanOrEqual(100);
  expect(h.store.chat(emoji.id).state.title).not.toMatch(/[\uD800-\uDBFF]$/u);
});

test("a draft with no model stays local and cannot dispatch until a model is selected", async () => {
  const h = setup();
  const chat = h.service.create(h.workspace, {
    id: randomUUID(),
    requestId: randomUUID(),
    provider: "fixture",
    profileId: h.profile.id,
    settings: { model: "", effort: "", permissionMode: "default" },
  });
  expect(h.spawns()).toBe(0);
  expect(() => h.send(chat.id)).toThrow("Choose a model");
  expect(h.store.chat(chat.id).state.turns).toHaveLength(0);
  expect(h.spawns()).toBe(0);
  h.service.change(h.workspace, chat.id, {
    requestId: randomUUID(),
    revision: 1,
    settings: { model: "model-a", effort: "high", permissionMode: "default" },
  });
  h.send(chat.id);
  await eventually(() => h.inputs.length === 1);
});

test("subscription switches persist on one chat, keep turn provenance and start isolated sessions with text history", async () => {
  const h = setup(),
    chat = h.chat(),
    log = h.store.chat(chat.id);
  const other = h.service.createProfile({ requestId: randomUUID(), provider: "fixture", label: "Work" });
  h.store.saveProfiles([
    { ...other, auth: { state: "authenticated", identity: "account-b", observedAt: new Date().toISOString() } },
  ]);
  const originalDefault = h.store.profile(h.profile.id).isDefault;
  const originalSession = chat.sessionId;
  const first = h.send(chat.id, "Remember: the manuscript is called Cedar.");
  await eventually(() => h.inputs.length === 1);
  const switchTo = (profileId: string, revision = log.state.configRevision) => ({
    requestId: randomUUID(),
    revision,
    profileId,
    provider: "fixture",
    settings: { model: "model-a", effort: "low", permissionMode: "default" },
  });
  expect(() => h.service.change(h.workspace, chat.id, switchTo(other.id))).toThrow("Finish or stop pending work");
  const emit = h.events.get(originalSession)!;
  emit({ type: "session", nativeId: "account-a-native" });
  emit({ type: "text", id: "answer-a", text: "Cedar noted." });
  emit({ type: "text", id: "private-thought", reasoning: true, text: "PRIVATE_REASONING" });
  emit({ type: "tool", id: "private-tool", name: "Read", detail: "PRIVATE_TOOL_RESULT", status: "completed" });
  emit({ type: "completed" });
  await eventually(() => log.state.runtime?.state === "stopped");
  h.service.saveDraft(h.workspace, chat.id, {
    requestId: randomUUID(),
    revision: log.state.draftRevision,
    text: "Keep my draft",
    attachments: [],
  });
  const request = switchTo(other.id);
  h.service.change(h.workspace, chat.id, request);
  h.service.change(h.workspace, chat.id, request);
  expect(h.store.list(h.workspace.id, h.workspace.epoch)).toHaveLength(1);
  expect(log.state.profileId).toBe(other.id);
  expect(log.state.configRevision).toBe(request.revision + 1);
  expect(log.text(log.state.draftHash)).toBe("Keep my draft");
  expect(log.state.runtime?.nativeId).toBeUndefined();
  expect(log.state.sessionId).not.toBe(originalSession);
  expect(log.state.turns[0]).toMatchObject({ id: first.turnId, profileId: h.profile.id, sessionId: originalSession });
  expect(h.store.profile(h.profile.id).isDefault).toBe(originalDefault);
  const replayed = new AgentStore(h.root).chat(chat.id).state;
  expect(replayed.profileId).toBe(other.id);
  expect(replayed.handoffHash).toBe(log.state.handoffHash);
  expect(replayed.turns[0]!.profileId).toBe(h.profile.id);
  // The other subscription needs no workspace grant of its own: the provider's acceptance covers it.
  h.send(chat.id, "What is the manuscript called?");
  await eventually(() => h.inputs.length === 2);
  expect(h.specs.at(-1)!.profile.id).toBe(other.id);
  expect(h.specs.at(-1)!.nativeId).toBeUndefined();
  expect(h.specs.at(-1)!.configRoot).not.toBe(h.specs[0]!.configRoot);
  const history = new TextDecoder().decode(h.inputs[1]!.attachments[0]!.bytes);
  expect(history).toContain("Remember: the manuscript is called Cedar.");
  expect(history).toContain("Cedar noted.");
  expect(history).not.toContain("PRIVATE_REASONING");
  expect(history).not.toContain("PRIVATE_TOOL_RESULT");
  expect(history).not.toContain("Keep my draft");
  expect(history).not.toContain("account-a-native");
  const secondSession = log.state.sessionId;
  h.events.get(secondSession)!({ type: "session", nativeId: "account-b-native" });
  h.events.get(secondSession)!({ type: "text", id: "answer-b", text: "It is Cedar." });
  h.send(chat.id, "Continue with the same subscription");
  h.events.get(secondSession)!({ type: "completed" });
  await eventually(() => h.inputs.length === 3);
  expect(h.specs.at(-1)!.nativeId).toBe("account-b-native");
  expect(h.inputs[2]!.attachments).toHaveLength(0);
  expect(log.state.handoffHash).toBeUndefined();
  h.events.get(secondSession)!({ type: "text", id: "partial", text: "The stopped partial reply" });
  await h.service.stop(h.workspace, chat.id);
  await eventually(() => log.state.runtime?.state === "stopped");
  h.service.change(h.workspace, chat.id, switchTo(h.profile.id));
  expect(log.state.profileId).toBe(h.profile.id);
  expect(log.state.runtime?.nativeId).toBeUndefined();
  expect(log.text(log.state.handoffHash)).toContain("It is Cedar.");
  expect(log.text(log.state.handoffHash)).toContain("The stopped partial reply");
  expect(log.text(log.state.handoffHash)).toContain("cancelled");
  expect(log.state.turns.map((turn) => turn.profileId)).toEqual([h.profile.id, other.id, other.id]);
  expect(() => h.service.change(h.workspace, chat.id, { ...switchTo(other.id), provider: "codex" })).toThrow(
    "switch its agent",
  );
  log.append({ type: "runtime", runId: randomUUID(), generation: 50, state: "unknown" });
  expect(() => h.service.change(h.workspace, chat.id, switchTo(other.id))).toThrow("Finish or stop pending work");
});

test("Retry stop after restart requires independent recovered-ownership proof", async () => {
  const h = setup(),
    chat = h.chat();
  h.store.chat(chat.id).append({ type: "runtime", runId: randomUUID(), generation: 1, state: "connected" });
  await h.service.close();
  let unknown = true;
  const recoveredStore = new AgentStore(h.root);
  const restarted = new ManagedChatService({
    store: recoveredStore,
    registry: new ManagedAgentRegistry(),
    launcher: {
      async spawn() {
        throw new Error("Recovery must not launch or signal a process");
      },
    },
    workspace: () => h.workspace,
    manifest: () => undefined,
    ownershipUnknown: () => unknown,
  });
  h.replace(restarted);
  expect(recoveredStore.chat(chat.id).state.runtime?.state).toBe("unknown");
  await expect(restarted.stop(h.workspace, chat.id)).rejects.toThrow("exit is still unconfirmed");
  expect(recoveredStore.chat(chat.id).state.runtime?.state).toBe("unknown");
  unknown = false;
  await restarted.stop(h.workspace, chat.id);
  expect(recoveredStore.chat(chat.id).state.runtime?.state).toBe("stopped");
  expect(h.spawns()).toBe(0);
});

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

test("confirmed native exit releases a completed run after fence or adapter-close races; unknown exit does not", async () => {
  for (const failure of ["fence", "close"] as const) {
    let uncertain = false;
    const h = setup({
      launcher: {
        async spawn() {
          return {
            pid: 123,
            exited: Promise.resolve({ code: 0, signal: null, groupEmpty: true }),
            async write() {},
            async fence() {
              if (failure === "fence") throw new Error("runtime exited before acknowledgement");
            },
            async stop() {
              if (uncertain) throw new Error("process group exit unconfirmed");
            },
            resize() {},
          };
        },
      },
    });
    const adapter = h.registry.get("fixture"),
      connect = adapter.connect.bind(adapter);
    if (failure === "close")
      adapter.connect = async (...args) => ({
        ...(await connect(...args)),
        async close() {
          throw new Error("transport already closed");
        },
      });
    const completed = h.chat();
    h.send(completed.id);
    await eventually(() => h.inputs.length === 1);
    h.events.get(completed.sessionId)!({ type: "completed" });
    await eventually(() => !h.service.busy);
    expect(h.store.chat(completed.id).state.runtime?.state).toBe("stopped");
    uncertain = true;
    const unconfirmed = h.chat();
    try {
      h.send(unconfirmed.id);
      await eventually(() => h.inputs.length === 2);
      h.events.get(unconfirmed.sessionId)!({ type: "completed" });
      await eventually(() => h.store.chat(unconfirmed.id).state.runtime?.state === "unknown");
      expect(h.service.busy).toBe(true);
    } finally {
      uncertain = false;
      await h.service.stop(h.workspace, unconfirmed.id);
    }
  }
});

test("a launch resolving after the stop grace still proves child exit before rejecting its fenced handoff", async () => {
  let release!: () => void,
    starting = false,
    stops = 0,
    stopsAtRejection: number | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = setup({
    launcher: {
      async spawn() {
        starting = true;
        await held;
        return {
          pid: 123,
          exited: Promise.resolve({ code: 0, signal: null, groupEmpty: true }),
          async write() {},
          async fence() {
            throw new Error("runtime exited before acknowledgement");
          },
          async stop() {
            stops++;
          },
          resize() {},
        };
      },
    },
  });
  const adapter = h.registry.get("fixture"),
    connect = adapter.connect.bind(adapter);
  adapter.connect = async (...args) => {
    try {
      return await connect(...args);
    } catch (error) {
      stopsAtRejection = stops;
      throw error;
    }
  };
  const chat = h.chat();
  try {
    h.send(chat.id);
    await eventually(() => starting);
    // Exercise the real five-second drainage boundary: cleanup's first pass cannot see this child.
    await h.service.stop(h.workspace, chat.id);
    expect(h.store.chat(chat.id).state.runtime?.state).toBe("unknown");
    release();
    await eventually(() => stopsAtRejection !== undefined);
    expect(stopsAtRejection).toBeGreaterThan(0);
  } finally {
    release();
    await h.service.stop(h.workspace, chat.id);
  }
}, 10_000);

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

test("a grant given under the first consent text is asked for again now that the agent can read web pages (#440)", async () => {
  const h = setup();
  const granted = (store = h.store) => store.consent(h.profile.id, h.workspace.id, h.workspace.epoch);
  expect(granted()).toBe(true);
  h.store.setConsent(h.profile.id, h.workspace.id, h.workspace.epoch, true, "", 1);
  expect(granted()).toBe(false);
  // The control log keeps which text each grant was given under, and a grant written before the
  // field existed reads as the first text.
  expect(granted(new AgentStore(h.root))).toBe(false);
  const log = join(h.root, "control.jsonl");
  const lines = readFileSync(log, "utf8").trimEnd().split("\n");
  const last = JSON.parse(lines.at(-1)!);
  expect(last.data).toMatchObject({ type: "consent", granted: true, disclosure: 1 });
  delete last.data.disclosure;
  writeFileSync(log, [...lines.slice(0, -1), JSON.stringify(last)].join("\n") + "\n");
  expect(granted(new AgentStore(h.root))).toBe(false);
  await h.service.consent(h.workspace, h.profile.id, true);
  expect(granted()).toBe(true);
  expect(granted(new AgentStore(h.root))).toBe(true);
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
  expect(h.specs[0]!.mcp).toMatchObject({ instructions: managedWorkflowInstructions, requiredTools: ["fixture"] });
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

test("a managed chat's notes are resolved against the document and carry their passage address", async () => {
  // Built from the stored entry alone, a managed chat's note said `orphaned, no_source_map` whether
  // or not its words were on the page, and had no address and no workspace line. Through the
  // resolving path the HTTP deliveries use, it reads the document as it stands, as they do.
  const h = setup(),
    chat = h.chat(),
    home = mkdtempSync(join(tmpdir(), "glosa-managed-address-home-")),
    buses = new WorkspaceBusRegistry();
  cleanup.unshift(async () => {
    await buses.close(h.root);
    rmSync(home, { recursive: true, force: true });
  });
  writeFileSync(join(h.root, "draft.md"), "# Title\n\n## One\n\nFirst.\n\n## Two\n\nA.\n\nB.\n\nThe named words.\n");
  const workspaceIndex = new WorkspaceIndex({ home });
  const workspace = await workspaceIndex.upsertWorkspace(h.root, "glosa-open");
  const bus = buses.get(workspace);
  await bus.createEntry("note-411", {
    kind: "annotation",
    artifact_path: "draft.md",
    body: "Tighten this.",
    intent: "content",
    target: { quote: { exact: "The named words.", prefix: "", suffix: "" } },
  });
  const tools = createManagedTools(async () => bus, undefined, {
    deps: { workspaceIndex, getWorkspaceBus: (target) => buses.get(target) },
    workspaceFor: () => workspace,
  });
  const context = { chat, assertActive() {}, reservations: new Set<string>() };
  const pulled = (await tools.call(context, "glosa_inbox_pull", {})) as { drained: DeliverableEntry[] };
  const got = (await tools.call(context, "glosa_inbox_get", { id: "note-411" })) as DeliverableEntry;
  for (const delivered of [pulled.drained[0]!, got]) {
    expect(delivered.text).toContain("\naddress: §2.3 (");
    expect(delivered.text).toStartWith(`workspace: ${workspace.canonical_path}\n`);
    expect(delivered.detail).toMatchObject({ address: "§2.3", resolution: { kind: "source_range" } });
  }
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

test("MCP scope changes fence the running chat, and the next send carries the new servers without a grant", async () => {
  const h = setup(),
    chat = h.chat();
  h.send(chat.id);
  await eventually(() => h.writes.length === 1);
  const servers = [
    { id: "docs", label: "Docs", enabled: true, transport: "http" as const, url: "https://tools.example.test/mcp" },
  ];
  await h.service.changeMcpPolicy(h.workspace, h.profile.id, { revision: 0, servers });
  expect(h.store.chat(chat.id).state.runtime?.state).toBe("stopped");
  h.send(chat.id);
  await eventually(() => h.writes.length === 2);
  expect(h.specs[1]?.servers).toEqual(servers);
});

test("an enabled account works in a workspace with no per-workspace grant, and a revoked grant changes nothing", async () => {
  const h = setup(),
    chat = h.chat();
  await h.service.consent(h.workspace, h.profile.id, false);
  expect(h.store.consent(h.profile.id, h.workspace.id, h.workspace.epoch)).toBe(false);
  h.send(chat.id, "no grant needed");
  await eventually(() => h.inputs.length === 1);
  expect(h.inputs[0]!.text).toBe("no grant needed");
});

test("after a restart, a message that never reached the agent goes once the daemon is serving", async () => {
  const h = setup(),
    chat = h.chat();
  h.hold(new Promise(() => {}));
  h.send(chat.id, "first");
  await eventually(() => h.inputs.length === 1);
  const waiting = h.send(chat.id, "queued before the restart");
  expect(h.store.chat(chat.id).state.turns.at(-1)?.status).toBe("queued");
  const recoveryRoot = realpathSync(mkdtempSync(join(tmpdir(), "glosa-chat-restart-")));
  cleanup.push(async () => rmSync(recoveryRoot, { recursive: true, force: true }));
  cpSync(h.root, recoveryRoot, { recursive: true });
  const recoveredStore = new AgentStore(recoveryRoot);
  const recovered = new ManagedChatService({
    store: recoveredStore,
    registry: h.registry,
    launcher: h.launcher,
    workspace: () => h.workspace,
    manifest: () => ({
      ...runtimeTarget(),
      id: "fixture",
      provider: "fixture",
      version: "1",
      executable: "/fixture",
      executableSha256: "0".repeat(64),
      qualified: true,
    }),
    releaseEnabled: true,
  });
  cleanup.push(() => recovered.close());
  const statuses = () => recoveredStore.chat(chat.id).state.turns.map((turn) => turn.status);
  // The turn that was with the agent is uncertain and stays so; the queued one is still queued, not held.
  expect(statuses()).toEqual(["outcome_unknown", "queued"]);
  expect(h.inputs).toHaveLength(1);
  recovered.setMcpOrigin("http://127.0.0.1:1");
  await eventually(() => h.inputs.length === 2);
  expect(h.inputs[1]!.turnId).toBe(waiting.turnId);
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

test("a reply that fails on its own does not hold the queue: the next message goes", async () => {
  const h = setup(),
    chat = h.chat();
  h.send(chat.id);
  await eventually(() => h.inputs.length === 1);
  h.send(chat.id, "next message");
  h.events.get(chat.sessionId)!({ type: "failed", code: "native-error", message: "Needs review" });
  await eventually(() => h.inputs.length === 2);
  expect(h.inputs[1]!.text).toBe("next message");
  expect(h.store.chat(chat.id).state.turns.map((turn) => turn.status)).toEqual(["failed", "running"]);
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

test("Glosa tool readiness bounds a stalled native read and rejects late or partial catalogs", async () => {
  let resolve!: (status: { state: "ready"; tools: string[] }) => void;
  let reads = 0;
  const delayed = new Promise<{ state: "ready"; tools: string[] }>((done) => {
    resolve = done;
  });
  // This witness must cross the actual deadline: a never-answering vendor control call is the failure boundary.
  await expect(
    waitForManagedTools(
      async () => {
        reads++;
        return delayed;
      },
      ["glosa_present"],
      () => false,
      15,
    ),
  ).rejects.toThrow("Your message was not sent");
  resolve({ state: "ready", tools: ["glosa_present"] });
  await Promise.resolve();
  expect(reads).toBe(1);
  await expect(
    waitForManagedTools(
      async () => ({ state: "ready", tools: ["glosa_present"] }),
      ["glosa_present", "glosa_claim"],
      () => false,
    ),
  ).rejects.toThrow("Your message was not sent");
  await expect(
    waitForManagedTools(
      async () => {
        throw new Error("private-grant");
      },
      ["glosa_present"],
      () => false,
    ),
  ).rejects.toThrow("Your message was not sent");
  await expect(
    waitForManagedTools(
      async () => ({ state: "ready", tools: ["glosa_present"] }),
      ["glosa_present"],
      () => true,
    ),
  ).rejects.toThrow("Your message was not sent");
});

test("tool preparation failure is unsent and an explicit resend can recover", async () => {
  const h = setup(),
    chat = h.chat();
  const adapter = h.registry.get("fixture"),
    connect = adapter.connect.bind(adapter);
  let fail = true,
    release!: () => void,
    entered = false;
  const barrier = new Promise<void>((done) => {
    release = done;
  });
  adapter.connect = async (...args) => {
    const connection = await connect(...args);
    connection.prepareTurn = async () => {
      entered = true;
      await barrier;
      if (fail) throw managedToolsUnavailable();
    };
    return connection;
  };
  h.send(chat.id, "Review the draft");
  await eventually(() => entered);
  expect(h.inputs).toHaveLength(0);
  release();
  await eventually(() => !h.service.busy);
  const state = h.store.chat(chat.id).state;
  expect(state.turns.map((turn) => turn.status)).toEqual(["failed"]);
  expect(state.turns[0]!.error).toContain("Your message was not sent");
  expect(h.writes).toEqual([]);
  fail = false;
  h.send(chat.id, "Review the draft");
  await eventually(() => h.inputs.length === 1);
  expect(h.inputs[0]!.text).toBe("Review the draft");
});

test("Stop during tool preparation fences a late readiness reply without submitting a prompt", async () => {
  const h = setup(),
    chat = h.chat();
  const adapter = h.registry.get("fixture"),
    connect = adapter.connect.bind(adapter);
  let release!: () => void,
    entered = false;
  const barrier = new Promise<void>((done) => {
    release = done;
  });
  adapter.connect = async (...args) => {
    const connection = await connect(...args);
    connection.prepareTurn = async () => {
      entered = true;
      await barrier;
    };
    return connection;
  };
  h.send(chat.id);
  await eventually(() => entered);
  const stopping = h.service.stop(h.workspace, chat.id);
  release();
  await stopping;
  await eventually(() => !h.service.busy);
  expect(h.inputs).toEqual([]);
  expect(h.writes).toEqual([]);
  expect(h.store.chat(chat.id).state.turns[0]!.status).toBe("cancelled");
});

test("tool preparation preserves actionable native configuration failures", async () => {
  const h = setup(),
    chat = h.chat();
  const adapter = h.registry.get("fixture"),
    connect = adapter.connect.bind(adapter);
  adapter.connect = async (...args) => {
    const connection = await connect(...args);
    connection.prepareTurn = async () => {
      throw new ManagedAgentError("unsupported-model", "Choose an available model.");
    };
    return connection;
  };
  h.send(chat.id);
  await eventually(() => h.store.chat(chat.id).state.turns[0]!.status === "failed");
  expect(h.store.chat(chat.id).state.turns[0]!.error).toBe("Choose an available model.");
  expect(h.inputs).toEqual([]);
});

test("Stop closes a stalled native readiness request and releases the chat for another turn", async () => {
  const h = setup(),
    chat = h.chat();
  const adapter = h.registry.get("fixture"),
    connect = adapter.connect.bind(adapter);
  let entered = false;
  adapter.connect = async (...args) => {
    const connection = await connect(...args),
      close = connection.close.bind(connection);
    let closed = false;
    connection.close = async () => {
      closed = true;
      await close();
    };
    connection.prepareTurn = () =>
      waitForManagedTools(
        async () => {
          entered = true;
          return new Promise(() => {});
        },
        ["glosa_present"],
        () => closed,
      );
    return connection;
  };
  h.send(chat.id);
  await eventually(() => entered);
  await h.service.stop(h.workspace, chat.id);
  expect(h.service.busy).toBe(false);
  expect(h.store.chat(chat.id).state.runtime!.state).toBe("stopped");
  expect(h.inputs).toEqual([]);
  adapter.connect = connect;
  h.send(chat.id, "Try again");
  await eventually(() => h.inputs.length === 1);
}, 10_000);

test("a managed grant cannot dispatch through an adapter without readiness support", async () => {
  const h = setup({ tools: { list: [{ name: "glosa_present" }], call: async () => ({}) } }),
    chat = h.chat();
  h.service.setMcpOrigin("http://127.0.0.1:4646");
  const adapter = h.registry.get("fixture"),
    connect = adapter.connect.bind(adapter);
  adapter.connect = async (...args) => {
    const connection = await connect(...args);
    delete connection.prepareTurn;
    return connection;
  };
  h.send(chat.id);
  await eventually(() => h.store.chat(chat.id).state.turns[0]!.status === "failed");
  expect(h.store.chat(chat.id).state.turns[0]!.error).toContain("Your message was not sent");
  expect(h.inputs).toEqual([]);
});

test("native disconnect or completion during preparation records an unsent failure, never an uncertain send", async () => {
  for (const event of [
    { type: "failed", code: "native-disconnected", message: "Disconnected", outcomeUnknown: true },
    { type: "completed" },
  ] as const) {
    const h = setup(),
      chat = h.chat();
    const adapter = h.registry.get("fixture"),
      connect = adapter.connect.bind(adapter);
    adapter.connect = async (...args) => {
      const connection = await connect(...args);
      connection.prepareTurn = async () => {
        args[2](event);
      };
      return connection;
    };
    h.send(chat.id);
    await eventually(() => h.store.chat(chat.id).state.turns[0]!.status === "failed");
    await eventually(() => !h.service.busy);
    expect(h.store.chat(chat.id).state.turns[0]!.status).toBe("failed");
    expect(h.store.chat(chat.id).state.turns[0]!.error).toContain("Your message was not sent");
    expect(h.inputs).toEqual([]);
    expect(h.writes).toEqual([]);
  }
});

test("references preserve exact text, survive replay, and stale commands hold before native dispatch", async () => {
  const h = setup(),
    chat = h.chat();
  let available = true;
  const connect = h.adapter.connect.bind(h.adapter);
  h.adapter.connect = async (...args) => ({
    ...(await connect(...args)),
    commands: async () => (available ? [{ id: "skill-a", name: "review", description: "Review", kind: "skill" }] : []),
  });
  expect(h.service.commandCatalog(h.workspace, chat.id).loaded).toBe(false);
  expect(h.spawns()).toBe(0);
  await h.service.refreshCommands(h.workspace, chat.id);
  expect(h.service.commandCatalog(h.workspace, chat.id).commands[0]?.id).toBe("skill-a");
  const text = "  /review 😀  ";
  const references = [{ kind: "command" as const, id: "skill-a", start: 2, end: 9, text: "/review" }];
  h.service.saveDraft(h.workspace, chat.id, { requestId: randomUUID(), revision: 0, text, references });
  expect(h.service.snapshot(h.workspace, chat.id).draftReferences).toEqual(references);
  available = false;
  h.service.send(h.workspace, chat.id, {
    requestId: randomUUID(),
    turnId: randomUUID(),
    configRevision: 1,
    draftRevision: 1,
    text,
    references,
  });
  for (let i = 0; i < 100 && h.store.chat(chat.id).state.turns[0]?.status !== "held"; i++) await Promise.resolve();
  expect(h.store.chat(chat.id).state.turns[0]?.status).toBe("held");
  expect(h.inputs).toEqual([]);
  expect(h.service.snapshot(h.workspace, chat.id).turns[0]?.text).toBe(text);
  expect(h.service.snapshot(h.workspace, chat.id).turns[0]?.references).toEqual(references);
});

test("workspace file references are live paths and cannot escape the workspace", async () => {
  const h = setup(),
    chat = h.chat();
  writeFileSync(join(h.root, "notes.md"), "private content is not embedded");
  const text = "Read @notes.md";
  const references = [{ kind: "file", id: "notes.md", text: "@notes.md", start: 5, end: 14 }];
  h.service.send(h.workspace, chat.id, {
    requestId: randomUUID(),
    turnId: randomUUID(),
    configRevision: 1,
    draftRevision: 0,
    text,
    references,
  });
  for (let i = 0; i < 100 && !h.inputs.length; i++) await Promise.resolve();
  expect(h.inputs[0]?.text).toBe('Read "notes.md"');
  expect(h.inputs[0]?.attachments).toEqual([]);
  const other = h.chat();
  h.service.send(h.workspace, other.id, {
    requestId: randomUUID(),
    turnId: randomUUID(),
    configRevision: 1,
    draftRevision: 0,
    text: "Read @../outside.md",
    references: [{ kind: "file", start: 5, end: 19, text: "@../outside.md", id: "../outside.md" }],
  });
  for (let i = 0; i < 100 && h.store.chat(other.id).state.turns[0]?.status !== "held"; i++) await Promise.resolve();
  expect(h.store.chat(other.id).state.turns[0]?.status).toBe("held");
  expect(h.inputs).toHaveLength(1);
});

test("unlinking native configuration never launches logout or deletes native files", async () => {
  const h = setup();
  const external = realpathSync(mkdtempSync(join(tmpdir(), "glosa-native-link-")));
  try {
    writeFileSync(join(external, "auth.json"), "native-owned");
    const profile = h.service.createProfile({
      requestId: randomUUID(),
      provider: "fixture",
      label: "Native",
      configuration: { mode: "linked", path: external },
    });
    mkdirSync(join(h.root, "profiles", profile.id, "native"), { recursive: true });
    h.adapter.logoutArgs = () => {
      throw new Error("native logout must never launch");
    };
    expect(() =>
      h.service.createProfile({
        requestId: randomUUID(),
        provider: "fixture",
        label: "Duplicate",
        configuration: { mode: "linked", path: external },
      }),
    ).toThrow("already linked");
    await expect(h.service.login(profile.id)).rejects.toThrow("native agent");
    const removed = await h.service.signOut(profile.id, {
      requestId: randomUUID(),
      revision: profile.revision,
      remove: true,
    });
    expect(removed.removed).toBe(true);
    expect(existsSync(join(external, "auth.json"))).toBe(true);
    expect(h.spawns()).toBe(0);
    expect(() =>
      h.service.createProfile({
        requestId: randomUUID(),
        provider: "fixture",
        label: "Owned",
        configuration: { mode: "linked", path: h.root },
      }),
    ).toThrow("outside Glosa");
  } finally {
    rmSync(external, { recursive: true, force: true });
  }
});

test("five messages can wait behind the one at work, a sixth is refused, and they go in order", async () => {
  const h = setup(),
    chat = h.chat();
  h.send(chat.id, "first");
  await eventually(() => h.inputs.length === 1);
  for (let i = 2; i <= 6; i++) h.send(chat.id, `message ${i}`);
  expect(() => h.send(chat.id, "one too many")).toThrow("Five messages are already waiting");
  const state = h.store.chat(chat.id).state;
  expect(state.turns.map((turn) => turn.status)).toEqual(["running", ...Array(5).fill("queued")]);
  h.events.get(state.sessionId)!({ type: "completed" });
  await eventually(() => h.inputs.length === 2);
  expect(h.inputs[1]!.text).toBe("message 2");
});

test("a live run's own capability report becomes the account's model catalog, with no discovery process", async () => {
  const h = setup(),
    chat = h.chat();
  expect(h.service.status().capabilities[h.profile.id]).toBeUndefined();
  h.send(chat.id, "first");
  await eventually(() => h.inputs.length === 1);
  // One connection: the turn's own. Nothing was launched to ask about models separately.
  expect(h.specs).toHaveLength(1);
  expect(h.service.status().capabilities[h.profile.id]?.models.map((model) => model.id)).toEqual(["model-a"]);
  // Journaled, so the catalog is there before any process on the next start.
  expect(h.store.savedCapabilities(h.profile.id)?.capabilities.models[0]?.id).toBe("model-a");
});

test("the protocol log pages the chat's journal as written, newest last, without starting anything", async () => {
  const h = setup(),
    chat = h.chat();
  const empty = h.service.journalPage(h.workspace, chat.id);
  expect(empty.records.map((record) => record.type)).toEqual(["created"]);
  expect(empty.total).toBe(1);
  h.send(chat.id, "first");
  await eventually(() => h.inputs.length === 1);
  const page = h.service.journalPage(h.workspace, chat.id);
  expect(page.records[0]!.seq).toBe(1);
  expect(page.records.map((record) => record.seq)).toEqual(page.records.map((_, i) => i + 1));
  expect(page.records.map((record) => record.type)).toContain("turn");
  expect(page.records.map((record) => record.type)).toContain("runtime");
  expect(page.records.every((record) => record.bytes > 0 && typeof record.at === "string")).toBe(true);
  const last = page.records.at(-1)!;
  const older = h.service.journalPage(h.workspace, chat.id, last.seq, 2);
  expect(older.records.map((record) => record.seq)).toEqual([last.seq - 2, last.seq - 1]);
  expect(older.hasEarlier).toBe(last.seq > 3);
  expect(h.specs).toHaveLength(1);
});

test("Send now stops the reply at work and sends the chosen message, with the rest still queued behind it", async () => {
  const h = setup(),
    chat = h.chat();
  h.send(chat.id, "first");
  await eventually(() => h.inputs.length === 1);
  h.send(chat.id, "second");
  const third = h.send(chat.id, "third");
  await h.service.sendNow(h.workspace, chat.id, third.turnId);
  await eventually(() => h.inputs.length === 2);
  expect(h.inputs[1]!.text).toBe("third");
  const state = h.store.chat(chat.id).state;
  expect(state.turns.map((turn) => turn.status)).toEqual(["cancelled", "queued", "running"]);
  h.events.get(state.sessionId)!({ type: "completed" });
  await eventually(() => h.inputs.length === 3);
  expect(h.inputs[2]!.text).toBe("second");
  await expect(h.service.sendNow(h.workspace, chat.id, third.turnId)).rejects.toThrow("Only a waiting message");
});

test("stopping the reply at work holds what waits, and a removed message never reached the agent", async () => {
  const h = setup(),
    chat = h.chat();
  const first = h.send(chat.id, "first");
  await eventually(() => h.inputs.length === 1);
  const second = h.send(chat.id, "second");
  h.send(chat.id, "third");
  await h.service.stop(h.workspace, chat.id, second.turnId);
  await h.service.stop(h.workspace, chat.id, first.turnId);
  const turns = new AgentStore(h.root).chat(chat.id).state.turns;
  expect(turns.map((turn) => turn.status)).toEqual(["cancelled", "cancelled", "held"]);
  // Replayed from the journal: only the first was ever sent on.
  expect(turns.map((turn) => !!turn.started)).toEqual([true, false, false]);
  expect(h.inputs).toHaveLength(1);
});

test("Send now after the reply failed on its own still holds what waits", async () => {
  const h = setup(),
    chat = h.chat();
  h.send(chat.id, "first");
  await eventually(() => h.inputs.length === 1);
  h.send(chat.id, "second");
  const third = h.send(chat.id, "third");
  // The failure is being cleared up when the person asks for the third message.
  h.events.get(chat.sessionId)!({
    type: "failed",
    code: "native-disconnected",
    message: "Disconnected",
    outcomeUnknown: true,
  });
  await h.service.sendNow(h.workspace, chat.id, third.turnId);
  await eventually(() => !h.service.busy);
  expect(h.store.chat(chat.id).state.turns.map((turn) => turn.status)).toEqual(["outcome_unknown", "held", "held"]);
  expect(h.inputs).toHaveLength(1);
});

test("a Send now choice survives the account's run limit and goes first when a slot frees", async () => {
  const h = setup(),
    x = h.chat(),
    y = h.chat(),
    z = h.chat();
  h.send(x.id, "x first");
  h.send(y.id, "y first");
  await eventually(() => h.inputs.length === 2);
  h.send(z.id, "z first");
  h.send(x.id, "x second");
  const chosen = h.send(x.id, "x third");
  // Stopping x frees a slot that z, waiting longer, takes: x is passed over at the limit of two.
  await h.service.sendNow(h.workspace, x.id, chosen.turnId);
  await eventually(() => h.inputs.length === 3);
  expect(h.inputs[2]!.text).toBe("z first");
  h.events.get(y.sessionId)!({ type: "completed" });
  await eventually(() => h.inputs.length === 4);
  expect(h.inputs[3]!.text).toBe("x third");
});

test("editing a waiting message is CAS-protected, durable and preserves its accepted settings", async () => {
  const h = setup(),
    chat = h.chat();
  h.send(chat.id, "first");
  await eventually(() => h.inputs.length === 1);
  const queued = h.send(chat.id, "original");
  const frozen = h.store.chat(chat.id).state.turns[1]!;
  h.service.change(h.workspace, chat.id, {
    requestId: randomUUID(),
    revision: 1,
    settings: { model: "model-a", effort: "low", permissionMode: "default" },
  });
  const input = { requestId: randomUUID(), turnId: queued.turnId, expectedRevision: 1, text: "edited in place" };
  expect(h.service.editQueuedTurn(h.workspace, chat.id, input)).toEqual({ turnId: queued.turnId, revision: 2 });
  expect(h.service.editQueuedTurn(h.workspace, chat.id, input)).toEqual({ turnId: queued.turnId, revision: 2 });
  expect(() => h.service.editQueuedTurn(h.workspace, chat.id, { ...input, text: "changed receipt" })).toThrow(
    "different input",
  );
  let conflict: unknown;
  try {
    h.service.editQueuedTurn(h.workspace, chat.id, { ...input, requestId: randomUUID(), text: "stale" });
  } catch (error) {
    conflict = error;
  }
  expect(conflict).toMatchObject({ code: "stale-turn" });
  const replay = new AgentStore(h.root);
  try {
    const edited = replay.chat(chat.id).state.turns[1]!;
    expect(replay.chat(chat.id).text(edited.textHash)).toBe("edited in place");
    expect(edited).toMatchObject({
      id: frozen.id,
      revision: 2,
      settings: frozen.settings,
      profileId: frozen.profileId,
      sessionId: frozen.sessionId,
      status: "queued",
    });
  } finally {
    replay.close();
  }
  expect(h.inputs).toHaveLength(1);
  h.events.get(chat.sessionId)!({ type: "completed" });
  await eventually(() => h.inputs.length === 2);
  expect(h.inputs[1]).toMatchObject({ text: "edited in place", settings: frozen.settings });
  expect(() =>
    h.service.editQueuedTurn(h.workspace, chat.id, { ...input, requestId: randomUUID(), expectedRevision: 2 }),
  ).toThrow("Only a waiting message");
});

test("an edit racing asynchronous command validation dispatches the latest waiting revision once", async () => {
  const h = setup(),
    chat = h.chat();
  const connect = h.adapter.connect.bind(h.adapter);
  const command = { id: "review", name: "review", description: "Review", kind: "skill" as const };
  const barrier = Promise.withResolvers<void>();
  let preparing = false,
    entered = false;
  h.adapter.connect = async (...args) => {
    const connection = await connect(...args);
    connection.prepareTurn = async () => {
      preparing = true;
    };
    connection.commands = async () => {
      if (preparing && !entered) {
        entered = true;
        await barrier.promise;
      }
      return [command];
    };
    return connection;
  };
  const state = h.store.chat(chat.id).state;
  const turnId = randomUUID();
  const references = [{ kind: "command", id: "review", text: "/review", start: 0, end: 7 }];
  h.service.send(h.workspace, chat.id, {
    requestId: randomUUID(),
    turnId,
    configRevision: state.configRevision,
    draftRevision: 0,
    text: "/review original",
    references,
  });
  await eventually(() => entered);
  h.service.editQueuedTurn(h.workspace, chat.id, {
    requestId: randomUUID(),
    turnId,
    expectedRevision: 1,
    text: "/review latest",
    references,
  });
  barrier.resolve();
  await eventually(() => h.inputs.length === 1);
  expect(h.inputs[0]!.text).toBe("/review latest");
  expect(h.store.chat(chat.id).state.turns[0]!.revision).toBe(2);
});

test("ordinary startup errors and native details survive as a sanitized unsent failure with stable attempt identity", async () => {
  const h = setup(),
    chat = h.chat();
  h.adapter.connect = async () => {
    throw Object.assign(new Error("Internal error"), {
      data: { details: "Model unavailable. access_token=private-canary" },
    });
  };
  h.send(chat.id);
  await eventually(() => !h.service.busy && h.store.chat(chat.id).state.turns[0]?.status === "failed");
  const state = h.store.chat(chat.id).state,
    turn = state.turns[0]!;
  expect(turn.error).toBe("Internal error");
  expect(turn.failure).toMatchObject({ phase: "connecting", dispatchCertainty: "unsent", title: "Internal error" });
  expect(turn.failure?.detail).toContain("Model unavailable.");
  expect(turn.failure?.detail).not.toContain("private-canary");
  expect(turn.attemptId).toBe(state.runtime!.runId);
  expect(h.inputs).toHaveLength(0);
  const replay = new AgentStore(h.root);
  try {
    expect(replay.chat(chat.id).state.turns[0]).toEqual(turn);
  } finally {
    replay.close();
  }
});

test("tool preparation retains nested native error details under its unsent recovery message", async () => {
  const h = setup(),
    chat = h.chat(),
    connect = h.adapter.connect.bind(h.adapter);
  h.adapter.connect = async (...args) => {
    const connection = await connect(...args);
    connection.prepareTurn = async () => {
      throw Object.assign(new Error("Internal error"), {
        data: { details: "Native configuration refused. refresh_token=private-preparation" },
      });
    };
    return connection;
  };
  h.send(chat.id);
  await eventually(() => !h.service.busy && h.store.chat(chat.id).view.turns[0]?.status === "failed");
  const turn = h.store.chat(chat.id).view.turns[0]!;
  expect(turn.error).toContain("Your message was not sent");
  expect(turn.failure).toMatchObject({ phase: "preparing", dispatchCertainty: "unsent" });
  expect(turn.failure?.detail).toContain("Native configuration refused.");
  expect(turn.failure?.detail).not.toContain("private-preparation");
  expect(h.inputs).toHaveLength(0);
});

test("an ordinary transport exception after submission preserves its cause and holds the queue without resending", async () => {
  const h = setup(),
    chat = h.chat(),
    connect = h.adapter.connect.bind(h.adapter);
  h.adapter.connect = async (...args) => {
    const connection = await connect(...args),
      start = connection.startTurn.bind(connection);
    connection.startTurn = async (input) => {
      await start(input);
      throw new Error("The native transport closed before its terminal reply.");
    };
    return connection;
  };
  h.send(chat.id, "possibly submitted");
  h.send(chat.id, "must wait");
  await eventually(() => !h.service.busy && h.store.chat(chat.id).view.turns[0]?.status === "outcome_unknown");
  const turns = h.store.chat(chat.id).view.turns;
  expect(turns.map((turn) => turn.status)).toEqual(["outcome_unknown", "held"]);
  expect(turns[0]!.failure).toMatchObject({
    dispatchCertainty: "unknown",
    title: "The native transport closed before its terminal reply.",
  });
  expect(h.inputs).toHaveLength(1);
});

test("display deltas flush on their deadline and before a decision or terminal event", async () => {
  const h = setup(),
    chat = h.chat();
  h.send(chat.id);
  await eventually(() => h.inputs.length === 1);
  const event = h.events.get(chat.sessionId)!;
  const log = h.store.chat(chat.id),
    revision = log.journal.revision;
  event({ type: "text", id: "reply", text: "first " });
  event({ type: "text", id: "reply", text: "words" });
  expect(log.journal.revision).toBe(revision);
  expect(log.view.content).toEqual([]);
  // A real elapsed-time witness owns the 20ms flush boundary; no further native event arrives.
  await eventually(() => log.view.content[0]?.text === "first words");
  expect(log.journal.records.slice(revision).map((record) => record.data.type)).toEqual(["content"]);
  event({ type: "text", id: "reply", text: " before permission" });
  event({
    type: "decision",
    decision: {
      id: "permission",
      kind: "permission",
      title: "Read file",
      detail: "notes.md",
      choices: [{ id: "deny", label: "Deny" }],
    },
  });
  const barrierTypes = log.journal.records.slice(-3).map((record) => record.data.type);
  expect(barrierTypes).toEqual(["content", "decision", "turn_status"]);
  event({ type: "text", id: "reply", text: " done" });
  event({ type: "completed" });
  await eventually(() => !h.service.busy);
  expect(log.view.content[0]!.text).toBe("first words before permission done");
  const finalContent = log.journal.records.findLastIndex((record) => record.data.type === "content");
  const completed = log.journal.records.findIndex(
    (record) => record.data.type === "turn_status" && record.data.status === "completed",
  );
  expect(finalContent).toBeLessThan(completed);
});

test("the display byte budget flushes before a quiet stream exceeds sixteen KiB", async () => {
  const h = setup(),
    chat = h.chat();
  h.send(chat.id);
  await eventually(() => h.inputs.length === 1);
  const event = h.events.get(chat.sessionId)!,
    log = h.store.chat(chat.id);
  const revision = log.journal.revision;
  for (let index = 0; index < 4; index++) event({ type: "text", id: "reply", text: "x".repeat(4096) });
  expect(log.journal.revision).toBe(revision + 1);
  expect(log.view.content[0]!.text.length).toBe(16 * 1024);
});

test("a historical chat page retains the active response and queued prompt bytes", async () => {
  const h = setup(),
    chat = h.chat();
  h.send(chat.id, "past");
  await eventually(() => h.inputs.length === 1);
  h.events.get(chat.sessionId)!({ type: "text", id: "past-reply", text: "past reply" });
  h.events.get(chat.sessionId)!({ type: "completed" });
  await eventually(() => !h.service.busy);
  const active = h.send(chat.id, "active");
  await eventually(() => h.inputs.length === 2);
  h.events.get(chat.sessionId)!({ type: "text", id: "active-reply", text: "active reply" });
  const queued = h.send(chat.id, "waiting");
  await eventually(() => h.store.chat(chat.id).view.content.length === 2);
  const page = h.service.snapshot(h.workspace, chat.id, `user:${active.turnId}`);
  expect(page.page.hasLater).toBe(true);
  expect(page.content.map((content) => content.text)).toEqual(["past reply", "active reply"]);
  expect(page.turns.find((turn) => turn.id === queued.turnId)?.text).toBe("waiting");
});

test("chat snapshots page historical turn rows as well as content, with complete export retained", () => {
  const h = setup(),
    chat = h.chat(),
    log = h.store.chat(chat.id);
  const textHash = log.blob(Buffer.from("old prompt"));
  for (let index = 0; index < 120; index++)
    log.append({
      type: "turn",
      turn: {
        id: randomUUID(),
        textHash,
        attachments: [],
        settings: chat.settings,
        profileEpoch: 0,
        identityRevision: 0,
        at: new Date().toISOString(),
        origin: "user",
        status: "completed",
      },
    });
  const latest = h.service.snapshot(h.workspace, chat.id);
  expect(latest.turns).toHaveLength(100);
  expect(latest.page.total).toBe(120);
  const earlier = h.service.snapshot(h.workspace, chat.id, latest.page.first);
  expect(earlier.turns).toHaveLength(20);
  expect(earlier.page.hasLater).toBe(true);
  expect(h.service.snapshot(h.workspace, chat.id, undefined, true).turns).toHaveLength(120);
  expect(h.spawns()).toBe(0);
});

test("workspace chat watches hydrate live records, replay missing cursors and reject foreign streams", async () => {
  const h = setup(),
    chat = h.chat(),
    other = h.chat();
  const watches = new ChatWatchStreams(h.service);
  type WatchData = {
    streamId?: string;
    chatId?: string;
    record?: {
      seq: number;
      data: { type: string; turn?: { text?: string }; content?: { text?: string } };
    };
  };
  const frames: { event: string; data: WatchData }[] = [];
  const stop = watches.register(h.workspace, (event, data) => frames.push({ event, data: data as WatchData }));
  const streamId = frames[0]!.data.streamId as string;
  try {
    watches.watch(h.workspace, { streamId, revision: 1, chats: [{ id: chat.id }] });
    expect(frames.at(-1)).toMatchObject({
      event: "chat_snapshot",
      data: { chatId: chat.id, snapshot: { id: chat.id } },
    });
    const cursor = h.store.chat(chat.id).journal.revision;
    h.send(chat.id, "streamed prompt");
    await eventually(() =>
      frames.some((frame) => frame.event === "chat_event" && frame.data.record?.data.type === "turn"),
    );
    expect(frames.find((frame) => frame.data.record?.data.type === "turn")?.data.record?.data.turn?.text).toBe(
      "streamed prompt",
    );
    await eventually(() => h.inputs.length === 1);
    const before = frames.length;
    expect(watches.watch(h.workspace, { streamId, revision: 1, chats: [{ id: other.id }] })).toEqual({ revision: 1 });
    h.events.get(chat.sessionId)!({ type: "text", id: "reply", text: "live" });
    h.events.get(chat.sessionId)!({ type: "completed" });
    await eventually(() => frames.slice(before).some((frame) => frame.data.record?.data.type === "content"));
    expect(frames.slice(before).some((frame) => frame.data.chatId === other.id)).toBe(false);
    const reconnect: { event: string; data: WatchData }[] = [];
    const close = watches.register(h.workspace, (event, data) => reconnect.push({ event, data: data as WatchData }));
    try {
      watches.watch(h.workspace, {
        streamId: reconnect[0]!.data.streamId,
        revision: 1,
        chats: [{ id: chat.id, cursor }],
      });
      const records = reconnect.filter((frame) => frame.event === "chat_event").map((frame) => frame.data.record!);
      expect(records.map((record) => record.seq)).toEqual(
        Array.from({ length: records.length }, (_, index) => cursor + index + 1),
      );
      expect(records.find((record) => record.data.type === "content")?.data.content?.text).toBe("live");
      expect(reconnect.some((frame) => frame.event === "chat_snapshot")).toBe(false);
      expect(h.inputs).toHaveLength(1);
    } finally {
      close();
    }
    expect(() => watches.watch({ ...h.workspace, epoch: "foreign" }, { streamId, revision: 2, chats: [] })).toThrow(
      "workspace connection changed",
    );
  } finally {
    stop();
  }
});

test("oversized chat watch bootstrap uses affected snapshot references and retains a gap-free cursor", async () => {
  const h = setup(),
    large = h.chat(),
    first = h.chat(),
    second = h.chat();
  function seed(chat: ReturnType<typeof h.chat>, parts: number) {
    const log = h.store.chat(chat.id),
      turnId = randomUUID();
    log.append({
      type: "turn",
      turn: {
        id: turnId,
        textHash: log.blob(Buffer.from("old prompt")),
        attachments: [],
        settings: chat.settings,
        profileEpoch: 0,
        identityRevision: 0,
        at: new Date().toISOString(),
        origin: "user",
        status: "completed",
      },
    });
    log.appendMany(
      Array.from({ length: parts }, (_, index) => ({
        type: "content" as const,
        content: {
          id: `tool-${index}`,
          turnId,
          role: "tool" as const,
          kind: "tool" as const,
          text: "x".repeat(16384),
          status: "completed" as const,
        },
      })),
    );
    return { log, turnId };
  }
  const { log, turnId } = seed(large, 100);
  seed(first, 25);
  seed(second, 25);
  expect(Buffer.byteLength(JSON.stringify(h.service.snapshot(h.workspace, large.id)))).toBeGreaterThan(1_048_576);
  const watches = new ChatWatchStreams(h.service),
    abort = new AbortController();
  let streamId = "";
  const response = createJournalStreamResponse(
    h.root,
    {
      subscribe: () => () => {},
    } as unknown as WorkspaceBus,
    new Request("http://127.0.0.1/w/fixture/stream", {
      headers: { "Last-Event-ID": "-1" },
      signal: abort.signal,
    }),
    undefined,
    {
      subscribeChatStream: (send) =>
        watches.register(h.workspace, (event, data) => {
          if (event === "chat_stream_ready") streamId = (data as { streamId: string }).streamId;
          send(event, data);
        }),
    },
  );
  const reader = response.body!.getReader(),
    decoder = new TextDecoder();
  async function frame() {
    const { value, done } = await reader.read();
    expect(done).toBe(false);
    const text = decoder.decode(value);
    return { event: /^event: (.*)$/m.exec(text)?.[1], data: JSON.parse(/^data: (.*)$/m.exec(text)?.[1] ?? "null") };
  }
  try {
    expect((await frame()).event).toBe("chat_stream_ready");
    // The empty workspace reconnect emits an immediate heartbeat without a data payload.
    await reader.read();
    watches.watch(h.workspace, { streamId, revision: 1, chats: [{ id: large.id }] });
    expect(await frame()).toMatchObject({
      event: "chat_snapshot_ref",
      data: { chatId: large.id, revision: log.journal.revision },
    });
    // A retained replay can be larger than the snapshot budget too, even below the event count cap.
    watches.watch(h.workspace, { streamId, revision: 2, chats: [{ id: large.id, cursor: 0 }] });
    expect((await frame()).event).toBe("chat_snapshot_ref");
    const captured = h.service.snapshot(h.workspace, large.id);
    log.append({
      type: "content",
      content: { id: "after-reference", turnId, role: "assistant", kind: "text", text: "after reference" },
    });
    const live = await frame();
    expect(live).toMatchObject({
      event: "chat_event",
      data: { chatId: large.id, record: { seq: captured.revision + 1 } },
    });
    // If this event arrived during the HTTP snapshot read, registering its captured watermark
    // replays it once. No provider operation or unrelated snapshot is needed.
    watches.watch(h.workspace, { streamId, revision: 3, chats: [{ id: large.id, cursor: captured.revision }] });
    expect(await frame()).toEqual(live);
    watches.watch(h.workspace, { streamId, revision: 4, chats: [{ id: first.id }, { id: second.id }] });
    expect(await frame()).toMatchObject({ event: "chat_snapshot", data: { chatId: first.id } });
    expect(await frame()).toMatchObject({ event: "chat_snapshot_ref", data: { chatId: second.id } });
    expect(h.spawns()).toBe(0);
  } finally {
    abort.abort();
    await reader.cancel().catch(() => {});
  }
});

function oauthFixture(h: ReturnType<typeof setup>) {
  const account = {
    accountId: randomUUID(),
    clientId: "issued-client",
    issuer: "https://issuer.invalid",
    subject: "subject-a",
    email: "same@example.invalid",
    label: "Personal",
    status: "signed-in" as "signed-in" | "signed-out",
    planEnabled: true,
  };
  const attempt = {
    attemptId: randomUUID(),
    accountId: account.accountId,
    status: "succeeded" as "succeeded" | "cancelled",
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    account,
  };
  let leases = 0,
    begins = 0,
    localCleared = true,
    closed = 0;
  const broker: import("../../src/agents/oauth-interface.ts").ManagedOAuthBroker = {
    async begin() {
      begins++;
      return { ...attempt, authorizationUrl: "https://issuer.invalid/authorize" };
    },
    status() {
      return structuredClone(attempt);
    },
    async cancel() {
      attempt.status = "cancelled";
      return structuredClone(attempt);
    },
    listAccounts() {
      return [structuredClone(account)];
    },
    getAccount(id) {
      return id === account.accountId ? structuredClone(account) : undefined;
    },
    async lease() {
      leases++;
      throw new Error("Metadata operation must not request a token");
    },
    async signOut() {
      account.status = "signed-out";
      return { localCleared, revocation: "unconfirmed" };
    },
    async close() {
      closed++;
    },
  };
  Object.defineProperty(h.adapter, "oauth", { value: broker });
  return {
    account,
    attempt,
    leases: () => leases,
    begins: () => begins,
    closed: () => closed,
    setLocalCleared(value: boolean) {
      localCleared = value;
    },
  };
}

test("OAuth sign-in requires experimental admission before any registration or account mutation", async () => {
  const h = setup({ releaseEnabled: false }),
    oauth = oauthFixture(h);
  const profile = h.service.adoptOAuth("fixture", { requestId: randomUUID(), attemptId: oauth.attempt.attemptId });
  await expect(h.service.beginOAuth("fixture", {})).rejects.toMatchObject({ code: "managed-unavailable" });
  await expect(h.service.beginOAuth("fixture", { accountId: oauth.account.accountId })).rejects.toMatchObject({
    code: "managed-unavailable",
  });
  expect(oauth.begins()).toBe(0);
  expect(h.store.profile(profile.id).revision).toBe(profile.revision);
  expect(h.store.profile(profile.id).auth.state).toBe("authenticated");
  // Account cleanup remains possible while execution is disabled.
  expect((await h.service.cancelOAuth("fixture", oauth.attempt.attemptId)).status).toBe("cancelled");
});

test("OAuth adoption keeps registration and native profile identities separate and does not dispatch or lease", async () => {
  const h = setup(),
    oauth = oauthFixture(h);
  const input = { requestId: randomUUID(), attemptId: oauth.attempt.attemptId };
  const profile = h.service.adoptOAuth("fixture", input);
  expect(profile.id).not.toBe(oauth.account.accountId);
  expect(profile.id).not.toBe(h.profile.id);
  expect(profile.authentication).toEqual({ mode: "oauth", credentialRef: oauth.account.accountId });
  expect(profile.auth.identity).toBe(`oauth:${oauth.account.accountId}`);
  expect(h.service.adoptOAuth("fixture", input).id).toBe(profile.id);
  expect(h.store.profile(h.profile.id).auth.identity).toBe("account-a");
  expect(h.service.status().oauthAccounts.fixture?.[0]?.planEnabled).toBe(true);
  expect(h.spawns()).toBe(0);
  expect(oauth.leases()).toBe(0);
  expect(h.inputs).toHaveLength(0);
  const ack = { requestId: randomUUID() };
  const acknowledged = h.service.acknowledgeOAuthPlan(profile.id, ack);
  expect(acknowledged.authentication?.planNoticeSeen).toBe(true);
  expect(h.service.acknowledgeOAuthPlan(profile.id, ack).revision).toBe(acknowledged.revision);
  await expect(h.service.login(profile.id)).rejects.toMatchObject({ code: "account-auth" });
});

test("OAuth signout blocks account use before vault cleanup and reports unconfirmed remote revocation", async () => {
  const h = setup(),
    oauth = oauthFixture(h);
  const profile = h.service.adoptOAuth("fixture", { requestId: randomUUID(), attemptId: oauth.attempt.attemptId });
  oauth.setLocalCleared(false);
  const input = { requestId: randomUUID(), revision: profile.revision };
  await expect(h.service.signOut(profile.id, input)).rejects.toThrow("secure credentials could not be removed");
  expect(h.store.profile(profile.id)).toMatchObject({
    enabled: false,
    cleanup: "signout",
    auth: { state: "needs_login", revocation: "unconfirmed" },
  });
  oauth.setLocalCleared(true);
  const done = await h.service.signOut(profile.id, input);
  expect(done.cleanup).toBeUndefined();
  expect(done.auth.revocation).toBe("unconfirmed");
  expect(h.spawns()).toBe(0);
  expect(oauth.leases()).toBe(0);
});

test("OAuth signup without inference scope remains a separate signed-in account and never enables plan use", () => {
  const h = setup(),
    oauth = oauthFixture(h);
  oauth.account.planEnabled = false;
  const profile = h.service.adoptOAuth("fixture", { requestId: randomUUID(), attemptId: oauth.attempt.attemptId });
  expect(profile.auth.state).toBe("authenticated");
  expect(profile.auth.plan).toBeUndefined();
  expect(h.service.status().oauthAccounts.fixture?.[0]?.planEnabled).toBe(false);
  expect(oauth.leases()).toBe(0);
  oauth.account.status = "signed-out";
  expect(() =>
    h.service.adoptOAuth("fixture", { requestId: randomUUID(), attemptId: oauth.attempt.attemptId }),
  ).toThrow("Complete sign-in");
});

test("retry creates a linked turn and cannot duplicate an unresolved or foreign attempt", async () => {
  const h = setup(),
    chat = h.chat(),
    first = h.send(chat.id);
  await eventually(() => h.inputs.length === 1);
  const retry = (source = first.turnId) => ({
    requestId: randomUUID(),
    turnId: randomUUID(),
    configRevision: h.store.chat(chat.id).state.configRevision,
    draftRevision: h.store.chat(chat.id).state.draftRevision,
    text: "Try again",
    retryOfTurnId: source,
  });
  expect(() => h.service.send(h.workspace, chat.id, retry())).toThrow("Only a resolved turn");
  expect(() => h.service.send(h.workspace, chat.id, retry(randomUUID()))).toThrow("Only a resolved turn");
  h.events.get(chat.sessionId)!({ type: "failed", code: "runtime-failed", message: "Native failure" });
  await eventually(() => !h.service.busy);
  const request = retry(),
    attemptId = h.store.chat(chat.id).turn(first.turnId)!.attemptId;
  expect(attemptId).toBeString();
  h.service.send(h.workspace, chat.id, request);
  h.service.send(h.workspace, chat.id, request);
  expect(h.store.chat(chat.id).state.turns).toHaveLength(2);
  expect(new AgentStore(h.root).chat(chat.id).turn(request.turnId)?.retryOf).toEqual({
    turnId: first.turnId,
    attemptId,
  });
});

test("authentication failure retains partial output and holds queued work until explicit reauthentication", async () => {
  const h = setup(),
    chat = h.chat();
  const first = h.send(chat.id),
    second = h.send(chat.id, "waiting for sign-in");
  await eventually(() => h.inputs.length === 1);
  const emit = h.events.get(chat.sessionId)!;
  emit({ type: "text", id: "partial", text: "Partial answer" });
  emit({ type: "failed", code: "account-auth", message: "Sign in again to continue." });
  await eventually(() => h.service.status().activeTurns === 0);
  const state = h.store.chat(chat.id).state;
  expect(state.turns.find((turn) => turn.id === first.turnId)).toMatchObject({
    status: "failed",
    failure: { category: "authentication", dispatchCertainty: "confirmed_terminal" },
  });
  expect(state.turns.find((turn) => turn.id === second.turnId)).toMatchObject({
    status: "held",
    error: "Sign in again, then continue this queued message explicitly.",
  });
  expect(state.content[0]?.text).toBe("Partial answer");
  expect(h.inputs).toHaveLength(1);
  expect(h.store.profile(h.profile.id).auth.state).toBe("needs_login");
});

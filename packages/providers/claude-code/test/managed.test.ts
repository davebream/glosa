// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type {
  AgentEvent,
  ProcessLauncher,
  ProfileLaunchSpec,
  SessionLaunchSpec,
} from "../../../daemon/src/agents/interface.ts";
import { ClaudeEventNormalizer, ClaudeManagedAdapter, type ClaudeQuery, type ClaudeSdk } from "../src/managed.ts";
import { claudeRuntimeCandidate } from "../src/runtime.ts";
import { runtimeTarget } from "../../../daemon/src/agents/runtimes.ts";
import { RuntimeSupervisor } from "../../../daemon/src/agents/supervisor.ts";
import { managedEnvironment } from "../../../daemon/src/agents/environment.ts";
import { waitUntil } from "../../../daemon/test/helpers.ts";
import { createInterface } from "node:readline";

test("Claude candidates select frozen native packages for each supported target and remain unqualified", () => {
  for (const target of [
    runtimeTarget("darwin", "arm64"),
    runtimeTarget("darwin", "x64"),
    runtimeTarget("linux", "x64", "glibc"),
  ]) {
    const candidate = claudeRuntimeCandidate(target);
    const lock = Bun.JSONC.parse(readFileSync(candidate.lockFile, "utf8")) as {
      workspaces: Record<string, { dependencies: Record<string, string> }>;
      packages: Record<string, [string, string, Record<string, string>, string]>;
    };
    expect(candidate).toMatchObject({ ...target, qualified: false, version: "2.1.280", sdkVersion: "0.3.280" });
    expect(candidate.binaryPackage).toBe(`@anthropic-ai/claude-code-${target.platform}-${target.architecture}`);
    expect(lock.workspaces[""]!.dependencies).toEqual(candidate.packages);
    expect(lock.packages[candidate.binaryPackage]![2]).toMatchObject({ os: target.platform, cpu: target.architecture });
    // Bun does not retain npm's libc field in its lock. The non-musl package and host guard select glibc.
    if (target.platform === "linux")
      expect(lock.packages[candidate.binaryPackage]![0]).toBe("@anthropic-ai/claude-code-linux-x64@2.1.280");
    expect(lock.packages[candidate.binaryPackage]![3]).toStartWith("sha512-");
  }
});

test("Claude SDK process bridge uses private auth and real supervised pipes, then cancels its owned descendant", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "glosa-claude-process-")));
  const configRoot = join(root, "profile"),
    cwd = join(root, "workspace"),
    system = join(root, "system");
  for (const dir of [configRoot, cwd, system]) mkdirSync(dir);
  const executable = join(root, "claude"),
    observed = join(configRoot, "observed.json");
  writeFileSync(join(system, "claude"), "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  writeFileSync(join(system, "settings.json"), '{"apiKeyHelper":"poison"}');
  // Only the SDK/vendor protocol is simulated. The bridge, native pipes and guardian are production.
  writeFileSync(
    executable,
    `#!${process.execPath}
import {writeFileSync} from "node:fs";
import {createInterface} from "node:readline";
if(process.argv[2]==="auth") {
 console.log(JSON.stringify({loggedIn:true,authMethod:"claude.ai",apiProvider:"firstParty",email:"writer@example.test",orgId:"org-a"}));
 process.exit(0);
}
const descendant=Bun.spawn(["/bin/sleep","60"],{stdin:"ignore",stdout:"ignore",stderr:"ignore"});
for await(const line of createInterface({input:process.stdin})) {
 const value=JSON.parse(line);
 writeFileSync(${JSON.stringify(observed)},JSON.stringify({cwd:process.cwd(),configRoot:process.env.CLAUDE_CONFIG_DIR,key:process.env.ANTHROPIC_API_KEY,preload:process.env.NODE_OPTIONS,interrupted:!!value.interrupt,descendant:descendant.pid}));
 console.log(JSON.stringify({type:"assistant",message:{id:"one",content:[{type:"text",text:value.interrupt?"interrupted":value.message.content[0].text}]}}));
}
`,
    { mode: 0o700 },
  );
  const abort = new AbortController();
  const adapter = new ClaudeManagedAdapter(async () => ({
    query(input) {
      const child = input.options.spawnClaudeCodeProcess({
        command: input.options.pathToClaudeCodeExecutable,
        args: ["--input-format", "stream-json"],
        cwd: system,
        env: { ANTHROPIC_API_KEY: "poison" },
        signal: abort.signal,
      });
      child.on("error", () => {});
      const write = (value: unknown) =>
        new Promise<void>((resolve, reject) =>
          child.stdin.write(`${JSON.stringify(value)}\n`, (error) => (error ? reject(error) : resolve())),
        );
      void (async () => {
        for await (const prompt of input.prompt) await write(prompt);
      })().catch(() => {});
      return {
        supportedModels: async () => [{ value: "model", displayName: "Fixture", supportedEffortLevels: ["high"] }],
        accountInfo: async () => ({ email: "writer@example.test", apiProvider: "firstParty", apiKeySource: "none" }),
        interrupt: () => write({ interrupt: true }),
        close: () => abort.abort(),
        async *[Symbol.asyncIterator]() {
          for await (const line of createInterface({ input: child.stdout })) yield JSON.parse(line);
        },
      };
    },
  }));
  const supervisor = new RuntimeSupervisor(join(root, "owner"));
  const children: import("../../../daemon/src/agents/interface.ts").OwnedProcess[] = [];
  const launcher: ProcessLauncher = {
    async spawn(options) {
      const child = await supervisor.spawn(options);
      children.push(child);
      return child;
    },
  };
  const events: AgentEvent[] = [];
  const spec = {
    cwd,
    configRoot,
    probeCwd: configRoot,
    env: managedEnvironment(
      {
        HOME: system,
        PATH: `${system}:/usr/bin:/bin`,
        CLAUDE_CONFIG_DIR: system,
        ANTHROPIC_API_KEY: "poison",
        NODE_OPTIONS: "--require=poison",
      },
      adapter.profileEnvironment(configRoot),
    ),
    profile: { auth: { identity: "org-a:writer@example.test" } },
    manifest: { executable, sdkModule: "/simulated/sdk.mjs" },
    settings: { model: "model", effort: "high", permissionMode: "default" },
  } as SessionLaunchSpec;
  let connection: Awaited<ReturnType<typeof adapter.connect>> | undefined;
  try {
    connection = await adapter.connect(spec, launcher, (event) => events.push(event));
    await connection.startTurn({ turnId: "logical", text: "local fixture", settings: spec.settings, attachments: [] });
    expect(await waitUntil(() => events.some((event) => event.type === "text"))).toBe(true);
    expect(events.find((event) => event.type === "text")).toMatchObject({ text: "local fixture" });
    const observation = JSON.parse(readFileSync(observed, "utf8"));
    expect(observation).toMatchObject({ configRoot, cwd });
    expect(observation.key).toBeUndefined();
    expect(observation.preload).toBeUndefined();
    await connection.interrupt();
    expect(await waitUntil(() => events.some((event) => event.type === "text" && event.text === "interrupted"))).toBe(
      true,
    );
    expect(readFileSync(join(system, "settings.json"), "utf8")).toBe('{"apiKeyHelper":"poison"}');
    await connection.close();
    for (const child of children) expect((await child.exited).groupEmpty).toBe(true);
    expect(supervisor.activeCount).toBe(0);
    expect(supervisor.recoveryRequired).toBe(false);
  } finally {
    await connection?.close();
    await supervisor.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

test("Claude streaming output is emitted once when the complete assistant message follows", () => {
  const events: AgentEvent[] = [],
    normalizer = new ClaudeEventNormalizer((event) => events.push(event));
  normalizer.accept({ type: "system", subtype: "init", session_id: "native-session" });
  normalizer.accept({ type: "stream_event", event: { type: "message_start", message: { id: "message-1" } } });
  normalizer.accept({
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
  });
  normalizer.accept({ type: "assistant", message: { id: "message-1", content: [{ type: "text", text: "Hello" }] } });
  normalizer.accept({ type: "assistant", message: { id: "message-2", content: [{ type: "text", text: " world" }] } });
  expect(
    events
      .filter((event) => event.type === "text")
      .map((event) => event.text)
      .join(""),
  ).toBe("Hello world");
  expect(events[0]).toEqual({ type: "session", nativeId: "native-session" });
});

test("Claude blockwise assistant envelopes preserve stream indexes after thinking and across subagents", () => {
  const events: AgentEvent[] = [];
  const normalizer = new ClaudeEventNormalizer((event) => events.push(event));
  // Native 0.3.280 emits one assistant envelope per completed block, sharing the
  // message id. Its content array restarts at zero while stream indexes advance.
  for (const parent of [null, "subagent-tool"]) {
    normalizer.accept({
      type: "stream_event",
      parent_tool_use_id: parent,
      event: { type: "message_start", message: { id: "message-1" } },
    });
    normalizer.accept({
      type: "stream_event",
      parent_tool_use_id: parent,
      event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Considering" } },
    });
    normalizer.accept({
      type: "assistant",
      parent_tool_use_id: parent,
      message: { id: "message-1", content: [{ type: "thinking", thinking: "Considering" }] },
    });
    normalizer.accept({
      type: "stream_event",
      parent_tool_use_id: parent,
      event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hello" } },
    });
    normalizer.accept({
      type: "assistant",
      parent_tool_use_id: parent,
      message: { id: "message-1", content: [{ type: "text", text: "Hello" }] },
    });
    // A non-streamed block still reaches the transcript under its own index.
    normalizer.accept({
      type: "assistant",
      parent_tool_use_id: parent,
      message: { id: "message-1", content: [{ type: "text", text: "Hello" }] },
    });
  }
  expect(events.filter((event) => event.type === "text")).toEqual(
    ["main", "subagent-tool"].flatMap((parent) => [
      { type: "text", id: `${parent}:message-1:0`, text: "Considering", reasoning: true },
      { type: "text", id: `${parent}:message-1:1`, text: "Hello", reasoning: false },
      { type: "text", id: `${parent}:message-1:2`, text: "Hello", reasoning: false },
    ]),
  );
});

test("Claude tool lifecycle and usage remain structured and subscription cost is labelled as an estimate", () => {
  const events: AgentEvent[] = [],
    normalizer = new ClaudeEventNormalizer((event) => events.push(event));
  normalizer.accept({
    type: "assistant",
    message: {
      id: "message",
      content: [{ type: "tool_use", id: "tool-1", name: "Read", input: { path: "<script>untrusted</script>" } }],
    },
  });
  normalizer.accept({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "file content", is_error: false }] },
  });
  normalizer.accept({
    type: "result",
    subtype: "success",
    is_error: false,
    total_cost_usd: 0.1,
    usage: { input_tokens: 12, output_tokens: 34 },
  });
  expect(events.filter((event) => event.type === "tool").map((event) => event.status)).toEqual([
    "running",
    "completed",
  ]);
  expect(events.find((event) => event.type === "usage")).toMatchObject({
    value: { scope: "native-session", estimatedCostUsd: 0.1, input_tokens: 12, output_tokens: 34 },
  });
  expect(events.at(-1)).toEqual({ type: "completed" });
});

test("Claude empty stream blocks do not shift later text and non-streamed messages preserve all blocks", () => {
  const events: AgentEvent[] = [];
  const normalizer = new ClaudeEventNormalizer((event) => events.push(event));
  normalizer.accept({ type: "stream_event", event: { type: "message_start", message: { id: "empty-first" } } });
  normalizer.accept({
    type: "stream_event",
    event: { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
  });
  normalizer.accept({ type: "stream_event", event: { type: "content_block_stop", index: 0 } });
  normalizer.accept({
    type: "stream_event",
    event: { type: "content_block_start", index: 1, content_block: { type: "text" } },
  });
  normalizer.accept({
    type: "stream_event",
    event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hello" } },
  });
  normalizer.accept({ type: "assistant", message: { id: "empty-first", content: [{ type: "text", text: "Hello" }] } });
  normalizer.accept({ type: "stream_event", event: { type: "content_block_stop", index: 1 } });
  normalizer.accept({
    type: "assistant",
    message: {
      id: "no-stream",
      content: [
        { type: "thinking", thinking: "Plan" },
        { type: "text", text: "Answer" },
      ],
    },
  });
  expect(events.filter((event) => event.type === "text").map((event) => [event.id, event.text])).toEqual([
    ["main:empty-first:1", "Hello"],
    ["main:no-stream:0", "Plan"],
    ["main:no-stream:1", "Answer"],
  ]);
});

test("Claude foreground status distinguishes signed-out exit 1 from errors and refuses API billing", async () => {
  const adapter = new ClaudeManagedAdapter();
  const { validLoginUrl } = await import("../../../spa/src/agent-login.js");
  // The pinned native login now uses claude.com; match only its exact host.
  expect(validLoginUrl("https://claude.com/cai/oauth/authorize", adapter.authHosts)).toBe(
    "https://claude.com/cai/oauth/authorize",
  );
  expect(validLoginUrl("https://claude.com.evil.test/cai/oauth/authorize", adapter.authHosts)).toBeNull();
  const calls: unknown[] = [];
  let exitCode = 0;
  let observation = {
    loggedIn: true,
    authMethod: "claude.ai",
    apiProvider: "firstParty",
    email: "writer@example.test",
    orgId: "org-a",
    subscriptionType: "Max",
  };
  const launcher: ProcessLauncher = {
    async spawn(options) {
      calls.push({ args: options.args, env: options.env, cwd: options.cwd });
      options.onData("stdout", Buffer.from(JSON.stringify(observation)));
      return {
        pid: 123,
        exited: Promise.resolve({ code: exitCode, signal: null, groupEmpty: true }),
        async write() {},
        async fence() {},
        async stop() {},
        resize() {},
      };
    },
  };
  const spec = {
    cwd: "/isolated/login",
    configRoot: "/isolated/account-a",
    env: adapter.profileEnvironment("/isolated/account-a"),
    manifest: { executable: "/qualified/claude" },
  } as ProfileLaunchSpec;
  expect(await adapter.probe(spec, launcher)).toMatchObject({
    state: "authenticated",
    identity: "org-a:writer@example.test",
    method: "Claude subscription",
  });
  observation = { ...observation, authMethod: "api_key" };
  expect(await adapter.probe(spec, launcher)).toMatchObject({ state: "probe_failed" });
  expect(calls).toHaveLength(2);
  expect(calls[0]).toMatchObject({
    args: ["auth", "status", "--json"],
    env: { CLAUDE_CONFIG_DIR: "/isolated/account-a", DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1" },
    cwd: "/isolated/login",
  });
  // Native 2.1.280 returns a complete loggedIn:false response with exit 1.
  observation = { ...observation, loggedIn: false, authMethod: "none" };
  exitCode = 1;
  expect(await adapter.probe(spec, launcher)).toMatchObject({ state: "needs_login" });
  observation = { ...observation, loggedIn: true, authMethod: "claude.ai" };
  expect(await adapter.probe(spec, launcher)).toMatchObject({ state: "probe_failed" });
  observation = { ...observation, loggedIn: false };
  exitCode = 2;
  expect(await adapter.probe(spec, launcher)).toMatchObject({ state: "probe_failed" });
});

test("Claude SDK seam keeps native IO supervised, isolates auth and routes a permission response", async () => {
  const writes: string[] = [],
    starts: Parameters<ProcessLauncher["spawn"]>[0][] = [],
    events: AgentEvent[] = [];
  let stopped = 0,
    configured!: Parameters<ClaudeSdk["query"]>[0];
  let readiness = { name: "glosa", status: "connected", tools: [{ name: "glosa_present" }] };
  let releaseStatus!: () => void;
  const statusGate = new Promise<void>((resolve) => {
    releaseStatus = resolve;
  });
  let statusRequested = false,
    waitStatus = false;
  const abort = new AbortController();
  const adapter = new ClaudeManagedAdapter(async () => ({
    query(input) {
      configured = input;
      const process = input.options.spawnClaudeCodeProcess({
        command: input.options.pathToClaudeCodeExecutable,
        args: ["--input-format", "stream-json"],
        cwd: "/wrong",
        env: { ANTHROPIC_API_KEY: "not-admitted" },
        signal: abort.signal,
      });
      process.on("error", () => {});
      return {
        supportedCommands: async () => [
          { name: "review", description: "Review writing", argumentHint: "document" },
          { name: "login", description: "Login", builtin: true },
          { name: "compact", description: "Compact", builtin: true },
        ],
        supportedModels: async () => [
          { value: "model", displayName: "Model", resolvedModel: "claude-sonnet-5", supportedEffortLevels: ["high"] },
        ],
        accountInfo: async () => ({
          email: "writer@example.test",
          organization: "A display name, not an org ID",
          apiProvider: "firstParty",
          apiKeySource: "none",
        }),
        mcpServerStatus: async () => {
          statusRequested = true;
          if (waitStatus) await statusGate;
          return [readiness];
        },
        interrupt: async () => {},
        close() {
          abort.abort();
        },
        async *[Symbol.asyncIterator]() {
          for await (const prompt of input.prompt) {
            await new Promise<void>((resolve, reject) =>
              process.stdin.write(JSON.stringify(prompt), (error) => (error ? reject(error) : resolve())),
            );
            const answer = await input.options.canUseTool(
              "Read",
              { file: "notes.md" },
              { signal: abort.signal, toolUseID: "permission-1" },
            );
            yield { type: "assistant", message: { id: "message", content: [{ type: "text", text: answer.behavior }] } };
            yield { type: "result", subtype: "success", is_error: false };
          }
        },
      } as ClaudeQuery;
    },
  }));
  const launcher: ProcessLauncher = {
    async spawn(options) {
      starts.push(options);
      if (options.args[0] === "auth")
        options.onData(
          "stdout",
          Buffer.from(
            JSON.stringify({
              loggedIn: true,
              authMethod: "claude.ai",
              apiProvider: "firstParty",
              email: "writer@example.test",
              orgId: "org-a",
            }),
          ),
        );
      let finish!: (value: { code: number; signal: null; groupEmpty: boolean }) => void;
      const exited =
        options.args[0] === "auth"
          ? Promise.resolve({ code: 0, signal: null, groupEmpty: true })
          : new Promise<{ code: number; signal: null; groupEmpty: boolean }>((resolve) => {
              finish = resolve;
            });
      return {
        pid: 1,
        exited,
        async write(data) {
          writes.push(data);
        },
        async fence() {},
        async stop() {
          stopped++;
          finish?.({ code: 0, signal: null, groupEmpty: true });
        },
        resize() {},
      };
    },
  };
  const spec = {
    profile: { auth: { identity: "org-a:writer@example.test" } },
    cwd: "/workspace",
    env: adapter.profileEnvironment("/private/profile"),
    manifest: { executable: "/qualified/claude", sdkModule: "/qualified/sdk.mjs" },
    settings: { model: "model", effort: "high", permissionMode: "default" },
    sessionId: "logical",
    runId: "run",
    generation: 1,
    mcp: {
      url: "http://127.0.0.1:4646/api/managed-mcp",
      grant: "private-grant",
      instructions: "App-owned Glosa workflow",
      requiredTools: ["glosa_present", "glosa_claim"],
    },
  } as SessionLaunchSpec;
  const connection = await adapter.connect(spec, launcher, (event) => events.push(event));
  try {
    expect((await connection.commands!())[0]).toMatchObject({
      name: "review",
      kind: "skill",
      argumentHint: "document",
    });
    expect((await connection.commands!()).map((entry) => entry.name)).toEqual(["review", "compact"]);
    expect(connection.capabilities.models[0]?.resolvedModel).toBe("claude-sonnet-5");
    expect(configured.options.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "App-owned Glosa workflow",
      snapshot: false,
    });
    const prompt = { turnId: "turn", text: "Read notes", settings: spec.settings, attachments: [] };
    // A connected server is insufficient when its tool catalog is incomplete.
    await expect(connection.startTurn(prompt)).rejects.toThrow("Your message was not sent");
    readiness = { ...readiness, status: "needs-auth" };
    await expect(connection.startTurn(prompt)).rejects.toThrow("Your message was not sent");
    expect(writes).toEqual([]);
    readiness = { ...readiness, status: "connected", tools: [{ name: "glosa_present" }, { name: "glosa_claim" }] };
    waitStatus = true;
    statusRequested = false;
    const sending = connection.startTurn(prompt);
    for (let i = 0; i < 30 && !statusRequested; i++) await Promise.resolve();
    expect(statusRequested).toBe(true);
    expect(writes).toEqual([]);
    releaseStatus();
    await sending;
    for (let i = 0; i < 30 && !events.some((event) => event.type === "decision"); i++) await Promise.resolve();
    expect(events.find((event) => event.type === "decision")).toMatchObject({ decision: { id: "permission-1" } });
    await connection.answer("permission-1", "allow");
    for (let i = 0; i < 30 && !events.some((event) => event.type === "completed"); i++) await Promise.resolve();
    expect(events.find((event) => event.type === "text")).toMatchObject({ text: "allow" });
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]!).message.content).toEqual([{ type: "text", text: "Read notes" }]);
    expect(starts[1]).toMatchObject({
      command: "/qualified/claude",
      cwd: "/workspace",
      env: { CLAUDE_CONFIG_DIR: "/private/profile", GLOSA_MANAGED_MCP_GRANT: "private-grant" },
    });
    expect(starts[1]!.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(starts[1]!.args.join(" ")).not.toContain("private-grant");
    expect(configured.options.settingSources).toEqual([]);
    expect(configured.options.strictMcpConfig).toBe(true);
    expect(configured.options.settings.disableClaudeAiConnectors).toBe(true);
  } finally {
    await connection.close();
  }
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(stopped).toBeGreaterThanOrEqual(2);
});

test("Claude local command results are visible once without duplicating assistant output", () => {
  const events: AgentEvent[] = [],
    normalizer = new ClaudeEventNormalizer((event) => events.push(event));
  normalizer.accept({ type: "result", subtype: "success", result: "Context usage" });
  expect(events.filter((event) => event.type === "text")).toHaveLength(1);
  normalizer.accept({ type: "assistant", message: { id: "message", content: [{ type: "text", text: "Reply" }] } });
  normalizer.accept({ type: "result", subtype: "success", result: "Reply" });
  expect(events.filter((event) => event.type === "text")).toHaveLength(2);
});

test("linked Claude loads enabled native plugins and tracks their authority without tracking skill descriptions", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "glosa-linked-claude-"))),
    configRoot = join(root, "native"),
    cwd = join(root, "workspace"),
    plugin = join(root, "plugin");
  mkdirSync(join(configRoot, "plugins"), { recursive: true });
  mkdirSync(cwd);
  mkdirSync(join(plugin, "hooks"), { recursive: true });
  mkdirSync(join(plugin, "skills"));
  writeFileSync(join(configRoot, "settings.json"), JSON.stringify({ enabledPlugins: { "writing@local": true } }));
  writeFileSync(
    join(configRoot, "plugins", "installed_plugins.json"),
    JSON.stringify({ version: 2, plugins: { "writing@local": [{ scope: "user", installPath: plugin }] } }),
  );
  writeFileSync(join(plugin, "hooks", "hooks.json"), JSON.stringify({ hooks: {} }));
  let configured: Parameters<ClaudeSdk["query"]>[0] | undefined;
  let finish!: () => void;
  const closed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const adapter = new ClaudeManagedAdapter(async () => ({
    query(options) {
      configured = options;
      return {
        supportedModels: async () => [],
        supportedCommands: async () => [],
        accountInfo: async () => ({
          email: "writer@example.test",
          organization: "org",
          apiProvider: "firstParty",
          apiKeySource: "none",
        }),
        interrupt: async () => {},
        close: finish,
        async *[Symbol.asyncIterator]() {
          await closed;
          yield { type: "system", subtype: "closed" };
        },
      };
    },
  }));
  adapter.probe = async () => ({
    state: "authenticated",
    identity: "org:writer@example.test",
    label: "writer@example.test",
    observedAt: new Date().toISOString(),
  });
  try {
    const before = adapter.configurationRevision(configRoot, cwd);
    writeFileSync(join(plugin, "skills", "SKILL.md"), "Changed description");
    expect(adapter.configurationRevision(configRoot, cwd)).toBe(before);
    writeFileSync(join(plugin, "hooks", "hooks.json"), JSON.stringify({ hooks: { SessionStart: [] } }));
    expect(adapter.configurationRevision(configRoot, cwd)).not.toBe(before);
    const spec = {
      configRoot,
      cwd,
      env: adapter.profileEnvironment(configRoot),
      profile: { configuration: { mode: "linked", path: configRoot }, auth: { identity: "org:writer@example.test" } },
      settings: { model: "", effort: "", permissionMode: "default" },
      manifest: { sdkModule: "/fixture-sdk", executable: "/fixture-cli" },
    } as SessionLaunchSpec;
    const connection = await adapter.connect(
      spec,
      {
        spawn: async () => {
          throw new Error("Unexpected process");
        },
      },
      () => {},
    );
    expect(configured!.options.settingSources).toEqual(["user", "project", "local"]);
    expect(configured!.options.strictMcpConfig).toBe(false);
    expect(configured!.options.plugins).toEqual([{ type: "local", path: plugin }]);
    await connection.close();
    writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { glosa: { command: "conflict" } } }));
    expect(() => adapter.configurationRevision(configRoot, cwd)).toThrow("reserved glosa");
  } finally {
    finish();
    rmSync(root, { recursive: true, force: true });
  }
});

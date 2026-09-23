// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import type {
  AgentEvent,
  ProcessLauncher,
  ProfileLaunchSpec,
  SessionLaunchSpec,
} from "../../../daemon/src/agents/interface.ts";
import { ClaudeEventNormalizer, ClaudeManagedAdapter, type ClaudeQuery, type ClaudeSdk } from "../src/managed.ts";

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
        supportedModels: async () => [{ value: "model", displayName: "Model", supportedEffortLevels: ["high"] }],
        accountInfo: async () => ({
          email: "writer@example.test",
          organization: "A display name, not an org ID",
          apiProvider: "firstParty",
          apiKeySource: "none",
        }),
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
    mcp: { url: "http://127.0.0.1:4646/api/managed-mcp", grant: "private-grant" },
  } as SessionLaunchSpec;
  const connection = await adapter.connect(spec, launcher, (event) => events.push(event));
  try {
    await connection.startTurn({ turnId: "turn", text: "Read notes", settings: spec.settings, attachments: [] });
    for (let i = 0; i < 30 && !events.some((event) => event.type === "decision"); i++) await Promise.resolve();
    expect(events.find((event) => event.type === "decision")).toMatchObject({ decision: { id: "permission-1" } });
    await connection.answer("permission-1", "allow");
    for (let i = 0; i < 30 && !events.some((event) => event.type === "completed"); i++) await Promise.resolve();
    expect(events.find((event) => event.type === "text")).toMatchObject({ text: "allow" });
    expect(writes).toHaveLength(1);
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

// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, ProcessLauncher, SessionLaunchSpec } from "../../../daemon/src/agents/interface.ts";
import { CODEX_WORKSPACE_PERMISSION, CodexManagedAdapter } from "../src/managed.ts";
import nativeConfiguration from "./fixtures/codex-0.156.1-config.json";
import { codexRuntimeCandidate } from "../src/runtime.ts";
import { runtimeTarget } from "../../../daemon/src/agents/runtimes.ts";
import { RuntimeSupervisor } from "../../../daemon/src/agents/supervisor.ts";
import { managedEnvironment } from "../../../daemon/src/agents/environment.ts";
import { waitUntil } from "../../../daemon/test/helpers.ts";

test("Codex candidates select frozen native packages for each supported target and remain unqualified", () => {
  for (const target of [
    runtimeTarget("darwin", "arm64"),
    runtimeTarget("darwin", "x64"),
    runtimeTarget("linux", "x64", "glibc"),
  ]) {
    const candidate = codexRuntimeCandidate(target);
    const lock = Bun.JSONC.parse(readFileSync(candidate.lockFile, "utf8")) as {
      workspaces: Record<string, { dependencies: Record<string, string> }>;
      packages: Record<string, [string, string, Record<string, string>, string]>;
    };
    expect(candidate).toMatchObject({ ...target, qualified: false, version: "0.156.1" });
    expect(candidate.packages["@openai/codex"]).toBe(`0.156.1-${target.platform}-${target.architecture}`);
    expect(lock.workspaces[""]!.dependencies).toEqual(candidate.packages);
    expect(lock.packages["@openai/codex"]![2]).toMatchObject({ os: target.platform, cpu: target.architecture });
    expect(lock.packages["@openai/codex"]![3]).toStartWith("sha512-");
  }
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("Codex stdio transport uses the admitted executable and private config, then stops its owned descendant", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "glosa-codex-process-")));
  roots.push(root);
  const configRoot = join(root, "profile"),
    cwd = join(root, "workspace"),
    system = join(root, "system");
  for (const dir of [configRoot, cwd, system]) mkdirSync(dir);
  const executable = join(root, "codex"),
    observed = join(configRoot, "observed.json");
  writeFileSync(join(system, "codex"), "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  writeFileSync(join(system, "config.toml"), 'model_provider="poison"');
  // An offline protocol stand-in, not the vendor CLI: real pipes, environment and process ownership.
  writeFileSync(
    executable,
    `#!${process.execPath}
import {writeFileSync} from "node:fs";
import {createInterface} from "node:readline";
const config=${JSON.stringify(nativeConfiguration.config)}, layers=${JSON.stringify(nativeConfiguration.layers)};
const args=process.argv.slice(2), methods=[];
for(let i=0;i<args.length;i++) if(args[i]==="-c") {
  const entry=args[++i], at=entry.indexOf("="), path=entry.slice(0,at).split(".");
  let target=config; while(path.length>1) {const key=path.shift(); target=target[key]??={};}
  target[path[0]]=(Bun.TOML.parse("value="+entry.slice(at+1))).value;
}
const descendant=Bun.spawn(["/bin/sleep","60"],{stdin:"ignore",stdout:"ignore",stderr:"ignore"});
const output=value=>console.log(JSON.stringify(value));
for await(const line of createInterface({input:process.stdin})) {
 const frame=JSON.parse(line); if(!frame.method||frame.id===undefined) continue;
 methods.push(frame.method);
 writeFileSync(${JSON.stringify(observed)},JSON.stringify({args,methods,cwd:process.cwd(),configRoot:process.env.CODEX_HOME,key:process.env.OPENAI_API_KEY,preload:process.env.NODE_OPTIONS,descendant:descendant.pid}));
 let result={};
 if(frame.method==="config/read") result={config,layers};
 if(frame.method==="account/read") result={account:{type:"chatgpt",email:"writer@example.test",planType:"pro"},requiresOpenaiAuth:true};
 if(frame.method==="model/list") result={data:[{id:"model",model:"model",displayName:"Fixture",supportedReasoningEfforts:[{reasoningEffort:"high"}]}],nextCursor:null};
 if(frame.method==="thread/start") result={thread:{id:"thread-a"}};
 if(frame.method==="turn/start") {
   output({method:"turn/started",params:{threadId:"thread-a",turn:{id:"turn-a"}}});
   output({method:"item/agentMessage/delta",params:{threadId:"thread-a",turnId:"turn-a",itemId:"one",delta:frame.params.input[0].text}});
   result={turn:{id:"turn-a"}};
 }
 output({id:frame.id,result});
}
`,
    { mode: 0o700 },
  );
  const adapter = new CodexManagedAdapter(),
    supervisor = new RuntimeSupervisor(join(root, "owner"));
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
        CODEX_HOME: system,
        OPENAI_API_KEY: "poison",
        NODE_OPTIONS: "--require=poison",
      },
      adapter.profileEnvironment(configRoot),
    ),
    profile: { auth: { identity: "chatgpt:writer@example.test" } },
    manifest: { executable },
    settings: { model: "model", effort: "high", permissionMode: "default" },
  } as SessionLaunchSpec;
  let connection: Awaited<ReturnType<typeof adapter.connect>> | undefined;
  try {
    connection = await adapter.connect(spec, launcher, (event) => events.push(event));
    await connection.startTurn({ turnId: "logical", text: "local fixture", settings: spec.settings, attachments: [] });
    expect(await waitUntil(() => events.some((event) => event.type === "text"))).toBe(true);
    expect(events.find((event) => event.type === "text")).toMatchObject({ text: "local fixture" });
    await connection.interrupt();
    const observation = JSON.parse(readFileSync(observed, "utf8"));
    expect(observation).toMatchObject({ configRoot, cwd: configRoot });
    expect(observation.key).toBeUndefined();
    expect(observation.preload).toBeUndefined();
    expect(observation.args).toContain("app-server");
    expect(observation.methods).toContain("turn/interrupt");
    expect(readFileSync(join(system, "config.toml"), "utf8")).toBe('model_provider="poison"');
    await connection.close();
    for (const child of children) expect((await child.exited).groupEmpty).toBe(true);
    expect(supervisor.activeCount).toBe(0);
    expect(supervisor.recoveryRequired).toBe(false);
  } finally {
    await connection?.close();
    await supervisor.close();
  }
}, 15_000);

function fixture(account = { type: "chatgpt", email: "writer@example.test", planType: "pro" }) {
  const root = mkdtempSync(join(tmpdir(), "glosa-codex-policy-"));
  roots.push(root);
  const cwd = join(root, "workspace"),
    neutral = join(root, "neutral");
  mkdirSync(cwd);
  mkdirSync(neutral);
  let config: Record<string, unknown> = {};
  let layers: object[] = structuredClone(nativeConfiguration.layers);
  const sent: Record<string, any>[] = [];
  const starts: Parameters<ProcessLauncher["spawn"]>[0][] = [];
  let output: (value: object) => void = () => {};
  let stopped = false;
  let threadOverrides: object = {};
  let mcpStatus: (params: Record<string, unknown>) => Promise<object> = async () => ({ data: [], nextCursor: null });
  const launcher: ProcessLauncher = {
    async spawn(options) {
      starts.push(options);
      expect(options.env.CODEX_HOME).toBe("/isolated/profile-a");
      if (spec.profile.configuration) {
        expect(options.args).not.toContain('cli_auth_credentials_store="file"');
        expect(options.args).not.toContain("features.plugins=false");
      } else {
        expect(options.args).toContain('cli_auth_credentials_store="file"');
        expect(options.args).toContain("features.apps=false");
        expect(options.args).toContain("features.plugins=false");
      }
      expect(options.args).toContain("analytics.enabled=false");
      expect(options.cwd).toBe(neutral);
      for (let i = 0; i < options.args.length; i++) {
        if (options.args[i] !== "-c") continue;
        const entry = options.args[++i]!,
          at = entry.indexOf("="),
          path = entry.slice(0, at).split(".");
        let target = config;
        while (path.length > 1) {
          const key = path.shift()!;
          target = (target[key] ??= {}) as Record<string, unknown>;
        }
        target[path[0]!] = (Bun.TOML.parse("value=" + entry.slice(at + 1)) as { value: unknown }).value;
      }
      output = (value) => options.onData("stdout", Buffer.from(`${JSON.stringify(value)}\n`));
      return {
        pid: 123,
        exited: new Promise(() => {}),
        async fence() {},
        async stop() {
          stopped = true;
        },
        resize() {},
        async write(wire) {
          const frame = JSON.parse(wire);
          sent.push(frame);
          if (!frame.method || frame.id === undefined) return;
          let result: object = {};
          if (frame.method === "config/read")
            result = {
              config: {
                // Captured from the pinned binary in an empty profile, with networking
                // blocked. This proves wire compatibility, not native account isolation.
                ...structuredClone(nativeConfiguration.config),
                ...config,
                otel: {
                  tool_result: { max_bytes: 2048 },
                  log_user_prompt: null,
                  environment: null,
                  span_attributes: null,
                  tracestate: null,
                  ...(config.otel as object),
                },
                features: { network_proxy: null, ...(config.features as object) },
              },
              layers,
            };
          if (frame.method === "account/read") result = { account, requiresOpenaiAuth: true };
          if (frame.method === "model/list")
            result = {
              data: [
                {
                  id: "model",
                  model: "model",
                  displayName: "A model",
                  supportedReasoningEfforts: [{ reasoningEffort: "high" }],
                  inputModalities: ["text"],
                },
              ],
              nextCursor: null,
            };
          if (frame.method === "thread/start" || frame.method === "thread/resume")
            result = {
              thread: { id: "thread-a" },
              ...(frame.params.permissions
                ? {
                    cwd: spec.cwd,
                    approvalPolicy: "on-request",
                    approvalsReviewer: "user",
                    activePermissionProfile: { id: frame.params.permissions, extends: null },
                    sandbox: {
                      type: "workspaceWrite",
                      writableRoots: [],
                      networkAccess: false,
                      excludeTmpdirEnvVar: true,
                      excludeSlashTmp: true,
                    },
                  }
                : {}),
              ...threadOverrides,
            };
          if (frame.method === "mcpServerStatus/list") result = await mcpStatus(frame.params);
          if (frame.method === "skills/list")
            result = {
              data: [
                {
                  cwd,
                  skills: [
                    { name: "review", description: "Review", path: "/native/skills/review/SKILL.md", enabled: true },
                  ],
                },
              ],
            };
          if (frame.method === "turn/start") {
            output({ method: "turn/started", params: { threadId: "thread-a", turn: { id: "turn-a" } } });
            result = { turn: { id: "turn-a" } };
          }
          output({ id: frame.id, result });
        },
      };
    },
  };
  const spec = {
    env: { CODEX_HOME: "/isolated/profile-a" },
    cwd,
    configRoot: neutral,
    probeCwd: neutral,
    manifest: { executable: "/pinned/codex" },
    profile: { auth: { identity: "chatgpt:writer@example.test" } },
  } as unknown as SessionLaunchSpec;
  return {
    launcher,
    spec,
    sent,
    starts,
    root,
    setConfig: (value: Record<string, unknown>) => {
      config = { ...config, ...value };
    },
    setLayers: (value: object[]) => {
      layers = value;
    },
    output: (value: object) => output(value),
    stopped: () => stopped,
    setThreadOverrides: (value: object) => {
      threadOverrides = value;
    },
    setMcpStatus: (read: typeof mcpStatus) => {
      mcpStatus = read;
    },
  };
}

test("Codex verifies subscription identity before opening a thread and never accepts API credentials", async () => {
  const adapter = new CodexManagedAdapter(),
    f = fixture({ type: "apiKey", email: "writer@example.test", planType: "pro" });
  await expect(adapter.connect(f.spec, f.launcher, () => {})).rejects.toThrow("Sign in again to this ChatGPT account");
  expect(f.sent.some((frame) => frame.method === "thread/start")).toBe(false);
  expect(f.stopped()).toBe(true);
});

test("Codex streams one copy, scopes decisions to the active thread, and writes a human answer once", async () => {
  const f = fixture(),
    events: AgentEvent[] = [],
    adapter = new CodexManagedAdapter();
  const connection = await adapter.connect(f.spec, f.launcher, (event) => events.push(event));
  expect(f.sent.some((frame) => frame.method === "thread/start")).toBe(false);
  await connection.startTurn({
    turnId: "logical-turn",
    text: "Review the draft",
    settings: { model: "model", effort: "high", permissionMode: "plan" },
    attachments: [],
  });
  const start = f.sent.find((frame) => frame.method === "turn/start")!;
  expect(start.params.sandboxPolicy).toEqual({ type: "readOnly" });
  f.output({
    method: "item/agentMessage/delta",
    params: { threadId: "thread-a", turnId: "turn-a", itemId: "item-a", delta: "Hello" },
  });
  f.output({
    method: "item/completed",
    params: { threadId: "thread-a", turnId: "turn-a", item: { id: "item-a", type: "agentMessage", text: "Hello" } },
  });
  f.output({ id: 98, method: "item/fileChange/requestApproval", params: { threadId: "other", turnId: "turn-a" } });
  f.output({
    id: 99,
    method: "item/fileChange/requestApproval",
    params: { threadId: "thread-a", turnId: "turn-a", reason: "Edit draft" },
  });
  expect(
    events
      .filter((event) => event.type === "text")
      .map((event) => event.text)
      .join(""),
  ).toBe("Hello");
  const decisions = events.filter((event) => event.type === "decision");
  expect(decisions).toHaveLength(1);
  await connection.answer(decisions[0]!.decision.id, "deny");
  await expect(connection.answer(decisions[0]!.decision.id, "allow")).rejects.toThrow("no longer waiting");
  expect(f.sent.filter((frame) => frame.id === 99)).toEqual([{ id: 99, result: { decision: "decline" } }]);
  f.output({
    method: "turn/completed",
    params: {
      threadId: "thread-a",
      turn: {
        status: "failed",
        error: {
          message: "Subscription unavailable",
          additionalDetails: "Subscription unavailable. Bearer hidden-token",
        },
      },
    },
  });
  expect(events.find((event) => event.type === "failed")).toMatchObject({
    code: "native-turn-failed",
    details: "Subscription unavailable. Bearer [redacted]",
  });
  await connection.close();
  expect(f.stopped()).toBe(true);
});

test("Codex preserves explicit native tool denial and cancellation without completing an unfinished tool", async () => {
  const f = fixture(),
    events: AgentEvent[] = [];
  const connection = await new CodexManagedAdapter().connect(f.spec, f.launcher, (event) => events.push(event));
  try {
    await connection.startTurn({
      turnId: "logical",
      text: "Review",
      settings: { model: "model", effort: "high", permissionMode: "plan" },
      attachments: [],
    });
    const report = (method: string, id: string, status?: string) =>
      f.output({
        method,
        params: { threadId: "thread-a", turnId: "turn-a", item: { id, type: "commandExecution", status } },
      });
    report("item/started", "unfinished", "inProgress");
    for (const status of ["completed", "failed", "declined", "denied", "cancelled", "canceled", "interrupted"])
      report("item/completed", status, status);
    f.output({ method: "turn/completed", params: { threadId: "thread-a", turn: { status: "interrupted" } } });
    expect(events.filter((event) => event.type === "tool").map(({ id, status }) => [id, status])).toEqual([
      ["unfinished", "running"],
      ["completed", "completed"],
      ["failed", "failed"],
      ["declined", "denied"],
      ["denied", "denied"],
      ["cancelled", "cancelled"],
      ["canceled", "cancelled"],
      ["interrupted", "cancelled"],
    ]);
  } finally {
    await connection.close();
  }
});

test("Codex file changes expose readable file names and diffs while unknown shapes stay literal and bounded", async () => {
  const f = fixture(),
    events: AgentEvent[] = [];
  const connection = await new CodexManagedAdapter().connect(f.spec, f.launcher, (event) => events.push(event));
  try {
    await connection.startTurn({
      turnId: "logical",
      text: "Review",
      settings: { model: "model", effort: "high", permissionMode: "plan" },
      attachments: [],
    });
    const report = (id: string, changes: unknown[]) =>
      f.output({
        method: "item/completed",
        params: {
          threadId: "thread-a",
          turnId: "turn-a",
          item: { id, type: "fileChange", status: "completed", changes },
        },
      });
    report("files", [
      {
        path: "outline.md",
        kind: { type: "update", move_path: "opening.md" },
        diff: "@@ -1 +1 @@\n-Old opening\n+<script>literal text</script>",
      },
      { path: "new.md", kind: { type: "add" }, diff: "A new paragraph." },
      { path: "old.md", kind: { type: "delete" }, diff: "The removed paragraph." },
    ]);
    report("unknown", [{ path: "other.md", kind: { type: "future-kind" }, diff: "Exact native content" }]);
    report("long", [{ path: "large.md", kind: { type: "add" }, diff: "a".repeat(17_000) }]);
    const tools = events.filter((event) => event.type === "tool");
    expect(tools[0]?.detail).toBe(
      "File: outline.md\nChange: update\nMove to: opening.md\n\n@@ -1 +1 @@\n-Old opening\n+<script>literal text</script>\n\nFile: new.md\nChange: add\n\nA new paragraph.\n\nFile: old.md\nChange: delete\n\nThe removed paragraph.",
    );
    expect(JSON.parse(tools[1]!.detail!)).toMatchObject({
      changes: [{ kind: { type: "future-kind" }, diff: "Exact native content" }],
    });
    expect(tools[2]?.detail?.length).toBe(16_000);
    expect(tools[2]?.detail).toEndWith("\n[Tool detail truncated]");
  } finally {
    await connection.close();
  }
});

test("Codex refuses inherited endpoints or policy overrides before sending a prompt, including resume", async () => {
  const f = fixture(),
    adapter = new CodexManagedAdapter();
  const connection = await adapter.connect(f.spec, f.launcher, () => {});
  f.setConfig({ mcp_servers: { surprise: { url: "https://unapproved.example.test" } } });
  const input = {
    turnId: "logical-turn",
    text: "Private draft",
    settings: { model: "model", effort: "high", permissionMode: "plan" as const },
    attachments: [],
  };
  await expect(connection.startTurn(input)).rejects.toThrow("configuration conflicts");
  expect(f.sent.some((frame) => frame.method === "thread/start" || frame.method === "turn/start")).toBe(false);
  f.setConfig({ mcp_servers: {} });
  await connection.startTurn(input);
  f.setConfig({ analytics: { enabled: true } });
  await expect(connection.startTurn(input)).rejects.toThrow("configuration conflicts");
  expect(f.sent.filter((frame) => frame.method === "turn/start")).toHaveLength(1);
  expect(f.sent.some((frame) => frame.method === "thread/resume")).toBe(false);
  await connection.close();
});

test("Codex accepts recorded serialization defaults without allowing changed routing or raw-layer overrides", async () => {
  const adapter = new CodexManagedAdapter();
  for (const config of [
    { chatgpt_base_url: "https://unapproved.example.test/" },
    { history: { persistence: "none" } },
    { project_doc_max_bytes: 999999 },
    { project_doc_fallback_filenames: ["private.txt"] },
  ]) {
    const f = fixture();
    f.setConfig(config);
    await expect(adapter.connect(f.spec, f.launcher, () => {})).rejects.toThrow("configuration conflicts");
    expect(f.sent.some((frame) => frame.method === "account/read" || frame.method === "thread/start")).toBe(false);
    expect(f.stopped()).toBe(true);
  }
  const f = fixture();
  f.setLayers([{ name: { type: "user" }, config: { chatgpt_base_url: "https://chatgpt.com/backend-api/" } }]);
  await expect(adapter.connect(f.spec, f.launcher, () => {})).rejects.toThrow("configuration conflicts");
  expect(f.stopped()).toBe(true);
});

test("Codex rejects project config and dangling configuration links before spawning", async () => {
  for (const dangling of [false, true]) {
    const f = fixture();
    mkdirSync(join(f.spec.cwd, ".codex"));
    const file = join(f.spec.cwd, ".codex", "config.toml");
    if (dangling) symlinkSync(join(f.root, "absent"), file);
    else writeFileSync(file, "[mcp_servers.inherited]\ncommand = 'unexpected'\n");
    await expect(new CodexManagedAdapter().connect(f.spec, f.launcher, () => {})).rejects.toThrow(
      "configuration conflicts",
    );
    expect(f.sent).toEqual([]);
  }
});

test("Codex rechecks workspace configuration after connecting and before native admission", async () => {
  const f = fixture(),
    connection = await new CodexManagedAdapter().connect(f.spec, f.launcher, () => {});
  mkdirSync(join(f.spec.cwd, ".codex"));
  writeFileSync(join(f.spec.cwd, ".codex", "config.toml"), "# Created after model discovery");
  await expect(
    connection.startTurn({
      turnId: "t",
      text: "private",
      settings: { model: "model", effort: "high", permissionMode: "plan" },
      attachments: [],
    }),
  ).rejects.toThrow("configuration conflicts");
  expect(f.sent.some((frame) => frame.method === "thread/start")).toBe(false);
  await connection.close();
});

test("Codex blocks linked-worktree inherited configuration but does not import home configuration", async () => {
  const f = fixture(),
    adapter = new CodexManagedAdapter();
  // A parent/home .codex is not project config when no Git root exists.
  mkdirSync(join(f.root, ".codex"));
  writeFileSync(join(f.root, ".codex", "config.toml"), "private system CLI settings");
  const connection = await adapter.connect(f.spec, f.launcher, () => {});
  await connection.close();
  const checkout = join(f.root, "checkout"),
    gitDir = join(checkout, ".git"),
    worktreeGit = join(gitDir, "worktrees", "one");
  mkdirSync(worktreeGit, { recursive: true });
  writeFileSync(join(worktreeGit, "commondir"), "../..\n");
  writeFileSync(join(f.spec.cwd, ".git"), `gitdir: ${worktreeGit}\n`);
  mkdirSync(join(checkout, ".codex"));
  writeFileSync(join(checkout, ".codex", "config.toml"), "[mcp_servers.extra]\ncommand = 'unexpected'\n");
  const sentBefore = f.sent.length;
  await expect(adapter.connect(f.spec, f.launcher, () => {})).rejects.toThrow("configuration conflicts");
  expect(f.sent.length).toBe(sentBefore);
});

test("Codex refuses an unexpected project layer even when its dangerous settings are masked", async () => {
  const f = fixture();
  f.setLayers([{ name: { type: "project" }, config: { model: "another-model" } }]);
  await expect(new CodexManagedAdapter().preflight(f.spec, f.launcher)).rejects.toThrow("configuration conflicts");
  expect(f.sent.some((frame) => frame.method === "account/read" || frame.method === "thread/start")).toBe(false);
  expect(f.stopped()).toBe(true);
});

test("Codex waits for the built-in catalog before sending and reinstalls guidance on resume", async () => {
  const f = fixture();
  f.spec.mcp = {
    url: "http://127.0.0.1:4646/api/managed-mcp",
    grant: "private-grant",
    instructions: "App-owned Glosa workflow",
    requiredTools: ["glosa_present", "glosa_claim"],
  };
  let release!: () => void,
    observed = false;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  let server = {
    name: "glosa-managed",
    runtimeStatus: "connected",
    authStatus: "unsupported",
    tools: { present: { name: "glosa_present" } } as Record<string, { name: string }>,
  };
  f.setMcpStatus(async (params) => {
    expect(params.threadId).toBe("thread-a");
    expect(params.detail).toBe("toolsAndAuthOnly");
    if (!params.cursor)
      return { data: [{ ...server, name: "glosa-user-optional", runtimeStatus: "failed" }], nextCursor: "page2" };
    observed = true;
    await gate;
    return { data: [server], nextCursor: null };
  });
  const connection = await new CodexManagedAdapter().connect(f.spec, f.launcher, () => {});
  const input = {
    turnId: "turn",
    text: "Review the draft",
    settings: { model: "model", effort: "high", permissionMode: "default" as const },
    attachments: [],
  };
  try {
    const preparing = connection.prepareTurn!(input.settings);
    for (let i = 0; i < 100 && !observed; i++) await Promise.resolve();
    expect(observed).toBe(true);
    expect(f.sent.some((frame) => frame.method === "turn/start")).toBe(false);
    release();
    await expect(preparing).rejects.toThrow("Your message was not sent");
    server = { ...server, runtimeStatus: "authenticationRequired" };
    await expect(connection.startTurn(input)).rejects.toThrow("Your message was not sent");
    expect(f.sent.some((frame) => frame.method === "turn/start")).toBe(false);
    server = {
      ...server,
      runtimeStatus: "connected",
      tools: { present: { name: "glosa_present" }, claim: { name: "glosa_claim" } },
    };
    await connection.prepareTurn!(input.settings);
    expect(f.sent.some((frame) => frame.method === "turn/start")).toBe(false);
    await connection.startTurn(input);
    const starts = f.sent.filter((frame) => ["thread/start", "thread/resume"].includes(frame.method));
    expect(starts.map((frame) => frame.method)).toContain("thread/resume");
    for (const frame of starts) {
      expect(frame.params.developerInstructions).toBe("App-owned Glosa workflow");
      expect(frame.params.config["mcp_servers.glosa-managed"]).toEqual({
        url: f.spec.mcp.url,
        bearer_token_env_var: "GLOSA_MANAGED_MCP_GRANT",
      });
    }
    expect(f.sent.filter((frame) => frame.method === "turn/start")).toHaveLength(1);
    expect(f.sent.find((frame) => frame.method === "turn/start")!.params.input).toEqual([
      { type: "text", text: "Review the draft" },
    ]);
    expect((await connection.mcpStatus!()).find((item) => item.name === "glosa-managed")!.login).toBe(false);
  } finally {
    await connection.close();
  }
});

test("Codex selected skills send the native skill item and dollar syntax", async () => {
  const f = fixture();
  const connection = await new CodexManagedAdapter().connect(f.spec, f.launcher, () => {});
  try {
    const commands = await connection.commands!(true);
    const skill = commands.find((item) => item.name === "review")!;
    await connection.startTurn({
      turnId: "logical",
      text: "/review notes",
      commandId: skill.id,
      settings: { model: "model", effort: "high", permissionMode: "plan" },
      attachments: [],
    });
    expect(f.sent.find((frame) => frame.method === "turn/start")!.params.input).toEqual([
      { type: "text", text: "$review notes" },
      { type: "skill", name: "review", path: "/native/skills/review/SKILL.md" },
    ]);
  } finally {
    await connection.close();
  }
});

test("linked Codex preserves native credentials and project tools but refuses a reserved MCP name", async () => {
  const f = fixture();
  f.spec.profile.configuration = { mode: "linked", path: f.spec.configRoot };
  mkdirSync(join(f.spec.cwd, ".codex"));
  writeFileSync(join(f.spec.cwd, ".codex", "config.toml"), "[features]\nplugins = true\n");
  f.setLayers([{ name: { type: "project" }, config: { features: { plugins: true } } }]);
  const nativeConfig = readFileSync(join(f.spec.cwd, ".codex", "config.toml"), "utf8");
  f.setConfig({ mcp_servers: { glosa: { command: "native-glosa" } } });
  const adapter = new CodexManagedAdapter();
  expect(await adapter.probe(f.spec, f.launcher)).toMatchObject({ state: "authenticated" });
  const connection = await adapter.connect(f.spec, f.launcher, () => {});
  expect(connection.capabilities.models).toHaveLength(1);
  await connection.close();
  expect(readFileSync(join(f.spec.cwd, ".codex", "config.toml"), "utf8")).toBe(nativeConfig);
  f.setConfig({ mcp_servers: { "glosa-managed": { command: "conflict" } } });
  await expect(adapter.connect(f.spec, f.launcher, () => {})).rejects.toThrow("reserved glosa-managed");
  const accountReads = f.sent.filter((frame) => frame.method === "account/read").length;
  f.setConfig({ mcp_servers: { glosa: { command: "native-glosa" } }, openai_base_url: "https://routing.example.test" });
  await expect(adapter.preflight(f.spec, f.launcher)).rejects.toThrow("Native routing");
  expect(f.sent.filter((frame) => frame.method === "account/read")).toHaveLength(accountReads);
});

test("Codex workspace policy permits local writes with human outside/network approvals and plan remains read-only", async () => {
  for (const mode of ["workspace", "plan"] as const) {
    const f = fixture(),
      connection = await new CodexManagedAdapter().connect(f.spec, f.launcher, () => {});
    try {
      await connection.startTurn({
        turnId: "turn",
        text: "Review",
        settings: { model: "model", effort: "high", permissionMode: mode },
        attachments: [],
      });
      const start = f.sent.find((frame) => frame.method === "thread/start")!.params;
      const turn = f.sent.find((frame) => frame.method === "turn/start")!.params;
      expect(start.config.web_search).toBe("disabled");
      expect(start.approvalsReviewer).toBe("user");
      expect(turn.approvalsReviewer).toBe("user");
      expect(start.approvalPolicy).toBe(mode === "workspace" ? "on-request" : "untrusted");
      expect(turn.approvalPolicy).toBe(start.approvalPolicy);
      expect(start.sandbox).toBe(mode === "workspace" ? undefined : "read-only");
      expect(start.permissions).toBe(mode === "workspace" ? CODEX_WORKSPACE_PERMISSION : undefined);
      expect(turn.permissions).toBe(start.permissions);
      expect(turn.sandboxPolicy).toEqual(mode === "workspace" ? undefined : { type: "readOnly" });
    } finally {
      await connection.close();
    }
  }
});

test.each([
  { activePermissionProfile: null },
  { activePermissionProfile: { id: ":workspace" } },
  { activePermissionProfile: { id: CODEX_WORKSPACE_PERMISSION, extends: ":workspace" } },
  { approvalsReviewer: "guardian_subagent" },
  { approvalPolicy: "never" },
  {
    sandbox: {
      type: "workspaceWrite",
      writableRoots: [],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: true,
    },
  },
])("workspace policy acknowledgement %j blocks input when confinement is not confirmed", async (overrides) => {
  const f = fixture();
  f.setThreadOverrides(overrides);
  const connection = await new CodexManagedAdapter().connect(f.spec, f.launcher, () => {});
  try {
    await expect(
      connection.startTurn({
        turnId: "turn",
        text: "Review",
        attachments: [],
        settings: { model: "model", effort: "high", permissionMode: "workspace" },
      }),
    ).rejects.toThrow("did not confirm confined workspace access");
    expect(f.sent.some((frame) => frame.method === "turn/start")).toBe(false);
  } finally {
    await connection.close();
  }
});

test("a widened reserved filesystem profile is refused before a workspace thread is created", async () => {
  const f = fixture();
  const connection = await new CodexManagedAdapter().connect(f.spec, f.launcher, () => {});
  try {
    f.setConfig({
      permissions: {
        [CODEX_WORKSPACE_PERMISSION]: {
          filesystem: { ":root": "read", [realpathSync(f.spec.cwd)]: "write" },
          network: { enabled: false },
        },
      },
    });
    await expect(
      connection.prepareTurn!({ model: "model", effort: "high", permissionMode: "workspace" }),
    ).rejects.toThrow("configuration conflicts");
    expect(f.sent.some((frame) => frame.method === "thread/start" || frame.method === "turn/start")).toBe(false);
  } finally {
    await connection.close();
  }
});

function oauthFixture() {
  const f = fixture();
  f.spec.profile.authentication = { mode: "oauth", credentialRef: "account-a" };
  f.spec.profile.auth.identity = "oauth:account-a";
  f.setLayers([]);
  const account = {
    accountId: "account-a",
    clientId: "client",
    issuer: "https://auth.openai.com",
    subject: "subject",
    label: "Writer",
    status: "signed-in" as const,
    planEnabled: true,
  };
  let leases = 0;
  let expiresAt = () => new Date(Date.now() + 3_600_000).toISOString();
  const broker = {
    getAccount: () => account,
    lease: async () => {
      leases++;
      return { accessToken: "synthetic-access-token", credentialVersion: "version-a", expiresAt: expiresAt() };
    },
  } as unknown as import("../../../daemon/src/agents/oauth-interface.ts").ManagedOAuthBroker;
  return {
    ...f,
    account,
    adapter: new CodexManagedAdapter({ oauth: broker }),
    leases: () => leases,
    setExpiration: (next: typeof expiresAt) => {
      expiresAt = next;
    },
  };
}

test("OAuth metadata probing never leases credentials or starts native inference and missing plan consent refuses dispatch", async () => {
  const f = oauthFixture();
  expect(await f.adapter.probe(f.spec, f.launcher)).toMatchObject({
    state: "authenticated",
    identity: "oauth:account-a",
    plan: "ChatGPT plan",
  });
  expect(f.leases()).toBe(0);
  expect(f.starts).toHaveLength(0);
  f.account.planEnabled = false;
  expect((await f.adapter.probe(f.spec, f.launcher)).plan).toBeUndefined();
  await expect(f.adapter.connect(f.spec, f.launcher, () => {})).rejects.toThrow("does not include ChatGPT plan access");
  expect(f.leases()).toBe(0);
  expect(f.starts).toHaveLength(0);
  f.account.planEnabled = true;
  f.spec.profile.auth.identity = "oauth:other-account";
  await expect(f.adapter.connect(f.spec, f.launcher, () => {})).rejects.toThrow("original ChatGPT account");
  expect(f.leases()).toBe(0);
  f.spec.profile.configuration = { mode: "linked", path: f.spec.configRoot };
  await expect(f.adapter.connect(f.spec, f.launcher, () => {})).rejects.toThrow("configuration conflicts");
  expect(f.starts).toHaveLength(0);
});

test("OAuth binds only the owned native environment, writes public startup policy and resumes without replay", async () => {
  const f = oauthFixture();
  f.spec.nativeId = "thread-a";
  f.spec.servers = [
    { id: "local", label: "Local", enabled: true, transport: "stdio", command: "/local/server", args: [] },
  ];
  const connection = await f.adapter.connect(f.spec, f.launcher, () => {});
  try {
    expect(f.leases()).toBe(1);
    expect(f.starts[0]!.env.ACCESS_TOKEN).toBe("synthetic-access-token");
    expect(f.starts[0]!.args.join(" ")).not.toContain("synthetic-access-token");
    const startup = readFileSync(join(f.spec.configRoot, "config.toml"), "utf8");
    expect(startup).not.toContain("synthetic-access-token");
    const config = Bun.TOML.parse(startup) as {
      model_provider: string;
      model_providers: Record<string, Record<string, unknown>>;
      shell_environment_policy: { include_only: string[] };
    };
    expect(config.model_provider).toBe("openai_chatgpt_plan");
    expect(config.model_providers.openai_chatgpt_plan).toEqual({
      name: "ChatGPT plan",
      base_url: "https://api.openai.com/v1",
      env_key: "ACCESS_TOKEN",
      wire_api: "responses",
      requires_openai_auth: false,
      supports_websockets: false,
      supports_standalone_web_search: false,
    });
    expect(config.shell_environment_policy).toMatchObject({
      inherit: "core",
      ignore_default_excludes: false,
      exclude: ["ACCESS_TOKEN", "GLOSA_MANAGED_MCP_GRANT"],
      set: {},
    });
    expect(config.shell_environment_policy.include_only).not.toContain("ACCESS_TOKEN");
    await connection.prepareTurn!({ model: "model", effort: "high", permissionMode: "workspace" });
    const resume = f.sent.find((frame) => frame.method === "thread/resume")!;
    expect(resume.params.modelProvider).toBe("openai_chatgpt_plan");
    expect(resume.params.threadId).toBe("thread-a");
    expect(resume.params.config["mcp_servers.glosa-user-local"]).toEqual({
      command: "/local/server",
      args: [],
      env: {},
      env_vars: [],
    });
    expect(f.sent.some((frame) => ["account/read", "thread/start", "turn/start"].includes(frame.method))).toBe(false);
    expect(JSON.stringify(f.sent)).not.toContain("synthetic-access-token");
  } finally {
    await connection.close();
  }
});

test("OAuth rejects changed startup routing and credential inheritance policy before launching", async () => {
  const f = oauthFixture();
  writeFileSync(join(f.spec.configRoot, "config.toml"), 'model_provider="openai"\n');
  await expect(f.adapter.connect(f.spec, f.launcher, () => {})).rejects.toThrow("configuration conflicts");
  expect(f.starts).toHaveLength(0);
  expect(f.leases()).toBe(0);
});

test("OAuth credential expiry fences the old process and the next foreground lease resumes without replay", async () => {
  const f = oauthFixture(),
    events: AgentEvent[] = [];
  // A real-time witness is intentional: this observes the expiry deadline that fences a process.
  f.setExpiration(() => new Date(Date.now() + 100).toISOString());
  const connection = await f.adapter.connect(f.spec, f.launcher, (event) => events.push(event));
  try {
    await connection.prepareTurn!({ model: "model", effort: "high", permissionMode: "workspace" });
    expect(
      await waitUntil(() => events.some((event) => event.type === "failed" && event.code === "auth-required")),
    ).toBe(true);
    expect(f.stopped()).toBe(true);
    await expect(
      connection.startTurn({
        turnId: "never-replay",
        text: "Unsent",
        settings: { model: "model", effort: "high", permissionMode: "workspace" },
        attachments: [],
      }),
    ).rejects.toThrow("stopped");
    expect(f.sent.some((frame) => frame.method === "turn/start")).toBe(false);
    expect(f.leases()).toBe(1);
  } finally {
    await connection.close();
  }
  f.setExpiration(() => new Date(Date.now() + 3_600_000).toISOString());
  f.spec.nativeId = "thread-a";
  const resumed = await f.adapter.connect(f.spec, f.launcher, () => {});
  try {
    await resumed.prepareTurn!({ model: "model", effort: "high", permissionMode: "workspace" });
    expect(f.leases()).toBe(2);
    expect(f.sent.some((frame) => frame.method === "thread/resume" && frame.params.threadId === "thread-a")).toBe(true);
    expect(f.sent.some((frame) => frame.method === "turn/start")).toBe(false);
  } finally {
    await resumed.close();
  }
});

test("Codex terminal error categories distinguish authentication and quota without guessing from titles", async () => {
  for (const [codexErrorInfo, code] of [
    ["unauthorized", "account-auth"],
    ["rateLimitExceeded", "quota"],
    [{ responseStreamConnectionFailed: { httpStatusCode: 401 } }, "account-auth"],
    ["other", "native-turn-failed"],
  ] as const) {
    const f = fixture(),
      events: AgentEvent[] = [];
    const connection = await new CodexManagedAdapter().connect(f.spec, f.launcher, (event) => events.push(event));
    try {
      await connection.startTurn({
        turnId: "logical",
        text: "Review",
        settings: { model: "model", effort: "high", permissionMode: "workspace" },
        attachments: [],
      });
      f.output({
        method: "turn/completed",
        params: {
          threadId: "thread-a",
          turn: { status: "failed", error: { codexErrorInfo, message: "Authentication failed: rate limit" } },
        },
      });
      expect(events.find((event) => event.type === "failed")).toMatchObject({ code });
    } finally {
      await connection.close();
    }
  }
});

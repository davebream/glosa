// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, ProcessLauncher, SessionLaunchSpec } from "../../../daemon/src/agents/interface.ts";
import { CodexManagedAdapter } from "../src/managed.ts";
import nativeConfiguration from "./fixtures/codex-0.156.1-config.json";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

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
  let output: (value: object) => void = () => {};
  let stopped = false;
  const launcher: ProcessLauncher = {
    async spawn(options) {
      expect(options.env.CODEX_HOME).toBe("/isolated/profile-a");
      expect(options.args).toContain('cli_auth_credentials_store="file"');
      expect(options.args).toContain("features.apps=false");
      expect(options.args).toContain("features.plugins=false");
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
        target[path[0]!] = JSON.parse(entry.slice(at + 1));
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
            result = { thread: { id: "thread-a" } };
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
    root,
    setConfig: (value: Record<string, unknown>) => {
      config = { ...config, ...value };
    },
    setLayers: (value: object[]) => {
      layers = value;
    },
    output: (value: object) => output(value),
    stopped: () => stopped,
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
  await connection.close();
  expect(f.stopped()).toBe(true);
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

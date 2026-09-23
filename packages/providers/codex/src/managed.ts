// SPDX-License-Identifier: Apache-2.0
// Native app-server stdio; no API client, credential extraction or terminal scraping.
import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
  ManagedAgentError,
  type AccountObservation,
  type AgentEvent,
  type ManagedAgentAdapter,
  type ManagedConnection,
  type OwnedProcess,
  type ProcessLauncher,
  type ProfileLaunchSpec,
  type SessionLaunchSpec,
} from "../../../daemon/src/agents/interface.ts";

const accountSchema = z.object({
  account: z
    .object({ type: z.literal("chatgpt"), email: z.string().email(), planType: z.string() })
    .passthrough()
    .nullable(),
  requiresOpenaiAuth: z.boolean(),
});
const modelsSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      model: z.string(),
      displayName: z.string(),
      supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string() })),
      inputModalities: z.array(z.string()).optional(),
    }),
  ),
  nextCursor: z.string().nullable(),
});
const threadSchema = z.object({
  thread: z.object({ id: z.string().min(1) }),
  model: z.string().optional(),
  reasoningEffort: z.string().nullable().optional(),
});
const envelope = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});
type Frame = z.infer<typeof envelope>;

const nativePolicy = {
  cli_auth_credentials_store: "file",
  mcp_oauth_credentials_store: "file",
  model_provider: "openai",
  otel: { exporter: "none", trace_exporter: "none", metrics_exporter: "none" },
  analytics: { enabled: false },
  feedback: { enabled: false },
  features: {
    apps: false,
    plugins: false,
    codex_hooks: false,
    hooks: false,
    plugin_hooks: false,
    // config/read reports these computed flags in this pinned runtime. Keep optional
    // integrations off, rather than mistaking reported defaults for approved tools.
    api_key_model_discovery: false,
    auth_elicitation: false,
    background_paginated_rollout_migration: false,
    codex_apps_mcp_2026_07_28: false,
    mcp_2026_07_28: false,
    memories: false,
    mentions_v2: false,
    remote_control: false,
    remote_plugin: false,
    tool_suggest: false,
    windows_sandbox_service: false,
  },
  check_for_update_on_startup: false,
  allow_login_shell: false,
  project_root_markers: [".git"],
};
const nativeConfig = Object.entries(nativePolicy).flatMap(([key, value]) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? Object.entries(value).flatMap(([child, item]) => ["-c", `${key}.${child}=${JSON.stringify(item)}`])
    : ["-c", `${key}=${JSON.stringify(value)}`],
);
function policyConflict(): never {
  throw new ManagedAgentError(
    "provider-unavailable",
    "Codex configuration conflicts with this isolated account. Remove inherited project tools or resolve the managed policy before continuing. Your configuration was not changed.",
  );
}
function metadata(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return policyConflict();
  }
}
/** Match the pinned .git discovery boundary, including the root checkout of linked worktrees. */
function checkProjectConfiguration(cwd: string): void {
  const start = realpathSync(cwd);
  const ancestors: string[] = [];
  let git: string | undefined;
  for (let current = start; ; current = dirname(current)) {
    ancestors.push(current);
    const path = join(current, ".git"),
      stat = metadata(path);
    if (stat) {
      if (stat.isSymbolicLink()) policyConflict();
      if (!stat.isDirectory() || metadata(join(path, "HEAD"))) {
        git = path;
        break;
      }
    }
    if (dirname(current) === current) break;
  }
  const roots = git ? ancestors : [start];
  if (git && !metadata(git)!.isDirectory()) {
    if (!metadata(git)!.isFile() || metadata(git)!.size > 4096) policyConflict();
    const match = /^gitdir: (.+)\s*$/.exec(readFileSync(git, "utf8"));
    if (!match) policyConflict();
    const gitDir = realpathSync(resolve(dirname(git), match[1]!));
    const common = join(gitDir, "commondir"),
      stat = metadata(common);
    if (stat) {
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) policyConflict();
      const commonDir = realpathSync(resolve(gitDir, readFileSync(common, "utf8").trim()));
      roots.push(dirname(commonDir));
    }
  }
  for (const root of roots) {
    const folder = join(root, ".codex"),
      stat = metadata(folder);
    if (stat?.isSymbolicLink() || (stat && !stat.isDirectory()) || metadata(join(folder, "config.toml")))
      policyConflict();
  }
}
/** Validate effective security values and raw layers; typed config/read also inserts defaults. */
function auditConfiguration(raw: unknown): void {
  const result = z
    .object({
      config: z.record(z.string(), z.unknown()),
      layers: z.array(z.object({ name: z.object({ type: z.string() }), config: z.record(z.string(), z.unknown()) })),
    })
    .safeParse(raw);
  if (!result.success) policyConflict();
  const withoutNulls = (value: unknown): unknown => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item != null)
        .map(([key, item]) => [key, withoutNulls(item)]),
    );
  };
  const config = withoutNulls(result.data.config) as Record<string, unknown>;
  // Pinned typed serialization adds this local log bound; it enables no exporter.
  const otel = config.otel as Record<string, unknown> | undefined;
  if (otel?.tool_result && JSON.stringify(otel.tool_result) === '{"max_bytes":2048}') delete otel.tool_result;
  // Reject all inherited tools/routing/hooks, even disabled entries: table overrides merge;
  // they do not replace inherited definitions or remove unapproved endpoint fields.
  for (const layer of result.data.layers) {
    if (layer.name.type === "project" && Object.keys(layer.config).length) policyConflict();
  }
  const equivalent = (actual: unknown, expected: unknown): boolean => {
    if (Array.isArray(expected)) return JSON.stringify(actual) === JSON.stringify(expected);
    if (expected && typeof expected === "object") {
      if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
      const record = actual as Record<string, unknown>;
      return (
        Object.keys(record).length === Object.keys(expected).length &&
        Object.entries(expected).every(([key, value]) => equivalent(record[key], value))
      );
    }
    return actual === expected;
  };
  for (const [key, value] of Object.entries(nativePolicy)) if (!equivalent(config[key], value)) policyConflict();
  const harmless = new Set([
    "model",
    "model_reasoning_effort",
    "model_reasoning_summary",
    "model_verbosity",
    "projects",
    "forced_chatgpt_workspace_id",
  ]);
  const emptyDefaults = new Set([
    "shell_environment_policy",
    "mcp_servers",
    "model_providers",
    "profiles",
    "plugins",
    "marketplaces",
  ]);
  const checkKeys = (values: Record<string, unknown>, rawLayer: boolean) => {
    for (const [key, value] of Object.entries(values)) {
      if (value == null || harmless.has(key)) continue;
      if (key in nativePolicy) {
        if (rawLayer) {
          const expected = nativePolicy[key as keyof typeof nativePolicy];
          if (
            value &&
            typeof value === "object" &&
            !Array.isArray(value) &&
            expected &&
            typeof expected === "object" &&
            !Array.isArray(expected)
          ) {
            for (const [child, item] of Object.entries(value))
              if (!equivalent(item, (expected as Record<string, unknown>)[child])) policyConflict();
          } else if (!equivalent(value, expected)) policyConflict();
        }
        continue;
      }
      if (key === "forced_login_method" && value === "chatgpt") continue;
      if (emptyDefaults.has(key) && equivalent(value, {})) continue;
      policyConflict();
    }
  };
  checkKeys(config, false);
  for (const layer of result.data.layers) checkKeys(layer.config, true);
}

/** One connection, one owned native process; bounded frames and requests, no reconnect/replay. */
export class ManagedCodexRpc {
  private process?: OwnedProcess;
  private readonly pending = new Map<
    string,
    { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  >();
  private buffer = "";
  private decoder = new TextDecoder();
  private closed = false;
  private sequence = 0;
  constructor(
    private readonly receive: (frame: Frame) => void,
    private readonly failed: () => void,
  ) {}
  async open(spec: ProfileLaunchSpec, launcher: ProcessLauncher): Promise<void> {
    checkProjectConfiguration(spec.cwd);
    const launchCwd = spec.probeCwd ?? spec.configRoot;
    checkProjectConfiguration(launchCwd);
    this.process = await launcher.spawn({
      command: spec.manifest.executable,
      args: [...nativeConfig, "app-server", "--listen", "stdio://"],
      cwd: launchCwd,
      env: spec.env,
      onData: (channel, bytes) => {
        if (channel === "stdout") this.accept(bytes);
      },
    });
    void this.process.exited.then(() => {
      if (!this.closed) {
        this.fail();
        this.failed();
      }
    });
    await this.request(
      "initialize",
      {
        clientInfo: { name: "glosa", title: "glosa", version: "1" },
        capabilities: { experimentalApi: true },
      },
      30000,
    );
    await this.write({ method: "initialized" });
    await this.audit(spec.cwd);
  }
  async audit(cwd: string): Promise<void> {
    checkProjectConfiguration(cwd);
    auditConfiguration(await this.request("config/read", { includeLayers: true, cwd }));
  }
  private accept(bytes: Uint8Array): void {
    if (this.closed) return;
    this.buffer += this.decoder.decode(bytes, { stream: true });
    if (Buffer.byteLength(this.buffer) > 8 * 1024 * 1024) {
      this.fail();
      this.failed();
      return;
    }
    let boundary: number;
    while ((boundary = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 1);
      if (!line.trim()) continue;
      try {
        const value = envelope.parse(JSON.parse(line));
        if (value.id !== undefined && !value.method) {
          const key = String(value.id),
            pending = this.pending.get(key);
          if (!pending) continue;
          this.pending.delete(key);
          clearTimeout(pending.timer);
          if (value.error) pending.reject(new ManagedAgentError("runtime-closed", "Codex rejected the operation."));
          else pending.resolve(value.result);
        } else this.receive(value);
      } catch {
        this.fail();
        this.failed();
        return;
      }
    }
  }
  private fail(): void {
    this.closed = true;
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(new ManagedAgentError("runtime-closed", "Codex disconnected before confirming the operation."));
    }
    this.pending.clear();
  }
  async write(frame: object): Promise<void> {
    if (this.closed || !this.process) throw new ManagedAgentError("runtime-closed", "Codex is disconnected.");
    await this.process.write(`${JSON.stringify(frame)}\n`);
  }
  async request(method: string, params: object, timeoutMs = 15000): Promise<unknown> {
    if (this.pending.size >= 64) throw new ManagedAgentError("runtime-capacity", "Too many pending Codex operations.");
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new ManagedAgentError("probe-timeout", "Codex did not confirm the operation in time."));
      }, timeoutMs);
      this.pending.set(String(id), { resolve, reject, timer });
      void this.write({ id, method, params }).catch((error) => {
        clearTimeout(timer);
        this.pending.delete(String(id));
        reject(error);
      });
    });
  }
  async close(): Promise<void> {
    this.fail();
    await this.process?.fence();
    await this.process?.stop();
  }
}

function observation(raw: unknown): AccountObservation {
  const value = accountSchema.safeParse(raw),
    observedAt = new Date().toISOString();
  if (!value.success) return { state: "probe_failed", observedAt };
  if (!value.data.account) return { state: "needs_login", observedAt };
  if (!value.data.requiresOpenaiAuth) return { state: "probe_failed", observedAt };
  const account = value.data.account;
  return {
    state: "authenticated",
    identity: `chatgpt:${account.email.toLowerCase()}`,
    label: account.email,
    plan: account.planType,
    method: "ChatGPT subscription",
    observedAt,
  };
}

export class CodexManagedAdapter implements ManagedAgentAdapter {
  readonly id = "codex";
  readonly name = "Codex";
  readonly authHosts = ["auth.openai.com", "chatgpt.com"];
  loginArgs() {
    return [...nativeConfig, "login"];
  }
  mcpLoginArgs(servers: import("../../../daemon/src/agents/interface.ts").AgentMcpServer[], serverId?: string) {
    const server = servers.find((item) => item.id === serverId && item.enabled && item.transport === "http");
    if (!server || server.transport !== "http")
      throw new ManagedAgentError("provider-unavailable", "Choose an enabled HTTP server to sign in.");
    return [
      ...nativeConfig,
      "-c",
      `mcp_servers.glosa-user-${server.id}.url=${JSON.stringify(server.url)}`,
      "mcp",
      "login",
      `glosa-user-${server.id}`,
    ];
  }
  logoutArgs() {
    return [...nativeConfig, "logout"];
  }
  profileEnvironment(configRoot: string) {
    return { CODEX_HOME: configRoot };
  }
  async preflight(spec: ProfileLaunchSpec, launcher: ProcessLauncher): Promise<void> {
    const rpc = new ManagedCodexRpc(
      () => {},
      () => {},
    );
    try {
      await rpc.open(spec, launcher);
    } finally {
      await rpc.close();
    }
  }
  async probe(spec: ProfileLaunchSpec, launcher: ProcessLauncher): Promise<AccountObservation> {
    const rpc = new ManagedCodexRpc(
      () => {},
      () => {},
    );
    try {
      await rpc.open(spec, launcher);
      return observation(await rpc.request("account/read", { refreshToken: true }));
    } catch {
      return { state: "probe_failed", observedAt: new Date().toISOString() };
    } finally {
      await rpc.close();
    }
  }
  async connect(
    spec: SessionLaunchSpec,
    launcher: ProcessLauncher,
    emit: (event: AgentEvent) => void,
  ): Promise<ManagedConnection> {
    let threadId = spec.nativeId,
      turnId: string | undefined,
      starting = false,
      ended = false;
    const streamed = new Set<string>();
    const decisions = new Map<string, { rpcId: string | number; method: string; params: Record<string, unknown> }>();
    const rpc = new ManagedCodexRpc(
      (frame) => {
        const params = frame.params ?? {};
        if (frame.method === "account/rateLimits/updated") {
          const limits = params.rateLimits as
            | {
                primary?: { usedPercent?: number; resetsAt?: number };
                secondary?: { usedPercent?: number; resetsAt?: number };
              }
            | undefined;
          const value: Record<string, string | number | null> = {
            quotaAsOf: new Date().toISOString(),
            quotaSource: "Codex account",
          };
          for (const [name, window] of Object.entries({ primary: limits?.primary, secondary: limits?.secondary })) {
            if (typeof window?.usedPercent === "number") value[`${name}UsedPercent`] = window.usedPercent;
            if (typeof window?.resetsAt === "number") value[`${name}ResetsAt`] = window.resetsAt;
          }
          emit({ type: "usage", value });
          return;
        }
        if (params.threadId && params.threadId !== threadId) return;
        if (params.turnId && turnId && params.turnId !== turnId) return;
        if (frame.method === "turn/started" && params.threadId === threadId && starting) {
          const turn = params.turn as { id?: string } | undefined;
          if (typeof turn?.id === "string") turnId = turn.id;
        }
        if (frame.id !== undefined && frame.method) {
          if (
            !threadId ||
            !turnId ||
            params.threadId !== threadId ||
            (params.turnId && params.turnId !== turnId) ||
            decisions.size >= 32
          ) {
            void rpc.write({ id: frame.id, error: { code: -32600, message: "No active operation" } }).catch(() => {});
            return;
          }
          const method = frame.method,
            id = randomUUID();
          if (
            ![
              "item/commandExecution/requestApproval",
              "item/fileChange/requestApproval",
              "item/tool/requestUserInput",
              "item/permissions/requestApproval",
              "mcpServer/elicitation/request",
            ].includes(method)
          ) {
            void rpc.write({ id: frame.id, error: { code: -32601, message: "Unsupported request" } }).catch(() => {});
            return;
          }
          decisions.set(id, { rpcId: frame.id, method, params });
          const question = method === "item/tool/requestUserInput";
          emit({
            type: "decision",
            decision: {
              id,
              kind: question ? "question" : "permission",
              title: question ? "Codex needs an answer" : "Codex requests permission",
              detail: JSON.stringify(params, null, 2).slice(0, 16000),
              choices: question
                ? [
                    { id: "answer", label: "Send answer" },
                    { id: "deny", label: "Cancel" },
                  ]
                : method === "mcpServer/elicitation/request"
                  ? [{ id: "deny", label: "Decline" }]
                  : [
                      { id: "allow", label: "Allow once" },
                      { id: "deny", label: "Deny" },
                    ],
              allowText: question,
              ...(question
                ? {
                    questions: z
                      .array(
                        z.object({
                          id: z.string(),
                          question: z.string(),
                          options: z
                            .array(z.object({ label: z.string(), description: z.string().optional() }))
                            .nullable()
                            .optional(),
                        }),
                      )
                      .min(1)
                      .max(16)
                      .parse(params.questions)
                      .map((q) => ({ id: q.id, question: q.question, options: q.options ?? [], multiple: false })),
                  }
                : {}),
            },
          });
          return;
        }
        if (frame.method === "serverRequest/resolved") {
          for (const [id, decision] of decisions)
            if (decision.rpcId === params.requestId) {
              decisions.delete(id);
              emit({ type: "decision_closed", id });
            }
          return;
        }
        if (!threadId || (!turnId && !starting)) return;
        if (
          ["item/agentMessage/delta", "item/plan/delta", "item/reasoning/summaryTextDelta"].includes(
            frame.method ?? "",
          ) &&
          typeof params.delta === "string" &&
          typeof params.itemId === "string"
        ) {
          const id = `${params.itemId}:${frame.method}:${params.summaryIndex ?? 0}`;
          streamed.add(params.itemId);
          emit({ type: "text", id, text: params.delta, reasoning: frame.method === "item/reasoning/summaryTextDelta" });
        } else if (["item/started", "item/completed"].includes(frame.method ?? "")) {
          const item = params.item as Record<string, unknown> | undefined;
          if (!item || typeof item.id !== "string" || typeof item.type !== "string") return;
          if (["agentMessage", "plan"].includes(item.type)) {
            if (frame.method === "item/completed" && !streamed.has(item.id) && typeof item.text === "string")
              emit({ type: "text", id: item.id, text: item.text });
          } else if (!["userMessage", "reasoning"].includes(item.type))
            emit({
              type: "tool",
              id: item.id,
              name: item.type,
              detail: JSON.stringify(item).slice(0, 16000),
              status:
                frame.method === "item/started"
                  ? "running"
                  : ["failed", "declined"].includes(String(item.status))
                    ? "failed"
                    : "completed",
            });
        } else if (frame.method === "turn/completed") {
          const turn = params.turn as { status?: string } | undefined;
          ended = true;
          decisions.clear();
          emit(
            turn?.status === "completed"
              ? { type: "completed" }
              : {
                  type: "failed",
                  code: "native-turn-failed",
                  message: "Codex did not complete this turn. Review its output before starting another message.",
                },
          );
        } else if (frame.method === "thread/tokenUsage/updated") {
          const usage = params.tokenUsage as
            | { total?: Record<string, unknown>; modelContextWindow?: number }
            | undefined;
          const numbers = Object.fromEntries(
            Object.entries(usage?.total ?? {}).filter(
              (entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]),
            ),
          );
          emit({
            type: "usage",
            value: {
              source: "Codex",
              scope: "native-thread",
              asOf: new Date().toISOString(),
              ...numbers,
              contextWindow: usage?.modelContextWindow ?? null,
            },
          });
        }
      },
      () => {
        if (!ended)
          emit({
            type: "failed",
            code: "native-disconnected",
            outcomeUnknown: true,
            message:
              "Codex disconnected. The operation's outcome may be unknown; review the workspace before continuing.",
          });
      },
    );
    try {
      await rpc.open(
        { ...spec, env: { ...spec.env, ...(spec.mcp ? { GLOSA_MANAGED_MCP_GRANT: spec.mcp.grant } : {}) } },
        launcher,
      );
      const account = observation(await rpc.request("account/read", { refreshToken: true }));
      if (account.state !== "authenticated")
        throw new ManagedAgentError("auth-required", "Sign in again to this ChatGPT account.");
      if (account.identity !== spec.profile.auth.identity)
        throw new ManagedAgentError(
          "account-mismatch",
          "Sign in to the original ChatGPT account before continuing this chat.",
        );
      const models: z.infer<typeof modelsSchema>["data"] = [];
      let cursor: string | null = null;
      const seenCursors = new Set<string | null>();
      do {
        if (models.length >= 500 || seenCursors.has(cursor)) throw new Error("model pagination overflow");
        seenCursors.add(cursor);
        const result = modelsSchema.parse(
          await rpc.request("model/list", { limit: 100, includeHidden: false, cursor }),
        );
        models.push(...result.data);
        cursor = result.nextCursor;
        if (models.length > 500) throw new Error("model catalog exceeds limit");
      } while (cursor);
      const config = {
        ...Object.fromEntries(
          (spec.servers ?? []).map((server) => [
            `mcp_servers.glosa-user-${server.id}`,
            server.transport === "http" ? { url: server.url } : { command: server.command, args: server.args },
          ]),
        ),
        ...(spec.mcp
          ? { "mcp_servers.glosa": { url: spec.mcp.url, bearer_token_env_var: "GLOSA_MANAGED_MCP_GRANT" } }
          : {}),
      };
      return {
        capabilities: {
          models: models.map((m) => ({
            id: m.model,
            name: m.displayName,
            efforts: m.supportedReasoningEfforts.map((e) => e.reasoningEffort),
          })),
          resume: true,
          images: models.some((m) => m.inputModalities?.includes("image")),
          questions: true,
          permissions: true,
          mcp: !!spec.mcp,
        },
        async mcpStatus() {
          const result = z
            .object({
              data: z
                .array(
                  z.object({
                    name: z.string(),
                    authStatus: z.string(),
                    runtimeStatus: z.string().nullable().optional(),
                  }),
                )
                .max(100),
              nextCursor: z.string().nullable().optional(),
            })
            .parse(await rpc.request("mcpServerStatus/list", { threadId, limit: 100, detail: "toolsAndAuthOnly" }));
          return result.data.map((server) => ({
            name: server.name,
            status: server.runtimeStatus ?? "unknown",
            auth: server.authStatus,
            login: true,
          }));
        },
        async startTurn(input) {
          await rpc.audit(spec.cwd);
          const selected = models.find((m) => m.model === input.settings.model);
          if (!selected || !selected.supportedReasoningEfforts.some((e) => e.reasoningEffort === input.settings.effort))
            throw new ManagedAgentError("unsupported-model", "Choose a model and effort offered by this account.");
          const planning = input.settings.permissionMode === "plan";
          let effective: z.infer<typeof threadSchema>;
          if (!threadId) {
            const result = threadSchema.parse(
              await rpc.request("thread/start", {
                config,
                cwd: spec.cwd,
                model: input.settings.model,
                modelProvider: "openai",
                approvalPolicy: "untrusted",
                sandbox: planning ? "read-only" : "workspace-write",
                experimentalRawEvents: false,
                persistExtendedHistory: true,
              }),
            );
            threadId = result.thread.id;
            effective = result;
          } else {
            const result = threadSchema.parse(
              await rpc.request("thread/resume", {
                config,
                threadId,
                cwd: spec.cwd,
                model: input.settings.model,
                modelProvider: "openai",
                approvalPolicy: "untrusted",
                sandbox: planning ? "read-only" : "workspace-write",
              }),
            );
            if (result.thread.id !== threadId) throw new Error("resumed a different thread");
            effective = result;
          }
          emit({ type: "effective_settings", model: effective.model });
          if (effective.model && effective.model !== input.settings.model)
            throw new ManagedAgentError(
              "unsupported-model",
              "Codex selected a different model. Review the model choice before sending again.",
            );
          emit({ type: "session", nativeId: threadId });
          const content: object[] = [{ type: "text", text: input.text }];
          for (const attachment of input.attachments) {
            if (attachment.mime.startsWith("image/")) {
              if (!selected.inputModalities?.includes("image"))
                throw new ManagedAgentError("unsupported-images", "This Codex model does not accept images.");
              content.push({
                type: "image",
                url: `data:${attachment.mime};base64,${Buffer.from(attachment.bytes).toString("base64")}`,
              });
            } else
              content.push({
                type: "text",
                text: `Attachment: ${attachment.name}\n${new TextDecoder().decode(attachment.bytes)}`,
              });
          }
          starting = true;
          const result = z.object({ turn: z.object({ id: z.string() }) }).parse(
            await rpc.request("turn/start", {
              threadId,
              input: content,
              model: input.settings.model,
              effort: input.settings.effort,
              cwd: spec.cwd,
              approvalPolicy: "untrusted",
              sandboxPolicy: planning
                ? { type: "readOnly" }
                : { type: "workspaceWrite", writableRoots: [spec.cwd], networkAccess: false },
              summary: "concise",
            }),
          );
          turnId = result.turn.id;
          starting = false;
        },
        async answer(id, choice, text) {
          const decision = decisions.get(id);
          if (!decision) throw new ManagedAgentError("stale-decision", "Codex is no longer waiting for this answer.");
          let result: object;
          if (decision.method === "item/tool/requestUserInput") {
            const questions = z
              .array(z.object({ id: z.string(), question: z.string() }))
              .parse(decision.params.questions);
            let answers: Record<string, { answers: string[] }> = {};
            if (choice !== "deny") {
              try {
                const values = z.record(z.string(), z.array(z.string())).parse(JSON.parse(text ?? ""));
                answers = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { answers: value }]));
              } catch {
                if (questions.length === 1) answers = { [questions[0]!.id]: { answers: [text ?? ""] } };
              }
            }
            if (choice !== "deny" && questions.some((q) => !(q.id in answers)))
              throw new ManagedAgentError("answer-required", "Answer each question by its id.");
            result = { answers };
          } else if (decision.method === "item/permissions/requestApproval")
            result = { permissions: choice === "allow" ? (decision.params.permissions ?? {}) : {}, scope: "turn" };
          else if (decision.method === "mcpServer/elicitation/request") result = { action: "decline", content: null };
          else result = { decision: choice === "allow" ? "accept" : "decline" };
          decisions.delete(id);
          await rpc.write({ id: decision.rpcId, result });
        },
        async interrupt() {
          if (threadId && turnId && !ended) await rpc.request("turn/interrupt", { threadId, turnId });
        },
        async close() {
          ended = true;
          decisions.clear();
          await rpc.close();
        },
      };
    } catch (error) {
      await rpc.close();
      throw error;
    }
  }
}

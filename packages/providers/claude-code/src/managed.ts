// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  type AccountObservation,
  type AgentEvent,
  type AgentInput,
  type ManagedAgentAdapter,
  ManagedAgentError,
  type ManagedConnection,
  type OwnedProcess,
  type ProcessLauncher,
  type ProfileLaunchSpec,
  type SessionLaunchSpec,
  type TurnSettings,
} from "../../../daemon/src/agents/interface.ts";
import { nativeProbe } from "../../../daemon/src/agents/probe.ts";
import { managedToolsUnavailable, waitForManagedTools } from "../../../daemon/src/agents/managed-bootstrap.ts";

// Structural boundary checked against the published 0.3.280 declarations. The optional commercial
// SDK is loaded only from an explicitly installed/qualified runtime, never imported by core.
export interface ClaudeQuery extends AsyncIterable<unknown> {
  supportedModels(): Promise<
    { value: string; displayName: string; resolvedModel?: string; supportedEffortLevels?: string[] }[]
  >;
  accountInfo(): Promise<{
    email?: string;
    organization?: string;
    subscriptionType?: string;
    tokenSource?: string;
    apiKeySource?: string;
    apiProvider?: string;
  }>;
  interrupt(): Promise<void>;
  mcpServerStatus?(): Promise<{ name: string; status: string; tools?: { name: string }[] }[]>;
  close(): void;
}
interface SdkSpawnOptions {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
  signal: AbortSignal;
}
interface PermissionOptions {
  signal: AbortSignal;
  toolUseID: string;
  title?: string;
  description?: string;
}
interface PermissionResult {
  behavior: "allow" | "deny";
  updatedInput?: Record<string, unknown>;
  message?: string;
}
export interface ClaudeSdk {
  query(options: {
    prompt: AsyncIterable<unknown>;
    options: {
      cwd: string;
      env: Record<string, string>;
      pathToClaudeCodeExecutable: string;
      executable: "bun";
      model?: string;
      effort?: string;
      permissionMode: "default" | "plan";
      resume?: string;
      includePartialMessages: boolean;
      settingSources: string[];
      strictMcpConfig: boolean;
      settings: { disableClaudeAiConnectors: boolean };
      persistSession: boolean;
      systemPrompt?: { type: "preset"; preset: "claude_code"; append: string; snapshot: false };
      mcpServers?: Record<
        string,
        | { type: "http"; url: string; headers?: Record<string, string> }
        | { type: "stdio"; command: string; args: string[] }
      >;
      canUseTool(name: string, input: Record<string, unknown>, options: PermissionOptions): Promise<PermissionResult>;
      spawnClaudeCodeProcess(options: SdkSpawnOptions): SdkProcess;
    };
  }): ClaudeQuery;
}

class InputQueue implements AsyncIterable<unknown> {
  private values: unknown[] = [];
  private wake?: () => void;
  private ended = false;
  push(value: unknown): void {
    if (this.ended) throw new Error("input closed");
    this.values.push(value);
    this.wake?.();
  }
  close(): void {
    this.ended = true;
    this.wake?.();
  }
  async *[Symbol.asyncIterator]() {
    while (!this.ended) {
      while (this.values.length) yield this.values.shift();
      if (!this.ended)
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
    }
  }
}

class SdkProcess extends EventEmitter {
  readonly stdin: Writable;
  readonly stdout = new PassThrough({ highWaterMark: 64 * 1024 });
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  private readonly owned: Promise<OwnedProcess>;
  constructor(spec: SessionLaunchSpec, options: SdkSpawnOptions, launcher: ProcessLauncher) {
    super();
    if (options.command !== spec.manifest.executable)
      throw new ManagedAgentError("unexpected-executable", "The SDK selected an unqualified executable.", 503);
    this.stdin = new Writable({
      highWaterMark: 64 * 1024,
      write: (chunk, _encoding, done) => {
        void this.owned
          .then((child) => child.write(Buffer.from(chunk).toString("utf8")))
          .then(
            () => done(),
            () => done(new Error("Agent input was refused.")),
          );
      },
      final: (done) => {
        void this.owned
          .then((child) => child.stop())
          .then(
            () => done(),
            () => done(new Error("Agent shutdown is uncertain.")),
          );
      },
    });
    // SDK changes may add implementation flags; they cannot reintroduce ambient credentials.
    this.owned = launcher.spawn({
      command: options.command,
      args: options.args,
      cwd: spec.cwd,
      env: spec.env,
      onData: (channel, bytes) => {
        if (channel !== "stdout") return;
        if (this.stdout.readableLength + this.stdout.writableLength + bytes.length > 2 * 1024 * 1024) {
          this.kill("SIGTERM");
          return;
        }
        this.stdout.write(bytes);
      },
    });
    const abort = () => this.kill("SIGTERM");
    if (options.signal.aborted) abort();
    else options.signal.addEventListener("abort", abort, { once: true });
    void this.owned
      .then(async (child) => {
        const exit = await child.exited;
        options.signal.removeEventListener("abort", abort);
        this.exitCode = exit.code;
        this.signalCode = exit.signal as NodeJS.Signals | null;
        this.stdout.end();
        this.emit("exit", this.exitCode, this.signalCode);
      })
      .catch(() => {
        this.stdout.end();
        this.emit("error", new Error("Agent process failed."));
      });
  }
  kill(_signal: NodeJS.Signals): boolean {
    this.killed = true;
    void this.owned
      .then((child) => child.stop())
      .catch(() => {
        this.emit("error", new Error("Agent shutdown is uncertain."));
      });
    return true;
  }
}

const statusSchema = z.object({
  loggedIn: z.boolean(),
  authMethod: z.string().optional(),
  apiProvider: z.string().optional(),
  email: z.string().optional(),
  orgId: z.string().optional(),
  subscriptionType: z.string().optional(),
});
export class ClaudeManagedAdapter implements ManagedAgentAdapter {
  readonly id = "claude-code";
  readonly name = "Claude";
  readonly authHosts = ["claude.ai", "claude.com", "platform.claude.com", "console.anthropic.com"];
  constructor(
    private readonly loadSdk: (path: string) => Promise<ClaudeSdk> = async (path) =>
      (await import(pathToFileURL(path).href)) as ClaudeSdk,
  ) {}
  loginArgs(): string[] {
    // The auth subcommand goes directly to native subscription sign-in without
    // starting the interactive session's theme/onboarding wizard.
    return ["auth", "login", "--claudeai"];
  }
  mcpLoginArgs(servers: import("../../../daemon/src/agents/interface.ts").AgentMcpServer[]): string[] {
    const mcpServers = Object.fromEntries(
      servers
        .filter((server) => server.enabled)
        .map((server) => [
          `glosa-user-${server.id}`,
          server.transport === "http"
            ? { type: "http", url: server.url }
            : { command: server.command, args: server.args },
        ]),
    );
    return [
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--settings",
      JSON.stringify({ disableClaudeAiConnectors: true }),
      "--mcp-config",
      JSON.stringify({ mcpServers }),
      "/mcp",
    ];
  }
  logoutArgs(): string[] {
    return ["auth", "logout"];
  }
  profileEnvironment(configRoot: string): Record<string, string> {
    return { CLAUDE_CONFIG_DIR: configRoot, DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1" };
  }
  async probe(spec: ProfileLaunchSpec, launcher: ProcessLauncher): Promise<AccountObservation> {
    const observedAt = new Date().toISOString();
    try {
      const output = await nativeProbe(spec, launcher, ["auth", "status", "--json"], (code, stdout) => {
        // The pinned CLI uses exit 1 for an ordinary signed-out account. All other
        // nonzero exits, including contradictory authenticated output, remain failures.
        return code === 0 || (code === 1 && statusSchema.safeParse(JSON.parse(stdout)).data?.loggedIn === false);
      });
      const value = statusSchema.parse(JSON.parse(output));
      if (!value.loggedIn) return { state: "needs_login", observedAt };
      if (
        value.authMethod !== "claude.ai" ||
        !value.email ||
        (value.apiProvider && !["firstParty", "first-party", "anthropic"].includes(value.apiProvider))
      )
        return { state: "probe_failed", observedAt };
      return {
        state: "authenticated",
        identity: `${value.orgId ?? "personal"}:${value.email.toLowerCase()}`,
        label: value.email,
        method: "Claude subscription",
        plan: value.subscriptionType,
        observedAt,
      };
    } catch {
      return { state: "probe_failed", observedAt };
    }
  }
  async connect(
    spec: SessionLaunchSpec,
    launcher: ProcessLauncher,
    onEvent: (event: AgentEvent) => void,
  ): Promise<ManagedConnection> {
    if (!spec.manifest.sdkModule)
      throw new ManagedAgentError("sdk-unavailable", "The qualified Claude SDK is not installed.", 503);
    const observed = await this.probe({ ...spec, cwd: spec.probeCwd ?? spec.configRoot }, launcher);
    if (observed.state !== "authenticated")
      throw new ManagedAgentError("auth-required", "Sign in again to this Claude account.");
    if (observed.identity !== spec.profile.auth.identity)
      throw new ManagedAgentError(
        "account-mismatch",
        "Sign in to the original Claude subscription account before continuing.",
      );
    const sdk = await this.loadSdk(spec.manifest.sdkModule),
      input = new InputQueue();
    const pending = new Map<
      string,
      { resolve: (result: PermissionResult) => void; name: string; input: Record<string, unknown>; cleanup(): void }
    >();
    let active = false,
      closed = false;
    const nativeSpec = {
      ...spec,
      env: { ...spec.env, ...(spec.mcp ? { GLOSA_MANAGED_MCP_GRANT: spec.mcp.grant } : {}) },
    };
    const query = sdk.query({
      prompt: input,
      options: {
        cwd: spec.cwd,
        env: nativeSpec.env,
        executable: "bun",
        pathToClaudeCodeExecutable: spec.manifest.executable,
        model: spec.settings.model || undefined,
        effort: spec.settings.effort || undefined,
        permissionMode: spec.settings.permissionMode,
        resume: spec.nativeId,
        includePartialMessages: true,
        persistSession: true,
        ...(spec.mcp
          ? {
              systemPrompt: {
                type: "preset" as const,
                preset: "claude_code" as const,
                append: spec.mcp.instructions,
                snapshot: false,
              },
            }
          : {}),
        // Project instructions are supplied by the native agent. User/global hooks, MCP and billing
        // configuration are not inherited. Additional sources require separate explicit consent.
        settingSources: [],
        strictMcpConfig: true,
        settings: { disableClaudeAiConnectors: true },
        mcpServers: {
          ...Object.fromEntries(
            (spec.servers ?? []).map((server) => [
              `glosa-user-${server.id}`,
              server.transport === "http"
                ? { type: "http" as const, url: server.url }
                : { type: "stdio" as const, command: server.command, args: server.args },
            ]),
          ),
          ...(spec.mcp
            ? {
                glosa: {
                  type: "http" as const,
                  url: spec.mcp.url,
                  headers: { Authorization: "Bearer ${GLOSA_MANAGED_MCP_GRANT}" },
                },
              }
            : {}),
        },
        spawnClaudeCodeProcess: (options) => new SdkProcess(nativeSpec, options, launcher),
        canUseTool: (name, toolInput, permission) =>
          new Promise<PermissionResult>((resolve) => {
            if (closed || permission.signal.aborted) {
              resolve({ behavior: "deny", message: "The run stopped." });
              return;
            }
            const id = permission.toolUseID || randomUUID();
            const deny = () => {
              const entry = pending.get(id);
              if (!entry) return;
              pending.delete(id);
              entry.cleanup();
              onEvent({ type: "decision_closed", id });
              resolve({ behavior: "deny", message: "The decision expired or the run stopped." });
            };
            const timeout = setTimeout(deny, 10 * 60_000);
            const cleanup = () => {
              clearTimeout(timeout);
              permission.signal.removeEventListener("abort", deny);
            };
            pending.set(id, { resolve, name, input: toolInput, cleanup });
            permission.signal.addEventListener("abort", deny, { once: true });
            onEvent({
              type: "decision",
              decision: {
                id,
                kind: name === "AskUserQuestion" ? "question" : "permission",
                title: permission.title ?? name,
                detail: permission.description ?? JSON.stringify(toolInput),
                choices: [
                  { id: "allow", label: name === "AskUserQuestion" ? "Submit answers" : "Allow once" },
                  { id: "deny", label: name === "AskUserQuestion" ? "Cancel" : "Deny" },
                ],
                allowText: name === "AskUserQuestion",
                ...(name === "AskUserQuestion"
                  ? {
                      questions: z
                        .array(
                          z.object({
                            question: z.string(),
                            options: z
                              .array(z.object({ label: z.string(), description: z.string().optional() }))
                              .default([]),
                            multiSelect: z.boolean().default(false),
                          }),
                        )
                        .min(1)
                        .max(16)
                        .parse(toolInput.questions)
                        .map((q) => ({
                          id: q.question,
                          question: q.question,
                          options: q.options,
                          multiple: q.multiSelect,
                        })),
                    }
                  : {}),
              },
            });
          }),
      },
    });
    try {
      const models = await query.supportedModels();
      const account = await query.accountInfo();

      if (
        (account.apiKeySource && account.apiKeySource !== "none") ||
        account.apiProvider !== "firstParty" ||
        !account.email ||
        account.email.toLowerCase() !== observed.label?.toLowerCase()
      ) {
        throw new ManagedAgentError(
          "account-mismatch",
          "Claude did not report the selected subscription account. Reconnect the account.",
        );
      }
      const normalize = new ClaudeEventNormalizer(onEvent);
      let prepared: string | undefined;
      const prepareTurn = async (settings: TurnSettings) => {
        if (active || closed) throw new ManagedAgentError("turn-active", "This runtime already accepted a turn.");
        if (spec.mcp && !query.mcpServerStatus) throw managedToolsUnavailable();
        if (spec.mcp)
          await waitForManagedTools(
            async () => {
              const server = (await query.mcpServerStatus?.())?.find((item) => item.name === "glosa");
              return {
                state:
                  !server || server.status === "pending"
                    ? "pending"
                    : server.status === "connected"
                      ? "ready"
                      : "failed",
                tools: server?.tools?.map((tool) => tool.name) ?? [],
              };
            },
            spec.mcp.requiredTools,
            () => closed,
          );
        if (closed) throw new ManagedAgentError("run-fenced", "This run was stopped.");
        prepared = JSON.stringify(settings);
      };
      void (async () => {
        try {
          for await (const message of query) {
            const init = message as { type?: string; subtype?: string; model?: string };
            if (init.type === "system" && init.subtype === "init" && typeof init.model === "string")
              onEvent({ type: "effective_settings", model: init.model });
            normalize.accept(message);
          }
          if (!closed)
            onEvent({
              type: "failed",
              code: "claude-ended",
              message: "Claude ended without confirming another result.",
              outcomeUnknown: true,
            });
        } catch {
          if (!closed)
            onEvent({
              type: "failed",
              code: "claude-disconnected",
              outcomeUnknown: true,
              message: "Claude disconnected. The turn was not resent.",
            });
        }
      })();
      return {
        prepareTurn,
        capabilities: {
          models: models.map((model) => ({
            id: model.value,
            name: model.displayName,
            ...(model.resolvedModel ? { resolvedModel: model.resolvedModel } : {}),
            efforts: model.supportedEffortLevels ?? [],
          })),
          images: true,
          resume: true,
          permissions: true,
          questions: true,
          mcp: !!spec.mcp,
        },
        async startTurn(turn: AgentInput) {
          if (active || closed) throw new ManagedAgentError("turn-active", "This runtime already accepted a turn.");
          if (prepared !== JSON.stringify(turn.settings)) await prepareTurn(turn.settings);
          active = true;
          prepared = undefined;
          const content: unknown[] = [{ type: "text", text: turn.text }];
          for (const file of turn.attachments) {
            if (file.mime.startsWith("image/"))
              content.push({
                type: "image",
                source: { type: "base64", media_type: file.mime, data: Buffer.from(file.bytes).toString("base64") },
              });
            else
              content.push({ type: "text", text: `Attachment: ${file.name}\n${new TextDecoder().decode(file.bytes)}` });
          }
          input.push({
            type: "user",
            message: { role: "user", content },
            parent_tool_use_id: null,
            session_id: spec.nativeId ?? "",
            uuid: turn.turnId,
          });
        },
        async answer(id, choice, text) {
          const decision = pending.get(id);
          if (!decision) throw new ManagedAgentError("stale-decision", "Claude no longer needs this response.");
          let updatedInput = decision.input;
          if (choice === "allow" && decision.name === "AskUserQuestion") {
            const questions = z
              .array(z.object({ question: z.string() }))
              .min(1)
              .parse(decision.input.questions);
            let answers: Record<string, string>;
            try {
              const values = z.record(z.string(), z.array(z.string())).parse(JSON.parse(text ?? ""));
              answers = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.join(", ")]));
            } catch {
              answers = questions.length === 1 ? { [questions[0]!.question]: text ?? "" } : {};
            }
            if (questions.some((question) => !answers[question.question]?.trim()))
              throw new ManagedAgentError("answer-required", "Answer each question before submitting.", 422);
            updatedInput = {
              ...decision.input,
              answers: Object.fromEntries(questions.map((question) => [question.question, answers[question.question]])),
            };
          }
          pending.delete(id);
          decision.cleanup();
          decision.resolve(
            choice === "allow"
              ? { behavior: "allow", updatedInput }
              : { behavior: "deny", message: "The user declined this tool request." },
          );
        },
        interrupt: () => query.interrupt(),
        async mcpStatus() {
          if (!query.mcpServerStatus) return [];
          return (await query.mcpServerStatus()).map((server) => ({
            name: server.name,
            status: server.status,
            auth: server.status === "needs-auth" ? "required" : "unknown",
            login: false,
          }));
        },
        async close() {
          closed = true;
          input.close();
          for (const decision of pending.values()) {
            decision.cleanup();
            decision.resolve({ behavior: "deny", message: "The run stopped." });
          }
          pending.clear();
          query.close();
        },
      };
    } catch (error) {
      closed = true;
      input.close();
      query.close();
      throw error;
    }
  }
}

/** Normalize SDK events into structured data; never HTML or ANSI scraping. */
export class ClaudeEventNormalizer {
  private readonly messageIds = new Map<string, string>();
  private readonly streamed = new Set<string>();
  private readonly completedBlocks = new Map<string, number>();
  private readonly activeBlocks = new Map<string, number>();
  private readonly tools = new Map<string, string>();
  constructor(private readonly emit: (event: AgentEvent) => void) {}
  accept(raw: unknown): void {
    if (!raw || typeof raw !== "object") return;
    const value = raw as Record<string, unknown>;
    if (value.type === "rate_limit_event") {
      const info = value.rate_limit_info as Record<string, unknown> | undefined;
      const limits: Record<string, string | number | null> = {
        quotaAsOf: new Date().toISOString(),
        quotaSource: "Claude account",
      };
      for (const key of ["status", "resetsAt", "utilization", "rateLimitType"]) {
        const item = info?.[key];
        if (typeof item === "string" || typeof item === "number") limits[`quota_${key}`] = item;
      }
      this.emit({ type: "usage", value: limits });
    }
    const parent = typeof value.parent_tool_use_id === "string" ? value.parent_tool_use_id : "main";
    if (value.type === "system" && value.subtype === "init" && typeof value.session_id === "string")
      this.emit({ type: "session", nativeId: value.session_id });
    if (value.type === "stream_event") {
      const event = value.event as {
        type?: string;
        index?: number;
        message?: { id?: string };
        content_block?: { type?: string; id?: string; name?: string; input?: unknown };
        delta?: { type?: string; text?: string; thinking?: string };
      };
      if (!event) return;
      if (event.type === "message_start") this.messageIds.set(parent, event.message?.id ?? randomUUID());
      const key = `${parent}:${this.messageIds.get(parent) ?? "unknown"}`;
      const id = `${key}:${event.index ?? 0}`;
      if (event.type === "content_block_start" && typeof event.index === "number")
        this.activeBlocks.set(key, event.index);
      if (event.type === "content_block_stop" && typeof event.index === "number") {
        this.activeBlocks.delete(key);
        this.completedBlocks.set(key, Math.max(this.completedBlocks.get(key) ?? 0, event.index + 1));
      }
      if (event.type === "content_block_delta" && event.delta) {
        const text =
          event.delta.type === "thinking_delta"
            ? event.delta.thinking
            : event.delta.type === "text_delta"
              ? event.delta.text
              : undefined;
        if (text) {
          this.streamed.add(id);
          this.emit({ type: "text", id, text, reasoning: event.delta.type === "thinking_delta" });
        }
      }
      if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
        const block = event.content_block;
        if (block.id && block.name) {
          this.tools.set(block.id, block.name);
          this.emit({
            type: "tool",
            id: block.id,
            name: block.name,
            detail: JSON.stringify(block.input ?? {}),
            status: "running",
          });
        }
      }
    }
    if (value.type === "assistant") {
      const message = value.message as {
        id?: string;
        content?: { type: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown }[];
      };
      // SDK assistant envelopes contain newly completed blocks, not a cumulative
      // message snapshot. Array indexes restart even when the message id is shared.
      const key = `${parent}:${message?.id ?? value.uuid}`;
      const content = message?.content ?? [];
      // Empty native blocks have no assistant envelope. Prefer the stream's real
      // index; the offset covers envelopes from non-streamed subagent messages.
      const offset =
        (content.length === 1 ? this.activeBlocks.get(key) : undefined) ?? this.completedBlocks.get(key) ?? 0;
      this.completedBlocks.set(key, Math.max(this.completedBlocks.get(key) ?? 0, offset + content.length));
      for (const [index, block] of content.entries()) {
        const id = `${key}:${offset + index}`;
        if ((block.type === "text" || block.type === "thinking") && !this.streamed.has(id))
          this.emit({
            type: "text",
            id,
            text: block.text ?? block.thinking ?? "",
            reasoning: block.type === "thinking",
          });
        if (block.type === "tool_use" && block.id && block.name) {
          this.tools.set(block.id, block.name);
          this.emit({
            type: "tool",
            id: block.id,
            name: block.name,
            detail: JSON.stringify(block.input ?? {}),
            status: "running",
          });
        }
      }
    }
    if (value.type === "user") {
      const message = value.message as {
        content?: { type: string; tool_use_id?: string; is_error?: boolean; content?: unknown }[];
      };
      if (Array.isArray(message?.content))
        for (const block of message.content)
          if (block.type === "tool_result" && block.tool_use_id)
            this.emit({
              type: "tool",
              id: block.tool_use_id,
              name: this.tools.get(block.tool_use_id) ?? "Tool",
              detail: typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? ""),
              status: block.is_error ? "failed" : "completed",
            });
    }
    if (value.type === "result") {
      const usage = value.usage as Record<string, number> | undefined;
      const totals: Record<string, string | number | null> = {
        scope: "native-session",
        estimatedCostUsd: typeof value.total_cost_usd === "number" ? value.total_cost_usd : null,
      };
      for (const key of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"])
        if (typeof usage?.[key] === "number") totals[key] = usage[key];
      this.emit({ type: "usage", value: totals });
      this.emit(
        value.subtype === "success" && !value.is_error
          ? { type: "completed" }
          : {
              type: "failed",
              code: "claude-turn-failed",
              message: "Claude could not complete this turn. Review the transcript before trying again.",
            },
      );
    }
  }
}

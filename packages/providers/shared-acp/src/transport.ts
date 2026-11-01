// SPDX-License-Identifier: Apache-2.0
import {
  client,
  methods,
  ndJsonStream,
  type ClientConnection,
  type ContentBlock,
  type RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import type {
  AgentEvent,
  ManagedConnection,
  OwnedProcess,
  ProcessLauncher,
  SessionLaunchSpec,
  TurnSettings,
} from "../../../daemon/src/agents/interface.ts";
import { ManagedAgentError } from "../../../daemon/src/agents/interface.ts";
import { providerEnvironmentSecrets, providerFailureDetails } from "./failures.ts";
import { type AcpQualification, requireAcpQualification } from "./qualification.ts";

/** Vendor launch/configuration stays outside the shared ACP transport. No released policy qualifies yet. */
export interface AcpProviderPolicy {
  qualification: AcpQualification;
  launch(spec: SessionLaunchSpec): { command: string; args: string[]; env: Record<string, string> };
  initializeMeta?: Record<string, unknown>;
  /** Must suppress all helper inference before creating a session. */
  configure(
    connection: ClientConnection,
    spec: SessionLaunchSpec,
  ): Promise<{
    sessionId: string;
    capabilities: ManagedConnection["capabilities"];
    /** Must verify effective settings, native generation and this attempt's exact MCP authority. */
    prepare(settings: TurnSettings): Promise<void>;
    /** A transport stopReason alone cannot establish successful native completion. */
    terminal(result: unknown): "completed" | "cancelled" | { code: string; message: string };
  }>;
}

/** One attempt owns one process. There is deliberately no warm cache, reconnect or prompt retry. */
export async function connectManagedAcp(
  spec: SessionLaunchSpec,
  launcher: ProcessLauncher,
  emit: (event: AgentEvent) => void,
  policy: AcpProviderPolicy,
): Promise<ManagedConnection> {
  // This must precede even launch-policy evaluation: unqualified code gets no credential or process.
  requireAcpQualification(policy.qualification);
  if (policy.qualification.provider !== spec.profile.provider)
    throw new ManagedAgentError("wrong-provider", "The qualified ACP policy belongs to a different provider.");
  let child: OwnedProcess | undefined, connection: ClientConnection | undefined;
  let closed = false,
    active = false,
    submitted = false;
  let inputController!: ReadableStreamDefaultController<Uint8Array>;
  const pending = new Map<
    string,
    { resolve(value: RequestPermissionResponse): void; cleanup(): void; allow?: string; deny?: string }
  >();
  const tools = new Map<string, string>();
  const closeDecisions = () => {
    for (const [id, decision] of pending) {
      decision.cleanup();
      decision.resolve({ outcome: { outcome: "cancelled" } });
      emit({ type: "decision_closed", id });
    }
    pending.clear();
  };
  const stop = async () => {
    if (closed) return;
    closed = true;
    closeDecisions();
    connection?.close();
    try {
      await child?.fence();
    } finally {
      await child?.stop();
    }
  };
  try {
    const readable = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          inputController = controller;
        },
      },
      { highWaterMark: 8 * 1024 * 1024, size: (chunk) => chunk?.byteLength ?? 0 },
    );
    const launch = policy.launch(spec);
    child = await launcher.spawn({
      ...launch,
      cwd: spec.probeCwd ?? spec.configRoot,
      onData(channel, bytes) {
        if (closed || channel !== "stdout") return;
        if ((inputController.desiredSize ?? 0) < bytes.byteLength) {
          inputController.error(new Error("ACP stream limit"));
          void stop();
        } else inputController.enqueue(bytes);
      },
    });
    const writable = new WritableStream<Uint8Array>({
      write: (bytes) => child!.write(Buffer.from(bytes).toString("utf8")),
    });
    let sessionId = "";
    connection = client({ name: "glosa" })
      .onNotification(methods.client.session.update, ({ params }) => {
        if (closed || params.sessionId !== sessionId || !active) return;
        const update = params.update;
        if (
          (update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk") &&
          update.content.type === "text"
        )
          emit({
            type: "text",
            id: `${spec.runId}:${update.sessionUpdate}:${update.messageId ?? "message"}`,
            text: update.content.text,
            reasoning: update.sessionUpdate === "agent_thought_chunk",
          });
        else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
          const name = update.title ?? tools.get(update.toolCallId) ?? "Tool";
          tools.set(update.toolCallId, name);
          emit({
            type: "tool",
            id: update.toolCallId,
            name,
            detail: JSON.stringify(update.content ?? update.rawInput ?? "").slice(0, 16000),
            status: update.status === "failed" ? "failed" : update.status === "completed" ? "completed" : "running",
          });
        }
      })
      .onRequest(methods.client.session.requestPermission, ({ params }) => {
        if (closed || !active || params.sessionId !== sessionId) return { outcome: { outcome: "cancelled" as const } };
        // A persistent approval is never offered as an Allow once choice.
        const allow = params.options.find((item) => item.kind === "allow_once")?.optionId;
        const deny = params.options.find((item) => item.kind === "reject_once")?.optionId;
        const id = params.toolCall.toolCallId;
        if (pending.has(id)) return { outcome: { outcome: "cancelled" as const } };
        return new Promise<RequestPermissionResponse>((resolve) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            resolve({ outcome: { outcome: "cancelled" } });
            emit({ type: "decision_closed", id });
          }, 10 * 60_000);
          pending.set(id, { resolve, cleanup: () => clearTimeout(timer), allow, deny });
          emit({
            type: "decision",
            decision: {
              id,
              kind: "permission",
              title: params.toolCall.title ?? "Agent requests permission",
              detail: JSON.stringify(params.toolCall.rawInput ?? "").slice(0, 16000),
              choices: [...(allow ? [{ id: "allow", label: "Allow once" }] : []), { id: "deny", label: "Deny" }],
            },
          });
        });
      })
      .connect(ndJsonStream(writable, readable, { maxMessageBytes: 8 * 1024 * 1024 }));
    void child.exited.then(() => {
      if (closed) return;
      inputController.error(new Error("ACP process ended"));
      void stop().then(() =>
        emit({
          type: "failed",
          code: "native-disconnected",
          message: "The agent disconnected. The message was not resent.",
          outcomeUnknown: submitted,
        }),
      );
    });
    const initialized = await connection.agent.request("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "glosa", version: "1" },
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        ...(policy.initializeMeta ? { _meta: policy.initializeMeta } : {}),
      },
    });
    if (initialized.protocolVersion !== 1)
      throw new ManagedAgentError("runtime-unqualified", "This ACP protocol version has not been qualified.");
    const native = await policy.configure(connection, spec);
    sessionId = native.sessionId;
    if (!sessionId) throw new ManagedAgentError("runtime-unqualified", "The agent did not confirm a native session.");
    emit({ type: "session", nativeId: sessionId });
    let prepared: string | undefined;
    const prepareTurn = async (settings: TurnSettings) => {
      if (closed || active || submitted)
        throw new ManagedAgentError("run-fenced", "This execution attempt is no longer available.");
      await native.prepare(settings);
      if (closed) throw new ManagedAgentError("run-fenced", "This execution attempt stopped during preparation.");
      prepared = JSON.stringify(settings);
    };
    return {
      capabilities: native.capabilities,
      prepareTurn,
      async startTurn(input) {
        if (input.commandId)
          throw new ManagedAgentError("invalid-reference", "ACP command routing is awaiting qualification.");
        if (prepared !== JSON.stringify(input.settings)) await prepareTurn(input.settings);
        if (closed || submitted)
          throw new ManagedAgentError("run-fenced", "This execution attempt already accepted a message.");
        const prompt: ContentBlock[] = [{ type: "text", text: input.text }];
        for (const file of input.attachments) {
          if (file.mime.startsWith("image/")) {
            if (!native.capabilities.images)
              throw new ManagedAgentError("unsupported-images", "This agent does not accept images.");
            prompt.push({ type: "image", mimeType: file.mime, data: Buffer.from(file.bytes).toString("base64") });
          } else
            prompt.push({ type: "text", text: `Attachment: ${file.name}\n${new TextDecoder().decode(file.bytes)}` });
        }
        active = true;
        submitted = true;
        // Acceptance and terminal completion are separate; never wait for the model in startTurn.
        void connection!.agent
          .request("session/prompt", { sessionId, prompt })
          .then((result) => {
            if (closed) return;
            active = false;
            closeDecisions();
            const outcome = native.terminal(result);
            emit(
              outcome === "completed"
                ? { type: "completed" }
                : outcome === "cancelled"
                  ? { type: "failed", code: "native-cancelled", message: "The agent stopped this turn." }
                  : { type: "failed", ...outcome },
            );
          })
          .catch((error) => {
            if (closed) return;
            active = false;
            closeDecisions();
            emit({
              type: "failed",
              code: "acp-provider-failed",
              message: "The agent did not confirm completion. Review its output before continuing.",
              details: providerFailureDetails(error, providerEnvironmentSecrets(launch.env)),
              outcomeUnknown: true,
            });
          });
      },
      async answer(id, choice) {
        const decision = pending.get(id);
        if (!decision) throw new ManagedAgentError("stale-decision", "The agent no longer needs this decision.");
        if (choice !== "allow" && choice !== "deny")
          throw new ManagedAgentError("invalid-answer", "Choose an available response.");
        const optionId = choice === "allow" ? decision.allow : decision.deny;
        if (choice === "allow" && !optionId)
          throw new ManagedAgentError("invalid-answer", "This request does not offer a one-time approval.");
        pending.delete(id);
        decision.cleanup();
        decision.resolve(
          optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } },
        );
      },
      async interrupt() {
        if (!closed && active) {
          closeDecisions();
          await connection!.agent.notify("session/cancel", { sessionId });
        }
      },
      close: stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

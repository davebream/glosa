// SPDX-License-Identifier: Apache-2.0
// Product-scoped MCP stdio server: durable inbox pull/get, metadata, session bind,
// conversation acknowledgement, and the optional Claude Channel notification rung.
import { existsSync, lstatSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult, JSONRPCMessage, RequestId } from "@modelcontextprotocol/sdk/types.js";
import type { WorkspaceMetadataDescriptor } from "../../daemon/src/adapters/workspace-metadata.ts";
import { ensureToken, glosaHome } from "../../daemon/src/index.ts";
import { formatPresentationBatch } from "../../daemon/src/delivery/presentation.ts";
import type { GlosaApiClient } from "./api-client.ts";
import type { DaemonHookClient, DrainResult } from "./daemon-client.ts";
import {
  conversationAckInputSchema,
  conversationAckOutputSchema,
  inboxGetInputSchema,
  inboxGetOutputSchema,
  inboxPullInputSchema,
  inboxPullOutputSchema,
  metadataClearInputSchema,
  metadataClearOutputSchema,
  metadataSetInputSchema,
  metadataSetOutputSchema,
  metadataShowInputSchema,
  metadataShowOutputSchema,
  presentInputSchema,
  presentOutputSchema,
  sessionBindInputSchema,
  sessionBindOutputSchema,
} from "./mcp-schemas.ts";
import { runOpenPresentation } from "./open-presentation.ts";
import { CLI_VERSION } from "./version.ts";

interface PendingAck {
  client: DaemonHookClient;
  sessionId: string;
  deliveryId: string;
  deregister: boolean;
}

export interface McpDeps {
  createHookClient: () => Promise<DaemonHookClient>;
  createApiClient: () => Promise<GlosaApiClient>;
  cwd?: () => string;
  sessionId?: () => string | undefined;
}

export const GLOSA_MCP_TOOL_NAMES = [
  "glosa_inbox_pull",
  "glosa_inbox_get",
  "glosa_metadata_set",
  "glosa_metadata_show",
  "glosa_metadata_clear",
  "glosa_session_bind",
  "glosa_conversation_ack",
  "glosa_present",
] as const;

const readOnlyClosedWorld = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: false,
  destructiveHint: false,
} as const;

function stateChangingClosedWorld(options: { destructiveHint: boolean; idempotentHint: boolean }) {
  return {
    readOnlyHint: false,
    destructiveHint: options.destructiveHint,
    idempotentHint: options.idempotentHint,
    openWorldHint: false,
  } as const;
}

/** MCP structuredContent plus JSON text fallback; inbox tools keep actionable presentation text. */
function toolResult(structuredContent: Record<string, unknown>, presentationText?: string): CallToolResult {
  const content: CallToolResult["content"] = [];
  if (presentationText !== undefined) content.push({ type: "text", text: presentationText });
  content.push({ type: "text", text: JSON.stringify(structuredContent) });
  return { content, structuredContent };
}

function responseId(message: JSONRPCMessage): RequestId | undefined {
  if (!("id" in message) || (!("result" in message) && !("error" in message))) return undefined;
  return message.id;
}

function responseSucceeded(message: JSONRPCMessage): boolean {
  if (!("result" in message)) return false;
  const result = message.result;
  return (
    typeof result !== "object" ||
    result === null ||
    !("isError" in result) ||
    (result as { isError?: unknown }).isError !== true
  );
}

class DeliveryAcknowledgements {
  private readonly pending = new Map<RequestId, PendingAck>();

  reserve(requestId: RequestId, ack: PendingAck, signal: AbortSignal): void {
    this.pending.set(requestId, ack);
    signal.addEventListener(
      "abort",
      () => {
        void this.failed(requestId, "MCP request cancelled before its response was written").catch(() => {});
      },
      { once: true },
    );
  }

  async presented(requestId: RequestId): Promise<void> {
    const ack = this.pending.get(requestId);
    if (!ack) return;
    this.pending.delete(requestId);
    try {
      await ack.client.acknowledge?.(ack.sessionId, ack.deliveryId, "presented");
    } finally {
      if (ack.deregister) await ack.client.deregister(ack.sessionId);
    }
  }

  async failed(requestId: RequestId, reason: string): Promise<void> {
    const ack = this.pending.get(requestId);
    if (!ack) return;
    this.pending.delete(requestId);
    try {
      await ack.client.acknowledge?.(ack.sessionId, ack.deliveryId, "failed", reason);
    } finally {
      if (ack.deregister) await ack.client.deregister(ack.sessionId);
    }
  }

  async failAll(reason: string): Promise<void> {
    await Promise.allSettled([...this.pending.keys()].map((requestId) => this.failed(requestId, reason)));
  }
}

/**
 * The SDK owns protocol framing. This decorator owns only glosa's durability boundary: a prepared
 * inbox delivery becomes presented after the corresponding JSON-RPC response reaches stdout.
 */
class DeliveryAwareTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: Transport["onmessage"];
  sessionId?: string;

  constructor(
    private readonly inner: Transport,
    private readonly acknowledgements: DeliveryAcknowledgements,
  ) {
    this.sessionId = inner.sessionId;
  }

  async start(): Promise<void> {
    this.inner.onclose = () => this.onclose?.();
    this.inner.onerror = (error) => this.onerror?.(error);
    this.inner.onmessage = (message, extra) => this.onmessage?.(message, extra);
    await this.inner.start();
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    const requestId = responseId(message);
    try {
      await this.inner.send(message, options);
    } catch (error) {
      if (requestId !== undefined) {
        await this.acknowledgements
          .failed(requestId, error instanceof Error ? error.message : String(error))
          .catch(() => {});
      }
      throw error;
    }
    if (requestId === undefined) return;
    if (responseSucceeded(message)) {
      await this.acknowledgements.presented(requestId);
    } else {
      await this.acknowledgements.failed(requestId, "MCP tool response reported an error");
    }
  }

  async close(): Promise<void> {
    await this.acknowledgements.failAll("MCP transport closed before its response was written");
    await this.inner.close();
  }

  setProtocolVersion(version: string): void {
    this.inner.setProtocolVersion?.(version);
  }
}

/**
 * The SDK's stdio transport owns parsing and lifecycle. Its stock send resolves from write()
 * backpressure alone, though, so use the SDK serializer with a write callback to make a broken
 * stdout observable by DeliveryAwareTransport before glosa acknowledges presentation.
 */
class WriteConfirmedStdioServerTransport extends StdioServerTransport {
  private readonly handleOutputError = (error: Error) => this.onerror?.(error);

  constructor(
    input: Readable,
    private readonly output: Writable,
  ) {
    super(input, output);
  }

  override async start(): Promise<void> {
    this.output.on("error", this.handleOutputError);
    await super.start();
  }

  override send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      this.output.write(serializeMessage(message), (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  override async close(): Promise<void> {
    this.output.off("error", this.handleOutputError);
    await super.close();
  }
}

export interface GlosaMcpServer {
  server: McpServer;
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
}

export function createMcpServer(deps: McpDeps): GlosaMcpServer {
  const acknowledgements = new DeliveryAcknowledgements();
  const pushAbort = new AbortController();
  let pushTask: Promise<void> | null = null;

  const server = new McpServer(
    { name: "glosa", version: CLI_VERSION },
    {
      capabilities: {
        experimental: { "claude/channel": {} },
      },
      instructions:
        "glosa conversation messages arrive as channel events with a message_id. Immediately call glosa_conversation_ack for that message_id before acting; hook delivery remains the safety fallback.",
    },
  );

  server.registerTool(
    "glosa_inbox_pull",
    {
      title: "Pull glosa inbox",
      description:
        "Pull the oldest pending actionable glosa inbox entries for a workspace (at most eight). Reserves delivery briefly; successful stdio write acknowledges presentation.",
      inputSchema: inboxPullInputSchema,
      outputSchema: inboxPullOutputSchema,
      annotations: { ...readOnlyClosedWorld, title: "Pull glosa inbox" },
    },
    async ({ workspace, limit = 8, session_id: requestedSession }, extra) => {
      const root = workspace ?? (deps.cwd ?? process.cwd)();
      const hostSession = deps.sessionId?.();
      if (hostSession && requestedSession && requestedSession !== hostSession) {
        throw new Error("session_id does not match the MCP host session");
      }
      const explicitSession = hostSession ?? requestedSession;
      const sessionId = explicitSession ?? `mcp-${process.pid}-${randomUUID()}`;
      const client = await deps.createHookClient();
      if (explicitSession) {
        await client.heartbeat(sessionId);
      } else {
        await client.register({ session_id: sessionId, provider: "mcp", cwd: root, source: "mcp_pull" });
      }
      const drained: DrainResult = await client.drain(sessionId, { via: "mcp_pull", limit });
      const text =
        drained.count > 0 ? formatPresentationBatch(drained.drained) : "glosa inbox: no pending actionable entries";
      const structuredContent = {
        entries: drained.drained,
        count: drained.count,
        has_more: drained.has_more ?? false,
      };
      if (drained.delivery_id) {
        acknowledgements.reserve(
          extra.requestId,
          {
            client,
            sessionId,
            deliveryId: drained.delivery_id,
            deregister: !explicitSession,
          },
          extra.signal,
        );
      } else if (!explicitSession) {
        await client.deregister(sessionId);
      }
      return toolResult(structuredContent, text);
    },
  );

  server.registerTool(
    "glosa_inbox_get",
    {
      title: "Get glosa inbox entry",
      description:
        "Retrieve one durable inbox entry presentation by id, optionally continuing from a truncation cursor. Does not perform delivery drain.",
      inputSchema: inboxGetInputSchema,
      outputSchema: inboxGetOutputSchema,
      annotations: { ...readOnlyClosedWorld, title: "Get glosa inbox entry" },
    },
    async ({ id, cursor, workspace }) => {
      const root = workspace ?? (deps.cwd ?? process.cwd)();
      const retrieved = await (await deps.createApiClient()).getInboxPresentation(root, id, cursor);
      const structuredContent = { presentation: retrieved.presentation };
      return toolResult(structuredContent, retrieved.presentation.text);
    },
  );

  server.registerTool(
    "glosa_metadata_set",
    {
      title: "Set workspace metadata",
      description:
        "Register or replace this integration's WorkspaceMetadataDescriptor v1 for a workspace. Same id replaces atomically; a different id conflicts until clear.",
      inputSchema: metadataSetInputSchema,
      outputSchema: metadataSetOutputSchema,
      annotations: {
        ...stateChangingClosedWorld({ destructiveHint: false, idempotentHint: true }),
        title: "Set workspace metadata",
      },
    },
    async ({ metadata, workspace }) => {
      const root = workspace ?? (deps.cwd ?? process.cwd)();
      const structuredContent = await (await deps.createApiClient()).setMetadata!(
        root,
        metadata as WorkspaceMetadataDescriptor,
      );
      return toolResult(structuredContent);
    },
  );

  server.registerTool(
    "glosa_metadata_show",
    {
      title: "Show workspace metadata",
      description:
        "Show the active declarative WorkspaceMetadataDescriptor for a workspace, or null when none is registered.",
      inputSchema: metadataShowInputSchema,
      outputSchema: metadataShowOutputSchema,
      annotations: { ...readOnlyClosedWorld, title: "Show workspace metadata" },
    },
    async ({ workspace }) => {
      const root = workspace ?? (deps.cwd ?? process.cwd)();
      const metadata = await (await deps.createApiClient()).getMetadata!(root);
      return toolResult({ metadata });
    },
  );

  server.registerTool(
    "glosa_metadata_clear",
    {
      title: "Clear workspace metadata",
      description: "Clear the active declarative workspace metadata for a workspace.",
      inputSchema: metadataClearInputSchema,
      outputSchema: metadataClearOutputSchema,
      annotations: {
        ...stateChangingClosedWorld({ destructiveHint: true, idempotentHint: true }),
        title: "Clear workspace metadata",
      },
    },
    async ({ workspace }) => {
      const root = workspace ?? (deps.cwd ?? process.cwd)();
      const structuredContent = await (await deps.createApiClient()).clearMetadata!(root);
      return toolResult(structuredContent);
    },
  );

  server.registerTool(
    "glosa_session_bind",
    {
      title: "Bind agent session",
      description: "Explicitly bind a live registered agent session to a workspace (authoritative routing).",
      inputSchema: sessionBindInputSchema,
      outputSchema: sessionBindOutputSchema,
      annotations: {
        ...stateChangingClosedWorld({ destructiveHint: false, idempotentHint: true }),
        title: "Bind agent session",
      },
    },
    async ({ session_id: sessionId, workspace }) => {
      const root = workspace ?? (deps.cwd ?? process.cwd)();
      await (await deps.createHookClient()).heartbeat(sessionId);
      const structuredContent = await (await deps.createApiClient()).bindSession!(root, sessionId);
      return toolResult(structuredContent);
    },
  );

  server.registerTool(
    "glosa_conversation_ack",
    {
      title: "Acknowledge conversation message",
      description:
        "Acknowledge that a targeted glosa conversation message reached this agent context (presented). Required after channel delivery; hook delivery remains the safety fallback.",
      inputSchema: conversationAckInputSchema,
      outputSchema: conversationAckOutputSchema,
      annotations: {
        ...stateChangingClosedWorld({ destructiveHint: false, idempotentHint: true }),
        title: "Acknowledge conversation message",
      },
    },
    async ({ message_id: messageId, session_id: requestedSession }) => {
      const hostSession = deps.sessionId?.();
      if (hostSession && requestedSession && requestedSession !== hostSession) {
        throw new Error("session_id does not match the MCP host session");
      }
      const sessionId = hostSession ?? requestedSession;
      if (!sessionId) {
        throw new Error(
          "glosa_conversation_ack requires an explicit session_id when the MCP host does not provide one",
        );
      }
      const client = await deps.createHookClient();
      if (!client.acknowledgeConversation) throw new Error("conversation acknowledgement is unavailable");
      await client.acknowledgeConversation(sessionId, messageId, "presented");
      return toolResult({ message_id: messageId, delivered: true });
    },
  );

  server.registerTool(
    "glosa_present",
    {
      title: "Present an artifact",
      description:
        "Register/open an absolute file path and return a ready SPA URL. Never launches a browser. mode preview is preview-locked and session-independent; annotate/edit select an unlocked initial mode and bind the MCP host session or explicit session_id.",
      inputSchema: presentInputSchema,
      outputSchema: presentOutputSchema,
      annotations: {
        ...stateChangingClosedWorld({ destructiveHint: false, idempotentHint: true }),
        title: "Present an artifact",
      },
    },
    async ({ path, mode, session_id: requestedSession }) => {
      const hostSession = deps.sessionId?.();
      const previewLock = mode === "preview";
      if (!previewLock && hostSession && requestedSession && requestedSession !== hostSession) {
        throw new Error("session_id does not match the MCP host session");
      }
      const bindSessionId = previewLock ? undefined : (hostSession ?? requestedSession);
      const result = await runOpenPresentation(
        path,
        undefined,
        "document",
        {
          createClient: deps.createApiClient,
          ensureToken,
          glosaHome,
          openBrowser: () => {
            throw new Error("glosa_present must never launch a browser");
          },
          platform: () => process.platform,
          dirExists: (dir) => {
            try {
              return existsSync(dir) && lstatSync(dir).isDirectory();
            } catch {
              return false;
            }
          },
          fileExists: (p) => {
            try {
              return existsSync(p) && lstatSync(p).isFile();
            } catch {
              return false;
            }
          },
          isRegularFile: (p) => {
            try {
              const st = lstatSync(p);
              return st.isFile() && !st.isSymbolicLink();
            } catch {
              return false;
            }
          },
        },
        {
          launchBrowser: false,
          usePresentationToken: true,
          previewLock,
          mode,
          bindSessionId,
        },
      );
      if (!result.ok) {
        throw new Error(result.error?.message ?? "glosa_present failed");
      }
      const data = result.data;
      if (!data.url || !data.slug || !data.path || data.surface === undefined || data.mode === undefined || data.preview === undefined) {
        throw new Error("glosa_present returned an incomplete presentation payload");
      }
      if (data.url.includes("#t=") || /[?&#]t=/.test(data.url)) {
        throw new Error("glosa_present must not return the durable pairing token");
      }
      return toolResult({
        url: data.url,
        slug: data.slug,
        path: data.path,
        ...(data.focus ? { focus: data.focus } : {}),
        surface: data.surface,
        mode: data.mode,
        preview: data.preview,
        ...(data.bound_session ? { bound_session: data.bound_session } : {}),
        ...(data.state_dir ? { state_dir: data.state_dir } : {}),
        warnings: result.warnings,
      });
    },
  );

  const startPush = () => {
    const sessionId = deps.sessionId?.();
    if (!sessionId || pushTask) return;
    pushTask = (async () => {
      while (!pushAbort.signal.aborted) {
        try {
          const client = await deps.createHookClient();
          if (!client.openConversationPush || !client.acknowledgeConversation) return;
          await client.openConversationPush(
            sessionId,
            async (entry) => {
              if (entry.kind !== "conversation_message") return;
              await server.server.notification({
                method: "notifications/claude/channel",
                params: { content: entry.message, meta: { message_id: entry.id } },
              } as never);
              await client.acknowledgeConversation?.(sessionId, entry.id, "transport_accepted");
            },
            pushAbort.signal,
          );
        } catch {
          if (pushAbort.signal.aborted) return;
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 1_000);
            timer.unref?.();
            pushAbort.signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                resolve();
              },
              { once: true },
            );
          });
        }
      }
    })();
  };

  server.server.oninitialized = startPush;

  return {
    server,
    connect: (transport) => server.connect(new DeliveryAwareTransport(transport, acknowledgements)),
    close: async () => {
      pushAbort.abort();
      await server.close();
      if (pushTask) await pushTask.catch(() => {});
      await acknowledgements.failAll("MCP server closed before its response was written");
    },
  };
}

function waitForInputEnd(input: Readable): Promise<void> {
  if (input.readableEnded || input.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      input.off("end", done);
      input.off("close", done);
      resolve();
    };
    input.once("end", done);
    input.once("close", done);
  });
}

export async function runMcpServer(
  deps: McpDeps,
  streams: { stdin?: Readable; stdout?: Writable } = {},
): Promise<void> {
  const input = streams.stdin ?? process.stdin;
  const output = streams.stdout ?? process.stdout;
  const runtime = createMcpServer(deps);
  await runtime.connect(new WriteConfirmedStdioServerTransport(input, output));
  try {
    await waitForInputEnd(input);
  } finally {
    await runtime.close();
  }
}

// SPDX-License-Identifier: Apache-2.0
// Minimal issue-18 MCP stdio server: durable inbox pull and paginated entry retrieval only.
import { randomUUID } from "node:crypto";
import { formatPresentationBatch } from "../../daemon/src/delivery/presentation.ts";
import type { DaemonHookClient, DrainResult } from "./daemon-client.ts";
import type { GlosaApiClient } from "./api-client.ts";
import type { WorkspaceMetadataDescriptor } from "../../daemon/src/adapters/workspace-metadata.ts";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface PendingAck {
  client: DaemonHookClient;
  sessionId: string;
  deliveryId: string;
  deregister?: boolean;
}

interface McpReply {
  response?: Record<string, unknown>;
  ack?: PendingAck;
}

export interface McpDeps {
  createHookClient: () => Promise<DaemonHookClient>;
  createApiClient: () => Promise<GlosaApiClient>;
  cwd?: () => string;
  sessionId?: () => string | undefined;
}

function result(id: JsonRpcRequest["id"], value: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, result: value };
}

function error(id: JsonRpcRequest["id"], code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function textToolResult(text: string, structuredContent?: Record<string, unknown>): Record<string, unknown> {
  return {
    content: [{ type: "text", text }],
    ...(structuredContent ? { structuredContent } : {}),
  };
}

async function pullInbox(req: JsonRpcRequest, deps: McpDeps): Promise<McpReply> {
  const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
  const workspace = typeof args.workspace === "string" ? args.workspace : (deps.cwd ?? process.cwd)();
  const limit = typeof args.limit === "number" && Number.isInteger(args.limit) ? Math.max(1, Math.min(8, args.limit)) : 8;
  const requestedSession =
    typeof args.session_id === "string" && args.session_id.length > 0 ? args.session_id : undefined;
  const hostSession = deps.sessionId?.();
  if (hostSession && requestedSession && requestedSession !== hostSession) {
    return { response: error(req.id, -32602, "session_id does not match the MCP host session") };
  }
  const explicitSession = hostSession ?? requestedSession;
  const sessionId = explicitSession ?? `mcp-${process.pid}-${randomUUID()}`;
  const client = await deps.createHookClient();
  if (explicitSession) {
    await client.heartbeat(sessionId);
  } else {
    await client.register({ session_id: sessionId, provider: "mcp", cwd: workspace, source: "mcp_pull" });
  }
  const drained: DrainResult = await client.drain(sessionId, { via: "mcp_pull", limit });
  const text = drained.count > 0 ? formatPresentationBatch(drained.drained) : "glosa inbox: no pending actionable entries";
  if (!explicitSession && !drained.delivery_id) await client.deregister(sessionId);
  return {
    response: result(req.id, textToolResult(text, { entries: drained.drained, count: drained.count, has_more: drained.has_more ?? false })),
    ...(drained.delivery_id ? { ack: { client, sessionId, deliveryId: drained.delivery_id, deregister: !explicitSession } } : {}),
  };
}

async function getInbox(req: JsonRpcRequest, deps: McpDeps): Promise<McpReply> {
  const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
  if (typeof args.id !== "string" || args.id.length === 0) {
    return { response: error(req.id, -32602, "glosa_inbox_get requires a non-empty id") };
  }
  const workspace = typeof args.workspace === "string" ? args.workspace : (deps.cwd ?? process.cwd)();
  // `get` is retrieval by durable ID, not a delivery drain. A hook may already have honestly
  // acknowledged the entry as presented before the agent follows the advertised retrieval hint;
  // the drain path intentionally suppresses such entries and would therefore make that hint fail.
  // Match `glosa inbox get` and the HTTP contract by reading the immutable entry directly.
  const retrieved = await (await deps.createApiClient()).getInboxPresentation(
    workspace,
    args.id,
    typeof args.cursor === "string" ? args.cursor : undefined,
  );
  const presentation = retrieved.presentation;
  return {
    response: result(req.id, textToolResult(presentation.text, { presentation })),
  };
}

function toolArgs(req: JsonRpcRequest): Record<string, unknown> {
  return (req.params?.arguments ?? {}) as Record<string, unknown>;
}

async function metadataSet(req: JsonRpcRequest, deps: McpDeps): Promise<McpReply> {
  const args = toolArgs(req);
  if (typeof args.metadata !== "object" || args.metadata === null || Array.isArray(args.metadata)) {
    return { response: error(req.id, -32602, "glosa_metadata_set requires a metadata object") };
  }
  const workspace = typeof args.workspace === "string" ? args.workspace : (deps.cwd ?? process.cwd)();
  const changed = await (await deps.createApiClient()).setMetadata!(workspace, args.metadata as WorkspaceMetadataDescriptor);
  return { response: result(req.id, textToolResult(`workspace metadata ${changed.replaced ? "replaced" : "registered"}: ${changed.metadata.id}`, changed)) };
}

async function metadataShow(req: JsonRpcRequest, deps: McpDeps): Promise<McpReply> {
  const args = toolArgs(req);
  const workspace = typeof args.workspace === "string" ? args.workspace : (deps.cwd ?? process.cwd)();
  const metadata = await (await deps.createApiClient()).getMetadata!(workspace);
  return { response: result(req.id, textToolResult(metadata ? `workspace metadata: ${metadata.id}` : "workspace metadata is not registered", { metadata })) };
}

async function metadataClear(req: JsonRpcRequest, deps: McpDeps): Promise<McpReply> {
  const args = toolArgs(req);
  const workspace = typeof args.workspace === "string" ? args.workspace : (deps.cwd ?? process.cwd)();
  const cleared = await (await deps.createApiClient()).clearMetadata!(workspace);
  return { response: result(req.id, textToolResult(cleared.cleared ? "workspace metadata cleared" : "workspace metadata already clear", cleared)) };
}

async function sessionBind(req: JsonRpcRequest, deps: McpDeps): Promise<McpReply> {
  const args = toolArgs(req);
  if (typeof args.session_id !== "string" || args.session_id.length === 0) {
    return { response: error(req.id, -32602, "glosa_session_bind requires a non-empty session_id") };
  }
  const workspace = typeof args.workspace === "string" ? args.workspace : (deps.cwd ?? process.cwd)();
  // A live MCP tool invocation is itself session activity. Refresh the existing registry lease
  // before binding so a long model turn (>60s with no hook boundary) cannot make its own explicit
  // bind fail as stale. Unknown IDs remain unknown because heartbeat is deliberately a no-op for
  // records that were never registered or were lost across a daemon restart.
  await (await deps.createHookClient()).heartbeat(args.session_id);
  const bound = await (await deps.createApiClient()).bindSession!(workspace, args.session_id);
  return { response: result(req.id, textToolResult(`session bound: ${bound.session_id}`, bound)) };
}

async function conversationAck(req: JsonRpcRequest, deps: McpDeps): Promise<McpReply> {
  const args = toolArgs(req);
  const messageId = args.message_id;
  const requestedSession =
    typeof args.session_id === "string" && args.session_id.length > 0 ? args.session_id : undefined;
  const hostSession = deps.sessionId?.();
  if (hostSession && requestedSession && requestedSession !== hostSession) {
    return { response: error(req.id, -32602, "session_id does not match the MCP host session") };
  }
  const sessionId = hostSession ?? requestedSession;
  if (typeof messageId !== "string" || messageId.length === 0) {
    return { response: error(req.id, -32602, "glosa_conversation_ack requires message_id") };
  }
  if (!sessionId) {
    return {
      response: error(
        req.id,
        -32602,
        "glosa_conversation_ack requires an explicit session_id when the MCP host does not provide one",
      ),
    };
  }
  const client = await deps.createHookClient();
  if (!client.acknowledgeConversation) {
    return { response: error(req.id, -32603, "conversation acknowledgement is unavailable") };
  }
  await client.acknowledgeConversation(sessionId, messageId, "presented");
  return {
    response: result(
      req.id,
      textToolResult(`conversation message acknowledged: ${messageId}`, {
        message_id: messageId,
        delivered: true,
      }),
    ),
  };
}

export async function handleMcpRequest(req: JsonRpcRequest, deps: McpDeps): Promise<McpReply> {
  if (req.method === "initialize") {
    return {
      response: result(req.id, {
        protocolVersion: typeof req.params?.protocolVersion === "string" ? req.params.protocolVersion : "2025-03-26",
        capabilities: {
          tools: { listChanged: false },
          experimental: { "claude/channel": {} },
        },
        instructions:
          "glosa conversation messages arrive as channel events with a message_id. Immediately call glosa_conversation_ack for that message_id before acting; hook delivery remains the safety fallback.",
        serverInfo: { name: "glosa", version: "1" },
      }),
    };
  }
  if (req.method === "ping") return { response: result(req.id, {}) };
  if (req.method === "notifications/initialized" || req.method.startsWith("notifications/")) return {};
  if (req.method === "tools/list") {
    return {
      response: result(req.id, {
        tools: [
          {
            name: "glosa_inbox_pull",
            description: "Pull the oldest pending actionable glosa inbox entries.",
            inputSchema: {
              type: "object",
              properties: {
                workspace: { type: "string", description: "Workspace path; defaults to the MCP process cwd." },
                limit: { type: "integer", minimum: 1, maximum: 8 },
                session_id: { type: "string", description: "Explicit registered session for targeted messages." },
              },
              additionalProperties: false,
            },
          },
          {
            name: "glosa_inbox_get",
            description: "Retrieve an inbox entry or its next truncated page.",
            inputSchema: {
              type: "object",
              required: ["id"],
              properties: {
                id: { type: "string" },
                cursor: { type: "string", description: "Opaque continuation cursor from a prior presentation." },
                workspace: { type: "string", description: "Workspace path; defaults to the MCP process cwd." },
              },
              additionalProperties: false,
            },
          },
          {
            name: "glosa_metadata_set",
            description: "Register or replace this integration's declarative workspace metadata.",
            inputSchema: {
              type: "object",
              required: ["metadata"],
              properties: {
                workspace: { type: "string", description: "Workspace path; defaults to the MCP process cwd." },
                metadata: { type: "object", description: "WorkspaceMetadataDescriptor v1." },
              },
              additionalProperties: false,
            },
          },
          {
            name: "glosa_metadata_show",
            description: "Show the active declarative workspace metadata.",
            inputSchema: { type: "object", properties: { workspace: { type: "string" } }, additionalProperties: false },
          },
          {
            name: "glosa_metadata_clear",
            description: "Clear the active declarative workspace metadata.",
            inputSchema: { type: "object", properties: { workspace: { type: "string" } }, additionalProperties: false },
          },
          {
            name: "glosa_session_bind",
            description: "Explicitly bind a live agent session to a workspace.",
            inputSchema: {
              type: "object",
              required: ["session_id"],
              properties: { session_id: { type: "string" }, workspace: { type: "string" } },
              additionalProperties: false,
            },
          },
          {
            name: "glosa_conversation_ack",
            description: "Acknowledge that a targeted glosa conversation message reached this agent context.",
            inputSchema: {
              type: "object",
              required: ["message_id"],
              properties: {
                message_id: { type: "string" },
                session_id: { type: "string", description: "Required only when the MCP host provides no session identity." },
              },
              additionalProperties: false,
            },
          },
        ],
      }),
    };
  }
  if (req.method === "tools/call") {
    const name = req.params?.name;
    if (name === "glosa_inbox_pull") return pullInbox(req, deps);
    if (name === "glosa_inbox_get") return getInbox(req, deps);
    if (name === "glosa_metadata_set") return metadataSet(req, deps);
    if (name === "glosa_metadata_show") return metadataShow(req, deps);
    if (name === "glosa_metadata_clear") return metadataClear(req, deps);
    if (name === "glosa_session_bind") return sessionBind(req, deps);
    if (name === "glosa_conversation_ack") return conversationAck(req, deps);
    return { response: error(req.id, -32602, `unknown tool '${String(name)}'`) };
  }
  return { response: error(req.id, -32601, `method not found: ${req.method}`) };
}

function writeLine(value: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(value)}\n`, (err) => (err ? reject(err) : resolve()));
  });
}

export async function runMcpServer(deps: McpDeps): Promise<void> {
  let writeTail = Promise.resolve();
  const write = (value: Record<string, unknown>) => {
    const next = writeTail.then(() => writeLine(value));
    writeTail = next.catch(() => {});
    return next;
  };
  const pushAbort = new AbortController();
  let pushTask: Promise<void> | null = null;
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
              await write({
                jsonrpc: "2.0",
                method: "notifications/claude/channel",
                params: { content: entry.message, meta: { message_id: entry.id } },
              });
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

  let buffered = "";
  for await (const chunk of process.stdin) {
    buffered += Buffer.from(chunk).toString("utf8");
    let newline = buffered.indexOf("\n");
    while (newline >= 0) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf("\n");
      if (!line) continue;
      let req: JsonRpcRequest;
      try {
        req = JSON.parse(line) as JsonRpcRequest;
      } catch {
        await write(error(null, -32700, "parse error"));
        continue;
      }
      let reply: McpReply;
      try {
        reply = await handleMcpRequest(req, deps);
      } catch (err) {
        reply = { response: error(req.id, -32603, err instanceof Error ? err.message : String(err)) };
      }
      if (!reply.response) continue;
      try {
        await write(reply.response);
        if (req.method === "initialize") startPush();
        if (reply.ack) {
          await reply.ack.client.acknowledge?.(reply.ack.sessionId, reply.ack.deliveryId, "presented");
          if (reply.ack.deregister) await reply.ack.client.deregister(reply.ack.sessionId);
        }
      } catch (err) {
        if (reply.ack) {
          await reply.ack.client.acknowledge?.(
            reply.ack.sessionId,
            reply.ack.deliveryId,
            "failed",
            err instanceof Error ? err.message : String(err),
          );
          if (reply.ack.deregister) await reply.ack.client.deregister(reply.ack.sessionId);
        }
        throw err;
      }
    }
  }
  pushAbort.abort();
  const activePushTask = pushTask as Promise<void> | null;
  if (activePushTask) await activePushTask.catch(() => {});
}

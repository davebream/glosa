// SPDX-License-Identifier: Apache-2.0
// Product-scoped MCP 2025-11-25 stdio server: durable inbox pull/get, metadata, session bind,
// and conversation acknowledgement. Protocol contract only — no resources/prompts/tasks surface.
import { randomUUID } from "node:crypto";
import { formatPresentationBatch } from "../../daemon/src/delivery/presentation.ts";
import type { DaemonHookClient, DrainResult } from "./daemon-client.ts";
import type { GlosaApiClient } from "./api-client.ts";
import type { WorkspaceMetadataDescriptor } from "../../daemon/src/adapters/workspace-metadata.ts";
import { GLOSA_MCP_TOOL_BY_NAME, listMcpTools, MCP_PROTOCOL_VERSION } from "./mcp-tools.ts";

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

/** MCP structuredContent plus JSON text fallback; inbox tools keep actionable presentation text. */
function toolResult(structuredContent: Record<string, unknown>, presentationText?: string): Record<string, unknown> {
  const content: Array<{ type: "text"; text: string }> = [];
  if (presentationText !== undefined) {
    content.push({ type: "text", text: presentationText });
  }
  content.push({ type: "text", text: JSON.stringify(structuredContent) });
  return { content, structuredContent };
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
  const structured = {
    entries: drained.drained,
    count: drained.count,
    has_more: drained.has_more ?? false,
  };
  if (!explicitSession && !drained.delivery_id) await client.deregister(sessionId);
  return {
    response: result(req.id, toolResult(structured, text)),
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
  const structured = { presentation };
  return {
    response: result(req.id, toolResult(structured, presentation.text)),
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
  return { response: result(req.id, toolResult(changed)) };
}

async function metadataShow(req: JsonRpcRequest, deps: McpDeps): Promise<McpReply> {
  const args = toolArgs(req);
  const workspace = typeof args.workspace === "string" ? args.workspace : (deps.cwd ?? process.cwd)();
  const metadata = await (await deps.createApiClient()).getMetadata!(workspace);
  return { response: result(req.id, toolResult({ metadata })) };
}

async function metadataClear(req: JsonRpcRequest, deps: McpDeps): Promise<McpReply> {
  const args = toolArgs(req);
  const workspace = typeof args.workspace === "string" ? args.workspace : (deps.cwd ?? process.cwd)();
  const cleared = await (await deps.createApiClient()).clearMetadata!(workspace);
  return { response: result(req.id, toolResult(cleared)) };
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
  return { response: result(req.id, toolResult(bound)) };
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
      toolResult({
        message_id: messageId,
        delivered: true,
      }),
    ),
  };
}

export async function handleMcpRequest(req: JsonRpcRequest, deps: McpDeps): Promise<McpReply> {
  if (req.method === "initialize") {
    const requested = req.params?.protocolVersion;
    if (requested !== MCP_PROTOCOL_VERSION) {
      return {
        response: error(
          req.id,
          -32602,
          `unsupported protocol version: ${typeof requested === "string" ? requested : "(missing)"}; glosa mcp requires ${MCP_PROTOCOL_VERSION}`,
        ),
      };
    }
    return {
      response: result(req.id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
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
        tools: listMcpTools(),
      }),
    };
  }
  if (req.method === "tools/call") {
    const name = req.params?.name;
    if (typeof name !== "string" || !GLOSA_MCP_TOOL_BY_NAME.has(name)) {
      return { response: error(req.id, -32602, `unknown tool '${String(name)}'`) };
    }
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
        if (req.method === "initialize" && !("error" in reply.response)) startPush();
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

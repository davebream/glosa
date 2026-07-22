// SPDX-License-Identifier: Apache-2.0
// Minimal issue-18 MCP stdio server: durable inbox pull and paginated entry retrieval only.
import { randomUUID } from "node:crypto";
import { formatPresentationBatch } from "../../daemon/src/delivery/presentation.ts";
import type { DaemonHookClient, DrainResult } from "./daemon-client.ts";
import type { GlosaApiClient } from "./api-client.ts";

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
}

interface McpReply {
  response?: Record<string, unknown>;
  ack?: PendingAck;
}

export interface McpDeps {
  createHookClient: () => Promise<DaemonHookClient>;
  createApiClient: () => Promise<GlosaApiClient>;
  cwd?: () => string;
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
  const sessionId = `mcp-${process.pid}-${randomUUID()}`;
  const client = await deps.createHookClient();
  await client.register({ session_id: sessionId, provider: "mcp", cwd: workspace, source: "mcp_pull" });
  const drained: DrainResult = await client.drain(sessionId, { via: "mcp_pull", limit });
  const text = drained.count > 0 ? formatPresentationBatch(drained.drained) : "glosa inbox: no pending actionable entries";
  if (!drained.delivery_id) await client.deregister(sessionId);
  return {
    response: result(req.id, textToolResult(text, { entries: drained.drained, count: drained.count, has_more: drained.has_more ?? false })),
    ...(drained.delivery_id ? { ack: { client, sessionId, deliveryId: drained.delivery_id } } : {}),
  };
}

async function getInbox(req: JsonRpcRequest, deps: McpDeps): Promise<McpReply> {
  const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
  if (typeof args.id !== "string" || args.id.length === 0) {
    return { response: error(req.id, -32602, "glosa_inbox_get requires a non-empty id") };
  }
  const workspace = typeof args.workspace === "string" ? args.workspace : (deps.cwd ?? process.cwd)();
  const sessionId = `mcp-${process.pid}-${randomUUID()}`;
  const client = await deps.createHookClient();
  await client.register({ session_id: sessionId, provider: "mcp", cwd: workspace, source: "mcp_get" });
  const retrieved = await client.drain(sessionId, {
    via: "mcp_pull",
    limit: 1,
    entryId: args.id,
    ...(typeof args.cursor === "string" ? { cursor: args.cursor } : {}),
  });
  const presentation = retrieved.drained[0];
  if (!presentation) {
    await client.deregister(sessionId);
    return { response: error(req.id, -32602, `no pending actionable entry '${args.id}'`) };
  }
  return {
    response: result(req.id, textToolResult(presentation.text, { presentation })),
    ...(retrieved.delivery_id ? { ack: { client, sessionId, deliveryId: retrieved.delivery_id } } : {}),
  };
}

export async function handleMcpRequest(req: JsonRpcRequest, deps: McpDeps): Promise<McpReply> {
  if (req.method === "initialize") {
    return {
      response: result(req.id, {
        protocolVersion: typeof req.params?.protocolVersion === "string" ? req.params.protocolVersion : "2025-03-26",
        capabilities: { tools: { listChanged: false } },
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
        ],
      }),
    };
  }
  if (req.method === "tools/call") {
    const name = req.params?.name;
    if (name === "glosa_inbox_pull") return pullInbox(req, deps);
    if (name === "glosa_inbox_get") return getInbox(req, deps);
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
        await writeLine(error(null, -32700, "parse error"));
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
        await writeLine(reply.response);
        if (reply.ack) {
          await reply.ack.client.acknowledge?.(reply.ack.sessionId, reply.ack.deliveryId, "presented");
          await reply.ack.client.deregister(reply.ack.sessionId);
        }
      } catch (err) {
        if (reply.ack) {
          await reply.ack.client.acknowledge?.(
            reply.ack.sessionId,
            reply.ack.deliveryId,
            "failed",
            err instanceof Error ? err.message : String(err),
          );
          await reply.ack.client.deregister(reply.ack.sessionId);
        }
        throw err;
      }
    }
  }
}

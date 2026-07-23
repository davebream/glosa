// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import { handleMcpRequest, type McpDeps } from "../src/mcp.ts";
import {
  GLOSA_MCP_TOOLS,
  JSON_SCHEMA_2020_12,
  MCP_PROTOCOL_VERSION,
  type McpToolDefinition,
  workspaceMetadataDescriptorSchema,
} from "../src/mcp-tools.ts";
import type { DaemonHookClient, DrainResult, RegisterSessionInput } from "../src/daemon-client.ts";
import type { GlosaApiClient } from "../src/api-client.ts";

const ajv = new Ajv2020({ allErrors: true, strict: false });

function presentation(id: string, kind: "annotation" | "human_edit", text: string) {
  return {
    id,
    kind,
    status: "pending",
    text,
    bytes: Buffer.byteLength(text, "utf8"),
    detail: {},
    truncation: { truncated: false, omitted_bytes: 0, omitted_hunks: 0 },
    retrieval: { command: `glosa inbox get ${id}`, mcp_tool: "glosa_inbox_get" as const },
  };
}

class HookClient implements DaemonHookClient {
  registered: RegisterSessionInput | null = null;
  drained: DrainResult = {
    delivery_id: "delivery-1",
    count: 1,
    drained: [presentation("inb-1", "annotation", "glosa annotation inb-1\ncomment:\nAct on this.")],
  };
  drainOptions: unknown;
  heartbeats: string[] = [];
  async register(input: RegisterSessionInput) {
    this.registered = input;
    return { workspace: input.cwd, drained_workspaces: [] };
  }
  async heartbeat(sessionId: string) {
    this.heartbeats.push(sessionId);
  }
  async deregister() {}
  async drain(_sessionId: string, options?: unknown) {
    this.drainOptions = options;
    return this.drained;
  }
  async acknowledgeConversation(
    _sessionId: string,
    _messageId: string,
    _outcome: "transport_accepted" | "presented" | "failed",
  ) {}
}

function deps(hook: HookClient, api?: Partial<GlosaApiClient>): McpDeps {
  return {
    createHookClient: async () => hook,
    createApiClient: async () => api as GlosaApiClient,
    cwd: () => "/workspace",
  };
}

function toolResultPayload(reply: { response?: Record<string, unknown> }): {
  content: Array<{ type: string; text: string }>;
  structuredContent: Record<string, unknown>;
} {
  return (reply.response?.result as {
    content: Array<{ type: string; text: string }>;
    structuredContent: Record<string, unknown>;
  })!;
}

function assertOutputConforms(tool: McpToolDefinition, structured: unknown): void {
  const validate = ajv.compile(tool.outputSchema);
  expect(validate(structured), JSON.stringify(validate.errors)).toBe(true);
}

const VALID_METADATA = {
  version: 1 as const,
  id: "fixture",
  artifacts: [
    {
      path: "notes.md",
      class: "R" as const,
      order: 0,
      derived_from: { path: "notes.md", via: "identity" },
    },
  ],
};

describe("MCP 2025-11-25 tool contract", () => {
  test("initialize accepts only 2025-11-25 and never echoes a client-supplied version", async () => {
    const ok = await handleMcpRequest(
      { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: MCP_PROTOCOL_VERSION } },
      deps(new HookClient()),
    );
    expect(ok.response?.result).toMatchObject({
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {
        tools: { listChanged: false },
        experimental: { "claude/channel": {} },
      },
    });
    expect(JSON.stringify(ok.response?.result)).toContain("glosa_conversation_ack");

    for (const protocolVersion of ["2025-03-26", "2025-06-18", "2024-11-05", undefined]) {
      const rejected = await handleMcpRequest(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: protocolVersion === undefined ? {} : { protocolVersion },
        },
        deps(new HookClient()),
      );
      const rejectedError = rejected.response?.error as { code: number; message: string } | undefined;
      expect(rejectedError).toMatchObject({ code: -32602 });
      expect(rejectedError?.message).toContain(MCP_PROTOCOL_VERSION);
    }
  });

  test("tools/list advertises complete Draft 2020-12 metadata for every tool", async () => {
    const reply = await handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }, deps(new HookClient()));
    const listed = reply.response?.result as { tools: McpToolDefinition[] } | undefined;
    expect(listed).toBeDefined();
    if (!listed) throw new Error("expected tools/list result");
    const tools = listed.tools;
    expect(tools.map((tool) => tool.name)).toEqual(GLOSA_MCP_TOOLS.map((tool) => tool.name));

    for (const tool of tools) {
      expect(tool.title.length).toBeGreaterThan(0);
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema.$schema).toBe(JSON_SCHEMA_2020_12);
      expect(tool.outputSchema.$schema).toBe(JSON_SCHEMA_2020_12);
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.outputSchema.type).toBe("object");
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.outputSchema.additionalProperties).toBe(false);
      expect(tool.execution).toEqual({ taskSupport: "forbidden" });
      expect(tool.annotations.openWorldHint).toBe(false);
      expect(typeof tool.annotations.readOnlyHint).toBe("boolean");
      expect(typeof tool.annotations.idempotentHint).toBe("boolean");
      expect(ajv.validateSchema(tool.inputSchema)).toBe(true);
      expect(ajv.validateSchema(tool.outputSchema)).toBe(true);
    }

    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    for (const name of ["glosa_inbox_pull", "glosa_inbox_get", "glosa_metadata_show"]) {
      expect(byName.get(name)?.annotations).toMatchObject({
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      });
    }
    for (const name of ["glosa_metadata_set", "glosa_metadata_clear", "glosa_session_bind", "glosa_conversation_ack"]) {
      expect(byName.get(name)?.annotations.readOnlyHint).toBe(false);
      expect(byName.get(name)?.annotations.openWorldHint).toBe(false);
    }
    expect(byName.get("glosa_metadata_clear")?.annotations.destructiveHint).toBe(true);
  });

  test("input schemas accept valid examples and reject invalid ones", () => {
    const cases: Array<{
      name: string;
      valid: Record<string, unknown>[];
      invalid: Record<string, unknown>[];
    }> = [
      {
        name: "glosa_inbox_pull",
        valid: [{}, { workspace: "/w", limit: 3, session_id: "s1" }],
        invalid: [{ limit: 0 }, { limit: 9 }, { workspace: 1 }, { extra: true }],
      },
      {
        name: "glosa_inbox_get",
        valid: [{ id: "inb-1" }, { id: "inb-1", cursor: "opaque", workspace: "/w" }],
        invalid: [{}, { id: "" }, { id: "inb-1", cursor: 1 }, { id: "inb-1", unexpected: true }],
      },
      {
        name: "glosa_metadata_set",
        valid: [{ metadata: VALID_METADATA }, { workspace: "/w", metadata: { version: 1, id: "a", artifacts: [] } }],
        invalid: [
          {},
          { metadata: { version: 2, id: "a", artifacts: [] } },
          { metadata: { version: 1, id: "", artifacts: [] } },
          { metadata: { version: 1, id: "a", artifacts: [], extra: true } },
        ],
      },
      {
        name: "glosa_metadata_show",
        valid: [{}, { workspace: "/w" }],
        invalid: [{ workspace: "" }, { workspace: "/w", extra: true }],
      },
      {
        name: "glosa_metadata_clear",
        valid: [{}, { workspace: "/w" }],
        invalid: [{ workspace: 1 }, { cleared: true }],
      },
      {
        name: "glosa_session_bind",
        valid: [{ session_id: "s1" }, { session_id: "s1", workspace: "/w" }],
        invalid: [{}, { session_id: "" }, { session_id: "s1", extra: true }],
      },
      {
        name: "glosa_conversation_ack",
        valid: [{ message_id: "m-1" }, { message_id: "m-1", session_id: "s1" }],
        invalid: [{}, { message_id: "" }, { message_id: "m-1", session_id: 1 }],
      },
    ];

    for (const example of cases) {
      const tool = GLOSA_MCP_TOOLS.find((entry) => entry.name === example.name)!;
      const validate = ajv.compile(tool.inputSchema);
      for (const value of example.valid) {
        expect(validate(value), `${example.name} valid ${JSON.stringify(value)} -> ${JSON.stringify(validate.errors)}`).toBe(true);
      }
      for (const value of example.invalid) {
        expect(validate(value), `${example.name} invalid ${JSON.stringify(value)}`).toBe(false);
      }
    }

    const validateDescriptor = ajv.compile({
      $schema: JSON_SCHEMA_2020_12,
      ...workspaceMetadataDescriptorSchema,
    });
    expect(validateDescriptor(VALID_METADATA)).toBe(true);
    expect(validateDescriptor({ version: 1, id: "bad id", artifacts: [] })).toBe(false);
  });

  test("conversation acknowledgement uses the exact MCP session identity", async () => {
    const calls: unknown[] = [];
    const hook = new HookClient();
    hook.acknowledgeConversation = async (
      sessionId: string,
      messageId: string,
      outcome: "transport_accepted" | "presented" | "failed",
    ) => {
      calls.push([sessionId, messageId, outcome]);
    };
    const reply = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "glosa_conversation_ack", arguments: { message_id: "m-1" } },
      },
      { ...deps(hook), sessionId: () => "claude-session-1" },
    );
    expect(reply.response?.error).toBeUndefined();
    expect(calls).toEqual([["claude-session-1", "m-1", "presented"]]);
    const payload = toolResultPayload(reply);
    assertOutputConforms(GLOSA_MCP_TOOLS.find((tool) => tool.name === "glosa_conversation_ack")!, payload.structuredContent);
    expect(payload.content).toEqual([{ type: "text", text: JSON.stringify(payload.structuredContent) }]);
  });

  test("the MCP host session cannot be overridden for targeted pull or acknowledgement", async () => {
    const hook = new HookClient();
    const d = { ...deps(hook), sessionId: () => "host-session" };
    for (const [name, arguments_] of [
      ["glosa_inbox_pull", { session_id: "other-session" }],
      ["glosa_conversation_ack", { message_id: "m-1", session_id: "other-session" }],
    ] as const) {
      const reply = await handleMcpRequest(
        { jsonrpc: "2.0", id: name, method: "tools/call", params: { name, arguments: arguments_ } },
        d,
      );
      expect(reply.response?.error).toMatchObject({ code: -32602 });
    }
    expect(hook.heartbeats).toEqual([]);
  });

  test("metadata and session tools call the same API client contract as the CLI", async () => {
    const calls: unknown[] = [];
    const api: Partial<GlosaApiClient> = {
      setMetadata: async (workspace, metadata) => {
        calls.push(["set", workspace, metadata]);
        return { metadata, replaced: false };
      },
      getMetadata: async (workspace) => {
        calls.push(["show", workspace]);
        return { version: 1, id: "fixture", artifacts: [] };
      },
      clearMetadata: async (workspace) => {
        calls.push(["clear", workspace]);
        return { cleared: true };
      },
      bindSession: async (workspace, sessionId) => {
        calls.push(["bind", workspace, sessionId]);
        return { bound: true, session_id: sessionId };
      },
    };
    const hook = new HookClient();
    const d = deps(hook, api);
    const metadata = { version: 1, id: "fixture", artifacts: [] };
    for (const [name, arguments_] of [
      ["glosa_metadata_set", { workspace: "/w", metadata }],
      ["glosa_metadata_show", { workspace: "/w" }],
      ["glosa_metadata_clear", { workspace: "/w" }],
      ["glosa_session_bind", { workspace: "/w", session_id: "s1" }],
    ] as const) {
      const reply = await handleMcpRequest({ jsonrpc: "2.0", id: name, method: "tools/call", params: { name, arguments: arguments_ } }, d);
      expect(reply.response?.error).toBeUndefined();
      const payload = toolResultPayload(reply);
      const tool = GLOSA_MCP_TOOLS.find((entry) => entry.name === name)!;
      assertOutputConforms(tool, payload.structuredContent);
      expect(payload.content).toEqual([{ type: "text", text: JSON.stringify(payload.structuredContent) }]);
    }
    expect(calls).toEqual([
      ["set", "/w", metadata],
      ["show", "/w"],
      ["clear", "/w"],
      ["bind", "/w", "s1"],
    ]);
    expect(hook.heartbeats).toEqual(["s1"]);
  });

  test("pull returns actionable content plus JSON text and a post-write acknowledgement reservation", async () => {
    const hook = new HookClient();
    const reply = await handleMcpRequest(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "glosa_inbox_pull", arguments: {} } },
      deps(hook),
    );
    expect(hook.registered).toMatchObject({ provider: "mcp", cwd: "/workspace", source: "mcp_pull" });
    const payload = toolResultPayload(reply);
    expect(payload.content[0]?.text).toContain("Act on this.");
    expect(payload.content[1]?.text).toBe(JSON.stringify(payload.structuredContent));
    assertOutputConforms(GLOSA_MCP_TOOLS.find((tool) => tool.name === "glosa_inbox_pull")!, payload.structuredContent);
    expect(reply.ack).toMatchObject({ deliveryId: "delivery-1" });
  });

  test("get retrieves a durable entry directly even after delivery has been presented", async () => {
    const hook = new HookClient();
    hook.drained = { delivery_id: null, count: 0, drained: [] };
    const calls: unknown[] = [];
    const api: Partial<GlosaApiClient> = {
      getInboxPresentation: async (workspace, id, cursor) => {
        calls.push([workspace, id, cursor]);
        return { presentation: presentation("inb-2", "human_edit", "page opaque") };
      },
    };
    const reply = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "glosa_inbox_get", arguments: { id: "inb-2", cursor: "opaque" } },
      },
      deps(hook, api),
    );
    const payload = toolResultPayload(reply);
    expect(payload.content[0]?.text).toBe("page opaque");
    expect(payload.content[1]?.text).toBe(JSON.stringify(payload.structuredContent));
    assertOutputConforms(GLOSA_MCP_TOOLS.find((tool) => tool.name === "glosa_inbox_get")!, payload.structuredContent);
    expect(calls).toEqual([["/workspace", "inb-2", "opaque"]]);
    expect(hook.registered).toBeNull();
    expect(hook.drainOptions).toBeUndefined();
    expect(reply.ack).toBeUndefined();
  });
});

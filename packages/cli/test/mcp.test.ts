// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import { handleMcpRequest, type McpDeps } from "../src/mcp.ts";
import type { DaemonHookClient, DrainResult, RegisterSessionInput } from "../src/daemon-client.ts";
import type { GlosaApiClient } from "../src/api-client.ts";

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

describe("issue-focused MCP inbox tools", () => {
  test("initialize advertises the experimental Claude Channel and acknowledgement instruction", async () => {
    const reply = await handleMcpRequest(
      { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-03-26" } },
      deps(new HookClient()),
    );
    expect(reply.response?.result).toMatchObject({
      capabilities: { experimental: { "claude/channel": {} } },
    });
    expect(JSON.stringify(reply.response?.result)).toContain("glosa_conversation_ack");
  });

  test("tools/list exposes inbox plus metadata/session contract tools", async () => {
    const reply = await handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }, deps(new HookClient()));
    const names = ((reply.response?.result as { tools: Array<{ name: string }> }).tools).map((tool) => tool.name);
    expect(names).toEqual([
      "glosa_inbox_pull",
      "glosa_inbox_get",
      "glosa_metadata_set",
      "glosa_metadata_show",
      "glosa_metadata_clear",
      "glosa_session_bind",
      "glosa_conversation_ack",
    ]);
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
    }
    expect(calls).toEqual([
      ["set", "/w", metadata],
      ["show", "/w"],
      ["clear", "/w"],
      ["bind", "/w", "s1"],
    ]);
    expect(hook.heartbeats).toEqual(["s1"]);
  });

  test("pull returns actionable content plus a post-write acknowledgement reservation", async () => {
    const hook = new HookClient();
    const reply = await handleMcpRequest(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "glosa_inbox_pull", arguments: {} } },
      deps(hook),
    );
    expect(hook.registered).toMatchObject({ provider: "mcp", cwd: "/workspace", source: "mcp_pull" });
    expect(JSON.stringify(reply.response)).toContain("Act on this.");
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
    expect(JSON.stringify(reply.response)).toContain("page opaque");
    expect(calls).toEqual([["/workspace", "inb-2", "opaque"]]);
    expect(hook.registered).toBeNull();
    expect(hook.drainOptions).toBeUndefined();
    expect(reply.ack).toBeUndefined();
  });
});

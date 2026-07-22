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
  async register(input: RegisterSessionInput) {
    this.registered = input;
    return { workspace: input.cwd, drained_workspaces: [] };
  }
  async heartbeat() {}
  async deregister() {}
  async drain(_sessionId: string, options?: unknown) {
    this.drainOptions = options;
    return this.drained;
  }
}

function deps(hook: HookClient, api?: Partial<GlosaApiClient>): McpDeps {
  return {
    createHookClient: async () => hook,
    createApiClient: async () => api as GlosaApiClient,
    cwd: () => "/workspace",
  };
}

describe("issue-focused MCP inbox tools", () => {
  test("tools/list exposes pull/get and no resolve or request-review commands", async () => {
    const reply = await handleMcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }, deps(new HookClient()));
    const names = ((reply.response?.result as { tools: Array<{ name: string }> }).tools).map((tool) => tool.name);
    expect(names).toEqual(["glosa_inbox_pull", "glosa_inbox_get"]);
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

  test("get uses the same reserved paginated presentation returned by the daemon", async () => {
    const hook = new HookClient();
    hook.drained = {
      delivery_id: "delivery-get",
      count: 1,
      drained: [presentation("inb-2", "human_edit", "page opaque")],
    };
    const reply = await handleMcpRequest(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "glosa_inbox_get", arguments: { id: "inb-2", cursor: "opaque" } },
      },
      deps(hook),
    );
    expect(JSON.stringify(reply.response)).toContain("page opaque");
    expect(hook.drainOptions).toEqual({ via: "mcp_pull", limit: 1, entryId: "inb-2", cursor: "opaque" });
    expect(reply.ack).toMatchObject({ deliveryId: "delivery-get" });
  });
});

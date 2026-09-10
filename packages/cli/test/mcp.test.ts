// SPDX-License-Identifier: Apache-2.0
import { describe, expect, spyOn, test } from "bun:test";
import { PassThrough, Writable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  type CallToolResult,
  LATEST_PROTOCOL_VERSION,
  type Request,
  type Result,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { EntryStatus, GlosaApiClient } from "../src/api-client.ts";
import type { DaemonHookClient, DrainResult, RegisterSessionInput } from "../src/daemon-client.ts";
import {
  abortableDelay,
  createMcpServer,
  GLOSA_MCP_TOOL_NAMES,
  type GlosaMcpServer,
  MCP_PUSH_BACKOFF_FACTOR,
  MCP_PUSH_JITTER_RATIO,
  MCP_PUSH_MAX_DELAY_MS,
  MCP_PUSH_MIN_DELAY_MS,
  MCP_PUSH_RECOVERY_MS,
  MCP_PUSH_UNBOUND_RETRY_MS,
  type McpDeps,
  nextPushAttempt,
  pushReconnectDelayMs,
  closeWithinBudget,
  MCP_SHUTDOWN_BUDGET_MS,
  runMcpServer,
} from "../src/mcp.ts";
import {
  conversationAckInputSchema,
  inboxGetInputSchema,
  inboxPresentationSchema,
  inboxPullInputSchema,
  metadataClearInputSchema,
  metadataSetInputSchema,
  metadataShowInputSchema,
  sessionBindInputSchema,
  workspaceMetadataDescriptorSchema,
} from "../src/mcp-schemas.ts";
import { CLI_VERSION } from "../src/version.ts";
import { apiError } from "../src/api-client.ts";
import { discoverMcpIdentity } from "../src/session.ts";

test("MCP host discovery rejects ambiguous providers and permits explicit selection", () => {
  const claude = { session_id: "a", provider: "claude-code", cwd: "/agent" };
  const codex = { session_id: "b", provider: "codex", cwd: "/agent" };
  expect(() => discoverMcpIdentity([claude, codex])).toThrow("multiple provider");
  expect(discoverMcpIdentity([claude, codex], "codex")).toEqual(codex);
  expect(() => discoverMcpIdentity([codex], "claude-code")).toThrow("provider does not match");
  expect(discoverMcpIdentity([null], "codex")).toBeNull();
});

test("generic pull preserves requested workspace scope while reusing its stable identity", async () => {
  const hook = new HookClient();
  hook.drained = { count: 0, drained: [] };
  const connected = await connect(deps(hook));
  try {
    await callTool(connected.client, { name: "glosa_inbox_pull", arguments: { workspace: "/target-a" } });
    const id = hook.registered?.session_id;
    expect(hook.registered?.cwd).toBe("/target-a");
    await callTool(connected.client, { name: "glosa_inbox_pull", arguments: { workspace: "/target-b" } });
    expect(hook.registered).toMatchObject({ session_id: id, cwd: "/target-b" });
    expect(hook.deregistered).toEqual([]);
  } finally {
    await connected.close();
  }
  // Was `toEqual([hook.registered!.session_id])`. Re-stated, not dropped: shutdown no longer
  // deregisters at all (#140) — a `deregister` would put the current bearer on the wire to an
  // endpoint resolved at first registration, and a port held that long is not an identity. The
  // session is cleaned up by its lease expiring instead (A2 §F08). The assertion still pins the
  // shutdown behaviour of a generic pull's session; what it pins is now the opposite value.
  expect(hook.deregistered).toEqual([]);
});

test("MCP heartbeats all tool activity, recovers only missing registration, and preserves auth errors", async () => {
  const hook = new HookClient();
  let registrations = 0;
  const register = hook.register.bind(hook);
  hook.register = async (input) => {
    registrations++;
    return register(input);
  };
  const connected = await connect({
    ...deps(hook, { getMetadata: async () => null }),
    session: () => ({ session_id: "s", provider: "codex", cwd: "/agent" }),
  });
  try {
    await callTool(connected.client, { name: "glosa_metadata_show", arguments: {} });
    expect(registrations).toBe(1);
    hook.heartbeat = async () => {
      throw apiError(404, { title: "session not registered" });
    };
    expect((await callTool(connected.client, { name: "glosa_metadata_show", arguments: {} })).isError).not.toBe(true);
    expect(registrations).toBe(2);
    hook.heartbeat = async () => {
      throw apiError(401, { title: "unauthorized" });
    };
    expect((await callTool(connected.client, { name: "glosa_metadata_show", arguments: {} })).isError).toBe(true);
    expect(registrations).toBe(2);
  } finally {
    await connected.close();
  }
});

function presentation(id: string, kind: "annotation" | "human_edit", text: string) {
  return {
    id,
    workspace: "/workspace",
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
  deregistered: string[] = [];
  deliveryAcks: Array<[string, string, "presented" | "failed", string?]> = [];
  conversationAcks: Array<[string, string, "transport_accepted" | "presented" | "failed"]> = [];
  push?: DaemonHookClient["openConversationPush"];

  async register(input: RegisterSessionInput) {
    this.registered = input;
    return { workspace: input.cwd };
  }

  async heartbeat(sessionId: string) {
    this.heartbeats.push(sessionId);
  }

  async deregister(sessionId: string) {
    this.deregistered.push(sessionId);
  }

  async drain(_sessionId: string, options?: unknown) {
    this.drainOptions = options;
    return this.drained;
  }

  async acknowledge(sessionId: string, deliveryId: string, outcome: "presented" | "failed", error?: string) {
    this.deliveryAcks.push([sessionId, deliveryId, outcome, error]);
  }

  async acknowledgeConversation(
    sessionId: string,
    messageId: string,
    outcome: "transport_accepted" | "presented" | "failed",
  ) {
    this.conversationAcks.push([sessionId, messageId, outcome]);
  }

  async openConversationPush(
    sessionId: string,
    onEntry: Parameters<NonNullable<DaemonHookClient["openConversationPush"]>>[1],
    signal: AbortSignal,
    onOpen?: () => void,
  ) {
    if (this.push) return this.push(sessionId, onEntry, signal, onOpen);
  }
}

function deps(hook: HookClient, api?: Partial<GlosaApiClient>): McpDeps {
  return {
    createHookClient: async () => hook,
    createApiClient: async () => api as GlosaApiClient,
    cwd: () => "/workspace",
  };
}

interface Connected {
  runtime: GlosaMcpServer;
  client: Client;
  serverTransport: InMemoryTransport;
  close(): Promise<void>;
}

async function connect(d: McpDeps): Promise<Connected> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const runtime = createMcpServer(d);
  await runtime.connect(serverTransport);
  const client = new Client({ name: "glosa-test", version: "1" }, { capabilities: {} });
  await client.connect(clientTransport);
  return {
    runtime,
    client,
    serverTransport,
    close: async () => {
      await client.close();
      await runtime.close();
    },
  };
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  if (predicate()) return;
  throw new Error(`timed out waiting for ${label}`);
}

function structured(result: { structuredContent?: Record<string, unknown> }): Record<string, unknown> {
  expect(result.structuredContent).toBeDefined();
  return result.structuredContent!;
}

async function callTool(
  client: Client,
  request: { name: string; arguments?: Record<string, unknown> },
): Promise<CallToolResult> {
  return (await client.callTool(request)) as CallToolResult;
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

describe("official TypeScript MCP SDK contract", () => {
  test("SDK initialization advertises latest protocol, channel capability, instructions, and package version", async () => {
    const connected = await connect(deps(new HookClient()));
    try {
      expect(LATEST_PROTOCOL_VERSION).toBe("2025-11-25");
      expect(connected.client.getServerVersion()).toEqual({ name: "glosa", version: CLI_VERSION });
      expect(connected.client.getServerCapabilities()).toMatchObject({
        tools: { listChanged: true },
        experimental: { "claude/channel": {} },
      });
      expect(connected.client.getInstructions()).toContain("glosa_conversation_ack");
    } finally {
      await connected.close();
    }
  });

  test("SDK negotiates an older supported protocol version without custom interception", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let buffered = "";
    let resolveResponse: (value: string) => void = () => {};
    const responseLine = new Promise<string>((resolve) => {
      resolveResponse = resolve;
    });
    output.on("data", (chunk) => {
      buffered += chunk.toString();
      const newline = buffered.indexOf("\n");
      if (newline >= 0) resolveResponse(buffered.slice(0, newline));
    });

    const running = runMcpServer(deps(new HookClient()), { stdin: input, stdout: output });
    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "compatibility-test", version: "1" },
        },
      })}\n`,
    );
    const response = JSON.parse(await responseLine) as { result: { protocolVersion: string } };
    input.end();
    await running;
    expect(response.result.protocolVersion).toBe("2025-06-18");
  });

  test("tools/list is SDK-generated from the nine Zod registrations", async () => {
    const connected = await connect(deps(new HookClient()));
    try {
      const tools = (await connected.client.listTools()).tools;
      expect(tools.map((tool) => tool.name)).toEqual([...GLOSA_MCP_TOOL_NAMES]);
      for (const tool of tools) {
        expect(tool.title?.length).toBeGreaterThan(0);
        expect(tool.description?.length).toBeGreaterThan(0);
        expect(tool.inputSchema.type).toBe("object");
        expect(tool.outputSchema?.type).toBe("object");
        expect(tool.inputSchema.additionalProperties).toBe(false);
        expect(tool.outputSchema?.additionalProperties).toBe(false);
        expect(tool.execution).toEqual({ taskSupport: "forbidden" });
        expect(tool.annotations?.openWorldHint).toBe(false);
        expect(typeof tool.annotations?.readOnlyHint).toBe("boolean");
        expect(typeof tool.annotations?.idempotentHint).toBe("boolean");
      }

      const byName = new Map(tools.map((tool) => [tool.name, tool]));
      for (const name of ["glosa_inbox_pull", "glosa_inbox_get", "glosa_metadata_show"]) {
        expect(byName.get(name)?.annotations).toMatchObject({
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: false,
        });
      }
      expect(byName.get("glosa_inbox_pull")?.description).toBe(
        "Pull the oldest pending actionable glosa inbox entries across the active session's routable workspaces (at most eight globally). Reserves delivery briefly; successful stdio write acknowledges presentation.",
      );
      expect(byName.get("glosa_inbox_pull")?.outputSchema).toMatchObject({
        properties: {
          entries: {
            description:
              "Pulled actionable presentations in global durable created/adopted order, each labelled with its canonical workspace.",
          },
        },
      });
      expect(byName.get("glosa_metadata_clear")?.annotations?.destructiveHint).toBe(true);
      expect(byName.get("glosa_present")?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    } finally {
      await connected.close();
    }
  });

  test("strict Zod inputs accept valid examples and reject invalid or unknown fields", () => {
    const cases = [
      {
        schema: inboxPullInputSchema,
        valid: [{}, { workspace: "/w", limit: 3, session_id: "s1" }],
        invalid: [{ limit: 0 }, { limit: 9 }, { workspace: 1 }, { extra: true }],
      },
      {
        schema: inboxGetInputSchema,
        valid: [{ id: "inb-1" }, { id: "inb-1", cursor: "opaque", workspace: "/w" }],
        invalid: [{}, { id: "" }, { id: "inb-1", cursor: 1 }, { id: "inb-1", unexpected: true }],
      },
      {
        schema: metadataSetInputSchema,
        valid: [{ metadata: VALID_METADATA }, { workspace: "/w", metadata: { version: 1, id: "a", artifacts: [] } }],
        invalid: [
          {},
          { metadata: { version: 2, id: "a", artifacts: [] } },
          { metadata: { version: 1, id: "", artifacts: [] } },
          { metadata: { version: 1, id: "a", artifacts: [], extra: true } },
        ],
      },
      {
        schema: metadataShowInputSchema,
        valid: [{}, { workspace: "/w" }],
        invalid: [{ workspace: "" }, { workspace: "/w", extra: true }],
      },
      {
        schema: metadataClearInputSchema,
        valid: [{}, { workspace: "/w" }],
        invalid: [{ workspace: 1 }, { cleared: true }],
      },
      {
        schema: sessionBindInputSchema,
        valid: [{ session_id: "s1" }, { session_id: "s1", workspace: "/w" }],
        invalid: [{}, { session_id: "" }, { session_id: "s1", extra: true }],
      },
      {
        schema: conversationAckInputSchema,
        valid: [{ message_id: "m-1" }, { message_id: "m-1", session_id: "s1" }],
        invalid: [{}, { message_id: "" }, { message_id: "m-1", session_id: 1 }],
      },
    ] as const;

    for (const example of cases) {
      for (const value of example.valid) expect(example.schema.safeParse(value).success).toBe(true);
      for (const value of example.invalid) expect(example.schema.safeParse(value).success).toBe(false);
    }
    expect(workspaceMetadataDescriptorSchema.safeParse(VALID_METADATA).success).toBe(true);
    expect(workspaceMetadataDescriptorSchema.safeParse({ version: 1, id: "bad id", artifacts: [] }).success).toBe(
      false,
    );
    const legacyPresentation: Partial<ReturnType<typeof presentation>> = presentation(
      "inb-n-minus-one",
      "annotation",
      "legacy response",
    );
    delete legacyPresentation.workspace;
    expect(inboxPresentationSchema.safeParse(legacyPresentation).success).toBe(true);
  });

  test("SDK-native tool errors reject invalid input and session identity overrides", async () => {
    const hook = new HookClient();
    const connected = await connect({ ...deps(hook), sessionId: () => "host-session" });
    try {
      const invalid = await callTool(connected.client, { name: "glosa_inbox_get", arguments: {} });
      expect(invalid.isError).toBe(true);
      expect(invalid.content).toEqual([
        expect.objectContaining({ type: "text", text: expect.stringContaining("Input validation error") }),
      ]);
      const unknown = await callTool(connected.client, { name: "glosa_unknown", arguments: {} });
      expect(unknown.isError).toBe(true);
      expect(unknown.content).toEqual([
        expect.objectContaining({ type: "text", text: expect.stringContaining("not found") }),
      ]);

      for (const [name, args] of [
        ["glosa_inbox_pull", { session_id: "other-session" }],
        ["glosa_conversation_ack", { message_id: "m-1", session_id: "other-session" }],
      ] as const) {
        const result = await callTool(connected.client, { name, arguments: args });
        expect(result.isError).toBe(true);
        expect(result.content).toEqual([
          expect.objectContaining({ type: "text", text: "session_id does not match the MCP host session" }),
        ]);
      }
      expect(hook.heartbeats).toEqual([]);
    } finally {
      await connected.close();
    }
  });

  test("SDK validates structured output against the registered Zod schema", async () => {
    const hook = new HookClient();
    const api: Partial<GlosaApiClient> = {
      getMetadata: async () => ({ version: 2, id: "invalid", artifacts: [] }) as never,
    };
    const connected = await connect(deps(hook, api));
    try {
      const result = await callTool(connected.client, { name: "glosa_metadata_show", arguments: {} });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        expect.objectContaining({ type: "text", text: expect.stringContaining("Output validation error") }),
      ]);
    } finally {
      await connected.close();
    }
  });

  test("conversation acknowledgement uses the exact MCP host session", async () => {
    const hook = new HookClient();
    const connected = await connect({ ...deps(hook), sessionId: () => "claude-session-1" });
    try {
      const result = await callTool(connected.client, {
        name: "glosa_conversation_ack",
        arguments: { message_id: "m-1" },
      });
      expect(result.isError).not.toBe(true);
      expect(structured(result)).toEqual({ message_id: "m-1", delivered: true });
      expect(hook.conversationAcks).toEqual([["claude-session-1", "m-1", "presented"]]);
    } finally {
      await connected.close();
    }
  });

  test("metadata and session tools retain CLI/API parity", async () => {
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
    const connected = await connect(deps(hook, api));
    try {
      for (const [name, args] of [
        ["glosa_metadata_set", { workspace: "/w", metadata: { version: 1, id: "fixture", artifacts: [] } }],
        ["glosa_metadata_show", { workspace: "/w" }],
        ["glosa_metadata_clear", { workspace: "/w" }],
        ["glosa_session_bind", { workspace: "/w", session_id: "s1" }],
      ] as const) {
        const result = await callTool(connected.client, { name, arguments: args });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toBeDefined();
        expect(result.content).toEqual([{ type: "text", text: JSON.stringify(result.structuredContent) }]);
      }
      expect(calls).toEqual([
        ["set", "/w", { version: 1, id: "fixture", artifacts: [] }],
        ["show", "/w"],
        ["clear", "/w"],
        ["bind", "/w", "s1"],
      ]);
      expect(hook.heartbeats).toHaveLength(2);
      expect(new Set(hook.heartbeats).size).toBe(1);
      expect(hook.registered?.session_id).toBe("s1");
    } finally {
      await connected.close();
    }
  });

  test("pull keeps actionable text and acknowledges only after the SDK transport write", async () => {
    const hook = new HookClient();
    const events: string[] = [];
    hook.acknowledge = async (sessionId, deliveryId, outcome, error) => {
      events.push(outcome);
      hook.deliveryAcks.push([sessionId, deliveryId, outcome, error]);
    };
    const connected = await connect(deps(hook));
    const send = connected.serverTransport.send.bind(connected.serverTransport);
    connected.serverTransport.send = async (message, options) => {
      await send(message, options);
      if ("result" in message && typeof message.result === "object" && message.result && "content" in message.result) {
        events.push("write");
      }
    };
    try {
      const result = await callTool(connected.client, { name: "glosa_inbox_pull", arguments: {} });
      await waitFor(() => hook.deliveryAcks.length === 1, "post-write delivery acknowledgement");
      expect(result.content[0]).toEqual(
        expect.objectContaining({ type: "text", text: expect.stringContaining("Act on this.") }),
      );
      expect(result.content[1]).toEqual({ type: "text", text: JSON.stringify(result.structuredContent) });
      expect(hook.registered).toMatchObject({ provider: "mcp", cwd: "/workspace", source: "mcp" });
      expect(events).toEqual(["write", "presented"]);
      expect(hook.deliveryAcks[0]?.slice(1, 3)).toEqual(["delivery-1", "presented"]);
      if (!hook.registered) throw new Error("expected stable MCP registration");
      expect(hook.deregistered).toEqual([]);
    } finally {
      await connected.close();
    }
  });

  test("transport write failure records failed and retains the shim session until close", async () => {
    const hook = new HookClient();
    const connected = await connect(deps(hook));
    const send = connected.serverTransport.send.bind(connected.serverTransport);
    connected.serverTransport.send = async (message, options) => {
      if ("result" in message && typeof message.result === "object" && message.result && "content" in message.result) {
        throw new Error("stdout unavailable");
      }
      await send(message, options);
    };
    try {
      void callTool(connected.client, { name: "glosa_inbox_pull", arguments: {} }).catch(() => {});
      await waitFor(() => hook.deliveryAcks.some((ack) => ack[2] === "failed"), "failed delivery acknowledgement");
      expect(hook.deliveryAcks[0]?.slice(1)).toEqual(["delivery-1", "failed", "stdout unavailable"]);
      if (!hook.registered) throw new Error("expected stable MCP registration");
      expect(hook.deregistered).toEqual([]);
    } finally {
      await connected.close();
    }
  });

  test("get refreshes registration and retrieves the durable entry without draining", async () => {
    const hook = new HookClient();
    hook.drained = { delivery_id: null, count: 0, drained: [] };
    const calls: unknown[] = [];
    const api: Partial<GlosaApiClient> = {
      getInboxPresentation: async (workspace, id, cursor) => {
        calls.push([workspace, id, cursor]);
        return { presentation: presentation("inb-2", "human_edit", "page opaque") };
      },
    };
    const connected = await connect(deps(hook, api));
    try {
      const result = await callTool(connected.client, {
        name: "glosa_inbox_get",
        arguments: { id: "inb-2", cursor: "opaque" },
      });
      expect(result.content[0]).toEqual({ type: "text", text: "page opaque" });
      expect(result.content[1]).toEqual({ type: "text", text: JSON.stringify(result.structuredContent) });
      expect(calls).toEqual([["/workspace", "inb-2", "opaque"]]);
      expect(hook.registered?.source).toBe("mcp");
      expect(hook.drainOptions).toBeUndefined();
      expect(hook.deliveryAcks).toEqual([]);
    } finally {
      await connected.close();
    }
  });

  test("initialized SDK connection sends Claude channel notifications and records transport acceptance", async () => {
    const channelNotificationSchema = z.object({
      method: z.literal("notifications/claude/channel"),
      params: z.object({
        content: z.string(),
        meta: z.object({ message_id: z.string() }),
      }),
    });
    type ChannelNotification = z.infer<typeof channelNotificationSchema>;
    const hook = new HookClient();
    hook.push = async (_sessionId, onEntry, signal) => {
      await onEntry({
        id: "message-1",
        workspace: "/workspace",
        kind: "conversation_message",
        status: "pending",
        text: "bounded",
        bytes: 7,
        message: "Exact composer text",
        message_bytes: 19,
        target_session_id: "claude-session-1",
        provider: "claude-code",
        detail: {},
        truncation: { truncated: false, omitted_bytes: 0, omitted_hunks: 0 },
        retrieval: { command: "glosa inbox get message-1", mcp_tool: "glosa_inbox_get" },
      });
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    };

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const runtime = createMcpServer({ ...deps(hook), sessionId: () => "claude-session-1" });
    await runtime.connect(serverTransport);
    const client = new Client<Request, ChannelNotification, Result>(
      { name: "channel-test", version: "1" },
      { capabilities: {} },
    );
    const notifications: ChannelNotification[] = [];
    client.setNotificationHandler(channelNotificationSchema, (notification) => {
      notifications.push(notification);
    });
    await client.connect(clientTransport);
    try {
      await waitFor(
        () => notifications.length === 1 && hook.conversationAcks.length === 1,
        "Claude channel notification acknowledgement",
      );
      expect(notifications[0]).toEqual({
        method: "notifications/claude/channel",
        params: { content: "Exact composer text", meta: { message_id: "message-1" } },
      });
      expect(hook.conversationAcks).toEqual([["claude-session-1", "message-1", "transport_accepted"]]);
    } finally {
      await client.close();
      await runtime.close();
    }
  });

  describe("MCP push-stream reconnect math (issue 178) — deterministic, no waiting", () => {
    test("pushReconnectDelayMs never violates the 5,000ms floor or the finite cap, across escalating attempts", () => {
      for (let attempt = 0; attempt <= 10; attempt++) {
        const expectedFloor = Math.min(
          MCP_PUSH_MIN_DELAY_MS * MCP_PUSH_BACKOFF_FACTOR ** attempt,
          MCP_PUSH_MAX_DELAY_MS,
        );
        const expectedCeiling = Math.min(MCP_PUSH_MAX_DELAY_MS, expectedFloor * (1 + MCP_PUSH_JITTER_RATIO));
        for (let sample = 0; sample < 20; sample++) {
          const delay = pushReconnectDelayMs(attempt);
          expect(delay).toBeGreaterThanOrEqual(expectedFloor);
          expect(delay).toBeLessThanOrEqual(expectedCeiling);
        }
      }
      // Proves the loop above actually exercised both regimes, not just the already-capped one:
      // by attempt 10 the raw exponential (5,000 * 2^10) is far past the cap.
      expect(MCP_PUSH_MIN_DELAY_MS * MCP_PUSH_BACKOFF_FACTOR ** 10).toBeGreaterThan(MCP_PUSH_MAX_DELAY_MS);
      expect(pushReconnectDelayMs(0)).toBeGreaterThanOrEqual(MCP_PUSH_MIN_DELAY_MS);
    });

    test("nextPushAttempt resets to the floor only once a connection was actually held for one lease-refresh cycle", () => {
      expect(nextPushAttempt(0, 0)).toBe(1);
      expect(nextPushAttempt(3, MCP_PUSH_RECOVERY_MS - 1)).toBe(4);
      expect(nextPushAttempt(3, MCP_PUSH_RECOVERY_MS)).toBe(0);
      expect(nextPushAttempt(7, MCP_PUSH_RECOVERY_MS * 5)).toBe(0);
    });

    test("abortableDelay resolves via its timer and releases the abort listener it registered", async () => {
      const controller = new AbortController();
      const addSpy = spyOn(controller.signal, "addEventListener");
      const removeSpy = spyOn(controller.signal, "removeEventListener");
      await abortableDelay(10, controller.signal);
      expect(addSpy).toHaveBeenCalledTimes(1);
      expect(removeSpy).toHaveBeenCalledTimes(1);
    });

    test("abortableDelay resolves promptly on abort instead of waiting out a long pending timer", async () => {
      const controller = new AbortController();
      const started = Date.now();
      const pending = abortableDelay(10_000, controller.signal);
      controller.abort();
      await pending;
      expect(Date.now() - started).toBeLessThan(200);
    });

    test("abortableDelay resolves immediately when the signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();
      const started = Date.now();
      await abortableDelay(10_000, controller.signal);
      expect(Date.now() - started).toBeLessThan(50);
    });
  });

  describe("MCP push-stream reconnect loop (issue 178) — real timing through the SDK", () => {
    test("a stream failure waits at least the 5,000ms floor before reconnecting, never the old flat 1s retry", async () => {
      const hook = new HookClient();
      const attemptedAt: number[] = [];
      hook.push = async () => {
        attemptedAt.push(Date.now());
        throw new Error("stream failure");
      };
      const connected = await connect({ ...deps(hook), sessionId: () => "claude-session-1" });
      try {
        await waitFor(() => attemptedAt.length >= 2, "second reconnect attempt", MCP_PUSH_MIN_DELAY_MS * 1.5);
        const gap = attemptedAt[1]! - attemptedAt[0]!;
        expect(gap).toBeGreaterThanOrEqual(MCP_PUSH_MIN_DELAY_MS);
        expect(gap).toBeLessThan(MCP_PUSH_MIN_DELAY_MS * 1.5);
      } finally {
        await connected.close();
      }
    }, 15_000);

    test("a clean EOF (openConversationPush resolves without throwing, e.g. a daemon restart) waits at least the 5,000ms floor — never the immediate-retry burst issue 178 reported", async () => {
      const hook = new HookClient();
      const attemptedAt: number[] = [];
      hook.push = async () => {
        attemptedAt.push(Date.now());
        // Resolves cleanly, exactly as createHttpDaemonClient's real openConversationPush does on
        // a clean EOF (daemon-client.ts's `if (done) break;` falls out of the loop and returns) —
        // never throws. Before issue 178, this path skipped the catch's sleep entirely.
      };
      const connected = await connect({ ...deps(hook), sessionId: () => "claude-session-1" });
      try {
        await waitFor(
          () => attemptedAt.length >= 2,
          "second reconnect attempt after clean EOF",
          MCP_PUSH_MIN_DELAY_MS * 1.5,
        );
        const gap = attemptedAt[1]! - attemptedAt[0]!;
        expect(gap).toBeGreaterThanOrEqual(MCP_PUSH_MIN_DELAY_MS);
        expect(gap).toBeLessThan(MCP_PUSH_MIN_DELAY_MS * 1.5);
      } finally {
        await connected.close();
      }
    }, 15_000);

    test("createHookClient/daemon-discovery failure waits at least the 5,000ms floor and escalates across repeated failures", async () => {
      const attemptedAt: number[] = [];
      const failingDeps: McpDeps = {
        createHookClient: async () => {
          attemptedAt.push(Date.now());
          throw new Error("glosa daemon unreachable: connection refused");
        },
        createApiClient: async () => ({}) as GlosaApiClient,
        cwd: () => "/workspace",
        sessionId: () => "claude-session-1",
      };
      const connected = await connect(failingDeps);
      try {
        await waitFor(() => attemptedAt.length >= 3, "third discovery attempt", MCP_PUSH_MAX_DELAY_MS * 1.5);
        const firstGap = attemptedAt[1]! - attemptedAt[0]!;
        const secondGap = attemptedAt[2]! - attemptedAt[1]!;
        expect(firstGap).toBeGreaterThanOrEqual(MCP_PUSH_MIN_DELAY_MS);
        // Bounded escalation, never the old flat 1,000ms-forever retry issue 178 reported for a
        // daemon that never comes back ("roughly 60 attempts a minute, forever, with no escalation").
        expect(secondGap).toBeGreaterThan(firstGap);
      } finally {
        await connected.close();
      }
    }, 30_000);

    test("a stalled connection that never establishes escalates backoff — wall-clock time alone cannot fake recovery", async () => {
      const hook = new HookClient();
      const startedAt: number[] = [];
      const finishedAt: number[] = [];
      let call = 0;
      hook.push = async (_sessionId, _onEntry, _signal, onOpen) => {
        call++;
        startedAt.push(Date.now());
        if (call === 2) {
          // A request that stalls past one whole lease-refresh cycle (MCP_PUSH_RECOVERY_MS) and
          // then fails WITHOUT ever calling onOpen — i.e. it never actually established a
          // connection, unlike a genuinely held-open stream that just happens to run that long.
          await Bun.sleep(MCP_PUSH_RECOVERY_MS + 1_000);
        }
        void onOpen; // deliberately never invoked — this attempt never opens
        finishedAt.push(Date.now());
        throw new Error("stream failure");
      };
      const connected = await connect({ ...deps(hook), sessionId: () => "claude-session-1" });
      try {
        await waitFor(() => startedAt.length >= 3, "third reconnect attempt", 90_000);
        // The delay between the stalled attempt finishing and the next attempt starting is the
        // real signal: reset-to-floor (the bug) yields ~MCP_PUSH_MIN_DELAY_MS; escalation (the
        // fix) yields at least one more doubling on top of that.
        const delayAfterStall = startedAt[2]! - finishedAt[1]!;
        expect(delayAfterStall).toBeGreaterThanOrEqual(MCP_PUSH_MIN_DELAY_MS * MCP_PUSH_BACKOFF_FACTOR);
      } finally {
        await connected.close();
      }
    }, 120_000);

    test("registered/alive/unbound (409) never spins — no retry within the ordinary backoff floor", async () => {
      const hook = new HookClient();
      let calls = 0;
      hook.push = async () => {
        calls++;
        throw apiError(409, { title: "session is not explicitly bound" });
      };
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      try {
        const connected = await connect({ ...deps(hook), sessionId: () => "claude-session-1" });
        try {
          await waitFor(() => calls >= 1, "first push attempt");
          // Long past the 5,000ms floor a generic stream failure would already have retried within —
          // a 409 must not, because only an explicit bind resolves it, never the passage of time.
          await Bun.sleep(MCP_PUSH_MIN_DELAY_MS + 1_500);
          expect(calls).toBe(1);
        } finally {
          await connected.close();
        }
      } finally {
        errorSpy.mockRestore();
      }
    }, 15_000);

    test("registered/alive/unbound (409) says why on stderr before the long wait, not silence", async () => {
      const hook = new HookClient();
      hook.push = async () => {
        throw apiError(409, { title: "session is not explicitly bound" });
      };
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      try {
        const connected = await connect({ ...deps(hook), sessionId: () => "claude-session-1" });
        try {
          await waitFor(() => errorSpy.mock.calls.length >= 1, "unbound diagnostic on stderr");
          const message = String(errorSpy.mock.calls[0]?.[0]);
          expect(message).toContain("claude-session-1");
          expect(message.toLowerCase()).toContain("not bound");
          expect(message).toContain(String(MCP_PUSH_UNBOUND_RETRY_MS));
        } finally {
          await connected.close();
        }
      } finally {
        errorSpy.mockRestore();
      }
    }, 15_000);

    test("close() cancels a pending reconnect wait promptly and the loop never reconnects again", async () => {
      const hook = new HookClient();
      let calls = 0;
      hook.push = async () => {
        calls++;
        throw new Error("stream failure");
      };
      const connected = await connect({ ...deps(hook), sessionId: () => "claude-session-1" });
      await waitFor(() => calls >= 1, "first push attempt");
      const closedAt = Date.now();
      await connected.close();
      expect(Date.now() - closedAt).toBeLessThan(500);
      // Long enough that a loop which failed to release its pending wait would have reconnected.
      await Bun.sleep(MCP_PUSH_MIN_DELAY_MS + 1_000);
      expect(calls).toBe(1);
    }, 15_000);
  });

  test("stdio write failure records failed before the temporary session is cleaned up", async () => {
    const hook = new HookClient();
    const input = new PassThrough();
    let resolveInitializeWrite = () => {};
    const initializeWritten = new Promise<void>((resolve) => {
      resolveInitializeWrite = resolve;
    });
    let writes = 0;
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        writes++;
        if (writes === 1) {
          callback();
          resolveInitializeWrite();
        } else {
          callback(new Error("broken stdout"));
        }
      },
    });

    const running = runMcpServer(deps(hook), { stdin: input, stdout: output });
    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "stdio-test", version: "1" },
        },
      })}\n`,
    );
    await initializeWritten;
    input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "glosa_inbox_pull", arguments: {} },
      })}\n`,
    );

    await waitFor(() => hook.deliveryAcks.some((ack) => ack[2] === "failed"), "stdio write failure");
    input.end();
    await running;
    expect(hook.deliveryAcks[0]?.slice(1)).toEqual(["delivery-1", "failed", "broken stdout"]);
    if (!hook.registered) throw new Error("expected stable MCP registration");
    // Was `toEqual([hook.registered.session_id])`. Re-stated, not dropped: a temporary session is
    // no longer deregistered on the way out (#140). Sending one would mean putting the current
    // bearer on the wire to an endpoint resolved at first registration, which a different-uid
    // process can take over once the daemon exits. Cleanup is the lease expiring (A2 §F08). The
    // registration itself is still asserted above, so this test still proves the session existed;
    // what changed is what happens to it at shutdown.
    expect(hook.deregistered).toEqual([]);
  });

  // #140. The real-process gate cannot prove this branch: when the budget wins there, the shim
  // exits anyway as its loop drains, so removing the branch changes nothing it can see. Injecting
  // the boundaries is what makes a deleted deadline a named red.
  test("#140 the shutdown budget ends the process when close() never settles", async () => {
    const exits: number[] = [];
    const outcome = await closeWithinBudget(
      () => new Promise<void>(() => {}),
      40,
      (code) => {
        exits.push(code);
      },
    );
    expect(outcome).toBe("expired");
    expect(exits).toEqual([0]);
  });

  test("#140 a close() that finishes inside the budget leaves the process alone", async () => {
    const exits: number[] = [];
    const outcome = await closeWithinBudget(
      async () => {},
      30_000,
      (code) => {
        exits.push(code);
      },
    );
    expect(outcome).toBe("closed");
    expect(exits).toEqual([]);
  });

  // A request that starts concurrently with `close()` must never do registration/heartbeat work.
  // `close()` sets its intake gate as its own synchronous first statement, so calling `close()`
  // without awaiting it already flips the gate before this test's next line runs — no timing or
  // fake delay is needed to land inside the shutdown window deterministically.
  test("#140 a request that starts after close() begins is rejected before any registration or heartbeat", async () => {
    const hook = new HookClient();
    const connected = await connect(deps(hook, { getMetadata: async () => null }));
    try {
      expect((await callTool(connected.client, { name: "glosa_metadata_show", arguments: {} })).isError).not.toBe(true);
      if (!hook.registered) throw new Error("expected the first call to register normally");
      const heartbeatsBefore = hook.heartbeats.length;

      const closing = connected.runtime.close();
      // The transport itself is also torn down by `close()`, concurrently, so the SDK may reject
      // the call outright rather than deliver a structured error result — either way is "rejected".
      const rejected = await callTool(connected.client, { name: "glosa_metadata_show", arguments: {} }).catch(
        () => ({ isError: true }) as CallToolResult,
      );
      await closing;

      expect(rejected.isError).toBe(true);
      expect(hook.heartbeats.length).toBe(heartbeatsBefore);
    } finally {
      await connected.client.close();
    }
  });

  // Distinct from the gate above: this proves `close()` tracks a request's WHOLE lifecycle, not
  // just its handler. A request stuck inside `ensureSession` (registering) never reaches its
  // handler at all, so a tracker that only adds a call once the handler starts would never see it
  // — `close()` would then resolve without ever having waited on it. `register()` here never
  // settles on purpose: `close()` must still be blocked on it well after a moment that would be
  // more than enough time to finish if it were not being waited on at all.
  // F-5. `close()` must CANCEL a stalled registration, not merely outlive it. Before the fix,
  // `ensureSession` built its client with `registrationAbort`, which does not fire when shutdown
  // starts, so a wedged register held graceful close open until the outer process-exit fallback —
  // the backstop doing the work the second shutdown step is supposed to do.
  // #140. Shutdown deliberately sends NOTHING to the daemon. The session is cleaned up by its
  // lease expiring, which A2 §F08 already defines as what happens when a transport goes away.
  // A `deregister` here would put the current bearer on the wire to an endpoint resolved at first
  // registration, and a port held that long is not an identity: after the daemon exits any local
  // process can take it, and the world-readable lock hands a different-uid process the instance id
  // to echo. The absence of this traffic IS the guarantee, so it is asserted rather than assumed.
  // #140. The last place a credential could leave at shutdown. `failAll` acknowledges every
  // still-pending delivery through the client that delivery arrived on — a previously-resolved
  // endpoint — and the only thing making that safe is that `close()` aborts `shutdownAbort` BEFORE
  // calling it, so the call fails locally instead of reaching the wire. Nothing pinned that
  // ordering, which meant reversing two lines in `close()` would have leaked silently.
  //
  // The response send is delayed so the acknowledgement genuinely lands DURING shutdown; without
  // that the reservation is consumed beforehand and this proves nothing.
  test("#140 an acknowledgement issued during shutdown finds its client already cancelled", async () => {
    const abortedWhenAcknowledged: boolean[] = [];
    const acks: string[] = [];

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const stalled = new Proxy(serverTransport, {
      get(target, prop, receiver) {
        // Delayed, not infinite: an infinite stall hangs `close()` before it ever reaches the
        // acknowledgement, so nothing would be recorded and the assertions below would be vacuous.
        // 200ms puts the acknowledgement squarely inside shutdown, which is the point.
        if (prop === "send")
          return (...args: unknown[]) =>
            Bun.sleep(200).then(() => (target.send as (...a: unknown[]) => Promise<void>)(...args));
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
      set(target, prop, value) {
        Reflect.set(target, prop, value);
        return true;
      },
    }) as typeof serverTransport;

    const runtime = createMcpServer({
      createHookClient: async (signal?: AbortSignal) => {
        // Default fixture: its `drained` already carries a top-level `delivery_id`, which is what
        // reserves the acknowledgement this test needs to still be in flight at shutdown.
        const client = new HookClient();
        client.acknowledge = async (_session, deliveryId) => {
          abortedWhenAcknowledged.push(signal?.aborted === true);
          acks.push(deliveryId);
        };
        return client;
      },
      createApiClient: async () => ({}) as GlosaApiClient,
      cwd: () => "/workspace",
    });
    await runtime.connect(stalled);
    const client = new Client({ name: "glosa-test", version: "1" }, { capabilities: {} });
    await client.connect(clientTransport);

    // Not awaited: its response is still in flight when shutdown starts, which is the case that
    // matters — an acknowledgement issued while the shim is closing.
    void client.callTool({ name: "glosa_inbox_pull", arguments: {} }).catch(() => {});
    await Bun.sleep(50);

    await runtime.close();
    await Bun.sleep(50); // let any acknowledgement racing the close actually land

    // It really did happen — otherwise this assertion would pass vacuously on an empty list.
    expect(acks).toEqual(["delivery-1"]);
    expect(abortedWhenAcknowledged.length).toBeGreaterThan(0);
    // And every such call found its client already cancelled, so none of them reached the wire.
    expect(abortedWhenAcknowledged.every(Boolean)).toBe(true);
  });

  test("#140 shutdown sends no deregistration — the session is left to its lease", async () => {
    const hook = new HookClient();
    const connected = await connect(deps(hook, { getMetadata: async () => null }));
    await callTool(connected.client, { name: "glosa_metadata_show", arguments: {} });
    expect(hook.registered).not.toBeNull();

    await connected.runtime.close();
    expect(hook.deregistered).toEqual([]);
  });

  test("#140 shutdown cancels a stalled registration rather than waiting out the outer deadline", async () => {
    const registerSignals: Array<AbortSignal | undefined> = [];
    const clientFor = (signal?: AbortSignal): HookClient => {
      const hook = new HookClient();
      hook.register = () => {
        registerSignals.push(signal);
        // Settles only when the signal it was handed aborts. Given no signal, or one that never
        // fires, it hangs — which is precisely the ablated behaviour.
        return new Promise<{ workspace: string }>((_resolve, reject) => {
          if (!signal) return;
          if (signal.aborted) return reject(new Error("registration aborted"));
          signal.addEventListener("abort", () => reject(new Error("registration aborted")), { once: true });
        });
      };
      return hook;
    };
    const connected = await connect({
      createHookClient: async (signal?: AbortSignal) => clientFor(signal),
      createApiClient: async () => ({ getMetadata: async () => null }) as unknown as GlosaApiClient,
      cwd: () => "/workspace",
    });
    const stuck = callTool(connected.client, { name: "glosa_metadata_show", arguments: {} });
    stuck.catch(() => {});
    await Bun.sleep(20);
    expect(registerSignals.length).toBeGreaterThan(0);

    // The wait is bounded HERE rather than left to the runner's own timeout: a test that dies on
    // its timeout reports "timed out", which names nothing and would be indistinguishable from an
    // unrelated hang. Racing it means the ablated build fails on the assertion below instead.
    const closing = connected.runtime.close();
    closing.catch(() => {});
    const started = Date.now();
    const closedInTime = await Promise.race([closing.then(() => true), Bun.sleep(1_000).then(() => false)]);
    const elapsedMs = Date.now() - started;
    // Comfortably under the outer budget: passing by reaching MCP_SHUTDOWN_BUDGET_MS would mean
    // the fallback rescued it, which is the defect rather than the fix.
    expect(closedInTime).toBe(true);
    expect(elapsedMs).toBeLessThan(1_000);
    expect(MCP_SHUTDOWN_BUDGET_MS).toBeGreaterThan(1_000);
  });

  test("#140 close() waits for a request's whole lifecycle, registration included, not just its handler", async () => {
    const hook = new HookClient();
    hook.register = () => new Promise<{ workspace: string }>(() => {});
    const connected = await connect(deps(hook, { getMetadata: async () => null }));
    const stuck = callTool(connected.client, { name: "glosa_metadata_show", arguments: {} });
    stuck.catch(() => {});
    // Give the SDK's own dispatch a moment to actually invoke the wrapped handler.
    await Bun.sleep(20);

    const closing = connected.runtime.close();
    closing.catch(() => {});
    const closedQuickly = await Promise.race([closing.then(() => true), Bun.sleep(200).then(() => false)]);
    expect(closedQuickly).toBe(false);
  });

  // A real-process race between a terminal signal and `runMcpServer`'s first `await` (`connect()`)
  // is unfalsifiable at any safe test timing: `connect()` itself does no real I/O and returns in
  // well under a millisecond (verified empirically while building this test), so no delay chosen
  // to reliably clear Bun's own ~150-200ms module-loading startup — which no code-level fix here
  // can shorten — can also land inside that sub-millisecond window. The ordering is instead
  // verified directly: `runMcpServer`'s synchronous prefix (installing the SIGHUP listener, and
  // everything before it) runs to completion before the function's first `await` ever yields
  // control back here, so checking it immediately after calling `runMcpServer` — without awaiting
  // — observes exactly what has run before `connect()` could possibly have started.
  test("#140 the SIGHUP listener is installed before runMcpServer's first await", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const before = process.listenerCount("SIGHUP");
    const running = runMcpServer(deps(new HookClient()), { stdin: input, stdout: output });
    expect(process.listenerCount("SIGHUP")).toBe(before + 1);
    // Invoke only the listener this call just registered — never `process.emit`, which fires
    // every OTHER SIGHUP listener already registered on this shared process too, including (in a
    // full run alongside the real-subprocess suite) `daemon/test/helpers.ts`'s own crash-cleanup
    // handler, which calls `process.exit()` and would take the whole test run down with it.
    const ourHandler = process.listeners("SIGHUP").at(-1) as () => void;
    ourHandler();
    await running;
    expect(process.listenerCount("SIGHUP")).toBe(before);
  });

  // Same reasoning as the SIGHUP listener check above, for the parent-poll's own setup: its
  // `setInterval` call is part of the same synchronous prefix, so it has already run by the time
  // this line executes without having awaited `runMcpServer` yet. Also checks the matching
  // cleanup: neither the listener nor the interval may be a reason the process stays alive, so
  // both must be torn down again once shutdown completes — an uncleared SIGHUP listener would
  // accumulate across every one of this file's other `runMcpServer` calls.
  test("#140 the parent-poll interval is created before runMcpServer's first await, and both it and the SIGHUP listener are torn down on exit", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const intervalSpy = spyOn(globalThis, "setInterval");
    const clearSpy = spyOn(globalThis, "clearInterval");
    const listenersBefore = process.listenerCount("SIGHUP");
    try {
      const callsBefore = intervalSpy.mock.calls.length;
      const running = runMcpServer(deps(new HookClient()), { stdin: input, stdout: output });
      expect(intervalSpy.mock.calls.length).toBe(callsBefore + 1);
      input.end();
      await running;
      expect(clearSpy).toHaveBeenCalled();
      expect(process.listenerCount("SIGHUP")).toBe(listenersBefore);
    } finally {
      intervalSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });

  test("stdio server exits cleanly when its input reaches EOF", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const running = runMcpServer(deps(new HookClient()), { stdin: input, stdout: output });
    input.end();
    await expect(running).resolves.toBeUndefined();
  });

  describe("glosa_ask — the blocking half, exercised through the real SDK", () => {
    /** An api-client double whose entry-status honours `wait_ms` the way the daemon does: it does
     * not answer until the answer exists. Anything that turned the wait back into a poll, or
     * dropped the wait entirely, shows up here as the wrong outcome. */
    function askApi(answerAfterCalls: number, detail: Record<string, unknown> | null) {
      const calls: Array<{ waitMs?: number }> = [];
      const api: Partial<GlosaApiClient> = {
        createAttentionRequest: async (_path, opts) => {
          created.push(opts as Record<string, unknown>);
          return { id: "inb-1", slug: "ws-1", status: "open" };
        },
        getEntryStatus: async (_path, _entry, waitMs) => {
          calls.push({ waitMs });
          const open = { id: "inb-1", kind: "attention", status: "open", detail: null };
          if (calls.length < answerAfterCalls || detail === null) return open as EntryStatus;
          return { id: "inb-1", kind: "attention", status: "done", detail } as unknown as EntryStatus;
        },
      };
      const created: Array<Record<string, unknown>> = [];
      return { api, calls, created };
    }

    test("an answered question returns the human's words and their chosen option", async () => {
      const { api, calls, created } = askApi(1, { outcome: "done", response: "Thin — say why.", chose: "thin" });
      const connected = await connect(deps(new HookClient(), api));
      try {
        const result = await callTool(connected.client, {
          name: "glosa_ask",
          arguments: {
            path: "notes.md",
            question: "Is argument X covered enough?",
            quote: { exact: "the premise readers accept" },
            options: ["covered", "thin"],
            label: "api-refactor",
            wait_seconds: 30,
          },
        });
        expect(result.isError).not.toBe(true);
        expect(structured(result)).toMatchObject({
          id: "inb-1",
          outcome: "answered",
          answer: "Thin — say why.",
          chose: "thin",
          anchored: true,
        });
        // The passage, the label and the options reached the daemon as sent.
        expect(created[0]).toMatchObject({
          agentLabel: "api-refactor",
          target: { quote: { exact: "the premise readers accept" } },
          answerOptions: ["covered", "thin"],
        });
        // And it WAITED — a wait_ms was actually passed, rather than the tool polling a bare read.
        expect(calls[0]?.waitMs).toBeGreaterThan(0);
      } finally {
        await connected.close();
      }
    });

    test("an empty answer is 'declined', never reported as an answer the human did not give", async () => {
      const { api } = askApi(1, { outcome: "done", response: "" });
      const connected = await connect(deps(new HookClient(), api));
      try {
        const result = await callTool(connected.client, {
          name: "glosa_ask",
          arguments: { path: "notes.md", question: "Ready?", wait_seconds: 5 },
        });
        expect(structured(result)).toMatchObject({ outcome: "declined" });
      } finally {
        await connected.close();
      }
    });

    test("a wait that elapses is 'unanswered' — distinct from declined, because nobody saw it", async () => {
      // Never goes terminal, and the deadline is immediate.
      const { api } = askApi(1, null);
      const connected = await connect(deps(new HookClient(), api));
      try {
        const result = await callTool(connected.client, {
          name: "glosa_ask",
          arguments: { path: "notes.md", question: "Ready?", wait_seconds: 0 },
        });
        expect(result.isError).not.toBe(true);
        // Collapsing this into "declined" would have the agent report a refusal from a human who
        // was never there.
        expect(structured(result)).toMatchObject({ id: "inb-1", outcome: "unanswered" });
      } finally {
        await connected.close();
      }
    });

    test("a pointer with no question returns at once and never waits", async () => {
      const { api, calls, created } = askApi(1, null);
      const connected = await connect(deps(new HookClient(), api));
      try {
        const result = await callTool(connected.client, {
          name: "glosa_ask",
          arguments: { path: "notes.md", quote: { exact: "the premise readers accept" } },
        });
        expect(structured(result)).toMatchObject({ id: "inb-1", outcome: "posted" });
        // No status was ever read: pointing is a side effect, not a request for something back.
        expect(calls).toHaveLength(0);
        expect(created[0]).toMatchObject({ action: "point" });
      } finally {
        await connected.close();
      }
    });

    test("a question is action 'ask', so answering it asserts no verdict nobody gave", async () => {
      const { api, created } = askApi(1, { outcome: "done", response: "Fine." });
      const connected = await connect(deps(new HookClient(), api));
      try {
        await callTool(connected.client, {
          name: "glosa_ask",
          arguments: { path: "notes.md", question: "Ready?", wait_seconds: 5 },
        });
        // `review` would force approved|changes_requested, and neither is true of "the human
        // answered a question".
        expect(created[0]).toMatchObject({ action: "ask" });
      } finally {
        await connected.close();
      }
    });
  });

  test("glosa_present preview returns a p= URL without binding, never launches a browser, never returns durable t=", async () => {
    const mkdtemp = await import("node:fs").then((fs) => fs.mkdtempSync);
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { writeFileSync, rmSync } = await import("node:fs");
    const dir = mkdtemp(join(tmpdir(), "glosa-present-"));
    const file = join(dir, "note.md");
    writeFileSync(file, "# hi\n");
    try {
      const calls: string[] = [];
      const api: Partial<GlosaApiClient> = {
        port: 4646,
        openWorkspace: async (path) => {
          calls.push(`open:${path}`);
          return { slug: "note-abc", path: dir, focus: "note.md", kind: "loose-file", state_dir: join(dir, "state") };
        },
        mintPresentationToken: async () => {
          calls.push("mint");
          return { token: "ephemeral-present-token", expires_in_s: 60 };
        },
        bindSession: async (path, sessionId) => {
          calls.push(`bind:${path}:${sessionId}`);
          return { bound: true, session_id: sessionId };
        },
      };
      const connected = await connect({
        ...deps(new HookClient(), api),
        sessionId: () => "host-session",
      });
      try {
        const result = await callTool(connected.client, {
          name: "glosa_present",
          arguments: { path: file, mode: "read", session_id: "host-session" },
        });
        expect(result.isError).not.toBe(true);
        const body = structured(result) as {
          url: string;
          preview: boolean;
          surface: string;
          mode: string;
          bound_session?: string;
          warnings?: Array<{ code: string; message: string }>;
        };
        expect(body.url).toContain("p=ephemeral-present-token");
        expect(body.url).toContain("lock=read");
        expect(body.url).not.toContain("t=");
        expect(body.preview).toBe(true);
        expect(body.surface).toBe("document");
        expect(body.mode).toBe("read");
        expect(body.bound_session).toBeUndefined();
        expect(body.warnings?.some((w) => w.code === "bind-failed")).not.toBe(true);
        expect(body.warnings?.some((w) => w.code === "preview-bind-conflict")).not.toBe(true);
        expect(calls.some((c) => c.startsWith("open:"))).toBe(true);
        expect(calls).toContain("mint");
        expect(calls.some((c) => c.startsWith("bind:"))).toBe(false);
      } finally {
        await connected.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("glosa_present annotate binds the host session and returns bound_session", async () => {
    const mkdtemp = await import("node:fs").then((fs) => fs.mkdtempSync);
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { writeFileSync, rmSync } = await import("node:fs");
    const dir = mkdtemp(join(tmpdir(), "glosa-present-annotate-"));
    const file = join(dir, "note.md");
    writeFileSync(file, "# hi\n");
    try {
      const calls: string[] = [];
      const api: Partial<GlosaApiClient> = {
        port: 4646,
        openWorkspace: async (path) => {
          calls.push(`open:${path}`);
          return { slug: "note-abc", path: dir, focus: "note.md", kind: "loose-file" };
        },
        mintPresentationToken: async () => {
          calls.push("mint");
          return { token: "ephemeral-annotate-token", expires_in_s: 60 };
        },
        bindSession: async (path, sessionId) => {
          calls.push(`bind:${path}:${sessionId}`);
          return { bound: true, session_id: sessionId };
        },
      };
      const connected = await connect({
        ...deps(new HookClient(), api),
        sessionId: () => "host-session",
      });
      try {
        const result = await callTool(connected.client, {
          name: "glosa_present",
          arguments: { path: file, mode: "review" },
        });
        expect(result.isError).not.toBe(true);
        const body = structured(result) as {
          url: string;
          mode: string;
          preview: boolean;
          bound_session?: string;
        };
        expect(body.url).toContain("p=ephemeral-annotate-token");
        expect(body.url).not.toContain("lock=read");
        expect(body.mode).toBe("review");
        expect(body.preview).toBe(false);
        expect(body.bound_session).toBe("host-session");
        expect(calls.some((c) => c.startsWith("bind:"))).toBe(true);
      } finally {
        await connected.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

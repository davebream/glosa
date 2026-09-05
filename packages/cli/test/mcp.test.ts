// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
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
import { createMcpServer, GLOSA_MCP_TOOL_NAMES, type GlosaMcpServer, type McpDeps, runMcpServer } from "../src/mcp.ts";
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
  ) {
    if (this.push) return this.push(sessionId, onEntry, signal);
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

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
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
      expect(hook.heartbeats).toEqual(["s1"]);
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
      expect(hook.registered).toMatchObject({ provider: "mcp", cwd: "/workspace", source: "mcp_pull" });
      expect(events).toEqual(["write", "presented"]);
      expect(hook.deliveryAcks[0]?.slice(1, 3)).toEqual(["delivery-1", "presented"]);
      if (!hook.registered) throw new Error("expected temporary MCP registration");
      expect(hook.deregistered).toEqual([hook.registered.session_id]);
    } finally {
      await connected.close();
    }
  });

  test("transport write failure records failed and cleans up the temporary MCP session", async () => {
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
      if (!hook.registered) throw new Error("expected temporary MCP registration");
      expect(hook.deregistered).toEqual([hook.registered.session_id]);
    } finally {
      await connected.close();
    }
  });

  test("get retrieves the durable entry directly without registering or draining", async () => {
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
      expect(hook.registered).toBeNull();
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
    if (!hook.registered) throw new Error("expected temporary MCP registration");
    expect(hook.deregistered).toEqual([hook.registered.session_id]);
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
          arguments: { path: file, mode: "read", session_id: "explicit-session" },
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

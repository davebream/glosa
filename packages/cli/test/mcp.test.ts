// SPDX-License-Identifier: Apache-2.0
import { describe, expect, spyOn, test } from "bun:test";
import { PassThrough, Writable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { type CallToolResult, LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import type { EntryStatus, GlosaApiClient } from "../src/api-client.ts";
import { apiError } from "../src/api-client.ts";
import type { DaemonClient, DrainResult, RegisterSessionInput, ScopedPullDrainOptions } from "../src/daemon-client.ts";
import {
  closeWithinBudget,
  createMcpServer,
  GLOSA_MCP_TOOL_NAMES,
  type GlosaMcpServer,
  MCP_SHUTDOWN_BUDGET_MS,
  type McpDeps,
  runMcpServer,
} from "../src/mcp.ts";
import {
  inboxGetInputSchema,
  inboxPresentationSchema,
  inboxPullInputSchema,
  metadataClearInputSchema,
  metadataSetInputSchema,
  metadataShowInputSchema,
  sessionBindInputSchema,
  watchInputSchema,
  workspaceMetadataDescriptorSchema,
} from "../src/mcp-schemas.ts";
import { discoverMcpIdentity } from "../src/session.ts";
import { CLI_VERSION } from "../src/version.ts";

test("MCP host discovery rejects ambiguous providers and permits explicit selection", () => {
  const claude = { session_id: "a", provider: "claude-code", cwd: "/agent" };
  const codex = { session_id: "b", provider: "codex", cwd: "/agent" };
  expect(() => discoverMcpIdentity([claude, codex])).toThrow("multiple provider");
  expect(discoverMcpIdentity([claude, codex], "codex")).toEqual(codex);
  expect(() => discoverMcpIdentity([codex], "claude-code")).toThrow("provider does not match");
  expect(discoverMcpIdentity([null], "codex")).toBeNull();
});

test("generic pull preserves requested workspace scope while reusing its stable identity", async () => {
  const hook = new FakeDaemonClient();
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
  const hook = new FakeDaemonClient();
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

class FakeDaemonClient implements DaemonClient {
  registered: RegisterSessionInput | null = null;
  drained: DrainResult = {
    delivery_id: "delivery-1",
    count: 1,
    drained: [presentation("inb-1", "annotation", "glosa annotation inb-1\ncomment:\nAct on this.")],
  };
  drainOptions: unknown;
  scopedDrainOptions: unknown;
  heartbeats: string[] = [];
  deregistered: string[] = [];
  deliveryAcks: Array<[string, string, "presented" | "failed", string?]> = [];
  pushedAcks: Array<[string, string, "presented" | "failed"]> = [];

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

  async drainScoped(_sessionId: string, options: ScopedPullDrainOptions) {
    this.scopedDrainOptions = options;
    return this.drained;
  }

  async acknowledge(sessionId: string, deliveryId: string, outcome: "presented" | "failed", error?: string) {
    this.deliveryAcks.push([sessionId, deliveryId, outcome, error]);
  }

  async acknowledgePushed(sessionId: string, entryId: string, outcome: "presented" | "failed") {
    this.pushedAcks.push([sessionId, entryId, outcome]);
  }
}

function deps(hook: FakeDaemonClient, api?: Partial<GlosaApiClient>): McpDeps {
  return {
    createDaemonClient: async () => hook,
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
  test("SDK initialization advertises latest protocol, no Channel capability, instructions, and package version", async () => {
    const connected = await connect(deps(new FakeDaemonClient()));
    try {
      expect(LATEST_PROTOCOL_VERSION).toBe("2025-11-25");
      expect(connected.client.getServerVersion()).toEqual({ name: "glosa", version: CLI_VERSION });
      expect(connected.client.getServerCapabilities()).toMatchObject({ tools: { listChanged: true } });
      // #152: Channels are gone. The shim must not advertise the experimental capability, or a
      // Claude session would negotiate a push rail nobody serves.
      expect(connected.client.getServerCapabilities()?.experimental).toBeUndefined();
      expect(connected.client.getInstructions()).toContain("glosa_delivery_ack");
      expect(connected.client.getInstructions()).not.toContain("glosa_conversation_ack");
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

    const running = runMcpServer(deps(new FakeDaemonClient()), { stdin: input, stdout: output });
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

  test("tools/list is SDK-generated from the ten Zod registrations", async () => {
    const connected = await connect(deps(new FakeDaemonClient()));
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
        schema: watchInputSchema,
        valid: [
          {},
          { workspace: "/w" },
          { path: "draft.md" },
          { since: "a".repeat(40), wait_ms: 900_000 },
          { session_id: "s1", wait_ms: 0 },
        ],
        invalid: [
          { wait_ms: -1 },
          { wait_ms: 900_001 },
          { wait_ms: 1.5 },
          { since: "not-a-sha" },
          { since: "a".repeat(39) },
          { workspace: 1 },
          { extra: true },
        ],
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
    const hook = new FakeDaemonClient();
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
        ["glosa_delivery_ack", { entry_id: "e-1", session_id: "other-session" }],
        ["glosa_watch", { session_id: "other-session" }],
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
    const hook = new FakeDaemonClient();
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

  test("monitor delivery acknowledgement uses the exact MCP host session", async () => {
    const hook = new FakeDaemonClient();
    const connected = await connect({ ...deps(hook), sessionId: () => "claude-session-1" });
    try {
      const result = await callTool(connected.client, {
        name: "glosa_delivery_ack",
        arguments: { entry_id: "entry-1" },
      });
      expect(result.isError).not.toBe(true);
      expect(structured(result)).toEqual({ entry_id: "entry-1", presented: true });
      expect(hook.pushedAcks).toEqual([["claude-session-1", "entry-1", "presented"]]);
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
    const hook = new FakeDaemonClient();
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

  test("a Codex bind starts one exact-thread attachment and MCP close aborts it", async () => {
    const hook = new FakeDaemonClient();
    const attached: unknown[] = [];
    let attachAborted = false;
    const api: Partial<GlosaApiClient> = {
      bindSession: async (_workspace, sessionId) => ({ bound: true, session_id: sessionId }),
    };
    const connected = await connect({
      ...deps(hook, api),
      startCodexAttachment: async (options, signal) => {
        attached.push(options);
        await new Promise<void>((resolve) =>
          signal.addEventListener(
            "abort",
            () => {
              attachAborted = true;
              resolve();
            },
            { once: true },
          ),
        );
      },
    });
    const result = await callTool(connected.client, {
      name: "glosa_session_bind",
      arguments: { workspace: "/review", session_id: "thread-exact", provider: "codex" },
    });
    expect(result.isError).not.toBe(true);
    expect(attached).toEqual([{ sessionId: "thread-exact", workspace: "/review", cwd: "/workspace" }]);
    const pulled = await callTool(connected.client, {
      name: "glosa_inbox_pull",
      arguments: { workspace: "/review" },
    });
    expect(pulled.isError).not.toBe(true);
    expect(hook.registered?.session_id).toBe("thread-exact");
    const acknowledged = await callTool(connected.client, {
      name: "glosa_delivery_ack",
      arguments: { entry_id: "entry-1" },
    });
    expect(acknowledged.isError).not.toBe(true);
    expect(hook.pushedAcks.at(-1)).toEqual(["thread-exact", "entry-1", "presented"]);
    await connected.close();
    expect(attachAborted).toBe(true);
  });

  test("pull keeps actionable text and acknowledges only after the SDK transport write", async () => {
    const hook = new FakeDaemonClient();
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
    const hook = new FakeDaemonClient();
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
    const hook = new FakeDaemonClient();
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

  test("the tool inventory carries no Channel-era tool (#152)", async () => {
    const connected = await connect(deps(new FakeDaemonClient()));
    try {
      const names = (await connected.client.listTools()).tools.map((tool) => tool.name);
      expect(names).not.toContain("glosa_conversation_ack");
      expect(names).toContain("glosa_delivery_ack");
      expect([...GLOSA_MCP_TOOL_NAMES]).not.toContain("glosa_conversation_ack");
    } finally {
      await connected.close();
    }
  });

  test("stdio write failure records failed before the temporary session is cleaned up", async () => {
    const hook = new FakeDaemonClient();
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
    const hook = new FakeDaemonClient();
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
      createDaemonClient: async (signal?: AbortSignal) => {
        // Default fixture: its `drained` already carries a top-level `delivery_id`, which is what
        // reserves the acknowledgement this test needs to still be in flight at shutdown.
        const client = new FakeDaemonClient();
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
    const hook = new FakeDaemonClient();
    const connected = await connect(deps(hook, { getMetadata: async () => null }));
    await callTool(connected.client, { name: "glosa_metadata_show", arguments: {} });
    expect(hook.registered).not.toBeNull();

    await connected.runtime.close();
    expect(hook.deregistered).toEqual([]);
  });

  test("#140 shutdown cancels a stalled registration rather than waiting out the outer deadline", async () => {
    const registerSignals: Array<AbortSignal | undefined> = [];
    const clientFor = (signal?: AbortSignal): FakeDaemonClient => {
      const hook = new FakeDaemonClient();
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
      createDaemonClient: async (signal?: AbortSignal) => clientFor(signal),
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
    const hook = new FakeDaemonClient();
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
    const running = runMcpServer(deps(new FakeDaemonClient()), { stdin: input, stdout: output });
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
      const running = runMcpServer(deps(new FakeDaemonClient()), { stdin: input, stdout: output });
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
    const running = runMcpServer(deps(new FakeDaemonClient()), { stdin: input, stdout: output });
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
      const connected = await connect(deps(new FakeDaemonClient(), api));
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
      const connected = await connect(deps(new FakeDaemonClient(), api));
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
      const connected = await connect(deps(new FakeDaemonClient(), api));
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
      const connected = await connect(deps(new FakeDaemonClient(), api));
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
      const connected = await connect(deps(new FakeDaemonClient(), api));
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
        ...deps(new FakeDaemonClient(), api),
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
        ...deps(new FakeDaemonClient(), api),
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

  describe("glosa_watch — the held read half, exercised through the real SDK (#153 Part 2)", () => {
    function externalEditPresentation(id: string, text = `glosa external_edit ${id}\nhunk`) {
      return {
        id,
        workspace: "/workspace",
        kind: "external_edit" as const,
        status: "pending",
        text,
        bytes: Buffer.byteLength(text, "utf8"),
        detail: { path: "draft.md", since_checkpoint: "a".repeat(40), until_checkpoint: "b".repeat(40) },
        truncation: { truncated: false, omitted_bytes: 0, omitted_hunks: 0 },
        retrieval: { command: `glosa inbox get ${id}`, mcp_tool: "glosa_inbox_get" as const },
      };
    }

    test("resolves session identity like other session tools: the MCP host session is used, and an explicit one is honoured with no host bound", async () => {
      const hook = new FakeDaemonClient();
      const seen: Array<{ session: string; opts?: unknown }> = [];
      const api: Partial<GlosaApiClient> = {
        watch: async (_path, session, opts) => {
          seen.push({ session, opts });
          return { entries: [], latest_checkpoint: null, has_more: false };
        },
      };
      const withHost = await connect({ ...deps(hook, api), sessionId: () => "host-session" });
      try {
        const result = await callTool(withHost.client, { name: "glosa_watch", arguments: {} });
        expect(result.isError).not.toBe(true);
        expect(seen[0]?.session).toBe("host-session");
      } finally {
        await withHost.close();
      }

      const withoutHost = await connect(deps(hook, api));
      try {
        const result = await callTool(withoutHost.client, {
          name: "glosa_watch",
          arguments: { session_id: "explicit-session" },
        });
        expect(result.isError).not.toBe(true);
        expect(seen[1]?.session).toBe("explicit-session");
      } finally {
        await withoutHost.close();
      }
    });

    test("requires an explicit session_id when the MCP host provides no session identity", async () => {
      const hook = new FakeDaemonClient();
      const connected = await connect(deps(hook, {}));
      try {
        const result = await callTool(connected.client, { name: "glosa_watch", arguments: {} });
        expect(result.isError).toBe(true);
        expect(result.content).toEqual([
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining("requires an explicit session_id"),
          }),
        ]);
      } finally {
        await connected.close();
      }
    });

    test("returns {entries, latest_checkpoint, has_more} and forwards path/since/wait_ms to the daemon call", async () => {
      const hook = new FakeDaemonClient();
      const calls: unknown[] = [];
      const api: Partial<GlosaApiClient> = {
        watch: async (path, session, opts) => {
          calls.push([path, session, opts]);
          return {
            entries: [externalEditPresentation("inb-ext-1")],
            latest_checkpoint: "c".repeat(40),
            has_more: true,
          };
        },
        watchTransportAck: async () => ({ accepted: ["inb-ext-1"] }),
      };
      const connected = await connect({ ...deps(hook, api), sessionId: () => "host-session" });
      try {
        const result = await callTool(connected.client, {
          name: "glosa_watch",
          arguments: { workspace: "/target", path: "draft.md", since: "a".repeat(40), wait_ms: 5000 },
        });
        expect(result.isError).not.toBe(true);
        expect(calls).toEqual([["/target", "host-session", { path: "draft.md", since: "a".repeat(40), waitMs: 5000 }]]);
        expect(structured(result)).toEqual({
          entries: [externalEditPresentation("inb-ext-1")],
          latest_checkpoint: "c".repeat(40),
          has_more: true,
        });
        expect(result.content[0]).toEqual(
          expect.objectContaining({ type: "text", text: expect.stringContaining("inb-ext-1") }),
        );
      } finally {
        await connected.close();
      }
    });

    test("an empty result names no new external edits and asks for no transport-ack", async () => {
      const hook = new FakeDaemonClient();
      let transportAckCalls = 0;
      const api: Partial<GlosaApiClient> = {
        watch: async () => ({ entries: [], latest_checkpoint: null, has_more: false }),
        watchTransportAck: async (session, entryIds) => {
          transportAckCalls++;
          return { accepted: entryIds };
        },
      };
      const connected = await connect({ ...deps(hook, api), sessionId: () => "host-session" });
      try {
        const result = await callTool(connected.client, { name: "glosa_watch", arguments: {} });
        expect(result.isError).not.toBe(true);
        expect(result.content[0]).toEqual({ type: "text", text: "glosa watch: no new external edits" });
        expect(transportAckCalls).toBe(0);
      } finally {
        await connected.close();
      }
    });

    test("transport acceptance is recorded once the HTTP body reaches the shim, and presented only after the SDK writes the response", async () => {
      const hook = new FakeDaemonClient();
      const events: string[] = [];
      const api: Partial<GlosaApiClient> = {
        watch: async () => {
          events.push("watch");
          return { entries: [externalEditPresentation("inb-ext-1")], latest_checkpoint: null, has_more: false };
        },
        watchTransportAck: async (_session, entryIds) => {
          events.push("transport-ack");
          return { accepted: entryIds };
        },
        watchAck: async (_session, _entryIds, outcome) => {
          events.push(outcome ?? "presented");
          return { accepted: ["inb-ext-1"] };
        },
      };
      const connected = await connect({ ...deps(hook, api), sessionId: () => "host-session" });
      const send = connected.serverTransport.send.bind(connected.serverTransport);
      connected.serverTransport.send = async (message, options) => {
        await send(message, options);
        if (
          "result" in message &&
          typeof message.result === "object" &&
          message.result &&
          "content" in message.result
        ) {
          events.push("write");
        }
      };
      try {
        await callTool(connected.client, { name: "glosa_watch", arguments: {} });
        await waitFor(() => events.includes("presented"), "post-write watch acknowledgement");
        // transport-ack happens right after the daemon call resolves — BEFORE the SDK write —
        // and `presented` only after it, mirroring `DeliveryAwareTransport`'s own boundary.
        expect(events).toEqual(["watch", "transport-ack", "write", "presented"]);
      } finally {
        await connected.close();
      }
    });

    test("a failed stdout write records failed, not presented", async () => {
      const hook = new FakeDaemonClient();
      const acks: Array<[string, string]> = [];
      const api: Partial<GlosaApiClient> = {
        watch: async () => ({
          entries: [externalEditPresentation("inb-ext-1")],
          latest_checkpoint: null,
          has_more: false,
        }),
        watchTransportAck: async (_session, entryIds) => ({ accepted: entryIds }),
        watchAck: async (session, _entryIds, outcome) => {
          acks.push([session, outcome ?? "presented"]);
          return { accepted: ["inb-ext-1"] };
        },
      };
      const connected = await connect({ ...deps(hook, api), sessionId: () => "host-session" });
      const send = connected.serverTransport.send.bind(connected.serverTransport);
      connected.serverTransport.send = async (message, options) => {
        if (
          "result" in message &&
          typeof message.result === "object" &&
          message.result &&
          "content" in message.result
        ) {
          throw new Error("stdout unavailable");
        }
        await send(message, options);
      };
      try {
        void callTool(connected.client, { name: "glosa_watch", arguments: {} }).catch(() => {});
        await waitFor(() => acks.length === 1, "failed watch acknowledgement");
        expect(acks[0]).toEqual(["host-session", "failed"]);
      } finally {
        await connected.close();
      }
    });

    test("#140 a watch acknowledgement issued during shutdown finds its client already cancelled", async () => {
      // Same technique as the drain-delivery equivalent above: delay the transport's own `send`
      // so the tool response is still in flight when shutdown starts, putting the watch
      // acknowledgement squarely inside `close()`'s `failAll` rather than racing to beat it.
      const abortedWhenAcknowledged: boolean[] = [];
      const acks: string[] = [];

      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const stalled = new Proxy(serverTransport, {
        get(target, prop, receiver) {
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
        createDaemonClient: async () => new FakeDaemonClient(),
        createApiClient: async (signal?: AbortSignal) => {
          const api: Partial<GlosaApiClient> = {
            watch: async () => ({
              entries: [externalEditPresentation("inb-ext-1")],
              latest_checkpoint: null,
              has_more: false,
            }),
            watchTransportAck: async (_session, entryIds) => ({ accepted: entryIds }),
            watchAck: async (_session, _entryIds, outcome) => {
              abortedWhenAcknowledged.push(signal?.aborted === true);
              acks.push(outcome ?? "presented");
              return { accepted: ["inb-ext-1"] };
            },
          };
          return api as GlosaApiClient;
        },
        sessionId: () => "host-session",
        cwd: () => "/workspace",
      });
      await runtime.connect(stalled);
      const client = new Client({ name: "glosa-test", version: "1" }, { capabilities: {} });
      await client.connect(clientTransport);

      void client.callTool({ name: "glosa_watch", arguments: {} }).catch(() => {});
      await Bun.sleep(50);

      await runtime.close();
      await Bun.sleep(50); // let any acknowledgement racing the close actually land

      expect(acks).toEqual(["failed"]);
      expect(abortedWhenAcknowledged.length).toBeGreaterThan(0);
      expect(abortedWhenAcknowledged.every(Boolean)).toBe(true);
    });

    test("cancelling the MCP request aborts the held watch itself, not just the acknowledgement", async () => {
      // Review round 6: the API client was built from the shutdown signal alone, so the request's
      // own cancellation was not observed until the acknowledgement was reserved — after both the
      // held GET and the transport ack had already run. A watch can hold for fifteen minutes, so a
      // cancelled request would leave the daemon holding it for the full budget.
      let watchSawAbort = false;
      const runtime = createMcpServer({
        createDaemonClient: async () => new FakeDaemonClient(),
        createApiClient: async (signal?: AbortSignal) => {
          const api: Partial<GlosaApiClient> = {
            watch: () =>
              new Promise((_resolve, reject) => {
                if (!signal) return; // ablated: request cancellation never reaches the watch
                const end = () => {
                  watchSawAbort = true;
                  reject(new Error("watch aborted"));
                };
                if (signal.aborted) return end();
                signal.addEventListener("abort", end, { once: true });
              }),
          };
          return api as GlosaApiClient;
        },
        sessionId: () => "host-session",
        cwd: () => "/workspace",
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await runtime.connect(serverTransport);
      const client = new Client({ name: "glosa-test", version: "1" }, { capabilities: {} });
      await client.connect(clientTransport);

      const cancel = new AbortController();
      const held = client
        .callTool({ name: "glosa_watch", arguments: { wait_ms: 900000 } }, undefined, { signal: cancel.signal })
        .catch(() => "cancelled");
      await Bun.sleep(50);
      expect(watchSawAbort).toBe(false); // genuinely still held

      cancel.abort();
      await held;
      await Bun.sleep(20);

      expect(watchSawAbort).toBe(true);
      await runtime.close();
    }, 10_000);

    test("criterion 6 — closing the MCP runtime aborts a watch that is still being HELD", async () => {
      // The test above proves what happens to an acknowledgement during shutdown; it cannot prove
      // this, because its fake `watch()` returns immediately (review round 4). A held watch is the
      // whole point of the route — it can sit for up to fifteen minutes — so the thing that has to
      // be pinned is that `close()` ends one that has not returned. This fake therefore settles
      // ONLY when the signal it was handed aborts, which is also what makes the ablation bite: take
      // the signal away and this test hangs to its timeout instead of passing.
      let sawAbort = false;
      const runtime = createMcpServer({
        createDaemonClient: async () => new FakeDaemonClient(),
        createApiClient: async (signal?: AbortSignal) => {
          const api: Partial<GlosaApiClient> = {
            watch: () =>
              new Promise((_resolve, reject) => {
                if (!signal) return; // ablated: nothing ever ends this hold
                const end = () => {
                  sawAbort = true;
                  reject(new Error("watch aborted"));
                };
                if (signal.aborted) return end();
                signal.addEventListener("abort", end, { once: true });
              }),
          };
          return api as GlosaApiClient;
        },
        sessionId: () => "host-session",
        cwd: () => "/workspace",
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await runtime.connect(serverTransport);
      const client = new Client({ name: "glosa-test", version: "1" }, { capabilities: {} });
      await client.connect(clientTransport);

      const held = client.callTool({ name: "glosa_watch", arguments: { wait_ms: 900000 } }).catch(() => "rejected");
      await Bun.sleep(50);
      expect(sawAbort).toBe(false); // genuinely still holding, not already finished

      await runtime.close();
      await held;

      expect(sawAbort).toBe(true);
    }, 10_000);
  });
});

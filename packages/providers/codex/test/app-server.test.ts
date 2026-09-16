// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeliverableEntry } from "@glosa/daemon";
import {
  CODEX_ATTACH_MAX_DELAY_MS,
  CODEX_ATTACH_MIN_DELAY_MS,
  CodexJsonRpcClient,
  codexAttachRetryDelay,
  runCodexAttachment,
  type CodexControlClient,
} from "../src/app-server.ts";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function serverFrame(message: string): Buffer<ArrayBufferLike> {
  const payload = Buffer.from(message);
  if (payload.byteLength >= 126) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.byteLength, 2);
    return Buffer.concat([header, payload]);
  }
  return Buffer.concat([Buffer.from([0x81, payload.byteLength]), payload]);
}

function decodeClientFrames(input: Buffer<ArrayBufferLike>): { messages: string[]; rest: Buffer<ArrayBufferLike> } {
  const messages: string[] = [];
  let offset = 0;
  while (input.byteLength - offset >= 2) {
    const second = input[offset + 1]!;
    let length = second & 0x7f;
    let header = 2;
    if (length === 126) {
      if (input.byteLength - offset < 4) break;
      length = input.readUInt16BE(offset + 2);
      header = 4;
    } else if (length === 127) {
      if (input.byteLength - offset < 10) break;
      length = Number(input.readBigUInt64BE(offset + 2));
      header = 10;
    }
    expect(second & 0x80).toBe(0x80);
    if (input.byteLength - offset < header + 4 + length) break;
    const mask = input.subarray(offset + header, offset + header + 4);
    const payload = Buffer.from(input.subarray(offset + header + 4, offset + header + 4 + length));
    for (let i = 0; i < payload.byteLength; i++) payload[i] = payload[i]! ^ mask[i % 4]!;
    if ((input[offset]! & 0x0f) === 0x1) messages.push(payload.toString("utf8"));
    offset += header + 4 + length;
  }
  return { messages, rest: input.subarray(offset) };
}

async function protocolPeer(onMessage: (message: Record<string, unknown>, socket: Socket) => void): Promise<{
  path: string;
  server: Server;
  connection: Promise<Socket>;
}> {
  const home = mkdtempSync(join(tmpdir(), "glosa-codex-peer-"));
  homes.push(home);
  const path = join(home, "control.sock");
  let resolveConnection!: (socket: Socket) => void;
  const connection = new Promise<Socket>((resolve) => {
    resolveConnection = resolve;
  });
  const server = createServer((socket) => {
    resolveConnection(socket);
    let input: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let upgraded = false;
    socket.on("data", (chunk) => {
      input = Buffer.concat([input, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
      if (!upgraded) {
        const boundary = input.indexOf("\r\n\r\n");
        if (boundary < 0) return;
        const header = input.subarray(0, boundary).toString("utf8");
        const key = header.match(/Sec-WebSocket-Key:\s*(.+)\r\n/i)?.[1]?.trim();
        if (!key) throw new Error("missing websocket key");
        const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        input = input.subarray(boundary + 4);
        upgraded = true;
      }
      const decoded = decodeClientFrames(input);
      input = decoded.rest;
      for (const message of decoded.messages) onMessage(JSON.parse(message), socket);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  return { path, server, connection };
}

const ENTRY: DeliverableEntry = {
  id: "entry-1",
  kind: "annotation",
  status: "pending",
  text: "Review this sentence.",
  bytes: 21,
  detail: { artifact_path: "notes.md" },
  truncation: { truncated: false, omitted_bytes: 0, omitted_hunks: 0 },
  retrieval: { command: "glosa inbox get entry-1", mcp_tool: "glosa_inbox_get" },
};

describe("Codex app-server protocol", () => {
  test("real masked WebSocket requests resume the exact thread, steer a known turn, then start while idle", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const peer = await protocolPeer((message, socket) => {
      requests.push(message);
      if (typeof message.id === "number") socket.write(serverFrame(JSON.stringify({ id: message.id, result: {} })));
    });
    try {
      const client = await CodexJsonRpcClient.connect(peer.path, AbortSignal.timeout(2_000));
      await client.resume("thread-exact");
      const socket = await peer.connection;
      socket.write(
        serverFrame(
          JSON.stringify({ method: "turn/started", params: { threadId: "thread-exact", turn: { id: "turn-1" } } }),
        ),
      );
      await Bun.sleep(10);
      await client.deliver("thread-exact", ENTRY);
      socket.write(
        serverFrame(
          JSON.stringify({ method: "turn/completed", params: { threadId: "thread-exact", turn: { id: "turn-1" } } }),
        ),
      );
      await Bun.sleep(10);
      await client.deliver("thread-exact", ENTRY);
      client.close();
      expect(requests.map((request) => request.method)).toEqual([
        "initialize",
        "initialized",
        "thread/resume",
        "turn/steer",
        "turn/start",
      ]);
      expect(requests[2]?.params).toEqual({ threadId: "thread-exact", excludeTurns: true });
      expect(requests[3]?.params).toMatchObject({ threadId: "thread-exact", expectedTurnId: "turn-1" });
      expect(requests[4]?.params).toMatchObject({ threadId: "thread-exact" });
      expect(requests[3]?.params).toEqual(
        expect.objectContaining({
          input: [expect.objectContaining({ type: "text", text: expect.stringContaining("[glosa entry-1]") })],
        }),
      );
    } finally {
      await new Promise<void>((resolve) => peer.server.close(() => resolve()));
    }
  });

  test("attachment registers the exact binding, pushes bounded input, acknowledges transport, and closes on abort", async () => {
    const controller = new AbortController();
    const registered: unknown[] = [];
    const delivered: DeliverableEntry[] = [];
    const acknowledgements: string[] = [];
    let closed = false;
    let finishClosed = () => {};
    const control: CodexControlClient = {
      resume: async (threadId) => expect(threadId).toBe("thread-exact"),
      deliver: async (threadId, entry) => {
        expect(threadId).toBe("thread-exact");
        delivered.push(entry);
      },
      onTurnCompleted: () => () => {},
      closed: new Promise<void>((resolve) => {
        finishClosed = resolve;
      }),
      close: () => {
        closed = true;
        finishClosed();
      },
    };
    const running = runCodexAttachment(
      { sessionId: "thread-exact", workspace: "/workspace", cwd: "/agent" },
      {
        createControlClient: async () => control,
        createDaemonClient: async () => ({
          register: async (input) => registered.push(input),
          heartbeat: async () => {},
          acknowledgeStreamTransport: async (_sessionId, entryId) => {
            acknowledgements.push(entryId);
            controller.abort();
          },
          openSessionStream: async (_sessionId, transport, onEntry, signal) => {
            expect(transport).toBe("codex_app_server");
            await onEntry(ENTRY);
            if (!signal.aborted)
              await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
            return { ended: "eof" as const };
          },
        }),
        random: () => 0,
        sleep: async () => {},
        now: () => 0,
      },
      controller.signal,
    );
    await running;
    expect(registered).toEqual([
      {
        session_id: "thread-exact",
        provider: "codex",
        cwd: "/agent",
        workspace_binding: "/workspace",
        source: "codex-app-server",
      },
    ]);
    expect(delivered).toEqual([ENTRY]);
    expect(acknowledgements).toEqual(["entry-1"]);
    expect(closed).toBe(true);
  });

  test("retry delay is bounded and the first failed resume remains retryable", async () => {
    expect(codexAttachRetryDelay(0, () => 0)).toBe(CODEX_ATTACH_MIN_DELAY_MS);
    expect(codexAttachRetryDelay(99, () => 1)).toBe(CODEX_ATTACH_MAX_DELAY_MS);
    expect(codexAttachRetryDelay(99, () => 0)).toBeLessThan(CODEX_ATTACH_MAX_DELAY_MS);
    let connections = 0;
    const controller = new AbortController();
    const control = (): CodexControlClient => ({
      resume: async () => {
        connections++;
        if (connections === 1) throw new Error("no rollout found for thread id thread-exact");
      },
      deliver: async () => {},
      onTurnCompleted: () => () => {},
      closed: new Promise(() => {}),
      close: () => {},
    });
    await runCodexAttachment(
      { sessionId: "thread-exact", workspace: "/workspace", cwd: "/agent" },
      {
        createControlClient: async () => control(),
        createDaemonClient: async () => ({
          register: async () => {},
          heartbeat: async () => {},
          acknowledgeStreamTransport: async () => {},
          openSessionStream: async () => {
            controller.abort();
            return { ended: "eof" as const };
          },
        }),
        random: () => 0,
        sleep: async () => {},
        now: () => 0,
      },
      controller.signal,
    );
    expect(connections).toBe(2);
  });

  test("abort closes an initialized control socket while a request is pending", async () => {
    let initialized = false;
    const peer = await protocolPeer((message, socket) => {
      if (message.method === "initialize" && typeof message.id === "number") {
        initialized = true;
        socket.write(serverFrame(JSON.stringify({ id: message.id, result: {} })));
      }
      // Deliberately never answer thread/resume.
    });
    try {
      const controller = new AbortController();
      const client = await CodexJsonRpcClient.connect(peer.path, controller.signal);
      expect(initialized).toBe(true);
      const pending = client.resume("thread-exact");
      controller.abort();
      await expect(pending).rejects.toThrow("closed");
      await client.closed;
    } finally {
      await new Promise<void>((resolve) => peer.server.close(() => resolve()));
    }
  });
});

// SPDX-License-Identifier: Apache-2.0
// Minimal RFC 6455 client for Codex's local app-server control socket. The built-in WebSocket
// client cannot dial AF_UNIX, so this keeps the provider local-only without opening a TCP port.
import { createHash, randomBytes } from "node:crypto";
import { createConnection, type Socket } from "node:net";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_FRAME_BYTES = 1024 * 1024;

export interface UnixWebSocketOptions {
  signal?: AbortSignal;
  handshakeTimeoutMs?: number;
  socketFactory?: (path: string) => Socket;
}

function frame(opcode: number, payload: Uint8Array): Buffer {
  if (payload.byteLength > MAX_FRAME_BYTES) throw new Error("websocket message exceeds 1 MiB");
  const extended = payload.byteLength < 126 ? 0 : payload.byteLength <= 0xffff ? 2 : 8;
  const header = Buffer.alloc(2 + extended + 4);
  header[0] = 0x80 | opcode;
  header[1] = 0x80 | (extended === 0 ? payload.byteLength : extended === 2 ? 126 : 127);
  if (extended === 2) header.writeUInt16BE(payload.byteLength, 2);
  if (extended === 8) header.writeBigUInt64BE(BigInt(payload.byteLength), 2);
  const maskOffset = 2 + extended;
  const mask = randomBytes(4);
  mask.copy(header, maskOffset);
  const masked = Buffer.alloc(payload.byteLength);
  for (let i = 0; i < payload.byteLength; i++) masked[i] = payload[i]! ^ mask[i % 4]!;
  return Buffer.concat([header, masked]);
}

export class UnixWebSocket {
  private input = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentOpcode: number | null = null;
  private ended = false;
  private readonly messages = new Set<(message: string) => void>();
  private readonly closed = new Set<(error?: Error) => void>();

  private constructor(private readonly socket: Socket) {
    socket.on("data", (chunk) => this.consume(Buffer.from(chunk)));
    socket.on("error", (error) => this.finish(error));
    socket.on("close", () => this.finish());
  }

  static async connect(path: string, options: UnixWebSocketOptions = {}): Promise<UnixWebSocket> {
    const socket = (options.socketFactory ?? ((target) => createConnection(target)))(path);
    const key = randomBytes(16).toString("base64");
    const expectedAccept = createHash("sha1")
      .update(key + WEBSOCKET_GUID)
      .digest("base64");
    const timeoutMs = options.handshakeTimeoutMs ?? 5_000;

    return await new Promise<UnixWebSocket>((resolve, reject) => {
      let buffered = Buffer.alloc(0);
      let settled = false;
      const timer = setTimeout(() => fail(new Error("websocket handshake timed out")), timeoutMs);
      timer.unref?.();
      const onAbort = () => fail(new Error("websocket handshake aborted"));
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        socket.off("error", fail);
        socket.off("close", onClose);
        socket.off("data", onHandshakeData);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.destroy();
        reject(error);
      };
      const onClose = () => fail(new Error("websocket closed during handshake"));
      const onHandshakeData = (chunk: Buffer) => {
        buffered = Buffer.concat([buffered, chunk]);
        if (buffered.byteLength > 16 * 1024) return fail(new Error("websocket handshake exceeds 16 KiB"));
        const boundary = buffered.indexOf("\r\n\r\n");
        if (boundary < 0) return;
        const header = buffered.subarray(0, boundary).toString("utf8");
        const lines = header.split("\r\n");
        if (!/^HTTP\/1\.[01] 101\b/.test(lines[0] ?? "")) return fail(new Error("websocket upgrade rejected"));
        const headers = new Map(
          lines.slice(1).map((line) => {
            const colon = line.indexOf(":");
            return [line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()];
          }),
        );
        if (headers.get("sec-websocket-accept") !== expectedAccept) {
          return fail(new Error("websocket accept hash mismatch"));
        }
        if (headers.get("upgrade")?.toLowerCase() !== "websocket") {
          return fail(new Error("websocket upgrade header is missing"));
        }
        if (
          !headers
            .get("connection")
            ?.toLowerCase()
            .split(/\s*,\s*/)
            .includes("upgrade")
        ) {
          return fail(new Error("websocket connection header is missing"));
        }
        settled = true;
        cleanup();
        const client = new UnixWebSocket(socket);
        const remaining = buffered.subarray(boundary + 4);
        if (remaining.byteLength > 0) client.consume(remaining);
        resolve(client);
      };
      if (options.signal?.aborted) return fail(new Error("websocket handshake aborted"));
      options.signal?.addEventListener("abort", onAbort, { once: true });
      socket.once("error", fail);
      socket.once("close", onClose);
      socket.on("data", onHandshakeData);
      socket.once("connect", () => {
        socket.write(
          `GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        );
      });
    });
  }

  onMessage(listener: (message: string) => void): () => void {
    this.messages.add(listener);
    return () => this.messages.delete(listener);
  }

  onClose(listener: (error?: Error) => void): () => void {
    this.closed.add(listener);
    if (this.ended) queueMicrotask(() => listener());
    return () => this.closed.delete(listener);
  }

  send(message: string): void {
    if (this.ended) throw new Error("websocket is closed");
    this.socket.write(frame(0x1, Buffer.from(message, "utf8")));
  }

  close(): void {
    if (this.ended) return;
    this.socket.end(frame(0x8, Buffer.alloc(0)));
    this.finish();
  }

  private finish(error?: Error): void {
    if (this.ended) return;
    this.ended = true;
    for (const listener of this.closed) listener(error);
    this.closed.clear();
    this.messages.clear();
  }

  private consume(chunk: Buffer): void {
    if (this.ended) return;
    this.input = Buffer.concat([this.input, chunk]);
    while (this.input.byteLength >= 2) {
      const first = this.input[0]!;
      const second = this.input[1]!;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.input.byteLength < 4) return;
        length = this.input.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.input.byteLength < 10) return;
        const wide = this.input.readBigUInt64BE(2);
        if (wide > BigInt(MAX_FRAME_BYTES)) {
          this.protocolError("websocket frame exceeds 1 MiB");
          return;
        }
        length = Number(wide);
        offset = 10;
      }
      if (masked) {
        this.protocolError("server websocket frames must not be masked");
        return;
      }
      if (length > MAX_FRAME_BYTES) {
        this.protocolError("websocket frame exceeds 1 MiB");
        return;
      }
      if (this.input.byteLength < offset + length) return;
      const payload = this.input.subarray(offset, offset + length);
      this.input = this.input.subarray(offset + length);
      const opcode = first & 0x0f;
      const final = (first & 0x80) !== 0;
      if ((first & 0x70) !== 0) {
        this.protocolError("websocket extensions are unsupported");
        return;
      }
      if (opcode >= 0x8 && (!final || length > 125)) {
        this.protocolError("invalid websocket control frame");
        return;
      }
      if (opcode === 0x8) {
        this.socket.end(frame(0x8, payload));
        this.finish();
        return;
      }
      if (opcode === 0x9) {
        this.socket.write(frame(0xa, payload));
        continue;
      }
      if (opcode === 0xa) continue;
      if (opcode === 0x1 || opcode === 0x2) {
        if (this.fragmentOpcode !== null) {
          this.protocolError("nested websocket message");
          return;
        }
        this.fragmentOpcode = opcode;
        this.fragments = [payload];
      } else if (opcode === 0x0) {
        if (this.fragmentOpcode === null) {
          this.protocolError("orphan websocket continuation");
          return;
        }
        this.fragments.push(payload);
      } else {
        this.protocolError("unsupported websocket opcode");
        return;
      }
      if (this.fragments.reduce((total, part) => total + part.byteLength, 0) > MAX_FRAME_BYTES) {
        this.protocolError("websocket message exceeds 1 MiB");
        return;
      }
      if (!final) continue;
      const messageOpcode = this.fragmentOpcode;
      const message = Buffer.concat(this.fragments);
      this.fragmentOpcode = null;
      this.fragments = [];
      if (messageOpcode !== 0x1) {
        this.protocolError("binary websocket messages are unsupported");
        return;
      }
      const text = message.toString("utf8");
      for (const listener of this.messages) listener(text);
    }
  }

  private protocolError(message: string): void {
    try {
      this.socket.end(frame(0x8, Buffer.from([0x03, 0xea])));
    } finally {
      this.finish(new Error(message));
    }
  }
}

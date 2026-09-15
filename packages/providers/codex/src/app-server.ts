// SPDX-License-Identifier: Apache-2.0
import { join } from "node:path";
import { homedir } from "node:os";
import type { DeliverableEntry } from "../../../daemon/src/agent-provider/interface.ts";
import { UnixWebSocket } from "./unix-websocket.ts";

export const CODEX_ATTACH_MIN_DELAY_MS = 5_000;
export const CODEX_ATTACH_MAX_DELAY_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

interface RpcResponse {
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string };
  method?: string;
  params?: Record<string, unknown>;
}

export interface CodexControlClient {
  resume(threadId: string): Promise<void>;
  deliver(threadId: string, entry: DeliverableEntry): Promise<void>;
  onTurnCompleted(listener: () => void): () => void;
  closed: Promise<void>;
  close(): void;
}

export interface CodexAttachOptions {
  sessionId: string;
  workspace: string;
  cwd: string;
  socketPath?: string;
}

export interface CodexAttachDeps {
  createControlClient(path: string, signal: AbortSignal): Promise<CodexControlClient>;
  createDaemonClient(signal: AbortSignal): Promise<{
    register(input: {
      session_id: string;
      provider: string;
      cwd: string;
      workspace_binding: string;
      source: string;
    }): Promise<unknown>;
    heartbeat(sessionId: string): Promise<void>;
    acknowledgeStreamTransport?(sessionId: string, entryId: string): Promise<void>;
    openSessionStream?(
      sessionId: string,
      transport: "codex_app_server",
      onEntry: (entry: DeliverableEntry) => Promise<void>,
      signal: AbortSignal,
    ): Promise<void>;
  }>;
  random(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref?.();
    signal.addEventListener("abort", done, { once: true });
  });
}

export function codexControlSocketPath(home = process.env.CODEX_HOME ?? join(homedir(), ".codex")): string {
  return join(home, "app-server-control", "app-server-control.sock");
}

export function codexAttachRetryDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(CODEX_ATTACH_MAX_DELAY_MS, CODEX_ATTACH_MIN_DELAY_MS * 2 ** attempt);
  return Math.max(CODEX_ATTACH_MIN_DELAY_MS, Math.floor(base * (0.8 + 0.2 * random())));
}

export class CodexJsonRpcClient implements CodexControlClient {
  private nextId = 1;
  private resumedThreadId: string | null = null;
  private activeTurnId: string | null = null;
  private readonly pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly completedListeners = new Set<() => void>();
  readonly closed: Promise<void>;

  private constructor(private readonly socket: UnixWebSocket) {
    socket.onMessage((wire) => this.receive(wire));
    this.closed = new Promise((resolve) =>
      socket.onClose((error) => {
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(error ?? new Error("Codex app-server connection closed"));
        }
        this.pending.clear();
        resolve();
      }),
    );
  }

  static async connect(path: string, signal: AbortSignal): Promise<CodexJsonRpcClient> {
    const socket = await UnixWebSocket.connect(path, { signal });
    const client = new CodexJsonRpcClient(socket);
    const closeOnAbort = () => client.close();
    signal.addEventListener("abort", closeOnAbort, { once: true });
    socket.onClose(() => signal.removeEventListener("abort", closeOnAbort));
    if (signal.aborted) {
      client.close();
      throw new Error("Codex app-server connection aborted");
    }
    try {
      await client.request("initialize", {
        clientInfo: { name: "glosa", title: "glosa local review transport", version: "1" },
        capabilities: null,
      });
      socket.send(JSON.stringify({ method: "initialized" }));
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  async resume(threadId: string): Promise<void> {
    await this.request("thread/resume", { threadId, excludeTurns: true });
    this.resumedThreadId = threadId;
  }

  async deliver(threadId: string, entry: DeliverableEntry): Promise<void> {
    const input = [{ type: "text", text: `[glosa ${entry.id}] ${JSON.stringify(entry)}`, text_elements: [] }];
    if (this.activeTurnId) {
      await this.request("turn/steer", { threadId, input, expectedTurnId: this.activeTurnId });
    } else {
      await this.request("turn/start", { threadId, input });
    }
  }

  onTurnCompleted(listener: () => void): () => void {
    this.completedListeners.add(listener);
    return () => this.completedListeners.delete(listener);
  }

  close(): void {
    this.socket.close();
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server ${method} timed out`));
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({ method, id, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private receive(wire: string): void {
    let message: RpcResponse;
    try {
      message = JSON.parse(wire) as RpcResponse;
    } catch {
      this.close();
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message ?? "Codex app-server request failed"));
      else pending.resolve(message.result);
      return;
    }
    const threadId = message.params?.threadId;
    if (message.method === "turn/started" && threadId === this.resumedThreadId) {
      const turn = message.params?.turn;
      const turnId = turn && typeof turn === "object" ? (turn as Record<string, unknown>).id : undefined;
      if (typeof turnId === "string") this.activeTurnId = turnId;
    }
    if (message.method === "turn/completed" && threadId === this.resumedThreadId) {
      this.activeTurnId = null;
      for (const listener of this.completedListeners) listener();
    }
  }
}

export const codexAttachmentRuntime = {
  createControlClient: CodexJsonRpcClient.connect,
  random: Math.random,
  sleep: abortableSleep,
} as const;

export async function runCodexAttachment(
  options: CodexAttachOptions,
  deps: CodexAttachDeps,
  signal: AbortSignal = AbortSignal.any([]),
): Promise<void> {
  let attempt = 0;
  while (!signal.aborted) {
    const attemptAbort = new AbortController();
    const combined = AbortSignal.any([signal, attemptAbort.signal]);
    let control: CodexControlClient | undefined;
    let removeCompleted: (() => void) | undefined;
    try {
      control = await deps.createControlClient(options.socketPath ?? codexControlSocketPath(), combined);
      await control.resume(options.sessionId);
      const daemon = await deps.createDaemonClient(combined);
      await daemon.register({
        session_id: options.sessionId,
        provider: "codex",
        cwd: options.cwd,
        workspace_binding: options.workspace,
        source: "codex-app-server",
      });
      if (!daemon.openSessionStream || !daemon.acknowledgeStreamTransport) {
        throw new Error("generic session stream is unavailable");
      }
      const connectedAt = Date.now();
      const stream = daemon.openSessionStream(
        options.sessionId,
        "codex_app_server",
        async (entry) => {
          await control!.deliver(options.sessionId, entry);
          await daemon.acknowledgeStreamTransport!(options.sessionId, entry.id);
        },
        combined,
      );
      removeCompleted = control.onTurnCompleted(() => {
        void daemon.heartbeat(options.sessionId).catch(() => {});
      });
      await Promise.race([stream, control.closed]);
      if (Date.now() - connectedAt >= 20_000) attempt = 0;
    } catch {
      if (signal.aborted) return;
    } finally {
      removeCompleted?.();
      attemptAbort.abort();
      control?.close();
    }
    await deps.sleep(codexAttachRetryDelay(attempt, deps.random), signal);
    attempt = Math.min(attempt + 1, 31);
  }
}

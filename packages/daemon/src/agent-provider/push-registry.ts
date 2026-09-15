// SPDX-License-Identifier: Apache-2.0
// Provider-neutral, in-memory bridge between a live session transport and AgentProvider.deliver.
// Durable truth remains in the workspace inbox/journal; losing this registry on restart only
// removes the optional push rung and leaves hook/MCP fallback eligible.
import type { DeliverableEntry } from "./interface.ts";

interface Connection {
  close?: () => void;
  send: (entry: DeliverableEntry) => void;
  transport: "channel" | "monitor";
  accepted: Set<string>;
}

interface PendingAck {
  resolve: (accepted: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
  promise: Promise<boolean>;
}

export class SessionPushRegistry {
  private readonly connections = new Map<string, Connection>();
  private readonly pending = new Map<string, PendingAck>();

  register(
    sessionId: string,
    send: Connection["send"],
    close?: () => void,
    transport: Connection["transport"] = "channel",
  ): () => void {
    this.connections.get(sessionId)?.close?.();
    this.connections.set(sessionId, { send, close, transport, accepted: new Set() });
    return () => {
      const current = this.connections.get(sessionId);
      if (current?.send !== send) return;
      this.connections.delete(sessionId);
      for (const [key, pending] of this.pending) {
        if (!key.startsWith(`${sessionId}\0`)) continue;
        clearTimeout(pending.timer);
        pending.resolve(false);
        this.pending.delete(key);
      }
    };
  }

  has(sessionId: string): boolean {
    return this.connections.has(sessionId);
  }

  transport(sessionId: string): Connection["transport"] | null {
    return this.connections.get(sessionId)?.transport ?? null;
  }

  isAwaitingTransport(sessionId: string, entryId: string): boolean {
    return this.pending.has(`${sessionId}\0${entryId}`);
  }

  send(sessionId: string, entry: DeliverableEntry, timeoutMs = 2_000): Promise<boolean> {
    const connection = this.connections.get(sessionId);
    if (!connection) return Promise.resolve(false);
    if (connection.accepted.has(entry.id)) return Promise.resolve(true);
    const key = `${sessionId}\0${entry.id}`;
    const prior = this.pending.get(key);
    if (prior) return prior.promise;
    let resolvePromise!: (accepted: boolean) => void;
    const promise = new Promise<boolean>((resolve) => {
      resolvePromise = resolve;
    });
    const timer = setTimeout(() => {
      this.pending.delete(key);
      resolvePromise(false);
    }, timeoutMs);
    timer.unref?.();
    this.pending.set(key, { resolve: resolvePromise, timer, promise });
    try {
      connection.send(entry);
    } catch {
      clearTimeout(timer);
      this.pending.delete(key);
      resolvePromise(false);
    }
    return promise;
  }

  acknowledgeTransport(sessionId: string, entryId: string): boolean {
    const key = `${sessionId}\0${entryId}`;
    const pending = this.pending.get(key);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pending.delete(key);
    this.connections.get(sessionId)?.accepted.add(entryId);
    pending.resolve(true);
    return true;
  }
}

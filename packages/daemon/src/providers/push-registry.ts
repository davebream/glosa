// SPDX-License-Identifier: Apache-2.0
// Provider-neutral, in-memory bridge between a live session transport and AgentProvider.deliver.
// Durable truth remains in the workspace inbox/journal; losing this registry on restart only
// removes the optional push rung and leaves hook/MCP fallback eligible.
import type { DeliverableEntry } from "./interface.ts";

interface Connection {
  send: (entry: DeliverableEntry) => void;
}

interface PendingAck {
  resolve: (accepted: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class SessionPushRegistry {
  private readonly connections = new Map<string, Connection>();
  private readonly pending = new Map<string, PendingAck>();

  register(sessionId: string, send: Connection["send"]): () => void {
    this.connections.set(sessionId, { send });
    return () => {
      const current = this.connections.get(sessionId);
      if (current?.send === send) this.connections.delete(sessionId);
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

  send(sessionId: string, entry: DeliverableEntry, timeoutMs = 2_000): Promise<boolean> {
    const connection = this.connections.get(sessionId);
    if (!connection) return Promise.resolve(false);
    const key = `${sessionId}\0${entry.id}`;
    const prior = this.pending.get(key);
    if (prior) {
      clearTimeout(prior.timer);
      prior.resolve(false);
      this.pending.delete(key);
    }
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        resolve(false);
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(key, { resolve, timer });
      try {
        connection.send(entry);
      } catch {
        clearTimeout(timer);
        this.pending.delete(key);
        resolve(false);
      }
    });
  }

  acknowledgeTransport(sessionId: string, entryId: string): boolean {
    const key = `${sessionId}\0${entryId}`;
    const pending = this.pending.get(key);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pending.delete(key);
    pending.resolve(true);
    return true;
  }
}

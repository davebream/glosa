// SPDX-License-Identifier: Apache-2.0
// Provider-neutral, in-memory bridge between a live session transport and AgentProvider.deliver.
// Durable truth remains in the workspace inbox/journal; losing this registry on restart only
// removes the optional push rung and leaves MCP pull eligible.
import type { DeliverableEntry } from "./interface.ts";
import type { SignalFrame } from "./signal-registry.ts";

interface Connection {
  /** Called with the replacing connection's transport when `register` displaces this one, so the
   * displaced side can write its terminal `event: superseded` frame before it closes (#206). Called
   * with no argument for every other close cause (shutdown, revocation, cancel, send failure) —
   * those must stay byte-identical EOF on the wire. */
  close?: (supersededBy?: Connection["transport"]) => void;
  send: (entry: DeliverableEntry) => void;
  /** Writes an `event: signal` frame (issue #155) on the SAME serialized writer as `send`, so a
   * signal and a delivery can never interleave mid-frame. Absent on a transport that cannot carry
   * one; such a session gets its signals from the drain instead. */
  sendSignal?: (frame: SignalFrame) => void;
  transport: "monitor" | "codex_app_server";
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
    close: Connection["close"],
    transport: Connection["transport"],
    sendSignal?: Connection["sendSignal"],
  ): () => void {
    this.connections.get(sessionId)?.close?.(transport);
    this.connections.set(sessionId, {
      send,
      close,
      transport,
      accepted: new Set(),
      ...(sendSignal ? { sendSignal } : {}),
    });
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

  /** Pushes a signal to the session's live stream. `false` when there is no stream, or it cannot
   * carry signals — the signal then stays pending for the next drain or reconnect. Fire-and-forget:
   * a signal is acknowledged by its addressee through the ack route, not by the transport. */
  sendSignal(sessionId: string, frame: SignalFrame): boolean {
    const connection = this.connections.get(sessionId);
    if (!connection?.sendSignal) return false;
    try {
      connection.sendSignal(frame);
      return true;
    } catch {
      return false;
    }
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

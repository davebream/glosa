// SPDX-License-Identifier: Apache-2.0
// Chat cursors are independent of the workspace journal's SSE Last-Event-ID.
import type { SseEventType } from "../transport/sse.ts";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ManagedAgentError } from "../agents/interface.ts";
import type { ChatWorkspace, ManagedChatService } from "./service.ts";
import type { ChatLog, ChatEvent } from "./store.ts";
import type { JournalRecord } from "./journal.ts";

// Leave half the workspace stream queue available for durable/live records and other channels.
const BOOTSTRAP_BYTES = 512 * 1024;

const watchSchema = z
  .object({
    streamId: z.uuid(),
    revision: z.number().int().positive(),
    chats: z
      .array(
        z
          .object({
            id: z.uuid(),
            cursor: z.number().int().nonnegative().optional(),
            before: z.string().max(256).optional(),
          })
          .strict(),
      )
      .max(32),
  })
  .strict();

/** Hydrate only the blob named by this event, never the complete history. */
export function displayChatRecord(log: ChatLog, record: JournalRecord<ChatEvent>) {
  const event = record.data;
  if (event.type === "turn")
    return { ...record, data: { ...event, turn: { ...event.turn, text: log.text(event.turn.textHash) } } };
  if (event.type === "draft" || event.type === "turn_revised")
    return { ...record, data: { ...event, text: log.text(event.textHash) } };
  return record;
}

type Connection = {
  workspace: ChatWorkspace;
  revision: number;
  send: (event: SseEventType, data: unknown) => void;
  watches: Map<string, () => void>;
};

export class ChatWatchStreams {
  private readonly connections = new Map<string, Connection>();
  constructor(private readonly service: ManagedChatService) {}

  register(workspace: ChatWorkspace, send: Connection["send"]): () => void {
    const streamId = randomUUID();
    const connection: Connection = { workspace, revision: 0, send, watches: new Map() };
    this.connections.set(streamId, connection);
    send("chat_stream_ready", { streamId, version: 1 });
    return () => {
      this.connections.delete(streamId);
      for (const stop of connection.watches.values()) stop();
      connection.watches.clear();
    };
  }

  watch(workspace: ChatWorkspace, raw: unknown): { revision: number } {
    const input = watchSchema.parse(raw);
    const connection = this.connections.get(input.streamId);
    if (!connection || connection.workspace.id !== workspace.id || connection.workspace.epoch !== workspace.epoch)
      throw new ManagedAgentError(
        "chat-stream-expired",
        "The workspace connection changed. Reconnect to continue.",
        409,
      );
    if (input.revision <= connection.revision) return { revision: connection.revision };
    if (new Set(input.chats.map((chat) => chat.id)).size !== input.chats.length)
      throw new ManagedAgentError("invalid-chat-watch", "A chat can only be watched once per connection.", 422);
    // Resolve all chats before changing the existing subscription, so invalid input is atomic.
    const chats = input.chats.map((chat) => ({ ...chat, log: this.service.chat(workspace, chat.id) }));
    for (const stop of connection.watches.values()) stop();
    connection.watches.clear();
    connection.revision = input.revision;
    let bootstrapBytes = 0;
    for (const chat of chats) {
      let sequence = chat.log.journal.revision;
      const listener = (record: JournalRecord<ChatEvent>) => {
        if (record.seq <= sequence) return;
        sequence = record.seq;
        try {
          this.service.chat(workspace, chat.id);
          connection.send("chat_event", { chatId: chat.id, record: displayChatRecord(chat.log, record) });
        } catch {
          connection.send("chat_unavailable", { chatId: chat.id });
          connection.watches.get(chat.id)?.();
          connection.watches.delete(chat.id);
        }
      };
      chat.log.journal.listeners.add(listener);
      connection.watches.set(chat.id, () => chat.log.journal.listeners.delete(listener));
      const reference = () => {
        const data = { chatId: chat.id, revision: sequence, ...(chat.before ? { before: chat.before } : {}) };
        bootstrapBytes += Buffer.byteLength(JSON.stringify(data)) + 64;
        connection.send("chat_snapshot_ref", data);
      };
      // No await between capture, listener registration and replay: no missing-write window.
      if (chat.cursor !== undefined && chat.cursor <= sequence && sequence - chat.cursor <= 500) {
        const replay: ReturnType<typeof displayChatRecord>[] = [];
        let replayBytes = 0;
        for (let index = chat.cursor; index < sequence; index++) {
          const record = chat.log.journal.records[index]!;
          const hydrated = displayChatRecord(chat.log, record);
          replayBytes += Buffer.byteLength(JSON.stringify({ chatId: chat.id, record: hydrated })) + 64;
          if (bootstrapBytes + replayBytes > BOOTSTRAP_BYTES) break;
          replay.push(hydrated);
        }
        if (bootstrapBytes + replayBytes > BOOTSTRAP_BYTES) reference();
        else {
          bootstrapBytes += replayBytes;
          for (const record of replay) connection.send("chat_event", { chatId: chat.id, record });
        }
      } else {
        const data = { chatId: chat.id, snapshot: this.service.snapshot(workspace, chat.id, chat.before) };
        const bytes = Buffer.byteLength(JSON.stringify(data)) + 64;
        if (bootstrapBytes + bytes > BOOTSTRAP_BYTES) reference();
        else {
          bootstrapBytes += bytes;
          connection.send("chat_snapshot", data);
        }
      }
    }
    return { revision: connection.revision };
  }
}

const registries = new WeakMap<ManagedChatService, ChatWatchStreams>();
export function chatWatchStreams(service: ManagedChatService): ChatWatchStreams {
  let registry = registries.get(service);
  if (!registry) {
    registry = new ChatWatchStreams(service);
    registries.set(service, registry);
  }
  return registry;
}

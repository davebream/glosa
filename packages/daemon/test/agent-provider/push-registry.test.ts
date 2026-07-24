// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import type { DeliverableEntry } from "../../src/agent-provider/interface.ts";
import { SessionPushRegistry } from "../../src/agent-provider/push-registry.ts";

function conversation(id: string, target: string): DeliverableEntry {
  const message = `message ${id}`;
  const text = `glosa conversation_message ${id}\nmessage:\n${message}`;
  return {
    id,
    kind: "conversation_message",
    status: "pending",
    text,
    bytes: Buffer.byteLength(text, "utf8"),
    message,
    message_bytes: Buffer.byteLength(message, "utf8"),
    target_session_id: target,
    provider: "claude-code",
    detail: { target_session_id: target, provider: "claude-code" },
    truncation: { truncated: false, omitted_bytes: 0, omitted_hunks: 0 },
    retrieval: { command: `glosa inbox get ${id}`, mcp_tool: "glosa_inbox_get" },
  };
}

describe("SessionPushRegistry", () => {
  test("only an active exact-session bridge is available and transport acceptance requires its ack", async () => {
    const registry = new SessionPushRegistry();
    const seen: string[] = [];
    const entry = conversation("message-1", "session-a");
    expect(await registry.send("session-a", entry, 1)).toBe(false);

    const unregister = registry.register("session-a", (value) => seen.push(value.id));
    const accepted = registry.send("session-a", entry, 100);
    expect(registry.has("session-a")).toBe(true);
    expect(registry.has("session-b")).toBe(false);
    expect(seen).toEqual(["message-1"]);
    expect(registry.acknowledgeTransport("session-b", entry.id)).toBe(false);
    expect(registry.acknowledgeTransport("session-a", entry.id)).toBe(true);
    expect(await accepted).toBe(true);

    unregister();
    expect(registry.has("session-a")).toBe(false);
  });
});

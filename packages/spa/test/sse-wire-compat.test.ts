// SPDX-License-Identifier: Apache-2.0
// P3.3 — wire-compatibility check between data-access.js's hand-duplicated SSE frame parser and
// the real server-side encoder it has to stay in sync with (packages/daemon/src/sse.ts). The two
// can't share code directly (data-access.js's own header comment explains why: it ships as plain
// JS straight to the browser with no build step, and sse.ts is TypeScript), so this test is what
// actually proves they still agree on the wire format — feeding real `encodeSseFrame` output
// through the browser-side `parseSseStream` and checking every field round-trips.
import { describe, expect, test } from "bun:test";
import { encodeSseFrame } from "../../daemon/src/sse.ts";
import { parseSseStream } from "../src/data-access.js";

function readerFor(text: string): ReadableStreamDefaultReader<Uint8Array> {
  const encoder = new TextEncoder();
  let sent = false;
  return {
    read: async () => {
      if (!sent) {
        sent = true;
        return { done: false, value: encoder.encode(text) };
      }
      return { done: true, value: undefined };
    },
  } as unknown as ReadableStreamDefaultReader<Uint8Array>;
}

describe("data-access.js parses real daemon-encoded SSE frames", () => {
  test("a snapshot frame round-trips id/event/data", async () => {
    const wire = encodeSseFrame({ id: 42, event: "snapshot", data: { artifacts: [{ path: "a.md" }] } });
    const frames = [];
    for await (const frame of parseSseStream(readerFor(wire))) frames.push(frame);
    expect(frames).toEqual([{ id: "42", event: "snapshot", data: JSON.stringify({ artifacts: [{ path: "a.md" }] }) }]);
  });

  test("a journal frame carrying a full JournalEvent-shaped payload round-trips", async () => {
    const payload = { v: 1, event_id: "01ABC", at: "2026-01-01T00:00:00.000Z", entry: "e1", event: "entry_created", by: "daemon" };
    const wire = encodeSseFrame({ id: 5, event: "journal", data: payload });
    const frames = [];
    for await (const frame of parseSseStream(readerFor(wire))) frames.push(frame);
    expect(frames).toHaveLength(1);
    expect(JSON.parse(frames[0]!.data)).toEqual(payload);
  });

  test("a heartbeat frame (server-encoded) is dropped by the browser-side parser too", async () => {
    const wire = encodeSseFrame({ event: "heartbeat" });
    const frames = [];
    for await (const frame of parseSseStream(readerFor(wire))) frames.push(frame);
    expect(frames).toHaveLength(0);
  });

  test("an id-less artifact-change frame (best-effort, no cursor) round-trips with id undefined", async () => {
    const wire = encodeSseFrame({ event: "artifact", data: { path: "a.md", class: "R", source_sha256: "abc" } });
    const frames = [];
    for await (const frame of parseSseStream(readerFor(wire))) frames.push(frame);
    expect(frames).toEqual([{ id: undefined, event: "artifact", data: JSON.stringify({ path: "a.md", class: "R", source_sha256: "abc" }) }]);
  });

  test("multiple frames concatenated in one write (as a real TCP chunk might) are all parsed in order", async () => {
    const wire =
      encodeSseFrame({ id: 1, event: "journal", data: { n: 1 } }) + encodeSseFrame({ id: 2, event: "journal", data: { n: 2 } });
    const frames = [];
    for await (const frame of parseSseStream(readerFor(wire))) frames.push(frame);
    expect(frames.map((f) => f.id)).toEqual(["1", "2"]);
  });
});

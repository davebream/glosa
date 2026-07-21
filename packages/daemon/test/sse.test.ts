// P3.2 — pure wire-format tests for sse.ts (A1 §8.1). No I/O, no Bun.serve: `encodeSseFrame`
// and `parseSseStream` are exercised directly against ReadableStreams built by hand, including
// deliberately splitting a single frame across an arbitrary chunk boundary — the whole reason
// this can't be tested with a plain `String.split`.
import { describe, expect, test } from "bun:test";
import { encodeSseFrame, parseSseStream } from "../src/sse.ts";

/** Turns an array of raw string chunks into a ReadableStreamDefaultReader<Uint8Array>, exactly
 * how a real fetch-streaming body would hand bytes to the client parser — chunk boundaries don't
 * respect frame boundaries. */
function readerFromChunks(chunks: string[]): ReadableStreamDefaultReader<Uint8Array> {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return stream.getReader();
}

async function collect(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const out: { id?: string; event: string; data: string }[] = [];
  for await (const ev of parseSseStream(reader)) out.push(ev);
  return out;
}

describe("encodeSseFrame", () => {
  test("a journal frame carries id, event, and JSON-encoded data", () => {
    const frame = encodeSseFrame({ id: 7, event: "journal", data: { hello: "world" } });
    expect(frame).toBe('id: 7\nevent: journal\ndata: {"hello":"world"}\n\n');
  });

  test("heartbeat carries no id and no data", () => {
    const frame = encodeSseFrame({ event: "heartbeat" });
    expect(frame).toBe("event: heartbeat\ndata: \n\n");
  });

  test("resync_required carries no id and no data", () => {
    const frame = encodeSseFrame({ event: "resync_required" });
    expect(frame).toBe("event: resync_required\ndata: \n\n");
  });

  test("snapshot's id can be -1 (empty-journal sentinel)", () => {
    const frame = encodeSseFrame({ id: -1, event: "snapshot", data: { artifacts: [] } });
    expect(frame.startsWith("id: -1\n")).toBe(true);
  });
});

describe("parseSseStream — round trip", () => {
  test("parses a single whole frame delivered in one chunk", async () => {
    const wire = encodeSseFrame({ id: 3, event: "journal", data: { a: 1 } });
    const events = await collect(readerFromChunks([wire]));
    expect(events).toEqual([{ id: "3", event: "journal", data: '{"a":1}' }]);
  });

  test("parses multiple frames concatenated in one chunk, in order", async () => {
    const wire =
      encodeSseFrame({ id: 0, event: "journal", data: { n: 0 } }) +
      encodeSseFrame({ id: 1, event: "journal", data: { n: 1 } }) +
      encodeSseFrame({ id: 2, event: "journal", data: { n: 2 } });
    const events = await collect(readerFromChunks([wire]));
    expect(events.map((e) => e.id)).toEqual(["0", "1", "2"]);
    expect(events.map((e) => JSON.parse(e.data).n)).toEqual([0, 1, 2]);
  });

  test("reassembles a frame split across an arbitrary chunk boundary, including mid-line", async () => {
    const wire = encodeSseFrame({ id: 42, event: "journal", data: { note: "split me" } });
    // Split at every possible byte offset — none of them may lose or corrupt the frame.
    for (let cut = 1; cut < wire.length - 1; cut++) {
      const events = await collect(readerFromChunks([wire.slice(0, cut), wire.slice(cut)]));
      expect(events).toEqual([{ id: "42", event: "journal", data: '{"note":"split me"}' }]);
    }
  });

  test("drops heartbeat frames silently — never yielded to the caller", async () => {
    const wire =
      encodeSseFrame({ id: 0, event: "journal", data: { n: 0 } }) +
      encodeSseFrame({ event: "heartbeat" }) +
      encodeSseFrame({ event: "heartbeat" }) +
      encodeSseFrame({ id: 1, event: "journal", data: { n: 1 } });
    const events = await collect(readerFromChunks([wire]));
    expect(events.map((e) => e.event)).toEqual(["journal", "journal"]);
  });

  test("surfaces a snapshot frame and a resync_required frame with their own event names", async () => {
    const wire =
      encodeSseFrame({ id: 5, event: "snapshot", data: { artifacts: [] } }) +
      encodeSseFrame({ event: "resync_required" });
    const events = await collect(readerFromChunks([wire]));
    expect(events[0]).toEqual({ id: "5", event: "snapshot", data: '{"artifacts":[]}' });
    expect(events[1]).toEqual({ id: undefined, event: "resync_required", data: "" });
  });

  test("an artifact frame has no id (advisory, not cursor-bearing)", async () => {
    const wire = encodeSseFrame({ event: "artifact", data: { path: "a.md" } });
    const events = await collect(readerFromChunks([wire]));
    expect(events[0]?.id).toBeUndefined();
    expect(events[0]?.event).toBe("artifact");
  });
});

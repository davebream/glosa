// @glosa/daemon — the SSE wire format (P3.2, A1 §8.1). One tiny module, two directions:
//   - `encodeSseFrame`: server-side, used by stream.ts to write `id:`/`event:`/`data:` frames.
//   - `parseSseStream`: client-side, hand-parsed fetch-streaming (NOT `EventSource` — A1 §2:
//     `EventSource` can't attach the `Authorization: Bearer` header). This half is written here
//     rather than in packages/spa because it's exercised directly by this task's round-trip tests;
//     P3.3 has the SPA import it (a same-monorepo relative import — no bundler, no npm package
//     boundary to cross, per the "no build step" stack constraint in the repo's own CLAUDE.md).
// P4.2 additions — `transcript` (a normalized `TranscriptEvent`, A2 §F16) and `mirror_unavailable`
// (the transcript stream's fail-soft signal: a parse/tail failure that must never surface as a
// 500 or a dropped connection, A2 §F16 "Failure Recovery") — same wire mechanics as every other
// frame type, just a separate cursor space (A1 §8.1's "two independent cursor spaces").
export type SseEventType =
  | "snapshot"
  | "journal"
  | "artifact"
  | "heartbeat"
  | "resync_required"
  | "transcript"
  | "mirror_unavailable";

export interface SseFrame {
  /** Omitted for `heartbeat` and `artifact` — neither advances the cursor (A1 §8.1/§8.3): a
   * heartbeat carries no state at all, and an artifact-change push has no durable log to replay
   * from on reconnect (unlike journal events), so it's deliberately kept out of the cursor space
   * rather than given an id nothing can resume from. */
  id?: number | string;
  event: SseEventType;
  data?: unknown;
}

/** Standard SSE framing: `id: <cursor>\nevent: <type>\ndata: <json>\n\n`. `data:` is always
 * present (even empty) so every frame ends in exactly one blank-line terminator regardless of
 * whether there's a payload — `heartbeat`/`resync_required` have none. Safe as a single `data:`
 * line because `JSON.stringify` never emits a raw newline byte (only escaped `\n` inside strings),
 * so a frame's data is always one line no matter what it encodes. */
export function encodeSseFrame(frame: SseFrame): string {
  const lines: string[] = [];
  if (frame.id !== undefined) lines.push(`id: ${frame.id}`);
  lines.push(`event: ${frame.event}`);
  lines.push(`data: ${frame.data !== undefined ? JSON.stringify(frame.data) : ""}`);
  return lines.join("\n") + "\n\n";
}

export interface ParsedSseEvent {
  id?: string;
  event: string;
  /** Raw string — callers `JSON.parse` it themselves once they know the event type. Kept as a
   * string here so a malformed/empty payload (heartbeat, resync_required) doesn't force every
   * caller through a `JSON.parse("")` special case. */
  data: string;
}

function parseFrame(raw: string): ParsedSseEvent | null {
  let id: string | undefined;
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("id: ")) id = line.slice(4);
    else if (line.startsWith("event: ")) event = line.slice(7);
    else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
    else if (line === "data:") dataLines.push("");
    // any other line (blank, unrecognized field) is ignored per the SSE spec's own tolerance
  }
  if (event === undefined) return null; // not a real frame — nothing to yield
  return { id, event, data: dataLines.join("\n") };
}

/** Fetch-streaming SSE parser (A1 §2/§8.1) — reads a `response.body.getReader()` reader and yields
 * one `ParsedSseEvent` per blank-line-terminated frame, correctly reassembling a frame that a
 * chunk boundary split mid-line (the whole reason this can't just be a `String.split` over one
 * chunk: TCP/HTTP chunking gives no guarantee a frame arrives whole). Drops `heartbeat` frames
 * silently — a caller never has to special-case them (A1 §8.3: "the client's parser drops
 * heartbeat events silently"). Does NOT interpret `resync_required`/reconnect — that's the
 * caller's watchdog/reconnect-loop concern (also P3.3); this module only speaks the wire format. */
export async function* parseSseStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<ParsedSseEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const rawFrame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const parsed = parseFrame(rawFrame);
      if (parsed && parsed.event !== "heartbeat") yield parsed;
    }
    if (done) return;
  }
}

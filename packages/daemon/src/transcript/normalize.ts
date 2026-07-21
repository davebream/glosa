// @glosa/daemon — P4.2: the vendored `TranscriptEvent` normalizer (A2 §F16). The ONLY module in
// this codebase allowed to look at a raw Claude Code transcript JSONL line — everything else (the
// tailer in transcript/stream.ts, the SPA's conversation.js) only ever sees the normalized shape
// below. This isolation is the whole point: the record format is "internal to Claude Code and
// changes between versions" (A2 §F16), so a format change or a corrupt/truncated file is contained
// to this one file rather than leaking `JSON.parse` calls across the daemon.
//
// `TranscriptNormalizer` is a small stateful class, not a pure function, because two of F16's
// requirements are inherently stateful: partial-line buffering (a chunk boundary can split a JSON
// record mid-line) and the cumulative unknown/quarantine count (surfaced to `glosa doctor status`,
// never reset by a resume/clear/compact resync — only the line-buffer and line-numbering are).
//
// NEVER THROWS. Every parse failure — invalid JSON, valid JSON that isn't an object, a record
// shape this module doesn't recognize — degrades to a `type: "unknown"` event and increments the
// quarantine counter; the fold always continues to the next line (A2 §F16 "Failure Recovery").

export type TranscriptEvent =
  | { type: "prose"; role: "user" | "assistant"; content: string; id: string }
  | { type: "tool_use"; tool_name: string; tool_id: string; input: unknown; id: string }
  | {
      type: "tool_result";
      tool_id: string;
      content: string;
      size_bytes: number;
      size_original: number;
      truncated: boolean;
      id: string;
    }
  | { type: "subagent"; subagent_id: string; summary: string; id: string }
  | { type: "meta"; kind: string; id: string }
  | { type: "unknown"; raw: string; line_num: number };

// A2 §F16 caps.
const TOOL_RESULT_CAP_BYTES = 10 * 1024; // "In-memory cap per event: 10 KB"
const PROSE_CONTENT_CAP_BYTES = 100 * 1024; // "content field: cap at 100 KB after truncation"
const TOOL_INPUT_CAP_BYTES = 50 * 1024; // "tool_input: cap at 50 KB"
const UNKNOWN_RAW_PREVIEW_CHARS = 200; // "first 200 chars of raw text"
const TOOL_RESULT_KEEP_END_CHARS = 200; // "retain start + marker + 200 chars of end"

interface CapResult {
  content: string;
  truncated: boolean;
  size_bytes: number;
  size_original: number;
}

/** Caps `content` at `capBytes` (measured in UTF-8 bytes, not chars — a transcript is arbitrary
 * user/tool text). Under the cap, returned verbatim. Over it, retains the start up to budget plus
 * the LAST `keepEndChars` characters plus a `"... truncated ..."` marker in between (A2 §F16: "the
 * start + '... truncated ...' marker + 200 chars of end") — trims the start slice byte-by-byte off
 * the end if a multi-byte character would otherwise straddle the cut, so the result is always
 * valid UTF-8. */
function capText(content: string, capBytes: number, keepEndChars = 0): CapResult {
  const sizeOriginal = Buffer.byteLength(content, "utf8");
  if (sizeOriginal <= capBytes) {
    return { content, truncated: false, size_bytes: sizeOriginal, size_original: sizeOriginal };
  }
  if (keepEndChars === 0) {
    // Simple head-truncation (used for prose/tool_input caps, which F16 doesn't specify a
    // keep-both-ends shape for). Pre-slice to `capBytes` CHARS first — always >= the eventual byte
    // count, since one UTF-16 code unit is never fewer than one UTF-8 byte — so the trim loop below
    // only ever runs a handful of times (multi-byte overshoot at the cut point), not once per
    // discarded character; a naive `content.slice(0,-1)` loop over a large single-byte-per-char
    // string is O(n) iterations of O(n) string copies each.
    let head = content.length > capBytes ? content.slice(0, capBytes) : content;
    while (Buffer.byteLength(head, "utf8") > capBytes && head.length > 0) head = head.slice(0, -1);
    const marker = "… truncated …";
    const truncatedContent = head + marker;
    return {
      content: truncatedContent,
      truncated: true,
      size_bytes: Buffer.byteLength(truncatedContent, "utf8"),
      size_original: sizeOriginal,
    };
  }
  const marker = "\n... truncated ...\n";
  const endPart = content.slice(-keepEndChars);
  const budget = Math.max(0, capBytes - Buffer.byteLength(marker, "utf8") - Buffer.byteLength(endPart, "utf8"));
  let startPart = content.slice(0, budget);
  while (Buffer.byteLength(startPart, "utf8") > budget && startPart.length > 0) startPart = startPart.slice(0, -1);
  const truncatedContent = startPart + marker + endPart;
  return {
    content: truncatedContent,
    truncated: true,
    size_bytes: Buffer.byteLength(truncatedContent, "utf8"),
    size_original: sizeOriginal,
  };
}

/** Flattens a Claude Code content value (a plain string, a `{text}`-shaped block, or an array of
 * either) down to plain text — used for subagent summaries and tool_result bodies, both of which
 * can arrive as either shape depending on record version. */
function flattenText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(flattenText).join("\n");
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (typeof v.text === "string") return v.text;
  }
  return "";
}

function unknownEvent(raw: string, lineNum: number): TranscriptEvent {
  return { type: "unknown", raw: raw.slice(0, UNKNOWN_RAW_PREVIEW_CHARS), line_num: lineNum };
}

/** Parses one already-JSON-decoded transcript record into zero or more normalized events. Never
 * throws — any shape it doesn't recognize (including a `message.content` neither a string nor an
 * array) falls through to the final `unknownEvent`. Modeled on Claude Code's actual (undocumented,
 * version-unstable — A2 §F16) transcript record shape: `{type: "user"|"assistant"|"summary"|
 * "system", uuid, message: {role, content}, isSidechain?, isMeta?}`, `content` either a plain
 * string or an array of `{type: "text"|"tool_use"|"tool_result", ...}` blocks. */
function parseRecord(obj: Record<string, unknown>, lineNum: number, rawLine: string): TranscriptEvent[] {
  const uuid = typeof obj.uuid === "string" && obj.uuid.length > 0 ? obj.uuid : `line-${lineNum}`;

  // `/compact` — A2 §F16's state-transition table: "Replaces history with summary." Hidden from
  // the prose stream (meta), never dropped as unknown — it's a recognized control record. Keyed
  // by `leafUuid` (the real record shape's own id for a summary line), falling back to `uuid`/
  // the line-number sentinel if neither is present.
  if (obj.type === "summary") {
    const summaryId = typeof obj.leafUuid === "string" && obj.leafUuid.length > 0 ? obj.leafUuid : uuid;
    return [{ type: "meta", kind: "compact", id: summaryId }];
  }
  if (obj.isMeta === true || obj.type === "system") {
    return [{ type: "meta", kind: typeof obj.type === "string" ? obj.type : "system", id: uuid }];
  }
  // Subagent sidechain (A2 §F16: "Glosa v1 does NOT attempt to follow subagent links... main-
  // session events are rendered" — but a sidechain record that DOES show up inline in the main
  // transcript is still surfaced, grouped, not silently dropped, per the task brief's "subagent
  // group" normalized kind).
  if (obj.isSidechain === true) {
    const message = obj.message as Record<string, unknown> | undefined;
    const summary = capText(flattenText(message?.content), PROSE_CONTENT_CAP_BYTES).content;
    return [{ type: "subagent", subagent_id: uuid, summary, id: uuid }];
  }

  if (obj.type === "user" || obj.type === "assistant") {
    const role = obj.type as "user" | "assistant";
    const message = obj.message as Record<string, unknown> | undefined;
    const content = message?.content;

    if (typeof content === "string") {
      return [{ type: "prose", role, content: capText(content, PROSE_CONTENT_CAP_BYTES).content, id: uuid }];
    }
    if (Array.isArray(content)) {
      const events: TranscriptEvent[] = [];
      content.forEach((block, i) => {
        if (typeof block !== "object" || block === null) return;
        const b = block as Record<string, unknown>;
        const blockId = `${uuid}:${i}`;
        if (b.type === "text" && typeof b.text === "string") {
          events.push({ type: "prose", role, content: capText(b.text, PROSE_CONTENT_CAP_BYTES).content, id: blockId });
        } else if (b.type === "tool_use") {
          const inputRaw = JSON.stringify(b.input ?? {});
          const capped = capText(inputRaw, TOOL_INPUT_CAP_BYTES);
          let input: unknown = {};
          try {
            input = capped.truncated ? { truncated: true, preview: capped.content } : JSON.parse(inputRaw);
          } catch {
            input = {};
          }
          events.push({
            type: "tool_use",
            tool_name: typeof b.name === "string" ? b.name : "unknown",
            tool_id: typeof b.id === "string" ? b.id : blockId,
            input,
            id: blockId,
          });
        } else if (b.type === "tool_result") {
          const capped = capText(flattenText(b.content), TOOL_RESULT_CAP_BYTES, TOOL_RESULT_KEEP_END_CHARS);
          events.push({
            type: "tool_result",
            tool_id: typeof b.tool_use_id === "string" ? b.tool_use_id : blockId,
            content: capped.content,
            size_bytes: capped.size_bytes,
            size_original: capped.size_original,
            truncated: capped.truncated,
            id: blockId,
          });
        }
        // Any other block type (image, thinking, …) is silently skipped — not one of the
        // normalized kinds this task's spec enumerates, and dropping ONE block inside an
        // otherwise-recognized record is not the same failure as an unrecognized record.
      });
      // A `user`/`assistant` record whose content array yielded nothing recognized (e.g. an
      // image-only message) still isn't "unknown" — the record shape WAS recognized, it just had
      // no renderable block. Return the empty array rather than manufacturing an unknown event.
      return events;
    }
    // `message` present but `content` is neither a string nor an array — not a shape this
    // normalizer recognizes.
    return [unknownEvent(rawLine, lineNum)];
  }

  // Any other `type` value — a future/unknown event kind (A2 §F16 "Unknown Event Quarantine").
  return [unknownEvent(rawLine, lineNum)];
}

const NEWLINE = 0x0a;

export class TranscriptNormalizer {
  private buffer: Uint8Array = new Uint8Array(0);
  private lineNum = 0;
  private quarantinedCount_ = 0;
  private readonly decoder = new TextDecoder("utf-8", { fatal: false });

  /** Feeds a raw byte chunk (as read straight off the transcript file — never string-decoded by
   * the caller, so byte offsets stay exact even across multi-byte UTF-8 characters). Returns every
   * event completed by this chunk, in order. A trailing partial line (no `\n` yet) is buffered
   * internally and contributes nothing to the returned array — A2 §F16 "Partial Line Handling":
   * "if a line has no trailing `\n`, buffer it... do NOT emit until the newline arrives." */
  feed(chunk: Uint8Array | string): TranscriptEvent[] {
    const chunkBytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
    const merged = new Uint8Array(this.buffer.length + chunkBytes.length);
    merged.set(this.buffer, 0);
    merged.set(chunkBytes, this.buffer.length);

    const events: TranscriptEvent[] = [];
    let start = 0;
    for (let i = 0; i < merged.length; i++) {
      if (merged[i] !== NEWLINE) continue;
      const lineBytes = merged.subarray(start, i);
      const line = this.decoder.decode(lineBytes);
      this.lineNum += 1;
      events.push(...this.parseLine(line, this.lineNum));
      start = i + 1;
    }
    this.buffer = merged.subarray(start);
    return events;
  }

  /** Bytes still buffered, unemitted — always exactly the trailing partial line (or empty, right
   * after a `feed()` that ended cleanly on a `\n`). The transcript tailer (stream.ts) uses this to
   * compute how far into the file it's safe to advance its `{inode, byte_offset}` cursor: always a
   * line boundary, never mid-line — a reconnect can only ever resume from a point every prior byte
   * before it was already fully parsed (or quarantined) from. */
  get pendingBytes(): number {
    return this.buffer.length;
  }

  /** Cumulative unknown/malformed line count (A2 §F16 "Metrics: expose unknown-event count"). NOT
   * reset by `reset()` — see that method's own docstring. */
  get quarantinedCount(): number {
    return this.quarantinedCount_;
  }

  /** A2 §F16's resume/clear/compact resync: discards the buffered partial line and resets line
   * numbering to 0 — called by the tailer the instant it detects the transcript file was truncated
   * or replaced (a new `inode`, or a size smaller than the last known offset). Deliberately does
   * NOT reset `quarantinedCount`: that's a lifetime metric across the whole tailer's life, not
   * scoped to one transcript-file identity. */
  reset(): void {
    this.buffer = new Uint8Array(0);
    this.lineNum = 0;
  }

  private parseLine(line: string, lineNum: number): TranscriptEvent[] {
    if (line.length === 0) return []; // a blank line between records — nothing to emit, not unknown
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.quarantinedCount_ += 1;
      return [unknownEvent(line, lineNum)];
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      this.quarantinedCount_ += 1;
      return [unknownEvent(line, lineNum)];
    }
    let events: TranscriptEvent[];
    try {
      events = parseRecord(parsed as Record<string, unknown>, lineNum, line);
    } catch {
      // Belt-and-suspenders: parseRecord is written to never throw, but a future edit to it (or a
      // record shape whose nesting breaks an assumption) must still degrade here, not crash the
      // whole tailer (A2 §F16's own bar: "Continue parsing from the next line; do NOT abort").
      this.quarantinedCount_ += 1;
      return [unknownEvent(line, lineNum)];
    }
    if (events.length === 1 && events[0]!.type === "unknown") this.quarantinedCount_ += 1;
    return events;
  }
}

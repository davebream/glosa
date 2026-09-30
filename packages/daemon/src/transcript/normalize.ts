// SPDX-License-Identifier: Apache-2.0
// Provider-neutral transcript framing, bounded content and quarantine accounting.

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
  | { type: "system"; content: string; id: string }
  | { type: "subagent"; subagent_id: string; summary: string; id: string }
  | { type: "meta"; kind: string; id: string }
  | { type: "unknown"; raw: string; line_num: number };

// A2 §F16 caps.
export const TOOL_RESULT_CAP_BYTES = 10 * 1024; // "In-memory cap per event: 10 KB"
export const PROSE_CONTENT_CAP_BYTES = 100 * 1024; // "content field: cap at 100 KB after truncation"
export const TOOL_INPUT_CAP_BYTES = 50 * 1024; // "tool_input: cap at 50 KB"
const UNKNOWN_RAW_PREVIEW_CHARS = 200; // "first 200 chars of raw text"
export const TOOL_RESULT_KEEP_END_CHARS = 200; // "retain start + marker + 200 chars of end"

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
export function capText(content: string, capBytes: number, keepEndChars = 0): CapResult {
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

export function unknownEvent(raw: string, lineNum: number): TranscriptEvent {
  return { type: "unknown", raw: raw.slice(0, UNKNOWN_RAW_PREVIEW_CHARS), line_num: lineNum };
}

const NEWLINE = 0x0a;

export type TranscriptRecordParser = (
  record: Record<string, unknown>,
  lineNum: number,
  rawLine: string,
) => TranscriptEvent[];

export class TranscriptNormalizer {
  constructor(
    private readonly parseRecord: TranscriptRecordParser = (_record, lineNum, raw) => [unknownEvent(raw, lineNum)],
  ) {}

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
      events = this.parseRecord(parsed as Record<string, unknown>, lineNum, line);
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

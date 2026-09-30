// SPDX-License-Identifier: Apache-2.0
// Claude Code record interpretation lives in its provider; the daemon only frames JSONL.
import {
  TranscriptNormalizer,
  type TranscriptEvent,
  capText,
  unknownEvent,
  PROSE_CONTENT_CAP_BYTES,
  TOOL_INPUT_CAP_BYTES,
  TOOL_RESULT_CAP_BYTES,
  TOOL_RESULT_KEEP_END_CHARS,
} from "../../../daemon/src/transcript/normalize.ts";

export class ClaudeTranscriptNormalizer extends TranscriptNormalizer {
  constructor() {
    super(parseClaudeRecord);
  }
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

/** Parses one already-JSON-decoded transcript record into zero or more normalized events. Never
 * throws — any shape it doesn't recognize (including a `message.content` neither a string nor an
 * array) falls through to the final `unknownEvent`. Modeled on Claude Code's actual (undocumented,
 * version-unstable — A2 §F16) transcript record shape: `{type: "user"|"assistant"|"summary"|
 * "system", uuid, message: {role, content}, isSidechain?, isMeta?}`, `content` either a plain
 * string or an array of `{type: "text"|"tool_use"|"tool_result", ...}` blocks. */
function parseClaudeRecord(obj: Record<string, unknown>, lineNum: number, rawLine: string): TranscriptEvent[] {
  const uuid = typeof obj.uuid === "string" && obj.uuid.length > 0 ? obj.uuid : `line-${lineNum}`;

  const content = flattenText((obj.message as Record<string, unknown> | undefined)?.content);
  const queuedContent = flattenText(obj.content);
  if (
    obj.type === "queue-operation" &&
    obj.operation === "enqueue" &&
    queuedContent.trimStart().startsWith("<task-notification>")
  ) {
    const summary = /<summary>([\s\S]*?)<\/summary>/.exec(queuedContent)?.[1];
    return [
      {
        type: "system",
        content: capText(summary ?? "Background task notification", PROSE_CONTENT_CAP_BYTES).content,
        id: uuid,
      },
    ];
  }
  if (
    obj.type === "user" &&
    (obj.isMeta === true || obj.isSynthetic === true) &&
    content.trimStart().startsWith("<task-notification>")
  ) {
    const summary = /<summary>([\s\S]*?)<\/summary>/.exec(content)?.[1];
    return [
      {
        type: "system",
        content: capText(summary ?? "Background task notification", PROSE_CONTENT_CAP_BYTES).content,
        id: uuid,
      },
    ];
  }
  if (
    [
      "progress",
      "queue-operation",
      "file-history-snapshot",
      "last-prompt",
      "attachment",
      "atis-latch",
      "cost-state",
    ].includes(String(obj.type))
  ) {
    return [{ type: "meta", kind: String(obj.type), id: uuid }];
  }

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

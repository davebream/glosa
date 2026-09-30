// SPDX-License-Identifier: Apache-2.0
// Rollout response_item records are authoritative. event_msg mirrors are deliberately not prose.
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

export class CodexTranscriptNormalizer extends TranscriptNormalizer {
  constructor() {
    super(parseCodexRecord);
  }
}

function parseCodexRecord(record: Record<string, unknown>, lineNum: number, raw: string): TranscriptEvent[] {
  const id = typeof record.id === "string" ? record.id : `line-${lineNum}`;
  if (["session_meta", "turn_context", "event_msg", "compacted"].includes(String(record.type)))
    return [{ type: "meta", kind: String(record.type), id }];
  if (record.type !== "response_item" || !record.payload || typeof record.payload !== "object")
    return [unknownEvent(raw, lineNum)];
  const item = record.payload as Record<string, unknown>;
  if (item.type === "reasoning") return [];
  if (item.type === "message") {
    if (item.role === "developer" || item.role === "system") return [];
    if ((item.role !== "user" && item.role !== "assistant") || !Array.isArray(item.content))
      return [unknownEvent(raw, lineNum)];
    const role = item.role;
    return item.content.flatMap((block, index): TranscriptEvent[] => {
      if (!block || typeof block !== "object") return [];
      if (!["input_text", "output_text", "text"].includes(block.type) || typeof block.text !== "string") return [];
      return [
        { type: "prose", role, content: capText(block.text, PROSE_CONTENT_CAP_BYTES).content, id: `${id}:${index}` },
      ];
    });
  }
  if (item.type === "function_call" || item.type === "custom_tool_call") {
    const rawInput = item.type === "function_call" ? item.arguments : item.input;
    const text = typeof rawInput === "string" ? rawInput : JSON.stringify(rawInput ?? {});
    const capped = capText(text, TOOL_INPUT_CAP_BYTES);
    let input: unknown = { text: capped.content };
    if (capped.truncated) input = { truncated: true, preview: capped.content };
    else if (item.type === "function_call") {
      try {
        input = JSON.parse(text);
      } catch {
        /* Preserve malformed arguments as bounded text. */
      }
    }
    return [
      {
        type: "tool_use",
        tool_name: typeof item.name === "string" ? item.name : "unknown",
        tool_id: typeof item.call_id === "string" ? item.call_id : id,
        input,
        id,
      },
    ];
  }
  if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
    const text = typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "");
    const capped = capText(text, TOOL_RESULT_CAP_BYTES, TOOL_RESULT_KEEP_END_CHARS);
    return [{ type: "tool_result", tool_id: typeof item.call_id === "string" ? item.call_id : id, ...capped, id }];
  }
  return [unknownEvent(raw, lineNum)];
}

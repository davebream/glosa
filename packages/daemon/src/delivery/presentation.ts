// SPDX-License-Identifier: Apache-2.0
// Actionable, provider-neutral inbox presentation (R3/R4, issue #18).

import type { DeliverableEntry, PresentationRetrieval } from "../agent-provider/interface.ts";
import type { Resolution } from "../anchoring.ts";

export const MAX_ENTRY_PRESENTATION_BYTES = 16 * 1024;
export const MAX_BATCH_PRESENTATION_BYTES = 32 * 1024;
export const MAX_DELIVERY_ENTRIES = 8;

const encoder = new TextEncoder();

export function utf8Bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

function truncateUtf8(value: string, maxBytes: number): { value: string; omitted: number } {
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= maxBytes) return { value, omitted: 0 };
  const slice = bytes.slice(0, Math.max(0, maxBytes));
  let decoded = new TextDecoder("utf-8", { fatal: false }).decode(slice);
  if (decoded.endsWith("�")) decoded = decoded.slice(0, -1);
  return { value: decoded, omitted: bytes.byteLength - utf8Bytes(decoded) };
}

function encodeCursor(id: string, offset: number): string {
  return Buffer.from(JSON.stringify({ v: 1, id, offset }), "utf8").toString("base64url");
}

export function decodePresentationCursor(cursor: string | undefined, expectedId: string): number {
  if (!cursor) return 0;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    if (value.v !== 1 || value.id !== expectedId || !Number.isInteger(value.offset) || (value.offset as number) < 0)
      return 0;
    return value.offset as number;
  } catch {
    return 0;
  }
}

function retrieval(id: string, cursor?: string): PresentationRetrieval {
  return {
    command: `glosa inbox get ${id}${cursor ? ` --cursor ${cursor}` : ""}`,
    mcp_tool: "glosa_inbox_get",
    ...(cursor ? { cursor } : {}),
  };
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export interface BuildPresentationOptions {
  status: string;
  resolution?: Resolution;
  cursor?: string;
  maxBytes?: number;
}

function annotationPresentation(
  id: string,
  payload: Record<string, unknown>,
  opts: BuildPresentationOptions,
): DeliverableEntry | null {
  const artifactPath = stringOf(payload.artifact_path);
  const body = stringOf(payload.body);
  const intent = stringOf(payload.intent);
  const target = recordOf(payload.target);
  const quote = recordOf(target?.quote);
  if (!artifactPath || body === null || !intent || !target || stringOf(quote?.exact) === null) return null;

  const offset = decodePresentationCursor(opts.cursor, id);
  const remainingBody = body.slice(offset);
  const resolution = opts.resolution ?? { kind: "orphaned", reason: "no_source_map" as const };
  const fixed = [
    `glosa annotation ${id}`,
    `artifact: ${artifactPath}`,
    `intent: ${intent}`,
    `quote: ${JSON.stringify(quote)}`,
    `position: ${JSON.stringify(target.position ?? null)}`,
    `resolution: ${JSON.stringify(resolution)}`,
    "comment:",
  ].join("\n");
  const maxBytes = opts.maxBytes ?? MAX_ENTRY_PRESENTATION_BYTES;
  const markerReserve = 512;
  const allowedBodyBytes = Math.max(0, maxBytes - utf8Bytes(fixed) - markerReserve);
  const sliced = truncateUtf8(remainingBody, allowedBodyBytes);
  const nextOffset = offset + sliced.value.length;
  const cursor = sliced.omitted > 0 ? encodeCursor(id, nextOffset) : undefined;
  const retrieve = retrieval(id, cursor);
  const marker = cursor
    ? `\n[truncated: ${sliced.omitted} UTF-8 bytes omitted; retrieve with ${retrieve.command} or MCP ${retrieve.mcp_tool}]`
    : "";
  const text = `${fixed}\n${sliced.value}${marker}`;
  return {
    id,
    kind: "annotation",
    status: opts.status,
    text,
    bytes: utf8Bytes(text),
    detail: { artifact_path: artifactPath, body: sliced.value, intent, target, resolution },
    truncation: { truncated: sliced.omitted > 0, omitted_bytes: sliced.omitted, omitted_hunks: 0 },
    retrieval: retrieve,
  };
}

function splitDiffHunks(diff: string): { header: string; hunks: string[] } {
  const lines = diff.split(/(?=^@@ )/m);
  return { header: lines.shift() ?? "", hunks: lines.filter(Boolean) };
}

function humanEditPresentation(
  id: string,
  payload: Record<string, unknown>,
  opts: BuildPresentationOptions,
): DeliverableEntry | null {
  const before = stringOf(payload.checkpoint_before);
  const after = stringOf(payload.checkpoint_after);
  const rawFiles = Array.isArray(payload.files) ? payload.files : null;
  if (!before || !after || !rawFiles) return null;
  const files = rawFiles
    .map(recordOf)
    .filter(
      (file): file is Record<string, unknown> =>
        file !== null && typeof file.path === "string" && typeof file.diff === "string",
    );
  if (files.length === 0) return null;

  const maxBytes = opts.maxBytes ?? MAX_ENTRY_PRESENTATION_BYTES;
  const paths = files.map((file) => file.path as string);
  const fixed = [`glosa human_edit ${id}`, `checkpoints: ${before}..${after}`, `files: ${paths.join(", ")}`].join("\n");
  const chunks: Array<{ path: string; diff: string }> = [];
  for (const file of files) {
    const parsed = splitDiffHunks(file.diff as string);
    if (parsed.hunks.length === 0) {
      chunks.push({ path: file.path as string, diff: parsed.header });
      continue;
    }
    parsed.hunks.forEach((hunk, index) => {
      chunks.push({ path: file.path as string, diff: `${index === 0 ? parsed.header : ""}${hunk}` });
    });
  }

  const offset = Math.min(decodePresentationCursor(opts.cursor, id), chunks.length);
  let text = fixed;
  const includedFiles: Array<{ path: string; diff: string }> = [];
  let includedCount = 0;
  for (const chunk of chunks.slice(offset)) {
    const addition = `\n\nfile: ${chunk.path}\n${chunk.diff.trimEnd()}`;
    if (utf8Bytes(text + addition) > maxBytes - 512) break;
    text += addition;
    includedFiles.push(chunk);
    includedCount += 1;
  }
  const omitted = chunks.slice(offset + includedCount);
  const omittedHunks = omitted.length;
  const omittedBytes = omitted.reduce((sum, chunk) => sum + utf8Bytes(chunk.diff), 0);
  const cursor = omittedHunks > 0 ? encodeCursor(id, offset + includedCount) : undefined;
  const retrieve = retrieval(id, cursor);
  if (omittedHunks > 0) {
    text += `\n[truncated: ${omittedHunks} hunks / ${omittedBytes} UTF-8 bytes omitted; retrieve with ${retrieve.command} or MCP ${retrieve.mcp_tool}]`;
  }
  return {
    id,
    kind: "human_edit",
    status: opts.status,
    text,
    bytes: utf8Bytes(text),
    detail: { checkpoint_before: before, checkpoint_after: after, files: includedFiles },
    truncation: { truncated: omittedHunks > 0, omitted_bytes: omittedBytes, omitted_hunks: omittedHunks },
    retrieval: retrieve,
  };
}

function attentionPresentation(
  id: string,
  payload: Record<string, unknown>,
  opts: BuildPresentationOptions,
): DeliverableEntry {
  const path = typeof payload.path === "string" ? payload.path : undefined;
  const action = typeof payload.action === "string" ? payload.action : undefined;
  const message = typeof payload.message === "string" ? payload.message : "";
  const offset = decodePresentationCursor(opts.cursor, id);
  const fixed = [
    `glosa attention_request ${id}`,
    ...(path ? [`artifact: ${path}`] : []),
    ...(action ? [`action: ${action}`] : []),
    "message:",
  ].join("\n");
  const maxBytes = opts.maxBytes ?? MAX_ENTRY_PRESENTATION_BYTES;
  const sliced = truncateUtf8(message.slice(offset), Math.max(0, maxBytes - utf8Bytes(fixed) - 512));
  const cursor = sliced.omitted > 0 ? encodeCursor(id, offset + sliced.value.length) : undefined;
  const retrieve = retrieval(id, cursor);
  const marker = cursor
    ? `\n[truncated: ${sliced.omitted} UTF-8 bytes omitted; retrieve with ${retrieve.command} or MCP ${retrieve.mcp_tool}]`
    : "";
  const text = `${fixed}\n${sliced.value}${marker}`;
  const detail = {
    ...(path ? { path } : {}),
    ...(action ? { action } : {}),
    ...(message ? { message: sliced.value } : {}),
  };
  return {
    id,
    kind: "attention_request",
    status: opts.status,
    text,
    bytes: utf8Bytes(text),
    detail,
    truncation: { truncated: sliced.omitted > 0, omitted_bytes: sliced.omitted, omitted_hunks: 0 },
    retrieval: retrieve,
  };
}

function conversationPresentation(
  id: string,
  payload: Record<string, unknown>,
  opts: BuildPresentationOptions,
): DeliverableEntry | null {
  const message = stringOf(payload.text);
  const targetSessionId = stringOf(payload.target_session_id);
  const provider = stringOf(payload.provider);
  if (!message || !targetSessionId || !provider) return null;
  const text = `glosa conversation_message ${id}\nmessage:\n${message}`;
  if (utf8Bytes(text) > (opts.maxBytes ?? MAX_ENTRY_PRESENTATION_BYTES)) return null;
  return {
    id,
    kind: "conversation_message",
    status: opts.status,
    text,
    bytes: utf8Bytes(text),
    message,
    message_bytes: utf8Bytes(message),
    target_session_id: targetSessionId,
    provider,
    detail: { target_session_id: targetSessionId, provider },
    truncation: { truncated: false, omitted_bytes: 0, omitted_hunks: 0 },
    retrieval: retrieval(id),
  };
}

export function buildDeliveryPresentation(
  id: string,
  payloadInput: unknown,
  opts: BuildPresentationOptions,
): DeliverableEntry | null {
  const payload = recordOf(payloadInput);
  if (!payload) return null;
  if (payload.kind === "annotation") return annotationPresentation(id, payload, opts);
  if (payload.kind === "human_edit") return humanEditPresentation(id, payload, opts);
  if (payload.kind === "attention_request") return attentionPresentation(id, payload, opts);
  if (payload.kind === "conversation_message") return conversationPresentation(id, payload, opts);
  return null;
}

export function formatPresentationBatch(entries: DeliverableEntry[], maxBytes = MAX_BATCH_PRESENTATION_BYTES): string {
  let out = "";
  for (const entry of entries) {
    const separator = out ? "\n\n---\n\n" : "";
    const text = entry.text;
    if (utf8Bytes(out + separator + text) > maxBytes) break;
    out += separator + text;
  }
  return out;
}

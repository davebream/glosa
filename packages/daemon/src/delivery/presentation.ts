// SPDX-License-Identifier: Apache-2.0
// Actionable, provider-neutral inbox presentation (R3/R4, issue #18).

import type { DeliverableEntry, PresentationClaim, PresentationRetrieval } from "../agent-provider/interface.ts";
import type { Resolution } from "../anchoring.ts";

export const MAX_ENTRY_PRESENTATION_BYTES = 16 * 1024;
export const MAX_BATCH_PRESENTATION_BYTES = 32 * 1024;
export const MAX_DELIVERY_ENTRIES = 8;
/** At most this many claims ride on one presentation (issue #155), exclusive first. */
export const MAX_PRESENTATION_CLAIMS = 4;

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

/** Keep identity and the decision/edit distinction inside the presentation byte budget. */
const APPLY_PROTOCOL = (id: string, sessionId?: string) => {
  const session = sessionId ? `'${sessionId.replaceAll("'", "'\\''")}'` : "<session_id returned by glosa_inbox_pull>";
  return [
    "how to act on this:",
    ...(sessionId
      ? [`your session_id: ${sessionId}`]
      : ["get your own session_id from glosa_inbox_pull (also returned by glosa_inbox_get and glosa_claim)."]),
    `1. before editing: glosa_claim with resources ["entry:${id}"] and this workspace,`,
    `   or glosa claim entry:${id} --session ${session} --workspace <the workspace: path above>`,
    "2. make the change only after the exclusive claim succeeds.",
    `3. finish: glosa resolve ${id} applied --session ${session} --workspace <the workspace: path above>`,
    "to decline without editing, resolve rejected with --note; no claim is needed unless another session holds the files.",
    "resolve deferred records 'not now': it leaves the note open and does not release an existing claim.",
    `if stopping with a claim: glosa_release, or glosa release <claim_id> --session ${session} --workspace <the workspace: path above>; unfinished edits become unknown.`,
    "use this same session_id and pass --workspace explicitly: your current directory may be another workspace.",
    "the claim's recorded files and before/after interval prove authorship; unclaimed edits remain unknown.",
  ].join("\n");
};

/** Said beside every address, so a session reads it as the reader's label for a passage today and
 * not as a place to find the words: the quote is what locates them. */
const ADDRESS_NOTE =
  "(the passage's label in the document as it stands now; an edit can renumber it, the quote is the anchor)";

export interface BuildPresentationOptions {
  status: string;
  sessionId?: string;
  resolution?: Resolution;
  cursor?: string;
  maxBytes?: number;
  /** #153 Part 2 (D10): true when this presentation is being built for a `glosa_watch` response.
   * The only kind that reads it is `external_edit` — every watched entry is one, since a watch
   * only ever surfaces that kind — and it swaps the "nothing is being asked" wording for one that
   * names why the session is seeing this at all: it asked to watch. */
  watched?: boolean;
  /** Live claims on this entry or its file (issue #155). Their text is reserved out of `maxBytes`
   * BEFORE the body is sized, so the body truncates and the claims never do. */
  claims?: readonly PresentationClaim[];
  /** The passage address (`§2.3`, packages/spa/src/address.js) of the block an annotation resolves
   * to, derived by the caller from the document as it stands at delivery. Only an annotation with a
   * `source_range` resolution reads it, and only beside its quote: the quote is the anchor, the
   * address a label the next edit can renumber. It lives in the fixed header, so it is reserved out
   * of `maxBytes` before the comment is sized and a long comment truncates instead. Never stored:
   * not in the inbox entry, not in the journal. */
  address?: string;
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
  // A label for a block the note does not resolve to would be a guess, so an address rides only
  // with a source range, whatever the caller passed.
  const address = resolution.kind === "source_range" && opts.address ? opts.address : undefined;
  const fixed = [
    `glosa annotation ${id}`,
    `artifact: ${artifactPath}`,
    ...(typeof payload.previous_artifact_path === "string" ? [`was: ${payload.previous_artifact_path}`] : []),
    `intent: ${intent}`,
    `quote: ${JSON.stringify(quote)}`,
    ...(address ? [`address: ${address} ${ADDRESS_NOTE}`] : []),
    `position: ${JSON.stringify(target.position ?? null)}`,
    `resolution: ${JSON.stringify(resolution)}`,
    "comment:",
  ].join("\n");
  const maxBytes = opts.maxBytes ?? MAX_ENTRY_PRESENTATION_BYTES;
  const markerReserve = 512;
  // The protocol is part of the entry, so it is part of the entry's budget. Appending it after
  // the body was sized against `maxBytes` would push every large annotation over the cap.
  const protocol = APPLY_PROTOCOL(id, opts.sessionId);
  const allowedBodyBytes = Math.max(0, maxBytes - utf8Bytes(fixed) - utf8Bytes(protocol) - 1 - markerReserve);
  const sliced = truncateUtf8(remainingBody, allowedBodyBytes);
  const nextOffset = offset + sliced.value.length;
  const cursor = sliced.omitted > 0 ? encodeCursor(id, nextOffset) : undefined;
  const retrieve = retrieval(id, cursor);
  const marker = cursor
    ? `\n[truncated: ${sliced.omitted} UTF-8 bytes omitted; retrieve with ${retrieve.command} or MCP ${retrieve.mcp_tool}]`
    : "";
  const text = `${fixed}\n${sliced.value}${marker}\n${protocol}`;
  return {
    id,
    kind: "annotation",
    status: opts.status,
    text,
    bytes: utf8Bytes(text),
    detail: {
      artifact_path: artifactPath,
      body: sliced.value,
      intent,
      target,
      ...(address ? { address } : {}),
      resolution,
    },
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
  if (payload.operation && typeof payload.operation === "object") {
    const operation = payload.operation as Record<string, unknown>;
    const text = `glosa human_edit ${id}\n${operation.op}: ${operation.path}${operation.to ? ` → ${operation.to}` : ""}\ncheckpoints: ${payload.checkpoint_before}..${payload.checkpoint_after}`;
    if (utf8Bytes(text) > (opts.maxBytes ?? MAX_ENTRY_PRESENTATION_BYTES)) return null;
    return {
      id,
      kind: "human_edit",
      status: opts.status,
      text,
      bytes: utf8Bytes(text),
      detail: payload,
      truncation: { truncated: false, omitted_bytes: 0, omitted_hunks: 0 },
      retrieval: retrieval(id),
    };
  }
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

/** An artifact changed on disk and nothing glosa did accounts for it (#144, #153 Part 1).
 *
 * The opening line is the whole point of this branch existing. These hunks used to arrive through
 * `humanEditPresentation` — offline catch-up produced diffs with no kind of their own, and the
 * `human_edit` branch stamps `kind:"human_edit"` on whatever it is handed — so an agent was told a
 * person made an edit that glosa could not attribute to anyone. A4 §F05 is explicit that anything
 * outside a lease or the editor API is `unknown`, "never falsely human". So this states what is
 * known (a file changed, between these two checkpoints, observed this way) and refuses the part
 * that was invented (who did it).
 *
 * Hunks are bounded and cursored exactly like a human edit's — same budget, same continuation
 * cursor — because the truncation contract in A5 §F23 is about size, not about kind. */
function externalEditPresentation(
  id: string,
  payload: Record<string, unknown>,
  opts: BuildPresentationOptions,
): DeliverableEntry | null {
  const path = stringOf(payload.path);
  const since = stringOf(payload.since_checkpoint);
  const until = stringOf(payload.until_checkpoint);
  const diff = stringOf(payload.diff);
  if (!path || !since || !until || diff === null) return null;
  const source = payload.source === "live" ? "observed live" : "found by offline catch-up";
  const observedAt = stringOf(payload.observed_at);

  const fixed = [
    `glosa external_edit ${id}`,
    `artifact: ${path}`,
    `checkpoints: ${since}..${until}`,
    `observed: ${source}${observedAt ? ` at ${observedAt}` : ""}`,
    `${path} changed on disk outside glosa. attribution is "unknown": no proven claim interval or glosa`,
    "editor save covered this change, so glosa records WHAT changed and does not guess WHO changed",
    "it. there is nothing to apply: the change is already in the file. this is a record, not a",
    ...(opts.watched
      ? [
          "request. you are seeing it because your session explicitly called glosa_watch; nobody",
          `else was nudged by it; \`glosa inbox dismiss ${id}\` closes it.`,
        ]
      : [`request; \`glosa inbox dismiss ${id}\` closes it.`]),
  ].join("\n");

  const parsed = splitDiffHunks(diff);
  const chunks =
    parsed.hunks.length === 0 ? [parsed.header] : parsed.hunks.map((h, i) => `${i === 0 ? parsed.header : ""}${h}`);
  const maxBytes = opts.maxBytes ?? MAX_ENTRY_PRESENTATION_BYTES;
  const offset = Math.min(decodePresentationCursor(opts.cursor, id), chunks.length);
  let text = fixed;
  let includedCount = 0;
  for (const chunk of chunks.slice(offset)) {
    const addition = `\n\n${chunk.trimEnd()}`;
    if (utf8Bytes(text + addition) > maxBytes - 512) break;
    text += addition;
    includedCount += 1;
  }
  const omitted = chunks.slice(offset + includedCount);
  const omittedHunks = omitted.length;
  const omittedBytes = omitted.reduce((sum, chunk) => sum + utf8Bytes(chunk), 0);
  const cursor = omittedHunks > 0 ? encodeCursor(id, offset + includedCount) : undefined;
  const retrieve = retrieval(id, cursor);
  if (omittedHunks > 0) {
    text += `\n[truncated: ${omittedHunks} hunks / ${omittedBytes} UTF-8 bytes omitted; retrieve with ${retrieve.command} or MCP ${retrieve.mcp_tool}]`;
  }
  return {
    id,
    kind: "external_edit",
    status: opts.status,
    text,
    bytes: utf8Bytes(text),
    detail: {
      path,
      since_checkpoint: since,
      until_checkpoint: until,
      source: payload.source,
      ...(observedAt ? { observed_at: observedAt } : {}),
    },
    truncation: { truncated: omittedHunks > 0, omitted_bytes: omittedBytes, omitted_hunks: omittedHunks },
    retrieval: retrieve,
  };
}

function attentionPresentation(
  id: string,
  payload: Record<string, unknown>,
  opts: BuildPresentationOptions,
): DeliverableEntry {
  const path =
    typeof payload.target_path === "string"
      ? payload.target_path
      : typeof payload.path === "string"
        ? payload.path
        : undefined;
  const approvalMode = payload.approval_mode === true;
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
    ...(approvalMode ? { approval_mode: true } : {}),
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

/** One line per claim, appended after the body so the entry's own first line — the one every
 * transport keys on — never moves. */
function claimsBlock(kept: readonly PresentationClaim[], omitted: number): string {
  const lines = kept.map(
    (claim) =>
      `claimed: session ${claim.session} ${claim.mode === "exclusive" ? "is editing this" : "is looking at this"} since ${claim.since}${claim.fence !== null ? ` (fence ${claim.fence})` : ""}`,
  );
  if (omitted > 0) lines.push(`claimed: …and ${omitted} more`);
  return `\n${lines.join("\n")}`;
}

export function buildDeliveryPresentation(
  id: string,
  payloadInput: unknown,
  opts: BuildPresentationOptions,
): DeliverableEntry | null {
  const claims = opts.claims ?? [];
  if (claims.length === 0) return buildPresentationBody(id, payloadInput, opts);
  const ordered = [...claims].sort((a, b) => (a.mode === b.mode ? 0 : a.mode === "exclusive" ? -1 : 1));
  const kept = ordered.slice(0, MAX_PRESENTATION_CLAIMS);
  const omitted = ordered.length - kept.length;
  const block = claimsBlock(kept, omitted);
  const maxBytes = opts.maxBytes ?? MAX_ENTRY_PRESENTATION_BYTES;
  const body = buildPresentationBody(id, payloadInput, { ...opts, maxBytes: Math.max(0, maxBytes - utf8Bytes(block)) });
  if (!body) return null;
  const text = `${body.text}${block}`;
  return {
    ...body,
    text,
    bytes: utf8Bytes(text),
    claims: kept.map((claim) => ({ ...claim })),
    truncation: { ...body.truncation, ...(omitted > 0 ? { omitted_claims: omitted } : {}) },
  };
}

function buildPresentationBody(
  id: string,
  payloadInput: unknown,
  opts: BuildPresentationOptions,
): DeliverableEntry | null {
  const payload = recordOf(payloadInput);
  if (!payload) return null;
  if (payload.kind === "annotation") return annotationPresentation(id, payload, opts);
  if (payload.kind === "human_edit") return humanEditPresentation(id, payload, opts);
  if (payload.kind === "external_edit") return externalEditPresentation(id, payload, opts);
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

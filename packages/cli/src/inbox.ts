// SPDX-License-Identifier: Apache-2.0
import type { GlosaApiClient, InboxListResult } from "./api-client.ts";
import { type CommandEnvelope, daemonUnreachableEnvelope, EXIT_CODES, printJsonEnvelope } from "./envelope.ts";

export interface InboxListOptions {
  workspace: string;
  all?: boolean;
}

/** `glosa inbox list [--all] [--workspace <path>]`'s CLI-side half (issue #142). Only
 * `createClient()` is guarded here: a `list` has no per-entry failure mode (no id, no lease, no
 * 404/409 to map through `mapEntryFailure`'s shape) — anything `listInboxEntries` itself throws
 * is a real, unmapped daemon answer and is left to `run()`'s own boundary handler (exit 70),
 * exactly as `runInboxGet` already does today. */
export async function runInboxList(
  options: InboxListOptions,
  deps: { createClient: () => Promise<GlosaApiClient> },
): Promise<CommandEnvelope<InboxListResult>> {
  let client: GlosaApiClient;
  try {
    client = await deps.createClient();
  } catch (err) {
    return { ...daemonUnreachableEnvelope("inbox list", (err as Error).message), data: { entries: [] } };
  }
  const result = await client.listInboxEntries(options.workspace, { all: options.all });
  return { ok: true, command: "inbox list", exitCode: EXIT_CODES.OK, data: result, warnings: [] };
}

/** A coarse relative age for human-mode output only — `--json` always carries the raw ISO
 * `created_at` (D6). No relative-age precedent exists elsewhere in the CLI, so this stays local
 * rather than becoming a new shared utility for one caller. */
function formatAge(createdAt: string | null): string {
  if (!createdAt) return "-";
  const ms = Date.now() - new Date(createdAt).getTime();
  if (!Number.isFinite(ms)) return "-";
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

export function printInboxListResult(result: CommandEnvelope<InboxListResult>, json: boolean): void {
  if (json) {
    printJsonEnvelope(result);
    return;
  }
  if (!result.ok) {
    process.stderr.write(`glosa inbox list: ${result.error?.message ?? "failed"}\n`);
    return;
  }
  // Two-space-indented columns, matching status.ts's `  <slug>  <path>  pending=<n>` register.
  for (const entry of result.data.entries) {
    const payloadNote = entry.payload_present ? "" : "  [no payload]";
    process.stdout.write(
      `  ${entry.id}  ${entry.kind}  ${entry.status}  ${formatAge(entry.created_at)}  ${entry.target_path ?? "-"}${payloadNote}\n`,
    );
  }
}

export interface InboxGetOptions {
  workspace: string;
  id: string;
  cursor?: string;
}

export interface InboxGetResult {
  exitCode: number;
  presentation: Awaited<ReturnType<GlosaApiClient["getInboxPresentation"]>>["presentation"];
}

export async function runInboxGet(
  options: InboxGetOptions,
  deps: { createClient: () => Promise<GlosaApiClient> },
): Promise<InboxGetResult> {
  const client = await deps.createClient();
  const result = await client.getInboxPresentation(options.workspace, options.id, options.cursor);
  return { exitCode: EXIT_CODES.OK, presentation: result.presentation };
}

export function printInboxGetResult(result: InboxGetResult, json: boolean): void {
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ glosa_json: 1, ok: true, command: "inbox get", exit_code: 0, data: result.presentation })}\n`,
    );
    return;
  }
  process.stdout.write(`${result.presentation.text}\n`);
}

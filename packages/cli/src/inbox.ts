// SPDX-License-Identifier: Apache-2.0
import type { DismissResult, GlosaApiClient, InboxListResult } from "./api-client.ts";
import {
  type CommandEnvelope,
  daemonUnreachableEnvelope,
  EXIT_CODES,
  printJsonEnvelope,
  usageEnvelope,
} from "./envelope.ts";
import { mapEntryFailure } from "./resolve.ts";

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

export interface InboxGetData {
  presentation?: Awaited<ReturnType<GlosaApiClient["getInboxPresentation"]>>["presentation"];
}

/** `glosa inbox get <id> [--cursor <opaque>] [--workspace <path>]`'s CLI-side half. Brought onto
 * the same `CommandEnvelope` path `list` and `dismiss` use (issue #142) — previously this had NO
 * try/catch at all, so a daemon-unreachable failure escaped to `run()`'s last-resort boundary
 * handler and exited **70** instead of the A6-mandated 3; an unknown entry likewise fell through
 * to 70 instead of 8. Success output is unchanged: `printInboxGetResult` still emits the bare
 * presentation object as `data`, not this envelope's own `data` field, which now wraps it under
 * `.presentation` purely so the daemon-unreachable/entry-error paths have somewhere honest to put
 * `{}`. */
export async function runInboxGet(
  options: InboxGetOptions,
  deps: { createClient: () => Promise<GlosaApiClient> },
): Promise<CommandEnvelope<InboxGetData>> {
  let client: GlosaApiClient;
  try {
    client = await deps.createClient();
  } catch (err) {
    return { ...daemonUnreachableEnvelope("inbox get", (err as Error).message), data: {} };
  }
  try {
    const result = await client.getInboxPresentation(options.workspace, options.id, options.cursor);
    return {
      ok: true,
      command: "inbox get",
      exitCode: EXIT_CODES.OK,
      data: { presentation: result.presentation },
      warnings: [],
    };
  } catch (err) {
    return { ...mapEntryFailure("inbox get", err), data: {} };
  }
}

export function printInboxGetResult(result: CommandEnvelope<InboxGetData>, json: boolean): void {
  if (json) {
    if (!result.ok) {
      printJsonEnvelope(result);
      return;
    }
    // Byte-for-byte the same success shape this always emitted: `data` is the presentation
    // object itself, not `{presentation: ...}` — the envelope's own nesting is a failure-path
    // convenience only, never surfaced on success.
    process.stdout.write(
      `${JSON.stringify({ glosa_json: 1, ok: true, command: "inbox get", exit_code: 0, data: result.data.presentation })}\n`,
    );
    return;
  }
  if (!result.ok) {
    process.stderr.write(`glosa inbox get: ${result.error?.message ?? "failed"}\n`);
    return;
  }
  process.stdout.write(`${result.data.presentation?.text}\n`);
}

export interface InboxDismissOptions {
  workspace: string;
  id?: string;
  note?: string;
}

export interface InboxDismissData {
  entry?: string;
  status?: string;
  to?: string;
}

/** `glosa inbox dismiss <id> [--note "…"] [--workspace <path>]`'s CLI-side half (issue #142) — a
 * human closing an entry unread, with no `--session` anywhere in its shape: `dismissEntry` opens
 * no lease and claims no session, so there is nothing here for one to attribute. Entry failures
 * (unknown id, already terminal) share `resolve.ts`'s `mapEntryFailure` mapping, exactly as the
 * design calls for "one error contract for all three [entry-id] actions". */
export async function runInboxDismiss(
  options: InboxDismissOptions,
  deps: { createClient: () => Promise<GlosaApiClient> },
): Promise<CommandEnvelope<InboxDismissData>> {
  if (!options.id) return usageEnvelope("inbox dismiss", "inbox dismiss: missing <id>");

  let client: GlosaApiClient;
  try {
    client = await deps.createClient();
  } catch (err) {
    return { ...daemonUnreachableEnvelope("inbox dismiss", (err as Error).message), data: {} };
  }

  try {
    const result: DismissResult = await client.dismissEntry(options.workspace, options.id, options.note);
    return { ok: true, command: "inbox dismiss", exitCode: EXIT_CODES.OK, data: result, warnings: [] };
  } catch (err) {
    return { ...mapEntryFailure("inbox dismiss", err), data: {} };
  }
}

export function printInboxDismissResult(result: CommandEnvelope<InboxDismissData>, json: boolean): void {
  if (json) {
    printJsonEnvelope(result);
    return;
  }
  if (!result.ok) {
    process.stderr.write(`glosa inbox dismiss: ${result.error?.message ?? "failed"}\n`);
    return;
  }
  process.stdout.write(`glosa inbox dismiss: ${result.data.entry} -> ${result.data.to}\n`);
}

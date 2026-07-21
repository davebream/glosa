// SPDX-License-Identifier: Apache-2.0
// @glosa/cli — `glosa status [dir] --json` (A6 §F26). Never fails just because the daemon is
// down — that fact is reported IN `data`, exit 0, unless something else entirely goes wrong
// (internal error -> exit 70). Aggregates via the daemon's own `GET /api/status` (P5.1 addition,
// http.ts) rather than assembling client-side from several calls — one round trip, one failure
// mode, consistent with `daemon-client.ts`'s existing "the daemon decides the shape" convention.
//
// `[dir]` is accepted for grammar consistency with `doctor [dir]`, but v1's aggregate is always
// global (every present workspace, every registered session) — `status` answering "what's glosa
// doing right now" doesn't need to be scoped to one workspace to be useful, and scoping it would
// need a canonicalize-and-match step this thin a command doesn't otherwise need.
import type { GlosaApiClient, SessionStatusSummary, StatusSummary, WorkspaceStatusSummary } from "./api-client.ts";
import { type CommandEnvelope, EXIT_CODES, printJsonEnvelope } from "./envelope.ts";

export interface StatusData {
  daemon_reachable: boolean;
  daemon?: StatusSummary["daemon"];
  workspaces?: WorkspaceStatusSummary[];
  sessions?: SessionStatusSummary[];
  reason?: string;
}

export interface StatusDeps {
  createClient: () => Promise<GlosaApiClient>;
}

export async function runStatus(_dir: string, deps: StatusDeps): Promise<CommandEnvelope<StatusData>> {
  let client: GlosaApiClient;
  try {
    client = await deps.createClient();
  } catch (err) {
    return {
      ok: true,
      command: "status",
      exitCode: EXIT_CODES.OK,
      data: { daemon_reachable: false, reason: (err as Error).message },
      warnings: [],
    };
  }

  try {
    const summary = await client.getStatus();
    return {
      ok: true,
      command: "status",
      exitCode: EXIT_CODES.OK,
      data: { daemon_reachable: true, daemon: summary.daemon, workspaces: summary.workspaces, sessions: summary.sessions },
      warnings: [],
    };
  } catch (err) {
    // Reached the daemon (createClient succeeded above) but the status call itself failed — still
    // never a hard failure for `status`'s own contract: report what happened, still exit 0.
    return {
      ok: true,
      command: "status",
      exitCode: EXIT_CODES.OK,
      data: { daemon_reachable: false, reason: (err as Error).message },
      warnings: [{ code: "status-fetch-failed", message: (err as Error).message }],
    };
  }
}

export function printStatusResult(result: CommandEnvelope<StatusData>, json: boolean): void {
  if (json) {
    printJsonEnvelope(result);
    return;
  }
  if (!result.data.daemon_reachable) {
    process.stdout.write(`glosa status: daemon unreachable (${result.data.reason ?? "unknown reason"})\n`);
    return;
  }
  const wsCount = result.data.workspaces?.length ?? 0;
  const sessCount = result.data.sessions?.length ?? 0;
  process.stdout.write(`glosa status: daemon ${result.data.daemon?.instance_id} — ${wsCount} workspace(s), ${sessCount} session(s)\n`);
  for (const w of result.data.workspaces ?? []) {
    process.stdout.write(`  ${w.slug}  ${w.path}  pending=${w.pending_count}${w.has_attention ? " [attention]" : ""}\n`);
  }
}

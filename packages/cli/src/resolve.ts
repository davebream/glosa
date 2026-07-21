// SPDX-License-Identifier: Apache-2.0
// @glosa/cli — `glosa resolve <id> <applied|rejected|deferred|stale> --session <sid> [--note]`
// and `glosa apply-begin <id> --session <sid>` (A4 §F05 / A6 §F26). Both operate on the CURRENT
// WORKING DIRECTORY as the workspace root — neither command's documented argument grammar carries
// a separate workspace path, and both are meant to be invoked by an agent session sitting inside
// the workspace it's already working in (same as every `git`/`gh` subcommand's own cwd-scoping
// convention). `apply-begin` opens the F05 lease; `resolve` with `applied|rejected|stale` closes
// it (`WorkspaceBus.resolveEntry`, http.ts's `handleWorkspaceResolve`); `resolve ... deferred`
// does neither (see http.ts's docstring on that route, and `commitTransition`'s in bus.ts, for why
// deferred is a legal no-op transition rather than a lease-closing one).
import type { GlosaApiClient } from "./api-client.ts";
import { type CommandEnvelope, EXIT_CODES, daemonUnreachableEnvelope, printJsonEnvelope, usageEnvelope } from "./envelope.ts";
import { isApiError } from "./api-client.ts";

export type ResolveOutcomeArg = "applied" | "rejected" | "deferred" | "stale";
const RESOLVE_OUTCOMES: ReadonlySet<string> = new Set(["applied", "rejected", "deferred", "stale"]);

export interface ResolveDeps {
  createClient: () => Promise<GlosaApiClient>;
}

export interface ResolveArgs {
  dir: string;
  id?: string;
  outcome?: string;
  session?: string;
  note?: string;
}

export interface ResolveData {
  entry?: string;
  status?: string;
  to?: string;
  lease_id?: string;
  post_sha?: string;
}

/** Maps an entry-related daemon failure (unknown entry, no matching apply-begin lease, wrong
 * session) to exit 8 `entry_error` — anything that ISN'T an API-level (4xx/5xx-with-body) failure
 * is treated as daemon-unreachable instead, since it means the request never got a real answer at
 * all (network refused, `ensureDaemon` failed, ...). */
function mapEntryFailure(command: string, err: unknown): CommandEnvelope<Record<string, never>> {
  if (isApiError(err)) {
    return {
      ok: false,
      command,
      exitCode: EXIT_CODES.ENTRY_ERROR,
      data: {},
      warnings: [],
      error: { code: "entry-error", kind: "entry_error", message: err.problem?.title ?? err.message },
    };
  }
  return daemonUnreachableEnvelope(command, (err as Error).message);
}

export async function runResolve(args: ResolveArgs, deps: ResolveDeps): Promise<CommandEnvelope<ResolveData>> {
  if (!args.id) return usageEnvelope("resolve", "resolve: missing <id>");
  if (!args.outcome || !RESOLVE_OUTCOMES.has(args.outcome)) {
    return usageEnvelope("resolve", "resolve: <status> must be one of applied|rejected|deferred|stale");
  }
  if (!args.session) return usageEnvelope("resolve", "resolve: --session <sid> is required");

  let client: GlosaApiClient;
  try {
    client = await deps.createClient();
  } catch (err) {
    return { ...daemonUnreachableEnvelope("resolve", (err as Error).message), data: {} };
  }

  try {
    const result = await client.resolveEntry(args.dir, args.id, args.outcome as ResolveOutcomeArg, args.session, args.note);
    return { ok: true, command: "resolve", exitCode: EXIT_CODES.OK, data: result, warnings: [] };
  } catch (err) {
    return { ...mapEntryFailure("resolve", err), data: {} };
  }
}

export function printResolveResult(result: CommandEnvelope<ResolveData>, json: boolean): void {
  if (json) {
    printJsonEnvelope(result);
    return;
  }
  if (!result.ok) {
    process.stderr.write(`glosa resolve: ${result.error?.message ?? "failed"}\n`);
    return;
  }
  process.stdout.write(`glosa resolve: ${result.data.entry} -> ${result.data.to}\n`);
}

// ---------------------------------------------------------------------------------------------
// apply-begin
// ---------------------------------------------------------------------------------------------

export interface ApplyBeginArgs {
  dir: string;
  id?: string;
  session?: string;
}

export interface ApplyBeginData {
  entry?: string;
  lease_id?: string;
  pre_sha?: string;
}

export async function runApplyBegin(args: ApplyBeginArgs, deps: ResolveDeps): Promise<CommandEnvelope<ApplyBeginData>> {
  if (!args.id) return usageEnvelope("apply-begin", "apply-begin: missing <id>");
  if (!args.session) return usageEnvelope("apply-begin", "apply-begin: --session <sid> is required");

  let client: GlosaApiClient;
  try {
    client = await deps.createClient();
  } catch (err) {
    return { ...daemonUnreachableEnvelope("apply-begin", (err as Error).message), data: {} };
  }

  try {
    const result = await client.applyBegin(args.dir, args.id, args.session);
    return { ok: true, command: "apply-begin", exitCode: EXIT_CODES.OK, data: result, warnings: [] };
  } catch (err) {
    if (isApiError(err) && err.status === 409 && err.problem?.type?.includes("lease-conflict")) {
      return {
        ok: false,
        command: "apply-begin",
        exitCode: EXIT_CODES.LEASE_CONFLICT,
        data: {},
        warnings: [],
        error: { code: "lease-conflict", kind: "lease_conflict", message: err.problem?.title ?? "an apply-lease is already active" },
      };
    }
    return { ...mapEntryFailure("apply-begin", err), data: {} };
  }
}

export function printApplyBeginResult(result: CommandEnvelope<ApplyBeginData>, json: boolean): void {
  if (json) {
    printJsonEnvelope(result);
    return;
  }
  if (!result.ok) {
    process.stderr.write(`glosa apply-begin: ${result.error?.message ?? "failed"}\n`);
    return;
  }
  // "prints the lease token" (A6 §F26) — bare, so a caller can capture it with `$(...)`.
  process.stdout.write(`${result.data.lease_id}\n`);
}

// SPDX-License-Identifier: Apache-2.0
// @glosa/cli — `glosa claim <resource…> --session <sid> [--mode exclusive|presence]` and
// `glosa release <claim_id> --session <sid>` (issue #155). A claim says "this session is working on
// these resources"; a second session trying to take an exclusive claim over the same files is told
// who already holds them. `apply-begin` remains the one-entry shorthand for an exclusive claim.
//
// Resources are `entry:<inbox id>` or `artifact:<workspace-relative path>`. Both commands default to
// the current directory as the workspace and take `--workspace <path>` to name another, exactly as
// `apply-begin` and `resolve` do.
import type { ClaimResult, GlosaApiClient, ReleaseClaimResult } from "./api-client.ts";
import { isApiError } from "./api-client.ts";
import {
  type CommandEnvelope,
  daemonUnreachableEnvelope,
  EXIT_CODES,
  printJsonEnvelope,
  usageEnvelope,
} from "./envelope.ts";
import { mapEntryFailure } from "./resolve.ts";

export interface ClaimDeps {
  createClient: () => Promise<GlosaApiClient>;
}

export interface ClaimArgs {
  dir: string;
  resources: string[];
  session?: string;
  mode?: string;
}

export type ClaimData = Partial<ClaimResult>;

function resourceLooksValid(resource: string): boolean {
  return /^(entry|artifact):.+/.test(resource);
}

/** A conflict on a claim is the same condition apply-begin reports, so it keeps apply-begin's exit
 * 12 (A6 §F26) and carries the holder the daemon named in the problem title. */
function conflictEnvelope(command: string, err: unknown): CommandEnvelope<Record<string, never>> | null {
  if (!isApiError(err) || err.status !== 409 || !err.problem?.type?.endsWith("/claim-held")) return null;
  return {
    ok: false,
    command,
    exitCode: EXIT_CODES.LEASE_CONFLICT,
    data: {},
    warnings: [],
    error: { code: "claim-held", kind: "lease_conflict", message: err.problem.title ?? "another session holds this" },
  };
}

export async function runClaim(args: ClaimArgs, deps: ClaimDeps): Promise<CommandEnvelope<ClaimData>> {
  if (args.resources.length === 0) return usageEnvelope("claim", "claim: at least one <resource> is required");
  const invalid = args.resources.find((resource) => !resourceLooksValid(resource));
  if (invalid) {
    return usageEnvelope(
      "claim",
      `claim: ${JSON.stringify(invalid)} is not a resource: use entry:<id> or artifact:<workspace-relative path>`,
    );
  }
  if (!args.session) return usageEnvelope("claim", "claim: --session <sid> is required");
  const mode = args.mode ?? "exclusive";
  if (mode !== "exclusive" && mode !== "presence") {
    return usageEnvelope("claim", "claim: --mode must be exclusive or presence");
  }

  let client: GlosaApiClient;
  try {
    client = await deps.createClient();
  } catch (err) {
    return { ...daemonUnreachableEnvelope("claim", (err as Error).message), data: {} };
  }
  if (!client.claim) return { ...daemonUnreachableEnvelope("claim", "this client cannot take claims"), data: {} };

  try {
    const result = await client.claim(args.dir, args.resources, args.session, { mode });
    return { ok: true, command: "claim", exitCode: EXIT_CODES.OK, data: result, warnings: [] };
  } catch (err) {
    return { ...(conflictEnvelope("claim", err) ?? mapEntryFailure("claim", err)), data: {} };
  }
}

export function printClaimResult(result: CommandEnvelope<ClaimData>, json: boolean): void {
  if (json) {
    printJsonEnvelope(result);
    return;
  }
  if (!result.ok) {
    process.stderr.write(`glosa claim: ${result.error?.message ?? "failed"}\n`);
    return;
  }
  // The claim id alone on stdout, like apply-begin's lease id, so `$(glosa claim …)` captures it.
  process.stdout.write(`${result.data.claim_id}\n`);
  const verb = result.data.renewed ? "renewed" : "holding";
  process.stderr.write(
    `glosa claim: ${verb} ${result.data.mode} claim (fence ${result.data.fence ?? "none"}) until ${result.data.expires_at}\n`,
  );
}

export interface ReleaseArgs {
  dir: string;
  claimId?: string;
  session?: string;
}

export type ReleaseData = Partial<ReleaseClaimResult>;

export async function runRelease(args: ReleaseArgs, deps: ClaimDeps): Promise<CommandEnvelope<ReleaseData>> {
  if (!args.claimId) return usageEnvelope("release", "release: missing <claim_id>");
  if (!args.session) return usageEnvelope("release", "release: --session <sid> is required");

  let client: GlosaApiClient;
  try {
    client = await deps.createClient();
  } catch (err) {
    return { ...daemonUnreachableEnvelope("release", (err as Error).message), data: {} };
  }
  if (!client.releaseClaim) {
    return { ...daemonUnreachableEnvelope("release", "this client cannot release claims"), data: {} };
  }

  try {
    const result = await client.releaseClaim(args.dir, args.claimId, args.session);
    return { ok: true, command: "release", exitCode: EXIT_CODES.OK, data: result, warnings: [] };
  } catch (err) {
    return { ...(conflictEnvelope("release", err) ?? mapEntryFailure("release", err)), data: {} };
  }
}

export function printReleaseResult(result: CommandEnvelope<ReleaseData>, json: boolean): void {
  if (json) {
    printJsonEnvelope(result);
    return;
  }
  if (!result.ok) {
    process.stderr.write(`glosa release: ${result.error?.message ?? "failed"}\n`);
    return;
  }
  process.stdout.write(
    result.data.released
      ? `glosa release: released ${result.data.claim_id}\n`
      : `glosa release: ${result.data.claim_id} was already released\n`,
  );
}

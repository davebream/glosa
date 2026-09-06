// SPDX-License-Identifier: Apache-2.0
import { isApiError, type GlosaApiClient } from "./api-client.ts";
import { daemonUnreachableEnvelope, EXIT_CODES, printJsonEnvelope, type CommandEnvelope } from "./envelope.ts";

type SessionData = { bound?: boolean; session_id?: string };

export async function runSessionBind(
  workspace: string,
  sessionId: string,
  createClient: () => Promise<GlosaApiClient>,
  metadata: { provider?: string; cwd?: string } = {},
): Promise<CommandEnvelope<SessionData>> {
  let client: GlosaApiClient;
  try {
    client = await createClient();
  } catch (error) {
    return { ...daemonUnreachableEnvelope("session", (error as Error).message), data: {} };
  }
  try {
    const result = await client.bindSession!(workspace, sessionId, {
      cwd: metadata.cwd ?? process.cwd(),
      provider: metadata.provider,
      source: "cli",
    });
    return { ok: true, command: "session", exitCode: EXIT_CODES.OK, data: result, warnings: [] };
  } catch (error) {
    if (isApiError(error)) {
      return {
        ok: false,
        command: "session",
        exitCode: EXIT_CODES.ENTRY_ERROR,
        data: {},
        warnings: [],
        error: { code: "session-bind-failed", kind: "entry_error", message: error.problem?.title ?? error.message },
      };
    }
    return { ...daemonUnreachableEnvelope("session", (error as Error).message), data: {} };
  }
}

export function printSessionBindResult(result: CommandEnvelope<SessionData>, json: boolean): void {
  if (json) {
    printJsonEnvelope(result);
    return;
  }
  if (!result.ok) {
    process.stderr.write(`glosa session bind: ${result.error?.message ?? "failed"}\n`);
    return;
  }
  process.stdout.write(`glosa session bind: ${result.data.session_id} bound\n`);
}

export function discoverMcpIdentity(
  candidates: Array<{ session_id: string; provider: string; cwd: string; channelPush?: boolean } | null>,
  provider?: string,
) {
  const matches = candidates.filter(
    (candidate) => candidate !== null && (!provider || candidate.provider === provider),
  );
  if (provider && matches.length === 0 && candidates.some((candidate) => candidate !== null)) {
    throw new Error("provider does not match the host session");
  }
  if (matches.length > 1) throw new Error("multiple provider session identities found; supply an explicit provider");
  return matches[0] ?? null;
}

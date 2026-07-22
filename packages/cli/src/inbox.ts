// SPDX-License-Identifier: Apache-2.0
import type { GlosaApiClient } from "./api-client.ts";
import { EXIT_CODES } from "./envelope.ts";

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
    process.stdout.write(`${JSON.stringify({ glosa_json: 1, ok: true, command: "inbox get", exit_code: 0, data: result.presentation })}\n`);
    return;
  }
  process.stdout.write(`${result.presentation.text}\n`);
}

// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import type { WorkspaceMetadataDescriptor } from "../../daemon/src/adapters/workspace-metadata.ts";
import { isApiError, type GlosaApiClient } from "./api-client.ts";
import { daemonUnreachableEnvelope, EXIT_CODES, printJsonEnvelope, type CommandEnvelope } from "./envelope.ts";

export type MetadataData = {
  metadata?: WorkspaceMetadataDescriptor;
  replaced?: boolean;
  cleared?: boolean;
};

export async function runMetadata(
  args: { action: string; workspace: string; file?: string },
  createClient: () => Promise<GlosaApiClient>,
): Promise<CommandEnvelope<MetadataData>> {
  const command = "metadata";
  if (!new Set(["set", "show", "clear"]).has(args.action)) {
    return { ok: false, command, exitCode: EXIT_CODES.USAGE, data: {}, warnings: [], error: { code: "usage", kind: "usage", message: `unsupported metadata action '${args.action}'` } };
  }
  if (args.action === "set" && !args.file) {
    return { ok: false, command, exitCode: EXIT_CODES.USAGE, data: {}, warnings: [], error: { code: "usage", kind: "usage", message: "metadata set requires a descriptor file" } };
  }

  let descriptor: WorkspaceMetadataDescriptor | undefined;
  if (args.action === "set") {
    try {
      descriptor = JSON.parse(readFileSync(args.file as string, "utf8")) as WorkspaceMetadataDescriptor;
    } catch (error) {
      return { ok: false, command, exitCode: EXIT_CODES.USAGE, data: {}, warnings: [], error: { code: "invalid-descriptor", kind: "usage", message: `could not read descriptor JSON: ${(error as Error).message}` } };
    }
  }

  let client: GlosaApiClient;
  try {
    client = await createClient();
  } catch (error) {
    return { ...daemonUnreachableEnvelope(command, (error as Error).message), data: {} };
  }
  try {
    if (args.action === "set") {
      const result = await client.setMetadata!(args.workspace, descriptor as WorkspaceMetadataDescriptor);
      return { ok: true, command, exitCode: EXIT_CODES.OK, data: result, warnings: [] };
    }
    if (args.action === "show") {
      const metadata = await client.getMetadata!(args.workspace);
      if (!metadata) {
        return { ok: false, command, exitCode: EXIT_CODES.NOT_A_WORKSPACE, data: {}, warnings: [], error: { code: "metadata-not-found", kind: "not_found", message: "workspace metadata is not registered" } };
      }
      return { ok: true, command, exitCode: EXIT_CODES.OK, data: { metadata }, warnings: [] };
    }
    const result = await client.clearMetadata!(args.workspace);
    return { ok: true, command, exitCode: EXIT_CODES.OK, data: result, warnings: [] };
  } catch (error) {
    if (isApiError(error)) {
      return { ok: false, command, exitCode: error.status === 409 ? EXIT_CODES.ENTRY_ERROR : EXIT_CODES.USAGE, data: {}, warnings: [], error: { code: error.status === 409 ? "metadata-conflict" : "invalid-metadata", kind: error.status === 409 ? "conflict" : "validation", message: error.problem?.title ?? error.message } };
    }
    return { ...daemonUnreachableEnvelope(command, (error as Error).message), data: {} };
  }
}

export function printMetadataResult(result: CommandEnvelope<MetadataData>, json: boolean): void {
  if (json) return printJsonEnvelope(result);
  if (!result.ok) {
    process.stderr.write(`glosa metadata: ${result.error?.message ?? "failed"}\n`);
    return;
  }
  if (result.data.metadata) {
    process.stdout.write(`glosa metadata: ${result.data.metadata.id} (${result.data.metadata.artifacts.length} artifacts)\n`);
  } else {
    process.stdout.write(result.data.cleared ? "glosa metadata: cleared\n" : "glosa metadata: already clear\n");
  }
}

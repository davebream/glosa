// SPDX-License-Identifier: Apache-2.0
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { glosaHome } from "../../daemon/src/lifecycle/home.ts";
import {
  OpenAITranscriptionProvider,
  type OpenAIDictationCredentialStore,
} from "../../providers/openai-transcription/src/index.ts";
import { confirmOnTty } from "./confirm.ts";
import { type CommandEnvelope, EXIT_CODES, printJsonEnvelope } from "./envelope.ts";
export type DictationAction = "configure" | "status" | "disable";
export interface DictationOptions {
  provider?: string;
  json?: boolean;
}
export interface DictationData {
  state?: string;
  provider?: string;
  display_name?: string;
}
export interface DictationCommandDeps {
  home?: string;
  credentialStore?: OpenAIDictationCredentialStore;
  isTTY?: () => boolean;
  confirm?: (question: string) => Promise<boolean>;
  readKey?: () => Promise<string>;
  platform?: NodeJS.Platform;
}
async function readKey(): Promise<string> {
  const output = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  const input = createInterface({ input: process.stdin, output, terminal: true });
  process.stderr.write("OpenAI API key (hidden): ");
  try {
    return await input.question("");
  } finally {
    input.close();
    output.destroy();
    process.stderr.write("\n");
  }
}
export async function runDictation(
  action: DictationAction,
  options: DictationOptions = {},
  deps: DictationCommandDeps = {},
): Promise<CommandEnvelope<DictationData>> {
  const failure = (message: string, usage = false): CommandEnvelope<DictationData> => ({
    ok: false,
    command: "dictation",
    exitCode: usage ? EXIT_CODES.USAGE : EXIT_CODES.INTERNAL,
    data: { state: "error" },
    warnings: [],
    error: { code: "dictation-failed", kind: usage ? "usage" : "internal", message },
  });
  const provider = new OpenAITranscriptionProvider({
    home: deps.home ?? glosaHome(),
    credentialStore: deps.credentialStore,
  });
  try {
    if (action === "configure") {
      if (options.provider !== "openai") return failure("configure requires --provider openai", true);
      if (!["darwin", "linux"].includes(deps.platform ?? process.platform))
        return failure("Secure dictation storage requires macOS or Linux.", true);
      if (options.json || !(deps.isTTY ?? (() => Boolean(process.stdin.isTTY)))())
        return failure("Configure requires an interactive terminal. You can also use Settings > Dictation.", true);
      process.stderr.write(
        "Dictation sends microphone audio and up to 8 KiB of visible context to OpenAI after you stop recording. OpenAI API billing is separate. Text stays a draft. Cleanup starts off. Saving the key makes no network request.\n",
      );
      if (!(await (deps.confirm ?? confirmOnTty)("Enable OpenAI dictation with this data policy?")))
        return failure("Dictation was not configured.", true);
      const settings = await provider.settings();
      await provider.update({
        ...settings,
        enabled: true,
        context: true,
        cleanup: false,
        api_key: await (deps.readKey ?? readKey)(),
      });
    } else if (action === "disable") {
      await provider.remove((await provider.settings()).revision);
    }
    const status = await provider.status();
    return {
      ok: true,
      command: "dictation",
      exitCode: 0,
      data: { state: status.state, provider: "openai", display_name: "OpenAI" },
      warnings: [],
    };
  } catch {
    return failure(
      "Dictation settings could not be changed or read. Check secure storage and retry in Settings > Dictation.",
    );
  } finally {
    provider.dispose();
  }
}

export function printDictationResult(result: CommandEnvelope<DictationData>, json: boolean): void {
  if (json) {
    printJsonEnvelope(result);
    return;
  }
  if (!result.ok) {
    process.stderr.write(`glosa dictation: ${result.error?.message ?? "failed"}\n`);
    return;
  }
  const label = result.data.display_name ? ` (${result.data.display_name})` : "";
  process.stdout.write(`glosa dictation: ${result.data.state}${label}\n`);
  for (const warning of result.warnings) process.stderr.write(`glosa dictation: warning: ${warning.message}\n`);
}

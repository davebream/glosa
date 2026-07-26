// SPDX-License-Identifier: Apache-2.0
// @glosa/cli — minimal interactive yes/no confirmation for TTY-gated consent prompts (issue #78).
// Deliberately framework-free (Gunshi has no prompt facility) and stderr-bound: stdout carries
// command contracts (the `open` URL line, `--json` envelopes) and must stay prompt-free.
import { createInterface } from "node:readline/promises";

export interface ConfirmIo {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

/**
 * Ask a `[y/N]` question on stderr and resolve true only for an explicit yes.
 * Callers gate on TTY themselves — this helper never checks `isTTY` so tests can drive it
 * with plain streams.
 */
export async function confirmOnTty(question: string, io: ConfirmIo = {}): Promise<boolean> {
  const rl = createInterface({
    input: (io.input ?? process.stdin) as NodeJS.ReadableStream,
    output: (io.output ?? process.stderr) as NodeJS.WritableStream,
  });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    const normalized = answer.trim().toLowerCase();
    return normalized === "y" || normalized === "yes";
  } finally {
    rl.close();
  }
}

// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from "node:url";
import type { RuntimeCandidate } from "../../../daemon/src/agents/runtimes.ts";
export function codexRuntimeCandidate(architecture = process.arch): RuntimeCandidate {
  return {
    lockFile: fileURLToPath(new URL(`./runtime-locks/darwin-${architecture}.lock`, import.meta.url)),
    provider: "codex",
    version: "0.156.1",
    binaryPackage: "@openai/codex",
    binaryName: "codex",
    qualified: false,
    packages: { "@openai/codex": `0.156.1-darwin-${architecture}` },
  };
}

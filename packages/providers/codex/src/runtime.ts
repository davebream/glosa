// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from "node:url";
import { runtimeTarget, type RuntimeCandidate } from "../../../daemon/src/agents/runtimes.ts";
export function codexRuntimeCandidate(target = runtimeTarget()): RuntimeCandidate {
  const { platform, architecture } = runtimeTarget(target.platform, target.architecture, target.libc);
  return {
    ...target,
    lockFile: fileURLToPath(new URL(`./runtime-locks/${platform}-${architecture}.lock`, import.meta.url)),
    provider: "codex",
    version: "0.156.1",
    binaryPackage: "@openai/codex",
    binaryName: "codex",
    qualified: false,
    packages: { "@openai/codex": `0.156.1-${platform}-${architecture}` },
  };
}

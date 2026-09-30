// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from "node:url";
import { runtimeTarget, type RuntimeCandidate } from "../../../daemon/src/agents/runtimes.ts";

/** A candidate is installable for explicit qualification, not a claim of native compatibility. */
export function claudeRuntimeCandidate(target = runtimeTarget()): RuntimeCandidate {
  const { platform, architecture } = runtimeTarget(target.platform, target.architecture, target.libc);
  const native = `@anthropic-ai/claude-code-${platform}-${architecture}`;
  return {
    ...target,
    lockFile: fileURLToPath(new URL(`./runtime-locks/${platform}-${architecture}.lock`, import.meta.url)),
    provider: "claude-code",
    version: "2.1.280",
    sdkVersion: "0.3.280",
    binaryPackage: native,
    binaryName: "claude",
    sdkPackage: "@anthropic-ai/claude-agent-sdk",
    qualified: false,
    packages: {
      [native]: "2.1.280",
      "@anthropic-ai/claude-agent-sdk": "0.3.280",
      "@anthropic-ai/sdk": "0.93.0",
      "@modelcontextprotocol/sdk": "1.30.0",
      zod: "4.5.4",
    },
  };
}

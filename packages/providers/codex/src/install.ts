// SPDX-License-Identifier: Apache-2.0
import { join } from "node:path";
import type {
  InstallBin,
  InstallRoots,
  ProviderInstallDescriptor,
  ProviderInstallTarget,
} from "../../../daemon/src/index.ts";

function command(bin: InstallBin, ...args: string[]): string {
  return [bin.command, ...bin.args, ...args].join(" ");
}

function configPaths(roots: InstallRoots): string[] {
  return [
    join(roots.workspace, ".codex", "hooks.json"),
    join(roots.workspace, ".codex", "config.toml"),
    join(roots.home, ".codex", "hooks.json"),
    join(roots.home, ".codex", "config.toml"),
  ];
}

export const codexInstallDescriptor: ProviderInstallDescriptor = {
  id: "codex",
  displayName: "Codex",
  supportedScopes: ["workspace", "user"],
  detect(roots, deps) {
    return deps.which("codex") !== null || configPaths(roots).some(deps.exists);
  },
  targets(scope, roots, bin): ProviderInstallTarget[] {
    const base = scope === "user" ? roots.home : roots.workspace;
    return [
      {
        key: "hooks",
        kind: "hooks-json",
        path: join(base, ".codex", "hooks.json"),
        hooks: [
          {
            event: "SessionStart",
            role: "session-start",
            command: command(bin, "hook", "session-start", "--provider", "codex"),
            timeout: 10,
          },
          {
            event: "SessionEnd",
            role: "session-end",
            command: command(bin, "hook", "session-end", "--provider", "codex"),
            timeout: 5,
          },
          {
            event: "UserPromptSubmit",
            role: "user-prompt-submit",
            command: command(bin, "hook", "user-prompt-submit", "--provider", "codex"),
            timeout: 10,
          },
          { event: "Stop", role: "stop", command: command(bin, "hook", "stop", "--provider", "codex"), timeout: 10 },
        ],
      },
      {
        key: "mcp",
        kind: "mcp-toml",
        path: join(base, ".codex", "config.toml"),
        startMarker: "# glosa:begin mcp_servers.glosa",
        endMarker: "# glosa:end mcp_servers.glosa",
      },
    ];
  },
  activationHelp: [],
};

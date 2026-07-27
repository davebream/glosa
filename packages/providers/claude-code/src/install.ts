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
    join(roots.workspace, ".claude", "settings.json"),
    join(roots.workspace, ".mcp.json"),
    join(roots.home, ".claude", "settings.json"),
    join(roots.home, ".claude.json"),
  ];
}

export const claudeCodeInstallDescriptor: ProviderInstallDescriptor = {
  id: "claude-code",
  displayName: "Claude Code",
  supportedScopes: ["workspace", "user"],
  detect(roots, deps) {
    return deps.which("claude") !== null || configPaths(roots).some(deps.exists);
  },
  targets(scope, roots, bin): ProviderInstallTarget[] {
    const user = scope === "user";
    const base = user ? roots.home : roots.workspace;
    const matcher = "startup|resume|clear|compact";
    return [
      {
        key: "hooks",
        kind: "hooks-json",
        path: join(base, ".claude", "settings.json"),
        hooks: [
          {
            event: "SessionStart",
            matcher,
            role: "session-start",
            command: command(bin, "hook", "session-start"),
            timeout: 10,
          },
          {
            event: "SessionStart",
            matcher,
            role: "rewake-watch",
            command: command(bin, "hook", "rewake-watch"),
            asyncRewake: true,
          },
          { event: "SessionEnd", role: "session-end", command: command(bin, "hook", "session-end"), timeout: 5 },
          {
            event: "UserPromptSubmit",
            role: "user-prompt-submit",
            command: command(bin, "hook", "user-prompt-submit"),
            timeout: 10,
          },
          { event: "Stop", role: "stop", command: command(bin, "hook", "stop"), timeout: 10 },
          { event: "Notification", role: "notification", command: command(bin, "hook", "notification"), timeout: 5 },
        ],
      },
      {
        key: "mcp",
        kind: "mcp-json",
        path: user ? join(roots.home, ".claude.json") : join(roots.workspace, ".mcp.json"),
      },
    ];
  },
  activationHelp: ["claude --dangerously-load-development-channels server:glosa"],
};

// SPDX-License-Identifier: Apache-2.0
import { join } from "node:path";
import type {
  InstallBin,
  InstallRoots,
  ProviderDetectionDeps,
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

/**
 * Where THIS Claude Code reads its user-scope configuration.
 *
 * `$CLAUDE_CONFIG_DIR` relocates the whole directory, and account switchers use exactly that to
 * give each account its own config root. Ignoring it means `glosa init --scope user` run inside
 * such a session writes `~/.claude/settings.json` — a file that session never reads — and reports
 * success. The variable name is Claude's, so resolving it belongs here and not in the generic core.
 *
 * The two files are NOT siblings by default: settings live in `~/.claude/`, while `.claude.json`
 * sits beside it in the home directory. When the directory is relocated, both move inside it.
 */
function userConfig(roots: InstallRoots, deps: ProviderDetectionDeps): { settings: string; mcp: string } {
  const configured = deps.env("CLAUDE_CONFIG_DIR");
  if (configured) return { settings: join(configured, "settings.json"), mcp: join(configured, ".claude.json") };
  return { settings: join(roots.home, ".claude", "settings.json"), mcp: join(roots.home, ".claude.json") };
}

export const claudeCodeInstallDescriptor: ProviderInstallDescriptor = {
  id: "claude-code",
  displayName: "Claude Code",
  supportedScopes: ["workspace", "user"],
  detect(roots, deps) {
    return deps.which("claude") !== null || configPaths(roots).some(deps.exists);
  },
  targets(scope, roots, bin, deps): ProviderInstallTarget[] {
    const user = scope === "user";
    const config = userConfig(roots, deps);
    const matcher = "startup|resume|clear|compact";
    return [
      {
        key: "hooks",
        kind: "hooks-json",
        path: user ? config.settings : join(roots.workspace, ".claude", "settings.json"),
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
        path: user ? config.mcp : join(roots.workspace, ".mcp.json"),
      },
    ];
  },
  activationHelp: ["claude --dangerously-load-development-channels server:glosa"],
};

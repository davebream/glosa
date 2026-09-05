// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { claudeCodeInstallDescriptor } from "../src/install.ts";

const roots = { workspace: "/workspace", home: "/home/test", glosaHome: "/home/test/.glosa" };
const bin = { command: "/bin/bun", args: ["run", "glosa.ts"] };
/** Host capabilities, with a pinned environment. Never the real one: a developer running this
 * suite inside an account-switcher session has CLAUDE_CONFIG_DIR pointed at live agent config. */
const deps = (env: Record<string, string> = {}) => ({
  exists: () => false,
  which: () => null,
  env: (name: string) => env[name],
});

describe("Claude Code onboarding descriptor", () => {
  test("owns workspace/user paths and the locked activation command", () => {
    expect(claudeCodeInstallDescriptor.targets("workspace", roots, bin, deps()).map((target) => target.path)).toEqual([
      join(roots.workspace, ".claude", "settings.json"),
      join(roots.workspace, ".mcp.json"),
    ]);
    expect(claudeCodeInstallDescriptor.targets("user", roots, bin, deps()).map((target) => target.path)).toEqual([
      join(roots.home, ".claude", "settings.json"),
      join(roots.home, ".claude.json"),
    ]);
    expect(claudeCodeInstallDescriptor.activationHelp).toEqual([
      "claude --dangerously-load-development-channels server:glosa",
    ]);
  });

  test("detection is local executable/config inspection", () => {
    expect(claudeCodeInstallDescriptor.detect(roots, { ...deps(), which: () => "/bin/claude" })).toBe(true);
    expect(
      claudeCodeInstallDescriptor.detect(roots, {
        ...deps(),
        exists: (path) => path === join(roots.workspace, ".claude", "settings.json"),
      }),
    ).toBe(true);
    expect(claudeCodeInstallDescriptor.detect(roots, deps())).toBe(false);
  });

  // An account switcher gives every account its own Claude config directory and runs Claude with
  // CLAUDE_CONFIG_DIR pointed at it. Ignoring that wrote `~/.claude/settings.json` — a file the
  // session doing the asking never reads — and reported success.
  test("user scope follows CLAUDE_CONFIG_DIR when Claude Code has been relocated", () => {
    const relocated = "/home/test/.ccs/instances/work";
    expect(
      claudeCodeInstallDescriptor
        .targets("user", roots, bin, deps({ CLAUDE_CONFIG_DIR: relocated }))
        .map((target) => target.path),
    ).toEqual([join(relocated, "settings.json"), join(relocated, ".claude.json")]);
  });

  test("workspace scope is unaffected by CLAUDE_CONFIG_DIR", () => {
    // Project-scoped config is resolved from the project, not from the user's config root.
    expect(
      claudeCodeInstallDescriptor
        .targets("workspace", roots, bin, deps({ CLAUDE_CONFIG_DIR: "/home/test/.ccs/instances/work" }))
        .map((target) => target.path),
    ).toEqual([join(roots.workspace, ".claude", "settings.json"), join(roots.workspace, ".mcp.json")]);
  });

  test("an empty CLAUDE_CONFIG_DIR is not a relocation", () => {
    expect(
      claudeCodeInstallDescriptor.targets("user", roots, bin, deps({ CLAUDE_CONFIG_DIR: "" })).map((t) => t.path),
    ).toEqual([join(roots.home, ".claude", "settings.json"), join(roots.home, ".claude.json")]);
  });
});

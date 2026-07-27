// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { claudeCodeInstallDescriptor } from "../src/install.ts";

const roots = { workspace: "/workspace", home: "/home/test", glosaHome: "/home/test/.glosa" };
const bin = { command: "/bin/bun", args: ["run", "glosa.ts"] };

describe("Claude Code onboarding descriptor", () => {
  test("owns workspace/user paths and the locked activation command", () => {
    expect(claudeCodeInstallDescriptor.targets("workspace", roots, bin).map((target) => target.path)).toEqual([
      join(roots.workspace, ".claude", "settings.json"),
      join(roots.workspace, ".mcp.json"),
    ]);
    expect(claudeCodeInstallDescriptor.targets("user", roots, bin).map((target) => target.path)).toEqual([
      join(roots.home, ".claude", "settings.json"),
      join(roots.home, ".claude.json"),
    ]);
    expect(claudeCodeInstallDescriptor.activationHelp).toEqual([
      "claude --dangerously-load-development-channels server:glosa",
    ]);
  });

  test("detection is local executable/config inspection", () => {
    expect(claudeCodeInstallDescriptor.detect(roots, { exists: () => false, which: () => "/bin/claude" })).toBe(true);
    expect(
      claudeCodeInstallDescriptor.detect(roots, {
        exists: (path) => path === join(roots.workspace, ".claude", "settings.json"),
        which: () => null,
      }),
    ).toBe(true);
    expect(claudeCodeInstallDescriptor.detect(roots, { exists: () => false, which: () => null })).toBe(false);
  });
});

// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { codexInstallDescriptor } from "../src/install.ts";

const roots = { workspace: "/workspace", home: "/home/test", glosaHome: "/home/test/.glosa" };
const bin = { command: "/bin/bun", args: ["run", "glosa.ts"] };
const deps = { exists: () => false, which: () => null, env: () => undefined };

describe("Codex onboarding descriptor", () => {
  test("owns workspace and user hook/MCP paths", () => {
    expect(codexInstallDescriptor.targets("workspace", roots, bin, deps).map((target) => target.path)).toEqual([
      join(roots.workspace, ".codex", "hooks.json"),
      join(roots.workspace, ".codex", "config.toml"),
    ]);
    expect(codexInstallDescriptor.targets("user", roots, bin, deps).map((target) => target.path)).toEqual([
      join(roots.home, ".codex", "hooks.json"),
      join(roots.home, ".codex", "config.toml"),
    ]);
  });

  test("detection is local executable/config inspection", () => {
    expect(codexInstallDescriptor.detect(roots, { ...deps, which: () => "/bin/codex" })).toBe(true);
    expect(
      codexInstallDescriptor.detect(roots, {
        ...deps,
        exists: (path) => path === join(roots.home, ".codex", "config.toml"),
      }),
    ).toBe(true);
    expect(codexInstallDescriptor.detect(roots, deps)).toBe(false);
  });
});

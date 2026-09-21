// SPDX-License-Identifier: Apache-2.0
//
// Installs the plugin into a throwaway Claude Code config and asserts it loads clean.
//
// `test/plugin-manifest.test.ts` encodes the documented contract. This one observes the runtime,
// which is the only thing that actually decides. It is the check that would have caught #305 on
// the day it shipped: `claude plugin validate` passes on the broken manifest, and so does
// `--strict`, because both read only `plugin.json`.
//
// It asserts on `errors`, NOT on `enabled`. A plugin whose monitors fail to parse still reports
// `enabled: true` — verified against Claude Code 2.1.278 with both manifest shapes. Asserting
// `enabled` would pass on exactly the failure this test exists to catch.
//
// `claude` is not installed on CI runners, so this skips there. That makes it a local and
// pre-release gate, not a CI gate; the CI gate is plugin-manifest.test.ts. The skip is noisy on
// purpose, so a permanently skipped check is visible rather than silently green.
import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import rootPackage from "../package.json" with { type: "json" };

const root = resolve(import.meta.dir, "..");

interface InstalledPlugin {
  id: string;
  version: string;
  enabled: boolean;
  errors?: string[];
  errorDetails?: unknown[];
}

function claudeOnPath(): string | null {
  const which = Bun.spawnSync({ cmd: ["which", "claude"], stdout: "pipe", stderr: "pipe" });
  return which.exitCode === 0 ? which.stdout.toString().trim() : null;
}

const claude = claudeOnPath();

describe("the plugin loads in a real Claude Code install", () => {
  test("installing glosa from a scratch marketplace reports no load errors (#305)", () => {
    if (!claude) {
      console.warn(
        "SKIPPED: `claude` is not on PATH, so the real plugin load was not exercised. " +
          "This is expected on CI runners; run it locally before a release.",
      );
      return;
    }

    const temp = mkdtempSync(join(tmpdir(), "glosa-plugin-load-"));
    try {
      const marketplace = join(temp, "market");
      const config = join(temp, "config");
      mkdirSync(join(marketplace, ".claude-plugin"), { recursive: true });
      mkdirSync(config, { recursive: true });
      cpSync(join(root, "glosa-plugin"), join(marketplace, "glosa-plugin"), { recursive: true });
      writeFileSync(
        join(marketplace, ".claude-plugin", "marketplace.json"),
        `${JSON.stringify(
          {
            name: "glosa-scratch",
            owner: { name: "acceptance" },
            plugins: [{ name: "glosa", source: "./glosa-plugin", description: "acceptance install" }],
          },
          null,
          2,
        )}\n`,
      );

      // CLAUDE_CONFIG_DIR keeps every write inside the temp tree; the real config is never touched.
      const env = { ...process.env, CLAUDE_CONFIG_DIR: config };
      const run = (args: string[]): string => {
        const child = Bun.spawnSync({ cmd: [claude, ...args], cwd: temp, env, stdout: "pipe", stderr: "pipe" });
        if (child.exitCode !== 0)
          throw new Error(`claude ${args.join(" ")} exited ${child.exitCode}\n${child.stderr.toString()}`);
        return child.stdout.toString();
      };

      run(["plugin", "marketplace", "add", marketplace]);
      run(["plugin", "install", "glosa@glosa-scratch"]);
      const installed = JSON.parse(run(["plugin", "list", "--json"])) as InstalledPlugin[];

      const entry = installed.find((plugin) => plugin.id === "glosa@glosa-scratch");
      expect(entry, "glosa was not installed").toBeDefined();
      // The load-bearing assertion. `enabled` stays true even when a component fails to parse.
      expect(entry!.errors ?? [], "the plugin reported load errors").toEqual([]);
      expect(entry!.errorDetails ?? [], "the plugin reported component load failures").toEqual([]);
      // Claude Code caches by version, so a drifted plugin.json would strand users on the
      // broken copy. This is the same invariant version-sync enforces, observed after a real install.
      expect(entry!.version).toBe(rootPackage.version);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }, 120_000);
});

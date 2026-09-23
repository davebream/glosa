// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeCatalog, type RuntimeCandidate } from "../../src/agents/runtimes.ts";
import type { ProcessLauncher } from "../../src/agents/interface.ts";

test("runtime installation freezes dependencies, excludes lifecycle scripts and rejects modified executable bytes", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "glosa-runtime-install-")));
  const lockFile = join(root, "release.lock");
  writeFileSync(lockFile, "fixture dependency lock");
  const candidate: RuntimeCandidate = {
    provider: "fixture",
    version: "1",
    packages: { fixture: "1" },
    binaryPackage: "fixture",
    binaryName: "native",
    qualified: false,
    lockFile,
  };
  const catalog = new RuntimeCatalog(root, [candidate]);
  const calls: Parameters<ProcessLauncher["spawn"]>[0][] = [];
  const launcher: ProcessLauncher = {
    async spawn(options) {
      calls.push(options);
      // Stand-in for package extraction, never a vendor process or a network compatibility claim.
      expect(readFileSync(join(options.cwd, "bun.lock"), "utf8")).toBe("fixture dependency lock");
      mkdirSync(join(options.cwd, "node_modules", "fixture"), { recursive: true });
      writeFileSync(join(options.cwd, "node_modules", "fixture", "native"), "fixture executable bytes");
      return {
        pid: 1,
        exited: Promise.resolve({ code: 0, signal: null, groupEmpty: true }),
        async write() {},
        async fence() {},
        async stop() {},
        resize() {},
      };
    },
  };
  try {
    expect(catalog.status("fixture").installed).toBe(false);
    const installed = await catalog.install("fixture", launcher);
    expect(installed.qualified).toBe(false);
    expect(calls[0]!.args).toContain("--frozen-lockfile");
    expect(calls[0]!.args).toContain("--ignore-scripts");
    expect(calls[0]!.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(calls[0]!.env.HOME).not.toBe(process.env.HOME);
    expect((await catalog.install("fixture", launcher)).id).toBe(installed.id);
    expect(calls).toHaveLength(1);
    writeFileSync(installed.executable, "modified executable");
    expect(() => catalog.manifest("fixture")).toThrow("integrity verification");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

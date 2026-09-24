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
  let fail = false;
  const launcher: ProcessLauncher = {
    async spawn(options) {
      calls.push(options);
      expect(catalog.status("fixture").installation?.phase).toBe("preparing");
      const report = (text: string) => options.onData("stderr", new TextEncoder().encode(text));
      // Native Bun verbose output, captured with a slow loopback fixture registry.
      // Chunks can split both lines and archive counters; only safe derived fields reach clients.
      report(" HTTP/1.1 GET https://registry.npmjs.org/fixture/-/fixture.tgz\nAuthorization: private-token\n");
      expect(catalog.status("fixture").installation?.phase).toBe("downloading");
      report("[fixture] Streamed 2.1 ");
      expect(catalog.status("fixture").installation?.packagesCompleted).toBe(0);
      report("MB tarball → 2 entries\n[another] Streamed 512 kB tarball → 1 entries\n");
      expect(catalog.status("fixture").installation).toEqual({
        phase: "downloading",
        startedAt: expect.any(Number),
        updatedAt: expect.any(Number),
        packagesCompleted: 2,
        bytesCompleted: 2_612_000,
      });
      await expect(
        catalog.install("fixture", {
          async spawn() {
            throw new Error("duplicate installation launched");
          },
        }),
      ).rejects.toThrow("already running");
      report("Resolved, downloaded and extracted [3]\n");
      expect(catalog.status("fixture").installation?.phase).toBe("installing");
      // Stand-in for package extraction, never a vendor process or a network compatibility claim.
      expect(readFileSync(join(options.cwd, "bun.lock"), "utf8")).toBe("fixture dependency lock");
      mkdirSync(join(options.cwd, "node_modules", "fixture"), { recursive: true });
      writeFileSync(join(options.cwd, "node_modules", "fixture", "native"), "fixture executable bytes");
      return {
        pid: 1,
        exited: Promise.resolve({ code: fail ? 1 : 0, signal: null, groupEmpty: true }),
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
    expect(catalog.status("fixture").installation?.phase).toBe("complete");
    expect(calls[0]!.args).toContain("--frozen-lockfile");
    expect(calls[0]!.args).toContain("--ignore-scripts");
    expect(calls[0]!.args).toContain("--verbose");
    expect(calls[0]!.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(calls[0]!.env.HOME).not.toBe(process.env.HOME);
    expect((await catalog.install("fixture", launcher)).id).toBe(installed.id);
    expect(calls).toHaveLength(1);
    writeFileSync(installed.executable, "modified executable");
    expect(() => catalog.manifest("fixture")).toThrow("integrity verification");
    fail = true;
    await expect(catalog.install("fixture", launcher)).rejects.toThrow("could not be installed");
    expect(catalog.status("fixture").installation?.phase).toBe("failed");
    expect(readFileSync(installed.executable, "utf8")).toBe("modified executable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

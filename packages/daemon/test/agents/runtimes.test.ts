// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeCatalog, runtimeTarget, type RuntimeCandidate } from "../../src/agents/runtimes.ts";
import type { ProcessLauncher } from "../../src/agents/interface.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "glosa-runtime-tree-")));
  roots.push(root);
  const lockFile = join(root, "release.lock");
  writeFileSync(lockFile, "fixture frozen dependency lock");
  const candidate: RuntimeCandidate = {
    ...runtimeTarget(),
    provider: "fixture",
    version: "1",
    lockFile,
    packages: { fixture: "1", sdk: "1", dependency: "1" },
    binaryPackage: "fixture",
    binaryName: "native",
    sdkPackage: "sdk",
    qualified: false,
  };
  const catalog = new RuntimeCatalog(root, [candidate]);
  let fail = false,
    omitSdk = false,
    calls = 0;
  // Only extraction is simulated. Catalog installation, disk hashes, manifest and repair are real.
  const launcher: ProcessLauncher = {
    async spawn(options) {
      calls++;
      for (const [file, bytes] of Object.entries({
        "fixture/native": "executable",
        "sdk/sdk.mjs": "export const fixture = true;",
        "dependency/index.js": "dependency",
      })) {
        if (omitSdk && file.startsWith("sdk/")) continue;
        const path = join(options.cwd, "node_modules", file);
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, bytes);
      }
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
  return {
    root,
    candidate,
    catalog,
    launcher,
    calls: () => calls,
    fail: (value: boolean) => {
      fail = value;
    },
    omitSdk: (value: boolean) => {
      omitSdk = value;
    },
  };
}

test.each([
  ["win32", "x64", ""],
  ["linux", "arm64", "glibc"],
  ["linux", "x64", "musl"],
  ["linux", "x64", ""],
  ["darwin", "ia32", ""],
])("managed runtime target refuses %s/%s/%s", (platform, arch, libc) => {
  expect(() => runtimeTarget(platform, arch, libc)).toThrow("Managed runtimes require");
});

test("a foreign platform candidate fails before filesystem installation or launch", async () => {
  const f = fixture();
  f.candidate.platform = process.platform === "darwin" ? "linux" : "darwin";
  await expect(f.catalog.install("fixture", f.launcher)).rejects.toThrow("does not match");
  expect(() => f.catalog.manifest("fixture")).toThrow("does not match");
  expect(f.calls()).toBe(0);
  expect(existsSync(join(f.root, "runtimes"))).toBe(false);
});

test.each(["fixture/native", "sdk/sdk.mjs", "dependency/index.js", "../bun.lock"])(
  "installed tree refuses changed %s bytes and preserves them through failed repair",
  async (file) => {
    const f = fixture(),
      installed = await f.catalog.install("fixture", f.launcher);
    const root = join(f.root, "runtimes", installed.id),
      path = join(root, "node_modules", file);
    writeFileSync(path, "tampered bytes");
    expect(() => f.catalog.manifest("fixture")).toThrow("integrity verification");
    f.fail(true);
    await expect(f.catalog.install("fixture", f.launcher)).rejects.toThrow("could not be installed");
    expect(readFileSync(path, "utf8")).toBe("tampered bytes");
    expect(readdirSync(join(f.root, "runtimes"))).toEqual([installed.id]);
    f.fail(false);
    f.omitSdk(true);
    await expect(f.catalog.install("fixture", f.launcher)).rejects.toThrow("could not be installed");
    expect(readFileSync(path, "utf8")).toBe("tampered bytes");
    expect(readdirSync(join(f.root, "runtimes"))).toEqual([installed.id]);
    f.omitSdk(false);
    const repaired = await f.catalog.install("fixture", f.launcher);
    expect(repaired.qualified).toBe(false);
    expect(f.catalog.manifest("fixture")?.id).toBe(installed.id);
    const quarantine = readdirSync(join(f.root, "runtimes")).find((name) =>
      name.startsWith(`${installed.id}.quarantine-`),
    );
    expect(quarantine).toBeDefined();
    expect(readFileSync(join(f.root, "runtimes", quarantine!, "node_modules", file), "utf8")).toBe("tampered bytes");
  },
);

test.each(["platform", "architecture", "libc", "missing-platform", "missing-sdk", "qualification"])(
  "installed manifest refuses %s forgery even with unchanged installed bytes",
  async (change) => {
    const f = fixture(),
      installed = await f.catalog.install("fixture", f.launcher);
    const path = join(f.root, "runtimes", installed.id, "manifest.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    if (change === "platform") manifest.platform = process.platform === "linux" ? "darwin" : "linux";
    if (change === "architecture") manifest.architecture = process.arch === "x64" ? "arm64" : "x64";
    if (change === "libc") manifest.libc = process.platform === "linux" ? undefined : "glibc";
    if (change === "missing-platform") delete manifest.platform;
    if (change === "missing-sdk") {
      delete manifest.sdkModule;
      delete manifest.sdkSha256;
    }
    if (change === "qualification") manifest.qualified = true;
    writeFileSync(path, JSON.stringify(manifest));
    expect(() => f.catalog.manifest("fixture")).toThrow("integrity verification");
  },
);

test.each(["rename failure", "published tree changed"])(
  "repair restores the rejected installation after %s",
  async (failure) => {
    const f = fixture(),
      installed = await f.catalog.install("fixture", f.launcher);
    writeFileSync(installed.executable, "rejected original bytes");
    const rename = fs.renameSync;
    const fault = spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(from).split("/").at(-1)?.startsWith(".install-")) {
        if (failure === "rename failure") throw new Error("fixture publication failure");
        rename(from, to);
        writeFileSync(installed.executable, "changed during publication");
      } else rename(from, to);
    });
    try {
      await expect(f.catalog.install("fixture", f.launcher)).rejects.toThrow("Existing installations were preserved");
      expect(readFileSync(installed.executable, "utf8")).toBe("rejected original bytes");
      expect(readdirSync(join(f.root, "runtimes"))).toEqual([installed.id]);
      expect(() => f.catalog.manifest("fixture")).toThrow("integrity verification");
    } finally {
      fault.mockRestore();
    }
  },
);

test("legacy runtime identities require foreground reinstall without changing legacy files or account data", async () => {
  const f = fixture();
  const oldId = `fixture-1-${process.arch}-${createHash("sha256").update(readFileSync(f.candidate.lockFile)).digest("hex").slice(0, 16)}`;
  const oldRoot = join(f.root, "runtimes", oldId);
  mkdirSync(oldRoot, { recursive: true });
  const legacy = JSON.stringify({ id: oldId, architecture: process.arch });
  writeFileSync(join(oldRoot, "manifest.json"), legacy);
  writeFileSync(join(f.root, "profile-and-history"), "unchanged account data");
  expect(f.catalog.manifest("fixture")).toBeUndefined();
  expect(f.catalog.status("fixture").installed).toBe(false);
  expect(f.calls()).toBe(0);
  const installed = await f.catalog.install("fixture", f.launcher);
  expect(installed.id).toContain(`-${process.platform}-${process.arch}-`);
  if (process.platform === "linux") expect(installed.id).toContain("-glibc-");
  expect(installed.id).not.toBe(oldId);
  expect(readFileSync(join(oldRoot, "manifest.json"), "utf8")).toBe(legacy);
  expect(readFileSync(join(f.root, "profile-and-history"), "utf8")).toBe("unchanged account data");
  expect(installed.qualified).toBe(false);
});

test("runtime installation freezes dependencies, excludes lifecycle scripts and rejects modified executable bytes", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "glosa-runtime-install-")));
  const lockFile = join(root, "release.lock");
  writeFileSync(lockFile, "fixture dependency lock");
  const candidate: RuntimeCandidate = {
    ...runtimeTarget(),
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

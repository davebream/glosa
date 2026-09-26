// SPDX-License-Identifier: Apache-2.0
// The pure halves of scripts/package-app.ts and scripts/app-smoke.ts (#371): Bun checksum lookup,
// the staged-tree guard, the per-architecture electron-builder config, the tree comparison the smoke
// uses, and the launcher itself, run through a Homebrew-style symlink against a fake Bun.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INSTALL_CHECK } from "../../cli/src/doctor.ts";
import { listingDifferences, SMOKE_INSTALL_ROW, treeListing } from "../scripts/app-smoke.ts";
import {
  appPathFor,
  builderEnvironment,
  bunAsset,
  inspectStagedTree,
  LAUNCHER,
  parseShasums,
  renderBuilderConfig,
  STAGED_TREE_CEILING_BYTES,
} from "../scripts/package-app.ts";
import pkg from "../package.json";

const temps: string[] = [];
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "glosa-package-app-test-"));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function write(root: string, rel: string, content = "x"): void {
  const path = join(root, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

/** A staged tree that passes: the entry points and one root dependency. */
function cleanTree(): string {
  const dir = temp();
  write(dir, "package.json", "{}");
  write(dir, "packages/cli/src/main.ts");
  write(dir, "packages/daemon/src/index.ts");
  write(dir, "node_modules/zod/package.json", "{}");
  write(dir, "node_modules/qs/test/index.js");
  return dir;
}

const SUMS = [
  `${"a".repeat(64)}  bun-darwin-aarch64.zip`,
  `${"b".repeat(64)}  bun-darwin-x64-baseline.zip`,
  `${"c".repeat(64)}  bun-darwin-x64.zip`,
].join("\n");

describe("package-app: Bun checksums", () => {
  test("finds the digest for exactly the named asset", () => {
    expect(parseShasums(SUMS, "bun-darwin-aarch64.zip")).toBe("a".repeat(64));
    expect(parseShasums(SUMS, "bun-darwin-x64.zip")).toBe("c".repeat(64));
    expect(parseShasums(SUMS, "bun-darwin-x64-baseline.zip")).toBe("b".repeat(64));
  });
  test("the standard x64 asset does not answer for the baseline one the Intel app carries", () => {
    expect(() => parseShasums(`${"c".repeat(64)}  bun-darwin-x64.zip`, "bun-darwin-x64-baseline.zip")).toThrow(
      "bun-darwin-x64-baseline.zip is not listed in SHASUMS256.txt",
    );
  });
  test("a similarly named asset does not answer for another", () => {
    expect(() => parseShasums(`${"b".repeat(64)}  bun-darwin-x64-baseline.zip`, "bun-darwin-x64.zip")).toThrow(
      "bun-darwin-x64.zip is not listed in SHASUMS256.txt",
    );
  });
  test("a missing line is a failure, never a pass", () => {
    expect(() => parseShasums("", "bun-darwin-aarch64.zip")).toThrow("not listed");
  });
  test("maps architectures to Bun's asset names", () => {
    expect(bunAsset("arm64")).toEqual({ asset: "bun-darwin-aarch64.zip", folder: "bun-darwin-aarch64" });
    // The baseline build: no AVX needed, so the Intel app also runs under a Rosetta without AVX.
    expect(bunAsset("x64")).toEqual({ asset: "bun-darwin-x64-baseline.zip", folder: "bun-darwin-x64-baseline" });
  });
});

describe("package-app: the staged tree", () => {
  test("a clean tree passes, and third-party test directories are left alone", () => {
    expect(inspectStagedTree(cleanTree(), ["zod"]).problems).toEqual([]);
  });
  test("packages/daemon/test is refused by name: the bundle would run as a source checkout", () => {
    const dir = cleanTree();
    write(dir, "packages/daemon/test/helpers.ts");
    expect(inspectStagedTree(dir, ["zod"]).problems).toEqual([
      "packages/daemon/test exists: the CLI would treat this bundle as a source checkout (~/.glosa-dev)",
    ]);
  });
  test("any other test directory under packages/ is refused", () => {
    const dir = cleanTree();
    write(dir, "packages/cli/test/a.test.ts");
    expect(inspectStagedTree(dir, ["zod"]).problems).toEqual([
      "packages/cli/test: a test directory must not ship in the app",
    ]);
  });
  test("a .git entry is refused", () => {
    const dir = cleanTree();
    write(dir, "node_modules/zod/.git", "gitdir: elsewhere");
    expect(inspectStagedTree(dir, ["zod"]).problems).toEqual([
      "node_modules/zod/.git: a .git entry must not ship in the app",
    ]);
  });
  test("a symlink is refused", () => {
    const dir = cleanTree();
    symlinkSync("/etc", join(dir, "packages", "escape"));
    expect(inspectStagedTree(dir, ["zod"]).problems).toEqual(["packages/escape: a symlink must not ship in the app"]);
  });
  test("leftover workspace links are refused", () => {
    const dir = cleanTree();
    mkdirSync(join(dir, "node_modules", "@glosa"));
    expect(inspectStagedTree(dir, ["zod"]).problems).toEqual([
      "node_modules/@glosa: workspace links must not ship in the app",
    ]);
  });
  test("a missing root dependency is refused", () => {
    expect(inspectStagedTree(cleanTree(), ["zod", "markdown-it"]).problems).toEqual([
      "node_modules/markdown-it is missing: a root dependency the CLI needs at run time",
    ]);
  });
  test("a tree above the size ceiling is refused, and the real ceiling is set", () => {
    const report = inspectStagedTree(cleanTree(), ["zod"], 1);
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toContain("above the");
    expect(STAGED_TREE_CEILING_BYTES).toBeGreaterThan(30e6);
  });
});

describe("package-app: electron-builder config", () => {
  const build = pkg.build as unknown as Record<string, unknown>;
  test("an unsigned build is ad-hoc signed by electron-builder, without the hardened runtime or notarization", () => {
    const config = renderBuilderConfig(build, { arch: "arm64", unsigned: true, notarize: true });
    const mac = config.mac as Record<string, unknown>;
    expect(mac.identity).toBe("-");
    expect(mac.hardenedRuntime).toBe(false);
    expect(mac.notarize).toBe(false);
    expect(mac.target).toEqual([
      { target: "dmg", arch: ["arm64"] },
      { target: "zip", arch: ["arm64"] },
    ]);
    expect((config.directories as Record<string, unknown>).output).toBe("dist/arm64");
  });
  test("a signed build keeps the hardened runtime, the entitlements and Bun in binaries", () => {
    const config = renderBuilderConfig(build, { arch: "x64", unsigned: false, notarize: false });
    const mac = config.mac as Record<string, unknown>;
    expect(mac.identity).toBeUndefined();
    expect(mac.hardenedRuntime).toBe(true);
    expect(mac.entitlements).toBe("assets/entitlements.mac.plist");
    expect(mac.binaries).toEqual(["Contents/Resources/bin/bun"]);
    expect(mac.notarize).toBe(false);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder's own macro syntax, not a template
    expect(config.artifactName).toBe("glosa-${version}-${arch}.${ext}");
    expect(config.afterPack).toBe("scripts/after-pack.cjs");
  });
  test("rendering never mutates package.json's build block", () => {
    renderBuilderConfig(build, { arch: "arm64", unsigned: true, notarize: false });
    expect((build.mac as Record<string, unknown>).identity).toBeUndefined();
  });
  test("node_modules never ride along in app.asar: the runtime lives in Resources/glosa", () => {
    expect(build.files as string[]).toContain("!node_modules{,/**/*}");
  });
  test("the app path follows electron-builder's per-arch output folders", () => {
    expect(appPathFor("/s", "arm64")).toBe("/s/dist/arm64/mac-arm64/glosa.app");
    expect(appPathFor("/s", "x64")).toBe("/s/dist/x64/mac/glosa.app");
  });
});

describe("app-smoke: comparisons", () => {
  test("the smoke's install row is the CLI's own doctor row", () => {
    expect(SMOKE_INSTALL_ROW).toBe(INSTALL_CHECK);
  });
  test("a file missing from the app, a changed file and an extra file are each named", () => {
    const staged = cleanTree();
    const shipped = cleanTree();
    rmSync(join(shipped, "node_modules", "zod"), { recursive: true });
    write(shipped, "packages/cli/src/main.ts", "changed");
    write(shipped, "extra.txt");
    const differences = listingDifferences(treeListing(staged), treeListing(shipped));
    expect(differences).toEqual([
      "missing from the app: node_modules/zod/package.json",
      "differs in the app: packages/cli/src/main.ts (1 staged, 7 shipped)",
      "not staged but shipped: extra.txt",
    ]);
  });
  test("identical trees have no differences", () => {
    expect(listingDifferences(treeListing(cleanTree()), treeListing(cleanTree()))).toEqual([]);
  });
});

describe("package-app: the launcher", () => {
  test("run through a symlink from another directory, it runs the bundled main.ts on the bundled Bun, never auto-installing", () => {
    const root = realpathSync(temp());
    const resources = join(root, "glosa.app", "Contents", "Resources");
    mkdirSync(join(resources, "bin"), { recursive: true });
    writeFileSync(join(resources, "bin", "glosa"), LAUNCHER);
    chmodSync(join(resources, "bin", "glosa"), 0o755);
    writeFileSync(join(resources, "bin", "bun"), `#!/bin/sh\nprintf '%s\\n' "$0" "$@"\n`);
    chmodSync(join(resources, "bin", "bun"), 0o755);
    mkdirSync(join(root, "homebrew", "bin"), { recursive: true });
    symlinkSync(join(resources, "bin", "glosa"), join(root, "homebrew", "bin", "glosa"));
    // A relative link one hop further, the shape a Caskroom symlink chain can take.
    symlinkSync("homebrew/bin/glosa", join(root, "relative-link"));
    for (const entry of [join(root, "homebrew", "bin", "glosa"), join(root, "relative-link")]) {
      const run = Bun.spawnSync([entry, "--version"], {
        env: { PATH: "/usr/bin:/bin" },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(run.stderr.toString()).toBe("");
      expect(run.stdout.toString().split("\n")).toEqual([
        join(resources, "bin", "bun"),
        "--no-install",
        join(resources, "glosa", "packages", "cli", "src", "main.ts"),
        "--version",
        "",
      ]);
    }
  });
});

describe("builderEnvironment", () => {
  test("an unsigned build signs ad hoc even when electron-builder sees a pull request", () => {
    const env = builderEnvironment({ GITHUB_BASE_REF: "main" }, true);
    expect(env.CSC_FOR_PULL_REQUEST).toBe("true");
    expect(env.CSC_IDENTITY_AUTO_DISCOVERY).toBe("false");
  });
  test("a signed build never opts in to signing a pull request", () => {
    const env = builderEnvironment({ GITHUB_BASE_REF: "main", CSC_FOR_PULL_REQUEST: "true" }, false);
    expect(env.CSC_FOR_PULL_REQUEST).toBeUndefined();
  });
});

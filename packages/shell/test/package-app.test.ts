// SPDX-License-Identifier: Apache-2.0
// The pure halves of scripts/package-app.ts and scripts/app-smoke.ts (#371): Bun checksum lookup,
// the staged-tree guard, the per-architecture electron-builder config, the tree comparison the smoke
// uses, and the launcher itself, run through a Homebrew-style symlink against a fake Bun.
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INSTALL_CHECK } from "../../cli/src/doctor.ts";
import { listingDifferences, SMOKE_INSTALL_ROW, treeListing } from "../scripts/app-smoke.ts";
import {
  appPathFor,
  binaryFormatProblem,
  builderEnvironment,
  bunAsset,
  inspectStagedTree,
  LAUNCHER,
  linuxBuilderEnvironment,
  packageCacheDir,
  pacmanArtifactPath,
  pacmanVersion,
  parseShasums,
  renderBuilderConfig,
  renderLinuxBuilderConfig,
  STAGED_TREE_CEILING_BYTES,
  unpackedPathFor,
  unzipCommand,
  upgradeFixtureVersion,
} from "../scripts/package-app.ts";
import {
  forbiddenPackagePaths,
  installFunctions,
  listingUnder,
  parseDesktopEntry,
  parsePackageListing,
  parsePkgInfo,
} from "../scripts/pacman-package.ts";
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
    expect(bunAsset("x64")).toEqual({ asset: "bun-darwin-x64.zip", folder: "bun-darwin-x64" });
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
  test("the app declares the glosa:// scheme, which electron-builder writes as CFBundleURLTypes (#392)", () => {
    const config = renderBuilderConfig(build, { arch: "arm64", unsigned: true, notarize: false });
    expect(config.protocols).toEqual([{ name: "glosa", schemes: ["glosa"], role: "Viewer" }]);
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
    // Directory enumeration order differs between macOS and Linux. Every difference must remain.
    expect([...differences].sort()).toEqual(
      [
        "missing from the app: node_modules/zod/package.json",
        "differs in the app: packages/cli/src/main.ts (1 staged, 7 shipped)",
        "not staged but shipped: extra.txt",
      ].sort(),
    );
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

// ---------------------------------------------------------------------------------------------
// The Linux pacman package (#432)

const SHELL_ROOT = join(import.meta.dir, "..");
const afterPack = createRequire(import.meta.url)("../scripts/after-pack.cjs") as {
  partsFor: (platform: string) => string[];
  resourcesDirFor: (context: unknown) => string;
  copyStage: (stage: string, resources: string, parts: string[]) => void;
  sealSandbox: (appOutDir: string) => void;
  default: (context: unknown) => Promise<void>;
};

describe("package-app: the Linux runtime (#432)", () => {
  test("Linux carries Bun's baseline build, x86_64 only, verified against its own SHASUMS line", () => {
    expect(bunAsset("x64", "linux")).toEqual({ asset: "bun-linux-x64-baseline.zip", folder: "bun-linux-x64-baseline" });
    expect(() => bunAsset("arm64", "linux")).toThrow("x86_64 only");
    const sums = `${"d".repeat(64)}  bun-linux-x64.zip\n${"e".repeat(64)}  bun-linux-x64-baseline.zip`;
    expect(parseShasums(sums, bunAsset("x64", "linux").asset)).toBe("e".repeat(64));
  });

  test("the staged Bun must be the platform's executable: Mach-O on macOS, x86-64 ELF on Linux", () => {
    const elf = (machine: number, klass = 2, data = 1) => {
      const header = Buffer.alloc(64);
      header.write("7f454c46", 0, "hex");
      header[4] = klass;
      header[5] = data;
      header.writeUInt16LE(machine, 18);
      return header;
    };
    expect(binaryFormatProblem(Buffer.from("cffaedfe", "hex"), "darwin")).toBeNull();
    expect(binaryFormatProblem(elf(0x3e), "darwin")).toContain("Mach-O");
    expect(binaryFormatProblem(elf(0x3e), "linux")).toBeNull();
    expect(binaryFormatProblem(elf(0xb7), "linux")).toContain("not an x86-64 ELF");
    expect(binaryFormatProblem(elf(0x3e, 1), "linux")).toContain("64-bit little-endian");
    expect(binaryFormatProblem(Buffer.from("cffaedfe", "hex"), "linux")).toContain("not an ELF");
  });

  test("caches follow the platform: ~/Library/Caches on macOS, XDG on Linux, GLOSA_BUN_CACHE on both", () => {
    expect(packageCacheDir("darwin", {}, "/Users/u")).toBe("/Users/u/Library/Caches/glosa-package-app");
    expect(packageCacheDir("linux", {}, "/home/u")).toBe("/home/u/.cache/glosa-package-app");
    expect(packageCacheDir("linux", { XDG_CACHE_HOME: "/x" }, "/home/u")).toBe("/x/glosa-package-app");
    expect(packageCacheDir("linux", { GLOSA_BUN_CACHE: "/c" }, "/home/u")).toBe("/c");
    expect(unzipCommand("darwin", "/z.zip", "/d")).toEqual(["ditto", ["-x", "-k", "/z.zip", "/d"]]);
    expect(unzipCommand("linux", "/z.zip", "/d")).toEqual(["bsdtar", ["-xf", "/z.zip", "-C", "/d"]]);
  });

  test("the pacman version joins the prerelease on, so a prerelease sorts before its release", () => {
    // electron-builder alone writes 0.1.0_alpha.36, which pacman ranks above 0.1.0.
    expect(pacmanVersion("0.1.0-alpha.36")).toBe("0.1.0alpha.36");
    expect(pacmanVersion("1.2.3-rc.1")).toBe("1.2.3rc.1");
    expect(pacmanVersion("0.1.0")).toBe("0.1.0");
  });
});

describe("package-app: the Linux electron-builder config (#432)", () => {
  const build = pkg.build as unknown as Record<string, unknown>;
  const config = renderLinuxBuilderConfig(build, { version: "0.1.0-alpha.36", shellRoot: "/s" });
  const linux = config.linux as Record<string, unknown>;
  const pacman = config.pacman as Record<string, unknown>;

  test("it drops the Mac sections and builds x86_64 pacman into dist/x64", () => {
    expect(config.mac).toBeUndefined();
    expect(config.dmg).toBeUndefined();
    expect(linux.target).toEqual([{ target: "pacman", arch: ["x64"] }]);
    expect((config.directories as Record<string, unknown>).output).toBe("dist/x64");
    expect(unpackedPathFor("/s")).toBe("/s/dist/x64/linux-unpacked");
    expect(pacmanArtifactPath("/s", "0.1.0-alpha.36")).toBe("/s/dist/x64/glosa-0.1.0-alpha.36-x64.pacman");
  });

  test("the Electron binary is named glosa, so the desktop file is glosa.desktop and links route to it", () => {
    // electron-builder's default would be @glosashell, from the package name @glosa/shell.
    expect(linux.executableName).toBe("glosa");
    expect(config.protocols).toEqual([{ name: "glosa", schemes: ["glosa"], role: "Viewer" }]);
  });

  test("fpm gets the mapped version and the package-owned /usr/bin/glosa symlink", () => {
    expect(pacman.fpm).toEqual(["--version", "0.1.0alpha.36", "/s/build/linux/usr-bin-glosa=/usr/bin/glosa"]);
  });

  test("dependencies are declared, Git included, and never the AUR-only http-parser default", () => {
    const depends = pacman.depends as string[];
    expect(depends).toContain("git");
    expect(depends).toContain("gtk3");
    expect(depends).toContain("nss");
    expect(depends).not.toContain("http-parser");
  });

  test("no update metadata ships, and fpm's required metadata carries no personal address", () => {
    expect(linux.publish).toBeNull();
    expect(config.extraMetadata).toEqual({ homepage: "https://github.com/davebream/glosa", license: "Apache-2.0" });
    expect(String(pacman.maintainer)).not.toMatch(/@[a-z0-9-]+\.[a-z]/i);
  });

  test("the install and remove scripts exist and do nothing: no macro, no sandbox switch, no home", () => {
    for (const key of ["afterInstall", "afterRemove"]) {
      const path = join(SHELL_ROOT, String(pacman[key]));
      expect(existsSync(path), path).toBe(true);
      const body = readFileSync(path, "utf8");
      // electron-builder expands ${name} macros in these files and throws on an unknown one.
      expect(body).not.toContain("${");
      expect(body).not.toMatch(/no-sandbox|\$HOME|\/home\/|kill|pkill/);
      expect(body.split("\n").filter((line) => line.trim() && !line.startsWith("#"))).toEqual([":"]);
    }
  });

  test("a Mac build renders exactly what it did before the Linux blocks existed", () => {
    const { linux: _linux, pacman: _pacman, ...macOnly } = build;
    for (const options of [
      { arch: "arm64", unsigned: true, notarize: false },
      { arch: "x64", unsigned: false, notarize: true },
    ] as const) {
      expect(renderBuilderConfig(build, options)).toEqual(renderBuilderConfig(macOnly, options));
      expect(renderBuilderConfig(build, options).linux).toBeUndefined();
    }
  });

  test("the pacman build drops CI build numbers and GitHub tokens, which would change pkgrel or add update metadata", () => {
    const env = linuxBuilderEnvironment({ BUILD_NUMBER: "7", GITHUB_TOKEN: "t", GH_TOKEN: "t", PATH: "/usr/bin" });
    expect(env).toEqual({ PATH: "/usr/bin" });
  });
});

describe("after-pack on each platform (#371, #432)", () => {
  test("macOS keeps its three parts in Contents/Resources; Linux adds the marker under resources/", () => {
    expect(afterPack.partsFor("darwin")).toEqual(["bin", "glosa", "licenses"]);
    expect(afterPack.partsFor("linux")).toEqual(["bin", "glosa", "licenses", "package-type"]);
    const mac = {
      electronPlatformName: "darwin",
      appOutDir: "/o",
      packager: { appInfo: { productFilename: "glosa" } },
    };
    expect(afterPack.resourcesDirFor(mac)).toBe("/o/glosa.app/Contents/Resources");
    const linux = {
      electronPlatformName: "linux",
      appOutDir: "/o",
      packager: { getResourcesDir: (d: string) => `${d}/resources` },
    };
    expect(afterPack.resourcesDirFor(linux)).toBe("/o/resources");
  });

  test("a Linux pack copies the stage and makes chrome-sandbox 4755; a missing part is named", () => {
    const out = temp();
    const resources = join(out, "resources");
    mkdirSync(resources, { recursive: true });
    writeFileSync(join(out, "chrome-sandbox"), "");
    chmodSync(join(out, "chrome-sandbox"), 0o755);
    const stage = temp();
    for (const part of ["bin", "glosa", "licenses"]) write(stage, `${part}/x`);
    write(stage, "package-type", "pacman\n");
    afterPack.copyStage(stage, resources, afterPack.partsFor("linux"));
    expect(readFileSync(join(resources, "package-type"), "utf8")).toBe("pacman\n");
    expect(() => afterPack.copyStage(temp(), resources, ["package-type"])).toThrow("package-type is missing");
    afterPack.sealSandbox(out);
    expect(statSync(join(out, "chrome-sandbox")).mode & 0o7777).toBe(0o4755);
  });
});

describe("reading a built pacman package (#432)", () => {
  const LISTING = [
    "-rw-r--r--  0 0      0         512 Sep 28 18:29 .PKGINFO",
    "drwxr-xr-x  0 0      0           0 Sep 28 18:29 opt/glosa/",
    "-rwsr-xr-x  0 0      0       18688 Sep 28 18:29 opt/glosa/chrome-sandbox",
    "-rw-r--r--  0 0      0           7 Sep 28 18:29 opt/glosa/resources/package-type",
    "lrwxrwxrwx  0 0      0           0 Sep 28 18:29 usr/bin/glosa -> /opt/glosa/resources/bin/glosa",
  ].join("\n");

  test("a bsdtar listing gives mode, owner, size and a symlink's target", () => {
    const entries = parsePackageListing(LISTING);
    expect(entries.get("opt/glosa/chrome-sandbox")).toEqual({ mode: "-rwsr-xr-x", uid: "0", gid: "0", size: "18688" });
    expect(entries.get("usr/bin/glosa")?.link).toBe("/opt/glosa/resources/bin/glosa");
    expect(entries.get("opt/glosa")?.mode).toBe("drwxr-xr-x");
    expect(listingUnder(entries, "opt/glosa")).toEqual(
      new Map([
        ["chrome-sandbox", "18688"],
        ["resources/package-type", "7"],
      ]),
    );
  });

  test(".PKGINFO keeps every value of a repeated key, in order", () => {
    const info = parsePkgInfo("# fpm\npkgname = glosa\ndepend = git\ndepend = gtk3\n");
    expect(info.get("pkgname")).toEqual(["glosa"]);
    expect(info.get("depend")).toEqual(["git", "gtk3"]);
  });

  test(".INSTALL functions reduce to what they do; glosa's do nothing", () => {
    const text =
      "post_install() {\n    :\n#!/bin/sh\n# comment\n:\n\n}\npost_remove() {\n    :\nrm -f /usr/bin/glosa\n}\n";
    expect(installFunctions(text)).toEqual(
      new Map([
        ["post_install", [":", ":"]],
        ["post_remove", [":", "rm -f /usr/bin/glosa"]],
      ]),
    );
  });

  test("a desktop entry's keys", () => {
    const entry = parseDesktopEntry("[Desktop Entry]\nExec=/opt/glosa/glosa %U\nMimeType=x-scheme-handler/glosa;\n");
    expect(entry.get("Exec")).toBe("/opt/glosa/glosa %U");
    expect(entry.get("MimeType")).toBe("x-scheme-handler/glosa;");
  });

  test("development state, credentials and update metadata never ship; third-party tests may", () => {
    const root = "opt/glosa/resources/glosa";
    const problems = forbiddenPackagePaths([
      `${root}/packages/daemon/test/helpers.ts`,
      `${root}/docs/requirements.md`,
      `${root}/.git/HEAD`,
      "opt/glosa/resources/app-update.yml",
      `${root}/.npmrc`,
      `${root}/node_modules/qs/test/index.js`,
      `${root}/packages/cli/src/main.ts`,
    ]);
    expect(problems).toHaveLength(5);
    expect(problems.join("\n")).toContain("source checkout");
    expect(problems.join("\n")).not.toContain("node_modules/qs");
    expect(problems.join("\n")).not.toContain("packages/cli/src/main.ts");
  });

  test("the smoke's upgrade package is newer in glosa's ordering and in pacman's", () => {
    expect(upgradeFixtureVersion("0.1.0-alpha.36")).toBe("0.1.0-alpha.36.1");
    expect(upgradeFixtureVersion("0.1.0")).toBe("0.1.1-smoke.1");
    expect(Bun.semver.order(upgradeFixtureVersion("0.1.0-alpha.36"), "0.1.0-alpha.36")).toBe(1);
    expect(Bun.semver.order(upgradeFixtureVersion("0.1.0"), "0.1.0")).toBe(1);
    // pacman: 0.1.0alpha.36.1 > 0.1.0alpha.36 (a numeric part after a separator sorts newer).
    expect(pacmanVersion(upgradeFixtureVersion("0.1.0-alpha.36"))).toBe("0.1.0alpha.36.1");
  });
});

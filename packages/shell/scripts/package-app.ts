// SPDX-License-Identifier: Apache-2.0
// Builds glosa.app: the Electron shell plus, under Contents/Resources, the Bun runtime at the
// repository's packageManager pin, the CLI/daemon/SPA/providers exactly as npm publishes them with
// their production dependencies, and a launcher that runs the one on the other (#371).
//
//   Contents/Resources/bin/bun     the runtime, sha256-verified against Bun's SHASUMS256.txt
//   Contents/Resources/bin/glosa   the launcher the cask links and the bundled CLI records
//   Contents/Resources/glosa/      the npm file set + production node_modules, never a test tree
//   Contents/Resources/licenses/   Electron's, Chromium's and Bun's license texts
//
// The staged tree lands in the bundle through scripts/after-pack.cjs, not `extraResources`, whose
// copy filter drops a top-level node_modules and other files; the smoke's S0 proves the copy exact.
//
// Nothing is bundled or transpiled; packaging and signing are the shell's one build step
// (requirements §4 exception). Node APIs only: the shell's tsconfig typechecks this file with Node
// types. It still runs under `bun` (`bun run --cwd packages/shell package`).
//
// Usage: bun scripts/package-app.ts [--arch arm64|x64|all] [--unsigned] [--smoke] [--stage-only]

import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { packContentProblems } from "../../../scripts/package-manifest.ts";

export type Arch = "arm64" | "x64";

/** The launcher at Contents/Resources/bin/glosa. It follows symlinks by hand (Homebrew links it into
 *  its bin; `readlink -f` only reached macOS in 12.3 and the floor is 13, and this also handles a
 *  relative link), finds Resources from its own real location, and `exec`s so the CLI's
 *  `process.execPath` is the bundled Bun: the daemon it spawns then runs on that Bun too.
 *  `--no-install` turns off Bun's runtime auto-install, which would otherwise fetch a missing
 *  package from the npm registry: a bundle with a hole in it fails loudly instead of reaching the
 *  network (invariant 5: no unconfigured egress). */
export const LAUNCHER = `#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# glosa: runs the CLI this app carries on the Bun runtime it carries (#371).
set -eu
self="$0"
while [ -L "$self" ]; do
  dir=$(cd -P -- "$(dirname -- "$self")" && pwd -P)
  link=$(readlink -- "$self")
  case "$link" in
    /*) self="$link" ;;
    *) self="$dir/$link" ;;
  esac
done
resources=$(cd -P -- "$(dirname -- "$self")/.." && pwd -P)
exec "$resources/bin/bun" --no-install "$resources/glosa/packages/cli/src/main.ts" "$@"
`;

/** Bun's release asset for an architecture. x64 is the AVX2 build: every Mac that runs macOS 13 has
 *  it, so `-baseline` is not needed. */
export function bunAsset(arch: Arch): { asset: string; folder: string } {
  const folder = arch === "arm64" ? "bun-darwin-aarch64" : "bun-darwin-x64";
  return { asset: `${folder}.zip`, folder };
}

/** The sha256 SHASUMS256.txt lists for exactly `asset`. A missing line is a failure, never a pass:
 *  a similarly named asset (`bun-darwin-x64-baseline.zip`) does not answer for `bun-darwin-x64.zip`. */
export function parseShasums(text: string, asset: string): string {
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(line.trim());
    if (match && match[2] === asset) return match[1] as string;
  }
  throw new Error(`${asset} is not listed in SHASUMS256.txt`);
}

export interface StagedTreeReport {
  problems: string[];
  bytes: number;
}

/**
 * Checks the staged `glosa/` tree before it is sealed into the app. Returns every problem as a
 * sentence naming the path; an empty list is a pass.
 *
 * - `packages/daemon/test` must not exist: `isSourceCheckout()` probes exactly that path, and a
 *   bundle that has it would run with a `~/.glosa-dev/<id>` home and a dev port.
 * - No `test`/`tests` directory under `packages/` and none at the top: the npm file set has none.
 *   Third-party packages under node_modules keep theirs; pruning someone else's package is not ours.
 * - No `.git` entry anywhere, no symlink anywhere (codesign seals files, and a link can point out of
 *   the bundle), no `node_modules/@glosa` workspace links.
 * - Every root dependency present, and the entry points the launcher and the daemon need.
 */
export function inspectStagedTree(
  dir: string,
  rootDependencies: readonly string[],
  maxBytes = Number.POSITIVE_INFINITY,
): StagedTreeReport {
  const problems: string[] = [];
  let bytes = 0;
  if (existsSync(join(dir, "packages", "daemon", "test")))
    problems.push("packages/daemon/test exists: the CLI would treat this bundle as a source checkout (~/.glosa-dev)");
  const walk = (abs: string): void => {
    for (const name of readdirSync(abs)) {
      const path = join(abs, name);
      const rel = relative(dir, path).split(sep).join("/");
      const stat = lstatSync(path);
      if (name === ".git") problems.push(`${rel}: a .git entry must not ship in the app`);
      if (stat.isSymbolicLink()) {
        problems.push(`${rel}: a symlink must not ship in the app`);
        continue;
      }
      if (stat.isDirectory()) {
        const underPackages = rel.startsWith("packages/");
        const isTestDir = name === "test" || name === "tests";
        if (isTestDir && rel !== "packages/daemon/test" && (underPackages || !rel.includes("/")))
          problems.push(`${rel}: a test directory must not ship in the app`);
        if (rel === "node_modules/@glosa")
          problems.push("node_modules/@glosa: workspace links must not ship in the app");
        if (rel === "packages/daemon/test") continue;
        walk(path);
      } else {
        bytes += stat.size;
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  else problems.push(`${dir} does not exist`);
  for (const file of ["package.json", "packages/cli/src/main.ts", "packages/daemon/src/index.ts"]) {
    if (!existsSync(join(dir, file))) problems.push(`${file} is missing`);
  }
  for (const dep of rootDependencies) {
    if (!existsSync(join(dir, "node_modules", dep, "package.json")))
      problems.push(`node_modules/${dep} is missing: a root dependency the CLI needs at run time`);
  }
  if (bytes > maxBytes)
    problems.push(
      `the staged tree is ${Math.round(bytes / 1e6)} MB, above the ${Math.round(maxBytes / 1e6)} MB ceiling`,
    );
  return { problems, bytes };
}

export interface RenderOptions {
  arch: Arch;
  unsigned: boolean;
  notarize: boolean;
}

/**
 * The electron-builder config for one architecture, derived from `build` in package.json so a hand
 * run of `electron-builder --mac` and this script agree. Unsigned builds are ad-hoc signed by
 * electron-builder itself (`identity: "-"`) so the DMG and zip hold a launchable app; the hardened
 * runtime is off for them because ad-hoc signing plus library validation rejects Electron's own
 * pre-signed frameworks. Signed builds keep the hardened runtime, the entitlements and the Bun
 * binary in `binaries`, and notarize only when the Apple credentials are present.
 */
export function renderBuilderConfig(build: Record<string, unknown>, options: RenderOptions): Record<string, unknown> {
  const config = JSON.parse(JSON.stringify(build)) as Record<string, unknown>;
  const mac = { ...((config.mac as Record<string, unknown> | undefined) ?? {}) };
  const targets = (mac.target as Array<{ target: string }> | undefined) ?? [{ target: "dmg" }, { target: "zip" }];
  mac.target = targets.map((target) => ({ target: target.target, arch: [options.arch] }));
  if (options.unsigned) {
    mac.identity = "-";
    mac.hardenedRuntime = false;
    mac.notarize = false;
  } else {
    mac.notarize = options.notarize;
  }
  config.mac = mac;
  const directories = { ...((config.directories as Record<string, unknown> | undefined) ?? {}) };
  directories.output = `dist/${options.arch}`;
  config.directories = directories;
  return config;
}

/** Where electron-builder leaves the .app for an architecture on an arm64 or x64 host. */
export function appPathFor(shellRoot: string, arch: Arch): string {
  const dir = arch === "arm64" ? "mac-arm64" : "mac";
  return join(shellRoot, "dist", arch, dir, "glosa.app");
}

// ---------------------------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const shellRoot = join(here, "..");
const repoRoot = join(shellRoot, "..", "..");
const buildDir = join(shellRoot, "build");
const stageDir = join(buildDir, "stage");
const stageGlosa = join(stageDir, "glosa");
const stageBin = join(stageDir, "bin");
/** Measured on the first build (#371, 0.1.0-alpha.31): 34.8 MB of files staged; the ceiling is that
 *  plus 50%, so a dependency that balloons the bundle is a decision, not an accident. */
export const STAGED_TREE_CEILING_BYTES = 52e6;
const WORKSPACE_MANIFESTS = [
  "packages/cli",
  "packages/daemon",
  "packages/spa",
  "packages/providers/claude-code",
  "packages/providers/codex",
  "packages/providers/wispr-flow",
];

function fail(message: string): never {
  throw new Error(message);
}

function run(command: string, args: string[], options: SpawnSyncOptions = {}): string {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...options });
  if (result.error) fail(`${command} ${args.join(" ")} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    const out = `${String(result.stdout ?? "")}${String(result.stderr ?? "")}`;
    fail(`${command} ${args.join(" ")} exited ${result.status}\n${out.slice(-4000)}`);
  }
  return String(result.stdout ?? "");
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function parseArgs(argv: string[]): { arches: Arch[]; unsigned: boolean; smoke: boolean; stageOnly: boolean } {
  let arch = process.arch === "arm64" ? "arm64" : "x64";
  let unsigned = false;
  let smoke = false;
  let stageOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--arch") arch = argv[++i] ?? fail("--arch needs arm64, x64 or all");
    else if (arg === "--unsigned") unsigned = true;
    else if (arg === "--smoke") smoke = true;
    else if (arg === "--stage-only") stageOnly = true;
    else fail(`unknown argument: ${arg}`);
  }
  if (!["arm64", "x64", "all"].includes(arch)) fail(`--arch must be arm64, x64 or all, not ${arch}`);
  const arches: Arch[] = arch === "all" ? ["arm64", "x64"] : [arch as Arch];
  return { arches, unsigned, smoke, stageOnly };
}

function stageSources(rootDependencies: string[]): void {
  const packDir = join(stageDir, "pack");
  mkdirSync(packDir, { recursive: true });
  mkdirSync(stageGlosa, { recursive: true });
  // Exactly the bytes npm publishes: one list of what ships (package.json `files`), one forbidden
  // list (scripts/package-manifest.ts), shared with the npm channel's own smoke.
  const packed = JSON.parse(
    run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", packDir], { cwd: repoRoot }),
  ) as Array<{ filename: string; files: Array<{ path: string }> }>;
  const result = packed[0] ?? fail("npm pack returned no artifact");
  const packProblems = packContentProblems(result.files.map((file) => file.path));
  if (packProblems.length > 0) fail(packProblems.join("\n"));
  run("tar", ["-xzf", join(packDir, result.filename), "--strip-components", "1", "-C", stageGlosa]);

  // Production dependencies from the lockfile, installed beside (never inside) the checkout, so the
  // checkout's own node_modules, Electron and the typechecker are untouched.
  const depsDir = join(stageDir, "deps");
  mkdirSync(depsDir, { recursive: true });
  for (const file of ["package.json", "bun.lock"]) cpSync(join(repoRoot, file), join(depsDir, file));
  for (const workspace of WORKSPACE_MANIFESTS) {
    mkdirSync(join(depsDir, workspace), { recursive: true });
    cpSync(join(repoRoot, workspace, "package.json"), join(depsDir, workspace, "package.json"));
  }
  run(process.execPath, ["install", "--frozen-lockfile", "--production", "--ignore-scripts"], { cwd: depsDir });
  // `.bin` directories are symlinks, and `@glosa` holds the workspace links into packages/* (which
  // would drag test trees in); the CLI resolves its own packages by relative import.
  cpSync(join(depsDir, "node_modules"), join(stageGlosa, "node_modules"), {
    recursive: true,
    filter: (source) => {
      const rel = relative(join(depsDir, "node_modules"), source).split(sep).join("/");
      return basename(source) !== ".bin" && rel !== "@glosa" && rel !== ".cache";
    },
  });

  const report = inspectStagedTree(stageGlosa, rootDependencies, STAGED_TREE_CEILING_BYTES);
  process.stdout.write(`package-app: staged glosa/ is ${(report.bytes / 1e6).toFixed(1)} MB\n`);
  if (report.problems.length > 0) fail(`the staged tree is not shippable:\n${report.problems.join("\n")}`);
}

async function fetchBun(arch: Arch, version: string): Promise<void> {
  const cache = join(
    process.env.GLOSA_BUN_CACHE ?? join(homedir(), "Library", "Caches", "glosa-package-app"),
    `bun-v${version}`,
  );
  mkdirSync(cache, { recursive: true });
  const base = `https://github.com/oven-sh/bun/releases/download/bun-v${version}`;
  const download = async (name: string): Promise<string> => {
    const path = join(cache, name);
    if (!existsSync(path)) {
      const response = await fetch(`${base}/${name}`);
      if (!response.ok) fail(`downloading ${base}/${name} failed: HTTP ${response.status}`);
      writeFileSync(path, Buffer.from(await response.arrayBuffer()));
    }
    return path;
  };
  const { asset, folder } = bunAsset(arch);
  const sums = await download("SHASUMS256.txt");
  const zip = await download(asset);
  // Verified on every build, cached or not: a sha256 over ~30 MB is cheap and a stale cache is not
  // a reason to ship unverified bytes.
  const expected = parseShasums(readFileSync(sums, "utf8"), asset);
  const actual = createHash("sha256").update(readFileSync(zip)).digest("hex");
  if (actual !== expected) {
    rmSync(zip, { force: true });
    fail(`${asset}: sha256 mismatch, expected ${expected}, got ${actual}; the cached copy was deleted`);
  }
  const unpacked = join(buildDir, `bun-${arch}`);
  rmSync(unpacked, { recursive: true, force: true });
  mkdirSync(unpacked, { recursive: true });
  run("ditto", ["-x", "-k", zip, unpacked]);
  mkdirSync(stageBin, { recursive: true });
  const target = join(stageBin, "bun");
  rmSync(target, { force: true });
  cpSync(join(unpacked, folder, "bun"), target);
  chmodSync(target, 0o755);
  const magic = readFileSync(target).subarray(0, 4).toString("hex");
  if (magic !== "cffaedfe") fail(`${target} is not a 64-bit Mach-O binary (magic ${magic})`);
  if (arch === process.arch) {
    const printed = run(target, ["--version"]).trim();
    if (printed !== version) fail(`${target} --version printed ${printed}, expected ${version}`);
  }
}

/** The app redistributes Electron (with Chromium) and Bun as binaries, so their license texts ride
 *  along in Contents/Resources/licenses. glosa's own LICENSE, NOTICE and THIRD_PARTY_NOTICES.md are
 *  already in Resources/glosa, because npm ships them. */
async function stageLicenses(bunVersion: string): Promise<void> {
  const licenses = join(stageDir, "licenses");
  mkdirSync(licenses, { recursive: true });
  const electronDist = join(shellRoot, "node_modules", "electron", "dist");
  cpSync(join(electronDist, "LICENSE"), join(licenses, "electron-LICENSE.txt"));
  cpSync(join(electronDist, "LICENSES.chromium.html"), join(licenses, "chromium-LICENSES.html"));
  const cache = join(
    process.env.GLOSA_BUN_CACHE ?? join(homedir(), "Library", "Caches", "glosa-package-app"),
    `bun-v${bunVersion}`,
  );
  mkdirSync(cache, { recursive: true });
  const cached = join(cache, "LICENSE.md");
  if (!existsSync(cached)) {
    const url = `https://raw.githubusercontent.com/oven-sh/bun/bun-v${bunVersion}/LICENSE.md`;
    const response = await fetch(url);
    if (!response.ok) fail(`downloading ${url} failed: HTTP ${response.status}`);
    writeFileSync(cached, Buffer.from(await response.arrayBuffer()));
  }
  cpSync(cached, join(licenses, "bun-LICENSE.md"));
}

function writeLauncher(): void {
  mkdirSync(stageBin, { recursive: true });
  const launcher = join(stageBin, "glosa");
  writeFileSync(launcher, LAUNCHER);
  chmodSync(launcher, 0o755);
}

function buildApp(arch: Arch, build: Record<string, unknown>, unsigned: boolean): void {
  const notarize = Boolean(
    process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID,
  );
  if (!unsigned && !notarize)
    process.stdout.write(
      "package-app: signing without APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID, so not notarizing\n",
    );
  const config = renderBuilderConfig(build, { arch, unsigned, notarize });
  const configPath = join(buildDir, `electron-builder.${arch}.json`);
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (unsigned) env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  const args = [
    join(shellRoot, "node_modules", "electron-builder", "cli.js"),
    "--mac",
    `--${arch}`,
    "--config",
    configPath,
    "--publish",
    "never",
  ];
  // codesign occasionally answers "internal error in Code Signing subsystem" on Electron Framework
  // and succeeds on the same command a moment later (seen on the x64 build, #371). Exactly that
  // message earns one more attempt; every other failure stops the build.
  for (let attempt = 1; ; attempt++) {
    const result = spawnSync("node", args, { cwd: shellRoot, env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    process.stdout.write(String(result.stdout ?? ""));
    process.stderr.write(String(result.stderr ?? ""));
    if (result.status === 0) break;
    const output = `${String(result.stdout ?? "")}${String(result.stderr ?? "")}`;
    if (attempt === 1 && output.includes("internal error in Code Signing subsystem")) {
      process.stdout.write("package-app: codesign reported an internal error; retrying the build once\n");
      continue;
    }
    fail(`electron-builder ${args.slice(1).join(" ")} exited ${result.status}`);
  }
  const app = appPathFor(shellRoot, arch);
  if (!existsSync(app)) fail(`electron-builder did not produce ${app}`);
  const version = String(readJson(join(shellRoot, "package.json")).version);
  for (const ext of ["dmg", "zip"]) {
    const artifact = join(shellRoot, "dist", arch, `glosa-${version}-${arch}.${ext}`);
    if (!existsSync(artifact)) fail(`electron-builder did not produce ${artifact}`);
    process.stdout.write(`package-app: ${artifact} (${(statSync(artifact).size / 1e6).toFixed(1)} MB)\n`);
  }
  process.stdout.write(`package-app: ${app}\n`);
}

function canRunX64(): boolean {
  if (process.arch === "x64") return true;
  return spawnSync("arch", ["-x86_64", "/usr/bin/true"]).status === 0;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (process.platform !== "darwin") fail("glosa.app is built on macOS only");

  const rootManifest = readJson(join(repoRoot, "package.json"));
  const pin = String(rootManifest.packageManager ?? "").replace(/^bun@/, "");
  const runningBun = (process.versions as Record<string, string | undefined>).bun;
  if (!pin) fail("the root package.json has no packageManager pin");
  if (runningBun !== pin) fail(`run this with Bun ${pin} (the packageManager pin), not ${runningBun ?? "Node"}`);
  if (!existsSync(join(shellRoot, "node_modules", "electron-builder", "cli.js")))
    fail("electron-builder is not installed: run `bun install --cwd packages/shell --frozen-lockfile`");

  const version = String(rootManifest.version);
  const shellManifest = readJson(join(shellRoot, "package.json"));
  if (shellManifest.version !== version)
    fail(
      `packages/shell/package.json says ${String(shellManifest.version)}, the root says ${version}: run \`bun run version:sync\``,
    );
  const ref = process.env.GITHUB_REF_NAME;
  if (ref?.startsWith("v") && ref !== `v${version}`) fail(`tag ${ref} does not match version ${version}`);

  rmSync(buildDir, { recursive: true, force: true });
  rmSync(join(shellRoot, "dist"), { recursive: true, force: true });
  const rootDependencies = Object.keys((rootManifest.dependencies as Record<string, string> | undefined) ?? {});
  stageSources(rootDependencies);
  writeLauncher();
  await stageLicenses(pin);
  if (options.stageOnly) {
    await fetchBun(options.arches[0] as Arch, pin);
    process.stdout.write(`package-app: staged ${stageDir}; stopping (--stage-only)\n`);
    return;
  }

  const build = shellManifest.build as Record<string, unknown>;
  for (const arch of options.arches) {
    await fetchBun(arch, pin);
    buildApp(arch, build, options.unsigned);
  }

  if (options.smoke) {
    for (const arch of options.arches) {
      if (arch === "x64" && !canRunX64()) {
        process.stdout.write("package-app: skipping the x64 smoke, Rosetta is not installed\n");
        continue;
      }
      const smoke = join(here, "app-smoke.ts");
      const args = [smoke, "--app", appPathFor(shellRoot, arch), "--stage", stageDir];
      if (!options.unsigned) args.push("--signed");
      run(process.execPath, args, { stdio: "inherit", cwd: shellRoot });
    }
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    process.stderr.write(`package-app: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

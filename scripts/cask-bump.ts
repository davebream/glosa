#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
// Renders the Homebrew cask (the desktop app) and formula (the command line alone) for a release
// and opens one pull request against the tap with both (#371). The release job runs it after
// uploading the DMGs and SHA256SUMS; `--dry-run` prints the cask, and `--dry-run --formula` the
// formula, so a maintainer can bump the tap by hand (docs/release.md, "Homebrew tap").
//
//   bun run scripts/cask-bump.ts --version 0.1.0-alpha.32 [--notarized] [--sums <path>] [--npm-tarball <path>]
//                                [--tap davebream/homebrew-tap] [--dry-run [--formula]]
//
// The formula installs the npm package with `bun add --global` into its keg and pins Homebrew's
// Bun with a wrapper, because the CLI starts with `#!/usr/bin/env bun` and a Dock-launched or
// otherwise bare PATH has no Bun on it. Its digest is the npm tarball's sha256: `--npm-tarball`
// hashes a local file, otherwise the tarball is downloaded from the registry.
//
// Without `--notarized` the cask describes an ad-hoc signed app, which macOS quarantines on install
// and after every upgrade, so its caveats say how to unblock it. The release job passes
// `--notarized` only when it signed with a Developer ID and notarized.
//
// The cask installs the app and links its bundled CLI. It never writes into an agent's
// configuration and its zap stanza never lists ~/.glosa, which holds journals, history and the
// pairing token.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitEnvironment } from "./git-env.ts";

export const DEFAULT_TAP = "davebream/homebrew-tap";

/** The DMG asset name the release job uploads for one architecture. */
export function dmgName(version: string, arch: "arm64" | "x64"): string {
  return `glosa-${version}-${arch}.dmg`;
}

/**
 * Parses a `shasum -a 256` listing into name → digest. Accepts text mode (`<hex>  <name>`) and
 * binary mode (`<hex> *<name>`). Blank lines are skipped; any other line is an error, because a
 * listing we cannot read is not one we should trust.
 */
export function parseSha256Sums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const [index, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (line === "") continue;
    const match = /^([0-9a-f]{64}) [ *](\S+)$/i.exec(line);
    if (!match) throw new Error(`SHA256SUMS line ${index + 1} is not "<sha256>  <file>": ${line}`);
    const [, digest, name] = match as unknown as [string, string, string];
    sums.set(name, digest.toLowerCase());
  }
  return sums;
}

/** Both DMG digests for `version`, or an error naming the asset that is missing. */
export function dmgDigests(sums: Map<string, string>, version: string): { arm: string; intel: string } {
  const arm = sums.get(dmgName(version, "arm64"));
  const intel = sums.get(dmgName(version, "x64"));
  if (!arm) throw new Error(`SHA256SUMS has no digest for ${dmgName(version, "arm64")}`);
  if (!intel) throw new Error(`SHA256SUMS has no digest for ${dmgName(version, "x64")}`);
  return { arm, intel };
}

/** The cask for one release. Pure over its arguments. */
export interface CaskOptions {
  /** Signed with a Developer ID and notarized. Without it the caveats explain the quarantine. */
  notarized?: boolean;
}

/** The first-launch step an ad-hoc signed app needs, which Gatekeeper enforces on the app and on
 *  the Bun inside it, so the command line is blocked too until it is done. */
const QUARANTINE_CAVEAT = `glosa.app is signed ad hoc, not notarized by Apple, so macOS blocks it, and the glosa
    command line inside it, until you allow it. After installing, and again after each upgrade, run:
      xattr -dr com.apple.quarantine #{appdir}/glosa.app
    Or open the app once, then choose Open Anyway in System Settings, Privacy & Security.

    `;

function assertDigest(label: string, digest: string): void {
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error(`${label} digest is not a sha256: ${digest}`);
}

function assertVersion(version: string): void {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(version)) throw new Error(`not a release version: ${version}`);
}

export function renderCask(version: string, armSha: string, intelSha: string, options: CaskOptions = {}): string {
  assertDigest("arm64", armSha);
  assertDigest("x64", intelSha);
  assertVersion(version);
  return `cask "glosa" do
  arch arm: "arm64", intel: "x64"

  version "${version}"
  sha256 arm:   "${armSha}",
         intel: "${intelSha}"

  url "https://github.com/davebream/glosa/releases/download/v#{version}/glosa-#{version}-#{arch}.dmg"
  name "glosa"
  desc "Local-first review workspace for documents drafted by AI coding agents"
  homepage "https://github.com/davebream/glosa"

  livecheck do
    url :url
    strategy :github_releases
    regex(/^v?(\\d+(?:\\.\\d+)+(?:-[\\w.]+)?)$/i)
  end

  auto_updates false
  depends_on macos: :ventura

  app "glosa.app"
  binary "#{appdir}/glosa.app/Contents/Resources/bin/glosa"

  uninstall quit: "dev.glosa.app"

  zap trash: [
    "~/Library/Application Support/glosa",
    "~/Library/Caches/dev.glosa.app",
    "~/Library/Caches/dev.glosa.app.ShipIt",
    "~/Library/Logs/glosa",
    "~/Library/Preferences/dev.glosa.app.plist",
    "~/Library/Saved Application State/dev.glosa.app.savedState",
  ]

  caveats <<~EOS
    ${options.notarized ? "" : QUARANTINE_CAVEAT}The glosa command line is linked into #{HOMEBREW_PREFIX}/bin and runs on the Bun runtime
    inside the app, so no separate Bun install is needed. If another glosa install is already
    recorded for the Claude Code plugin, it keeps that role; \`glosa doctor\` lists every install
    it can see and says which one is recorded.

    glosa never writes into your agent's configuration. Add the Claude Code plugin the same way
    as before:
      /plugin marketplace add davebream/glosa
      /plugin install glosa

    The glosa formula installs the same command line without the app. Install one or the other:
    both link glosa into #{HOMEBREW_PREFIX}/bin, so the second one fails to link.

    A daemon started by glosa keeps running after the app quits; \`glosa status\` shows it.
    Update with: brew upgrade --cask glosa
  EOS
end
`;
}

/** The npm tarball the formula installs. */
export function npmTarballUrl(version: string): string {
  return `https://registry.npmjs.org/@davebream/glosa/-/glosa-${version}.tgz`;
}

/**
 * The formula for one release: the command line alone, on Homebrew's Bun. Pure over its
 * arguments. The shape was verified end to end on 2026-09-26: `brew install` from a tap,
 * `brew test`, `glosa --version` with PATH=/usr/bin:/bin, and `glosa open` starting a daemon on
 * the keg's Bun.
 */
export function renderFormula(version: string, tarballSha: string): string {
  assertDigest("npm tarball", tarballSha);
  assertVersion(version);
  return `class Glosa < Formula
  desc "Local-first review workspace for documents drafted by AI coding agents"
  homepage "https://github.com/davebream/glosa"
  url "${npmTarballUrl(version)}"
  sha256 "${tarballSha}"
  license "Apache-2.0"

  livecheck do
    url "https://registry.npmjs.org/@davebream/glosa"
    strategy :json do |json|
      json["dist-tags"]&.values
    end
  end

  depends_on "bun"
  depends_on :macos

  def install
    ENV["BUN_INSTALL"] = libexec
    ENV["BUN_INSTALL_CACHE_DIR"] = buildpath/"bun-cache"
    system formula_opt_bin("bun")/"bun", "add", "--global", cached_download
    # The CLI starts with \`#!/usr/bin/env bun\`; pin Homebrew's Bun so a bare PATH still works.
    (bin/"glosa").write_env_script libexec/"bin/glosa", PATH: "#{formula_opt_bin("bun")}:$PATH"
  end

  def caveats
    <<~EOS
      This formula installs the glosa command line only, on Homebrew's Bun. The desktop app is
      the glosa cask, which carries the same command line. Install one or the other: both link
      glosa into #{HOMEBREW_PREFIX}/bin, so the second one fails to link.

      glosa never writes into your agent's configuration. Add the Claude Code plugin the same way
      as before:
        /plugin marketplace add davebream/glosa
        /plugin install glosa

      Update with: brew upgrade glosa
    EOS
  end

  test do
    ENV["GLOSA_HOME"] = testpath/"glosa-home"
    assert_match version.to_s, shell_output("#{bin}/glosa --version")
  end
end
`;
}

/** sha256 of a tarball's bytes, lowercase hex. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface Options {
  version: string;
  notarized: boolean;
  sums: string | null;
  npmTarball: string | null;
  tap: string;
  dryRun: boolean;
  formula: boolean;
}

export function parseArgs(argv: string[]): Options {
  const options: Options = {
    version: "",
    notarized: false,
    sums: null,
    npmTarball: null,
    tap: DEFAULT_TAP,
    dryRun: false,
    formula: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined || next.startsWith("--")) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === "--version") options.version = value().replace(/^v/, "");
    else if (arg === "--sums") options.sums = value();
    else if (arg === "--tap") options.tap = value();
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--notarized") options.notarized = true;
    else if (arg === "--npm-tarball") options.npmTarball = value();
    else if (arg === "--formula") options.formula = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.version) throw new Error("--version <version> is required");
  if (options.formula && !options.dryRun) throw new Error("--formula only selects what --dry-run prints");
  return options;
}

function run(cmd: string[], cwd: string, env: NodeJS.ProcessEnv): string {
  const result = Bun.spawnSync({ cmd, cwd, env, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`${cmd.slice(0, 3).join(" ")} failed (${result.exitCode}): ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString();
}

function readSums(options: Options, scratch: string): string {
  if (options.sums) return readFileSync(options.sums, "utf8");
  run(
    [
      "gh",
      "release",
      "download",
      `v${options.version}`,
      "--repo",
      "davebream/glosa",
      "--pattern",
      "SHA256SUMS",
      "--dir",
      scratch,
    ],
    scratch,
    gitEnvironment(),
  );
  return readFileSync(join(scratch, "SHA256SUMS"), "utf8");
}

/** The npm tarball's sha256. A local file when given; otherwise the registry, retried with
 *  backoff because the CDN can lag a few minutes behind a fresh publish. */
async function tarballDigest(options: Options): Promise<string> {
  if (options.npmTarball) return sha256Hex(readFileSync(options.npmTarball));
  const url = npmTarballUrl(options.version);
  let last = "";
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const response = await fetch(url, { headers: { "User-Agent": "glosa-release" } });
      if (response.ok) return sha256Hex(new Uint8Array(await response.arrayBuffer()));
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = (error as Error).message;
    }
    if (attempt < 6) await Bun.sleep(attempt * 10_000);
  }
  throw new Error(`could not download ${url}: ${last}`);
}

/** Git configuration, passed through the environment, that authenticates to github.com with the
 *  tap token as a basic-auth header. Keeps the token out of every URL and argv. */
export function tapAuthEnvironment(token: string): Record<string, string> {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

function openTapPullRequest(options: Options, cask: string, formula: string, scratch: string): string {
  const token = process.env.HOMEBREW_TAP_TOKEN;
  if (!token) {
    throw new Error("HOMEBREW_TAP_TOKEN is not set; bump the tap by hand with --dry-run (docs/release.md)");
  }
  const checkout = join(scratch, "tap");
  const branch = `glosa-${options.version}`;
  const env = {
    ...gitEnvironment(),
    GH_TOKEN: token,
    GIT_AUTHOR_NAME: "github-actions[bot]",
    GIT_AUTHOR_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
    GIT_COMMITTER_NAME: "github-actions[bot]",
    GIT_COMMITTER_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
  };
  const base = run(
    ["gh", "repo", "view", options.tap, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"],
    scratch,
    env,
  ).trim();
  // The token travels as an HTTP header set through git's environment, never in the remote URL or
  // the argv: git echoes a failing URL in its own error text, and run() puts stderr in the error.
  const gitEnv = { ...env, ...tapAuthEnvironment(token) };
  const remote = `https://github.com/${options.tap}.git`;
  run(["git", "clone", "--depth", "1", "--branch", base, remote, checkout], scratch, gitEnv);
  run(["git", "checkout", "-b", branch], checkout, env);
  mkdirSync(join(checkout, "Casks"), { recursive: true });
  mkdirSync(join(checkout, "Formula"), { recursive: true });
  writeFileSync(join(checkout, "Casks", "glosa.rb"), cask);
  writeFileSync(join(checkout, "Formula", "glosa.rb"), formula);
  run(["git", "add", "Casks/glosa.rb", "Formula/glosa.rb"], checkout, env);
  run(["git", "commit", "-m", `glosa ${options.version}`], checkout, env);
  run(["git", "push", "origin", branch], checkout, gitEnv);
  return run(
    [
      "gh",
      "pr",
      "create",
      "--repo",
      options.tap,
      "--base",
      base,
      "--head",
      branch,
      "--title",
      `glosa ${options.version}`,
      "--body",
      `Bumps the cask and the formula to glosa ${options.version}.\n\nRelease: https://github.com/davebream/glosa/releases/tag/v${options.version}\n\nCask, arm64: ${dmgName(options.version, "arm64")}\nCask, x64: ${dmgName(options.version, "x64")}\nFormula: ${npmTarballUrl(options.version)}\n\nDMG digests come from the release's SHA256SUMS; the formula digest is the npm tarball's sha256.`,
    ],
    checkout,
    env,
  ).trim();
}

export async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  const scratch = mkdtempSync(join(tmpdir(), "glosa-cask-"));
  try {
    if (options.dryRun && options.formula) {
      process.stdout.write(renderFormula(options.version, await tarballDigest(options)));
      return 0;
    }
    const { arm, intel } = dmgDigests(parseSha256Sums(readSums(options, scratch)), options.version);
    const cask = renderCask(options.version, arm, intel, { notarized: options.notarized });
    if (options.dryRun) {
      process.stdout.write(cask);
      return 0;
    }
    const formula = renderFormula(options.version, await tarballDigest(options));
    process.stdout.write(`${openTapPullRequest(options, cask, formula, scratch)}\n`);
    return 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    process.exit(await main(Bun.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`cask-bump: ${(error as Error).message}\n`);
    process.exit(1);
  }
}

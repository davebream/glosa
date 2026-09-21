// SPDX-License-Identifier: Apache-2.0
//
// The single place that knows where the released version is written.
//
// `package.json` is the source of truth. Every other site is derived from it, because a version
// kept in several hand-edited files drifts: `glosa-plugin/.claude-plugin/plugin.json` sat seven
// releases behind the root manifest for months and nothing noticed (#305).
//
// Each site carries ONE regex whose entire match IS the version, via lookbehind/lookahead. Reading
// and writing therefore share the same locus by construction — a table with separate read and write
// strategies is where silent divergence lives, because the checker can read a field the writer never
// touches and pass forever.
//
// A site that matches nothing is a hard failure, never a pass. A pattern that quietly stops matching
// is the default failure mode of a regex-driven checker and would leave this gate green forever.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dir, "..");

export interface VersionSite {
  /** Repo-root-relative, POSIX-separated. */
  readonly path: string;
  readonly label: string;
  /** Matches EXACTLY the version substring. Must carry `g`, and must match exactly once. */
  readonly pattern: RegExp;
}

export interface ForbiddenVersionSite {
  readonly path: string;
  /** Why a version here is wrong, and what to do instead. */
  readonly label: string;
  /** ANY match is a failure. */
  readonly pattern: RegExp;
}

export const VERSION_SITES: readonly VersionSite[] = [
  {
    path: "package.json",
    label: "the root npm manifest — the source of truth for every other site",
    pattern: /(?<=^\s*"version":\s*")[^"]+(?="\s*,?\s*$)/gm,
  },
  {
    path: "glosa-plugin/.claude-plugin/plugin.json",
    label: "the Claude Code plugin manifest shipped inside the npm tarball",
    pattern: /(?<=^\s*"version":\s*")[^"]+(?="\s*,?\s*$)/gm,
  },
  {
    path: "README.md",
    label: "the published tarball install URL for scope-mapped npm configs",
    pattern: /(?<=\/glosa-)[0-9][^/\s)]*(?=\.tgz)/g,
  },
  {
    path: "test/oss-release.test.ts",
    label: "the release-metadata assertion's pinned version",
    pattern: /(?<=expect\(rootPackage\.version\)\.toBe\(")[^"]+(?="\))/g,
  },
];

export const SOURCE_SITE = VERSION_SITES[0]!;

export const FORBIDDEN_VERSION_SITES: readonly ForbiddenVersionSite[] = [
  {
    path: ".claude-plugin/marketplace.json",
    label:
      "a marketplace entry must not pin a version — it would become a third drift site. " +
      'The entry uses `source: "./glosa-plugin"`, so plugin.json is already the authority',
    pattern: /"version"\s*:/g,
  },
];

for (const site of [...VERSION_SITES, ...FORBIDDEN_VERSION_SITES]) {
  if (!site.pattern.global) throw new Error(`${site.path}: pattern must carry the g flag`);
}

export type Reader = (path: string) => string | null;

export type FailureReason = "unreadable" | "absent" | "ambiguous" | "mismatch" | "forbidden";

export interface SiteFailure {
  readonly path: string;
  readonly label: string;
  readonly reason: FailureReason;
  readonly found: readonly string[];
  readonly expected?: string;
}

export function readSite(text: string, site: VersionSite): string[] {
  return [...text.matchAll(site.pattern)].map((match) => match[0]);
}

export function writeSite(text: string, site: VersionSite, version: string): string {
  return text.replace(site.pattern, version);
}

export function worktreeReader(root = ROOT): Reader {
  return (path) => {
    try {
      return readFileSync(join(root, path), "utf8");
    } catch {
      return null;
    }
  };
}

/**
 * Reads the blob Git is about to COMMIT, not the file on disk.
 *
 * `GIT_*` is deliberately NOT stripped here, unlike `scripts/test-plan.ts`'s `gitEnvironment()`.
 * That helper wants ROOT's repository regardless of who invoked it; this one wants the index the
 * caller is committing, and during `git rebase`/`git merge` the hook's `GIT_INDEX_FILE` names a
 * temporary index. Only Git's *configuration* is neutralized, so a user's ~/.gitconfig cannot
 * influence the answer.
 */
export function indexReader(root = ROOT): Reader {
  return (path) => {
    const child = Bun.spawnSync({
      cmd: ["git", "show", `:${path}`],
      cwd: root,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    return child.exitCode === 0 ? child.stdout.toString() : null;
  };
}

export function sourceVersion(read: Reader): string {
  const text = read(SOURCE_SITE.path);
  if (text === null) throw new Error(`${SOURCE_SITE.path} is not readable`);
  const found = readSite(text, SOURCE_SITE);
  if (found.length !== 1)
    throw new Error(`${SOURCE_SITE.path}: version pattern matched ${found.length} times, expected exactly 1`);
  return found[0]!;
}

export function inspect(
  read: Reader,
  expected: string,
  sites: readonly VersionSite[] = VERSION_SITES,
  forbidden: readonly ForbiddenVersionSite[] = FORBIDDEN_VERSION_SITES,
): SiteFailure[] {
  const failures: SiteFailure[] = [];
  for (const site of sites) {
    const { path, label } = site;
    const text = read(path);
    if (text === null) {
      failures.push({ path, label, reason: "unreadable", found: [], expected });
      continue;
    }
    const found = readSite(text, site);
    if (found.length === 0) failures.push({ path, label, reason: "absent", found, expected });
    else if (found.length > 1) failures.push({ path, label, reason: "ambiguous", found, expected });
    else if (found[0] !== expected) failures.push({ path, label, reason: "mismatch", found, expected });
  }
  for (const site of forbidden) {
    const { path, label } = site;
    const text = read(path);
    if (text === null) {
      failures.push({ path, label, reason: "unreadable", found: [] });
      continue;
    }
    const hits = [...text.matchAll(site.pattern)].map((match) => match[0]);
    if (hits.length > 0) failures.push({ path, label, reason: "forbidden", found: hits });
  }
  return failures;
}

export function describeFailures(failures: readonly SiteFailure[]): string[] {
  return failures.map((failure) => {
    if (failure.reason === "unreadable")
      return `${failure.path}: not readable — missing from the tree, or deleted from the commit`;
    if (failure.reason === "absent")
      return `${failure.path}: the version pattern matched nothing. The site moved or was reworded; fix VERSION_SITES in scripts/version-sync.ts rather than deleting the site`;
    if (failure.reason === "ambiguous")
      return `${failure.path}: the version pattern matched ${failure.found.length} times (${failure.found.join(", ")}); tighten it in scripts/version-sync.ts`;
    if (failure.reason === "mismatch")
      return `${failure.path}: expected ${failure.expected}, found ${failure.found[0]}`;
    return `${failure.path}: ${failure.label} (${failure.found.length} occurrence(s))`;
  });
}

/** Rewrites every derived site to `version`. Returns the paths actually changed. */
export function syncWorktree(version: string, root = ROOT): string[] {
  const changed: string[] = [];
  for (const site of VERSION_SITES) {
    const file = join(root, site.path);
    const text = readFileSync(file, "utf8");
    const found = readSite(text, site);
    if (found.length !== 1)
      throw new Error(
        `${site.path}: version pattern matched ${found.length} times; refusing to write. Fix VERSION_SITES first.`,
      );
    if (found[0] === version) continue;
    writeFileSync(file, writeSite(text, site, version));
    changed.push(site.path);
  }
  return changed;
}

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/**
 * Failures go to stderr: a pre-commit hook's stdout can be swallowed, and this repository has
 * already shipped one check that reported on a stream nothing was reading.
 */
function report(failures: readonly SiteFailure[], expected: string, source: string): void {
  const checked = VERSION_SITES.length + FORBIDDEN_VERSION_SITES.length;
  process.stderr.write(
    `version drift: ${failures.length} of ${checked} checked site(s) disagree with ${expected},\nread from ${source}.\n\n` +
      `${describeFailures(failures)
        .map((line) => `  ${line}`)
        .join("\n")}\n\nFix: bun run version:sync\n`,
  );
}

function usage(message: string): never {
  process.stderr.write(`version-sync: ${message}\n`);
  process.exit(2);
}

function stage(paths: readonly string[], root: string): void {
  if (paths.length === 0) return;
  const child = Bun.spawnSync({
    cmd: ["git", "add", "--", ...paths],
    cwd: root,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  // A failed `git add` must fail the hook: otherwise the commit silently keeps the drifted content.
  if (child.exitCode !== 0) {
    process.stderr.write(`version-sync: git add failed\n${child.stderr.toString()}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string) => argv.includes(name);
  const value = (name: string) => {
    const index = argv.indexOf(name);
    return index < 0 ? undefined : argv[index + 1];
  };

  const set = value("--set");
  const expectedFlag = value("--expect");
  const staged = flag("--staged");
  const write = flag("--write") || set !== undefined;

  if (flag("--list")) {
    process.stdout.write(`${VERSION_SITES.map((site) => site.path).join("\n")}\n`);
    process.exit(0);
  }
  if (write && staged) usage("--write/--set cannot read the index; drop --staged");
  for (const candidate of [set, expectedFlag])
    if (candidate !== undefined && !SEMVER.test(candidate)) usage(`not a semantic version: ${candidate}`);

  if (write) {
    const version = set ?? sourceVersion(worktreeReader());
    if (set !== undefined) {
      const file = join(ROOT, SOURCE_SITE.path);
      writeFileSync(file, writeSite(readFileSync(file, "utf8"), SOURCE_SITE, set));
    }
    const changed = syncWorktree(version, ROOT);
    process.stdout.write(
      changed.length
        ? `version-sync: wrote ${version} to ${changed.length} site(s)\n${changed.map((path) => `  ${path}`).join("\n")}\n`
        : `version-sync: every site already carries ${version}\n`,
    );
    if (flag("--stage")) stage(changed, ROOT);
    // A writer that does not verify its own output is the next piece of decoration.
    const residual = inspect(worktreeReader(), version);
    if (residual.length) {
      report(residual, version, "the working tree, after writing");
      process.exit(1);
    }
    process.exit(0);
  }

  const read = staged ? indexReader() : worktreeReader();
  const source = staged ? "the git index (the content of this commit)" : "the working tree";
  const version = expectedFlag ?? sourceVersion(read);
  const failures = inspect(read, version);
  if (!failures.length) {
    process.stdout.write(`version-sync: ${VERSION_SITES.length} site(s) agree on ${version} in ${source}\n`);
    process.exit(0);
  }
  report(failures, version, source);
  process.exit(1);
}

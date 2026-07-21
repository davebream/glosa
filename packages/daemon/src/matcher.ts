// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — the ONE canonical file matcher (A4 §F20). chokidar v4 dropped glob support and
// git-pathspec isn't minimatch-compatible, so no consumer (watcher, sidebar, git-pathspec staging)
// is allowed to hold its own glob — they all consume the single normalized LIST this module
// produces. Built on picomatch (zero-dep, fs-free — A4 §F20 sanctions it by name; pure JS, no
// native addon).
import { existsSync, lstatSync, readFileSync, readdirSync, type Stats } from "node:fs";
import { join } from "node:path";
import picomatch from "picomatch";

export interface MatcherArtifactsConfig {
  include: string[];
  exclude: string[];
  maxFileBytes: number;
  /** Reserved for a future toggle. `resolveMatchedFiles` NEVER follows symlinks regardless of
   * this value — "don't follow symlinks" is a security invariant (closes the F24 traversal
   * escape), not a preference, so it isn't wired to anything yet. Kept in the config shape only
   * because A4 §F20's default config literally includes it. */
  followSymlinks: boolean;
}

export interface MatcherConfig {
  artifacts: MatcherArtifactsConfig;
}

export const DEFAULT_MATCHER_CONFIG: MatcherConfig = {
  artifacts: {
    include: ["**/*.md", "**/*.html", "**/*.txt"],
    exclude: [".glosa/**", "**/node_modules/**", ".*/**"],
    maxFileBytes: 2 * 1024 * 1024, // 2 MiB
    followSymlinks: false,
  },
};

/** Loads `<root>/.glosa/config.json` and deep-merges it onto `DEFAULT_MATCHER_CONFIG`. Missing
 * file → defaults, unchanged. Invalid JSON or a non-object override → throws (fail loud; a
 * config a user thinks is active but silently isn't is worse than a startup error). `include`/
 * `exclude` are UNIONED onto the defaults (an override "adds" a glob, per A4 §F20's example of
 * lowering `maxFileBytes` OR adding a glob) — the scalar fields (`maxFileBytes`,
 * `followSymlinks`) replace the default when present. */
export function loadMatcherConfig(root: string): MatcherConfig {
  const overridePath = join(root, ".glosa", "config.json");
  if (!existsSync(overridePath)) return DEFAULT_MATCHER_CONFIG;

  let raw: string;
  try {
    raw = readFileSync(overridePath, "utf8");
  } catch (err) {
    throw new Error(`matcher config: failed to read ${overridePath}: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`matcher config: invalid JSON in ${overridePath}: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`matcher config: ${overridePath} must contain a JSON object`);
  }

  const override = parsed as { artifacts?: Partial<MatcherArtifactsConfig> };
  const overrideArtifacts = override.artifacts ?? {};
  const base = DEFAULT_MATCHER_CONFIG.artifacts;
  return {
    artifacts: {
      include: [...base.include, ...(overrideArtifacts.include ?? [])],
      exclude: [...base.exclude, ...(overrideArtifacts.exclude ?? [])],
      maxFileBytes: overrideArtifacts.maxFileBytes ?? base.maxFileBytes,
      followSymlinks: overrideArtifacts.followSymlinks ?? base.followSymlinks,
    },
  };
}

export interface MatchedFile {
  /** POSIX `/`-separated, relative to root, NFC-normalized, no leading `./`. The comparison key
   * — this is what the include/exclude globs and the deterministic sort operate on. */
  path: string;
  /** The on-disk path (absolute), built from the raw (possibly NFD, as APFS hands back) segment
   * names. Filesystem operations (open/read) must use this, never `path` — APFS is
   * normalization-insensitive but not normalization-preserving; only the raw bytes are
   * guaranteed to resolve. */
  rawPath: string;
  sizeBytes: number;
}

export interface ResolveMatchedFilesResult {
  tracked: MatchedFile[];
  oversize: MatchedFile[];
  /** Diagnostic only — POSIX/NFC path of every symlink encountered (file or dir), root-relative.
   * Never matched, never descended into. */
  skippedSymlinks: string[];
}

/** Byte-order comparator on the UTF-8 encoding of the NFC path — deliberately not
 * `localeCompare` (locale-dependent) and not bare `<`/`>` on JS strings (UTF-16 code-unit order,
 * which only coincides with UTF-8 byte order inside the BMP). This is what makes the ordering
 * identical across the three consumers regardless of host locale. */
function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function toNfcPosixPath(segments: string[]): string {
  return segments.map((s) => s.normalize("NFC")).join("/");
}

/** Walks `root` with `lstatSync` (never follows symlinks — F24), matches every regular file
 * against `config.artifacts.include` minus `exclude`, and splits matches into `tracked` /
 * `oversize` by `maxFileBytes`. Deterministic: two runs over the same tree return byte-identical
 * ordering (sorted on the NFC `path`), so the watcher/sidebar/git consumers wired in later tasks
 * can't drift relative to each other. */
export function resolveMatchedFiles(
  root: string,
  config: MatcherConfig = loadMatcherConfig(root),
): ResolveMatchedFilesResult {
  // nocase: false is picomatch's default already — passed explicitly because A4 §F20 calls out
  // case-sensitivity as a deliberate choice, not an accident of the default: macOS's default FS
  // (APFS) is case-insensitive, but glosa treats artifact names case-sensitively regardless of
  // what the host filesystem would consider equal.
  const isIncluded = picomatch(config.artifacts.include, { nocase: false });
  const isExcluded = picomatch(config.artifacts.exclude, { nocase: false });

  // Directory-prune patterns DERIVED from the same exclude list — NOT a second, independent source
  // of glob knowledge (which is exactly the drift this module exists to prevent). Any exclude of
  // the form `P/**` swallows the entire subtree under `P`, so a directory whose path matches `P`
  // can be skipped wholesale: every file under it is excluded by construction, so descending would
  // only burn `lstat`s. This is what keeps the walk from crawling `node_modules` and, crucially,
  // `.glosa/` (incl. `.glosa/shadow.git` once F21 lands and it fills with objects). A symlink
  // inside a pruned subtree simply isn't discovered (its diagnostic listing is irrelevant — the
  // whole subtree is excluded anyway).
  const dirPrunePatterns = config.artifacts.exclude
    .filter((g) => g.endsWith("/**"))
    .map((g) => g.slice(0, -"/**".length));
  const isPrunedDir =
    dirPrunePatterns.length > 0 ? picomatch(dirPrunePatterns, { nocase: false }) : () => false;

  const candidates: { path: string; rawPath: string; sizeBytes: number }[] = [];
  const skippedSymlinks: string[] = [];

  const walk = (absDir: string, relSegments: string[]): void => {
    let names: string[];
    try {
      names = readdirSync(absDir);
    } catch {
      return; // unreadable dir (permissions, or raced-away) — skip, don't fail the whole walk
    }
    for (const name of names) {
      const absPath = join(absDir, name);
      const nextSegments = [...relSegments, name];
      let st: Stats;
      try {
        st = lstatSync(absPath);
      } catch {
        continue; // raced away between readdir and lstat
      }
      if (st.isSymbolicLink()) {
        // Neither followed nor matched, regardless of what it points at (in-root or outside) —
        // its target is never lstat'd/read/opened by this function.
        skippedSymlinks.push(toNfcPosixPath(nextSegments));
        continue;
      }
      if (st.isDirectory()) {
        // Skip descending into a directory whose whole subtree is excluded (derived above).
        if (isPrunedDir(toNfcPosixPath(nextSegments))) continue;
        walk(absPath, nextSegments);
      } else if (st.isFile()) {
        candidates.push({ path: toNfcPosixPath(nextSegments), rawPath: absPath, sizeBytes: st.size });
      }
      // other entry kinds (fifo, socket, device) are neither matched nor walked
    }
  };
  walk(root, []);

  const tracked: MatchedFile[] = [];
  const oversize: MatchedFile[] = [];
  for (const candidate of candidates) {
    if (!isIncluded(candidate.path) || isExcluded(candidate.path)) continue;
    const file: MatchedFile = candidate;
    // Strictly over the threshold is oversize; exactly-at is still tracked.
    if (file.sizeBytes > config.artifacts.maxFileBytes) oversize.push(file);
    else tracked.push(file);
  }

  tracked.sort((a, b) => byteCompare(a.path, b.path));
  oversize.sort((a, b) => byteCompare(a.path, b.path));
  skippedSymlinks.sort(byteCompare);

  return { tracked, oversize, skippedSymlinks };
}

export type CrossingEvent =
  | { type: "file_tracked"; path: string }
  | { type: "file_untracked"; path: string; reason: "oversize" | "deleted" };

/** Pure diff between two `resolveMatchedFiles` results — the §F20 threshold-crossing events.
 * Emits event DESCRIPTORS only; appending them to the journal (with a checkpoint, in the
 * oversize-crossing case "the last checkpoint stands" — no new checkpoint here) is later-task
 * wiring, not this function's job. */
export function diffSnapshots(prev: ResolveMatchedFilesResult, next: ResolveMatchedFilesResult): CrossingEvent[] {
  const prevTracked = new Set(prev.tracked.map((f) => f.path));
  const prevOversize = new Set(prev.oversize.map((f) => f.path));
  const nextTracked = new Set(next.tracked.map((f) => f.path));
  const nextOversize = new Set(next.oversize.map((f) => f.path));

  const events: CrossingEvent[] = [];

  for (const path of nextOversize) {
    if (prevTracked.has(path)) events.push({ type: "file_untracked", path, reason: "oversize" }); // grew past
  }
  for (const path of nextTracked) {
    if (prevOversize.has(path)) events.push({ type: "file_tracked", path }); // shrank under
    else if (!prevTracked.has(path)) events.push({ type: "file_tracked", path }); // new file
  }
  for (const path of prevTracked) {
    if (!nextTracked.has(path) && !nextOversize.has(path)) events.push({ type: "file_untracked", path, reason: "deleted" });
  }

  events.sort((a, b) => byteCompare(a.path, b.path));
  return events;
}

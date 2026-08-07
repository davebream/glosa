// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — the ONE answer to "what is this path's workspace root?" (issue #96).
//
// Before this module, three commands answered that question three different ways: `glosa open`
// registered an unowned file's CONTAINING DIRECTORY as a loose-file worktree, while `doctor` and
// `init` used their literal `dir` argument or `process.cwd()`. So `glosa doctor <repo>` could
// report a repo as wired while `glosa open <repo>/sub/doc.md` reported the same work as unwired
// and told the user to run `glosa init <repo>/sub` — or, for `/tmp/doc.md`, `glosa init
// /private/tmp`. Following that hint writes agent config into a system temp dir or a broad parent
// holding several unrelated repos.
//
// The rule, in one place, used by the daemon's open resolution and by the CLI's `init`/`doctor`
// cwd defaults: **a path's workspace root is its enclosing git repository**. That is the same
// boundary Claude Code itself uses to locate project settings, so it is the only root at which
// `.claude/settings.json` and `.mcp.json` actually take effect.
//
// Deliberately pure `node:fs` — no `git` spawn. `enclosingGitRoot` runs on every `glosa open` of
// a file, inside the global-index mutex; a subprocess there would be both slow and a new failure
// mode. A `.git` entry (directory OR file, so linked worktrees and submodules resolve) is the
// same marker `git rev-parse --show-toplevel` looks for.
import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, isAbsolute, sep } from "node:path";

/** Every path is compared post-`realpath` because macOS aliases `/tmp` -> `/private/tmp` and
 * `$TMPDIR` -> `/private/var/folders/...`; comparing the literal strings would miss both. */
function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** Is `dir` itself the root of a git repository? `.git` may be a directory (normal clone) or a
 * file (linked worktree / submodule pointing at the real git dir). */
export function isGitRepoRoot(dir: string, exists: (path: string) => boolean = existsSync): boolean {
  return exists(join(dir, ".git"));
}

/**
 * Walk up from `startDir` and return the first directory containing a `.git` entry, canonicalized
 * — or `null` when the walk reaches the filesystem root without finding one (a stray file in
 * `/tmp`, a scratch directory, a home-directory note).
 *
 * `startDir` is expected to be a directory. Callers holding a FILE path pass `dirname(file)`.
 */
export function enclosingGitRoot(
  startDir: string,
  exists: (path: string) => boolean = existsSync,
): string | null {
  let current = realOrSelf(startDir);
  for (;;) {
    if (isGitRepoRoot(current, exists)) return current;
    const parent = dirname(current);
    if (parent === current) return null; // hit `/`
    // Re-normalize at EVERY step, not just the start: `realOrSelf` on a nonexistent `startDir`
    // (a CLI target that doesn't exist yet, or the synthetic `join(outer, "other")` shape a test
    // walks up from) silently falls back to the raw string, so `parent` after the first hop can
    // still be un-normalized even though it names a real, existing ancestor. Calling `realOrSelf`
    // again here is a no-op once `current` is already canonical (`realpathSync` on a real path
    // returns that same path), so this costs nothing on the common case.
    current = realOrSelf(parent);
  }
}

/** `startDir`'s enclosing git repo, or `startDir` itself when it is not inside one. The shape
 * `init`/`doctor` want for their cwd default: always a usable root, never `null`. */
export function workspaceRootFor(
  startDir: string,
  exists: (path: string) => boolean = existsSync,
): { root: string; kind: "git-repo" | "literal" } {
  const repo = enclosingGitRoot(startDir, exists);
  return repo ? { root: repo, kind: "git-repo" } : { root: realOrSelf(startDir), kind: "literal" };
}

// ---------------------------------------------------------------------------------------------
// `glosa init` target safety (issue #96)
// ---------------------------------------------------------------------------------------------

export type InitTargetRisk = "none" | "temp-dir" | "multi-repo";

export interface InitTargetVerdict {
  risk: InitTargetRisk;
  /** Human-readable reason, empty for `none`. Rendered verbatim in the CLI error/warning. */
  detail: string;
}

export interface ClassifyInitTargetDeps {
  /** Temp roots to treat as unsafe. Defaults to the macOS set, each realpath'd. */
  tempRoots?: string[];
  exists?: (path: string) => boolean;
  /** Immediate entries of a directory; `[]` on any read error. */
  readDir?: (dir: string) => string[];
}

function defaultTempRoots(): string[] {
  return [...new Set([tmpdir(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"].map(realOrSelf))];
}

function defaultReadDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Would writing agent config into `dir` be a surprising mutation?
 *
 * The ladder, in order:
 *  1. **`dir` is itself a git repository → `none`.** A repo is a project root by definition, and
 *     that is true of a scratch repo created under `$TMPDIR` just as much as one in `~/code`. This
 *     is why the check leads with repo-ness rather than with the path prefix: the thing that makes
 *     `glosa init /private/tmp` wrong is that `/private/tmp` is not a project, not that it is
 *     under `/tmp`.
 *  2. **Under a temp root → `temp-dir`.** The `glosa open /tmp/doc.md` -> `glosa init /private/tmp`
 *     accident from issue #96.
 *  3. **Two or more immediate subdirectories are git repos → `multi-repo`.** A `~/code`-style
 *     parent. Config written here silently applies to every repo beneath it.
 *
 * Advisory only — this function never touches disk beyond stat/readdir. The CLI decides what a
 * non-`none` verdict costs (A6 §F26: refuse with exit 2, overridable by `--force` or a TTY
 * confirmation).
 */
export function classifyInitTarget(dir: string, deps: ClassifyInitTargetDeps = {}): InitTargetVerdict {
  const exists = deps.exists ?? existsSync;
  const readDir = deps.readDir ?? defaultReadDir;
  const resolved = realOrSelf(dir);

  if (isGitRepoRoot(resolved, exists)) return { risk: "none", detail: "" };

  const tempRoots = (deps.tempRoots ?? defaultTempRoots()).map(realOrSelf);
  const containingTempRoot = tempRoots.find((root) => isInside(root, resolved));
  if (containingTempRoot !== undefined) {
    return {
      risk: "temp-dir",
      detail: `${resolved} is inside the temporary directory ${containingTempRoot} and is not a git repository`,
    };
  }

  const repoChildren: string[] = [];
  for (const name of readDir(resolved)) {
    const child = join(resolved, name);
    try {
      if (!lstatSync(child).isDirectory()) continue;
    } catch {
      continue;
    }
    if (isGitRepoRoot(child, exists)) repoChildren.push(name);
    if (repoChildren.length >= 2) break;
  }
  if (repoChildren.length >= 2) {
    return {
      risk: "multi-repo",
      detail: `${resolved} is not a git repository but contains several (${repoChildren.sort().join(", ")}, …)`,
    };
  }

  return { risk: "none", detail: "" };
}

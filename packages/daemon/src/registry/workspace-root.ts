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
// The rule, in one place, used by the daemon's open resolution and by the CLI's `doctor`
// cwd default: **a path's workspace root is its enclosing git repository, with one boundary**
// (issue #146): that repository is never the user's home directory or an ancestor of it. On a
// machine whose home is itself a git checkout (a dotfiles repo, common), the unbounded walk
// reached `$HOME` for anything with no nearer repository and every caller adopted the user's
// whole home directory as a workspace. The boundary lives in exactly one place — the raw walk is
// module-private below, and every policy-bearing export applies it — so a fourth caller cannot
// reach around it the way `workspace-index.ts` once did. That is the same enclosing-repository
// boundary Claude Code itself uses to locate project settings, so it is the only root at which
// `.claude/settings.json` and `.mcp.json` actually take effect.
//
// Deliberately pure `node:fs` — no `git` spawn. The walk runs on every `glosa open` of a file,
// inside the global-index mutex; a subprocess there would be both slow and a new failure mode. A
// `.git` entry (directory OR file, so linked worktrees and submodules resolve) is the same marker
// `git rev-parse --show-toplevel` looks for.
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
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

/**
 * Is `root` the user's home directory, or an ancestor of it (issue #146)? `/Users` or `/` is the
 * same class of mistake as `$HOME` itself — the same unbounded upward walk reaches it whenever no
 * nearer repository exists.
 *
 * False for a repository that is merely a SUBdirectory of home — the ordinary, must-keep-working
 * case. `isInside(root, home)` asks "is `home` at or beneath `root`?"; when `root` is instead
 * beneath `home`, `home` is an ANCESTOR of `root`, not the other way around, so this returns
 * `false` and the repo resolves exactly as it always has.
 */
export function isHomeOrAncestor(root: string, home: string): boolean {
  return isInside(root, realOrSelf(home));
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
 *
 * MODULE-PRIVATE (issue #146): this walk has no boundary of its own — on a machine whose home is
 * itself a git checkout (a dotfiles repo, common), it reaches `$HOME` for anything with no nearer
 * repository, and a caller that adopted that answer as-is pointed a workspace at the user's whole
 * home directory. Every shipping caller must go through `enclosingGitRootWithin` or
 * `workspaceRootFor` below, both of which apply that boundary; `test/registry/import-guard.test.ts`
 * asserts no other shipping module reaches this function.
 */
function rawEnclosingGitRoot(startDir: string, exists: (path: string) => boolean = existsSync): string | null {
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

/**
 * `startDir`'s enclosing git repository — the SAME walk `rawEnclosingGitRoot` performs — refusing
 * to answer with the user's home directory or any ancestor of it (issue #146). `home` defaults to
 * `os.homedir()`, but every acceptance case for this boundary drives a temp directory through this
 * parameter instead: `os.homedir()` does not follow a mutated `process.env.HOME` under the pinned
 * Bun, so a boundary with no such seam could never be handed a fake home by a test.
 *
 * "No enclosing repository" and "the enclosing repository is home-or-above" both fold to `null`.
 * Every caller in this codebase already treats a `null` enclosing root as "nothing to promote to
 * here", so there is no shipping caller that needs to tell the two apart.
 */
export function enclosingGitRootWithin(
  startDir: string,
  home: string = homedir(),
  exists: (path: string) => boolean = existsSync,
): string | null {
  const root = rawEnclosingGitRoot(startDir, exists);
  if (root === null) return null;
  return isHomeOrAncestor(root, home) ? null : root;
}

/** `startDir`'s enclosing git repo (bounded, see `enclosingGitRootWithin`), or `startDir` itself
 * when it is not inside one. The shape `init`/`doctor` want for their cwd default: always a usable
 * root, never `null`. */
export function workspaceRootFor(
  startDir: string,
  home: string = homedir(),
  exists: (path: string) => boolean = existsSync,
): { root: string; kind: "git-repo" | "literal" } {
  const repo = enclosingGitRootWithin(startDir, home, exists);
  return repo ? { root: repo, kind: "git-repo" } : { root: realOrSelf(startDir), kind: "literal" };
}

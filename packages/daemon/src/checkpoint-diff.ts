// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — GET /w/:slug/diff support (A1 §5.7): resolves a from..to checkpoint range into
// per-file unified diffs with their `Glosa-Attribution` trailer, read straight off shadow-git
// history that checkpoint()/diffShas (git/shadow.ts) already produced — this module only reads it
// back. Kept separate from http.ts so the route handler itself stays a thin dispatcher.
import { runGit, safePathspec } from "./git/shadow.ts";
import type { WorkspaceTarget } from "./workspace.ts";

export interface DiffHunk {
  path: string;
  diff: string;
  attribution: string;
}

/** `sha^{commit}` resolves only if `sha` names an actual commit reachable in this repo — this is
 * what tells a caller-supplied checkpoint id apart from garbage without ever throwing. A missing
 * shadow repo entirely (no `.glosa/shadow.git` yet, e.g. a workspace with no tracked files and no
 * lease history) fails the git spawn itself ("not a git repository", exit 128) — caught here the
 * same as any other "not a real commit" case, so this never throws either way. */
export async function commitExists(root: WorkspaceTarget, sha: string): Promise<boolean> {
  try {
    const result = await runGit(root, ["cat-file", "-e", `${sha}^{commit}`], { allowExitCodes: [0, 1, 128] });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/** The `Glosa-Attribution` trailer of the MOST RECENT commit in `from..to` that touched `path` —
 * i.e. whichever checkpoint last wrote this file within the requested range. This is what makes a
 * post-apply commit's `session:<id>` (not the pre-apply commit's `unknown`) the value surfaced for
 * a file actually edited under a lease: `resolveEntry`'s checkpoint always lands AFTER
 * `applyBegin`'s, so it sorts first in `git log`'s reverse-chronological output. A path with no
 * commit at all in the range (shouldn't happen — callers only ask this for paths `git diff
 * --name-only` already reported as changed) falls back to "unknown", never a throw. */
export async function fileAttribution(root: WorkspaceTarget, from: string, to: string, path: string): Promise<string> {
  const log = await runGit(root, ["log", "--format=%H", `${from}..${to}`, "--", safePathspec(path)]);
  const shas = log.stdout.split("\n").filter((line) => line.length > 0);
  if (shas.length === 0) return "unknown";
  const mostRecent = shas[0] as string;
  const trailer = await runGit(root, [
    "show",
    "-s",
    "--format=%(trailers:key=Glosa-Attribution,valueonly)",
    mostRecent,
  ]);
  const value = trailer.stdout.trim();
  return value.length > 0 ? value : "unknown";
}

/** Builds the A1 §5.7 `hunks[]` array: one unified diff + its attribution per file changed between
 * `from` and `to`. Per-file `git diff` calls (rather than splitting one combined diff's text on
 * `diff --git` headers) so the attribution lookup can reuse the exact same pathspec without
 * re-parsing header lines — simpler, and immune to path-quoting edge cases in a combined diff.
 *
 * `to` may be the sentinel `"working"` (P3.5, A6 §F31's "checkpoint <-> working" diff form) — `git
 * diff <rev>` with a SINGLE ref compares that ref against the live working tree instead of another
 * commit, so the sentinel only changes how the argv is built, never what's parsed out of it.
 * Attribution for the working-tree form still reads trailers from `from..HEAD` (the committed
 * side of the range) — an uncommitted delta has no trailer of its own to report, so "whatever the
 * last real checkpoint in range attributed" is the honest answer, same as any other gap the
 * committed history doesn't cover. */
export async function buildDiffHunks(root: WorkspaceTarget, from: string, to: string): Promise<DiffHunk[]> {
  const isWorking = to === "working";
  const nameOnlyArgs = isWorking ? ["diff", "--name-only", "-M", from] : ["diff", "--name-only", "-M", from, to];
  const nameOnly = await runGit(root, nameOnlyArgs);
  const paths = nameOnly.stdout.split("\n").filter((line) => line.length > 0);

  const hunks: DiffHunk[] = [];
  for (const path of paths) {
    const diffArgs = isWorking
      ? ["diff", "-M", from, "--", safePathspec(path)]
      : ["diff", "-M", from, to, "--", safePathspec(path)];
    const fileDiff = await runGit(root, diffArgs);
    const attribution = await fileAttribution(root, from, isWorking ? "HEAD" : to, path);
    hunks.push({ path, diff: fileDiff.stdout, attribution });
  }
  return hunks;
}

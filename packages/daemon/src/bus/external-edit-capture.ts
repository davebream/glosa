// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — the shadow-git half of `external_edit` (#144, #153 Part 1): turning a checkpoint
// interval into one payload per changed artifact, and finding the drift commits no entry names.
//
// Deliberately a SEPARATE module from `external-edit.ts`. That one holds the kind, the payload
// shape, and the `isExternalEditEntry` predicate every exclusion fold calls — and `peek.ts`'s
// read-only folds are among those callers. `peek.ts` exists precisely so a plain GET (or a GC
// pass) never gains write side effects "incl. spawning git", so it must not transitively import
// the git layer to ask what kind an entry is. The split keeps that true by construction.
import { runGit, safePathspec } from "../git/shadow.ts";
import type { WorkspaceTarget } from "../workspace.ts";
import {
  EXTERNAL_EDIT_CHECKPOINT_KIND,
  EXTERNAL_EDIT_KIND,
  type ExternalEditPayload,
  type ExternalEditSource,
} from "./external-edit.ts";

/** Splits one checkpoint interval into one payload per changed artifact. The path list comes from
 * git's own diff of the two commits rather than from the filesystem events that triggered the
 * capture: the commit is what durably happened, a watcher event set is only what was noticed, and
 * a missed or coalesced event would otherwise silently drop an artifact from the report. */
export async function externalEditPayloads(
  workspace: WorkspaceTarget,
  sinceSha: string,
  untilSha: string,
  source: ExternalEditSource,
  observedAt: string,
): Promise<ExternalEditPayload[]> {
  // `-z` (NUL-delimited, never C-quoted) for the same reason `shadow.ts`'s `trackedUnion` uses it:
  // git C-quotes a filename containing a tab/newline/quote/backslash regardless of `core.quotepath`,
  // and a quoted path would never match the real one this payload names.
  const listed = await runGit(workspace, ["diff", "-M", "--name-only", "-z", sinceSha, untilSha]);
  const paths = listed.stdout.split("\0").filter((path) => path.length > 0);

  const payloads: ExternalEditPayload[] = [];
  for (const path of paths) {
    const diff = (await runGit(workspace, ["diff", "-M", sinceSha, untilSha, "--", safePathspec(path)])).stdout;
    payloads.push({
      kind: EXTERNAL_EDIT_KIND,
      path,
      diff,
      diff_bytes: Buffer.byteLength(diff, "utf8"),
      since_checkpoint: sinceSha,
      until_checkpoint: untilSha,
      observed_at: observedAt,
      source,
    });
  }
  return payloads;
}

export interface DriftCommit {
  sha: string;
  /** The checkpoint this commit's changes are measured against. Empty only for a root commit,
   * which is always the `baseline` and therefore never a drift commit in the first place. */
  parent: string;
}

/** Every drift-capturing checkpoint reachable from HEAD that no `external_edit` entry names yet —
 * the recovery for contract A7's crash gap.
 *
 * WHY A SCAN AND NOT A RETRY. The ordering is forced: the entry has to name the commit, so the
 * commit goes first. A crash in that window is PERMANENT rather than transient, because
 * `checkpoint()` is idempotent (A4 §F21: nothing staged -> return HEAD, no commit) — the next
 * quiet window, and offline catch-up on the next restart, both find a clean worktree and have no
 * diff left to synthesize the missing entry from. `selfHealInbox` repairs the neighbouring gap
 * (inbox file written, `entry_created` not appended) and has no analogue here.
 *
 * What survives is shadow history: the commit is still there, still carrying its trailers, either
 * way. So the durable signal is exactly the one the contract names — the last emitted
 * `until_checkpoint` compared against the current shadow HEAD — read here as the commit range
 * between them. `frontier` is that last reported sha (`null` when this workspace has never
 * reported one, in which case the whole history is walked; that costs one `git log` spawn at
 * startup and stops happening the moment a first entry is emitted).
 *
 * Only `EXTERNAL_EDIT_CHECKPOINT_KIND` commits qualify, and the exclusions are what keep this from
 * re-reporting glosa's own work: `baseline` captures what was on disk before glosa was watching,
 * `pre_apply`/`post_apply`/`apply_expired` belong to a lease's own interval, and
 * `human_edit`/`restore` are `human` by construction. No producer writes an `auto_checkpoint`
 * commit while a lease is held — both the watcher and offline catch-up defer entirely — so no
 * lease-window commit can reach this scan by that kind either. */
export async function unreportedDriftCommits(
  workspace: WorkspaceTarget,
  frontier: string | null,
  reported: ReadonlySet<string>,
): Promise<DriftCommit[]> {
  const range = frontier ? `${frontier}..HEAD` : "HEAD";
  // ONE git invocation for the whole range, trailers included — deliberately not one `git show` per
  // commit. This runs on a startup path, and before a workspace has ever reported an external edit
  // there is no frontier, so the range is its ENTIRE shadow history: a per-commit spawn would make
  // daemon start scale with how many times the workspace has ever been checkpointed.
  //
  // `%x1e`-terminated records with `%x1f`-separated fields, because a trailer block ends with its
  // own newline and line-oriented parsing would mis-frame every record after the first.
  //
  // Exit 128 = no HEAD yet (shadow repo before its first commit) — nothing to recover, same house
  // pattern as `isPathDirty`. A `frontier` that no longer resolves fails the same way and degrades
  // to "nothing found" rather than taking reconcile down; the next emitted entry re-pins a frontier
  // that does resolve.
  const log = await runGit(
    workspace,
    ["log", "--reverse", "--format=%H%x1f%P%x1f%(trailers:key=Glosa-Kind,valueonly,separator=%x2c)%x1e", range],
    { allowExitCodes: [0, 128] },
  );
  if (log.exitCode !== 0) return [];

  const commits: DriftCommit[] = [];
  for (const record of log.stdout.split("\x1e")) {
    const fields = record.trim().split("\x1f");
    if (fields.length < 3) continue;
    const [sha = "", parents = "", kinds = ""] = fields;
    if (sha.length === 0 || reported.has(sha)) continue;
    const parent = parents.split(" ").filter(Boolean)[0];
    if (!parent) continue; // root commit == the baseline; it reports the starting point, not a change
    if (kinds.trim() !== EXTERNAL_EDIT_CHECKPOINT_KIND) continue;
    commits.push({ sha, parent });
  }
  return commits;
}

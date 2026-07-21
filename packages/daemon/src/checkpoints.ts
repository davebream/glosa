// @glosa/daemon — GET /w/:slug/checkpoints support (A6 §F31): resolves the `since` token
// (`yesterday`|`today`|ISO|<checkpoint-id>) and lists the shadow-git history as rows the UI can
// render in DOCUMENT-NATIVE language (checkpoint_id is an opaque short sha, never surfaced to the
// human as "a commit" — R1). Reads shadow-git history the same way checkpoint-diff.ts does (this
// module only reads what git/shadow.ts's `checkpoint()` already produced).
import { commitExists } from "./checkpoint-diff.ts";
import { runGit } from "./git/shadow.ts";

export interface CheckpointRow {
  checkpoint_id: string;
  at: string;
  by: string;
  summary: string;
  bytes_changed: number;
}

// git's magic empty-tree object — diffing a root commit (no parent) against this is how you get
// "everything this commit introduced" instead of failing on a nonexistent `<sha>^`.
const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

// ISO 8601 dates always start `YYYY-MM-DD` — a shadow-git short/full sha is lowercase hex and can
// never contain a `-`, so this one anchor is enough to tell "an ISO since=" apart from "a
// checkpoint-id since=" before ever asking git about it.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}/;

/** A6 §F31: "day-boundary words resolve in the HOST LOCAL TZ". Built from `now`'s LOCAL calendar
 * components (`getFullYear`/`getMonth`/`getDate`), not `now.getTime() - 24*3600*1000` — the naive
 * subtraction is wrong exactly on a DST-transition day (the local calendar day it lands on is 23
 * or 25 real hours, not 24), which is the specific bug this construction avoids and
 * `checkpoints.test.ts`'s DST case proves against a real spring-forward/fall-back date pair. */
export function resolveDayBoundary(token: "yesterday" | "today", now: Date): string {
  const daysBack = token === "yesterday" ? 1 : 0;
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysBack, 0, 0, 0, 0);
  return midnight.toISOString();
}

export type SinceResolution =
  | { ok: true; mode: "boundary"; iso: string }
  | { ok: true; mode: "checkpoint"; checkpointId: string }
  | { ok: false };

/** Resolves the A6 §F31 `since` token against this workspace's shadow-git history + `now`.
 * `yesterday`/`today` and a bare ISO string both resolve to a `"boundary"` instant (an ISO date
 * honors its OWN offset — `new Date(since)` does that for free, no extra handling needed); anything
 * else is checked against the shadow repo as a checkpoint id (`ok:false` if it's none of the above
 * — an unrecognized token, per A6 §F31's own listed forms). */
export async function resolveSince(root: string, since: string, now: Date): Promise<SinceResolution> {
  if (since === "yesterday" || since === "today") {
    return { ok: true, mode: "boundary", iso: resolveDayBoundary(since, now) };
  }
  if (ISO_DATE_RE.test(since)) {
    const parsed = Date.parse(since);
    if (!Number.isNaN(parsed)) return { ok: true, mode: "boundary", iso: new Date(parsed).toISOString() };
    return { ok: false };
  }
  if (await commitExists(root, since)) {
    return { ok: true, mode: "checkpoint", checkpointId: since };
  }
  return { ok: false };
}

// Unit separator (never appears in a date/trailer value) so one `git show` call can carry the
// short sha, committer date, and both trailers as a single line, split back apart reliably —
// mirrors checkpoint-diff.ts's per-commit git calls, just combined into one round trip per row.
const FIELD_SEP = "\x1f";

async function commitMeta(root: string, sha: string): Promise<{ id: string; at: string; by: string; kind: string }> {
  const format = ["%h", "%cI", "%(trailers:key=Glosa-Attribution,valueonly)", "%(trailers:key=Glosa-Kind,valueonly)"].join(
    FIELD_SEP,
  );
  const result = await runGit(root, ["show", "-s", `--format=${format}`, sha]);
  const [id, at, by, kind] = result.stdout.split(FIELD_SEP).map((s) => s.trim());
  return { id: id ?? sha, at: at ?? "", by: by || "unknown", kind: kind || "unknown" };
}

async function bytesChanged(root: string, sha: string): Promise<number> {
  const parent = await runGit(root, ["rev-parse", `${sha}^`], { allowExitCodes: [0, 128] });
  const from = parent.exitCode === 0 ? parent.stdout.trim() : EMPTY_TREE_SHA;
  const diff = await runGit(root, ["diff", from, sha]);
  return Buffer.byteLength(diff.stdout, "utf8");
}

export interface ListCheckpointsOptions {
  since?: string;
  limit?: number;
}

export type ListCheckpointsResult = { ok: true; rows: CheckpointRow[] } | { ok: false };

/** Lists checkpoints newest-first (A6 §F31). `since` narrows the range (a day-boundary/ISO instant
 * filters by committer date; a checkpoint id filters to `<id>..HEAD`, i.e. strictly after it);
 * `limit` caps the row count AFTER filtering. `ok:false` only for an unrecognized `since` token —
 * an empty/never-checkpointed workspace is `ok:true, rows:[]`, not an error. */
export async function listCheckpoints(root: string, opts: ListCheckpointsOptions, now: Date): Promise<ListCheckpointsResult> {
  let revRange = "HEAD";
  let sinceMs: number | undefined;

  if (opts.since !== undefined) {
    const resolved = await resolveSince(root, opts.since, now);
    if (!resolved.ok) return { ok: false };
    if (resolved.mode === "checkpoint") revRange = `${resolved.checkpointId}..HEAD`;
    else sinceMs = new Date(resolved.iso).getTime();
  }

  if (!(await commitExists(root, "HEAD"))) return { ok: true, rows: [] }; // nothing ever checkpointed

  const log = await runGit(root, ["log", "--format=%H", revRange]);
  const shas = log.stdout.split("\n").filter((line) => line.length > 0);

  const rows: CheckpointRow[] = [];
  for (const sha of shas) {
    const meta = await commitMeta(root, sha);
    if (sinceMs !== undefined && new Date(meta.at).getTime() < sinceMs) continue;
    rows.push({ checkpoint_id: meta.id, at: meta.at, by: meta.by, summary: meta.kind, bytes_changed: await bytesChanged(root, sha) });
    if (opts.limit !== undefined && rows.length >= opts.limit) break;
  }
  return { ok: true, rows };
}

// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — GET /w/:slug/checkpoints support (A6 §F31): resolves the `since` token
// (`yesterday`|`today`|ISO|<checkpoint-id>) and lists the shadow-git history as rows the UI can
// render in DOCUMENT-NATIVE language (checkpoint_id is an opaque short sha, never surfaced to the
// human as "a commit" — R1). Reads shadow-git history the same way checkpoint-diff.ts does (this
// module only reads what git/shadow.ts's `checkpoint()` already produced).
import { commitExists } from "./checkpoint-diff.ts";
import { runGit } from "./git/shadow.ts";
import type { WorkspaceTarget } from "./workspace.ts";
import { existsSync, readFileSync } from "node:fs";
import { journalPath } from "./bus/paths.ts";

export interface CheckpointRow {
  checkpoint_id: string;
  at: string;
  by: string;
  summary: string;
  bytes_changed: number;
  origin: "workspace" | "lineage";
  lineage_id?: string;
}

interface LineageSourcePath {
  registration_id: string;
  source_path: string;
  target_path: string;
}

interface LineageInfo {
  adoption_id: string;
  sources: LineageSourcePath[];
}

function attachedLineages(root: WorkspaceTarget): LineageInfo[] {
  const path = journalPath(root);
  if (!existsSync(path)) return [];
  const byId = new Map<string, LineageInfo>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const event = JSON.parse(line) as { event?: unknown; detail?: Record<string, unknown> };
      if (event.event !== "lineage_attached") continue;
      const adoptionId = event.detail?.adoption_id;
      const sources = event.detail?.sources;
      if (typeof adoptionId !== "string" || !Array.isArray(sources)) continue;
      byId.set(adoptionId, {
        adoption_id: adoptionId,
        sources: sources.filter(
          (source): source is LineageSourcePath =>
            typeof source === "object" &&
            source !== null &&
            typeof (source as Record<string, unknown>).registration_id === "string" &&
            typeof (source as Record<string, unknown>).source_path === "string" &&
            typeof (source as Record<string, unknown>).target_path === "string",
        ),
      });
    } catch {
      // Replay owns quarantine; a history listing remains read-only and ignores a torn/bad line.
    }
  }
  return [...byId.values()];
}

async function lineageRefs(root: WorkspaceTarget): Promise<Map<string, string>> {
  const result = await runGit(root, ["for-each-ref", "--format=%(refname)", "refs/glosa/lineages"], {
    allowExitCodes: [0, 128],
  });
  if (result.exitCode !== 0) return new Map();
  const refs = new Map<string, string>();
  for (const ref of result.stdout.split("\n").filter(Boolean)) {
    const id = ref.split("/").at(-2);
    if (id) refs.set(id, ref);
  }
  return refs;
}

async function checkpointOrigins(
  root: WorkspaceTarget,
): Promise<Map<string, { origin: "workspace" | "lineage"; lineageId?: string }>> {
  const origins = new Map<string, { origin: "workspace" | "lineage"; lineageId?: string }>();
  if (await commitExists(root, "HEAD")) {
    const active = await runGit(root, ["log", "--format=%H", "HEAD"]);
    for (const sha of active.stdout.split("\n").filter(Boolean)) origins.set(sha, { origin: "workspace" });
  }
  for (const [lineageId, ref] of await lineageRefs(root)) {
    const log = await runGit(root, ["log", "--format=%H", ref]);
    for (const sha of log.stdout.split("\n").filter(Boolean)) {
      if (!origins.has(sha)) origins.set(sha, { origin: "lineage", lineageId });
    }
  }
  return origins;
}

/** Returns the historical source path for a target artifact at `checkpoint`, if that checkpoint
 * belongs to an imported lineage. Active workspace commits intentionally return the input path. */
export async function checkpointArtifactPath(
  root: WorkspaceTarget,
  checkpoint: string,
  targetPath: string,
): Promise<string> {
  const refs = await lineageRefs(root);
  for (const lineage of attachedLineages(root)) {
    for (const source of lineage.sources) {
      if (source.target_path !== targetPath) continue;
      const ref = refs.get(source.registration_id);
      if (!ref) continue;
      const reachable = await runGit(root, ["merge-base", "--is-ancestor", checkpoint, ref], {
        allowExitCodes: [0, 1],
      });
      if (reachable.exitCode === 0) return source.source_path;
    }
  }
  return targetPath;
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
export async function resolveSince(root: WorkspaceTarget, since: string, now: Date): Promise<SinceResolution> {
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

async function commitMeta(
  root: WorkspaceTarget,
  sha: string,
): Promise<{ id: string; at: string; by: string; kind: string }> {
  const format = [
    "%h",
    "%cI",
    "%(trailers:key=Glosa-Attribution,valueonly)",
    "%(trailers:key=Glosa-Kind,valueonly)",
  ].join(FIELD_SEP);
  const result = await runGit(root, ["show", "-s", `--format=${format}`, sha]);
  const [id, at, by, kind] = result.stdout.split(FIELD_SEP).map((s) => s.trim());
  return { id: id ?? sha, at: at ?? "", by: by || "unknown", kind: kind || "unknown" };
}

async function bytesChanged(root: WorkspaceTarget, sha: string): Promise<number> {
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
export async function listCheckpoints(
  root: WorkspaceTarget,
  opts: ListCheckpointsOptions,
  now: Date,
): Promise<ListCheckpointsResult> {
  let sinceMs: number | undefined;
  let sinceCheckpoint: string | undefined;

  if (opts.since !== undefined) {
    const resolved = await resolveSince(root, opts.since, now);
    if (!resolved.ok) return { ok: false };
    if (resolved.mode === "checkpoint") sinceCheckpoint = resolved.checkpointId;
    else sinceMs = new Date(resolved.iso).getTime();
  }

  const origins = await checkpointOrigins(root);
  if (origins.size === 0) return { ok: true, rows: [] };
  const refs = [...(await lineageRefs(root)).values()];
  const revisions = [...((await commitExists(root, "HEAD")) ? ["HEAD"] : []), ...refs];
  const orderedLog = await runGit(root, ["log", "--date-order", "--format=%H", ...revisions]);
  let shas = orderedLog.stdout.split("\n").filter(Boolean);
  if (sinceCheckpoint) {
    const resolved = await runGit(root, ["rev-parse", "--verify", sinceCheckpoint]);
    const index = shas.indexOf(resolved.stdout.trim());
    if (index >= 0) shas = shas.slice(0, index);
  }

  const rows: CheckpointRow[] = [];
  for (const sha of shas) {
    const origin = origins.get(sha);
    if (!origin) continue;
    const meta = await commitMeta(root, sha);
    if (sinceMs !== undefined && new Date(meta.at).getTime() < sinceMs) continue;
    rows.push({
      checkpoint_id: meta.id,
      at: meta.at,
      by: meta.by,
      summary: meta.kind,
      bytes_changed: await bytesChanged(root, sha),
      origin: origin.origin,
      ...(origin.lineageId ? { lineage_id: origin.lineageId } : {}),
    });
    if (opts.limit !== undefined && rows.length >= opts.limit) break;
  }
  return { ok: true, rows };
}

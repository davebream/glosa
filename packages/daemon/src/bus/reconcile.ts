// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — startup reconciliation, the ordered sequence from A4 §F04:
//   1. torn-tail truncate   2. replay -> derived state   3. inbox<->journal self-heal
//   4. apply-lease reconcile (P2.3 stub)   5. offline catch-up (P2.3 stub)
// Steps 4-5 depend on shadow-git (F21, not built yet) — they're typed no-ops here, wired into
// the driver so P2.3 only has to fill in the two function bodies.
import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, truncateSync } from "node:fs";
import { appendEvent, JournalWriter, type JournalEvent } from "./journal.ts";
import { cleanupOrphanInboxTempFiles, listInboxEntryIds } from "./inbox.ts";
import { journalPath, quarantinePath, shadowGitDir, workspaceBusDir } from "./paths.ts";
import { quarantineRawBytes } from "./quarantine.ts";
import { applyEvent, replayJournal, type DerivedState, type Reducer } from "./replay.ts";
import { lifecycleReducer } from "./lifecycle.ts";
import { ulid as defaultUlid } from "./ulid.ts";
import { checkpoint, headSha, initShadowRepo, reclaimIndexLock } from "../git/shadow.ts";
import { resolveTrackedFiles } from "../matcher.ts";
import { workspaceWorktree, type WorkspaceTarget } from "../workspace.ts";

export interface TailTruncateResult {
  truncated: boolean;
  bytesRemoved: number;
}

interface ReconcileDeps {
  journalPath: string;
  quarantinePath: string;
  writer: JournalWriter;
  ulid: () => string;
  now?: () => Date;
}

/** Step 1. A crash mid-append leaves a final line with no trailing "\n" — safe to detect because
 * fsync-before-ACK means any event the caller was ever told succeeded already has its newline on
 * disk. Truncates back to the last clean newline, quarantines the torn bytes (which may not even
 * be a full line), and records the repair. */
export function truncateTornTail(deps: ReconcileDeps): TailTruncateResult {
  if (!existsSync(deps.journalPath)) return { truncated: false, bytesRemoved: 0 };
  const raw = readFileSync(deps.journalPath);
  if (raw.length === 0) return { truncated: false, bytesRemoved: 0 };
  if (raw[raw.length - 1] === 0x0a) return { truncated: false, bytesRemoved: 0 }; // clean tail, nothing to do

  const lastNewlineIdx = raw.lastIndexOf(0x0a); // -1 if not even one complete record exists
  const keepLen = lastNewlineIdx + 1;
  const tornBytes = raw.subarray(keepLen);

  // Ordering note: if the process dies between this quarantine write and the truncate below, the
  // next startup sees the same torn tail again and repeats both — a harmless duplicate entry in
  // the quarantine file plus a duplicate `journal_tail_truncated` event (unlike the interior-line
  // case in replay.ts, this one isn't deduped; it's rare, self-limiting, and not worth the extra
  // machinery for a startup-only path).
  quarantineRawBytes(deps.quarantinePath, tornBytes);
  truncateSync(deps.journalPath, keepLen);
  // `truncateSync` takes a path, not our writer's fd, and a metadata change like a file shrink
  // isn't guaranteed durable until something fsyncs a fd for this file — so open one just for
  // that, rather than assuming the `journal_tail_truncated` append below will cover it (a crash
  // between the two would otherwise leave the truncation itself unconfirmed).
  const tfd = openSync(deps.journalPath, "r+");
  try {
    fsyncSync(tfd);
  } finally {
    closeSync(tfd);
  }

  const hash = createHash("sha256").update(tornBytes).digest("hex");
  const event: JournalEvent = {
    v: 1,
    event_id: deps.ulid(),
    at: (deps.now?.() ?? new Date()).toISOString(),
    event: "journal_tail_truncated",
    by: "daemon",
    detail: { bytes: tornBytes.byteLength, hash },
  };
  // Not in the lifecycle-critical set, but this only runs once at startup — force fsync so the
  // repair itself is durable before reconcile proceeds to trust the (now-clean) file.
  appendEvent(deps.writer, event, { fsync: true });

  return { truncated: true, bytesRemoved: tornBytes.byteLength };
}

/** Step 3. An inbox file on disk with no `entry_created` in the journal means the daemon crashed
 * after the write-once rename but before the paired journal append (A4 §F04's ordering makes the
 * reverse gap — event without file — impossible, so this is the only direction to heal).
 * Synthesizes and appends the missing `entry_created`, folding it into `state` immediately so the
 * caller doesn't have to re-replay. Also sweeps orphaned inbox `*.tmp` files (crash-before-rename
 * — already inert, this just tidies up). */
export function selfHealInbox(deps: {
  workspaceRoot: WorkspaceTarget;
  state: DerivedState;
  writer: JournalWriter;
  ulid: () => string;
  now?: () => Date;
  reducer?: Reducer;
}): string[] {
  cleanupOrphanInboxTempFiles(deps.workspaceRoot);

  const healed: string[] = [];
  for (const id of listInboxEntryIds(deps.workspaceRoot)) {
    if (deps.state.entries[id]) continue; // already has an entry_created on record

    const event: JournalEvent = {
      v: 1,
      event_id: deps.ulid(),
      at: (deps.now?.() ?? new Date()).toISOString(),
      entry: id,
      event: "entry_created",
      by: "daemon",
      detail: { synthesized: true, reason: "inbox_self_heal" },
    };
    appendEvent(deps.writer, event);
    applyEvent(deps.state, event, deps.reducer);
    healed.push(id);
  }
  return healed;
}

// Step 4: apply-lease reconcile (A4 §F05/F04). `state.applyLease` already carries the one
// outstanding lease, if any (replay.ts's reducer derives it) — this never has to re-scan raw
// journal lines itself. A lease whose `expires_at` is still in the future is left alone (still
// legitimately active, e.g. a session that's mid-edit right now); only a genuinely dangling one
// gets closed out, and closing it out NEVER attributes it to a session — the interval just goes
// unrecorded as anything more than "unknown" (no checkpoint here either; step 5 immediately after
// this one is what captures whatever the worktree looks like now, as `unknown`).
export interface ApplyLeaseReconcileDeps {
  workspaceRoot: WorkspaceTarget;
  state: DerivedState;
  writer: JournalWriter;
  ulid: () => string;
  now?: () => Date;
  reducer?: Reducer;
}
export function reconcileApplyLeases(deps: ApplyLeaseReconcileDeps): string[] {
  const lease = deps.state.applyLease;
  if (!lease) return [];
  const now = deps.now?.() ?? new Date();
  if (new Date(lease.expiresAt).getTime() > now.getTime()) return []; // still active, not our concern

  const event: JournalEvent = {
    v: 1,
    event_id: deps.ulid(),
    at: now.toISOString(),
    entry: lease.entry,
    event: "apply_expired",
    by: "daemon",
    detail: { lease_id: lease.leaseId },
  };
  appendEvent(deps.writer, event);
  applyEvent(deps.state, event, deps.reducer);
  return [lease.leaseId];
}

// Step 5: offline catch-up (A4 §F04/F21). While the daemon was down, a human (or anything else)
// may have edited a tracked file directly — there's no lease to prove who, so any drift gets
// captured as a checkpoint attributed `unknown`, never guessed at. True no-op (no git touched at
// all) when there's nothing tracked AND no shadow repo yet — this is what keeps P2.1's
// fault-injection sweep (hundreds of reconcile() calls over a workspace with no artifact files)
// from paying for a git spawn on every iteration; the first real tracked file is what triggers
// `initShadowRepo`'s baseline, which already captures "whatever's on disk at first-ever-init" on
// its own, so this only needs to fire again for drift AFTER that baseline exists.
export interface OfflineCatchUpResult {
  occurred: boolean;
  preSha?: string;
  postSha?: string;
  /** Set instead of throwing when the shadow-git bootstrap itself fails (broken git toolchain,
   * permission issue, corrupted shadow repo, ...) — see `reconcileWorkspace`'s catch around this
   * step for why this must never take the rest of reconcile down with it. */
  error?: string;
}
export interface OfflineCatchUpDeps {
  workspaceRoot: WorkspaceTarget;
  state: DerivedState;
  writer: JournalWriter;
  ulid: () => string;
  now?: () => Date;
  reducer?: Reducer;
}
export async function offlineCatchUp(deps: OfflineCatchUpDeps): Promise<OfflineCatchUpResult> {
  // A lease still on record here means step 4 (which runs first, in the same reconcile pass)
  // looked at it and did NOT find it expired — i.e. it's legitimately active right now. That
  // interval belongs to the lease's own eventual `resolveEntry`, not to us: checkpointing it here
  // would durably commit the in-flight edit as `Glosa-Attribution: unknown` — and since
  // `checkpoint()` is idempotent (nothing left to stage once we've already committed it),
  // `resolveEntry`'s own later checkpoint would then find nothing new, return that SAME sha, and
  // the journal would say `session:<id>` for a commit whose trailer says `unknown`. Skip
  // entirely — no git spawned, nothing captured — and let the lease's own checkpoint at
  // `applyBegin` (pre-existing drift) / `resolveEntry` (the proven interval) be the only two
  // checkpoints that ever touch this window.
  if (deps.state.applyLease) return { occurred: false };

  const hasTrackedFiles = resolveTrackedFiles(deps.workspaceRoot).tracked.length > 0;
  const shadowExists = existsSync(shadowGitDir(deps.workspaceRoot));
  if (!hasTrackedFiles && !shadowExists) return { occurred: false };

  reclaimIndexLock(deps.workspaceRoot, { writer: deps.writer, ulid: deps.ulid, now: deps.now });
  await initShadowRepo(deps.workspaceRoot, { writer: deps.writer, ulid: deps.ulid, now: deps.now });

  const preSha = await headSha(deps.workspaceRoot);
  const postSha = await checkpoint(deps.workspaceRoot, { attribution: "unknown", kind: "auto_checkpoint" });
  if (postSha === preSha) return { occurred: false }; // baseline (just created, or already current) covers it

  const now = deps.now?.() ?? new Date();
  const event: JournalEvent = {
    v: 1,
    event_id: deps.ulid(),
    at: now.toISOString(),
    event: "offline_catchup",
    by: "daemon",
    detail: { pre_sha: preSha, post_sha: postSha },
  };
  appendEvent(deps.writer, event);
  applyEvent(deps.state, event, deps.reducer);
  return { occurred: true, preSha, postSha };
}

export interface ReconcileOptions {
  ulid?: () => string;
  now?: () => Date;
  reducer?: Reducer;
}

export interface ReconcileResult {
  workspaceRoot: string;
  tailTruncated: boolean;
  bytesRemoved: number;
  state: DerivedState;
  healedEntryIds: string[];
  quarantineCount: number;
  expiredLeaseIds: string[];
  offlineCatchup: OfflineCatchUpResult;
}

/** Runs the full ordered sequence (1 -> 2 -> 3 -> 4 -> 5) for one workspace. Opens its own
 * `JournalWriter` for the repair appends it may need to make and closes it before returning — a
 * long-lived writer for serving subsequent live appends is a separate concern (owned by whatever's
 * driving the daemon's request handling, not by reconcile itself). Async because steps 4-5 may
 * touch shadow-git (A4 §F21); both are true no-ops when there's nothing for them to do (no
 * dangling lease / no tracked files and no shadow repo yet), so a workspace that never uses either
 * feature pays no git-spawn cost here. */
export async function reconcileWorkspace(
  workspaceRoot: WorkspaceTarget,
  opts: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const jPath = journalPath(workspaceRoot);
  const qPath = quarantinePath(workspaceRoot);
  mkdirSync(workspaceBusDir(workspaceRoot), { recursive: true });

  const ulidFn = opts.ulid ?? defaultUlid;
  // P2.5: this is the real daemon-startup path (A4 §F04's ordered sequence), so the reducer it
  // validates crash-recovery against must be the production one — `lifecycleReducer`, not
  // replay.ts's placeholder minimal reducer — unless a caller explicitly overrides it (e.g. a
  // lower-level test proving fold/quarantine mechanics independent of any particular reducer).
  const reducer = opts.reducer ?? lifecycleReducer;
  const writer = new JournalWriter(jPath);
  try {
    const tail = truncateTornTail({ journalPath: jPath, quarantinePath: qPath, writer, ulid: ulidFn, now: opts.now });

    const { state, quarantineCount } = replayJournal({
      journalPath: jPath,
      quarantinePath: qPath,
      writer,
      ulid: ulidFn,
      now: opts.now,
      reducer,
    });

    // An adopted loose bus is historical evidence. Replay and torn-tail repair remain safe, but
    // self-healing, lease expiry, and offline Git catch-up would append fresh events and violate
    // the seal. The parent workspace is the only live writer from this point onward.
    if (state.adoptionSeal) {
      return {
        workspaceRoot: workspaceWorktree(workspaceRoot),
        tailTruncated: tail.truncated,
        bytesRemoved: tail.bytesRemoved,
        state,
        healedEntryIds: [],
        quarantineCount,
        expiredLeaseIds: [],
        offlineCatchup: { occurred: false },
      };
    }

    const healedEntryIds = selfHealInbox({
      workspaceRoot: workspaceWorktree(workspaceRoot),
      state,
      writer,
      ulid: ulidFn,
      now: opts.now,
      reducer,
    });

    const expiredLeaseIds = reconcileApplyLeases({
      workspaceRoot: workspaceWorktree(workspaceRoot),
      state,
      writer,
      ulid: ulidFn,
      now: opts.now,
      reducer,
    });
    // Step 5 is best-effort drift *provenance* capture (attributed "unknown"), not a dependency of
    // the journal-backed inbox/delivery machinery the rest of the bus serves — a broken git
    // toolchain, permission issue, or corrupted shadow repo here must never take the whole
    // workspace down (glosa/#38: this used to propagate all the way up through resolveBus() and
    // fail every request against the workspace, including plain message delivery that never
    // touches git at all).
    let offlineCatchup: OfflineCatchUpResult;
    try {
      offlineCatchup = await offlineCatchUp({
        workspaceRoot,
        state,
        writer,
        ulid: ulidFn,
        now: opts.now,
        reducer,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[glosa] offline catch-up failed for ${workspaceRoot}: ${message}`);
      offlineCatchup = { occurred: false, error: message };
    }

    return {
      workspaceRoot: workspaceWorktree(workspaceRoot),
      tailTruncated: tail.truncated,
      bytesRemoved: tail.bytesRemoved,
      state,
      healedEntryIds,
      quarantineCount,
      expiredLeaseIds,
      offlineCatchup,
    };
  } finally {
    writer.close();
  }
}

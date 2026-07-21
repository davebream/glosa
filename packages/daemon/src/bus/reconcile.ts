// @glosa/daemon — startup reconciliation, the ordered sequence from A4 §F04:
//   1. torn-tail truncate   2. replay -> derived state   3. inbox<->journal self-heal
//   4. apply-lease reconcile (P2.3 stub)   5. offline catch-up (P2.3 stub)
// Steps 4-5 depend on shadow-git (F21, not built yet) — they're typed no-ops here, wired into
// the driver so P2.3 only has to fill in the two function bodies.
import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, truncateSync } from "node:fs";
import { appendEvent, JournalWriter, type JournalEvent } from "./journal.ts";
import { cleanupOrphanInboxTempFiles, listInboxEntryIds } from "./inbox.ts";
import { journalPath, quarantinePath, workspaceBusDir } from "./paths.ts";
import { quarantineRawBytes } from "./quarantine.ts";
import { applyEvent, replayJournal, type DerivedState, type Reducer } from "./replay.ts";
import { ulid as defaultUlid } from "./ulid.ts";

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
  workspaceRoot: string;
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

// P2.3: apply-lease reconcile (step 4). Scan the journal for an `apply_begin` with no matching
// `apply_end`; for any whose `expires_at` has passed, append `apply_expired` and diff
// `pre_sha`..worktree via shadow-git, attributing the interval `unknown`. Not implemented here —
// shadow-git (A4 §F21) doesn't exist yet. Typed so P2.3 only has to fill in the body.
export interface ApplyLeaseReconcileDeps {
  workspaceRoot: string;
  state: DerivedState;
}
export function reconcileApplyLeases(_deps: ApplyLeaseReconcileDeps): void {
  // P2.3: implement once shadow-git lands.
}

// P2.3: offline catch-up (step 5). Diff shadow-git HEAD against the current worktree; any drift
// not covered by a proven apply-lease interval becomes an `auto_checkpoint` attributed `unknown`
// plus an `offline_catchup` event. Not implemented here — shadow-git (A4 §F21) doesn't exist yet.
export interface OfflineCatchUpDeps {
  workspaceRoot: string;
  state: DerivedState;
}
export function offlineCatchUp(_deps: OfflineCatchUpDeps): void {
  // P2.3: implement once shadow-git lands.
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
}

/** Runs the full ordered sequence (1 -> 2 -> 3, then no-op stubs 4 -> 5) for one workspace. Opens
 * its own `JournalWriter` for the repair appends it may need to make and closes it before
 * returning — a long-lived writer for serving subsequent live appends is a separate concern
 * (owned by whatever's driving the daemon's request handling, not by reconcile itself). */
export function reconcileWorkspace(workspaceRoot: string, opts: ReconcileOptions = {}): ReconcileResult {
  const jPath = journalPath(workspaceRoot);
  const qPath = quarantinePath(workspaceRoot);
  mkdirSync(workspaceBusDir(workspaceRoot), { recursive: true });

  const ulidFn = opts.ulid ?? defaultUlid;
  const writer = new JournalWriter(jPath);
  try {
    const tail = truncateTornTail({ journalPath: jPath, quarantinePath: qPath, writer, ulid: ulidFn, now: opts.now });

    const { state, quarantineCount } = replayJournal({
      journalPath: jPath,
      quarantinePath: qPath,
      writer,
      ulid: ulidFn,
      now: opts.now,
      reducer: opts.reducer,
    });

    const healedEntryIds = selfHealInbox({
      workspaceRoot,
      state,
      writer,
      ulid: ulidFn,
      now: opts.now,
      reducer: opts.reducer,
    });

    reconcileApplyLeases({ workspaceRoot, state });
    offlineCatchUp({ workspaceRoot, state });

    return {
      workspaceRoot,
      tailTruncated: tail.truncated,
      bytesRemoved: tail.bytesRemoved,
      state,
      healedEntryIds,
      quarantineCount,
    };
  } finally {
    writer.close();
  }
}

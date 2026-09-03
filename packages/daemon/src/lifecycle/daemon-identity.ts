// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — the process-wide answer to "am I the daemon that currently owns the singleton
// lock?". Set exactly once, by `lifecycle.ts`, at the moment `acquireLockOrExit` returns — i.e.
// the instant this process has won the O_EXCL CAS on `<GLOSA_HOME>/daemon.lock` (A5 §F13) — and
// cleared on shutdown.
//
// Why this is ambient rather than a parameter threaded through every caller: "which daemon am I"
// is a PROCESS fact, not a per-workspace or per-call one. The only consumer today is
// `git/shadow.ts#reclaimIndexLock`, which A4 §F21 allows to unlink a stray `index.lock` only when
// the singleton lock proves this process is the sole git operator. Threading the id from
// `bootDaemon` down through `WorkspaceBusRegistry` -> `WorkspaceBus` -> `reconcileWorkspace` ->
// `offlineCatchUp` would put the same process-global fact in a half-dozen optional dependency
// slots, each of which could silently omit it — and since an unprovable identity must FAIL CLOSED,
// a single forgotten slot is a latent daemon outage that only shows up the day a stale
// `index.lock` actually exists. One claim site is one thing to get right.
//
// This is NOT a security boundary. Anything already running inside the daemon process could call
// `unlinkSync` directly; the value here is that code which is NOT the daemon (a second daemon that
// lost the CAS and kept going, a CLI/diagnostic path, a test harness pointed at a live workspace)
// has no identity to claim and therefore cannot delete a lock a live `git` owns.

/** Who we are plus WHERE the lock proving it lives. The path is captured at claim time rather than
 * re-derived from `glosaHome()` on each use, so a later mutation of `GLOSA_HOME` in this process
 * can never redirect the proof at a different home than the one we actually locked. */
export interface DaemonIdentity {
  instanceId: string;
  lockFile: string;
}

let claimed: DaemonIdentity | null = null;

/** Called by `lifecycle.ts` immediately after this process wins the daemon-lock CAS. */
export function claimDaemonIdentity(identity: DaemonIdentity): void {
  claimed = identity;
}

/** Called on shutdown, after the lock file itself is released. Idempotent. */
export function releaseDaemonIdentity(): void {
  claimed = null;
}

/** `null` in any process that has not won the daemon-lock CAS — CLI, hooks, tests, and a second
 * daemon that lost the race. Callers must treat `null` as "ownership unprovable", never as
 * "ownership assumed". */
export function currentDaemonIdentity(): DaemonIdentity | null {
  return claimed;
}

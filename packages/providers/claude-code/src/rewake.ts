// @glosa/providers-claude-code — A2 §F07's asyncRewake rearm protocol. The asyncRewake hook
// (`glosa hook rewake-watch`, launched by Claude Code's SessionStart hook config) is ONE-SHOT: it
// exits the first time it signals a rewake (exit code 2), and Claude Code never re-spawns it for
// the rest of the session. Everything in this file exists to answer one question safely across
// however many times it gets asked: "is a watcher currently armed for this session, and if not,
// start one" — without ever ending up with two watchers alive for the same session at once.
//
// Two pieces, deliberately separate:
//   - RewakeLeaseStore: the actual duplicate-watcher guard (A2 §F07's per-session lease file,
//     `openSync(path, 'wx')` exclusive create, stale-after-30s reclaim). This is the ONLY thing
//     that gets to say "a watcher is active" — anything layered on top just asks it.
//   - RewakeCoordinator: the hook-facing API (`onSessionStart`/`onStop`/`onSessionEnd`) that
//     `glosa hook <event>` handlers call. It never spawns a second watcher for an already-armed
//     session, because it always defers the actual "is one armed" answer to the lease store.
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

export interface WatcherLease {
  pid: number;
  started: string; // ISO-8601
}

export interface RewakeLeaseStoreDeps {
  /** The directory per-session lease files live under — A2 §F07 literally names
   * `~/.glosa/.sessions/<id>.watcher.lock`, i.e. `join(glosaHome(), ".sessions")`; callers pass
   * that in explicitly (never hardcoded here) so tests use a tmp dir and never touch a real home. */
  dir: string;
  now?: () => Date;
  /** F07: "stale PIDs reclaimed after 30s staleness". */
  staleMs?: number;
}

const DEFAULT_STALE_MS = 30_000;

/** The A2 §F07 per-session watcher lease. `tryAcquire` is the entire duplicate-watcher guard: an
 * `openSync(path, 'wx')` exclusive create either wins outright or fails `EEXIST`, and only a
 * lease whose `started` is older than `staleMs` gets reclaimed (unlinked, then retried once) —
 * anything fresher means a real, currently-active watcher, so the caller is told `acquired: false`
 * rather than clobbering it. */
export class RewakeLeaseStore {
  private readonly dir: string;
  private readonly now: () => Date;
  private readonly staleMs: number;

  constructor(deps: RewakeLeaseStoreDeps) {
    this.dir = deps.dir;
    this.now = deps.now ?? (() => new Date());
    this.staleMs = deps.staleMs ?? DEFAULT_STALE_MS;
    mkdirSync(this.dir, { recursive: true });
  }

  private pathFor(sessionId: string): string {
    return join(this.dir, `${sessionId}.watcher.lock`);
  }

  private writeExclusive(path: string, lease: WatcherLease): boolean {
    let fd: number;
    try {
      fd = openSync(path, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err;
    }
    try {
      writeSync(fd, JSON.stringify(lease));
    } finally {
      closeSync(fd);
    }
    return true;
  }

  /** Wins the lease for `sessionId` (recording `pid`) or reports the lease already held by
   * someone else. A stale existing lease is reclaimed (unlink + one retry) — if that retry also
   * loses (someone else reclaimed it first, or a genuinely fresh lease raced in), this reports
   * `acquired: false` against whatever is on disk NOW rather than looping. */
  tryAcquire(sessionId: string, pid: number): { acquired: boolean; lease: WatcherLease } {
    const path = this.pathFor(sessionId);
    const lease: WatcherLease = { pid, started: this.now().toISOString() };

    if (this.writeExclusive(path, lease)) return { acquired: true, lease };

    const existing = this.read(sessionId);
    if (existing && this.now().getTime() - new Date(existing.started).getTime() > this.staleMs) {
      this.release(sessionId);
      if (this.writeExclusive(path, lease)) return { acquired: true, lease };
    }
    return { acquired: false, lease: this.read(sessionId) ?? lease };
  }

  read(sessionId: string): WatcherLease | null {
    try {
      return JSON.parse(readFileSync(this.pathFor(sessionId), "utf8")) as WatcherLease;
    } catch {
      return null;
    }
  }

  /** Overwrites an ALREADY-OWNED lease's `pid` — the second half of the claim-then-spawn-then-
   * record sequence `RewakeCoordinator.armIfNeeded` uses (P4.3 concurrency review fix #5): the
   * caller wins the lease with a PLACEHOLDER pid (its own — the hook process, not the eventual
   * watcher) BEFORE spawning anything, so the exclusivity check (`tryAcquire`'s `wx` create) has
   * already run by the time any process would spawn a watcher; this just fills in the real
   * watcher pid afterward, once it exists. Refuses (`false`) if the lease no longer names
   * `expectedPid` — a stale-reclaim race stole it out from under this caller in the (sub-
   * millisecond) window between the claim and this call — so it can never clobber a DIFFERENT
   * owner's lease. */
  updatePid(sessionId: string, expectedPid: number, newPid: number): boolean {
    const existing = this.read(sessionId);
    if (!existing || existing.pid !== expectedPid) return false;
    const lease: WatcherLease = { pid: newPid, started: existing.started };
    const fd = openSync(this.pathFor(sessionId), "w"); // NOT "wx" — this is an authorized overwrite, not a fresh claim
    try {
      writeSync(fd, JSON.stringify(lease));
    } finally {
      closeSync(fd);
    }
    return true;
  }

  /** The watcher's own shutdown path calls this with its own pid right before it exits (whether
   * via rewake exit(2) or a plain exit(0)) — releasing promptly is what lets the VERY NEXT
   * `onStop` rearm immediately instead of waiting out `staleMs`. Only releases a lease that still
   * names `pid` — a watcher that already lost a reclaim race (its lease was stolen out from under
   * it by a fresher one) must not release the NEW owner's lease on its way out. */
  release(sessionId: string, pid?: number): void {
    if (pid !== undefined) {
      const existing = this.read(sessionId);
      if (existing && existing.pid !== pid) return;
    }
    try {
      unlinkSync(this.pathFor(sessionId));
    } catch {
      // already gone — fine
    }
  }

  isActive(sessionId: string): boolean {
    const lease = this.read(sessionId);
    if (!lease) return false;
    return this.now().getTime() - new Date(lease.started).getTime() <= this.staleMs;
  }
}

export interface RewakeCoordinatorDeps {
  leases: RewakeLeaseStore;
  /** Spawns a fresh watcher process for `sessionId` and returns its pid. Production: detached
   * `glosa hook rewake-watch --session <id>` (mirrors lifecycle.ts's `spawnAndWait` shape); tests
   * inject a fake incrementing-pid stub so rearm logic is provable with no real subprocess. */
  spawnWatcher: (sessionId: string) => number;
}

export interface RearmResult {
  /** `true` only if THIS call is the one that actually spawned a fresh watcher. */
  rearmed: boolean;
  /** The (possibly pre-existing) active watcher's pid. */
  pid: number;
}

/** The hook-facing API — `glosa hook session-start`/`stop`/`session-end` call these instead of
 * touching `RewakeLeaseStore` directly. Every entry point funnels through `armIfNeeded`, which
 * CLAIMS the lease before ever calling `spawnWatcher` (P4.3 concurrency review fix #5 — see
 * `armIfNeeded`'s own docstring for why this ordering, not an `isActive()` pre-check, is what
 * actually makes two racing callers safe). */
export class RewakeCoordinator {
  constructor(private readonly deps: RewakeCoordinatorDeps) {}

  /** A2 §F07 step 1: SessionStart arms a watcher if one isn't already active. */
  onSessionStart(sessionId: string): RearmResult {
    return this.armIfNeeded(sessionId);
  }

  /** The Stop hook's rearm (A2 §F07: "rearmed by the Stop hook via a per-session lease"). The
   * asyncRewake watcher is one-shot, so by the time any given Stop fires it has very likely
   * already exited (releasing its own lease on the way out, via `RewakeLeaseStore.release`) —
   * this re-arms it. Safe to call on every single Stop: a session with an already-active watcher
   * is a no-op. */
  onStop(sessionId: string): RearmResult {
    return this.armIfNeeded(sessionId);
  }

  /** SessionEnd releases the lease outright, so a stale file never lingers under
   * `~/.glosa/.sessions/` past the session it belonged to. */
  onSessionEnd(sessionId: string): void {
    this.deps.leases.release(sessionId);
  }

  /** P4.3 concurrency review fix #5 — the original version checked `isActive()`, THEN spawned a
   * watcher, THEN tried to claim the lease: with each `glosa hook <event>` invocation a SEPARATE
   * OS process constructing its own fresh `RewakeCoordinator`/`RewakeLeaseStore` racing on the
   * SAME on-disk lease file, two processes could both observe "not active" (a wide window —
   * `handleStop` awaits two daemon HTTP round-trips before ever reaching this call), both spawn a
   * watcher, and only ONE would win the lease — leaving the loser's watcher process alive,
   * unowned, and free to independently signal Claude. Exactly what F07's exclusivity exists to
   * prevent.
   *
   * The fix: claim FIRST, spawn only after winning. `tryAcquire`'s `openSync(path, 'wx')` is the
   * actual atomic exclusivity primitive (true even across real separate processes, unlike an
   * `isActive()` read followed by a LATER `tryAcquire`) — so this claims the lease with a
   * PLACEHOLDER pid (this hook process's own `process.pid`, not the eventual watcher's) BEFORE
   * `spawnWatcher` is ever called. A caller that loses the claim returns `rearmed: false`
   * immediately, without spawning anything. Only the winner spawns, then records the real watcher
   * pid via `updatePid` (best-effort — see that method's own docstring for the narrow race it
   * still tolerates without misattributing ownership). */
  private armIfNeeded(sessionId: string): RearmResult {
    const claimPid = process.pid;
    const claim = this.deps.leases.tryAcquire(sessionId, claimPid);
    if (!claim.acquired) {
      return { rearmed: false, pid: claim.lease.pid };
    }
    const watcherPid = this.deps.spawnWatcher(sessionId);
    this.deps.leases.updatePid(sessionId, claimPid, watcherPid);
    return { rearmed: true, pid: watcherPid };
  }
}

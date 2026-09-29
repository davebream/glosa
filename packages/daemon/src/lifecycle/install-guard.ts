// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — what a running daemon does when its install changes under it (#432).
//
// Contract: docs/design/2026-09-29-install-lifetime-and-restart.md, rules R-L2..R-L5. An installed
// daemon (never a source checkout, R-L10) snapshots the identity of its tree before it binds,
// refuses to boot from a tree that changed while it was loading, refuses anything that would start
// new code from a changed tree, and then retires through its own graceful drain. It never signals
// another process and nothing here reaches the network.
import { type BigIntStats, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/** The exit code of a daemon that refused to boot because its tree changed while it loaded (R-L2).
 *  Clients map it to a retry message rather than a generic spawn failure. */
export const INSTALL_CHANGED_EXIT = 5;

/** How a file or directory looked when the snapshot was taken. Nanosecond times from a bigint
 *  `lstat`: a package manager's replace-and-rename, an unlink and re-create, and a re-create with
 *  its old mtime restored all move at least `ino` or `ctime`, and userspace cannot set `ctime`. */
export interface Identity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

export interface InstallSnapshot {
  root: string;
  /** Absolute path to identity: the root, every directory under it (symlinks recorded, never
   *  followed), the curated files and the runtime binary. */
  entries: ReadonlyMap<string, Identity>;
}

export type InstallChange = { ok: false; path: string; why: "missing" | "identity" | "after-start" };
export type InstallVerdict = { ok: true } | InstallChange;

export type Lstat = (path: string) => BigIntStats;
const realLstat: Lstat = (path) => lstatSync(path, { bigint: true });

function identityOf(stat: BigIntStats): Identity {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs };
}

function sameIdentity(a: Identity, b: Identity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

export interface SnapshotOptions {
  root: string;
  /** Files read or started after boot whose in-place rewrite a directory would not reveal. A file
   *  absent at boot is simply not guarded. */
  files: readonly string[];
  /** The runtime this daemon runs on; `bin/bun` in a packaged install. */
  execPath: string;
  lstat?: Lstat;
  readdir?: (path: string) => { name: string; isDirectory(): boolean; isSymbolicLink(): boolean }[];
}

/** Records the tree as it is now. Every directory is included because replacing any file in it,
 *  by rename or by unlink and create, changes the directory itself. */
export function captureInstallSnapshot(options: SnapshotOptions): InstallSnapshot {
  const lstat = options.lstat ?? realLstat;
  const readdir = options.readdir ?? ((path: string) => readdirSync(path, { withFileTypes: true }));
  const entries = new Map<string, Identity>();
  const visit = (dir: string): void => {
    let stat: BigIntStats;
    try {
      stat = lstat(dir);
    } catch {
      return;
    }
    entries.set(dir, identityOf(stat));
    if (!stat.isDirectory()) return;
    let children: ReturnType<NonNullable<SnapshotOptions["readdir"]>>;
    try {
      children = readdir(dir);
    } catch {
      return;
    }
    for (const child of children) {
      const path = join(dir, child.name);
      if (child.isDirectory()) visit(path);
      else if (child.isSymbolicLink()) {
        try {
          entries.set(path, identityOf(lstat(path)));
        } catch {
          // vanished between readdir and lstat: the next verify reports it
        }
      }
    }
  };
  visit(options.root);
  for (const file of [...options.files, options.execPath]) {
    try {
      entries.set(file, identityOf(lstat(file)));
    } catch {
      // absent at boot: not guarded
    }
  }
  return { root: options.root, entries };
}

/** R-L2: a tree any of whose entries changed at or after `startNs - marginNs` changed while this
 *  process was loading its code, so the code in memory may be a mix of two installs. */
export function bootVerdict(snapshot: InstallSnapshot, startNs: bigint, marginNs: bigint): InstallVerdict {
  const cutoff = startNs - marginNs;
  for (const [path, identity] of snapshot.entries) {
    if (identity.ctimeNs >= cutoff) return { ok: false, path, why: "after-start" };
  }
  return { ok: true };
}

/** R-L3: the first entry that is gone or no longer the same file, or ok. */
export function verifySnapshot(snapshot: InstallSnapshot, lstat: Lstat = realLstat): InstallVerdict {
  for (const [path, identity] of snapshot.entries) {
    let now: Identity;
    try {
      now = identityOf(lstat(path));
    } catch {
      return { ok: false, path, why: "missing" };
    }
    if (!sameIdentity(identity, now)) return { ok: false, path, why: "identity" };
  }
  return { ok: true };
}

/** The current identities of every snapshot entry, as one string: two equal fingerprints a sweep
 *  apart mean the package manager has stopped writing. */
export function currentFingerprint(snapshot: InstallSnapshot, lstat: Lstat = realLstat): string {
  const parts: string[] = [];
  for (const path of snapshot.entries.keys()) {
    try {
      const s = lstat(path);
      parts.push(`${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`);
    } catch {
      parts.push("-");
    }
  }
  return parts.join("|");
}

/** A Linux process's start in nanoseconds since the epoch: when the system booted, plus the
 *  kernel's start time for the process (`/proc/<pid>/stat` field 22, in USER_HZ ticks, which is 100
 *  on every Linux ABI glosa supports). The boot is `nowNs` minus `/proc/uptime`, both to 10 ms.
 *  Not `/proc/stat`'s btime: that is whole seconds, which put the start up to a second early, so a
 *  tree copied just before the daemon started counted as changed while it loaded. Null when either
 *  file does not parse. */
export function linuxProcessStartNs(selfStat: string, uptime: string, nowNs: bigint): bigint | null {
  const ticks = selfStat.slice(selfStat.lastIndexOf(")") + 2).split(" ")[19];
  const up = /^(\d+)\.(\d{1,9})\s/.exec(uptime);
  if (ticks === undefined || !/^\d+$/.test(ticks) || !up) return null;
  const uptimeNs = BigInt(up[1] as string) * 1_000_000_000n + BigInt((up[2] as string).padEnd(9, "0"));
  return nowNs - uptimeNs + BigInt(ticks) * 10_000_000n;
}

/** When this process started, in nanoseconds since the epoch. On Linux the kernel's own record
 *  (`linuxProcessStartNs`); elsewhere `performance.timeOrigin`, which trails the exec by Bun's own
 *  startup, hence the larger margin there (`bootMarginNs`). */
export function processStartNs(platform: NodeJS.Platform = process.platform): bigint {
  if (platform === "linux") {
    try {
      const selfStat = readFileSync("/proc/self/stat", "utf8");
      const uptime = readFileSync("/proc/uptime", "utf8");
      const start = linuxProcessStartNs(selfStat, uptime, BigInt(Date.now()) * 1_000_000n);
      if (start !== null) return start;
    } catch {
      // fall through to timeOrigin
    }
  }
  return BigInt(Math.floor(performance.timeOrigin * 1_000_000));
}

/** The boot margin (review answer 1): 100 ms on Linux, measured from the kernel's start time;
 *  500 ms elsewhere. `GLOSA_INSTALL_BOOT_MARGIN_MS` overrides it for tests. */
export function bootMarginNs(platform: NodeJS.Platform = process.platform, env = Bun.env): bigint {
  const override = env.GLOSA_INSTALL_BOOT_MARGIN_MS;
  if (override !== undefined && /^\d+$/.test(override)) return BigInt(override) * 1_000_000n;
  return platform === "linux" ? 100_000_000n : 500_000_000n;
}

/** The sweep interval: 2 s, or `GLOSA_INSTALL_SWEEP_MS` for tests. */
export function sweepIntervalMs(env = Bun.env): number {
  const override = env.GLOSA_INSTALL_SWEEP_MS;
  return override !== undefined && /^\d+$/.test(override) && Number(override) > 0 ? Number(override) : 2000;
}

/** Thrown by a guarded operation once the install has changed. `code` lets a route answer 503. */
export class InstallChangedError extends Error {
  readonly code = "install-changed";
  constructor(
    readonly op: string,
    readonly change: InstallChange,
  ) {
    super(`glosa was updated or removed while running (${change.why}: ${change.path}); ${op} was refused`);
    this.name = "InstallChangedError";
  }
}

export interface InstallGuardOptions {
  snapshot: InstallSnapshot;
  /** True when retiring now would interrupt nothing: no managed chat is running. */
  canRetire: () => boolean;
  /** Runs the daemon's own graceful shutdown, once. */
  retire: (change: InstallChange) => void;
  log: (line: string) => void;
  verify?: (snapshot: InstallSnapshot) => InstallVerdict;
  fingerprint?: (snapshot: InstallSnapshot) => string;
  rootExists?: (root: string) => boolean;
  now?: () => number;
  sweepMs?: number;
  /** The longest a fenced daemon waits for the package manager to stop writing (R-L4). */
  settleMaxMs?: number;
}

/**
 * R-L3/R-L4 as a three-state machine: pinned (the tree is the one this daemon booted from), fenced
 * (it is not; nothing new starts from it, and the daemon waits for the writes to settle and for
 * managed chats to finish), retiring (the graceful shutdown has been asked for). Fencing is one-way.
 */
export class InstallGuard {
  #state: "pinned" | "fenced" | "retiring" = "pinned";
  #change: InstallChange | null = null;
  #fencedAt = 0;
  #lastPrint: string | null = null;
  #waitingLogged = false;
  #timer: ReturnType<typeof setInterval> | null = null;
  readonly #o: Required<Omit<InstallGuardOptions, "snapshot" | "canRetire" | "retire" | "log">> &
    Pick<InstallGuardOptions, "snapshot" | "canRetire" | "retire" | "log">;

  constructor(options: InstallGuardOptions) {
    this.#o = {
      verify: (snapshot) => verifySnapshot(snapshot),
      fingerprint: (snapshot) => currentFingerprint(snapshot),
      rootExists: (root) => {
        try {
          lstatSync(root);
          return true;
        } catch {
          return false;
        }
      },
      now: () => Date.now(),
      sweepMs: 2000,
      settleMaxMs: 30_000,
      // An option passed as `undefined` keeps its default rather than erasing it.
      ...(Object.fromEntries(
        Object.entries(options).filter(([, value]) => value !== undefined),
      ) as InstallGuardOptions),
    };
  }

  /** True once the install has been seen to change. Reported in the handshake as `install_changed`. */
  get fenced(): boolean {
    return this.#state !== "pinned";
  }

  get state(): "pinned" | "fenced" | "retiring" {
    return this.#state;
  }

  /** The change that fenced this daemon, for doctor and the log. */
  get change(): InstallChange | null {
    return this.#change;
  }

  /** Call before anything that reads or starts code from the tree after boot. Throws
   *  `InstallChangedError` when the tree changed, and fences the daemon if it was not already. */
  assertUnchanged(op: string): void {
    if (this.#state === "pinned") {
      const verdict = this.#o.verify(this.#o.snapshot);
      if (verdict.ok) return;
      this.#fence(verdict);
    }
    throw new InstallChangedError(op, this.#change as InstallChange);
  }

  /** One sweep: detect a change, then wait for it to settle and for the daemon to be idle. */
  sweep(): void {
    if (this.#state === "retiring") return;
    if (this.#state === "pinned") {
      const verdict = this.#o.verify(this.#o.snapshot);
      if (!verdict.ok) this.#fence(verdict);
      return;
    }
    const print = this.#o.fingerprint(this.#o.snapshot);
    const settled =
      !this.#o.rootExists(this.#o.snapshot.root) ||
      print === this.#lastPrint ||
      this.#o.now() - this.#fencedAt >= this.#o.settleMaxMs;
    this.#lastPrint = print;
    if (!settled) return;
    if (!this.#o.canRetire()) {
      if (!this.#waitingLogged) {
        this.#waitingLogged = true;
        this.#o.log("install changed; waiting for managed chats to finish before restarting");
      }
      return;
    }
    this.#state = "retiring";
    this.#o.retire(this.#change as InstallChange);
  }

  start(): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => this.sweep(), this.#o.sweepMs);
    (this.#timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  #fence(change: InstallChange): void {
    this.#state = "fenced";
    this.#change = change;
    this.#fencedAt = this.#o.now();
    this.#lastPrint = this.#o.fingerprint(this.#o.snapshot);
    const rel = relative(this.#o.snapshot.root, change.path) || ".";
    this.#o.log(`install changed (${change.why} ${rel}); nothing new starts from it`);
  }
}

// ---------------------------------------------------------------------------------------------
// The one guard of this process. A daemon has exactly one install, so the spawn sites (matcher
// and hardlink workers, the managed-chat guardian, the runtime lockfile) ask it directly rather
// than having it threaded through every constructor. Unset (a source checkout, a unit test) means
// unguarded, which is R-L10.

let activeGuard: InstallGuard | null = null;

export function activateInstallGuard(guard: InstallGuard | null): void {
  activeGuard = guard;
}

/** Throws `InstallChangedError` when this process's install changed (R-L3); a no-op when unguarded. */
export function assertInstallUnchanged(op: string): void {
  activeGuard?.assertUnchanged(op);
}

/** Whether this process's install has been seen to change. */
export function installChanged(): boolean {
  return activeGuard?.fenced === true;
}

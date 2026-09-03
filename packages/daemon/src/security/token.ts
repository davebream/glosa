// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — pairing token lifecycle + constant-time Bearer compare (A1 §2, A3 §3-4).
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";

export function tokenPath(home: string): string {
  return join(home, "token");
}

export interface TokenSource {
  current(): string | null;
  generationSignal(): AbortSignal;
  snapshot(): { token: string | null; signal: AbortSignal };
}

export interface TokenMutationDeps {
  rename: typeof renameSync;
  unlink: typeof unlinkSync;
}

const REAL_TOKEN_MUTATION_DEPS: TokenMutationDeps = { rename: renameSync, unlink: unlinkSync };

/** Mints a fresh 128-bit token (32 hex chars) and writes it to `<home>/token`, atomically: a
 * temp file in the same dir → fsync → rename over the destination (A3 §3 "atomic temp+rename
 * 0600") so a reader can never observe a partial file. Permissions are finalized on the temp
 * inode before rename, leaving no fallible operation after the commit point. Unconditional —
 * callers that want "mint only if absent" use `ensureToken`. */
export function mintToken(home: string, deps: TokenMutationDeps = REAL_TOKEN_MUTATION_DEPS): string {
  const token = randomBytes(16).toString("hex"); // 128-bit
  const dest = tokenPath(home);
  const tmp = `${dest}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  // `open`'s CLI-side ensureToken() call runs BEFORE the daemon's own boot (which is what
  // normally creates `home` via ensureHomeDir) — on a genuinely fresh GLOSA_HOME (first-ever
  // `glosa open`), nothing else has created this directory yet.
  mkdirSync(home, { recursive: true });
  let fd: number | null = null;
  let committed = false;
  try {
    writeFileSync(tmp, token, { mode: 0o600, flag: "wx" });
    // Set the final mode before the atomic commit. There are deliberately no fallible operations
    // after rename: a reported failure must leave the previously usable credential in place.
    chmodSync(tmp, 0o600);
    fd = openSync(tmp, "r+");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    deps.rename(tmp, dest);
    committed = true;
  } finally {
    if (fd !== null) closeSync(fd);
    if (!committed) {
      try {
        deps.unlink(tmp);
      } catch {
        // The destination was never changed. A best-effort cleanup failure must not hide the
        // original write/fsync/rename error.
      }
    }
  }
  return token;
}

/** Explicit rotation. Kept separate from `ensureToken` so routine startup never invalidates a
 * credential. The returned material is for internal callers only; the CLI discards it. */
export function rotateToken(home: string, deps: TokenMutationDeps = REAL_TOKEN_MUTATION_DEPS): string {
  return mintToken(home, deps);
}

/** Removes the only ambient API credential. `unlink` is the commit point, so a failed revoke
 * leaves the old credential usable and the caller can truthfully report rollback. */
export function revokeToken(home: string, deps: TokenMutationDeps = REAL_TOKEN_MUTATION_DEPS): boolean {
  const path = tokenPath(home);
  if (!existsSync(path)) return false;
  try {
    deps.unlink(path);
    return true;
  } catch (error) {
    // Two concurrent revocations linearize at unlink; the loser is the same idempotent success as
    // observing an already-absent file before calling unlink.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Idempotent pairing-token bootstrap: returns the existing `<home>/token` if one is already on
 * disk, else mints one via `mintToken`. Never overwrites an existing token — rotation is a
 * separate, explicit operation (P5.1/A3 §3), not something a routine boot can trigger. */
export function ensureToken(home: string): string {
  const existing = loadToken(home);
  if (existing !== null) return existing;
  return mintToken(home);
}

/** Reads `<home>/token` (0600, written by P1.4) into memory. `null` — never a throw — when the
 * file is absent or unreadable, so callers can treat "no token yet" as `paired: false`. */
export function loadToken(home: string): string | null {
  const path = tokenPath(home);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

/** Constant-time Bearer comparison. A length mismatch still runs a same-cost dummy compare
 * before returning false, so a byte-by-byte or length oracle never leaks token length. */
export function tokenMatches(candidate: string | null, expected: string | null): boolean {
  if (candidate === null || expected === null) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

/** Live view of the token file shared by both daemon listeners. Every request refreshes
 * synchronously, while the directory watcher proactively aborts long-lived streams and clears
 * class-F capabilities through subscribers. Atomic rename/unlink means readers see either the
 * old complete credential or the new complete state, never partial bytes. */
export class TokenAuthority implements TokenSource {
  private value: string | null;
  private controller = new AbortController();
  private readonly listeners = new Set<() => void>();
  private watcher: FSWatcher | null = null;
  private permissionWarning: string | null = null;

  constructor(
    private readonly home: string,
    private readonly warn: (message: string) => void = () => {},
  ) {
    mkdirSync(home, { recursive: true });
    this.value = loadToken(home);
    this.checkPermissions();
    try {
      this.watcher = watch(home, (_event, filename) => {
        if (filename === null || filename.toString() === "token") this.refresh();
      });
      this.watcher.on("error", () => this.warn("token watcher unavailable; request-time refresh remains active"));
    } catch {
      this.warn("token watcher unavailable; request-time refresh remains active");
    }
  }

  current(): string | null {
    this.refresh();
    return this.value;
  }

  generationSignal(): AbortSignal {
    this.refresh();
    return this.controller.signal;
  }

  snapshot(): { token: string | null; signal: AbortSignal } {
    this.refresh();
    return { token: this.value, signal: this.controller.signal };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  refresh(): boolean {
    const next = loadToken(this.home);
    this.checkPermissions();
    if (next === this.value) return false;
    this.value = next;
    const previous = this.controller;
    this.controller = new AbortController();
    previous.abort();
    for (const listener of this.listeners) listener();
    return true;
  }

  close(): void {
    this.watcher?.close();
    this.watcher = null;
    this.controller.abort();
    this.listeners.clear();
  }

  private checkPermissions(): void {
    const path = tokenPath(this.home);
    let warning: string | null = null;
    try {
      const mode = statSync(path).mode & 0o777;
      if (mode !== 0o600) warning = `token file permissions are ${mode.toString(8)}; expected 0600`;
    } catch {
      // Missing/unreadable is represented by current() === null, not a permission warning.
    }
    if (warning !== null && warning !== this.permissionWarning) this.warn(warning);
    this.permissionWarning = warning;
  }
}

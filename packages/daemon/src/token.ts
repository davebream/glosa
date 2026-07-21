// @glosa/daemon — pairing token load/mint + constant-time Bearer compare (A1 §2, A3 §3-4).
// Rotation and revocation are P5.1's job; this module mints once and otherwise only ever reads
// what's already on disk.
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";

export function tokenPath(home: string): string {
  return join(home, "token");
}

/** Mints a fresh 128-bit token (32 hex chars) and writes it to `<home>/token`, atomically: a
 * temp file in the same dir → fsync → rename over the destination (A3 §3 "atomic temp+rename
 * 0600") so a reader can never observe a partial file. Perms are set on the temp file AND
 * re-asserted with an explicit chmod after the rename, since a rename can inherit the
 * destination's prior mode on some filesystems. Unconditional — callers that want
 * "mint only if absent" use `ensureToken`. */
export function mintToken(home: string): string {
  const token = randomBytes(16).toString("hex"); // 128-bit
  const dest = tokenPath(home);
  const tmp = `${dest}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  // `open`'s CLI-side ensureToken() call runs BEFORE the daemon's own boot (which is what
  // normally creates `home` via ensureHomeDir) — on a genuinely fresh GLOSA_HOME (first-ever
  // `glosa open`), nothing else has created this directory yet.
  mkdirSync(home, { recursive: true });
  writeFileSync(tmp, token, { mode: 0o600 });
  const fd = openSync(tmp, "r+");
  fsyncSync(fd);
  closeSync(fd);
  renameSync(tmp, dest);
  chmodSync(dest, 0o600);
  return token;
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

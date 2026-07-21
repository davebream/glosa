// @glosa/daemon — pairing token load + constant-time Bearer compare (A1 §2, A3 §4). Minting,
// rotation, and revocation are P1.4's job; this module only ever reads what's already on disk.
import { existsSync, readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";

export function tokenPath(home: string): string {
  return join(home, "token");
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

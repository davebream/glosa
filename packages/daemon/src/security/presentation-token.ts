// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — short-TTL single-use presentation tokens (A3). Distinct from the durable
// pairing token (`~/.glosa/token`) and from class-F capabilities (multi-request, path-scoped).
// A presentation URL carries `p=<ephemeral>` so an MCP transcript/log leak is time-bounded;
// redemption exchanges it once for the current durable pairing token over a same-origin call.
import { randomBytes } from "node:crypto";

/** A3: presentation tokens expire after 60 seconds. */
export const PRESENTATION_TOKEN_TTL_MS = 60_000;

function randomToken(): string {
  // 256-bit random, hex-encoded — same encoding as class-F capabilities so tokens drop cleanly
  // into URL fragments without encoding concerns.
  return randomBytes(32).toString("hex");
}

export class PresentationTokenStore {
  private readonly map = new Map<string, number>(); // token → expiresAt (epoch ms)

  /** Mints a fresh single-use presentation token. `now` is injectable for tests only. */
  mint(now: number = Date.now()): { token: string; expiresAt: number } {
    const token = randomToken();
    const expiresAt = now + PRESENTATION_TOKEN_TTL_MS;
    this.map.set(token, expiresAt);
    return { token, expiresAt };
  }

  /** Atomically redeems a presentation token. Returns true exactly once for a live token;
   * expired, unknown, and already-redeemed tokens all return false (callers must collapse those
   * into one 401 so an attacker cannot distinguish the failure mode). */
  redeem(token: string, now: number = Date.now()): boolean {
    const expiresAt = this.map.get(token);
    if (expiresAt === undefined) return false;
    this.map.delete(token);
    return now < expiresAt;
  }

  /** Token rotation/revocation invalidates every browser credential, including outstanding
   * presentation URLs. */
  clear(): void {
    this.map.clear();
  }

  /** Test/diagnostic only — not used by any production path. */
  size(): number {
    return this.map.size;
  }
}

// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — the class-F capability store (A1 §7, A3 §1/§3). One in-memory `Map`, exactly
// as the spec requires: NOT persisted (a daemon restart invalidates every outstanding capability
// — acceptable for a local single-user tool), directory-scoped and multi-request (not single-use:
// a class-F document loads sibling assets — its own CSS/JS/images — over the SAME token for the
// whole time the iframe is displayed, per A1 §7's explicit reconciliation of an earlier
// single-use draft). Every mint is a FRESH token+nonce pair — nothing here is ever reused across
// two different mint calls, even for the same artifact.
import { randomBytes } from "node:crypto";

/** A1 §7: "TTL 600s (10 min)". */
export const CAPABILITY_TTL_MS = 600_000;

export interface CapabilityRecord {
  slug: string;
  /** The artifact's containing directory, already realpath-resolved at mint time — this is the
   * confinement root every subsequent `/doc/:token/<path...>` request re-confines against (A1
   * §7: "each request re-confined — a sibling request can never escape the artifact's
   * directory"). */
  artifactDirRealPath: string;
  /** The document's own filename within that directory — `/doc/:token/<artifactBasename>` is the
   * document itself; any other sibling path under the same token is an asset request. */
  artifactBasename: string;
  /** A3 §2's per-load nonce: minted alongside the token, embedded in the bridge script at serve
   * time, and validated exactly once by the bridge on the `glosa:init` handshake message. */
  nonce: string;
  expiresAt: number; // epoch ms
}

function randomToken(): string {
  // 256-bit random, hex-encoded (A1 §7 / A3 §1: "256-bit"). Hex rather than base64url purely so
  // the token drops cleanly into a URL path segment with no encoding concerns.
  return randomBytes(32).toString("hex");
}

export class CapabilityStore {
  private readonly map = new Map<string, CapabilityRecord>();

  /** Mints a fresh token+nonce for one artifact directory. `now` is injectable for tests only —
   * production callers always take the default `Date.now()`. */
  mint(input: { slug: string; artifactDirRealPath: string; artifactBasename: string }, now: number = Date.now()): {
    token: string;
    nonce: string;
    expiresAt: number;
  } {
    const token = randomToken();
    const nonce = randomToken();
    const expiresAt = now + CAPABILITY_TTL_MS;
    this.map.set(token, { ...input, nonce, expiresAt });
    return { token, nonce, expiresAt };
  }

  /** `exists && now < expiresAt` (A1 §7) — anything else (unknown token, or expired) is `null`,
   * collapsing to the same `404` at the call site so an attacker can't distinguish "never
   * existed" from "expired" (A1 §7: "no daemon-origin details"). An expired lookup is dropped
   * from the map on the way out — opportunistic cleanup, not a correctness requirement (an
   * expired-but-still-present entry would already fail every future lookup here regardless). */
  lookup(token: string, now: number = Date.now()): CapabilityRecord | null {
    const record = this.map.get(token);
    if (!record) return null;
    if (now >= record.expiresAt) {
      this.map.delete(token);
      return null;
    }
    return record;
  }

  /** Test/diagnostic only — not used by any production path. */
  size(): number {
    return this.map.size;
  }
}

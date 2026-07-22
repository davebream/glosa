// SPDX-License-Identifier: Apache-2.0
// P1.4 — pairing token minting (A1 §2, A3 §3). loadToken/tokenMatches are P1.2/P1.3's coverage
// (auth.test.ts); this file covers the new mint/ensure primitives: format, perms, idempotency,
// and atomicity. Hermetic tmp GLOSA_HOME per test, never touches a real `~/.glosa`.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readdirSync, renameSync, rmSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  ensureToken,
  loadToken,
  mintToken,
  revokeToken,
  rotateToken,
  TokenAuthority,
  tokenPath,
} from "../src/token.ts";
import { cleanupHome, freshHome } from "./helpers.ts";

describe("mintToken", () => {
  test("writes a 32-hex-char (128-bit) token at mode 0600", () => {
    const home = freshHome();
    try {
      const token = mintToken(home);
      expect(token).toMatch(/^[0-9a-f]{32}$/);
      const stat = statSync(tokenPath(home));
      expect(stat.mode & 0o777).toBe(0o600);
      expect(loadToken(home)).toBe(token);
    } finally {
      cleanupHome(home);
    }
  });

  test("mints correctly when `home` itself doesn't exist yet (real first-ever `glosa open`)", () => {
    // The CLI's `open` command calls ensureToken/mintToken BEFORE the daemon's own boot ever runs
    // (so the token exists on disk before a first-spawn daemon reads it) — on a genuinely fresh
    // GLOSA_HOME, nothing else has created this directory yet. Every OTHER test in this file uses
    // freshHome(), which is mkdtempSync-backed and therefore always pre-creates the directory,
    // which is exactly why this gap was invisible until a real first-run reproduced it.
    const parent = freshHome();
    const home = join(parent, "not-yet-created", "glosa-home");
    try {
      expect(existsSync(home)).toBe(false);
      const token = mintToken(home);
      expect(token).toMatch(/^[0-9a-f]{32}$/);
      expect(loadToken(home)).toBe(token);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("no leftover temp file after a successful mint (atomic happy path)", () => {
    const home = freshHome();
    try {
      mintToken(home);
      const entries = readdirSync(home);
      expect(entries).toEqual(["token"]);
    } finally {
      cleanupHome(home);
    }
  });

  test("overwrites: two calls mint two different tokens (unconditional, unlike ensureToken)", () => {
    const home = freshHome();
    try {
      const first = mintToken(home);
      const second = mintToken(home);
      expect(second).not.toBe(first);
      expect(loadToken(home)).toBe(second);
    } finally {
      cleanupHome(home);
    }
  });
});

describe("ensureToken", () => {
  test("mints on first call, returns the same token on a second call (idempotent)", () => {
    const home = freshHome();
    try {
      const first = ensureToken(home);
      expect(first).toMatch(/^[0-9a-f]{32}$/);
      const second = ensureToken(home);
      expect(second).toBe(first);
      expect(loadToken(home)).toBe(first);
    } finally {
      cleanupHome(home);
    }
  });

  test("never overwrites a token that already exists on disk", () => {
    const home = freshHome();
    try {
      const preExisting = mintToken(home);
      const result = ensureToken(home);
      expect(result).toBe(preExisting);
    } finally {
      cleanupHome(home);
    }
  });
});

describe("rotateToken / revokeToken", () => {
  test("rotation atomically installs a fresh 128-bit mode-0600 credential", () => {
    const home = freshHome();
    try {
      const oldToken = ensureToken(home);
      const nextToken = rotateToken(home);
      expect(nextToken).toMatch(/^[0-9a-f]{32}$/);
      expect(nextToken).not.toBe(oldToken);
      expect(loadToken(home)).toBe(nextToken);
      expect(statSync(tokenPath(home)).mode & 0o777).toBe(0o600);
    } finally {
      cleanupHome(home);
    }
  });

  test("failed rotation rolls back to the previous credential and cleans its temp file", () => {
    const home = freshHome();
    try {
      const oldToken = ensureToken(home);
      expect(() =>
        rotateToken(home, {
          rename: () => {
            throw new Error("injected rename failure");
          },
          unlink: unlinkSync,
        }),
      ).toThrow("injected rename failure");
      expect(loadToken(home)).toBe(oldToken);
      expect(readdirSync(home)).toEqual(["token"]);
    } finally {
      cleanupHome(home);
    }
  });

  test("revoke is idempotent and a failed unlink preserves the old credential", () => {
    const home = freshHome();
    try {
      const oldToken = ensureToken(home);
      expect(() =>
        revokeToken(home, {
          rename: renameSync,
          unlink: () => {
            throw new Error("injected unlink failure");
          },
        }),
      ).toThrow("injected unlink failure");
      expect(loadToken(home)).toBe(oldToken);

      expect(revokeToken(home)).toBe(true);
      expect(loadToken(home)).toBeNull();
      expect(revokeToken(home)).toBe(false);
    } finally {
      cleanupHome(home);
    }
  });
});

describe("TokenAuthority", () => {
  test("generation changes abort stale streams and notify capability subscribers", () => {
    const home = freshHome();
    const first = ensureToken(home);
    const authority = new TokenAuthority(home);
    let changes = 0;
    authority.subscribe(() => changes++);
    const staleSignal = authority.generationSignal();
    try {
      const second = rotateToken(home);
      expect(authority.current()).toBe(second);
      expect(authority.current()).not.toBe(first);
      expect(staleSignal.aborted).toBe(true);
      expect(authority.generationSignal().aborted).toBe(false);
      expect(changes).toBe(1);

      revokeToken(home);
      expect(authority.current()).toBeNull();
      expect(changes).toBe(2);
    } finally {
      authority.close();
      cleanupHome(home);
    }
  });

  test("permission drift warns once per observed bad mode without disabling auth", () => {
    const home = freshHome();
    const token = ensureToken(home);
    chmodSync(tokenPath(home), 0o644);
    const warnings: string[] = [];
    const authority = new TokenAuthority(home, (message) => warnings.push(message));
    try {
      expect(authority.current()).toBe(token);
      expect(authority.current()).toBe(token);
      expect(warnings.filter((message) => message.includes("expected 0600"))).toHaveLength(1);
    } finally {
      authority.close();
      cleanupHome(home);
    }
  });
});

// SPDX-License-Identifier: Apache-2.0
// Test-only helpers for the P2.3 shadow-git + apply-lease suites. Mirrors test/bus/helpers.ts's
// freshWorkspace/cleanupWorkspace/deterministic-clock pattern (every test gets its own hermetic
// tmp workspace, never a real repo) plus a `writeFile` borrowed from test/matcher/helpers.ts's
// shape — these tests need actual tracked files on disk for git to have something to commit.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JournalWriter } from "../../src/bus/journal.ts";
import { journalPath } from "../../src/bus/paths.ts";
import { createUlidGenerator, type UlidGenerator } from "../../src/bus/ulid.ts";
import { claimDaemonIdentity, type DaemonIdentity, releaseDaemonIdentity } from "../../src/daemon-identity.ts";
import { writeLockExclusive } from "../../src/lock.ts";

export function freshWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "glosa-git-test-"));
}

export function cleanupWorkspace(root: string): void {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

export function writeFile(root: string, relPath: string, content: string): string {
  const abs = join(root, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

export function deterministicUlid(startMs = 1_700_000_000_000): UlidGenerator {
  let t = startMs;
  return createUlidGenerator({
    now: () => t++,
    randomBytes: (n) => new Uint8Array(n),
  });
}

export function deterministicClock(startMs = 1_700_000_000_000): () => Date {
  let t = startMs;
  return () => new Date(t++);
}

/** A throwaway `JournalWriter` for tests that need to satisfy shadow-git functions' `writer`
 * dependency but don't care about the journal content themselves — closed by the caller when
 * done (or left for the tmp dir cleanup to sweep, same as elsewhere in this test suite). */
export function testWriter(root: string): JournalWriter {
  return new JournalWriter(journalPath(root));
}

/** Establishes the A4 §F21 singleton proof the way the live daemon does: writes a REAL
 * `daemon.lock` (same `writeLockExclusive` + `DaemonLock` shape as `lifecycle.ts`) under this
 * test's own tmp workspace — never a real `~/.glosa` — and claims the matching process identity.
 * `reclaimIndexLock` then proves sole-operatorship against genuine on-disk bytes rather than a
 * stubbed comparison. Always pair with `dropDaemonIdentity()` in `afterEach`: the claim is
 * process-wide, and `bun test` runs every file in one process. */
export function claimTestDaemonIdentity(root: string, instanceId = "gl-test-instance"): DaemonIdentity {
  const home = join(root, "daemon-home");
  mkdirSync(home, { recursive: true });
  const lockFile = join(home, "daemon.lock");
  rmSync(lockFile, { force: true });
  writeLockExclusive(lockFile, {
    instance_id: instanceId,
    pid: process.pid,
    port: 0,
    protocol_version: "test",
    started_at: new Date().toISOString(),
    host: "127.0.0.1",
    bun: Bun.version,
  });
  const identity: DaemonIdentity = { instanceId, lockFile };
  claimDaemonIdentity(identity);
  return identity;
}

export function dropDaemonIdentity(): void {
  releaseDaemonIdentity();
}

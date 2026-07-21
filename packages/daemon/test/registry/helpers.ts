// Test-only helpers for the P2.4 registry suites. Every test gets its own tmp GLOSA_HOME and/or
// tmp workspace dir — never a real `~/.glosa` — plus a deterministic clock so lease/GC timing
// assertions don't depend on wall-clock jitter.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "glosa-registry-home-"));
}

export function freshWorkspaceDir(): string {
  return mkdtempSync(join(tmpdir(), "glosa-registry-ws-"));
}

export function cleanup(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

export function deterministicClock(startMs = 1_700_000_000_000): () => Date {
  let t = startMs;
  return () => new Date(t++);
}

/** A clock whose time only moves when the test explicitly calls `.advance(ms)` — for GC
 * throttle/grace-period and lease-expiry assertions where the test needs to control exactly how
 * much time has passed between two calls, not just get monotonically-increasing timestamps. */
export interface ManualClock {
  (): Date;
  advance(ms: number): void;
}

export function manualClock(startMs = 1_700_000_000_000): ManualClock {
  let t = startMs;
  const clock = (() => new Date(t)) as ManualClock;
  clock.advance = (ms: number) => {
    t += ms;
  };
  return clock;
}

// Test-only helpers for the P2.1 file-bus suites. Every test gets its own tmp workspace dir
// (never a real repo `.glosa/`) and a deterministic ulid/clock pair so ordering assertions don't
// depend on wall-clock timing.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUlidGenerator, type UlidGenerator } from "../../src/bus/ulid.ts";

export function freshWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "glosa-bus-test-"));
}

export function cleanupWorkspace(root: string): void {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

/** A deterministic ulid generator: fixed clock start, incrementing ms per call, zeroed
 * randomness (bumped by the generator's own monotonic-increment path when two calls land in the
 * same ms — which never happens here since the clock always advances). */
export function deterministicUlid(startMs = 1_700_000_000_000): UlidGenerator {
  let t = startMs;
  return createUlidGenerator({
    now: () => t++,
    randomBytes: (n) => new Uint8Array(n), // all-zero randomness — fine, time component still varies
  });
}

export function deterministicClock(startMs = 1_700_000_000_000): () => Date {
  let t = startMs;
  return () => new Date(t++);
}

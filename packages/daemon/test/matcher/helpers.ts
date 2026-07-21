// SPDX-License-Identifier: Apache-2.0
// Test-only helpers for the P2.2 matcher suites. Every test gets its own hermetic tmp workspace
// dir (never a real repo) — mirrors test/bus/helpers.ts's freshWorkspace/cleanupWorkspace pattern.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function freshWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "glosa-matcher-test-"));
}

export function cleanupWorkspace(root: string): void {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

/** Writes a file at `root/relPath`, creating parent dirs. `content` may be a string or a byte
 * count (writes that many `a` bytes) — useful for the size-threshold tests. */
export function writeFile(root: string, relPath: string, content: string | number): string {
  const abs = join(root, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  const data = typeof content === "number" ? "a".repeat(content) : content;
  writeFileSync(abs, data);
  return abs;
}

export function makeDir(root: string, relPath: string): string {
  const abs = join(root, relPath);
  mkdirSync(abs, { recursive: true });
  return abs;
}

export function makeSymlink(target: string, linkPath: string): void {
  symlinkSync(target, linkPath);
}

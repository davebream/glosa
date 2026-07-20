// Test-only helpers shared across the P1.2 daemon lifecycle suites. Every test gets its own
// tmp GLOSA_HOME and a random high port so parallel test cases never collide, and nothing here
// ever touches a real `~/.glosa`.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { lockPath } from "../src/home.ts";
import { readLock } from "../src/lock.ts";

const MAIN_PATH = fileURLToPath(new URL("../../cli/src/main.ts", import.meta.url));

export function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "glosa-test-"));
}

export function cleanupHome(home: string): void {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

/** A random high port per test case so concurrent test files never collide. */
export function randomPort(): number {
  return 21000 + Math.floor(Math.random() * 30000);
}

/** Spawns the real `glosa __daemon` process (not detached — tests want a handle to control it). */
export function spawnDaemon(
  home: string,
  port: number,
  envOverrides: Record<string, string> = {},
): Bun.Subprocess<"ignore", "pipe", "pipe"> {
  return Bun.spawn({
    cmd: [process.execPath, MAIN_PATH, "__daemon"],
    env: { ...Bun.env, GLOSA_HOME: home, GLOSA_PORT: String(port), ...envOverrides } as Record<
      string,
      string
    >,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

/** A pid guaranteed to be dead: spawn a trivial process and wait for it to exit. */
export async function deadPid(): Promise<number> {
  const proc = Bun.spawn({ cmd: [process.execPath, "-e", "0"], stdout: "ignore", stderr: "ignore" });
  const pid = proc.pid;
  await proc.exited;
  return pid;
}

export function writeUnparseableLock(home: string): void {
  writeFileSync(lockPath(home), "{ this is not json");
}

export async function waitForHandshake(
  port: number,
  deadlineMs = 5000,
): Promise<{ protocol_version: string; instance_id: string; pid: number; started_at: string } | null> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/handshake`, {
        signal: AbortSignal.timeout(500),
      });
      if (res.ok) return await res.json();
    } catch {
      // not up yet
    }
    await Bun.sleep(50);
  }
  return null;
}

export async function waitUntil(fn: () => boolean, deadlineMs = 3000, intervalMs = 50): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (fn()) return true;
    await Bun.sleep(intervalMs);
  }
  return fn();
}

export function lockOf(home: string) {
  return readLock(lockPath(home));
}

/** Best-effort SIGTERM + wait for the lock to disappear; used to tear down spawned daemons. */
export async function stopDaemon(home: string, proc: Bun.Subprocess): Promise<void> {
  try {
    proc.kill("SIGTERM");
  } catch {
    // already dead
  }
  await Promise.race([proc.exited, Bun.sleep(3000)]);
  await waitUntil(() => lockOf(home) === null, 3000);
}

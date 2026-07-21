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

// A random base picked once per test-process invocation, then a monotonic per-call offset on
// top of it (P1.3 review item 5). Two independent `Math.random()` calls could pick the same port
// and cause a real, intermittent collision between two subprocess daemons in the same run — this
// makes every call within one `bun test` invocation collision-free by construction, while still
// varying the base across runs so repeated runs don't all fight over the exact same range.
//
// Step is 4, not 1: `bootDaemon` binds a second listener at `GLOSA_CLASSF_PORT ?? port + 1` by
// default (A3 §0), and several tests (http.test.ts) derive that classF port the same way rather
// than calling randomPort() again. With a step of 1, `port + 1` for call N is *always* exactly
// the port randomPort() hands out to call N+1 — a guaranteed, not just probable, collision
// between one test's classF listener and the next test's main port. A step of 4 keeps every
// directly-issued port at the same offset (mod 4) as PORT_BASE while every `port + 1`/`port + 2`/
// `port + 3` derivative falls on a different residue, so neither can ever coincide with a
// directly-issued port.
const PORT_BASE = 20000 + Math.floor(Math.random() * 20000); // random base in [20000, 40000)
const PORT_STEP = 4;
let portOffset = 0;

/** A collision-free high port per call within this test run — including against any `port + N`
 * (N < PORT_STEP) derived from a previous call, e.g. a daemon's default class-F port. */
export function randomPort(): number {
  const port = PORT_BASE + portOffset;
  portOffset += PORT_STEP;
  return port;
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

// Default bumped from 5000 to 8000 (P1.3 review item 5 follow-up): a real daemon normally
// answers in well under a second, so this only adds margin for the failure path — it doesn't
// slow down passing tests, which return as soon as the handshake succeeds. The extra headroom
// matters once many subprocess-spawning tests run back to back in the same file; a spawn that's
// usually fast can occasionally take longer under that cumulative load, and 5000ms left too
// little slack against the surrounding tests' own budgets.
export async function waitForHandshake(
  port: number,
  deadlineMs = 8000,
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

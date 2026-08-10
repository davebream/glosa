// SPDX-License-Identifier: Apache-2.0
// Test-only helpers shared across the P1.2 daemon lifecycle suites. Every test gets its own
// tmp GLOSA_HOME and collision-free high port block, and nothing here ever touches a real
// `~/.glosa`.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

// Every isolated Bun test module evaluates this file separately, so a module-local random range
// is not enough: two workers can independently choose the same port. Reserve blocks atomically
// in the shared temp directory instead. A block has four ports because the daemon claims
// `port + 1` for Class-F and tests may derive up to `port + 3`.
const PORT_MIN = 20_000;
const PORT_MAX_EXCLUSIVE = 60_000;
const PORT_BLOCK_SIZE = 4;
const PORT_RESERVATION_ROOT = join(tmpdir(), "glosa-test-port-reservations");
const ownedReservations = new Set<string>();
let nextPort = PORT_MIN;

function reservationPath(port: number): string {
  return join(PORT_RESERVATION_ROOT, String(port));
}

function probePortBlock(port: number): boolean {
  const probes: ReturnType<typeof Bun.serve>[] = [];
  try {
    for (let offset = 0; offset < PORT_BLOCK_SIZE; offset += 1) {
      probes.push(
        Bun.serve({
          hostname: "127.0.0.1",
          port: port + offset,
          fetch: () => new Response(null, { status: 204 }),
        }),
      );
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    return false;
  } finally {
    for (const probe of probes) void probe.stop(true);
  }
}

function reservePortBlock(port: number): boolean {
  const reservation = reservationPath(port);
  try {
    mkdirSync(PORT_RESERVATION_ROOT, { recursive: true });
    mkdirSync(reservation);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }

  if (probePortBlock(port)) {
    ownedReservations.add(reservation);
    return true;
  }

  rmSync(reservation, { recursive: true, force: true });
  return false;
}

process.once("exit", () => {
  for (const reservation of ownedReservations) rmSync(reservation, { recursive: true, force: true });
});

/** A cross-process collision-free high port block. The returned port and its next three ports
 * are reserved for this test process, including the daemon's default Class-F listener. */
export function randomPort(): number {
  const blockCount = (PORT_MAX_EXCLUSIVE - PORT_MIN) / PORT_BLOCK_SIZE;
  for (let attempt = 0; attempt < blockCount; attempt += 1) {
    const port = nextPort;
    nextPort += PORT_BLOCK_SIZE;
    if (nextPort >= PORT_MAX_EXCLUSIVE) nextPort = PORT_MIN;
    if (reservePortBlock(port)) return port;
  }
  throw new Error("no free glosa test port blocks remain");
}

/** Spawns the real `glosa __daemon` process (not detached — tests want a handle to control it).
 * stdout/stderr are ignored on purpose: nothing in the shared helpers reads those pipes, and an
 * undrained pipe can fill and stall the child under full-suite load (flaky handshake timeouts). */
export function spawnDaemon(
  home: string,
  port: number,
  envOverrides: Record<string, string> = {},
): Bun.Subprocess<"ignore", "ignore", "ignore"> {
  return Bun.spawn({
    cmd: [process.execPath, MAIN_PATH, "__daemon"],
    env: { ...Bun.env, GLOSA_HOME: home, GLOSA_PORT: String(port), ...envOverrides } as Record<
      string,
      string
    >,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
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

// Default bumped to 15000 (P1.3 review item 5 follow-up): a real daemon normally
// answers in well under a second, so this only adds margin for the failure path — it doesn't
// slow down passing tests, which return as soon as the handshake succeeds. The extra headroom
// matters once the full subprocess suites run twice back to back; a spawn that's usually fast
// can occasionally take longer under that cumulative load. Passing tests still return as soon as
// the handshake succeeds, so the margin only affects a genuine failure path.
//
// When `proc` is supplied, bail as soon as the child has exited — otherwise a spawn that lost
// EADDRINUSE / crashed would burn the full deadline polling a port that will never answer, and
// under Bun's default 5s test timeout that surfaces as an opaque handshake null / dangling kill.
export async function waitForHandshake(
  port: number,
  deadlineMs = 15000,
  proc?: Bun.Subprocess,
): Promise<{ protocol_version: string; build_id?: string; instance_id: string; pid: number; started_at: string } | null> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (proc && proc.exitCode !== null) return null;
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

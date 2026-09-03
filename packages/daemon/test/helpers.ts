// SPDX-License-Identifier: Apache-2.0
// Test-only helpers shared across the P1.2 daemon lifecycle suites. Every test gets its own
// tmp GLOSA_HOME and collision-free high port block, and nothing here ever touches a real
// `~/.glosa`.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type EnsureDaemonResult, ensureDaemon as ensureProductionDaemon } from "../src/lifecycle/daemon.ts";
import { glosaHome, lockPath } from "../src/lifecycle/home.ts";
import { readLock } from "../src/lifecycle/lock.ts";

const MAIN_PATH = fileURLToPath(new URL("../../cli/src/main.ts", import.meta.url));
const GUARDIAN_PATH = fileURLToPath(new URL("./fixtures/daemon-guardian.ts", import.meta.url));

// A test runner can be stopped before its async finally/afterAll hooks run. Ordinary child
// processes are reparented in that case, so every real daemon this helper launches would otherwise
// survive the suite that owns its temporary home. Keep strong handles and synchronously SIGKILL
// only those exact children from the process exit hook; production's detached-daemon semantics are
// untouched because this ownership registry exists only in test code.
const ownedDaemonChildren = new Set<Bun.Subprocess<"ignore", "ignore", "ignore">>();
const ownedDetachedDaemons = new Map<number, { home: string; instanceId: string }>();
let guardian: Bun.Subprocess<"pipe", "ignore", "ignore"> | null = null;

function guardianCommand(op: "watch" | "unwatch", home: string): void {
  if (!guardian || guardian.exitCode !== null) {
    guardian = Bun.spawn({
      cmd: [process.execPath, GUARDIAN_PATH],
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
    });
    guardian.unref();
  }
  guardian.stdin.write(`${JSON.stringify({ op, home })}\n`);
  guardian.stdin.flush();
}

export function superviseDaemonHome(home: string): void {
  guardianCommand("watch", home);
}

function releaseDaemonHome(home: string): void {
  if (guardian?.exitCode === null) guardianCommand("unwatch", home);
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function reapOwnedDaemonChildren(): void {
  for (const child of ownedDaemonChildren) {
    if (child.exitCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // The child won an exit race; there is nothing left to reap.
      }
    }
  }
  for (const [pid, owned] of ownedDetachedDaemons) {
    const lock = readLock(lockPath(owned.home));
    if (lock?.pid !== pid || lock.instance_id !== owned.instanceId) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already dead
    }
  }
}

process.once("exit", reapOwnedDaemonChildren);
for (const [signal, exitCode] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
  ["SIGHUP", 129],
] as const) {
  process.once(signal, () => {
    reapOwnedDaemonChildren();
    process.exit(exitCode);
  });
}

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

// Every isolated Bun test module evaluates this file separately, so a module-local random range is
// not enough: two workers can independently choose the same port. Two *worktrees* can too — a
// developer running `bun test` in two checkouts at once is the case that made this concrete. So the
// reservation stays MACHINE-GLOBAL. Namespacing it per worktree would only trade one bug for a
// worse one: 127.0.0.1 ports are a machine-global resource, so two namespaced checkouts would each
// happily "own" port 20000 and then collide for real on bind.
//
// The reservation IS a listening socket, not a file. Reservations used to be directories under a
// shared `$TMPDIR` root, released only from `process.once("exit", ...)`, which meant a SIGKILLed or
// crashed run leaked its block forever; the root grew monotonically until every socket test on the
// machine failed, in isolation too, with nothing to hint that the fix was `rm -rf` on a directory.
//
// `packages/daemon/src/registry/lockfile-fallback.ts` solves its equivalent problem with an owner
// pid plus `kill(pid, 0)` liveness bounded by an abandon ceiling, and that is the right answer
// THERE: it guards an ordinary file, and no filesystem offers compare-and-delete, so a reclaimer
// that reads a dead record and then unlinks it can unlink the LIVE record a second reclaimer just
// put in its place — which is why that module also has to re-prove ownership afterwards and can
// raise LEASE_STOLEN. Copying that here would import the same residual race and a TTL that is a
// guess either way.
//
// We do not need it, because the resource being reserved is itself a kernel object. bind(2) is a
// real compare-and-swap, and the kernel closes the socket when the owner dies for ANY reason —
// SIGKILL, panic, a `bun test` interrupted with ctrl-C. Reclamation is therefore immediate and
// exact, with no pid, no TTL, no sweeper and no reclaim race; and a crashed run leaves nothing on
// disk at all, so there is no leak left to reap. That is strictly stronger than the directories
// were, which only excluded processes that agreed to consult the directory.
//
// One sentinel port per block, in a range disjoint from the blocks themselves, so holding a
// reservation never occupies a port a test might want. A block is four ports because the daemon
// claims `port + 1` for Class-F and tests may derive up to `port + 3`.
const PORT_MIN = 20_000;
const PORT_BLOCK_SIZE = 4;
/** First sentinel port. Everything below is block space, everything from here to 59_999 is one
 * sentinel per block — 8000 blocks and 8000 sentinels fit the 20_000-59_999 range exactly. */
const SENTINEL_MIN = 52_000;
const MAX_BLOCKS = (SENTINEL_MIN - PORT_MIN) / PORT_BLOCK_SIZE;

/** Test seams, and the ONLY reason this is configurable: a subprocess test must be able to retry
 * one exact block to prove crash release and live-owner exclusion without binding 8000 sentinels.
 * Anything absent, unparseable or out of range falls back to the normal whole-range behavior, so
 * a stray env var cannot point outside the allocator's range. */
function configuredBlockOffset(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed >= MAX_BLOCKS) return 0;
  return parsed;
}

function configuredBlockCount(raw: string | undefined, available: number): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > available) return available;
  return parsed;
}

const BLOCK_OFFSET = configuredBlockOffset(Bun.env.GLOSA_TEST_PORT_BLOCK_OFFSET);
const BLOCK_COUNT = configuredBlockCount(Bun.env.GLOSA_TEST_PORT_BLOCKS, MAX_BLOCKS - BLOCK_OFFSET);
const BLOCK_MIN = PORT_MIN + BLOCK_OFFSET * PORT_BLOCK_SIZE;
const BLOCK_MAX_EXCLUSIVE = BLOCK_MIN + BLOCK_COUNT * PORT_BLOCK_SIZE;

function bindExclusiveListener(port: number) {
  return Bun.listen({
    hostname: "127.0.0.1",
    port,
    // Bun documents the default as non-exclusive. Darwin currently rejects a second bind even
    // without this flag, but the allocator must depend on the API contract, not that accident.
    exclusive: true,
    // Nothing ever connects to a sentinel. It exists only to be un-bindable by anyone else, so the
    // handlers just refuse whatever wanders in.
    socket: {
      data: () => {},
      open: (socket) => {
        socket.end();
      },
    },
  });
}

type Sentinel = ReturnType<typeof bindExclusiveListener>;

// Strong references, deliberately. Sentinels are unref'd so a reservation never keeps a test
// process alive, and an unref'd listener that nothing references is exactly the kind of object a GC
// is free to finalize — which would silently drop a reservation the process still depends on.
const heldSentinels: Sentinel[] = [];
let nextPort = BLOCK_MIN;

function sentinelPortFor(port: number): number {
  return SENTINEL_MIN + (port - PORT_MIN) / PORT_BLOCK_SIZE;
}

function probePortBlock(port: number): boolean {
  const probes: Sentinel[] = [];
  try {
    for (let offset = 0; offset < PORT_BLOCK_SIZE; offset += 1) {
      probes.push(bindExclusiveListener(port + offset));
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    return false;
  } finally {
    // SocketListener.stop() is synchronous, unlike Bun.serve.stop(). randomPort() may hand this
    // block to a daemon immediately, so returning before the probes close creates its own bind race.
    for (const probe of probes) probe.stop(true);
  }
}

function reservePortBlock(port: number): boolean {
  let sentinel: Sentinel;
  try {
    sentinel = bindExclusiveListener(sentinelPortFor(port));
  } catch (error) {
    // EADDRINUSE means a live process — this one, a sibling test file, another worktree's suite —
    // holds the block. Anything else is a real failure and must not be read as "block taken".
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    return false;
  }
  sentinel.unref();

  // The sentinel excludes other users of this helper; the probe catches everything else that might
  // already be sitting on the block — an unrelated service, or a daemon orphaned by an earlier run.
  if (!probePortBlock(port)) {
    sentinel.stop(true);
    return false;
  }

  heldSentinels.push(sentinel);
  return true;
}

/** A cross-process collision-free high port block. The returned port and its next three ports
 * are reserved for this test process, including the daemon's default Class-F listener. The
 * reservation lasts exactly as long as this process does, however it ends. */
export function randomPort(): number {
  for (let attempt = 0; attempt < BLOCK_COUNT; attempt += 1) {
    const port = nextPort;
    nextPort += PORT_BLOCK_SIZE;
    if (nextPort >= BLOCK_MAX_EXCLUSIVE) nextPort = BLOCK_MIN;
    if (reservePortBlock(port)) return port;
  }
  throw new Error(
    `no free glosa test port block in ${BLOCK_MIN}-${BLOCK_MAX_EXCLUSIVE - 1}: all ${BLOCK_COUNT} ` +
      `sentinel ports (${sentinelPortFor(BLOCK_MIN)}-${sentinelPortFor(BLOCK_MAX_EXCLUSIVE - PORT_BLOCK_SIZE)}) ` +
      "are bound. Reservations " +
      "are held by live processes and released by the kernel the moment they exit, so this is " +
      "never leftover state and there is no directory to delete — something is genuinely holding " +
      "them. Stop any other running glosa test suites and any orphaned `glosa __daemon`, then " +
      "see who is left with:\n  lsof -nP -iTCP@127.0.0.1 -sTCP:LISTEN",
  );
}

/** Spawns the real `glosa __daemon` process (not detached — tests want a handle to control it).
 * stdout/stderr are ignored on purpose: nothing in the shared helpers reads those pipes, and an
 * undrained pipe can fill and stall the child under full-suite load (flaky handshake timeouts). */
export function spawnDaemon(
  home: string,
  port: number,
  envOverrides: Record<string, string> = {},
): Bun.Subprocess<"ignore", "ignore", "ignore"> {
  superviseDaemonHome(home);
  const child = Bun.spawn({
    cmd: [process.execPath, MAIN_PATH, "__daemon"],
    env: { ...Bun.env, GLOSA_HOME: home, GLOSA_PORT: String(port), ...envOverrides } as Record<string, string>,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  ownedDaemonChildren.add(child);
  void child.exited.finally(() => ownedDaemonChildren.delete(child));
  return child;
}

export function trackDetachedDaemon(home: string, daemon: { pid: number; instanceId: string }): void {
  ownedDetachedDaemons.set(daemon.pid, { home, instanceId: daemon.instanceId });
}

/** Production ensure semantics with test-runner ownership registered immediately after readiness. */
export async function ensureTestDaemon(): Promise<EnsureDaemonResult> {
  const home = glosaHome();
  superviseDaemonHome(home);
  const result = await ensureProductionDaemon();
  if (result.ok) trackDetachedDaemon(home, result);
  return result;
}

export async function stopDetachedDaemon(home: string, daemon: { pid: number; instanceId?: string }): Promise<void> {
  try {
    process.kill(daemon.pid, "SIGTERM");
  } catch {
    // already dead
  }
  let exited = await waitUntil(() => !pidIsAlive(daemon.pid), 3000);
  if (!exited) {
    const lock = readLock(lockPath(home));
    if (lock?.pid === daemon.pid && (daemon.instanceId === undefined || lock.instance_id === daemon.instanceId)) {
      try {
        process.kill(daemon.pid, "SIGKILL");
      } catch {
        // already dead
      }
      exited = await waitUntil(() => !pidIsAlive(daemon.pid), 3000);
    }
  }
  if (!exited) throw new Error(`test daemon pid ${daemon.pid} did not exit after SIGTERM/SIGKILL`);
  ownedDetachedDaemons.delete(daemon.pid);
  if (!(await waitUntil(() => lockOf(home) === null, 3000))) {
    throw new Error(`test daemon pid ${daemon.pid} exited without releasing ${lockPath(home)}`);
  }
  releaseDaemonHome(home);
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
): Promise<{
  protocol_version: string;
  build_id?: string;
  instance_id: string;
  pid: number;
  started_at: string;
} | null> {
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

/** SIGTERM, then bounded SIGKILL fallback, proving the owned child actually exited before its
 * temporary home can be removed. */
export async function stopDaemon(home: string, proc: Bun.Subprocess): Promise<void> {
  try {
    proc.kill("SIGTERM");
  } catch {
    // already dead
  }
  const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(3000).then(() => false)]);
  if (!exited && proc.exitCode === null) {
    try {
      proc.kill("SIGKILL");
    } catch {
      // already dead
    }
  }
  await proc.exited;
  if (!(await waitUntil(() => lockOf(home) === null, 3000))) {
    throw new Error(`test daemon pid ${proc.pid} exited without releasing ${lockPath(home)}`);
  }
  releaseDaemonHome(home);
}

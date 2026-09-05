// SPDX-License-Identifier: Apache-2.0
// P1.2 daemon lifecycle — real fault/concurrency tests (A5 §F13). Every test gets its own tmp
// GLOSA_HOME + a random high port (via helpers.ts) so parallel runs never collide on port/home,
// and nothing here ever touches a real `~/.glosa`. The bootDaemon-side cases spawn the actual
// `glosa __daemon` subprocess — that's the point, per the task brief: these are fault-injection
// and race scenarios a happy-path unit test can't exercise.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { APP_VERSION, BUILD_ID } from "../src/lifecycle/build-id.ts";
import { confirmPortFree } from "../src/lifecycle/daemon.ts";
import { ensureHomeDir, lockPath, logPath } from "../src/lifecycle/home.ts";
import { type DaemonLock, reclaimStaleLock, writeLockExclusive } from "../src/lifecycle/lock.ts";
import { PROTOCOL_VERSION } from "../src/lifecycle/protocol.ts";
import {
  assertDefined,
  cleanupHome,
  deadPid,
  ensureTestDaemon as ensureDaemon,
  freshHome,
  lockOf,
  randomPort,
  spawnDaemon,
  stopDaemon,
  waitForFile,
  waitForHandshake,
  waitUntil,
  writeUnparseableLock,
} from "./helpers.ts";

/** Long enough that the daemon's 250ms lock-repair watchdog has certainly had several turns.
 *
 * The tests using this prove a negative — the watchdog looked at this file and declined to touch
 * it — and declining is silent, so there is no event to wait for and a settle window is the only
 * instrument available. The risk it guards against is not flakiness but a vacuous pass: too short a
 * window and the assertion holds because the watchdog never ran at all, which proves nothing. */
const WATCHDOG_SETTLE_MS = 1_500;

/** Long enough for a signal to have killed the process if it were going to. A different timescale
 * from the watchdog's: signal delivery and exit are prompt, and the test that uses this backs the
 * window with a positive proof — the daemon answers a handshake afterwards. */
const SIGNAL_SETTLE_MS = 300;

function sampleLock(overrides: Partial<DaemonLock> = {}): DaemonLock {
  return {
    instance_id: "gl-fake",
    pid: process.pid,
    port: randomPort(),
    protocol_version: PROTOCOL_VERSION,
    build_id: BUILD_ID,
    started_at: new Date().toISOString(),
    host: "127.0.0.1",
    bun: Bun.version,
    ...overrides,
  };
}

const VERSIONED_DAEMON_FIXTURE = fileURLToPath(new URL("./fixtures/versioned-daemon.ts", import.meta.url));

function spawnVersionedDaemon(
  home: string,
  port: number,
  buildId?: string,
  envOverrides: Record<string, string> = {},
): Bun.Subprocess<"ignore", "pipe", "pipe"> {
  return Bun.spawn({
    cmd: [process.execPath, VERSIONED_DAEMON_FIXTURE],
    env: {
      ...Bun.env,
      GLOSA_HOME: home,
      GLOSA_PORT: String(port),
      ...(buildId === undefined ? {} : { GLOSA_FIXTURE_BUILD_ID: buildId }),
      ...envOverrides,
    } as Record<string, string>,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("bootDaemon — subprocess fault/concurrency", () => {
  let home: string;

  beforeEach(() => {
    home = freshHome();
  });

  afterEach(() => {
    cleanupHome(home);
  });

  test("two concurrent spawns on the same home/port: exactly one live daemon, loser exits 0", async () => {
    const port = randomPort();
    const p1 = spawnDaemon(home, port);
    const p2 = spawnDaemon(home, port);
    try {
      const race = await Promise.race([
        p1.exited.then((code) => ({ code, other: p2 })),
        p2.exited.then((code) => ({ code, other: p1 })),
      ]);
      // The loser exits 0 (benign race per A5 §F13); the winner keeps serving.
      expect(race.code).toBe(0);

      const hs = await waitForHandshake(port);
      assertDefined(hs, "handshake");

      const lock = lockOf(home);
      assertDefined(lock, "ownership lock");
      expect(lock.instance_id).toBe(hs.instance_id);

      await stopDaemon(home, race.other);
    } finally {
      try {
        p1.kill("SIGKILL");
      } catch {
        // already dead
      }
      try {
        p2.kill("SIGKILL");
      } catch {
        // already dead
      }
    }
  }, 10000);

  test("a daemon contender exits terminally when a foreign process already owns the port", async () => {
    const port = randomPort();
    const squatter = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch: () => Response.json({ not: "a glosa handshake" }),
    });
    const proc = spawnDaemon(home, port);
    try {
      expect(await proc.exited).toBe(3);
      expect(readFileSync(logPath(home), "utf8")).toContain("EADDRINUSE");
      expect(lockOf(home)).toBeNull();
    } finally {
      squatter.stop();
      try {
        proc.kill("SIGKILL");
      } catch {
        // already stopped
      }
    }
  }, 5000);

  test("second daemon on a different port hits the lock EEXIST/live-peer branch and exits 0, leaving the first daemon's lock intact", async () => {
    const portA = randomPort();
    const portB = randomPort();

    const daemonA = spawnDaemon(home, portA);
    try {
      const hsA = await waitForHandshake(portA);
      expect(hsA).not.toBeNull();
      expect(lockOf(home)?.port).toBe(portA);

      // daemonB binds its OWN port fine (no EADDRINUSE — different port), then hits the lock
      // file already held by daemonA: EEXIST → reads the existing lock → confirms daemonA is a
      // live peer via handshake at lock.port → benign race → exits 0 without touching the lock.
      const daemonB = spawnDaemon(home, portB);
      try {
        const codeB = await daemonB.exited;
        expect(codeB).toBe(0);

        // daemonA's lock is untouched — still points at daemonA, still on portA.
        const lock = lockOf(home);
        expect(lock).not.toBeNull();
        expect(lock!.instance_id).toBe(hsA!.instance_id);
        expect(lock!.port).toBe(portA);

        // daemonA is still the one actually serving.
        const hsA2 = await waitForHandshake(portA, 1000);
        expect(hsA2?.instance_id).toBe(hsA!.instance_id);
      } finally {
        try {
          daemonB.kill("SIGKILL");
        } catch {
          // already dead
        }
      }
    } finally {
      await stopDaemon(home, daemonA);
    }
  }, 10000);

  test("stale lock: dead pid is reclaimed and a fresh daemon boots", async () => {
    ensureHomeDir(home);
    const port = randomPort();
    writeLockExclusive(lockPath(home), sampleLock({ pid: await deadPid(), port }));

    const proc = spawnDaemon(home, port);
    try {
      const hs = await waitForHandshake(port);
      expect(hs).not.toBeNull();
      // The main listener intentionally becomes reachable before lock reclamation completes.
      // Wait for ownership rather than racing the bind-before-lock lifecycle contract.
      expect(await waitForFile(lockPath(home), () => lockOf(home)?.pid === proc.pid)).toBe(true);
      const lock = lockOf(home);
      expect(lock!.instance_id).not.toBe("gl-fake");
      expect(lock!.pid).toBe(proc.pid);
    } finally {
      await stopDaemon(home, proc);
    }
  }, 10000);

  test("stale lock: unparseable lock file is reclaimed and a fresh daemon boots", async () => {
    ensureHomeDir(home);
    const port = randomPort();
    writeUnparseableLock(home);

    const proc = spawnDaemon(home, port);
    try {
      const hs = await waitForHandshake(port);
      expect(hs).not.toBeNull();
      expect(lockOf(home)?.pid).toBe(proc.pid);
    } finally {
      await stopDaemon(home, proc);
    }
  }, 10000);

  test("repairs a deleted ownership lock without handshake traffic", async () => {
    ensureHomeDir(home);
    const port = randomPort();
    const proc = spawnDaemon(home, port);
    try {
      const hs = await waitForHandshake(port);
      assertDefined(hs, "handshake");
      unlinkSync(lockPath(home));

      // The watchdog lives in a separate OS process on its own 250ms timer. A loaded runner can
      // starve that process for seconds, so the budget is generous — and costs nothing here,
      // because the repair write is itself the event this returns on. Asserting the result is what
      // makes a genuine timeout say "timed out" instead of failing the match below against null.
      expect(await waitForFile(lockPath(home), () => lockOf(home)?.instance_id === hs.instance_id)).toBe(true);

      expect(lockOf(home)).toMatchObject({
        instance_id: hs.instance_id,
        pid: hs.pid,
        port,
        build_id: hs.build_id,
      });
      expect(readFileSync(logPath(home), "utf8")).toContain("recreated missing ownership lock");
    } finally {
      await stopDaemon(home, proc);
    }
  }, 10000);

  test("watchdog never overwrites an existing malformed ownership file", async () => {
    ensureHomeDir(home);
    const port = randomPort();
    const proc = spawnDaemon(home, port);
    const malformed = "{not-json";
    try {
      expect(await waitForHandshake(port)).not.toBeNull();
      await Bun.write(lockPath(home), malformed);

      await Bun.sleep(WATCHDOG_SETTLE_MS);

      expect(readFileSync(lockPath(home), "utf8")).toBe(malformed);
    } finally {
      proc.kill("SIGTERM");
      await proc.exited;
    }
  }, 10000);

  test("SIGTERM: daemon stops accepting and removes its own lock", async () => {
    ensureHomeDir(home);
    const port = randomPort();
    const proc = spawnDaemon(home, port);
    try {
      const hs = await waitForHandshake(port);
      expect(hs).not.toBeNull();
      expect(lockOf(home)).not.toBeNull();

      proc.kill("SIGTERM");
      const code = await proc.exited;
      expect(code).toBe(0);
      // A positive proof — the lock really goes away — so wait on the removal itself rather than
      // guessing how long it takes.
      expect(await waitForFile(lockPath(home), () => lockOf(home) === null)).toBe(true);
    } finally {
      try {
        proc.kill("SIGKILL");
      } catch {
        // already dead
      }
    }
  }, 10000);

  test("SIGTERM guard: does not unlink a lock whose instance_id no longer matches", async () => {
    ensureHomeDir(home);
    const port = randomPort();
    const proc = spawnDaemon(home, port);
    try {
      const hs = await waitForHandshake(port);
      expect(hs).not.toBeNull();

      // Simulate the lock having been reclaimed by someone else out from under this daemon.
      reclaimStaleLock(lockPath(home), sampleLock({ instance_id: "gl-someone-else", port }));

      await Bun.sleep(WATCHDOG_SETTLE_MS);
      expect(lockOf(home)?.instance_id).toBe("gl-someone-else");

      proc.kill("SIGTERM");
      const code = await proc.exited;
      expect(code).toBe(0); // still exits cleanly

      const lock = lockOf(home);
      expect(lock).not.toBeNull();
      expect(lock!.instance_id).toBe("gl-someone-else"); // untouched
    } finally {
      try {
        proc.kill("SIGKILL");
      } catch {
        // already dead
      }
    }
  }, 10000);

  test("ignores SIGINT and SIGHUP: stays alive, lock intact, handshake still 200", async () => {
    ensureHomeDir(home);
    const port = randomPort();
    const proc = spawnDaemon(home, port);
    try {
      const hs = await waitForHandshake(port);
      assertDefined(hs, "handshake");

      proc.kill("SIGINT");
      await Bun.sleep(SIGNAL_SETTLE_MS);
      proc.kill("SIGHUP");
      await Bun.sleep(SIGNAL_SETTLE_MS);

      const stillAlive = await Promise.race([
        proc.exited.then(() => false),
        Bun.sleep(SIGNAL_SETTLE_MS).then(() => true),
      ]);
      expect(stillAlive).toBe(true);

      // Staying alive is only half of it — it must still be serving. This is the positive proof
      // that carries the test, so it gets the ordinary handshake budget rather than a tight one.
      const hs2 = await waitForHandshake(port);
      expect(hs2?.instance_id).toBe(hs.instance_id);
      expect(lockOf(home)?.instance_id).toBe(hs.instance_id);
    } finally {
      await stopDaemon(home, proc);
    }
  }, 10000);
});

describe("stable free-port confirmation", () => {
  test("retains ownership when a transient refused sequence becomes bound", async () => {
    const observations = [false, false, true];
    let calls = 0;
    const delays: number[] = [];
    const result = await confirmPortFree(4646, {
      deadline: performance.now() + 1000,
      ownershipUnchanged: () => true,
      probe: async () => observations[calls++] as boolean,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    expect(result).toBe("bound");
    expect(calls).toBe(3);
    expect(delays).toEqual([100, 100]);
  });

  test("reports free only after three consecutive refused connections", async () => {
    let calls = 0;
    const result = await confirmPortFree(4646, {
      deadline: performance.now() + 1000,
      ownershipUnchanged: () => true,
      probe: async () => {
        calls += 1;
        return false;
      },
      sleep: async () => {},
    });

    expect(result).toBe("free");
    expect(calls).toBe(3);
  });

  test("stops before another probe when ownership changes or the deadline expires", async () => {
    let ownershipChecks = 0;
    let probes = 0;
    const changed = await confirmPortFree(4646, {
      deadline: performance.now() + 1000,
      ownershipUnchanged: () => {
        ownershipChecks += 1;
        return ownershipChecks < 3;
      },
      probe: async () => {
        probes += 1;
        return false;
      },
      sleep: async () => {},
    });
    const expired = await confirmPortFree(4646, {
      deadline: 0,
      ownershipUnchanged: () => true,
      probe: async () => {
        throw new Error("deadline should prevent probing");
      },
      now: () => 1,
    });

    expect(changed).toBe("ownership-changed");
    expect(probes).toBe(1);
    expect(expired).toBe("deadline");
  });
});

// P1.3 review item 5 follow-up: this describe block used to share one `let home` / `savedHome` /
// `savedPort` closure across all five tests via beforeEach/afterEach. Several of these tests do
// a real ~5s wait deep inside `ensureDaemon()` (polling a port that's deliberately never going
// to answer), and re-read the shared `home` closure variable AFTER that wait — e.g. `fail-closed`
// asserts `logPath(home)` only after its `await ensureDaemon()` returns. That pattern turned out
// to be unsafe against this Bun version's test scheduling: under the load of the full suite (and
// even in isolation), the next test's beforeEach could run and reassign the shared `home` before
// a still-pending previous test's post-await code read it, producing spurious ENOENT/ path-
// mismatch failures with no bug in the daemon code itself — confirmed by re-running the same
// scenario with each test's state made fully local (below) and seeing the flake disappear.
// Fix: each test now owns a `const home = freshHome()` and saves/restores the env vars itself in
// a local try/finally — no state is shared with any sibling test, so no interleaving (real or
// scheduler-induced) can corrupt another test's view of its own home directory.
describe("ensureDaemon — client", () => {
  test("a legacy daemon is replaced and the successful connection reports the current build", async () => {
    const home = freshHome();
    const savedHome = process.env.GLOSA_HOME;
    const savedPort = process.env.GLOSA_PORT;
    const port = randomPort();
    const legacy = spawnVersionedDaemon(home, port);
    let replacementPid: number | null = null;
    try {
      const legacyHandshake = await waitForHandshake(port);
      expect(legacyHandshake?.build_id).toBeUndefined();
      process.env.GLOSA_HOME = home;
      process.env.GLOSA_PORT = String(port);

      const result = await ensureDaemon();
      expect(result.ok).toBe(true);
      if (result.ok) {
        replacementPid = result.pid;
        expect(result.buildId).toBe(BUILD_ID);
        expect(result.pid).not.toBe(legacy.pid);
        expect(lockOf(home)?.build_id).toBe(BUILD_ID);
      }
      expect(await legacy.exited).toBe(0);
    } finally {
      const pid = replacementPid;
      if (typeof pid === "number") {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // already stopped
        }
        await waitUntil(() => lockOf(home) === null, 5000);
      }
      try {
        legacy.kill("SIGKILL");
      } catch {
        // already stopped
      }
      if (savedHome === undefined) delete process.env.GLOSA_HOME;
      else process.env.GLOSA_HOME = savedHome;
      if (savedPort === undefined) delete process.env.GLOSA_PORT;
      else process.env.GLOSA_PORT = savedPort;
      cleanupHome(home);
    }
  }, 20000);

  test("a current daemon silently recreates a missing lock and concurrent clients converge", async () => {
    const home = freshHome();
    const savedHome = process.env.GLOSA_HOME;
    const savedPort = process.env.GLOSA_PORT;
    const port = randomPort();
    const daemon = spawnDaemon(home, port);
    try {
      const handshake = await waitForHandshake(port);
      expect(handshake).not.toBeNull();
      unlinkSync(lockPath(home));
      process.env.GLOSA_HOME = home;
      process.env.GLOSA_PORT = String(port);

      const results = await Promise.all(Array.from({ length: 8 }, () => ensureDaemon()));

      expect(results.every((result) => result.ok)).toBe(true);
      for (const result of results) {
        if (!result.ok) throw new Error(result.reason);
        expect(result.pid).toBe(handshake!.pid);
        expect(result.instanceId).toBe(handshake!.instance_id);
      }
      expect(lockOf(home)).toMatchObject({
        pid: handshake!.pid,
        instance_id: handshake!.instance_id,
        port,
        build_id: handshake!.build_id,
      });
      expect(readFileSync(logPath(home), "utf8")).toContain("recreated missing ownership lock");
    } finally {
      await stopDaemon(home, daemon);
      if (savedHome === undefined) delete process.env.GLOSA_HOME;
      else process.env.GLOSA_HOME = savedHome;
      if (savedPort === undefined) delete process.env.GLOSA_PORT;
      else process.env.GLOSA_PORT = savedPort;
      cleanupHome(home);
    }
  }, 12000);

  test("a slow current daemon repairs a missing lock and is reused without spawning a contender", async () => {
    const home = freshHome();
    const savedHome = process.env.GLOSA_HOME;
    const savedPort = process.env.GLOSA_PORT;
    const port = randomPort();
    const daemon = spawnVersionedDaemon(home, port, BUILD_ID, {
      GLOSA_FIXTURE_REPAIR_INTERVAL_MS: "250",
      GLOSA_FIXTURE_SLOW_HANDSHAKE_AFTER: "1",
      GLOSA_FIXTURE_SLOW_HANDSHAKE_COUNT: "2",
      GLOSA_FIXTURE_HANDSHAKE_DELAY_MS: "1100",
    });
    try {
      const handshake = await waitForHandshake(port);
      expect(handshake).not.toBeNull();
      unlinkSync(lockPath(home));
      process.env.GLOSA_HOME = home;
      process.env.GLOSA_PORT = String(port);

      const result = await ensureDaemon({ timeoutMs: 3000 });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.reason);
      expect(result.pid).toBe(handshake!.pid);
      expect(result.instanceId).toBe(handshake!.instance_id);
      expect(lockOf(home)?.instance_id).toBe(handshake!.instance_id);
      const log = existsSync(logPath(home)) ? readFileSync(logPath(home), "utf8") : "";
      expect(log).not.toContain("EADDRINUSE");
    } finally {
      await stopDaemon(home, daemon);
      if (savedHome === undefined) delete process.env.GLOSA_HOME;
      else process.env.GLOSA_HOME = savedHome;
      if (savedPort === undefined) delete process.env.GLOSA_PORT;
      else process.env.GLOSA_PORT = savedPort;
      cleanupHome(home);
    }
  }, 12000);

  test("an overall deadline leaves ambiguous live ownership untouched", async () => {
    const home = freshHome();
    const savedHome = process.env.GLOSA_HOME;
    const savedPort = process.env.GLOSA_PORT;
    const port = randomPort();
    ensureHomeDir(home);
    const squatter = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch: () => Response.json({ not: "a glosa handshake" }),
    });
    writeLockExclusive(lockPath(home), sampleLock({ pid: process.pid, port }));

    try {
      process.env.GLOSA_HOME = home;
      process.env.GLOSA_PORT = String(port);
      const started = performance.now();
      const result = await ensureDaemon({ timeoutMs: 300 });
      const elapsed = performance.now() - started;

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("300ms wall-clock budget");
      expect(elapsed).toBeLessThan(1000);
      expect(lockOf(home)?.instance_id).toBe("gl-fake");
      expect(existsSync(logPath(home))).toBe(false);
    } finally {
      squatter.stop();
      if (savedHome === undefined) delete process.env.GLOSA_HOME;
      else process.env.GLOSA_HOME = savedHome;
      if (savedPort === undefined) delete process.env.GLOSA_PORT;
      else process.env.GLOSA_PORT = savedPort;
      cleanupHome(home);
    }
  });

  test("a dead-PID lock is retained when its port remains bound", async () => {
    const home = freshHome();
    const savedHome = process.env.GLOSA_HOME;
    const savedPort = process.env.GLOSA_PORT;
    const port = randomPort();
    const stalePid = await deadPid();
    ensureHomeDir(home);
    const squatter = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch: () => Response.json({ not: "a glosa handshake" }),
    });
    writeLockExclusive(lockPath(home), sampleLock({ pid: stalePid, port }));

    try {
      process.env.GLOSA_HOME = home;
      process.env.GLOSA_PORT = String(port);

      const result = await ensureDaemon({ timeoutMs: 1000 });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("lock was retained and no daemon was spawned");
      expect(lockOf(home)?.instance_id).toBe("gl-fake");
      expect(existsSync(logPath(home))).toBe(false);
    } finally {
      squatter.stop();
      if (savedHome === undefined) delete process.env.GLOSA_HOME;
      else process.env.GLOSA_HOME = savedHome;
      if (savedPort === undefined) delete process.env.GLOSA_PORT;
      else process.env.GLOSA_PORT = savedPort;
      cleanupHome(home);
    }
  });

  test("ownership changes restart stable evaluation and still permit only one spawn", async () => {
    const home = freshHome();
    const savedHome = process.env.GLOSA_HOME;
    const savedPort = process.env.GLOSA_PORT;
    const firstPort = randomPort();
    const replacementPort = randomPort();
    const stalePid = await deadPid();
    ensureHomeDir(home);
    writeLockExclusive(
      lockPath(home),
      sampleLock({ instance_id: "gl-first-observation", pid: stalePid, port: firstPort }),
    );

    let replacementTimer: ReturnType<typeof setTimeout> | undefined;
    let daemonPid: number | null = null;
    try {
      process.env.GLOSA_HOME = home;
      process.env.GLOSA_PORT = String(firstPort);
      replacementTimer = setTimeout(() => {
        reclaimStaleLock(
          lockPath(home),
          sampleLock({ instance_id: "gl-replacement-observation", pid: stalePid, port: replacementPort }),
        );
      }, 25);

      const started = performance.now();
      const result = await ensureDaemon({ timeoutMs: 3000 });
      const elapsed = performance.now() - started;

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.reason);
      daemonPid = result.pid;
      expect(result.port).toBe(replacementPort);
      expect(elapsed).toBeLessThan(3000);
      const servingLines = readFileSync(logPath(home), "utf8")
        .split("\n")
        .filter((line) => line.includes(" serving 127.0.0.1:"));
      expect(servingLines).toHaveLength(1);
    } finally {
      if (replacementTimer) clearTimeout(replacementTimer);
      if (daemonPid !== null) {
        try {
          process.kill(daemonPid, "SIGTERM");
        } catch {
          // already stopped
        }
        await waitUntil(() => lockOf(home) === null, 5000);
      }
      if (savedHome === undefined) delete process.env.GLOSA_HOME;
      else process.env.GLOSA_HOME = savedHome;
      if (savedPort === undefined) delete process.env.GLOSA_PORT;
      else process.env.GLOSA_PORT = savedPort;
      cleanupHome(home);
    }
  }, 8000);

  test("an older lockless daemon remains fail-closed with exact manual recovery guidance", async () => {
    const home = freshHome();
    const savedHome = process.env.GLOSA_HOME;
    const savedPort = process.env.GLOSA_PORT;
    const port = randomPort();
    const daemon = spawnVersionedDaemon(home, port);
    try {
      const handshake = await waitForHandshake(port);
      expect(handshake?.build_id).toBeUndefined();
      unlinkSync(lockPath(home));
      process.env.GLOSA_HOME = home;
      process.env.GLOSA_PORT = String(port);

      const result = await ensureDaemon();

      expect(result).toMatchObject({ ok: false });
      if (result.ok) throw new Error("expected an old lockless daemon to fail closed");
      expect(result.reason).toContain("daemon build cannot self-repair");
      expect(result.reason).toContain(`lsof -nP -iTCP:${port} -sTCP:LISTEN`);
      expect(result.reason).toContain(`kill -TERM ${handshake!.pid}`);
      expect(lockOf(home)).toBeNull();
      expect((await waitForHandshake(port, 1000))?.instance_id).toBe(handshake!.instance_id);
    } finally {
      await stopDaemon(home, daemon);
      if (savedHome === undefined) delete process.env.GLOSA_HOME;
      else process.env.GLOSA_HOME = savedHome;
      if (savedPort === undefined) delete process.env.GLOSA_PORT;
      else process.env.GLOSA_PORT = savedPort;
      cleanupHome(home);
    }
  }, 12000);

  test("fails closed when an answering daemon has an unparseable lock", async () => {
    const home = freshHome();
    const savedHome = process.env.GLOSA_HOME;
    const savedPort = process.env.GLOSA_PORT;
    const port = randomPort();
    const daemon = spawnDaemon(home, port);
    try {
      expect(await waitForHandshake(port)).not.toBeNull();
      writeUnparseableLock(home);
      process.env.GLOSA_HOME = home;
      process.env.GLOSA_PORT = String(port);

      const result = await ensureDaemon();

      expect(result).toMatchObject({ ok: false });
      if (!result.ok) expect(result.reason).toContain("unusable lock");
    } finally {
      await stopDaemon(home, daemon);
      if (savedHome === undefined) delete process.env.GLOSA_HOME;
      else process.env.GLOSA_HOME = savedHome;
      if (savedPort === undefined) delete process.env.GLOSA_PORT;
      else process.env.GLOSA_PORT = savedPort;
      cleanupHome(home);
    }
  }, 12000);

  test("a newer protocol-compatible daemon is reused without being signalled", async () => {
    const home = freshHome();
    const savedHome = process.env.GLOSA_HOME;
    const savedPort = process.env.GLOSA_PORT;
    const port = randomPort();
    const newerBuild = "0.2.0-0123456789abcdef";
    const daemon = spawnVersionedDaemon(home, port, newerBuild);
    try {
      expect((await waitForHandshake(port))?.build_id).toBe(newerBuild);
      process.env.GLOSA_HOME = home;
      process.env.GLOSA_PORT = String(port);

      const result = await ensureDaemon();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.pid).toBe(daemon.pid);
        expect(result.buildId).toBe(newerBuild);
      }
      expect(lockOf(home)?.pid).toBe(daemon.pid);
    } finally {
      await stopDaemon(home, daemon);
      if (savedHome === undefined) delete process.env.GLOSA_HOME;
      else process.env.GLOSA_HOME = savedHome;
      if (savedPort === undefined) delete process.env.GLOSA_PORT;
      else process.env.GLOSA_PORT = savedPort;
      cleanupHome(home);
    }
  }, 12000);

  test("concurrent clients replacing a same-semver divergent daemon converge on one instance", async () => {
    const home = freshHome();
    const savedHome = process.env.GLOSA_HOME;
    const savedPort = process.env.GLOSA_PORT;
    const port = randomPort();
    const divergentBuild = `${APP_VERSION}-${BUILD_ID.endsWith("0000000000000000") ? "1111111111111111" : "0000000000000000"}`;
    const daemon = spawnVersionedDaemon(home, port, divergentBuild);
    let replacementPid: number | null = null;
    try {
      expect((await waitForHandshake(port))?.build_id).toBe(divergentBuild);
      process.env.GLOSA_HOME = home;
      process.env.GLOSA_PORT = String(port);

      const results = await Promise.all([ensureDaemon(), ensureDaemon()]);
      expect(results.every((result) => result.ok)).toBe(true);
      if (results[0]?.ok && results[1]?.ok) {
        replacementPid = results[0].pid;
        expect(results[0].instanceId).toBe(results[1].instanceId);
        expect(results[0].pid).toBe(results[1].pid);
        expect(results[0].buildId).toBe(BUILD_ID);
      }
      expect(replacementPid).not.toBeNull();
      expect(lockOf(home)?.pid).toBe(replacementPid ?? undefined);
      expect(await daemon.exited).toBe(0);
    } finally {
      const pid = replacementPid;
      if (typeof pid === "number") {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // already stopped
        }
        await waitUntil(() => lockOf(home) === null, 5000);
      }
      try {
        daemon.kill("SIGKILL");
      } catch {
        // already stopped
      }
      if (savedHome === undefined) delete process.env.GLOSA_HOME;
      else process.env.GLOSA_HOME = savedHome;
      if (savedPort === undefined) delete process.env.GLOSA_PORT;
      else process.env.GLOSA_PORT = savedPort;
      cleanupHome(home);
    }
  }, 25000);

  test("a same-semver divergent daemon from ANOTHER install is refused, never signalled", async () => {
    // The regression this whole rule exists for: a source checkout and a release install of the
    // same version each read the other as "different build" and SIGTERM it, forever. The daemon
    // here is byte-divergent exactly like the convergence test above — the ONLY difference is that
    // it belongs to someone else, and that alone must flip takeover into refusal.
    const home = freshHome();
    const savedHome = process.env.GLOSA_HOME;
    const savedPort = process.env.GLOSA_PORT;
    const port = randomPort();
    const divergentBuild = `${APP_VERSION}-${BUILD_ID.endsWith("0000000000000000") ? "1111111111111111" : "0000000000000000"}`;
    const daemon = spawnVersionedDaemon(home, port, divergentBuild, {
      GLOSA_FIXTURE_INSTALL_ID: "ffffffffffffffff",
    });
    try {
      expect((await waitForHandshake(port))?.build_id).toBe(divergentBuild);
      process.env.GLOSA_HOME = home;
      process.env.GLOSA_PORT = String(port);

      const result = await ensureDaemon();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("different glosa install");
        // Refusing is only useful if the user is told how to proceed by hand.
        expect(result.reason).toContain(`kill -TERM ${daemon.pid}`);
        expect(result.logPath).toBe(logPath(home));
      }
      // The load-bearing assertion: still running, still the lock owner. Nothing was signalled.
      expect(daemon.exitCode).toBeNull();
      expect(lockOf(home)?.pid).toBe(daemon.pid);
    } finally {
      await stopDaemon(home, daemon);
      if (savedHome === undefined) delete process.env.GLOSA_HOME;
      else process.env.GLOSA_HOME = savedHome;
      if (savedPort === undefined) delete process.env.GLOSA_PORT;
      else process.env.GLOSA_PORT = savedPort;
      cleanupHome(home);
    }
  }, 15000);

  test("retries when a replacement changes ownership between the lock read and handshake", async () => {
    const home = freshHome();
    const savedHome = process.env.GLOSA_HOME;
    const savedPort = process.env.GLOSA_PORT;
    const port = randomPort();
    const divergentBuild = `${APP_VERSION}-${BUILD_ID.endsWith("0000000000000000") ? "1111111111111111" : "0000000000000000"}`;
    const daemon = spawnVersionedDaemon(home, port, divergentBuild);
    const realFetch = globalThis.fetch;
    let releaseDelayedHandshake!: () => void;
    const delayedHandshake = new Promise<void>((resolve) => {
      releaseDelayedHandshake = resolve;
    });
    let notifyDelayedHandshake!: () => void;
    const delayedHandshakeObserved = new Promise<void>((resolve) => {
      notifyDelayedHandshake = resolve;
    });
    let intercepted = false;
    let replacementPid: number | null = null;
    try {
      expect((await waitForHandshake(port))?.build_id).toBe(divergentBuild);
      process.env.GLOSA_HOME = home;
      process.env.GLOSA_PORT = String(port);
      globalThis.fetch = ((input, init) => {
        if (!intercepted && String(input) === `http://127.0.0.1:${port}/api/handshake`) {
          intercepted = true;
          notifyDelayedHandshake();
          return delayedHandshake.then(() => realFetch(input, init));
        }
        return realFetch(input, init);
      }) as typeof fetch;

      const delayedClient = ensureDaemon();
      await delayedHandshakeObserved;
      const replacementClient = ensureDaemon();
      expect(await waitForFile(lockPath(home), () => lockOf(home)?.build_id === BUILD_ID)).toBe(true);
      releaseDelayedHandshake();

      const results = await Promise.all([delayedClient, replacementClient]);
      expect(results.every((result) => result.ok)).toBe(true);
      if (results[0]?.ok && results[1]?.ok) {
        replacementPid = results[0].pid;
        expect(results[0].instanceId).toBe(results[1].instanceId);
        expect(results[0].pid).toBe(results[1].pid);
      }
    } finally {
      globalThis.fetch = realFetch;
      const pid = replacementPid;
      if (typeof pid === "number") {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // already stopped
        }
        await waitUntil(() => lockOf(home) === null, 5000);
      }
      try {
        daemon.kill("SIGKILL");
      } catch {
        // already stopped
      }
      if (savedHome === undefined) delete process.env.GLOSA_HOME;
      else process.env.GLOSA_HOME = savedHome;
      if (savedPort === undefined) delete process.env.GLOSA_PORT;
      else process.env.GLOSA_PORT = savedPort;
      cleanupHome(home);
    }
  }, 25000);

  test("port authority: reads lock.port, not GLOSA_PORT, when they differ", async () => {
    const home = freshHome();
    const savedHome = process.env.GLOSA_HOME;
    const savedPort = process.env.GLOSA_PORT;
    const lockPort = randomPort();
    const envPort = randomPort();
    const daemonProc = spawnDaemon(home, lockPort);
    try {
      const hs = await waitForHandshake(lockPort);
      assertDefined(hs, "handshake");
      expect(lockOf(home)?.port).toBe(lockPort);

      process.env.GLOSA_HOME = home;
      process.env.GLOSA_PORT = String(envPort); // deliberately wrong — lock.port must win

      const result = await ensureDaemon();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.port).toBe(lockPort);
        expect(result.instanceId).toBe(hs.instance_id);
      }
    } finally {
      await stopDaemon(home, daemonProc);
      if (savedHome === undefined) delete process.env.GLOSA_HOME;
      else process.env.GLOSA_HOME = savedHome;
      if (savedPort === undefined) delete process.env.GLOSA_PORT;
      else process.env.GLOSA_PORT = savedPort;
      cleanupHome(home);
    }
    // Timeout bumped from 10s: worst case here is waitForHandshake's own 5s deadline plus
    // stopDaemon's up-to-6s teardown budget (3s exit wait + 3s lock-gone poll) — ~11s, tighter
    // than the 10s test timeout allowed once this runs right after the bootDaemon describe
    // block's ~7 real subprocess spawns/kills (observed: this test is reliably fast in
    // isolation but intermittently exceeds its old budget after that prior subprocess churn).
  }, 20000);

  test("stale lock: alive-but-foreign-port (nothing listening) is reclaimed on lock.port, ignoring GLOSA_PORT", async () => {
    const home = freshHome();
    const savedHome = process.env.GLOSA_HOME;
    const savedPort = process.env.GLOSA_PORT;
    ensureHomeDir(home);
    const staleLockPort = randomPort(); // nothing listening here — genuinely stale
    const wrongSeedPort = randomPort(); // must be ignored: lock.port is authoritative once a lock exists
    writeLockExclusive(lockPath(home), sampleLock({ pid: process.pid, port: staleLockPort }));

    process.env.GLOSA_HOME = home;
    process.env.GLOSA_PORT = String(wrongSeedPort);

    try {
      const result = await ensureDaemon();
      try {
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.port).toBe(staleLockPort);
          expect(result.port).not.toBe(wrongSeedPort);
          expect(result.instanceId).not.toBe("gl-fake");
        }
      } finally {
        if (result.ok) {
          try {
            process.kill(result.pid, "SIGTERM");
          } catch {
            // already dead
          }
          await waitUntil(() => lockOf(home) === null);
        }
      }
    } finally {
      if (savedHome === undefined) delete process.env.GLOSA_HOME;
      else process.env.GLOSA_HOME = savedHome;
      if (savedPort === undefined) delete process.env.GLOSA_PORT;
      else process.env.GLOSA_PORT = savedPort;
      cleanupHome(home);
    }
  }, 12000);

  test("fail-closed: alive pid + port bound by a non-glosa squatter refuses to spawn a duplicate", async () => {
    const home = freshHome();
    const savedHome = process.env.GLOSA_HOME;
    const savedPort = process.env.GLOSA_PORT;
    ensureHomeDir(home);
    const port = randomPort();
    // Something is genuinely listening on lock.port, but it never answers the glosa handshake —
    // e.g. a hung daemon or an unrelated process. This must NOT be treated the same as a free
    // port: unlinking the lock and spawning here would leave two live daemons (R1 violation).
    const squatter = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch: () => Response.json({ not: "a glosa handshake" }),
    });
    writeLockExclusive(lockPath(home), sampleLock({ pid: process.pid, port })); // pid alive (it's us)

    try {
      process.env.GLOSA_HOME = home;
      process.env.GLOSA_PORT = String(port);

      const result = await ensureDaemon();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain(String(port));
        expect(result.reason.toLowerCase()).toContain("not spawning a duplicate");
        expect(result.logPath).toBe(logPath(home));
      }

      // The lock must survive untouched — no reclaim happened.
      const lock = lockOf(home);
      expect(lock).not.toBeNull();
      expect(lock!.instance_id).toBe("gl-fake");

      // And nothing else is now serving a real glosa handshake on this port — the squatter's
      // stub response is still all that's there.
      const res = await fetch(`http://127.0.0.1:${port}/api/handshake`);
      const body = await res.json();
      expect(body).toEqual({ not: "a glosa handshake" });
    } finally {
      squatter.stop();
      if (savedHome === undefined) delete process.env.GLOSA_HOME;
      else process.env.GLOSA_HOME = savedHome;
      if (savedPort === undefined) delete process.env.GLOSA_PORT;
      else process.env.GLOSA_PORT = savedPort;
      cleanupHome(home);
    }
  }, 20000);

  test("newer daemon + protocol mismatch FAILs without attempting a downgrade", async () => {
    const home = freshHome();
    const savedHome = process.env.GLOSA_HOME;
    const savedPort = process.env.GLOSA_PORT;
    const fakePort = randomPort();
    const fakeServer = Bun.serve({
      hostname: "127.0.0.1",
      port: fakePort,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/handshake") {
          return Response.json({
            protocol_version: "99.0", // major mismatch vs this client's PROTOCOL_VERSION
            instance_id: "gl-future",
            build_id: "0.2.0-0000000000000000",
            pid: process.pid,
            started_at: new Date().toISOString(),
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    ensureHomeDir(home);
    writeLockExclusive(
      lockPath(home),
      sampleLock({
        instance_id: "gl-future",
        pid: process.pid,
        port: fakePort,
        protocol_version: "99.0",
        build_id: "0.2.0-0000000000000000",
      }),
    );

    try {
      process.env.GLOSA_HOME = home;
      process.env.GLOSA_PORT = String(fakePort);

      const result = await ensureDaemon();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("incompatible glosa versions installed");
        expect(result.reason).toContain("99.0");
      }
      expect(fakeServer.pendingRequests).toBe(0);
    } finally {
      fakeServer.stop();
      if (savedHome === undefined) delete process.env.GLOSA_HOME;
      else process.env.GLOSA_HOME = savedHome;
      if (savedPort === undefined) delete process.env.GLOSA_PORT;
      else process.env.GLOSA_PORT = savedPort;
      cleanupHome(home);
    }
  }, 10000);

  test("malformed lock identity fails closed without signalling, unlinking, or spawning", async () => {
    const home = freshHome();
    const savedHome = process.env.GLOSA_HOME;
    const savedPort = process.env.GLOSA_PORT;
    const port = randomPort();
    const daemon = spawnVersionedDaemon(home, port, BUILD_ID);
    try {
      expect(await waitForHandshake(port)).not.toBeNull();
      const raw = JSON.parse(readFileSync(lockPath(home), "utf8"));
      raw.build_id = 42;
      await Bun.write(lockPath(home), JSON.stringify(raw));
      process.env.GLOSA_HOME = home;
      process.env.GLOSA_PORT = String(port);

      const result = await ensureDaemon();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("invalid daemon lock build identity");
      expect(existsSync(lockPath(home))).toBe(true);
      expect((await waitForHandshake(port, 1000))?.pid).toBe(daemon.pid);
    } finally {
      try {
        daemon.kill("SIGTERM");
      } catch {
        // already stopped
      }
      await Promise.race([daemon.exited, Bun.sleep(3000)]);
      if (savedHome === undefined) delete process.env.GLOSA_HOME;
      else process.env.GLOSA_HOME = savedHome;
      if (savedPort === undefined) delete process.env.GLOSA_PORT;
      else process.env.GLOSA_PORT = savedPort;
      cleanupHome(home);
    }
  }, 10000);

  test("foreign squatter: a bound port fails closed without spawning a daemon contender", async () => {
    const home = freshHome();
    const savedHome = process.env.GLOSA_HOME;
    const savedPort = process.env.GLOSA_PORT;
    const port = randomPort();
    // Occupy the port with a non-glosa server. Stable occupancy is enough to refuse the spawn;
    // the bootDaemon test above independently preserves EADDRINUSE's terminal child behavior.
    const squatter = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch: () => Response.json({ not: "a glosa handshake" }),
    });

    try {
      process.env.GLOSA_HOME = home;
      process.env.GLOSA_PORT = String(port);

      const started = Date.now();
      const result = await ensureDaemon({ timeoutMs: 6000 });
      const elapsed = Date.now() - started;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.logPath).toBe(logPath(home));
        expect(result.reason).toContain(String(port));
        expect(result.reason).toContain(logPath(home));
        expect(result.reason.toLowerCase()).toContain("no daemon was spawned");
        expect(existsSync(result.logPath!)).toBe(false);
      }
      expect(elapsed).toBeLessThan(6500);
    } finally {
      squatter.stop();
      if (savedHome === undefined) delete process.env.GLOSA_HOME;
      else process.env.GLOSA_HOME = savedHome;
      if (savedPort === undefined) delete process.env.GLOSA_PORT;
      else process.env.GLOSA_PORT = savedPort;
      cleanupHome(home);
    }
  }, 15000);
});

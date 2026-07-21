// SPDX-License-Identifier: Apache-2.0
// P1.2 daemon lifecycle — real fault/concurrency tests (A5 §F13). Every test gets its own tmp
// GLOSA_HOME + a random high port (via helpers.ts) so parallel runs never collide on port/home,
// and nothing here ever touches a real `~/.glosa`. The bootDaemon-side cases spawn the actual
// `glosa __daemon` subprocess — that's the point, per the task brief: these are fault-injection
// and race scenarios a happy-path unit test can't exercise.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ensureHomeDir, lockPath, logPath } from "../src/home.ts";
import { reclaimStaleLock, writeLockExclusive, type DaemonLock } from "../src/lock.ts";
import { PROTOCOL_VERSION } from "../src/protocol.ts";
import { APP_VERSION, BUILD_ID } from "../src/build-id.ts";
import { ensureDaemon } from "../src/lifecycle.ts";
import {
  cleanupHome,
  deadPid,
  freshHome,
  lockOf,
  randomPort,
  spawnDaemon,
  stopDaemon,
  waitForHandshake,
  waitUntil,
  writeUnparseableLock,
} from "./helpers.ts";

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
): Bun.Subprocess<"ignore", "pipe", "pipe"> {
  return Bun.spawn({
    cmd: [process.execPath, VERSIONED_DAEMON_FIXTURE],
    env: {
      ...Bun.env,
      GLOSA_HOME: home,
      GLOSA_PORT: String(port),
      ...(buildId === undefined ? {} : { GLOSA_FIXTURE_BUILD_ID: buildId }),
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
      expect(hs).not.toBeNull();

      const lock = lockOf(home);
      expect(lock).not.toBeNull();
      expect(lock!.instance_id).toBe(hs!.instance_id);

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
      expect(await waitUntil(() => lockOf(home)?.pid === proc.pid)).toBe(true);
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
      expect(lockOf(home)).toBeNull();
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
      expect(hs).not.toBeNull();

      proc.kill("SIGINT");
      await Bun.sleep(300);
      proc.kill("SIGHUP");
      await Bun.sleep(300);

      const stillAlive = await Promise.race([proc.exited.then(() => false), Bun.sleep(200).then(() => true)]);
      expect(stillAlive).toBe(true);

      const hs2 = await waitForHandshake(port, 1000);
      expect(hs2?.instance_id).toBe(hs!.instance_id);
      expect(lockOf(home)?.instance_id).toBe(hs!.instance_id);
    } finally {
      await stopDaemon(home, proc);
    }
  }, 10000);
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

  test("port authority: reads lock.port, not GLOSA_PORT, when they differ", async () => {
    const home = freshHome();
    const savedHome = process.env.GLOSA_HOME;
    const savedPort = process.env.GLOSA_PORT;
    const lockPort = randomPort();
    const envPort = randomPort();
    const daemonProc = spawnDaemon(home, lockPort);
    try {
      const hs = await waitForHandshake(lockPort);
      expect(hs).not.toBeNull();
      expect(lockOf(home)?.port).toBe(lockPort);

      process.env.GLOSA_HOME = home;
      process.env.GLOSA_PORT = String(envPort); // deliberately wrong — lock.port must win

      const result = await ensureDaemon();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.port).toBe(lockPort);
        expect(result.instanceId).toBe(hs!.instance_id);
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

  test("handshake-poll timeout: fails referencing the daemon.log path", async () => {
    const home = freshHome();
    const savedHome = process.env.GLOSA_HOME;
    const savedPort = process.env.GLOSA_PORT;
    const port = randomPort();
    // Occupy the port with a non-glosa server so the spawned daemon can never bind it, and so
    // polling never sees a valid handshake shape — this forces the full poll deadline.
    const squatter = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch: () => Response.json({ not: "a glosa handshake" }),
    });

    try {
      process.env.GLOSA_HOME = home;
      process.env.GLOSA_PORT = String(port);

      const result = await ensureDaemon();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.logPath).toBe(logPath(home));
        expect(existsSync(result.logPath!)).toBe(true);
        const log = readFileSync(result.logPath!, "utf8");
        expect(log.length).toBeGreaterThan(0);
      }
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

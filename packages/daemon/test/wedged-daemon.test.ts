// SPDX-License-Identifier: Apache-2.0
// Issue #139 regression: a daemon whose event loop has stopped keeps its listening socket but
// stops accepting. Discovery used to read that state as an ordinary refused connection, delete the
// live daemon's ownership record, and then fail to bind the port it had just declared free —
// leaving every glosa client on the machine down with no documented way back.
//
// Two layers, because the state has two halves that are cheap to prove separately and expensive to
// prove together:
//   1. against a REAL non-accepting process, `bind(2)` still reports the port as taken;
//   2. given a refused connect (what a saturated accept queue produces), the confirmation must
//      still answer "bound".
// Saturating a real accept queue takes ~128 abandoned connections and would buy nothing the two
// layers do not already establish.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILD_ID } from "../src/lifecycle/build-id.ts";
import { confirmPortFree } from "../src/lifecycle/daemon.ts";
import { diagnoseDaemon } from "../src/lifecycle/diagnose.ts";
import { probePortBindable, probePortBound } from "../src/lifecycle/handshake.ts";
import { logPath, lockPath } from "../src/lifecycle/home.ts";
import { INSTALL_ID } from "../src/lifecycle/install.ts";
import { writeLockExclusive } from "../src/lifecycle/lock.ts";
import { PROTOCOL_VERSION } from "../src/lifecycle/protocol.ts";
import { DEFAULT_STALL_WATCHDOG_MS, resolveStallMs } from "../src/lifecycle/stall-watchdog.ts";
import { cleanupHome, deadPid, freshHome, randomPort, waitUntil } from "./helpers.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/wedged-daemon.ts", import.meta.url));
const STALL_FIXTURE = fileURLToPath(new URL("./fixtures/stalling-daemon.ts", import.meta.url));

let running: Bun.Subprocess<"ignore", "ignore", "ignore"> | null = null;

afterEach(() => {
  // SIGKILL, deliberately: a wedged process cannot run a SIGTERM handler, which is the whole point
  // of the fixture.
  if (running?.exitCode === null) running.kill("SIGKILL");
  running = null;
});

/** Starts the fixture, waits for it to serve, then wedges it and waits for it to stop answering. */
async function startWedgedDaemon(port: number): Promise<Bun.Subprocess<"ignore", "ignore", "ignore">> {
  const child = Bun.spawn({
    cmd: [process.execPath, FIXTURE, String(port)],
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  running = child;

  if (!(await pollReady(port))) throw new Error(`wedged-daemon fixture never served on ${port}`);

  await fetch(`http://127.0.0.1:${port}/wedge`, { signal: AbortSignal.timeout(2000) }).catch(() => {});
  const wedged = await pollUntilSilent(port);
  if (!wedged) throw new Error(`wedged-daemon fixture on ${port} kept answering`);
  return child;
}

async function pollReady(port: number): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const ok = await fetch(`http://127.0.0.1:${port}/ready`)
      .then((res) => res.ok)
      .catch(() => false);
    if (ok) return true;
    await Bun.sleep(50);
  }
  return false;
}

function exitedWithin(child: Bun.Subprocess, timeoutMs: number): Promise<boolean> {
  return Promise.race([child.exited.then(() => true), Bun.sleep(timeoutMs).then(() => false)]);
}

async function pollUntilSilent(port: number): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 250);
    const answered = await fetch(`http://127.0.0.1:${port}/ready`, { signal: controller.signal })
      .then(() => true)
      .catch(() => false);
    clearTimeout(timer);
    if (!answered) return true;
    await Bun.sleep(50);
  }
  return false;
}

describe("a daemon whose event loop has stopped (issue #139)", () => {
  test("still holds the port: it answers nothing, and nothing else can bind it", async () => {
    const port = randomPort();
    await startWedgedDaemon(port);

    // The two facts a client has to reconcile, from the report itself: `lsof` shows a live process
    // LISTENing, and the handshake never comes back.
    expect(await probePortBindable(port)).toBe(false);
    const handshake = await fetch(`http://127.0.0.1:${port}/api/handshake`, {
      signal: AbortSignal.timeout(500),
    })
      .then(() => true)
      .catch(() => false);
    expect(handshake).toBe(false);
  }, 20_000);

  test("a refused connect does not make its port free", async () => {
    const port = randomPort();
    await startWedgedDaemon(port);

    // `probe` returns false the way the real `probePortBound` does once the accept queue is full:
    // the kernel answers connects with RST while the socket is still LISTENing. Three of those
    // used to be the whole proof a client needed before unlinking an ownership record.
    const result = await confirmPortFree(port, {
      deadline: performance.now() + 5000,
      ownershipUnchanged: () => true,
      probe: async () => false,
      sleep: async () => {},
    });

    expect(result).toBe("bound");
  }, 20_000);

  test("SIGTERM cannot stop it and SIGKILL can — which is why the recovery hint names both", async () => {
    const port = randomPort();
    const child = await startWedgedDaemon(port);

    child.kill("SIGTERM");
    expect(await exitedWithin(child, 1500)).toBe(false);
    expect(await probePortBound(port, 500)).toBe(true);

    child.kill("SIGKILL");
    expect(await exitedWithin(child, 3000)).toBe(true);
    // And the port is genuinely free now, so the next client's replacement can bind it.
    expect(await probePortBindable(port)).toBe(true);
  }, 20_000);
});

describe("naming the state for a user (issue #139)", () => {
  test("diagnoseDaemon calls a live non-answering owner wedged, not a stale lock", async () => {
    const home = freshHome();
    const port = randomPort();
    const child = await startWedgedDaemon(port);
    writeLockExclusive(lockPath(home), {
      instance_id: "gl-wedged",
      pid: child.pid,
      port,
      protocol_version: PROTOCOL_VERSION,
      build_id: BUILD_ID,
      install_id: INSTALL_ID,
      started_at: new Date().toISOString(),
      host: "127.0.0.1",
      bun: Bun.version,
    });

    try {
      const diagnosis = await diagnoseDaemon(home, port);
      expect(diagnosis.kind).toBe("wedged");
      expect(diagnosis.pid).toBe(child.pid);
      // The recovery a user can actually perform, which is the whole point of naming the state.
      expect(diagnosis.detail).toContain(`kill -9 ${child.pid}`);
    } finally {
      cleanupHome(home);
    }
  }, 20_000);

  test("diagnoseDaemon calls a free port with a leftover record a stale lock", async () => {
    const home = freshHome();
    const port = randomPort();
    writeLockExclusive(lockPath(home), {
      instance_id: "gl-stale",
      pid: await deadPid(),
      port,
      protocol_version: PROTOCOL_VERSION,
      build_id: BUILD_ID,
      install_id: INSTALL_ID,
      started_at: new Date().toISOString(),
      host: "127.0.0.1",
      bun: Bun.version,
    });

    try {
      const diagnosis = await diagnoseDaemon(home, port);
      expect(diagnosis.kind).toBe("stale-lock");
    } finally {
      cleanupHome(home);
    }
  }, 20_000);
});

describe("the stall watchdog (issue #139)", () => {
  test("releases the ownership lock and kills a daemon whose loop has stopped", async () => {
    const home = freshHome();
    const instanceId = "gl-stall-fixture";
    const child = Bun.spawn({
      cmd: [process.execPath, STALL_FIXTURE, home, instanceId, "600"],
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    running = child;

    try {
      expect(await waitUntil(() => existsSync(lockPath(home)), 3000)).toBe(true);
      expect(await waitUntil(() => existsSync(join(home, "wedged.marker")), 3000)).toBe(true);

      // The recovery a human had to perform by hand: SIGTERM does nothing, because the handler the
      // fixture installed lives on the thread that stopped.
      child.kill("SIGTERM");
      expect(await exitedWithin(child, 400)).toBe(false);

      expect(await exitedWithin(child, 8000)).toBe(true);
      expect(child.signalCode).toBe("SIGKILL");
      // Released BEFORE the kill, so the next client meets a free port and no ownership record
      // rather than a lock naming a PID that has just vanished.
      expect(existsSync(lockPath(home))).toBe(false);
      expect(readFileSync(logPath(home), "utf8")).toContain("event loop has not run");
    } finally {
      cleanupHome(home);
    }
  }, 20_000);

  test("an unparseable threshold falls back to the default instead of disabling the watchdog", () => {
    expect(resolveStallMs(undefined)).toBe(DEFAULT_STALL_WATCHDOG_MS);
    expect(resolveStallMs("not-a-number")).toBe(DEFAULT_STALL_WATCHDOG_MS);
    expect(resolveStallMs("-1")).toBe(DEFAULT_STALL_WATCHDOG_MS);
    expect(resolveStallMs("1500")).toBe(1500);
    expect(resolveStallMs("0")).toBe(0);
  });
});

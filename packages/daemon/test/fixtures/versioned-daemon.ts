// SPDX-License-Identifier: Apache-2.0
// Test-only daemon peer with selectable identity. It exercises ensureDaemon's real lock,
// handshake, signal, and replacement paths without importing the production lifecycle.
import { chmodSync, existsSync } from "node:fs";
import { apiSocketPath, ensureHomeDir, ensureRunDir, lockPath } from "../../src/lifecycle/home.ts";
import { INSTALL_ID } from "../../src/lifecycle/install.ts";
import { type DaemonLock, removeLockIfOwned, writeLockExclusive } from "../../src/lifecycle/lock.ts";

const home = ensureHomeDir(Bun.env.GLOSA_HOME as string);
const port = Number(Bun.env.GLOSA_PORT);
const instanceId = Bun.env.GLOSA_FIXTURE_INSTANCE ?? "gl-versioned-fixture";
const protocolVersion = Bun.env.GLOSA_FIXTURE_PROTOCOL ?? "1.0";
const buildId = Bun.env.GLOSA_FIXTURE_BUILD_ID;
// Defaults to the REAL install id: this fixture genuinely runs out of this checkout, so
// presenting itself as the same install is honest, not a fudge. Tests that need the
// cross-install refusal set a foreign value explicitly.
const installId = Bun.env.GLOSA_FIXTURE_INSTALL_ID ?? INSTALL_ID;
const startedAt = new Date().toISOString();
const repairIntervalMs = Number(Bun.env.GLOSA_FIXTURE_REPAIR_INTERVAL_MS ?? 0);
const slowHandshakeAfter = Number(Bun.env.GLOSA_FIXTURE_SLOW_HANDSHAKE_AFTER ?? -1);
const slowHandshakeCount = Number(Bun.env.GLOSA_FIXTURE_SLOW_HANDSHAKE_COUNT ?? 0);
const handshakeDelayMs = Number(Bun.env.GLOSA_FIXTURE_HANDSHAKE_DELAY_MS ?? 0);
// Defaults to serving one, because the peers this fixture stands in for are ones `ensureDaemon`
// is expected to REUSE, and a reused daemon a client cannot actually talk to is not a peer. Set
// this to "" to play a daemon that predates the socket listener (A3 §3.2) and must be refused.
const servesSocket = (Bun.env.GLOSA_FIXTURE_SERVES_SOCKET ?? "1") !== "";

const record: DaemonLock = {
  instance_id: instanceId,
  pid: process.pid,
  port,
  protocol_version: protocolVersion,
  ...(buildId === undefined ? {} : { build_id: buildId }),
  ...(installId === "" ? {} : { install_id: installId }),
  started_at: startedAt,
  host: "127.0.0.1",
  bun: Bun.version,
};

let handshakeRequests = 0;

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(req) {
    if (new URL(req.url).pathname !== "/api/handshake") return new Response("not found", { status: 404 });
    const requestIndex = handshakeRequests;
    handshakeRequests += 1;
    if (
      requestIndex >= slowHandshakeAfter &&
      requestIndex < slowHandshakeAfter + slowHandshakeCount &&
      handshakeDelayMs > 0
    ) {
      await Bun.sleep(handshakeDelayMs);
    }
    return Response.json({
      protocol_version: protocolVersion,
      ...(buildId === undefined ? {} : { build_id: buildId }),
      ...(installId === "" ? {} : { install_id: installId }),
      instance_id: instanceId,
      pid: process.pid,
      started_at: startedAt,
      ...(servesSocket ? { serves_socket: true } : {}),
    });
  },
});

/** A real socket, not just the claim of one — the same bind, chmod and run-dir mode production
 * uses, so a test that asserts a peer is reusable is asserting something a client could use. */
const socketServer = servesSocket
  ? (() => {
      ensureRunDir(home);
      const path = apiSocketPath(home);
      const bound = Bun.serve({ unix: path, fetch: () => new Response("{}", { status: 200 }) });
      chmodSync(path, 0o600);
      return bound;
    })()
  : null;

const lockFile = lockPath(home);
writeLockExclusive(lockFile, record);

let mayRepairLock = repairIntervalMs > 0;
const repairTimer =
  repairIntervalMs > 0
    ? setInterval(() => {
        if (!mayRepairLock || existsSync(lockFile)) return;
        try {
          writeLockExclusive(lockFile, record);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }, repairIntervalMs)
    : null;
repairTimer?.unref();

// Holds open the state A3 §3.2 calls the shutdown window: TCP listener closed, so the port is
// free for anyone to bind, while this process stays alive and its lock stays on disk and correct.
// A real daemon passes through exactly this for up to SHUTDOWN_HARD_EXIT_MS on every ordinary
// shutdown; racing that window in a test is flaky, so the fixture stops there and waits instead.
// The Unix socket deliberately stays up: the point of the test this serves is that a client keeps
// working over the socket while an impostor holds the port.
//
// A polled file rather than a signal: Bun terminates on SIGUSR1 and SIGUSR2 even with a handler
// registered (verified), so a signal cannot express "drop the listener and keep living".
const dropTcpFile = `${home}/fixture-drop-tcp`;
const dropTcpTimer = setInterval(() => {
  if (!existsSync(dropTcpFile)) return;
  clearInterval(dropTcpTimer);
  void server.stop(false);
}, 25);
dropTcpTimer.unref();

let stopping = false;
process.on("SIGTERM", () => {
  if (stopping) return;
  stopping = true;
  mayRepairLock = false;
  if (repairTimer) clearInterval(repairTimer);
  void Promise.all([server.stop(false), socketServer?.stop(false)]).then(() => {
    removeLockIfOwned(lockFile, instanceId);
    process.exit(0);
  });
});

await new Promise<never>(() => {});

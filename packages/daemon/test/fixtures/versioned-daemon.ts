// SPDX-License-Identifier: Apache-2.0
// Test-only daemon peer with selectable identity. It exercises ensureDaemon's real lock,
// handshake, signal, and replacement paths without importing the production lifecycle.
import { existsSync } from "node:fs";
import { ensureHomeDir, lockPath } from "../../src/lifecycle/home.ts";
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
    });
  },
});

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

let stopping = false;
process.on("SIGTERM", () => {
  if (stopping) return;
  stopping = true;
  mayRepairLock = false;
  if (repairTimer) clearInterval(repairTimer);
  void server.stop(false).then(() => {
    removeLockIfOwned(lockFile, instanceId);
    process.exit(0);
  });
});

await new Promise<never>(() => {});

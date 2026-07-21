// SPDX-License-Identifier: Apache-2.0
// Test-only daemon peer with selectable identity. It exercises ensureDaemon's real lock,
// handshake, signal, and replacement paths without importing the production lifecycle.
import { ensureHomeDir, lockPath } from "../../src/home.ts";
import { removeLockIfOwned, writeLockExclusive, type DaemonLock } from "../../src/lock.ts";

const home = ensureHomeDir(Bun.env.GLOSA_HOME as string);
const port = Number(Bun.env.GLOSA_PORT);
const instanceId = Bun.env.GLOSA_FIXTURE_INSTANCE ?? "gl-versioned-fixture";
const protocolVersion = Bun.env.GLOSA_FIXTURE_PROTOCOL ?? "1.0";
const buildId = Bun.env.GLOSA_FIXTURE_BUILD_ID;
const startedAt = new Date().toISOString();

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(req) {
    if (new URL(req.url).pathname !== "/api/handshake") return new Response("not found", { status: 404 });
    return Response.json({
      protocol_version: protocolVersion,
      ...(buildId === undefined ? {} : { build_id: buildId }),
      instance_id: instanceId,
      pid: process.pid,
      started_at: startedAt,
    });
  },
});

const record: DaemonLock = {
  instance_id: instanceId,
  pid: process.pid,
  port,
  protocol_version: protocolVersion,
  ...(buildId === undefined ? {} : { build_id: buildId }),
  started_at: startedAt,
  host: "127.0.0.1",
  bun: Bun.version,
};
writeLockExclusive(lockPath(home), record);

let stopping = false;
process.on("SIGTERM", () => {
  if (stopping) return;
  stopping = true;
  void server.stop(false).then(() => {
    removeLockIfOwned(lockPath(home), instanceId);
    process.exit(0);
  });
});

await new Promise<never>(() => {});

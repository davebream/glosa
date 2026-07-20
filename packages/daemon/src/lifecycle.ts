// @glosa/daemon — F13 daemon lifecycle: the `glosa __daemon` boot body (bootDaemon) and the
// client-side "find or spawn" helper (ensureDaemon). See docs/appendices/A5-daemon-architecture.md
// §F13 and docs/requirements.md R1. Three roles, one binary: this module is used by the daemon
// role (bootDaemon, never imported by the SPA) and by every client role (ensureDaemon).
import { closeSync, openSync, unlinkSync, appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ensureHomeDir, glosaHome, lockPath, logPath } from "./home.ts";
import {
  isPidAlive,
  readLock,
  reclaimStaleLock,
  removeLockIfOwned,
  writeLockExclusive,
  type DaemonLock,
} from "./lock.ts";
import { fetchHandshake, pollHandshake, probePortBound, type HandshakeResponse } from "./handshake.ts";
import { PROTOCOL_VERSION, protocolCompatible } from "./protocol.ts";

const DEFAULT_PORT = 4646;
const HANDSHAKE_TIMEOUT_MS = 1000;
const HANDSHAKE_POLL_MS = 5000;

function log(home: string, line: string): void {
  try {
    appendFileSync(logPath(home), `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    // logging is best-effort; never let it crash boot or shutdown
  }
}

// ---------------------------------------------------------------------------------------------
// Daemon role: `glosa __daemon` body. Binds the port, wins (or loses) the lock CAS, serves the
// lifecycle handshake, and blocks forever — every exit happens via an explicit process.exit()
// call below, per A5 §F13's exit-code table. Never returns normally.
// ---------------------------------------------------------------------------------------------
export async function bootDaemon(): Promise<never> {
  const home = ensureHomeDir(glosaHome());
  const port = Number(Bun.env.GLOSA_PORT ?? DEFAULT_PORT);
  const lockFile = lockPath(home);
  const instanceId = `gl-${randomUUID()}`;
  const startedAt = new Date().toISOString();

  const server = await bindOrExit(home, port, instanceId, startedAt);

  const record: DaemonLock = {
    instance_id: instanceId,
    pid: process.pid,
    port,
    protocol_version: PROTOCOL_VERSION,
    started_at: startedAt,
    host: "127.0.0.1",
    bun: Bun.version,
  };
  await acquireLockOrExit(home, lockFile, record, server);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Sequential: stop accepting *before* touching the lock, so a future journal-fsync /
    // SSE-bye step (P2/P3) has a clean "no new work, then cleanup" ordering to slot into.
    await server.stop();
    removeLockIfOwned(lockFile, instanceId);
    log(home, `${instanceId} graceful shutdown complete`);
    process.exit(0);
  };
  process.on("SIGTERM", () => {
    void shutdown();
  });
  // Survive Ctrl-C in the terminal / the controlling terminal closing (A5 §F13) — the shim
  // dying must not take the daemon with it.
  process.on("SIGHUP", () => {});
  process.on("SIGINT", () => {});

  log(home, `${instanceId} serving 127.0.0.1:${port}`);
  return new Promise<never>(() => {
    // bootDaemon never resolves on the happy path; the process lives until a signal handler
    // (or one of the exit-code branches above) calls process.exit().
  });
}

async function bindOrExit(
  home: string,
  port: number,
  instanceId: string,
  startedAt: string,
): Promise<ReturnType<typeof Bun.serve>> {
  try {
    return Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/handshake" && req.method === "GET") {
          return Response.json({
            protocol_version: PROTOCOL_VERSION,
            instance_id: instanceId,
            pid: process.pid,
            started_at: startedAt,
          } satisfies HandshakeResponse);
        }
        return new Response("not found", { status: 404 });
      },
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
    // Someone else already holds the port. A live glosa peer answering the handshake there
    // is a benign race (two clients spawned a daemon at once, we lost) — exit clean. A
    // non-glosa process squatting the port is not — exit loud so the log has a trail.
    const peer = await fetchHandshake(port, HANDSHAKE_TIMEOUT_MS);
    if (peer) {
      log(home, `benign race: peer ${peer.instance_id} already serving 127.0.0.1:${port}`);
      process.exit(0);
    }
    log(home, `EADDRINUSE on 127.0.0.1:${port}, no glosa peer answering — foreign process`);
    process.exit(3);
  }
}

async function acquireLockOrExit(
  home: string,
  lockFile: string,
  record: DaemonLock,
  server: ReturnType<typeof Bun.serve>,
): Promise<void> {
  try {
    writeLockExclusive(lockFile, record);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }

  const existing = readLock(lockFile);
  const peer = existing ? await fetchHandshake(existing.port, HANDSHAKE_TIMEOUT_MS) : null;
  if (existing && peer && peer.instance_id === existing.instance_id) {
    log(home, `benign race: lock held by live peer ${existing.instance_id}`);
    await server.stop();
    process.exit(0);
  }

  log(home, "stale lock on create, reclaiming");
  try {
    reclaimStaleLock(lockFile, record);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    log(home, "lock reclaim retry failed, giving up");
    await server.stop();
    process.exit(4);
  }
}

// ---------------------------------------------------------------------------------------------
// Client role: every non-daemon entry point (CLI, MCP shim, hooks) calls this to get connection
// info, spawning a detached daemon if none is live. Never binds/locks anything itself.
// ---------------------------------------------------------------------------------------------
export interface DaemonConnection {
  port: number;
  instanceId: string;
  protocolVersion: string;
  pid: number;
  startedAt: string;
}

export type EnsureDaemonResult =
  | ({ ok: true } & DaemonConnection)
  | { ok: false; reason: string; logPath?: string };

export async function ensureDaemon(): Promise<EnsureDaemonResult> {
  const home = ensureHomeDir(glosaHome());
  const lockFile = lockPath(home);
  const seedPort = Number(Bun.env.GLOSA_PORT ?? DEFAULT_PORT);

  const lock = readLock(lockFile);
  if (!lock) return spawnAndWait(home, seedPort);

  if (isPidAlive(lock.pid)) {
    const hs = await pollHandshake(lock.port, HANDSHAKE_POLL_MS);
    if (hs) return toResult(lock.port, hs);

    // Alive pid, no valid handshake within the ≤5s budget: a hung glosa daemon and a foreign
    // squatter on lock.port are indistinguishable from here. Spawning a duplicate would
    // violate the R1 singleton invariant, so only proceed to reclaim when the port is
    // *provably free* — otherwise fail closed (mirrors bootDaemon's own
    // EADDRINUSE-foreign → exit 3 posture; A5 §F13's "PID reuse" stale case is specifically
    // the free-port case, not this one).
    if (await probePortBound(lock.port, HANDSHAKE_TIMEOUT_MS)) {
      log(
        home,
        `lock pid ${lock.pid} alive, port ${lock.port} bound but not answering the glosa ` +
          "handshake — refusing to spawn a duplicate",
      );
      return {
        ok: false,
        reason:
          `a process is bound to port ${lock.port} but is not answering the glosa handshake; ` +
          "the daemon may be hung or the port is taken by another process — not spawning a duplicate",
        logPath: logPath(home),
      };
    }
    log(home, `lock pid ${lock.pid} alive but port ${lock.port} is free — treating lock as stale`);
  }

  // Dead pid, or alive pid with a provably free port: genuinely stale. lock.port is the
  // authoritative port (A5 §F13) — the fresh daemon must reclaim that same port, not
  // whatever GLOSA_PORT happens to be seeded with right now.
  unlinkIfPresent(lockFile);
  return spawnAndWait(home, lock.port);
}

function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // already gone — fine
  }
}

function toResult(port: number, hs: HandshakeResponse): EnsureDaemonResult {
  if (!protocolCompatible(PROTOCOL_VERSION, hs.protocol_version)) {
    return {
      ok: false,
      reason:
        `daemon protocol ${hs.protocol_version} is incompatible with this client's ` +
        `${PROTOCOL_VERSION} — upgrade glosa`,
    };
  }
  return {
    ok: true,
    port,
    instanceId: hs.instance_id,
    protocolVersion: hs.protocol_version,
    pid: hs.pid,
    startedAt: hs.started_at,
  };
}

/**
 * Builds the spawned daemon's environment: scrubs `ANTHROPIC_API_KEY` (never let a spawned
 * child inherit it — see docs/CLAUDE.md invariant 5) and pins `GLOSA_HOME`/`GLOSA_PORT` so the
 * child roots itself exactly where this client expects. Pure — exported so the scrub itself is
 * unit-testable independent of actually spawning a process.
 */
export function buildChildEnv(
  base: Record<string, string | undefined>,
  opts: { home: string; port: number },
): Record<string, string | undefined> {
  const env = { ...base };
  delete env.ANTHROPIC_API_KEY;
  env.GLOSA_HOME = opts.home;
  env.GLOSA_PORT = String(opts.port);
  return env;
}

async function spawnAndWait(home: string, port: number): Promise<EnsureDaemonResult> {
  const mainPath = fileURLToPath(new URL("../../cli/src/main.ts", import.meta.url));
  const logFd = openSync(logPath(home), "a");
  const env = buildChildEnv(Bun.env, { home, port });

  const child = Bun.spawn({
    cmd: [process.execPath, mainPath, "__daemon"],
    stdio: ["ignore", logFd, logFd],
    env,
  });
  child.unref();
  closeSync(logFd); // child holds its own dup'd copy; safe to release ours

  const hs = await pollHandshake(port, HANDSHAKE_POLL_MS);
  if (!hs) {
    return {
      ok: false,
      reason: `daemon did not become ready within ${HANDSHAKE_POLL_MS}ms`,
      logPath: logPath(home),
    };
  }
  return toResult(port, hs);
}

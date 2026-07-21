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
import { createApiFetch, createClassFFetch } from "./http.ts";
import { classFCspHeaders, spaCspHeaders } from "./csp.ts";
import { internalErrorResponse } from "./problem.ts";
import { loadToken } from "./token.ts";
import { CapabilityStore } from "./capability.ts";
import { WorkspaceIndex } from "./registry/workspace-index.ts";
import { SessionRegistry } from "./registry/session-registry.ts";
import { WorkspaceBusRegistry } from "./bus/workspace-bus-registry.ts";

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
// P3.1: the daemon's single backend instance — one WorkspaceIndex, one SessionRegistry (sharing
// that index), one WorkspaceBusRegistry, wired together per session-registry.ts's own "production
// wiring is three lines" docstring and workspace-bus-registry.ts's `setOnHardRemove` docstring.
// Pulled out of bootDaemon so it's unit-testable on its own (a real WorkspaceIndex/SessionRegistry
// pair, no port binds, no subprocess) — see test/backend-wiring.test.ts.
// ---------------------------------------------------------------------------------------------
export interface DaemonBackend {
  workspaceIndex: WorkspaceIndex;
  sessionRegistry: SessionRegistry;
  busRegistry: WorkspaceBusRegistry;
}

export interface BuildBackendOptions {
  /** Test-only overrides for WorkspaceIndex's GC timers — production always uses the real
   * defaults (A5 §F19: grace ~24h, throttle ~60s). */
  gcGraceMs?: number;
  gcThrottleMs?: number;
}

export function buildBackend(home: string, opts: BuildBackendOptions = {}): DaemonBackend {
  const workspaceIndex = new WorkspaceIndex({ home, gcGraceMs: opts.gcGraceMs, gcThrottleMs: opts.gcThrottleMs });
  const sessionRegistry = new SessionRegistry({ index: workspaceIndex });
  const busRegistry = new WorkspaceBusRegistry();

  // Live-session predicate: a workspace under a live session is never GC-hard-removed no matter
  // how long its path has been missing (WorkspaceIndex's own conservative default otherwise).
  workspaceIndex.setLiveSessionPredicate((canonicalPath) => sessionRegistry.forWorkspace(canonicalPath).length > 0);
  // Hard-remove eviction: a workspace GC actually removes from the index must also drop its open
  // WorkspaceBus (journal fd, mutex slot, in-memory state) — see workspace-bus-registry.ts.
  workspaceIndex.setOnHardRemove((canonicalPath) => busRegistry.evict(canonicalPath));

  return { workspaceIndex, sessionRegistry, busRegistry };
}

// ---------------------------------------------------------------------------------------------
// Daemon role: `glosa __daemon` body. Binds the port, wins (or loses) the lock CAS, serves the
// lifecycle handshake, and blocks forever — every exit happens via an explicit process.exit()
// call below, per A5 §F13's exit-code table. Never returns normally.
// ---------------------------------------------------------------------------------------------
export async function bootDaemon(): Promise<never> {
  const home = ensureHomeDir(glosaHome());
  const port = Number(Bun.env.GLOSA_PORT ?? DEFAULT_PORT);
  const classFPort = Number(Bun.env.GLOSA_CLASSF_PORT ?? port + 1);
  const lockFile = lockPath(home);
  const instanceId = `gl-${randomUUID()}`;
  const startedAt = new Date().toISOString();
  const token = loadToken(home);
  const backend = buildBackend(home);
  // ONE store, shared by both listeners (P4.1, A1 §7): a token minted on the SPA/API origin
  // (createApiFetch) must be lookup-able by the class-F origin (createClassFFetch) — two
  // independent stores would mean every capability 404s on the very listener that's supposed to
  // serve it.
  const capabilityStore = new CapabilityStore();

  const apiFetch = createApiFetch({
    port,
    classFPort,
    token,
    instanceId,
    startedAt,
    workspaceIndex: backend.workspaceIndex,
    sessionRegistry: backend.sessionRegistry,
    getWorkspaceBus: (root) => backend.busRegistry.get(root),
    capabilityStore,
  });
  const server = await bindMainOrExit(home, port, apiFetch, spaCspHeaders(classFPort));

  // Lock acquisition happens IMMEDIATELY after the main-port bind — before the class-F bind —
  // deliberately mirroring P1.2's original "bind, then lock" ordering (A5 §F13: "Bind-before-
  // lock + O_EXCL → exactly one daemon wins"). Observed empirically: inserting the class-F
  // bind's own await *before* the lock CAS widens the window between "this process thinks it
  // won the main port" and "this process has proven it via the lock", and on this environment
  // `Bun.serve()` does not reliably surface EADDRINUSE between two racing OS processes fast
  // enough to close that window — two daemons could both consider themselves bound before either
  // wrote the lock. The lock's real O_EXCL CAS is the actual single-owner guarantee (the port
  // bind is only a fast-path optimization), so it must follow the primary bind as tightly as
  // P1.2 had it. Class-F binds only once this process has already won the lock outright.
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

  const classFFetch = createClassFFetch({ port: classFPort, spaPort: port, capabilityStore });
  const classFServer = await bindClassFOrExit(
    home,
    classFPort,
    classFFetch,
    server,
    classFCspHeaders(port),
    lockFile,
    instanceId,
  );

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Sequential: stop accepting *before* touching the lock, so a future journal-fsync /
    // SSE-bye step (P2/P3) has a clean "no new work, then cleanup" ordering to slot into.
    await Promise.all([server.stop(), classFServer.stop()]);
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

  log(home, `${instanceId} serving 127.0.0.1:${port} (class-F 127.0.0.1:${classFPort})`);
  return new Promise<never>(() => {
    // bootDaemon never resolves on the happy path; the process lives until a signal handler
    // (or one of the exit-code branches above) calls process.exit().
  });
}

async function bindMainOrExit(
  home: string,
  port: number,
  fetch: (req: Request) => Promise<Response>,
  errorCsp: Record<string, string>,
): Promise<ReturnType<typeof Bun.serve>> {
  try {
    return Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch,
      // Defense in depth: createApiFetch already try/catches everything, so this only fires if
      // a throw somehow escapes that (a bug in the pipeline itself). Bun's default error page
      // leaks source/stack — this never does (P1.3 review item 2).
      //
      // Deliberately NOT passing `development: false` here even though it reads like the more
      // "production" choice: on this Bun version (1.2.7) it changes `Bun.serve()`'s own
      // EADDRINUSE behavior — two racing processes both calling `Bun.serve({port: X, development:
      // false, ...})` for the same port can BOTH return successfully (confirmed via a minimal
      // repro + `lsof` showing both actually LISTENing), silently breaking the R1 singleton
      // invariant this whole bind-then-lock dance exists to protect. Omitting `development`
      // (Bun's own default) throws EADDRINUSE correctly, confirmed by the same repro. The `error`
      // callback alone is enough for the leak-prevention this option was meant to add — it does
      // NOT reproduce the EADDRINUSE regression on its own.
      error: () => internalErrorResponse(errorCsp),
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

/** Called only after this process has already won the main-port bind AND the lock CAS (see the
 * ordering note in bootDaemon) — so by this point there is no "benign race with a live glosa
 * peer" case left to distinguish; any bind failure here is a foreign squatter on the class-F
 * port. Tears down both the already-bound main server AND the just-acquired lock (this process
 * is not going to become the running daemon after all) so a failed boot never leaves a half-up
 * daemon holding the primary port or a lock nobody is going to service. */
async function bindClassFOrExit(
  home: string,
  port: number,
  fetch: (req: Request) => Promise<Response>,
  mainServer: ReturnType<typeof Bun.serve>,
  errorCsp: Record<string, string>,
  lockFile: string,
  instanceId: string,
): Promise<ReturnType<typeof Bun.serve>> {
  try {
    return Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch,
      // See the matching comment in bindMainOrExit — no `development: false` here either, for
      // the same EADDRINUSE-reliability reason.
      error: () => internalErrorResponse(errorCsp),
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
    log(home, `EADDRINUSE on class-F port 127.0.0.1:${port} — foreign process, aborting boot`);
    removeLockIfOwned(lockFile, instanceId);
    await mainServer.stop();
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

// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — F13 daemon lifecycle: the `glosa __daemon` boot body (bootDaemon) and the
// client-side "find or spawn" helper (ensureDaemon). See docs/appendices/A5-daemon-architecture.md
// §F13 and docs/requirements.md R1. Three roles, one binary: this module is used by the daemon
// role (bootDaemon, never imported by the SPA) and by every client role (ensureDaemon).
import { closeSync, openSync, appendFileSync, readFileSync } from "node:fs";
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
import { BUILD_ID, parseBuildId } from "./build-id.ts";
import { AdapterRegistry } from "./adapters/interface.ts";
import { WorkspaceMetadataRegistry } from "./adapters/workspace-metadata.ts";

const DEFAULT_PORT = 4646;
const HANDSHAKE_TIMEOUT_MS = 1000;
const HANDSHAKE_POLL_MS = 5000;
const RESTART_LOCK_WAIT_MS = 5000;
const ENSURE_MAX_PASSES = 8;
export const SHUTDOWN_DRAIN_MS = 3000;

interface DrainableServer {
  stop(closeActiveConnections?: boolean): Promise<void>;
}

export async function drainDaemonServers(
  servers: readonly DrainableServer[],
  afterStopAccepting: () => void,
  closeWorkspaceBuses: () => Promise<void>,
  timeoutMs = SHUTDOWN_DRAIN_MS,
): Promise<boolean> {
  const activeHandlers = servers.map((server) => server.stop(false));
  afterStopAccepting();
  const gracefulDrain = Promise.all(activeHandlers).then(closeWorkspaceBuses);
  const drained = await Promise.race([
    gracefulDrain.then(() => true),
    Bun.sleep(timeoutMs).then(() => false),
  ]);
  if (!drained) await Promise.allSettled(servers.map((server) => server.stop(true)));
  return drained;
}

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
  adapterRegistry: AdapterRegistry;
  metadataRegistry: WorkspaceMetadataRegistry;
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
  const adapterRegistry = new AdapterRegistry();
  const metadataRegistry = new WorkspaceMetadataRegistry();
  adapterRegistry.register(metadataRegistry.adapter());

  // Live-session predicate: a workspace under a live session is never GC-hard-removed no matter
  // how long its path has been missing (WorkspaceIndex's own conservative default otherwise).
  workspaceIndex.setLiveSessionPredicate((canonicalPath) => sessionRegistry.forWorkspace(canonicalPath).length > 0);
  // Hard-remove eviction: a workspace GC actually removes from the index must also drop its open
  // WorkspaceBus (journal fd, mutex slot, in-memory state) — see workspace-bus-registry.ts.
  workspaceIndex.setOnHardRemove((canonicalPath) => busRegistry.evict(canonicalPath));

  return { workspaceIndex, sessionRegistry, busRegistry, adapterRegistry, metadataRegistry };
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
  const shutdownController = new AbortController();
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
    adapterRegistry: backend.adapterRegistry,
    metadataRegistry: backend.metadataRegistry,
    shutdownSignal: shutdownController.signal,
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
    build_id: BUILD_ID,
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
    // Calling stop(false) synchronously closes the listeners to new work while allowing active
    // fetch handlers to finish. Closing SSE immediately after that prevents those intentionally
    // long-lived responses from holding the drain open forever.
    const drained = await drainDaemonServers(
      [server, classFServer],
      () => shutdownController.abort(),
      () => backend.busRegistry.closeAll(),
    );
    if (!drained) {
      log(home, `${instanceId} graceful drain exceeded ${SHUTDOWN_DRAIN_MS}ms; force-closing listeners`);
    }
    removeLockIfOwned(lockFile, instanceId);
    log(home, `${instanceId} ${drained ? "graceful" : "forced"} shutdown complete`);
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
  buildId: string;
  pid: number;
  startedAt: string;
}

export type EnsureDaemonResult =
  | ({ ok: true } & DaemonConnection)
  | { ok: false; reason: string; logPath?: string };

export type DaemonBuildDecision =
  | { action: "use" }
  | { action: "restart"; reason: "legacy" | "newer-client" | "same-version-different-build" }
  | { action: "fail"; reason: string };

const incompatibleVersionsReason = (daemonProtocol: string): string =>
  `incompatible glosa versions installed: daemon protocol ${daemonProtocol}, ` +
  `client protocol ${PROTOCOL_VERSION}; upgrade glosa`;

export function decideDaemonBuild(
  clientBuildId: string,
  daemonBuildId: string | undefined,
  daemonProtocol: string,
): DaemonBuildDecision {
  const client = parseBuildId(clientBuildId);
  if (!client) return { action: "fail", reason: `invalid client build identity: ${clientBuildId}` };
  if (daemonBuildId === undefined) return { action: "restart", reason: "legacy" };

  const daemon = parseBuildId(daemonBuildId);
  if (!daemon) return { action: "fail", reason: `invalid daemon build identity: ${daemonBuildId}` };

  const versionOrder = Bun.semver.order(client.version, daemon.version);
  if (versionOrder > 0) return { action: "restart", reason: "newer-client" };
  if (versionOrder === 0 && client.sourceHash !== daemon.sourceHash) {
    return { action: "restart", reason: "same-version-different-build" };
  }

  if (!protocolCompatible(PROTOCOL_VERSION, daemonProtocol)) {
    return { action: "fail", reason: incompatibleVersionsReason(daemonProtocol) };
  }
  return { action: "use" };
}

export function daemonPeerMismatchReason(lock: DaemonLock, hs: HandshakeResponse): string | null {
  if (lock.instance_id !== hs.instance_id || lock.pid !== hs.pid) {
    return "daemon lock and handshake identify different processes";
  }
  if (lock.protocol_version !== hs.protocol_version) {
    return "daemon lock and handshake report different protocol versions";
  }
  if (lock.build_id !== hs.build_id) {
    return "daemon lock and handshake report different build identities";
  }
  return null;
}

function toConnection(port: number, hs: HandshakeResponse): DaemonConnection {
  return {
    port,
    instanceId: hs.instance_id,
    protocolVersion: hs.protocol_version,
    buildId: hs.build_id as string,
    pid: hs.pid,
    startedAt: hs.started_at,
  };
}

async function waitForLockOwnershipChange(lockFile: string, instanceId: string): Promise<boolean> {
  const deadline = Date.now() + RESTART_LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    const current = readLock(lockFile);
    if (!current || current.instance_id !== instanceId) return true;
    await Bun.sleep(50);
  }
  return false;
}

function malformedLockBuildIdentity(lockFile: string): string | null {
  try {
    const value: unknown = JSON.parse(readFileSync(lockFile, "utf8"));
    if (typeof value !== "object" || value === null || !("build_id" in value)) return null;
    const buildId = (value as Record<string, unknown>).build_id;
    if (typeof buildId !== "string" || !parseBuildId(buildId)) {
      return `invalid daemon lock build identity: ${String(buildId)}`;
    }
    return null;
  } catch {
    // A wholly unparseable legacy/stale lock retains the existing stale-lock recovery behavior.
    return null;
  }
}

export async function ensureDaemon(): Promise<EnsureDaemonResult> {
  const home = ensureHomeDir(glosaHome());
  const lockFile = lockPath(home);
  const seedPort = Number(Bun.env.GLOSA_PORT ?? DEFAULT_PORT);
  let preferredPort = seedPort;

  for (let pass = 0; pass < ENSURE_MAX_PASSES; pass += 1) {
    const lock = readLock(lockFile);
    const identityError = malformedLockBuildIdentity(lockFile);
    if (identityError) return { ok: false, reason: identityError, logPath: logPath(home) };
    if (!lock) {
      const spawnFailure = await spawnAndWait(home, preferredPort);
      if (spawnFailure) return spawnFailure;
      continue;
    }

    preferredPort = lock.port;
    if (isPidAlive(lock.pid)) {
      const hs = await pollHandshake(lock.port, HANDSHAKE_POLL_MS);
      if (hs) {
        const mismatch = daemonPeerMismatchReason(lock, hs);
        if (mismatch) return { ok: false, reason: mismatch, logPath: logPath(home) };

        const decision = decideDaemonBuild(BUILD_ID, hs.build_id, hs.protocol_version);
        if (decision.action === "use") return { ok: true, ...toConnection(lock.port, hs) };
        if (decision.action === "fail") return { ok: false, reason: decision.reason };

        log(home, `refreshing ${hs.instance_id}: ${decision.reason} (${hs.build_id ?? "legacy"} -> ${BUILD_ID})`);
        try {
          process.kill(hs.pid, "SIGTERM");
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
            return { ok: false, reason: `could not stop stale glosa daemon: ${(err as Error).message}` };
          }
        }
        if (!(await waitForLockOwnershipChange(lockFile, lock.instance_id))) {
          return {
            ok: false,
            reason: `stale glosa daemon did not release its lock within ${RESTART_LOCK_WAIT_MS}ms`,
            logPath: logPath(home),
          };
        }
        continue;
      }

      // Alive pid, no valid handshake within the ≤5s budget: a hung glosa daemon and a foreign
      // squatter on lock.port are indistinguishable from here. Only reclaim when the port is
      // provably free, otherwise spawning could violate the singleton invariant.
      if (await probePortBound(lock.port, HANDSHAKE_TIMEOUT_MS)) {
        log(home, `lock pid ${lock.pid} alive, port ${lock.port} bound but not answering the glosa handshake`);
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

    removeLockIfOwned(lockFile, lock.instance_id);
  }

  return {
    ok: false,
    reason: "daemon ownership changed too many times while ensuring a connection",
    logPath: logPath(home),
  };
}

/**
 * Builds the spawned daemon's environment: scrubs `ANTHROPIC_API_KEY` (never let a spawned
 * child inherit it — see AGENTS.md invariant 5) and pins `GLOSA_HOME`/`GLOSA_PORT` so the
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

async function spawnAndWait(
  home: string,
  port: number,
): Promise<Extract<EnsureDaemonResult, { ok: false }> | null> {
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
  return null;
}

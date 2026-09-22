// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — F13 daemon lifecycle: the `glosa __daemon` boot body (bootDaemon) and the
// client-side "find or spawn" helper (ensureDaemon). See docs/appendices/A5-daemon-architecture.md
// §F13 and docs/requirements.md R1. Three roles, one binary: this module is used by the daemon
// role (bootDaemon, never imported by the SPA) and by every client role (ensureDaemon).

import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import { appendFileSync, chmodSync, closeSync, existsSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { AdapterRegistry } from "../adapters/interface.ts";
import { WorkspaceMetadataRegistry } from "../adapters/workspace-metadata.ts";
import { AdoptionCoordinator, resumePendingAdoptions } from "../adoption.ts";
import { type AgentProvider, AgentProviderRegistry } from "../agent-provider/interface.ts";
import { SessionPushRegistry } from "../agent-provider/push-registry.ts";
import { WatchEmissionRegistry } from "../agent-provider/watch-emissions.ts";
import { type DictationProvider, DictationProviderRegistry } from "../dictation/interface.ts";
import { ArtifactWatcherAllocation } from "../artifact-watcher-allocation.ts";
import { ClaimSweeper } from "../claim-sweeper.ts";
import { SignalRegistry } from "../agent-provider/signal-registry.ts";
import { ArtifactWatcherRegistry, type ArtifactWatcherRegistryOptions } from "../artifact-watcher.ts";
import { WorkspaceBus } from "../bus/bus.ts";
import { WorkspaceBusRegistry } from "../bus/workspace-bus-registry.ts";
import { resolveTrackedFilesAsync } from "../matcher-async.ts";
import { resolveTrackedFiles } from "../matcher.ts";
import type { WorkspaceBusWriteCheckpointObserver } from "../bus/write-checkpoint.ts";
import { SessionRegistry } from "../registry/session-registry.ts";
import { WorkspaceIndex } from "../registry/workspace-index.ts";
import { CapabilityStore } from "../security/capability.ts";
import { classFCspHeaders, spaCspHeaders } from "../security/csp.ts";
import { PresentationTokenStore } from "../security/presentation-token.ts";
import { TokenAuthority } from "../security/token.ts";
import {
  type ApiContext,
  type BunServer,
  createApiFetch,
  createClassFFetch,
  createRejectionRecorder,
} from "../transport/http.ts";
import { internalErrorResponse } from "../transport/problem.ts";
import type { WorkspaceTarget } from "../workspace.ts";
import { BUILD_ID, parseBuildId } from "./build-id.ts";
import { claimDaemonIdentity, releaseDaemonIdentity } from "./daemon-identity.ts";
import {
  fetchHandshake,
  type HandshakeResponse,
  pollHandshake,
  probePortBindable,
  probePortBound,
} from "./handshake.ts";
import { apiSocketPath, ensureHomeDir, ensureRunDir, glosaHome, lockPath, logPath, runDir } from "./home.ts";
import { INSTALL_ID } from "./install.ts";
import { glosaClassFPort, glosaPort } from "./port.ts";
import {
  type DaemonLock,
  isPidAlive,
  readLock,
  reclaimStaleLock,
  removeLockIfOwned,
  writeLockExclusive,
} from "./lock.ts";
import { PROTOCOL_VERSION, protocolCompatible } from "./protocol.ts";
import { startStallWatchdog } from "./stall-watchdog.ts";

const HANDSHAKE_TIMEOUT_MS = 1000;
const HANDSHAKE_POLL_MS = 5000;
/** How long a client waits for a daemon it has signalled, or found exiting, to give up its lock.
 * Longer than the daemon's own hard-exit ceiling (`SHUTDOWN_HARD_EXIT_MS`) so a daemon that uses all
 * of it is still waited for; the overall discovery deadline bounds it in practice. */
const EXITING_DAEMON_WAIT_MS = 10_000;
const ENSURE_MAX_PASSES = 8;
const DEFAULT_ENSURE_TIMEOUT_MS = 12_000;
const LOCK_REPAIR_INTERVAL_MS = 250;
const PORT_FREE_CONFIRMATIONS = 3;
const PORT_FREE_CONFIRMATION_INTERVAL_MS = 100;
export const SHUTDOWN_DRAIN_MS = 3000;
/** Hard ceiling on a shutdown that has already begun. The drain itself is bounded, but the
 * force-close that follows it is a runtime call this process does not control, and a shutdown that
 * never finishes is indistinguishable from the ignored-SIGTERM the user reported: `shuttingDown`
 * is already set, so no later signal starts a second attempt. Past this, exit anyway. */
export const SHUTDOWN_HARD_EXIT_MS = 8000;

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
  const drained = await Promise.race([gracefulDrain.then(() => true), Bun.sleep(timeoutMs).then(() => false)]);
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
  providerRegistry: AgentProviderRegistry;
  dictationRegistry: DictationProviderRegistry;
  pushRegistry: SessionPushRegistry;
  signalRegistry: SignalRegistry;
  watchEmissions: WatchEmissionRegistry;
  artifactWatcherRegistry: ArtifactWatcherRegistry;
  /** Starts daemon-lifetime watching for workspaces already in the index. Call AFTER serving:
   * it is warm-up, not readiness, and it yields between workspaces. */
  warmArtifactWatchers(): Promise<void>;
  adoptionCoordinator: AdoptionCoordinator;
  createAdoptionStagingBus(workspace: WorkspaceTarget): WorkspaceBus;
  sealAdoptionSources(
    sources: readonly WorkspaceTarget[],
    adoptionId: string,
    targetRegistrationId: string,
  ): Promise<void>;
  closeWorkspaceResources(): Promise<void>;
  /** `closeWorkspaceResources` for a process that is about to exit: closes every bus, but retires
   * the artifact watchers without closing their filesystem watches (see
   * `ArtifactWatcherRegistry.abandonAll`). Daemon shutdown uses this one. */
  releaseWorkspaceResourcesForExit(): Promise<void>;
}

export interface ProviderFactoryDeps {
  sessionRegistry: SessionRegistry;
  pushRegistry: SessionPushRegistry;
}

export interface DictationProviderFactoryDeps {
  home: string;
}

export interface BuildBackendOptions {
  /** Test-only overrides for WorkspaceIndex's GC timers — production always uses the real
   * defaults (A5 §F19: grace ~24h, throttle ~60s). */
  gcGraceMs?: number;
  gcThrottleMs?: number;
  providerFactories?: Array<(deps: ProviderFactoryDeps) => AgentProvider>;
  dictationProviderFactories?: Array<(deps: DictationProviderFactoryDeps) => DictationProvider>;
  /** Explicit acceptance-test dependency. The packaged CLI never supplies one. */
  writeCheckpoint?: WorkspaceBusWriteCheckpointObserver;
  /** Test-only override for what counts as the user's home directory. Production reads the real
   * one. Threaded to WorkspaceIndex as well, so the refusal the index applies and the refusal
   * watcher warm-up applies are answering from the same value rather than two calls to
   * `homedir()` that could diverge under test. */
  userHomeDir?: string;
  /** Test-only: how the artifact watcher registry opens a filesystem watch. Production uses
   * `nativeWorkspaceWatch`. */
  artifactWatchFactory?: ArtifactWatcherRegistryOptions["watchFactory"];
  /** Test-only capacity override for deterministic allocation/preemption coverage. */
  maxWatchedWorkspaces?: number;
  /** Test-only resolver seam. Production uses the matcher Worker implementation below. */
  resolveTrackedFilesAsync?: typeof resolveTrackedFilesAsync;
  /** Test-only poison seam for synchronous shadow matcher walks. */
  resolveTrackedFilesSync?: typeof resolveTrackedFiles;
}

export function buildBackend(home: string, opts: BuildBackendOptions = {}): DaemonBackend {
  const userHomeDir = opts.userHomeDir ?? homedir();
  const asyncTrackedFiles = opts.resolveTrackedFilesAsync ?? resolveTrackedFilesAsync;
  const workspaceIndex = new WorkspaceIndex({
    home,
    gcGraceMs: opts.gcGraceMs,
    gcThrottleMs: opts.gcThrottleMs,
    userHomeDir,
  });
  // Constructed BEFORE SessionRegistry (issue #156 held-review finding) so the SAME instance —
  // never a second one — is what both `ctx.adoptionCoordinator` (session register/bind, forget's
  // own commit) and SessionRegistry's heartbeat/connection-refresh serialize against; two separate
  // coordinators would leave the two call paths just as unserialized as having none at all.
  const adoptionCoordinator = new AdoptionCoordinator();
  const sessionRegistry = new SessionRegistry({ index: workspaceIndex, ownershipCoordinator: adoptionCoordinator });
  const busRegistry = new WorkspaceBusRegistry({
    writeCheckpoint: opts.writeCheckpoint,
    resolveTrackedFilesAsync: asyncTrackedFiles,
    resolveTrackedFilesSync: opts.resolveTrackedFilesSync,
  });
  const adapterRegistry = new AdapterRegistry();
  const metadataRegistry = new WorkspaceMetadataRegistry();
  const providerRegistry = new AgentProviderRegistry();
  const dictationRegistry = new DictationProviderRegistry();
  const pushRegistry = new SessionPushRegistry();
  // Issue #155: session signals, derived from each bus's claim events as they are appended. Routed
  // with the same R2 predicate as delivery, pushed on the session's own stream when it has one, and
  // otherwise held for its next drain. In memory only — the journal event is the durable record.
  const signalRegistry = new SignalRegistry({
    sessionsFor: (workspace) => sessionRegistry.forWorkspace(workspace).map((session) => session.session_id),
    push: (sessionId, frame) => pushRegistry.sendSignal(sessionId, frame),
  });
  busRegistry.setOnOpen((bus, workspace) => {
    const unsubscribe = signalRegistry.attach(
      bus,
      typeof workspace === "string" ? workspace : workspace.canonical_path,
    );
    bus.closeSignal().addEventListener("abort", unsubscribe, { once: true });
  });
  const watchEmissions = new WatchEmissionRegistry();
  const artifactWatcherRegistry = new ArtifactWatcherRegistry({
    watchFactory: opts.artifactWatchFactory,
    maxWatchedWorkspaces: opts.maxWatchedWorkspaces,
    warn: (message) => log(home, message),
    initialResolveTrackedFiles: asyncTrackedFiles,
    // The watcher→bus edge (#153), assembled HERE rather than imported inside the watcher: that
    // module stays a chokidar fan-out that knows nothing about journals or shadow git, and the one
    // place the two layers meet is this composition root. `captureExternalEdit` takes the
    // workspace mutex and refuses a sealed/forgotten bus itself (`assertWritable`), so the timer
    // firing during a `glosa forget` is refused at the same gate every other writer meets.
    captureExternalEdit: async (workspace) => {
      const bus = busRegistry.get(workspace);
      await bus.reconcileOnce();
      return bus.captureExternalEdit();
    },
  });
  const artifactWatcherAllocation = new ArtifactWatcherAllocation({
    workspaceIndex,
    sessionRegistry,
    watcherRegistry: artifactWatcherRegistry,
    userHomeDir,
    warn: (message) => log(home, message),
  });
  // Issue #155: claims die with their TTL or their holder session, including claims nobody meets
  // again. Started with the backend; it only ever touches buses something already opened.
  const claimSweeper = new ClaimSweeper({
    workspaceIndex,
    busRegistry,
    sessionRegistry,
    warn: (message) => log(home, message),
  });
  claimSweeper.start();
  const sealAdoptionSources = async (
    sources: readonly WorkspaceTarget[],
    adoptionId: string,
    targetRegistrationId: string,
  ): Promise<void> => {
    await busRegistry.sealForAdoption(sources, adoptionId, targetRegistrationId);
    await Promise.all(sources.map((source) => artifactWatcherRegistry.evict(source)));
  };
  const createAdoptionStagingBus = (workspace: WorkspaceTarget) =>
    new WorkspaceBus(workspace, {
      resolveTrackedFilesAsync: asyncTrackedFiles,
      resolveTrackedFilesSync: opts.resolveTrackedFilesSync,
    });
  const closeWorkspaceResources = async (): Promise<void> => {
    await claimSweeper.stop();
    await artifactWatcherAllocation.stop();
    await Promise.all([artifactWatcherRegistry.closeAll(), busRegistry.closeAll()]);
  };
  const releaseWorkspaceResourcesForExit = async (): Promise<void> => {
    // Watchers first and synchronously, so no quiet-window capture can start against a bus that
    // is closing, and no warm-up step opens a new watch that nothing will ever use. The claim
    // sweeper stops first for the same reason: no expiry may start against a closing bus.
    await claimSweeper.stop();
    await artifactWatcherAllocation.stop();
    artifactWatcherRegistry.abandonAll();
    await busRegistry.closeAll();
  };
  adapterRegistry.register(metadataRegistry.adapter());
  for (const factory of opts.providerFactories ?? []) {
    providerRegistry.register(factory({ sessionRegistry, pushRegistry }));
  }
  for (const factory of opts.dictationProviderFactories ?? []) {
    dictationRegistry.register(factory({ home }));
  }

  // Live-session predicate: a workspace under a live session is never GC-hard-removed no matter
  // how long its path has been missing (WorkspaceIndex's own conservative default otherwise).
  workspaceIndex.setLiveSessionPredicate((canonicalPath) => sessionRegistry.forWorkspace(canonicalPath).length > 0);
  // Hard-remove eviction: a workspace GC actually removes from the index must also drop its open
  // WorkspaceBus (journal fd, mutex slot, in-memory state) — see workspace-bus-registry.ts.
  workspaceIndex.setOnHardRemove(async (entry) => {
    await Promise.all([busRegistry.evict(entry), artifactWatcherRegistry.evict(entry)]);
    artifactWatcherAllocation.requestRebalance();
  });
  // Daemon-lifetime artifact watching (#153). Two halves, and both are needed: workspaces already
  // in the index when this process starts, and workspaces registered while it runs. Without the
  // first, watching would only ever begin after something touched a workspace over HTTP; without
  // the second, a `glosa open` during the daemon's life would produce no watcher until the next
  // restart. Neither half involves a browser — that is the amendment's whole point.
  workspaceIndex.setOnRegister(() => artifactWatcherAllocation.requestRebalance());
  sessionRegistry.setOnSessionsChanged(() => artifactWatcherAllocation.requestRebalance());

  /** The second half: workspaces already in the index when this process started.
   *
   * NOT run here. `ensureWatched` schedules one matcher walk per workspace on first sight, and this
   * builder runs before `Bun.serve`. Warm-up is not readiness, so the caller starts serving first
   * and calls this afterwards; production matcher walks run in Workers and cannot freeze the
   * daemon event loop while the accumulated index is warmed.
   *
   * Yields between workspaces so registration work stays interleavable, and skips roots that are
   * no longer on disk: an index entry whose directory was deleted is not worth a tree walk, and
   * `present` does not currently catch that on its own. */
  const warmArtifactWatchers = (): Promise<void> => artifactWatcherAllocation.rebalance();

  return {
    warmArtifactWatchers,
    workspaceIndex,
    sessionRegistry,
    busRegistry,
    adapterRegistry,
    metadataRegistry,
    providerRegistry,
    dictationRegistry,
    pushRegistry,
    signalRegistry,
    watchEmissions,
    artifactWatcherRegistry,
    adoptionCoordinator,
    createAdoptionStagingBus,
    sealAdoptionSources,
    closeWorkspaceResources,
    releaseWorkspaceResourcesForExit,
  };
}

// ---------------------------------------------------------------------------------------------
// Daemon role: `glosa __daemon` body. Binds the port, wins (or loses) the lock CAS, serves the
// lifecycle handshake, and blocks forever — every exit happens via an explicit process.exit()
// call below, per A5 §F13's exit-code table. Never returns normally.
// ---------------------------------------------------------------------------------------------
export async function bootDaemon(opts: BuildBackendOptions = {}): Promise<never> {
  const home = ensureHomeDir(glosaHome());
  const port = glosaPort();
  const classFPort = glosaClassFPort(port);
  const lockFile = lockPath(home);
  const instanceId = `gl-${randomUUID()}`;
  const startedAt = new Date().toISOString();
  const tokenAuthority = new TokenAuthority(home, (message) => log(home, message));
  const backend = buildBackend(home, opts);
  const shutdownController = new AbortController();
  // ONE store, shared by both listeners (P4.1, A1 §7): a token minted on the SPA/API origin
  // (createApiFetch) must be lookup-able by the class-F origin (createClassFFetch) — two
  // independent stores would mean every capability 404s on the very listener that's supposed to
  // serve it.
  const capabilityStore = new CapabilityStore();
  const presentationTokenStore = new PresentationTokenStore();
  tokenAuthority.subscribe(() => {
    capabilityStore.clear();
    presentationTokenStore.clear();
  });

  const record: DaemonLock = {
    instance_id: instanceId,
    pid: process.pid,
    port,
    protocol_version: PROTOCOL_VERSION,
    build_id: BUILD_ID,
    install_id: INSTALL_ID,
    started_at: startedAt,
    host: "127.0.0.1",
    bun: Bun.version,
  };
  let shutdownRequested = false;
  let shutdown: (() => Promise<void>) | null = null;
  let startupShutdownTimer: ReturnType<typeof setTimeout> | null = null;
  // The main listener starts accepting as soon as Bun.serve returns, before the rest of boot has
  // installed the fully wired shutdown function below. A client may therefore receive a valid
  // handshake and immediately send SIGTERM while startup is still finishing. Remember that signal
  // instead of falling through to the OS default, which exits without releasing daemon.lock.
  process.on("SIGTERM", () => {
    shutdownRequested = true;
    if (shutdown) {
      void shutdown();
      return;
    }
    if (startupShutdownTimer !== null) return;
    startupShutdownTimer = setTimeout(() => {
      log(home, `${instanceId} startup shutdown exceeded ${SHUTDOWN_HARD_EXIT_MS}ms; releasing ownership and exiting`);
      removeLockIfOwned(lockFile, instanceId);
      releaseDaemonIdentity();
      process.exit(0);
    }, SHUTDOWN_HARD_EXIT_MS);
  });
  let mayRepairLock = false;
  const repairLockOwnership = (): void => {
    // Only the process that already won the initial bind + O_EXCL race may repair its missing
    // coordination record. Existing files — including malformed or mismatched ones — are never
    // overwritten here, and shutdown disables repair before removing its own lock.
    if (!mayRepairLock || existsSync(lockFile)) return;
    try {
      writeLockExclusive(lockFile, record);
      log(home, `${instanceId} recreated missing ownership lock`);
    } catch (error) {
      // Another writer winning O_EXCL is a normal race. Any other failure is logged and left for
      // the client-side lock/handshake verification to fail closed; the daemon never guesses.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        log(home, `${instanceId} could not recreate missing ownership lock: ${(error as Error).message}`);
      }
    }
  };
  let markStartupReady!: () => void;
  const startupReady = new Promise<void>((resolve) => {
    markStartupReady = resolve;
  });

  // ONE context object, deliberately: `createApiFetch` keys the daemon's composite-delivery
  // registry and adoption coordinator on this object's identity, so the two listeners below must
  // be built from this exact reference rather than from a copy.
  const apiContext: ApiContext = {
    port,
    classFPort,
    token: tokenAuthority,
    instanceId,
    startedAt,
    repairLockOwnership,
    workspaceIndex: backend.workspaceIndex,
    sessionRegistry: backend.sessionRegistry,
    getWorkspaceBus: (workspace) => backend.busRegistry.get(workspace),
    sealAdoptionSources: backend.sealAdoptionSources,
    createAdoptionStagingBus: backend.createAdoptionStagingBus,
    adoptionCoordinator: backend.adoptionCoordinator,
    capabilityStore,
    presentationTokenStore,
    adapterRegistry: backend.adapterRegistry,
    metadataRegistry: backend.metadataRegistry,
    providerRegistry: backend.providerRegistry,
    dictationRegistry: backend.dictationRegistry,
    pushRegistry: backend.pushRegistry,
    signalRegistry: backend.signalRegistry,
    watchEmissions: backend.watchEmissions,
    artifactWatcherRegistry: backend.artifactWatcherRegistry,
    shutdownSignal: shutdownController.signal,
    home,
    recordRejection: createRejectionRecorder((line) => log(home, `${instanceId} ${line}`)),
  };
  const apiFetch = createApiFetch(apiContext);
  const socketApiFetch = createApiFetch(apiContext, "socket");
  // Bun.serve starts accepting as soon as it returns, but a successful handshake is the public
  // readiness proof. Hold only that route until lock ownership, both listeners, and shutdown are
  // fully wired so clients never observe a new process beside the previous process's stale lock.
  // #153 Part 2 (criterion 5) found this dropping `server` entirely — Bun always calls a
  // `Bun.serve` fetch handler as `fetch(req, server)`, but this wrapper only ever forwarded
  // `request`, so every downstream `server?.timeout(req, 0)` (the session stream's own included)
  // silently no-op'd in production: `server` was always `undefined` here, never Bun's real
  // instance. A held connection was therefore still subject to Bun's default idle close (A1
  // §8.3) regardless of that call, which is exactly the defect a real bound-daemon test (as
  // opposed to `http-routes.test.ts`'s in-process, no-bound-server calls) can observe and this
  // one bound-parameter fix closes for every current and future caller of `server.timeout`.
  //
  // Forwarding it is necessary and not sufficient: on the pinned Bun, `server.timeout(req, n)` is
  // ignored on the UNIX listener for every `n`, so the socket needs its own `idleTimeout` (see
  // `bindApiSocketOrExit`). A real `server` here still matters for the hostname/port listeners.
  const readyApiFetch = async (request: Request, server: BunServer): Promise<Response> => {
    if (new URL(request.url).pathname === "/api/handshake") await startupReady;
    return apiFetch(request, server);
  };
  const server = await bindMainOrExit(
    home,
    port,
    readyApiFetch,
    spaCspHeaders(classFPort, backend.dictationRegistry.enabledConnectOrigins()),
  );

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
  await acquireLockOrExit(home, lockFile, record, server);
  mayRepairLock = true;
  const lockRepairTimer = setInterval(repairLockOwnership, LOCK_REPAIR_INTERVAL_MS);
  lockRepairTimer.unref();
  // This is the ONLY moment a glosa process may call itself the daemon: the O_EXCL CAS above has
  // just proven it owns `<GLOSA_HOME>/daemon.lock`. `git/shadow.ts#reclaimIndexLock` needs that
  // proof before it may unlink a stray `index.lock` (A4 §F21) — a process that never reaches this
  // line has no identity to claim and therefore refuses to reclaim rather than risk deleting a
  // lock a live `git` owns. `lockFile` is captured with the id so the proof is always read back
  // from the home this process actually locked.
  claimDaemonIdentity({ instanceId, lockFile });
  // Armed only now, for the same reason: the watchdog releases the ownership lock before it kills,
  // and only a process that has won the CAS has an ownership record it is entitled to release.
  const stallWatchdog = startStallWatchdog({
    home,
    lockFile,
    instanceId,
    log: (line) => log(home, line),
  });

  try {
    await resumePendingAdoptions(
      backend.workspaceIndex,
      (workspace) => backend.busRegistry.get(workspace),
      backend.sealAdoptionSources,
      backend.adoptionCoordinator,
      backend.createAdoptionStagingBus,
    );
  } catch (error) {
    // A sealed adoption is deliberately fail-closed for its own target, but must not prevent a
    // daemon from serving unrelated workspaces. The next open retries the same durable plan.
    log(home, `${instanceId} adoption resume deferred: ${(error as Error).message}`);
  }

  const classFFetch = createClassFFetch({
    port: classFPort,
    spaPort: port,
    capabilityStore,
    tokenSource: tokenAuthority,
  });
  const classFServer = await bindClassFOrExit(
    home,
    classFPort,
    classFFetch,
    server,
    classFCspHeaders(port),
    lockFile,
    instanceId,
  );

  // The third listener: the same API surface, same context, served over a Unix socket that only
  // this uid can open (A3 §3.2). Bound last, for the same reason class-F is bound after the lock
  // — the TCP bind plus the O_EXCL CAS is what decides which process is the daemon, and nothing
  // may widen the window between those two. `socketApiFetch` is a second closure over the SAME
  // `apiContext`, not a second context, so both listeners share one composite-delivery registry
  // and one adoption coordinator (see `createApiFetch`'s note on why transport is a parameter).
  const socketPath = apiSocketPath(home);
  const socketServer = await bindApiSocketOrExit(
    home,
    socketPath,
    async (request: Request, bunServer: BunServer): Promise<Response> => {
      if (new URL(request.url).pathname === "/api/handshake") await startupReady;
      return socketApiFetch(request, bunServer);
    },
    [server, classFServer],
    spaCspHeaders(classFPort),
    lockFile,
    instanceId,
  );
  // Only now, and only because the bind returned: the handshake's `serves_socket` is a claim
  // about a listener that exists, not about a build that intended one. `markStartupReady` has
  // not fired yet, so no handshake can have answered `false` for this daemon.
  apiContext.servesSocket = true;

  let shuttingDown = false;
  shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (startupShutdownTimer !== null) {
      clearTimeout(startupShutdownTimer);
      startupShutdownTimer = null;
    }
    mayRepairLock = false;
    clearInterval(lockRepairTimer);
    // A shutdown that hangs past this point still ends, and still ends with its lock released.
    // Deliberately NOT unref'd: closing the listeners removes the last thing keeping this loop
    // alive, so an unref'd timer would let the process fall out from under a stalled drain and
    // leave its ownership record behind — the state a client then has to fail closed against. This
    // costs nothing on the ordinary path, which reaches `process.exit(0)` long before it fires.
    const hardExit = setTimeout(() => {
      log(home, `${instanceId} shutdown exceeded ${SHUTDOWN_HARD_EXIT_MS}ms; exiting without a clean drain`);
      removeLockIfOwned(lockFile, instanceId);
      releaseDaemonIdentity();
      process.exit(0);
    }, SHUTDOWN_HARD_EXIT_MS);
    stallWatchdog?.stop();
    // Calling stop(false) synchronously closes the listeners to new work while allowing active
    // fetch handlers to finish. Closing SSE immediately after that prevents those intentionally
    // long-lived responses from holding the drain open forever.
    const drained = await drainDaemonServers(
      [server, classFServer, socketServer],
      () => {
        shutdownController.abort();
        tokenAuthority.close();
      },
      backend.releaseWorkspaceResourcesForExit,
    );
    if (!drained) {
      log(home, `${instanceId} graceful drain exceeded ${SHUTDOWN_DRAIN_MS}ms; force-closing listeners`);
    }
    clearTimeout(hardExit);
    removeLockIfOwned(lockFile, instanceId);
    // Dropped AFTER the lock file is gone, so the two can never disagree in the direction that
    // matters: an identity outliving its lock only makes `reclaimIndexLock` fail closed, whereas
    // a lock outliving its identity would be a claim with nothing behind it.
    releaseDaemonIdentity();
    log(home, `${instanceId} ${drained ? "graceful" : "forced"} shutdown complete`);
    process.exit(0);
  };
  // Survive Ctrl-C in the terminal / the controlling terminal closing (A5 §F13) — the shim
  // dying must not take the daemon with it.
  process.on("SIGHUP", () => {});
  process.on("SIGINT", () => {});

  if (shutdownRequested) {
    void shutdown();
  } else {
    markStartupReady();
    log(home, `${instanceId} serving 127.0.0.1:${port} (class-F 127.0.0.1:${classFPort})`);
    // Warm the artifact watchers only now — after both binds, the lock, and the handshake gate.
    // Deliberately not awaited: warm-up is not readiness, and on a machine with a large index it
    // takes far longer than a client is willing to wait for `glosa open`. Failures are logged and
    // dropped rather than thrown, because a workspace that cannot be watched still has its changes
    // captured by offline catch-up on the next reconcile.
    void backend
      .warmArtifactWatchers()
      .catch((error: unknown) => log(home, `${instanceId} artifact watcher warm-up failed: ${String(error)}`));
  }
  return new Promise<never>(() => {
    // bootDaemon never resolves on the happy path; the process lives until a signal handler
    // (or one of the exit-code branches above) calls process.exit().
  });
}

async function bindMainOrExit(
  home: string,
  port: number,
  fetch: (req: Request, server: BunServer) => Promise<Response>,
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

/**
 * Is anything actually listening on a Unix socket path? `refused` (a clean ECONNREFUSED) is the
 * ONLY answer that proves nobody is, and it is the only one any caller may act destructively on —
 * the same fail-closed shape as `probePortBound` for TCP.
 *
 * Uses a raw `connect(2)` rather than `fetch`: Bun pools connections by socket path and will
 * answer a second `fetch` without reconnecting, which makes a liveness probe written that way
 * report a peer that is no longer there.
 */
function probeUnixSocket(path: string, timeoutMs = 1000): Promise<"listening" | "refused" | "unknown"> {
  return new Promise((resolve) => {
    const socket = connect({ path });
    let settled = false;
    const finish = (result: "listening" | "refused" | "unknown") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish("unknown"), timeoutMs);
    socket.once("connect", () => finish("listening"));
    socket.once("error", (err: NodeJS.ErrnoException) => finish(err.code === "ECONNREFUSED" ? "refused" : "unknown"));
  });
}

/**
 * Binds `<GLOSA_HOME>/run/api.sock`, the listener every CLI, MCP and provider client
 * authenticates over (A3 §3.2). Called only after this process has won the main-port bind AND the
 * lock CAS, so — exactly like `bindClassFOrExit` — any failure here is a foreign owner and the
 * right answer is to give back the port and the lock rather than serve half a daemon.
 *
 * Two facts about Unix sockets on Darwin drive the body, both verified with fresh unpooled
 * `connect(2)` rather than `fetch` (Bun's connection pool answers a second `fetch` without ever
 * calling `connect`, which makes a permission probe written that way report the opposite):
 *
 *   - `Bun.serve({unix})` creates the socket **0755**. The `chmod` to 0600 necessarily lands
 *     after the bind, so the parent directory — created 0700 by `ensureRunDir` — is what closes
 *     that window. Both permissions are enforced independently by the kernel.
 *   - `EADDRINUSE` does NOT distinguish a live owner from a dead one. A second bind on a live
 *     path throws it, and so does a bind over the inode a SIGKILLed daemon left behind — the path
 *     stays refused until something unlinks it. That is why the body probes before reclaiming
 *     rather than either retrying blindly (which would start a second daemon beside a live one)
 *     or failing (which would let one crash brick every later boot).
 */
async function bindApiSocketOrExit(
  home: string,
  socketPath: string,
  fetch: (req: Request, server: BunServer) => Promise<Response>,
  boundServers: readonly { stop(closeActiveConnections?: boolean): Promise<void> }[],
  errorCsp: Record<string, string>,
  lockFile: string,
  instanceId: string,
): Promise<ReturnType<typeof Bun.serve>> {
  const abortBoot = async (line: string): Promise<never> => {
    log(home, line);
    removeLockIfOwned(lockFile, instanceId);
    await Promise.allSettled(boundServers.map((server) => server.stop()));
    process.exit(3);
  };
  try {
    ensureRunDir(home);
  } catch (err) {
    return abortBoot(`cannot create ${runDir(home)} at mode 0700: ${(err as Error).message} — aborting boot`);
  }
  const bind = (): ReturnType<typeof Bun.serve> =>
    Bun.serve({
      unix: socketPath,
      fetch,
      // A1 8.3's per-request opt-out (`server.timeout(req, 0)`) is IGNORED on this listener by the
      // pinned Bun: a held request is still closed at Bun's ~10s default, whatever value the route
      // passes, and Bun's own warning says to configure `idleTimeout` instead. That silently cost
      // every held read on this transport, because this is the transport the monitor and the MCP
      // shim use: a `wait_ms` of 15 minutes ended at 10 seconds, and the Claude Code monitor's
      // session stream, which sends nothing between deliveries, was closed every 10 seconds and
      // reconnected on a backoff that climbs to the 60s ceiling. `glosa status` then reported
      // `push.connected:false` for most of every minute while push delivery did in fact work, just
      // a minute late.
      //
      // Disabled rather than merely raised: Bun caps `idleTimeout` at 255s and `MAX_ENTRY_WAIT_MS`
      // is 15 minutes, so no finite value can serve the wait this API already promises. Nothing is
      // left unbounded by it — every held route aborts on `req.signal`, on its own `wait_ms` timer,
      // and on the credential/lifecycle signals, and this listener is reachable only by this uid.
      //
      // Spread through a cast because `bun-types` declares `idleTimeout` on the hostname/port
      // variant only and `Serve.Options` is an XOR, so the unix branch types it as `undefined`.
      // The runtime honors it on both — `a held read outlives the socket listener's idle close`
      // fails without this line and passes with it — so the cast records a gap in the
      // declarations, not an assumption about behavior.
      ...({ idleTimeout: 0 } as object),
      // Same reasoning as bindMainOrExit: Bun's default error page leaks source and stack.
      error: () => internalErrorResponse(errorCsp),
    });
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = bind();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") {
      return abortBoot(`cannot bind ${socketPath}: ${(err as Error).message} — aborting boot`);
    }
    // A socket file outlives the process that made it: a daemon killed with SIGKILL, or one the
    // OS took down, leaves the inode behind and `bind(2)` refuses the path until something
    // removes it. Without this, a single crash would leave every later daemon unable to boot
    // until a human deleted a file they have never heard of.
    //
    // The same evidence rule as `reclaimStaleLock`: only a clean ECONNREFUSED proves nobody is
    // listening. A path that still ACCEPTS is a live owner — which, having already won the port
    // and the lock CAS above, would be a second daemon holding the socket alone, and unlinking it
    // would start a second daemon beside one still serving. Anything else is ambiguous, and an
    // ambiguous probe must never be what authorizes a delete.
    const owner = await probeUnixSocket(socketPath);
    if (owner !== "refused") {
      return abortBoot(
        owner === "listening"
          ? `${socketPath} is already being served by another process — aborting boot`
          : `cannot determine whether ${socketPath} is in use — aborting boot`,
      );
    }
    log(home, `removing a stale ${socketPath} left by a daemon that did not shut down`);
    try {
      unlinkSync(socketPath);
      server = bind();
    } catch (retryErr) {
      return abortBoot(`cannot reclaim ${socketPath}: ${(retryErr as Error).message} — aborting boot`);
    }
  }
  try {
    chmodSync(socketPath, 0o600);
  } catch (err) {
    // Fail the boot rather than serve a socket whose mode we could not confirm. The run dir alone
    // would still deny another uid, but a listener whose own permissions are unknown is not
    // something to leave running and call defended.
    await server.stop(true);
    return abortBoot(`cannot set ${socketPath} to mode 0600: ${(err as Error).message} — aborting boot`);
  }
  return server;
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
// Client role: every non-daemon entry point (CLI, MCP shim) calls this to get connection
// info, spawning a detached daemon if none is live. Never binds/locks anything itself.
// ---------------------------------------------------------------------------------------------
export interface DaemonConnection {
  port: number;
  instanceId: string;
  protocolVersion: string;
  buildId: string;
  /** Absent only when the daemon predates install identity (A5 §F13). */
  installId?: string;
  pid: number;
  startedAt: string;
  /** Where this client sends every authenticated request (A3 §3.2). Derived from this process's
   * own `GLOSA_HOME`, never from anything the peer said — a peer-supplied path would be one more
   * value an impostor could choose, and the whole point of this transport is that the destination
   * is decided by the filesystem rather than by the thing answering it. `port` remains for the
   * browser URL `glosa open` builds and for diagnostics; nothing authenticated uses it. */
  socketPath: string;
}

export type EnsureDaemonResult = ({ ok: true } & DaemonConnection) | { ok: false; reason: string; logPath?: string };

export interface EnsureDaemonOptions {
  timeoutMs?: number;
}

type PortFreeConfirmation = "free" | "bound" | "ownership-changed" | "deadline";

interface PortFreeConfirmationOptions {
  deadline: number;
  ownershipUnchanged: () => boolean;
  probe?: typeof probePortBound;
  bindable?: typeof probePortBindable;
  sleep?: (ms: number) => Promise<unknown>;
  now?: () => number;
}

function remainingMs(deadline: number, now: () => number = () => performance.now()): number {
  return Math.max(0, Math.ceil(deadline - now()));
}

function sameLockInstance(current: DaemonLock | null, expected: DaemonLock): boolean {
  return (
    current !== null &&
    current.instance_id === expected.instance_id &&
    current.pid === expected.pid &&
    current.port === expected.port &&
    current.protocol_version === expected.protocol_version &&
    current.build_id === expected.build_id &&
    // Ownership, not just liveness: this predicate gates `removeLockIfOwned`, so leaving install
    // identity out of it would let one install delete another's ownership record.
    current.install_id === expected.install_id &&
    current.started_at === expected.started_at &&
    current.host === expected.host &&
    current.bun === expected.bun
  );
}

/**
 * A single refused TCP connect is only a momentary observation. Require a short stable sequence
 * before a client is allowed to remove an ownership record or spawn a contender. Any ambiguity is
 * fail-closed, and ownership is re-read around every asynchronous step.
 *
 * The refused sequence is necessary but NOT sufficient, which is what issue #139 cost a user: a
 * daemon whose event loop has stopped keeps its listening socket but stops accepting, its accept
 * queue fills with the connections glosa's own discovery keeps opening, and macOS then answers
 * further connects with a clean `ECONNREFUSED`. Three of those 100 ms apart is a routine
 * observation under that load, so connect-evidence alone let a client delete a live daemon's
 * ownership record — after which the wedged daemon could neither be reached nor replaced.
 *
 * So freedom is proven by BINDING the port, never by failing to connect to it. The refused
 * sequence stays as the cheap fast path that decides whether the bind is worth attempting.
 */
export async function confirmPortFree(
  port: number,
  options: PortFreeConfirmationOptions,
): Promise<PortFreeConfirmation> {
  const probe = options.probe ?? probePortBound;
  const bindable = options.bindable ?? probePortBindable;
  const sleep = options.sleep ?? Bun.sleep;
  const now = options.now ?? (() => performance.now());

  for (let attempt = 0; attempt < PORT_FREE_CONFIRMATIONS; attempt += 1) {
    if (!options.ownershipUnchanged()) return "ownership-changed";
    const remaining = remainingMs(options.deadline, now);
    if (remaining <= 0) return "deadline";
    if (await probe(port, Math.min(HANDSHAKE_TIMEOUT_MS, remaining))) return "bound";
    if (!options.ownershipUnchanged()) return "ownership-changed";

    if (attempt < PORT_FREE_CONFIRMATIONS - 1) {
      const beforeSleep = remainingMs(options.deadline, now);
      if (beforeSleep <= 0) return "deadline";
      await sleep(Math.min(PORT_FREE_CONFIRMATION_INTERVAL_MS, beforeSleep));
    }
  }

  if (remainingMs(options.deadline, now) <= 0) return "deadline";
  // The one observation that cannot be faked by a saturated accept queue. A port this process
  // could not take is held by someone, so it reports `bound` exactly as a successful connect does.
  if (!(await bindable(port))) return "bound";
  if (!options.ownershipUnchanged()) return "ownership-changed";
  return remainingMs(options.deadline, now) > 0 ? "free" : "deadline";
}

function deadlineFailure(home: string, timeoutMs: number): Extract<EnsureDaemonResult, { ok: false }> {
  return spawnFailed(home, `daemon discovery exceeded its ${timeoutMs}ms wall-clock budget; ownership is unverified`);
}

function locklessHandshakeResult(
  home: string,
  lockFile: string,
  port: number,
  hs: HandshakeResponse,
): Extract<EnsureDaemonResult, { ok: false }> | null {
  const repaired = readLock(lockFile);
  if (repaired && repaired.port === port && daemonPeerMismatchReason(repaired, hs) === null) return null;

  const buildDecision = decideDaemonBuild({
    clientBuildId: BUILD_ID,
    clientInstallId: INSTALL_ID,
    daemonBuildId: hs.build_id,
    daemonInstallId: hs.install_id,
    daemonProtocol: hs.protocol_version,
  });
  // The foreign-install failure is the MOST actionable case, not the least: it must keep the
  // recovery text rather than degrade to a bare "cannot safely establish ownership".
  const manualRecovery =
    buildDecision.action === "restart"
      ? `; this daemon build cannot self-repair — ${manualStopHint(port, hs.pid)}`
      : buildDecision.action === "fail" && buildDecision.foreignInstall
        ? `; ${buildDecision.reason} — ${manualStopHint(port, hs.pid)}`
        : "";
  return {
    ok: false,
    reason: `glosa daemon answered on port ${port} ${
      existsSync(lockFile) ? "with an unusable lock" : "without a lock"
    }; cannot safely establish ownership${manualRecovery}`,
    logPath: logPath(home),
  };
}

export type DaemonBuildDecision =
  | { action: "use" }
  | { action: "restart"; reason: "legacy" | "newer-client" | "same-version-different-build" }
  /** `foreignInstall` marks the one failure a user can act on directly: another install owns the
   * daemon, so the fix is to stop that process rather than to change anything about this one. */
  | { action: "fail"; reason: string; foreignInstall?: true };

/** Everything the decision needs, as one object. Deliberately not positional: adding install
 * identity as extra parameters would let every existing call site keep compiling while silently
 * passing `undefined`, and `undefined` MUST NOT read as "the same install as mine". */
export interface DaemonBuildInputs {
  clientBuildId: string;
  clientInstallId: string;
  daemonBuildId: string | undefined;
  daemonInstallId: string | undefined;
  daemonProtocol: string;
}

const incompatibleVersionsReason = (daemonProtocol: string): string =>
  `incompatible glosa versions installed: daemon protocol ${daemonProtocol}, ` +
  `client protocol ${PROTOCOL_VERSION}; upgrade glosa`;

const foreignInstallReason = (daemonBuildId: string): string =>
  `the glosa daemon on this port was started by a different glosa install (daemon build ` +
  `${daemonBuildId}, this client ${BUILD_ID}); refusing to stop a daemon this install did not start`;

/**
 * Whether this client may take over the daemon it just found — A5 §F13's singleton rule, with the
 * ownership half made explicit: **a client only ever stops a daemon its own install started.**
 *
 * Two installs of one version on one machine (a source checkout beside a release, two globals)
 * otherwise evict each other on every command, which is exactly the mutual-kill storm this rule
 * exists to end. The two restart paths carry deliberately opposite burdens of proof:
 *
 * - **Upgrade** (client strictly newer) restarts unless the daemon can be PROVEN foreign. A daemon
 *   predating install identity has nothing to compare, and refusing there would break the ordinary
 *   upgrade path (issue #6) for every user exactly once.
 * - **Same version, different bytes** restarts only when the daemon can be PROVEN ours. That case
 *   means either a developer editing their own source (restart is wanted) or two installs sharing
 *   a home (restart is destructive), and unknown identity must resolve to the safe one.
 */
export function decideDaemonBuild(inputs: DaemonBuildInputs): DaemonBuildDecision {
  const { clientBuildId, clientInstallId, daemonBuildId, daemonInstallId, daemonProtocol } = inputs;
  const client = parseBuildId(clientBuildId);
  if (!client) return { action: "fail", reason: `invalid client build identity: ${clientBuildId}` };
  if (daemonBuildId === undefined) return { action: "restart", reason: "legacy" };

  const daemon = parseBuildId(daemonBuildId);
  if (!daemon) return { action: "fail", reason: `invalid daemon build identity: ${daemonBuildId}` };

  const versionOrder = Bun.semver.order(client.version, daemon.version);
  if (versionOrder > 0) {
    if (daemonInstallId !== undefined && daemonInstallId !== clientInstallId) {
      return { action: "fail", reason: foreignInstallReason(daemonBuildId), foreignInstall: true };
    }
    return { action: "restart", reason: "newer-client" };
  }
  if (versionOrder === 0 && client.sourceHash !== daemon.sourceHash) {
    if (daemonInstallId !== clientInstallId) {
      return { action: "fail", reason: foreignInstallReason(daemonBuildId), foreignInstall: true };
    }
    return { action: "restart", reason: "same-version-different-build" };
  }

  if (!protocolCompatible(PROTOCOL_VERSION, daemonProtocol)) {
    return { action: "fail", reason: incompatibleVersionsReason(daemonProtocol) };
  }
  return { action: "use" };
}

/** The decision for a peer this client has just handshaken with, using its own identity. */
function decideForPeer(hs: HandshakeResponse): DaemonBuildDecision {
  return decideDaemonBuild({
    clientBuildId: BUILD_ID,
    clientInstallId: INSTALL_ID,
    daemonBuildId: hs.build_id,
    daemonInstallId: hs.install_id,
    daemonProtocol: hs.protocol_version,
  });
}

/** How a human stops a daemon this process refuses to stop for them. For a daemon that is still
 * answering — a foreign install, an incompatible build — SIGTERM is the whole recovery. */
function manualStopHint(port: number, pid: number): string {
  return (
    `verify PID ${pid} with \`lsof -nP -iTCP:${port} -sTCP:LISTEN\`, ` +
    `stop it with \`kill -TERM ${pid}\`, then retry`
  );
}

/** The same hint for a process that holds the port but answers nothing. SIGTERM is named first
 * because it is the correct thing to try against a foreign squatter, and SIGKILL is named because
 * a wedged glosa daemon cannot run its own SIGTERM handler: the signal is delivered to a process
 * whose event loop has stopped, is queued, and is never dispatched (issue #139). Leaving SIGKILL
 * out is what left a user with no documented way back other than guessing. */
function unresponsiveStopHint(port: number, pid: number): string {
  return (
    `verify PID ${pid} with \`lsof -nP -iTCP:${port} -sTCP:LISTEN\`, then \`kill -TERM ${pid}\`; ` +
    `a wedged daemon cannot run its own shutdown, so if the PID survives, \`kill -9 ${pid}\` ends it ` +
    `and the next glosa command starts a replacement`
  );
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
  // AFTER the build check, so an older peer that has neither field keeps reporting the build
  // reason it always did. Lock and handshake are written by the same process, so absent-on-both is
  // agreement and present-on-one-side alone is a genuine disagreement — the rule `build_id`
  // already follows.
  if (lock.install_id !== hs.install_id) {
    return "daemon lock and handshake report different install identities";
  }
  return null;
}

function toConnection(port: number, hs: HandshakeResponse, home: string): DaemonConnection {
  return {
    port,
    socketPath: apiSocketPath(home),
    instanceId: hs.instance_id,
    protocolVersion: hs.protocol_version,
    buildId: hs.build_id as string,
    installId: hs.install_id,
    pid: hs.pid,
    startedAt: hs.started_at,
  };
}

/** Waits for a lock's owner to let go: the lock is removed or replaced, or the owning process
 * exits (a daemon killed mid-shutdown leaves its lock behind, which the next pass reclaims through
 * the dead-PID path). */
async function waitForExitingOwner(
  lockFile: string,
  lock: DaemonLock,
  timeoutMs: number,
  deps: DiscoveryDependencies,
): Promise<"released" | "exited" | "timeout"> {
  const deadline = deps.now() + timeoutMs;
  while (true) {
    if (!sameLockInstance(readLock(lockFile), lock)) return "released";
    if (!deps.pidAlive(lock.pid)) return "exited";
    if (deps.now() >= deadline) return "timeout";
    await deps.sleep(Math.min(50, Math.max(1, remainingMs(deadline, deps.now))));
  }
}

/** Deliberately specific rather than the generic deadline failure: what this client learned is that
 * a named process is still shutting down, and waiting a little longer is usually all it takes. */
function stillExitingFailure(
  home: string,
  lock: DaemonLock,
  waitedMs: number,
): Extract<EnsureDaemonResult, { ok: false }> {
  log(
    home,
    `lock pid ${lock.pid} is a glosa daemon still shutting down after ${Math.round(waitedMs)}ms; not spawning a replacement beside it`,
  );
  return {
    ok: false,
    reason:
      `the previous glosa daemon (PID ${lock.pid}) is still shutting down and has not released its lock ` +
      `after ${Math.round(waitedMs)}ms; retry in a few seconds. If it keeps holding it: ${unresponsiveStopHint(lock.port, lock.pid)}`,
    logPath: logPath(home),
  };
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

/** Internal composition seam; not re-exported from the daemon package or exposed through config. */
export interface DiscoveryDependencies {
  now: () => number;
  sleep: (ms: number) => Promise<unknown>;
  fetchHandshake: typeof fetchHandshake;
  pollHandshake: typeof pollHandshake;
  probe: typeof probePortBound;
  bindable: typeof probePortBindable;
  pidAlive: (pid: number) => boolean;
  /** Whether a live PID is still a glosa daemon rather than a reused PID. */
  isDaemonProcess: (pid: number) => boolean;
}
const discoveryDefaults: DiscoveryDependencies = {
  now: () => performance.now(),
  sleep: Bun.sleep,
  fetchHandshake,
  pollHandshake,
  probe: probePortBound,
  bindable: probePortBindable,
  pidAlive: isPidAlive,
  isDaemonProcess: isGlosaDaemonProcess,
};

/** Every daemon is spawned as `<bun> <main> __daemon` (see `spawnAndWait`), so the argument is the
 * marker. Reading it through `ps` is macOS/POSIX, which is the v1 platform. An unreadable process
 * counts as not a daemon, which keeps today's behaviour for it. */
export function isGlosaDaemonProcess(pid: number): boolean {
  try {
    const result = Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
    if (result.exitCode !== 0) return false;
    return /(^|\s)__daemon(\s|$)/.test(result.stdout.toString().trim());
  } catch {
    return false;
  }
}

export async function ensureDaemon(options: EnsureDaemonOptions = {}): Promise<EnsureDaemonResult> {
  return ensureDaemonWithDependencies(options);
}

export async function ensureDaemonWithDependencies(
  options: EnsureDaemonOptions = {},
  overrides: Partial<DiscoveryDependencies> = {},
): Promise<EnsureDaemonResult> {
  const deps = { ...discoveryDefaults, ...overrides };

  const home = ensureHomeDir(glosaHome());
  const lockFile = lockPath(home);
  const seedPort = glosaPort();
  const timeoutMs = options.timeoutMs ?? DEFAULT_ENSURE_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    return spawnFailed(home, `invalid daemon discovery timeout: ${String(timeoutMs)}`);
  }
  const deadline = deps.now() + timeoutMs;
  let preferredPort = seedPort;
  let spawnAttempted = false;

  for (let pass = 0; pass < ENSURE_MAX_PASSES; pass += 1) {
    if (remainingMs(deadline, deps.now) <= 0) return deadlineFailure(home, timeoutMs);
    const lock = readLock(lockFile);
    const identityError = malformedLockBuildIdentity(lockFile);
    if (identityError) return { ok: false, reason: identityError, logPath: logPath(home) };
    if (!lock) {
      // A daemon can be alive briefly without a lock while a concurrent replacement is still
      // settling. Re-probing the seed port prevents every client from spawning a losing contender
      // into an already occupied port; ownership is unknowable, so this remains fail-closed.
      const hs = await deps.fetchHandshake(
        preferredPort,
        Math.min(HANDSHAKE_TIMEOUT_MS, remainingMs(deadline, deps.now)),
      );
      if (hs) {
        // A current daemon repairs a missing lock from inside its own handshake handler. Trust it
        // only after the newly visible daemon-written record agrees with that handshake; the next
        // pass then applies the ordinary build/protocol decision using lock.port as authority.
        const failure = locklessHandshakeResult(home, lockFile, preferredPort, hs);
        if (!failure) continue;
        return failure;
      }

      // The daemon-owned watchdog may have repaired the record even when the response that
      // triggered or overlapped that repair missed the one-second fetch budget.
      if (existsSync(lockFile)) continue;

      const portState = await confirmPortFree(preferredPort, {
        ...deps,
        deadline,
        ownershipUnchanged: () => !existsSync(lockFile),
      });
      if (portState === "ownership-changed") continue;
      if (portState === "deadline") return deadlineFailure(home, timeoutMs);
      if (portState === "bound") {
        const pollBudget = Math.min(HANDSHAKE_POLL_MS, remainingMs(deadline, deps.now));
        const peer =
          pollBudget > 0 ? await deps.pollHandshake(preferredPort, pollBudget, 100, () => existsSync(lockFile)) : null;
        if (existsSync(lockFile)) continue;
        if (peer) {
          const failure = locklessHandshakeResult(home, lockFile, preferredPort, peer);
          if (!failure) continue;
          return failure;
        }
        // Deliberately NOT gated on the remaining budget. This is a PROVEN diagnosis — the port
        // is held and nothing there speaks glosa — and it names the recovery. Returning the
        // generic "discovery exceeded its budget" instead, just because polling for a handshake
        // consumed the deadline, is how issue #139 reached a user as a timeout with nothing to act
        // on. A deadline is what we ran out of, never the most specific thing we learned.
        return spawnFailed(
          home,
          `a process is bound to port ${preferredPort} but is not answering the glosa handshake; ` +
            "ownership cannot be established safely, so no daemon was spawned — find it with " +
            `\`lsof -nP -iTCP:${preferredPort} -sTCP:LISTEN\``,
        );
      }

      // Re-read immediately before spawning: a watchdog or concurrent daemon may have repaired or
      // created the lock after the last refused connection.
      if (existsSync(lockFile)) continue;
      if (spawnAttempted) {
        return spawnFailed(home, "daemon ownership was not established after the single permitted spawn attempt");
      }
      spawnAttempted = true;
      const spawnFailure = await spawnAndWait(home, preferredPort, deadline, timeoutMs, deps);
      if (spawnFailure) return spawnFailure;
      continue;
    }

    preferredPort = lock.port;
    const pidAlive = deps.pidAlive(lock.pid);
    if (pidAlive) {
      const pollBudget = Math.min(HANDSHAKE_POLL_MS, remainingMs(deadline, deps.now));
      const hs = pollBudget > 0 ? await deps.pollHandshake(lock.port, pollBudget) : null;
      if (hs) {
        const mismatch = daemonPeerMismatchReason(lock, hs);
        if (mismatch) {
          // The lock can legitimately roll over while this client is awaiting the handshake: a
          // concurrent client may have replaced an older daemon. Only retry when that ownership
          // change is observable; an unchanged mismatched lock remains fail-closed.
          const currentLock = readLock(lockFile);
          if (!currentLock || currentLock.instance_id !== lock.instance_id) continue;
          return { ok: false, reason: mismatch, logPath: logPath(home) };
        }

        const decision = decideForPeer(hs);
        if (decision.action === "use") {
          // A daemon that serves no socket cannot be talked to by this client at all: every
          // authenticated request goes over `<GLOSA_HOME>/run/api.sock`, and there is deliberately
          // no fall back to the port (A3 §3.2 — a fallback would hand a squatter the entire
          // defense, since making the socket look absent is free). Refuse here, at resolve time,
          // where the message can name the recovery, rather than at the first request.
          if (hs.serves_socket !== true) {
            log(home, `refusing ${hs.instance_id}: daemon predates the local socket listener`);
            return {
              ok: false,
              reason:
                `the glosa daemon on port ${lock.port} predates this client's local socket and ` +
                `cannot be reached securely — ${manualStopHint(lock.port, hs.pid)}`,
              logPath: logPath(home),
            };
          }
          return { ok: true, ...toConnection(lock.port, hs, home) };
        }
        if (decision.action === "fail") {
          // A refusal has to be as traceable as a takeover, and as actionable: this is the branch
          // a user meets when a second install owns the port, so it carries the log pointer the
          // neighbouring failures already had, plus how to stop the other daemon by hand.
          if (decision.foreignInstall) {
            log(home, `refusing ${hs.instance_id}: foreign install (${hs.install_id ?? "unknown"} != ${INSTALL_ID})`);
            return {
              ok: false,
              reason: `${decision.reason} — ${manualStopHint(lock.port, hs.pid)}`,
              logPath: logPath(home),
            };
          }
          return { ok: false, reason: decision.reason, logPath: logPath(home) };
        }

        log(home, `refreshing ${hs.instance_id}: ${decision.reason} (${hs.build_id ?? "legacy"} -> ${BUILD_ID})`);
        try {
          process.kill(hs.pid, "SIGTERM");
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
            return { ok: false, reason: `could not stop stale glosa daemon: ${(err as Error).message}` };
          }
        }
        const restartBudget = Math.min(EXITING_DAEMON_WAIT_MS, remainingMs(deadline, deps.now));
        if (restartBudget <= 0) return deadlineFailure(home, timeoutMs);
        if ((await waitForExitingOwner(lockFile, lock, restartBudget, deps)) === "timeout") {
          return stillExitingFailure(home, lock, restartBudget);
        }
        continue;
      }

      // Alive pid, no valid handshake within the ≤5s budget: a hung glosa daemon and a foreign
      // squatter on lock.port are indistinguishable from here. Only reclaim when the port is
      // stably free and the exact ownership record remains unchanged.
      const portState = await confirmPortFree(lock.port, {
        ...deps,
        deadline,
        ownershipUnchanged: () => sameLockInstance(readLock(lockFile), lock),
      });
      if (portState === "ownership-changed") continue;
      if (portState === "deadline") return deadlineFailure(home, timeoutMs);
      if (portState === "bound") {
        log(home, `lock pid ${lock.pid} alive, port ${lock.port} bound but not answering the glosa handshake`);
        return {
          ok: false,
          reason:
            `a process is bound to port ${lock.port} but is not answering the glosa handshake; ` +
            "the daemon may be wedged or the port is taken by another process — not spawning a " +
            `duplicate. To clear it: ${unresponsiveStopHint(lock.port, lock.pid)}`,
          logPath: logPath(home),
        };
      }
      // A free port with a live PID is also exactly what a daemon looks like between closing its
      // listeners and removing its lock on the way out, which can take seconds. Reclaiming that
      // lock started a second daemon beside one that was still closing its workspaces. So a PID
      // that is still a glosa daemon is waited for; only a PID the OS has since handed to some
      // other program is reclaimed at once.
      if (deps.isDaemonProcess(lock.pid)) {
        const budget = Math.min(EXITING_DAEMON_WAIT_MS, remainingMs(deadline, deps.now));
        if ((await waitForExitingOwner(lockFile, lock, budget, deps)) === "timeout") {
          return stillExitingFailure(home, lock, budget);
        }
        continue;
      }
      log(
        home,
        `lock pid ${lock.pid} alive but not a glosa daemon, and port ${lock.port} is free — treating lock as stale`,
      );
    } else {
      // A dead PID does not prove the recorded port is free: the PID may have exited while a
      // replacement is binding, or another process may now own the port. Use the same stable,
      // ownership-checked evidence required for the alive-but-unresponsive path.
      const portState = await confirmPortFree(lock.port, {
        ...deps,
        deadline,
        ownershipUnchanged: () => sameLockInstance(readLock(lockFile), lock),
      });
      if (portState === "ownership-changed") continue;
      if (portState === "deadline") return deadlineFailure(home, timeoutMs);
      if (portState === "bound") {
        return spawnFailed(
          home,
          `daemon lock PID ${lock.pid} is not alive, but port ${lock.port} is bound; ` +
            "ownership cannot be established safely, so the lock was retained and no daemon was spawned",
        );
      }
      log(home, `lock pid ${lock.pid} is not alive and port ${lock.port} is stably free — treating lock as stale`);
    }

    if (!sameLockInstance(readLock(lockFile), lock)) continue;
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

function spawnFailed(home: string, reason: string): Extract<EnsureDaemonResult, { ok: false }> {
  const daemonLog = logPath(home);
  return {
    ok: false,
    reason: reason.includes(daemonLog) ? reason : `${reason} — see ${daemonLog}`,
    logPath: daemonLog,
  };
}

async function spawnAndWait(
  home: string,
  port: number,
  deadline: number,
  timeoutMs: number,
  deps: DiscoveryDependencies,
): Promise<Extract<EnsureDaemonResult, { ok: false }> | null> {
  const mainPath = fileURLToPath(new URL("../../../cli/src/main.ts", import.meta.url));
  const logFd = openSync(logPath(home), "a");
  const env = buildChildEnv(Bun.env, { home, port });

  const child = Bun.spawn({
    cmd: [process.execPath, mainPath, "__daemon"],
    stdio: ["ignore", logFd, logFd],
    env,
  });
  child.unref();
  closeSync(logFd); // child holds its own dup'd copy; safe to release ours

  const pollBudget = Math.min(HANDSHAKE_POLL_MS, remainingMs(deadline, deps.now));
  if (pollBudget <= 0) return deadlineFailure(home, timeoutMs);
  const hs = await deps.pollHandshake(port, pollBudget, 100, () => child.exitCode !== null);
  if (hs) return null;

  // Child already gone: a peer may have won the bind race (exit 0), or this spawn lost to a
  // foreign squatter / crashed before serving. Do not burn the rest of the 5s poll budget.
  if (child.exitCode === 0) {
    const peerBudget = Math.min(HANDSHAKE_TIMEOUT_MS, remainingMs(deadline, deps.now));
    const peer = peerBudget > 0 ? await deps.fetchHandshake(port, peerBudget) : null;
    if (peer) return null;
  }
  if (child.exitCode !== null) {
    const probeBudget = Math.min(HANDSHAKE_TIMEOUT_MS, remainingMs(deadline, deps.now));
    if (probeBudget <= 0) return deadlineFailure(home, timeoutMs);
    if (await deps.probe(port, probeBudget)) {
      return spawnFailed(
        home,
        `a process is bound to port ${port} but is not answering the glosa handshake; the daemon could not bind`,
      );
    }
    return spawnFailed(home, `daemon exited before becoming ready (exit ${child.exitCode})`);
  }

  if (remainingMs(deadline, deps.now) <= 0) return deadlineFailure(home, timeoutMs);
  return spawnFailed(home, `daemon did not become ready within ${pollBudget}ms`);
}

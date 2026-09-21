// SPDX-License-Identifier: Apache-2.0
// Claude Code plugin monitor: a read-only workspace-index watcher and connect-only transport for
// the daemon's provider-neutral session stream. It never starts, stops, or repairs a daemon.
import { lstatSync, readFileSync, realpathSync, watch } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { DeliverableEntry } from "../../../daemon/src/agent-provider/interface.ts";
import { BUILD_ID } from "../../../daemon/src/lifecycle/build-id.ts";
import { daemonPeerMismatchReason } from "../../../daemon/src/lifecycle/daemon.ts";
import { fetchHandshake } from "../../../daemon/src/lifecycle/handshake.ts";
import { apiSocketPath, glosaHome, lockPath } from "../../../daemon/src/lifecycle/home.ts";
import { INSTALL_ID } from "../../../daemon/src/lifecycle/install.ts";
import { readLock } from "../../../daemon/src/lifecycle/lock.ts";
import { PROTOCOL_VERSION, protocolCompatible } from "../../../daemon/src/lifecycle/protocol.ts";
import { authedRequest } from "../../../daemon/src/security/authed-request.ts";
import { claudeConfigRoots, confineTranscriptPath } from "../../../daemon/src/transcript/root.ts";
import { workspaceIndexPath, type WorkspaceIndexFile } from "../../../daemon/src/registry/workspace-index.ts";

export const MONITOR_MIN_DELAY_MS = 5_000;
export const MONITOR_MAX_DELAY_MS = 60_000;
export const MONITOR_BACKOFF_FACTOR = 2;
export const MONITOR_JITTER_RATIO = 0.2;

/** #206: how a superseded monitor decides whether the session is free again — a fixed interval plus
 * jitter, never tighter than the retry floor above, and no backoff growth (a park is not a
 * failure). */
export const PARK_PROBE_BASE_MS = 15_000;
export const PARK_PROBE_JITTER_MS = 3_000;
/** How many consecutive proven-free probes the parked side needs before it resumes (#206
 * follow-up). One is not enough: it cannot tell a departed owner from an owner reconnecting on the
 * `MONITOR_MIN_DELAY_MS` floor, and treating that gap as freedom is what let both monitors resume
 * and print. Two, a full park interval apart, is the smallest count that outlives an ordinary
 * reconnect. */
export const PARK_FREE_PROBES_REQUIRED = 2;

export function parkProbeDelay(random: () => number = Math.random): number {
  return PARK_PROBE_BASE_MS + Math.floor(PARK_PROBE_JITTER_MS * random());
}

/** #206 review round 1 (F-7): bounds a single ownership-probe HTTP round trip so a request that is
 * accepted but never answers cannot hang the park loop forever — a timeout is inconclusive, exactly
 * like a network error or a malformed body. Kept below the probe interval floor so a stalled
 * request cannot itself delay the next scheduled probe. */
export const PARK_PROBE_REQUEST_TIMEOUT_MS = 4_000;

/** #206: how long, after a delivery write or its transport acknowledgement fails while the stream
 * is still open, `registerAndStream` keeps reading before giving up on seeing a `superseded` frame.
 * Replacement deletes the OLD connection's pending acknowledgement, so a failure right there is the
 * expected shape of a mid-delivery displacement, not a reason to reconnect and re-displace the new
 * owner — but an ordinary failure on a healthy connection must not hang forever either. *
 * 12 s, not the 2 s this shipped with (and deliberately not 15 s, which would collide with the
 * park-probe interval and make the two sleeps indistinguishable to a test). CI run 35039592341 saw a
 * displaced monitor deliver an entry only the owner should have had; its log proves that duplicate
 * delivery but records neither monitor's timeline nor how the stream end was classified, so this
 * race is the strongest explanation from the code rather than an observed one. Waiting longer costs nothing in the case this exists for —
 * replacement closes the stream immediately, so EOF ends the wait — and only delays surfacing a
 * genuine handling error on a stream that stays healthy. */
export const STREAM_FAILURE_DEADLINE_MS = 12_000;

export interface MonitorOptions {
  sessionId: string;
  projectDir: string;
  pluginRoot: string;
}

export interface MonitorDeps {
  home: () => string;
  fetch: typeof fetch;
  stdout: { write(chunk: string, callback: (error?: Error | null) => void): unknown };
  random: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  waitForWorkspaceChange: (path: string, signal: AbortSignal) => Promise<void>;
  /** #206 review round 1 (F-7): the parked probe's absolute cadence is scheduled from this clock,
   * not from wall-clock `Date.now()` directly, so tests can compress a slow-but-bounded probe's
   * effect on the NEXT probe's spacing without any real waiting. */
  now: () => number;
}

/** What `resolveDaemon` hands to the stream loop. Note what is NOT here: the pairing token.
 * It used to be, captured once and reused for the whole stream, which meant a `glosa token
 * rotate` mid-stream turned every later transport-ack into a silent 401 — the defect
 * `daemon-client.ts` had already fixed on its side. `authedRequest` reads the credential per
 * request instead, so the monitor picks up a rotation the same way every other client does. */
interface ExistingDaemon {
  port: number;
  socketPath: string;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", cancel);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const cancel = () => {
      clearTimeout(timer);
      finish();
    };
    signal.addEventListener("abort", cancel, { once: true });
  });
}

function defaultWaitForWorkspaceChange(path: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      watcher?.close();
      signal.removeEventListener("abort", finish);
      resolve();
    };
    let watcher: ReturnType<typeof watch> | undefined;
    try {
      watcher = watch(dirname(path), (_event, filename) => {
        if (filename === null || filename.toString() === "workspaces.json") finish();
      });
      watcher.on("error", finish);
    } catch {
      // The home may not exist yet. The bounded wake below retries discovery without creating it.
    }
    timer = setTimeout(finish, 30_000);
    timer.unref?.();
    signal.addEventListener("abort", finish, { once: true });
  });
}

export function realMonitorDeps(): MonitorDeps {
  return {
    home: glosaHome,
    fetch,
    stdout: process.stdout,
    random: Math.random,
    sleep: defaultSleep,
    waitForWorkspaceChange: defaultWaitForWorkspaceChange,
    now: Date.now,
  };
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

export function registeredWorkspaceForProject(path: string, projectDir: string): string | null {
  let canonicalProject: string;
  try {
    canonicalProject = realpathSync(projectDir);
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as WorkspaceIndexFile;
    const candidates = Object.values(parsed.workspaces)
      .filter((entry) => entry.present && (entry.lifecycle?.state ?? "active") === "active")
      .filter((entry) => isWithin(entry.canonical_path, canonicalProject))
      .sort((a, b) => b.canonical_path.length - a.canonical_path.length);
    return candidates[0]?.canonical_path ?? null;
  } catch {
    return null;
  }
}

export function deriveMonitorTranscriptPath(sessionId: string, projectDir: string): string | undefined {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) return undefined;
  const encodedCwd = projectDir.replace(/[^a-zA-Z0-9]/g, "-");
  const candidates = new Set<string>();
  for (const root of claudeConfigRoots()) {
    const path = join(root, "projects", encodedCwd, `${sessionId}.jsonl`);
    try {
      if (lstatSync(path).isFile() && confineTranscriptPath(path, [root]).ok) candidates.add(realpathSync(path));
    } catch {
      // A fresh session may not have written its transcript yet.
    }
  }
  return candidates.size === 1 ? [...candidates][0] : undefined;
}

/** FIRST resolution only, and read-only by contract: A3 §3 requires the monitor's daemon
 * discovery to "never start, repair, replace, or stop a process", which is why this cannot use
 * `ensureDaemon` — that spawns. The acceptance policy lives here because it answers "SHOULD I use
 * this daemon", which is settled once. Where the credential goes is not settled here at all: it
 * goes to this home's socket, and the kernel decides who may open that. */
async function existingDaemon(home: string): Promise<ExistingDaemon | null> {
  const lock = readLock(lockPath(home));
  if (!lock) return null;
  const handshake = await fetchHandshake(lock.port, 500);
  if (!handshake || daemonPeerMismatchReason(lock, handshake) !== null) return null;
  if (!protocolCompatible(PROTOCOL_VERSION, handshake.protocol_version)) return null;
  if (handshake.install_id !== INSTALL_ID || handshake.build_id !== BUILD_ID) return null;
  // A daemon that serves no socket cannot be reached by this monitor at all, and there is
  // deliberately no fall back to its port (A3 §3.2). Refusing is the whole point: a fallback
  // would mean anything that makes the socket look absent gets the credential over TCP.
  if (handshake.serves_socket !== true) return null;
  return { port: lock.port, socketPath: apiSocketPath(home) };
}

async function writeLine(output: MonitorDeps["stdout"], line: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    output.write(`${line}\n`, (error) => (error ? reject(error) : resolve()));
  });
}

export interface SessionStreamEnd {
  ended: "superseded" | "eof";
}

async function registerAndStream(
  options: MonitorOptions,
  workspace: string,
  connection: ExistingDaemon,
  deps: MonitorDeps,
  signal: AbortSignal,
): Promise<SessionStreamEnd> {
  const home = deps.home();
  const transcriptPath = deriveMonitorTranscriptPath(options.sessionId, options.projectDir);
  const registered = await authedRequest(
    connection,
    {
      path: "/api/sessions/register",
      method: "POST",
      contentType: "application/json",
      extraHeaders: { "X-Contract-Version": PROTOCOL_VERSION },
      body: JSON.stringify({
        session_id: options.sessionId,
        provider: "claude-code",
        cwd: options.projectDir,
        workspace_binding: workspace,
        source: "monitor",
        ...(transcriptPath ? { transcript_path: transcriptPath } : {}),
      }),
      signal,
    },
    home,
    deps.fetch,
  );
  if (!registered.ok) throw new Error(`session registration failed (${registered.status})`);
  const response = await authedRequest(
    connection,
    {
      path: `/api/sessions/${encodeURIComponent(options.sessionId)}/stream`,
      method: "GET",
      extraHeaders: { "X-Contract-Version": PROTOCOL_VERSION },
      signal,
    },
    home,
    deps.fetch,
  );
  if (!response.ok) throw new Error(`session stream failed (${response.status})`);
  if (!response.body) throw new Error("session stream has no body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let superseded = false;
  // #206: set once a delivery write or its transport acknowledgement fails while the stream is
  // still open. Supersession takes precedence — keep reading toward EOF instead of surfacing the
  // failure immediately, bounded so an ordinary failure still gets reported promptly.
  let failure: { error: unknown } | undefined;
  let deadlineAt = 0;

  while (!signal.aborted) {
    if (failure && Date.now() >= deadlineAt) throw failure.error;
    let done: boolean;
    let value: Uint8Array | undefined;
    if (failure) {
      const remaining = Math.max(0, deadlineAt - Date.now());
      const raced = await Promise.race([
        reader.read().then((r) => ({ timedOut: false as const, r })),
        deps.sleep(remaining, signal).then(() => ({ timedOut: true as const })),
      ]);
      if (raced.timedOut) throw failure.error;
      ({ done, value } = raced.r);
    } else {
      ({ done, value } = await reader.read());
    }
    if (done) {
      if (failure) {
        if (superseded) return { ended: "superseded" };
        throw failure.error;
      }
      return { ended: superseded ? "superseded" : "eof" };
    }
    buffered += decoder.decode(value, { stream: true });
    let boundary = buffered.indexOf("\n\n");
    while (boundary >= 0) {
      const frame = buffered.slice(0, boundary);
      buffered = buffered.slice(boundary + 2);
      boundary = buffered.indexOf("\n\n");
      const event = frame.match(/^event:\s*(.+)$/m)?.[1];
      if (event === "superseded") {
        superseded = true;
        continue;
      }
      if (event !== "delivery" || failure) continue;
      const data = frame.match(/^data:\s*(.+)$/m)?.[1];
      if (!data) continue;
      const entry = JSON.parse(data) as DeliverableEntry;
      try {
        await writeLine(deps.stdout, `[glosa ${entry.id}] ${JSON.stringify(entry)}`);
        // A separate authenticated request, minutes or hours after the stream opened — it does
        // NOT inherit the open-time credential, it resolves one of its own.
        const ack = await authedRequest(
          connection,
          {
            path: `/api/sessions/${encodeURIComponent(options.sessionId)}/stream/${encodeURIComponent(entry.id)}/transport-ack`,
            method: "POST",
            extraHeaders: { "X-Contract-Version": PROTOCOL_VERSION },
            body: "{}",
            signal,
          },
          home,
          deps.fetch,
        );
        if (!ack.ok) throw new Error(`stream acknowledgement failed (${ack.status})`);
      } catch (error) {
        failure = { error };
        deadlineAt = Date.now() + STREAM_FAILURE_DEADLINE_MS;
      }
    }
  }
  return { ended: superseded ? "superseded" : "eof" };
}

/** #206: parked between a `superseded` end and an authoritative `connected:false` (including an
 * unknown session — the normal loop's own register/stream decides from there). No register, no
 * stream, no delivery output, no lease hold while parked. Every probe re-runs daemon discovery
 * (`existingDaemon`) and re-reads credentials from scratch.
 *
 * Review round 1 (F-6): only a LITERAL boolean `connected` field is authoritative. `{}`, `[]`,
 * `{connected:null}`, a non-2xx status, a network error, an unparseable body, and (F-7) a request
 * that never answers within `PARK_PROBE_REQUEST_TIMEOUT_MS` are ALL `null` (inconclusive) — the
 * caller keeps parking on anything but a proven `false`. The request is bounded and its own
 * `AbortController` is aborted in `finally` regardless of which side of the race wins, so a slow
 * daemon never keeps the underlying fetch alive past this function's return. */
async function probeStreamConnected(
  sessionId: string,
  deps: MonitorDeps,
  signal: AbortSignal,
): Promise<boolean | null> {
  const probeAbort = new AbortController();
  const combined = AbortSignal.any([signal, probeAbort.signal]);
  const attempt = (async (): Promise<boolean | null> => {
    const connection = await existingDaemon(deps.home());
    if (!connection) return null;
    let res: Response;
    try {
      res = await authedRequest(
        connection,
        {
          path: `/api/sessions/${encodeURIComponent(sessionId)}/stream/status`,
          method: "GET",
          extraHeaders: { "X-Contract-Version": PROTOCOL_VERSION },
          signal: combined,
        },
        deps.home(),
        deps.fetch,
      );
    } catch {
      return null;
    }
    if (!res.ok) return null;
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return null;
    }
    // A top-level `null` parses fine and is not an object; reading a field off it throws, which
    // would escape this probe as a rejection rather than an inconclusive answer. Check the
    // envelope before the field (review round 2, F-6).
    if (typeof body !== "object" || body === null) return null;
    const connected = (body as { connected?: unknown }).connected;
    if (connected === true) return true;
    if (connected === false) return false;
    return null;
  })();
  try {
    const outcome = await Promise.race([
      attempt.then((v) => ({ timedOut: false as const, v })),
      deps.sleep(PARK_PROBE_REQUEST_TIMEOUT_MS, combined).then(() => ({ timedOut: true as const })),
    ]);
    return outcome.timedOut ? null : outcome.v;
  } finally {
    probeAbort.abort();
  }
}

/** Review round 1 (F-7): schedules each probe from an ABSOLUTE cadence — `dueAt` advances by
 * `parkProbeDelay()` every iteration regardless of how long the previous probe itself took (now
 * bounded by `PARK_PROBE_REQUEST_TIMEOUT_MS`) — so the gap between probe STARTS stays within the
 * contract's interval instead of drifting by however long each request happened to take. */
async function parkUntilFree(sessionId: string, deps: MonitorDeps, signal: AbortSignal): Promise<void> {
  let dueAt = deps.now();
  let freeProbes = 0;
  while (!signal.aborted) {
    dueAt += parkProbeDelay(deps.random);
    await deps.sleep(Math.max(0, dueAt - deps.now()), signal);
    if (signal.aborted) return;
    const connected = await probeStreamConnected(sessionId, deps, signal);
    // A single `connected:false` does not mean the session is free — it can equally be the OWNER
    // between two connections. The owner's ordinary retry floor is `MONITOR_MIN_DELAY_MS` (5s),
    // well inside one park interval (15–18s), so a probe landing in that gap would hand ownership
    // to the parked side and leave both processes printing. That is the failure this guard exists
    // for: two real monitors both resumed at ~16s and ~17.5s, each reprinting the same entry.
    //
    // Requiring TWO consecutive proven `false` probes, a full interval apart, means an owner doing
    // an ordinary reconnect is back before the second one. A genuinely departed owner costs one
    // extra interval before the parked side takes over — latency on a fallback path, against a
    // correctness bug on the main one.
    if (connected === false) {
      freeProbes += 1;
      if (freeProbes >= PARK_FREE_PROBES_REQUIRED) return;
      continue;
    }
    // Anything else — connected, or inconclusive — restarts the count. An inconclusive probe is not
    // evidence of freedom, so it must not carry a previous `false` forward.
    freeProbes = 0;
  }
}

export function monitorRetryDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(MONITOR_MAX_DELAY_MS, MONITOR_MIN_DELAY_MS * MONITOR_BACKOFF_FACTOR ** attempt);
  const jitter = Math.min(MONITOR_MAX_DELAY_MS - base, Math.floor(base * MONITOR_JITTER_RATIO * random()));
  return base + jitter;
}

export async function runClaudeMonitor(
  options: MonitorOptions,
  deps: MonitorDeps = realMonitorDeps(),
  signal: AbortSignal = AbortSignal.any([]),
): Promise<void> {
  const indexPath = workspaceIndexPath(deps.home());
  let attempt = 0;
  while (!signal.aborted) {
    const workspace = registeredWorkspaceForProject(indexPath, options.projectDir);
    if (!workspace) {
      attempt = 0;
      await deps.waitForWorkspaceChange(indexPath, signal);
      continue;
    }
    let superseded = false;
    try {
      const connection = await existingDaemon(deps.home());
      if (!connection) throw new Error("daemon unavailable");
      const connectedAt = Date.now();
      const result = await registerAndStream(options, workspace, connection, deps, signal);
      if (Date.now() - connectedAt >= 20_000) attempt = 0;
      superseded = result.ended === "superseded";
    } catch {
      if (signal.aborted) return;
    }
    if (superseded) {
      await parkUntilFree(options.sessionId, deps, signal);
      attempt = 0;
      continue;
    }
    await deps.sleep(monitorRetryDelay(attempt, deps.random), signal);
    attempt = Math.min(attempt + 1, 31);
  }
}

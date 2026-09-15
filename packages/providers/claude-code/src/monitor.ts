// SPDX-License-Identifier: Apache-2.0
// Claude Code plugin monitor: a read-only workspace-index watcher and connect-only transport for
// the daemon's provider-neutral session stream. It never starts, stops, or repairs a daemon.
import { lstatSync, readFileSync, realpathSync, watch } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { DeliverableEntry } from "../../../daemon/src/agent-provider/interface.ts";
import { BUILD_ID } from "../../../daemon/src/lifecycle/build-id.ts";
import { daemonPeerMismatchReason } from "../../../daemon/src/lifecycle/daemon.ts";
import { fetchHandshake } from "../../../daemon/src/lifecycle/handshake.ts";
import { glosaHome, lockPath } from "../../../daemon/src/lifecycle/home.ts";
import { INSTALL_ID } from "../../../daemon/src/lifecycle/install.ts";
import { readLock } from "../../../daemon/src/lifecycle/lock.ts";
import { PROTOCOL_VERSION, protocolCompatible } from "../../../daemon/src/lifecycle/protocol.ts";
import { loadToken } from "../../../daemon/src/security/token.ts";
import { claudeConfigRoots, confineTranscriptPath } from "../../../daemon/src/transcript/root.ts";
import { workspaceIndexPath, type WorkspaceIndexFile } from "../../../daemon/src/registry/workspace-index.ts";

export const MONITOR_MIN_DELAY_MS = 5_000;
export const MONITOR_MAX_DELAY_MS = 60_000;
export const MONITOR_BACKOFF_FACTOR = 2;
export const MONITOR_JITTER_RATIO = 0.2;

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
}

interface ExistingDaemon {
  port: number;
  token: string;
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

async function existingDaemon(home: string): Promise<ExistingDaemon | null> {
  const lock = readLock(lockPath(home));
  if (!lock) return null;
  const handshake = await fetchHandshake(lock.port, 500);
  if (!handshake || daemonPeerMismatchReason(lock, handshake) !== null) return null;
  if (!protocolCompatible(PROTOCOL_VERSION, handshake.protocol_version)) return null;
  if (handshake.install_id !== INSTALL_ID || handshake.build_id !== BUILD_ID) return null;
  try {
    const token = loadToken(home);
    return token ? { port: lock.port, token } : null;
  } catch {
    return null;
  }
}

function headers(connection: ExistingDaemon): HeadersInit {
  const base = `http://127.0.0.1:${connection.port}`;
  return {
    Host: `127.0.0.1:${connection.port}`,
    Origin: base,
    Authorization: `Bearer ${connection.token}`,
    "X-Contract-Version": PROTOCOL_VERSION,
  };
}

async function writeLine(output: MonitorDeps["stdout"], line: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    output.write(`${line}\n`, (error) => (error ? reject(error) : resolve()));
  });
}

async function registerAndStream(
  options: MonitorOptions,
  workspace: string,
  connection: ExistingDaemon,
  deps: MonitorDeps,
  signal: AbortSignal,
): Promise<void> {
  const base = `http://127.0.0.1:${connection.port}`;
  const transcriptPath = deriveMonitorTranscriptPath(options.sessionId, options.projectDir);
  const registered = await deps.fetch(`${base}/api/sessions/register`, {
    method: "POST",
    headers: { ...headers(connection), "Content-Type": "application/json" },
    body: JSON.stringify({
      session_id: options.sessionId,
      provider: "claude-code",
      cwd: options.projectDir,
      workspace_binding: workspace,
      source: "monitor",
      ...(transcriptPath ? { transcript_path: transcriptPath } : {}),
    }),
    signal,
  });
  if (!registered.ok) throw new Error(`session registration failed (${registered.status})`);
  const response = await deps.fetch(`${base}/api/sessions/${encodeURIComponent(options.sessionId)}/stream`, {
    headers: headers(connection),
    signal,
  });
  if (!response.ok) throw new Error(`session stream failed (${response.status})`);
  if (!response.body) throw new Error("session stream has no body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  while (!signal.aborted) {
    const { done, value } = await reader.read();
    if (done) return;
    buffered += decoder.decode(value, { stream: true });
    let boundary = buffered.indexOf("\n\n");
    while (boundary >= 0) {
      const frame = buffered.slice(0, boundary);
      buffered = buffered.slice(boundary + 2);
      boundary = buffered.indexOf("\n\n");
      if (frame.match(/^event:\s*(.+)$/m)?.[1] !== "delivery") continue;
      const data = frame.match(/^data:\s*(.+)$/m)?.[1];
      if (!data) continue;
      const entry = JSON.parse(data) as DeliverableEntry;
      await writeLine(deps.stdout, `[glosa ${entry.id}] ${JSON.stringify(entry)}`);
      const ack = await deps.fetch(
        `${base}/api/sessions/${encodeURIComponent(options.sessionId)}/stream/${encodeURIComponent(entry.id)}/transport-ack`,
        { method: "POST", headers: headers(connection), body: "{}", signal },
      );
      if (!ack.ok) throw new Error(`stream acknowledgement failed (${ack.status})`);
    }
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
    try {
      const connection = await existingDaemon(deps.home());
      if (!connection) throw new Error("daemon unavailable");
      const connectedAt = Date.now();
      await registerAndStream(options, workspace, connection, deps, signal);
      if (Date.now() - connectedAt >= 20_000) attempt = 0;
    } catch {
      if (signal.aborted) return;
    }
    await deps.sleep(monitorRetryDelay(attempt, deps.random), signal);
    attempt = Math.min(attempt + 1, 31);
  }
}

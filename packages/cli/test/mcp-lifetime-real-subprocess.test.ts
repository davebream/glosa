// SPDX-License-Identifier: Apache-2.0
// Issue #140: the MCP shim's shutdown owner, proven at real OS process boundaries. Every scenario
// here asserts against the real child's exit status, its PID's disappearance, or the daemon's own
// record of it — never a wrapper's own bookkeeping (`L-pipeline-graph-gate-1`) — and cleanup kills
// always run after the assertions, never inside the observation window a scenario depends on.
//
// AC-1 needs a real intermediary parent whose exit actually changes the shim's `getppid()`; a test
// that spawns the shim directly and merely holds its stdin open never exercises that at all
// (`mcp-intermediary.ts`'s docstring explains the fd mechanics). AC-2 must observe an effect beyond
// "it exited" — macOS terminates on SIGHUP by default, so exit alone stays green with the handler
// deleted. AC-4 must prove the replacement listener received NOTHING at shutdown, not merely
// merely that the port was bound.
import { describe, expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tokenPath } from "../../daemon/src/security/token.ts";
import { lockPath, readLock } from "../../daemon/src/index.ts";
import {
  cleanupHome,
  freshHome,
  randomPort,
  spawnDaemon,
  stopDaemon,
  waitForHandshake,
  withCleanup,
} from "../../daemon/test/helpers.ts";
import { MCP_PARENT_POLL_MS, MCP_SHUTDOWN_BUDGET_MS } from "../src/mcp.ts";

const MAIN_PATH = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const INTERMEDIARY_PATH = fileURLToPath(new URL("./fixtures/mcp-intermediary.ts", import.meta.url));
const TOKEN = "mcp-lifetime-real-subprocess-token-0123456789";

// Generous margin over the production budget: detection latency (one poll tick) plus the shutdown
// budget itself, doubled so CI load never turns a real pass into a flaky timeout.
const ORPHAN_DEADLINE_MS = (MCP_PARENT_POLL_MS + MCP_SHUTDOWN_BUDGET_MS) * 2;

function realDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/** Strips agent identity so registration takes the synthetic `mcp-<pid>-<uuid>` path unless
 * `extra` supplies one, and strips the API key so nothing here can reach a real model. */
function baseEnv(home: string, port: number, extra: Record<string, string> = {}): Record<string, string> {
  const filtered = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        value !== undefined && !["ANTHROPIC_API_KEY", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID"].includes(key),
    ),
  ) as Record<string, string>;
  return { ...filtered, GLOSA_HOME: home, GLOSA_PORT: String(port), ...extra };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(predicate: () => boolean, deadlineMs: number, intervalMs = 25): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (predicate()) return true;
    await Bun.sleep(intervalMs);
  }
  return predicate();
}

/** Does the daemon currently accept this credential? Rotation is only observable once its own
 * watcher has re-read the file, so tests wait for this rather than assuming the write took. */
async function tokenAccepted(port: number, token: string): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { Authorization: `Bearer ${token}` } });
    return res.status === 200;
  } catch {
    return false;
  }
}

async function waitUntilAsync(
  predicate: () => Promise<boolean>,
  deadlineMs: number,
  intervalMs = 100,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (await predicate()) return true;
    await Bun.sleep(intervalMs);
  }
  return predicate();
}

async function sessions(
  port: number,
  token: string = TOKEN,
): Promise<Array<{ session_id: string; provider: string; source: string }>> {
  const res = await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { Authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  return ((await res.json()) as { sessions: Array<{ session_id: string; provider: string; source: string }> }).sessions;
}

interface JsonRpcIo {
  write(line: unknown): Promise<void>;
  readLines(want: number, timeoutMs: number): Promise<string[]>;
  end(): void;
}

/** Line-delimited JSON-RPC over a Bun subprocess's own `stdin`/`stdout` pipes. Used both for a
 * direct spawn and for the intermediary's pipes in `spawnOrphanable` — in the latter case these
 * are the pipes the TEST holds, which is exactly what keeps the shim's stdin open past its real
 * parent's exit. */
function wireStdio(proc: { stdin: unknown; stdout: unknown }): JsonRpcIo {
  const writer = proc.stdin as { write(bytes: Uint8Array): unknown; flush(): Promise<unknown>; end(): void };
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  return {
    async write(line) {
      writer.write(new TextEncoder().encode(`${JSON.stringify(line)}\n`));
      await writer.flush();
    },
    async readLines(want, timeoutMs) {
      const out: string[] = [];
      const deadline = Date.now() + timeoutMs;
      while (out.length < want && Date.now() < deadline) {
        const remaining = Math.max(0, deadline - Date.now());
        const step = await Promise.race([
          reader.read(),
          Bun.sleep(remaining).then(() => ({ done: true as const, value: undefined })),
        ]);
        if (step.done) break;
        buffered += decoder.decode(step.value as Uint8Array, { stream: true });
        let nl: number;
        while ((nl = buffered.indexOf("\n")) >= 0) {
          const line = buffered.slice(0, nl).trim();
          buffered = buffered.slice(nl + 1);
          if (line) out.push(line);
        }
      }
      return out;
    },
    end() {
      writer.end();
    },
  };
}

function initializeMessages(id = 1) {
  return {
    request: {
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "mcp-lifetime-real-subprocess", version: "1" },
      },
    },
    initialized: { jsonrpc: "2.0", method: "notifications/initialized" },
  };
}

const metadataShowCall = {
  jsonrpc: "2.0",
  id: 2,
  method: "tools/call",
  params: { name: "glosa_metadata_show", arguments: {} },
};

/** Drives `initialize` → `initialized` → one real tool call over `io`, proving the shim actually
 * registered with the daemon before whatever the caller does next. */
async function handshakeAndRegister(io: JsonRpcIo): Promise<void> {
  const { request, initialized } = initializeMessages();
  await io.write(request);
  expect((await io.readLines(1, 15_000)).length).toBe(1);
  await io.write(initialized);
  await io.write(metadataShowCall);
  expect((await io.readLines(1, 15_000)).length).toBe(1);
}

/** Reads one line from a Bun subprocess stream without waiting for the stream to close — `.text()`
 * blocks until EOF, which is wrong here because the intermediary stays alive relaying traffic. */
async function readOneLine(stream: ReadableStream<Uint8Array>, timeoutMs: number): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const deadline = Date.now() + timeoutMs;
  while (!buffered.includes("\n") && Date.now() < deadline) {
    const remaining = Math.max(0, deadline - Date.now());
    const step = await Promise.race([
      reader.read(),
      Bun.sleep(remaining).then(() => ({ done: true as const, value: undefined })),
    ]);
    if (step.done) break;
    buffered += decoder.decode(step.value as Uint8Array, { stream: true });
  }
  reader.releaseLock();
  const nl = buffered.indexOf("\n");
  if (nl < 0) throw new Error(`no line received within ${timeoutMs}ms: ${JSON.stringify(buffered)}`);
  return buffered.slice(0, nl);
}

/** Spawns the real intermediary (`mcp-intermediary.ts`), which spawns `glosa mcp` as its own
 * child over a socketpair, hands that socketpair's peer to a second independent holder process,
 * reports both pids on its own stderr, and then relays traffic between its own stdio (which this
 * function wires up, ordinary single-hop pipes the TEST owns) and the shim, until killed.
 * `killParent()` is the "real intermediary parent that exits" the contract requires — after it
 * returns, the shim's actual OS parent is gone, but its stdin is still held open by the holder. */
async function spawnOrphanable(
  env: Record<string, string>,
  cwd: string,
): Promise<{ childPid: number; holderPid: number; io: JsonRpcIo; killParent(): Promise<void> }> {
  const intermediary = Bun.spawn({
    cmd: [process.execPath, INTERMEDIARY_PATH, process.execPath, MAIN_PATH, "mcp"],
    env,
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const pidReport = await readOneLine(intermediary.stderr as ReadableStream<Uint8Array>, 15_000);
  const childMatch = /child_pid=(\d+)/.exec(pidReport);
  const holderMatch = /holder_pid=(\d+)/.exec(pidReport);
  if (!childMatch || !holderMatch) throw new Error(`intermediary did not report both pids: ${pidReport}`);
  return {
    childPid: Number(childMatch[1]),
    holderPid: Number(holderMatch[1]),
    io: wireStdio(intermediary),
    // The holder is left running deliberately — it must outlive this call so the shim's stdin
    // stays open through the whole observation window. The caller kills it, after assertions.
    async killParent() {
      intermediary.kill("SIGKILL");
      await intermediary.exited;
    },
  };
}

/** A replacement for a killed daemon that accepts a connection, RECORDS the bytes it received
 * (binding the port alone proves nothing about what actually arrived), and never writes a
 * response. The recorded bytes are what let a test assert not merely THAT the shim spoke to this
 * listener, but WHAT it was willing to say to it — specifically, whether a bearer token was in
 * it. */
function wedgedListener(port: number): Promise<{ close(): void; sawRequest: Promise<void>; received(): string }> {
  return new Promise((resolve, reject) => {
    let resolveSaw: () => void;
    const sawRequest = new Promise<void>((res) => {
      resolveSaw = res;
    });
    let bytes = "";
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("data", (chunk: Buffer) => {
        bytes += chunk.toString("utf8");
        resolveSaw();
      });
      socket.on("error", () => {});
      socket.on("close", () => sockets.delete(socket));
      // Deliberately never write() — this holds every connection open forever.
    });
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve({
        close: () => {
          for (const socket of sockets) socket.destroy();
          server.close();
        },
        sawRequest,
        received: () => bytes,
      });
    });
  });
}

/** A listener that PASSES the identity probe and then wedges. It answers `/api/handshake` with the
 * instance id the real daemon published — public metadata any local process can read from the
 * lock — and never answers anything else. It is the hardest case for the shutdown guarantee: an
 * endpoint that would satisfy any check made of public metadata. It must still receive nothing. */
function identityEchoingListener(
  port: number,
  instanceId: string,
): Promise<{ close(): void; sawDeregister: Promise<void>; received(): string }> {
  return new Promise((resolve, reject) => {
    let resolveSaw: () => void;
    const sawDeregister = new Promise<void>((res) => {
      resolveSaw = res;
    });
    let bytes = "";
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        bytes += text;
        if (text.includes("/api/handshake")) {
          const body = JSON.stringify({ instance_id: instanceId, protocol_version: "1", build_id: "x", pid: 1 });
          socket.write(
            `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
          );
          return;
        }
        if (text.includes("/deregister")) resolveSaw();
        // Everything else: hold the connection open and never answer.
      });
      socket.on("error", () => {});
      socket.on("close", () => sockets.delete(socket));
    });
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve({
        close: () => {
          for (const socket of sockets) socket.destroy();
          server.close();
        },
        sawDeregister,
        received: () => bytes,
      });
    });
  });
}

describe("MCP shim real-process lifetime (#140)", () => {
  test("AC-3: stdin EOF exits the real OS process, with parent and daemon both alive", async () => {
    const home = freshHome();
    const agentCwd = realDir("glosa-lifetime-ac3-");
    writeFileSync(tokenPath(home), TOKEN, { mode: 0o600 });
    const port = randomPort();
    const daemon = spawnDaemon(home, port);
    await withCleanup(
      async () => {
        expect(await waitForHandshake(port, 15_000, daemon)).not.toBeNull();
        const env = baseEnv(home, port, { CLAUDE_CODE_SESSION_ID: "ac3-session" });
        const proc = Bun.spawn({
          cmd: [process.execPath, MAIN_PATH, "mcp"],
          env,
          cwd: agentCwd,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "ignore",
        });
        // One real registered tool call, so this proves a functioning shim exits on EOF, not a
        // shim that never got far enough to matter.
        await handshakeAndRegister(wireStdio(proc));
        (proc.stdin as unknown as { end(): void }).end();
        const exitCode = await Promise.race([proc.exited, Bun.sleep(15_000).then(() => "TIMEOUT" as const)]);
        expect(exitCode).toBe(0);
        expect(proc.signalCode).toBeNull();
      },
      async () => {
        await stopDaemon(home, daemon);
        cleanupHome(home);
      },
    );
  }, 30_000);

  // F-4. The parent dies during the shim's own module load, so its first `process.ppid` read can
  // only ever return the reaper — there is no earlier value to have captured. The poll compares a
  // live getppid() against that reaper baseline, agrees with it forever, and never fires. Without
  // the initial-reaper check the shim runs indefinitely, holding a stdin nobody will ever close.
  test("F-4: a shim whose parent is already gone before its first look still exits", async () => {
    const home = freshHome();
    const agentCwd = realDir("glosa-lifetime-f4-");
    writeFileSync(tokenPath(home), TOKEN, { mode: 0o600 });
    const port = randomPort();
    const daemon = spawnDaemon(home, port);
    let holderPid: number | undefined;
    let childPid: number | undefined;
    await withCleanup(
      async () => {
        expect(await waitForHandshake(port, 15_000, daemon)).not.toBeNull();
        const env = baseEnv(home, port, {
          CLAUDE_CODE_SESSION_ID: "f4-session",
          GLOSA_TEST_INTERMEDIARY_EXIT_IMMEDIATELY: "1",
        });
        const intermediary = Bun.spawn({
          cmd: [process.execPath, INTERMEDIARY_PATH, process.execPath, MAIN_PATH, "mcp"],
          env,
          cwd: agentCwd,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        });
        const pidReport = await readOneLine(intermediary.stderr as ReadableStream<Uint8Array>, 15_000);
        const childMatch = /child_pid=(\d+)/.exec(pidReport);
        const holderMatch = /holder_pid=(\d+)/.exec(pidReport);
        if (!childMatch || !holderMatch) throw new Error(`intermediary did not report both pids: ${pidReport}`);
        childPid = Number(childMatch[1]);
        holderPid = Number(holderMatch[1]);

        // The parent is gone essentially at once; the holder keeps the shim's stdin open, so EOF
        // never arrives and nothing but the shim's own check can end it.
        await intermediary.exited;
        expect(alive(holderPid)).toBe(true);

        const exited = await waitUntil(() => !alive(childPid as number), ORPHAN_DEADLINE_MS);
        expect(exited).toBe(true);
        expect(alive(childPid as number)).toBe(false);
      },
      async () => {
        for (const pid of [holderPid, childPid]) {
          if (pid === undefined) continue;
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // already dead
          }
        }
        await stopDaemon(home, daemon);
        cleanupHome(home);
      },
    );
  }, 30_000);

  test("AC-1 idle: a shim whose real parent has exited exits on its own within the total deadline", async () => {
    const home = freshHome();
    const agentCwd = realDir("glosa-lifetime-ac1-idle-");
    writeFileSync(tokenPath(home), TOKEN, { mode: 0o600 });
    const port = randomPort();
    const daemon = spawnDaemon(home, port);
    let holderPid: number | undefined;
    await withCleanup(
      async () => {
        expect(await waitForHandshake(port, 15_000, daemon)).not.toBeNull();
        const env = baseEnv(home, port, { CLAUDE_CODE_SESSION_ID: "ac1-idle-session" });
        const harness = await spawnOrphanable(env, agentCwd);
        holderPid = harness.holderPid;
        await handshakeAndRegister(harness.io);

        expect(alive(harness.childPid)).toBe(true);
        await harness.killParent();
        // The real OS parent is gone now; stdin is NOT closed — the holder still holds its end.
        expect(alive(harness.childPid)).toBe(true);

        const exited = await waitUntil(() => !alive(harness.childPid), ORPHAN_DEADLINE_MS);
        expect(exited).toBe(true);
        expect(alive(harness.childPid)).toBe(false);
      },
      async () => {
        if (holderPid !== undefined) {
          try {
            process.kill(holderPid, "SIGKILL");
          } catch {
            // already dead
          }
        }
        await stopDaemon(home, daemon);
        cleanupHome(home);
      },
    );
  }, 45_000);

  test("AC-1 busy: an orphaned shim exits even with a long poll outstanding", async () => {
    const home = freshHome();
    const agentCwd = realDir("glosa-lifetime-ac1-busy-");
    writeFileSync(tokenPath(home), TOKEN, { mode: 0o600 });
    const port = randomPort();
    const daemon = spawnDaemon(home, port);
    let holderPid: number | undefined;
    await withCleanup(
      async () => {
        expect(await waitForHandshake(port, 15_000, daemon)).not.toBeNull();
        const env = baseEnv(home, port, { CLAUDE_CODE_SESSION_ID: "ac1-busy-session" });
        const harness = await spawnOrphanable(env, agentCwd);
        holderPid = harness.holderPid;

        const { request, initialized } = initializeMessages();
        await harness.io.write(request);
        expect((await harness.io.readLines(1, 15_000)).length).toBe(1);
        await harness.io.write(initialized);

        // A real, healthy daemon — no wedged socket needed here. Nobody will ever answer, so
        // this is a genuine `glosa_ask` long poll outstanding the moment the parent dies.
        await harness.io.write({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "glosa_ask",
            arguments: { path: "notes.md", question: "left unanswered on purpose", wait_seconds: 60 },
          },
        });
        // Give the request time to actually leave the shim and reach the daemon before killing
        // the parent — otherwise this would prove nothing about cancelling in-flight work.
        await Bun.sleep(500);

        expect(alive(harness.childPid)).toBe(true);
        const start = Date.now();
        await harness.killParent();
        expect(alive(harness.childPid)).toBe(true);

        const exited = await waitUntil(() => !alive(harness.childPid), ORPHAN_DEADLINE_MS);
        const elapsedMs = Date.now() - start;
        expect(exited).toBe(true);
        expect(alive(harness.childPid)).toBe(false);
        // Comfortably below the ~5s production shutdown budget: if the outstanding `glosa_ask`
        // call were not itself cancelled, only the outer backstop would end this process, at
        // ~5s — this bound is what makes that ablation distinguishable from a working
        // cancellation path.
        expect(elapsedMs).toBeLessThan(4_500);
      },
      async () => {
        if (holderPid !== undefined) {
          try {
            process.kill(holderPid, "SIGKILL");
          } catch {
            // already dead
          }
        }
        await stopDaemon(home, daemon);
        cleanupHome(home);
      },
    );
  }, 45_000);

  test("AC-2: SIGHUP exits through the shutdown owner, not the default disposition", async () => {
    const home = freshHome();
    const agentCwd = realDir("glosa-lifetime-ac2-");
    writeFileSync(tokenPath(home), TOKEN, { mode: 0o600 });
    const port = randomPort();
    const daemon = spawnDaemon(home, port);
    await withCleanup(
      async () => {
        expect(await waitForHandshake(port, 15_000, daemon)).not.toBeNull();
        // No identity variable: this is the synthetic path, the one that used to deregister.
        const env = baseEnv(home, port);
        const proc = Bun.spawn({
          cmd: [process.execPath, MAIN_PATH, "mcp"],
          env,
          cwd: agentCwd,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "ignore",
        });
        await handshakeAndRegister(wireStdio(proc));

        const before = await sessions(port);
        const synthetic = before.filter((s) => /^mcp-\d+-/.test(s.session_id));
        expect(synthetic.length).toBe(1);

        proc.kill("SIGHUP");
        const exitCode = await Promise.race([
          proc.exited,
          Bun.sleep(ORPHAN_DEADLINE_MS).then(() => "TIMEOUT" as const),
        ]);
        // "It exited" alone would be green with the handler deleted — macOS terminates on SIGHUP
        // by default. The exit CODE is what separates the two: the shutdown owner returns 0 with no
        // signal, the default disposition kills BY the signal and reports 129. Measured, not
        // assumed: ablating the handler reds this line with `Received: 129`. This used to also
        // assert the session was deregistered, which is no longer something shutdown does (#140).
        expect(exitCode).toBe(0);
        expect(proc.signalCode).toBeNull();
      },
      async () => {
        await stopDaemon(home, daemon);
        cleanupHome(home);
      },
    );
  }, 45_000);

  // F-6. A shim must keep serving across a `glosa token rotate`: the daemon accepts only the
  // current credential, with no grace period. This is the end-to-end half, through a real shim
  // process. The credential-lifetime half — a client built before the rotation and used after —
  // is in `api-integration.test.ts`, because every client this path builds is per call and so
  // never crosses that boundary.
  test("F-6: a shim stays usable across a token rotation, through its per-call clients", async () => {
    const home = freshHome();
    const agentCwd = realDir("glosa-lifetime-f6-");
    writeFileSync(tokenPath(home), TOKEN, { mode: 0o600 });
    const port = randomPort();
    const daemon = spawnDaemon(home, port);
    await withCleanup(
      async () => {
        expect(await waitForHandshake(port, 15_000, daemon)).not.toBeNull();
        const env = baseEnv(home, port); // no identity variable: the session must be synthetic
        const proc = Bun.spawn({
          cmd: [process.execPath, MAIN_PATH, "mcp"],
          env,
          cwd: agentCwd,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "ignore",
        });
        const io = wireStdio(proc);
        await handshakeAndRegister(io);
        const before = (await sessions(port)).filter((sn) => /^mcp-\d+-/.test(sn.session_id));
        expect(before.length).toBe(1);

        // Rotate. The daemon re-reads its own credential, so from here only ROTATED is accepted.
        const ROTATED = `${TOKEN}-rotated-abcdef0123456789`;
        writeFileSync(tokenPath(home), ROTATED, { mode: 0o600 });
        expect(await waitUntilAsync(() => tokenAccepted(port, ROTATED), 10_000)).toBe(true);

        // Real activity on the fresh credential, so the session is demonstrably still live and
        // the shim has had every chance to notice the new token.
        await io.write({
          jsonrpc: "2.0",
          id: 99,
          method: "tools/call",
          params: { name: "glosa_inbox_pull", arguments: {} },
        });
        expect((await io.readLines(1, 15_000)).length).toBe(1);
        expect((await sessions(port, ROTATED)).filter((sn) => /^mcp-\d+-/.test(sn.session_id)).length).toBe(1);

        // A second tool call after the rotation, end to end through a real shim. Note what this
        // does NOT prove: `createMcpServer` builds a fresh hook client for every heartbeat and
        // drain, so this call's client is constructed AFTER the rotation and would work even if
        // the bearer were captured at construction. The long-held-client boundary is crossed only
        // by the guard in `api-integration.test.ts`, which builds its client BEFORE rotating.
        // What this pins is the end-to-end behaviour: the shim keeps serving across a rotation.
        await io.write({
          jsonrpc: "2.0",
          id: 100,
          method: "tools/call",
          params: { name: "glosa_inbox_pull", arguments: {} },
        });
        expect((await io.readLines(1, 15_000)).length).toBe(1);
        expect((await sessions(port, ROTATED)).filter((sn) => /^mcp-\d+-/.test(sn.session_id)).length).toBe(1);

        (proc.stdin as unknown as { end(): void }).end();
        expect(await Promise.race([proc.exited, Bun.sleep(ORPHAN_DEADLINE_MS).then(() => "TIMEOUT" as const)])).toBe(0);
      },
      async () => {
        await stopDaemon(home, daemon);
        cleanupHome(home);
      },
    );
  }, 45_000);

  // The hardest case for the same guarantee. This listener answers a handshake with the instance
  // id the real daemon published — public metadata any local process can read from the world-
  // readable lock — so it would satisfy any check made of that metadata, including the tokenless
  // handshake this shim briefly used. It still receives nothing, because the shim no longer sends
  // anything at shutdown. That is the difference between a vulnerability closed by verification
  // and one closed by construction.
  test("an endpoint that could fool any metadata check still receives nothing at shutdown", async () => {
    const home = freshHome();
    const agentCwd = realDir("glosa-lifetime-f13-");
    writeFileSync(tokenPath(home), TOKEN, { mode: 0o600 });
    const port = randomPort();
    const daemon = spawnDaemon(home, port);
    let echo: { close(): void; sawDeregister: Promise<void>; received(): string } | undefined;
    await withCleanup(
      async () => {
        expect(await waitForHandshake(port, 15_000, daemon)).not.toBeNull();
        const lock = readLock(lockPath(home));
        if (!lock) throw new Error("daemon published no lock");
        const env = baseEnv(home, port); // no identity variable: the session must be synthetic
        const proc = Bun.spawn({
          cmd: [process.execPath, MAIN_PATH, "mcp"],
          env,
          cwd: agentCwd,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "ignore",
        });
        await handshakeAndRegister(wireStdio(proc));
        expect((await sessions(port)).filter((sn) => /^mcp-\d+-/.test(sn.session_id)).length).toBe(1);

        daemon.kill("SIGKILL");
        await daemon.exited;
        await Bun.sleep(300);
        // Same instance id the real daemon published: any local process can read it from the lock.
        echo = await identityEchoingListener(port, lock.instance_id);

        (proc.stdin as unknown as { end(): void }).end();
        const start = Date.now();
        const exitCode = await Promise.race([
          proc.exited,
          Bun.sleep(ORPHAN_DEADLINE_MS).then(() => "TIMEOUT" as const),
        ]);
        const elapsedMs = Date.now() - start;
        expect(exitCode).toBe(0);
        expect(alive(proc.pid)).toBe(false);

        // No handshake, no deregistration, no credential — nothing at all.
        expect(echo.received()).toBe("");
        // Still bounded: with no shutdown request to wait on, this is well inside the budget.
        expect(elapsedMs).toBeLessThan(4_500);
      },
      async () => {
        echo?.close();
        cleanupHome(home);
      },
    );
  }, 45_000);

  test("AC-4: a wedged daemon cannot hold a synthetic-session shim open", async () => {
    const home = freshHome();
    const agentCwd = realDir("glosa-lifetime-ac4-");
    writeFileSync(tokenPath(home), TOKEN, { mode: 0o600 });
    const port = randomPort();
    let daemon = spawnDaemon(home, port);
    let wedged: { close(): void; sawRequest: Promise<void>; received(): string } | undefined;
    await withCleanup(
      async () => {
        expect(await waitForHandshake(port, 15_000, daemon)).not.toBeNull();
        // No identity variable: the synthetic path, which is where shutdown used to send a
        // deregistration and now sends nothing.
        const env = baseEnv(home, port);
        const proc = Bun.spawn({
          cmd: [process.execPath, MAIN_PATH, "mcp"],
          env,
          cwd: agentCwd,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "ignore",
        });
        await handshakeAndRegister(wireStdio(proc));

        const registered = await sessions(port);
        const synthetic = registered.filter((s) => /^mcp-\d+-/.test(s.session_id));
        expect(synthetic.length).toBe(1);

        daemon.kill("SIGKILL");
        await daemon.exited;
        await Bun.sleep(300); // let the port actually free before rebinding
        wedged = await wedgedListener(port);

        (proc.stdin as unknown as { end(): void }).end();
        const start = Date.now();
        const exitCode = await Promise.race([
          proc.exited,
          Bun.sleep(ORPHAN_DEADLINE_MS).then(() => "TIMEOUT" as const),
        ]);
        const elapsedMs = Date.now() - start;
        expect(exitCode).toBe(0);
        expect(proc.signalCode).toBeNull();
        expect(alive(proc.pid)).toBe(false);
        // Comfortably below the ~5s production shutdown budget. With no shutdown request to
        // wait on, reaching the outer backstop would mean something else in `close()` hung; this
        // bound is what would notice.
        expect(elapsedMs).toBeLessThan(4_500);

        // NOTHING should reach whatever holds this port. The shim does not deregister on the way
        // out (#140): its session is cleaned up by the lease expiring, so there is no shutdown
        // traffic to misdirect. This listener is a foreign process that took the recycled port,
        // and the guarantee is that it learns nothing — not that what it learns is harmless.
        await Bun.sleep(1_000); // long enough for any shutdown request to have been attempted
        expect(wedged.received()).toBe("");

        // The daemon is dead in this scenario, so respawn a fresh one only so cleanup below has
        // something real to stop and `cleanupHome` can run without racing a listener.
        wedged.close();
        daemon = spawnDaemon(home, port);
        expect(await waitForHandshake(port, 15_000, daemon)).not.toBeNull();
      },
      async () => {
        wedged?.close();
        await stopDaemon(home, daemon);
        cleanupHome(home);
      },
    );
  }, 45_000);

  // Bun/Node's own dynamic-import chain for `glosa mcp` (index.ts's lazy handler, then mcp.ts's
  // own module graph) measurably dominates this process's observable startup — ~100-200ms in this
  // environment, verified empirically while building this test (a signal sent at that point still
  // hit the platform default; one sent past it reached the handler). No code-level fix can shorten
  // that: it is Bun resolving and executing the module graph, before any of this issue's code has
  // even started running. `STARTUP_MARGIN_MS` sits safely past that measured threshold so these
  // two tests exercise the window they are meant to (this process's own code path, before any MCP
  // handshake), not the unrelated, unfixable module-loading window that precedes it.
  const STARTUP_MARGIN_MS = 400;

  test("F-1: SIGHUP sent before any handshake, as early as this process's own code can be signalled, still exits gracefully", async () => {
    // With the SIGHUP handler installed before `runMcpServer`'s first `await` (this fix), this is
    // safe regardless of exactly when within its own code the signal lands. With it installed only
    // after `connect()` (the prior bug) — a call that itself does no real I/O and returns almost
    // immediately — the exploitable gap was already this narrow; the point of the fix is that no
    // window remains at all, not that this test widens it.
    const home = freshHome();
    const agentCwd = realDir("glosa-lifetime-f1-sighup-early-");
    writeFileSync(tokenPath(home), TOKEN, { mode: 0o600 });
    const port = randomPort();
    const daemon = spawnDaemon(home, port);
    await withCleanup(
      async () => {
        expect(await waitForHandshake(port, 15_000, daemon)).not.toBeNull();
        const env = baseEnv(home, port);
        const proc = Bun.spawn({
          cmd: [process.execPath, MAIN_PATH, "mcp"],
          env,
          cwd: agentCwd,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "ignore",
        });
        await Bun.sleep(STARTUP_MARGIN_MS);
        proc.kill("SIGHUP");
        const exitCode = await Promise.race([proc.exited, Bun.sleep(15_000).then(() => "TIMEOUT" as const)]);
        expect(exitCode).toBe(0);
        expect(proc.signalCode).toBeNull();
      },
      async () => {
        await stopDaemon(home, daemon);
        cleanupHome(home);
      },
    );
  }, 30_000);

  test("F-1: the real parent exiting before any handshake, as early as this process's own code can observe it, is still detected", async () => {
    // No handshake before killing the parent — the earliest window a black-box test can reach
    // that is still inside this process's own code (see `STARTUP_MARGIN_MS`, above; killing
    // immediately after spawn instead measures kernel-level reparenting racing the child's own
    // process bootstrap, which no baseline captured in JS — old or new — can ever see around).
    // The prior bug captured the parent-poll baseline via a fresh `getppid()` AFTER `connect()`;
    // a parent that had already exited by then would be captured as launchd from the start, and
    // the poll would never see a change again. Using Bun's own cached `process.ppid`, read before
    // this function's first `await`, fixes that for any parent death after this process's own
    // code has started running — which is the actual, reachable bug this issue is about.
    const home = freshHome();
    const agentCwd = realDir("glosa-lifetime-f1-parent-early-");
    writeFileSync(tokenPath(home), TOKEN, { mode: 0o600 });
    const port = randomPort();
    const daemon = spawnDaemon(home, port);
    let holderPid: number | undefined;
    await withCleanup(
      async () => {
        expect(await waitForHandshake(port, 15_000, daemon)).not.toBeNull();
        const env = baseEnv(home, port, { CLAUDE_CODE_SESSION_ID: "f1-parent-early-session" });
        const harness = await spawnOrphanable(env, agentCwd);
        holderPid = harness.holderPid;
        await Bun.sleep(STARTUP_MARGIN_MS);
        await harness.killParent();

        const exited = await waitUntil(() => !alive(harness.childPid), ORPHAN_DEADLINE_MS);
        expect(exited).toBe(true);
        expect(alive(harness.childPid)).toBe(false);
      },
      async () => {
        if (holderPid !== undefined) {
          try {
            process.kill(holderPid, "SIGKILL");
          } catch {
            // already dead
          }
        }
        await stopDaemon(home, daemon);
        cleanupHome(home);
      },
    );
  }, 45_000);

  test("shutdown budget: the total deadline ends the process even when nothing else bounds the hang", async () => {
    // No daemon ever exists in this scenario — `ensureDaemon()` has its OWN independent ~12s
    // default timeout (`DEFAULT_ENSURE_TIMEOUT_MS`, `packages/daemon/src/lifecycle/daemon.ts`),
    // which none of the shutdown owner's per-client abort signals touch (contract: "left alone
    // unless the total budget requires aborting it earlier"). A tool call that is still inside
    // that discovery wait when SIGHUP arrives is therefore bounded by nothing but the outer
    // `runMcpServer` race and its `process.exit` fallback — this is what isolates that mechanism
    // from the per-client cancellation the other scenarios above already cover.
    const home = freshHome();
    const agentCwd = realDir("glosa-lifetime-budget-");
    writeFileSync(tokenPath(home), TOKEN, { mode: 0o600 });
    const port = randomPort();
    const wedged = await wedgedListener(port);
    await withCleanup(
      async () => {
        const env = baseEnv(home, port, { CLAUDE_CODE_SESSION_ID: "budget-session" });
        const proc = Bun.spawn({
          cmd: [process.execPath, MAIN_PATH, "mcp"],
          env,
          cwd: agentCwd,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "ignore",
        });
        const io = wireStdio(proc);
        const { request, initialized } = initializeMessages();
        await io.write(request);
        expect((await io.readLines(1, 15_000)).length).toBe(1);
        await io.write(initialized);
        // Fires `deps.createApiClient()` → `ensureDaemon()`, which hangs against the wedged
        // port — no response ever answers `getMetadata`'s request, so this never returns on its
        // own.
        await io.write({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "glosa_metadata_show", arguments: {} },
        });
        await Bun.sleep(300); // let the call actually enter ensureDaemon()'s wait first

        const start = Date.now();
        proc.kill("SIGHUP");
        const exitCode = await Promise.race([proc.exited, Bun.sleep(11_000).then(() => "TIMEOUT" as const)]);
        const elapsedMs = Date.now() - start;
        expect(exitCode).toBe(0);
        expect(proc.signalCode).toBeNull();
        // Comfortably above the ~5s production budget (scheduling jitter) but well under
        // `ensureDaemon`'s own ~12s timeout — only the outer backstop lands in this window.
        expect(elapsedMs).toBeLessThan(9_000);
      },
      async () => {
        wedged.close();
        cleanupHome(home);
      },
    );
  }, 30_000);
});

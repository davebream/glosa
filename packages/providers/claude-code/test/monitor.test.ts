// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILD_ID } from "../../../daemon/src/lifecycle/build-id.ts";
import { lockPath } from "../../../daemon/src/lifecycle/home.ts";
import { INSTALL_ID } from "../../../daemon/src/lifecycle/install.ts";
import { writeLockExclusive } from "../../../daemon/src/lifecycle/lock.ts";
import { PROTOCOL_VERSION } from "../../../daemon/src/lifecycle/protocol.ts";
import { tokenPath } from "../../../daemon/src/security/token.ts";
import type { MonitorDeps } from "../src/monitor.ts";
import {
  MONITOR_MAX_DELAY_MS,
  MONITOR_MIN_DELAY_MS,
  PARK_PROBE_BASE_MS,
  PARK_PROBE_JITTER_MS,
  PARK_PROBE_REQUEST_TIMEOUT_MS,
  STREAM_FAILURE_DEADLINE_MS,
  monitorRetryDelay,
  parkProbeDelay,
  registeredWorkspaceForProject,
  runClaudeMonitor,
} from "../src/monitor.ts";

const TOKEN = "monitor-fake-daemon-token-0123456789abcdef";
const FAKE_PORT = 45_991;

/** Everything `existingDaemon()` needs to accept this "daemon" as real, without spawning one: a
 * matching lock file plus a token file. The ONE piece that can't come from `MonitorDeps` is the
 * handshake itself — `existingDaemon` calls `fetchHandshake`, which uses the real global `fetch` —
 * so callers must also stub `globalThis.fetch` for the `/api/handshake` path (see
 * `withFakeGlobalFetch`) and route everything else through the injected `MonitorDeps.fetch`. */
function seedFakeDaemon(home: string): { instanceId: string; pid: number; startedAt: string } {
  const instanceId = "gl-fake-instance";
  const pid = 999_999;
  const startedAt = new Date().toISOString();
  writeLockExclusive(lockPath(home), {
    instance_id: instanceId,
    pid,
    port: FAKE_PORT,
    protocol_version: PROTOCOL_VERSION,
    build_id: BUILD_ID,
    install_id: INSTALL_ID,
    started_at: startedAt,
    host: "test-host",
    bun: "1.0.0",
  });
  writeFileSync(tokenPath(home), TOKEN, { mode: 0o600 });
  return { instanceId, pid, startedAt };
}

let restoreFetch: (() => void) | undefined;
afterEach(() => {
  restoreFetch?.();
  restoreFetch = undefined;
});

/** Stubs the real global `fetch` for exactly the one call `existingDaemon()` makes outside
 * `MonitorDeps` — `GET /api/handshake` — and fails loudly on anything else, so a code path this
 * suite did not intend to exercise never silently reaches the real network. `handshakeOk`, when
 * given, is consulted on every handshake call (including the initial connect) — returning `false`
 * makes that ONE handshake behave as an unreachable/foreign daemon (#206 F-6: a daemon-discovery
 * failure during a parked probe must be inconclusive, not free). */
function withFakeGlobalFetch(
  daemon: { instanceId: string; pid: number; startedAt: string },
  options: { handshakeOk?: () => boolean } = {},
): void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/api/handshake")) {
      if (options.handshakeOk && !options.handshakeOk()) {
        return new Response(null, { status: 503 });
      }
      return new Response(
        JSON.stringify({
          protocol_version: PROTOCOL_VERSION,
          build_id: BUILD_ID,
          install_id: INSTALL_ID,
          instance_id: daemon.instanceId,
          pid: daemon.pid,
          started_at: daemon.startedAt,
        }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected real fetch to ${url} — route it through MonitorDeps.fetch instead`);
  }) as typeof fetch;
  restoreFetch = () => {
    globalThis.fetch = original;
  };
}

function sseFrame(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function streamResponse(chunks: Uint8Array[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

/** A registered, active workspace an already-realpath'd `project` directory resolves into —
 * exactly what `registeredWorkspaceForProject` needs to stop waiting and let the monitor proceed. */
function seedWorkspace(home: string, project: string): void {
  writeFileSync(
    join(home, "workspaces.json"),
    JSON.stringify({
      version: 4,
      updated_at: new Date().toISOString(),
      workspaces: { w: { canonical_path: project, present: true, lifecycle: { state: "active" } } },
      adoptions: {},
      forget_operations: {},
    }),
  );
}

const ENTRY = {
  id: "entry-1",
  kind: "annotation",
  status: "pending",
  text: "Review this sentence.",
  bytes: 21,
  detail: { artifact_path: "notes.md" },
  truncation: { truncated: false, omitted_bytes: 0, omitted_hunks: 0 },
  retrieval: { command: "glosa inbox get entry-1", mcp_tool: "glosa_inbox_get" },
};

describe("Claude plugin monitor", () => {
  test("retry delay keeps the five-second floor and finite cap", () => {
    expect(MONITOR_MIN_DELAY_MS).toBe(5_000);
    expect(MONITOR_MAX_DELAY_MS).toBe(60_000);
    expect(monitorRetryDelay(0, () => 0)).toBe(MONITOR_MIN_DELAY_MS);
    expect(monitorRetryDelay(0, () => 1)).toBe(6_000);
    expect(monitorRetryDelay(99, () => 1)).toBe(MONITOR_MAX_DELAY_MS);
  });

  test("workspace discovery is read-only and chooses the most specific active ancestor", () => {
    const home = mkdtempSync(join(tmpdir(), "glosa-monitor-index-"));
    const outerPath = join(home, "outer");
    const innerPath = join(outerPath, "inner");
    mkdirSync(innerPath, { recursive: true });
    const outer = realpathSync(outerPath);
    const inner = realpathSync(innerPath);
    const path = join(home, "workspaces.json");
    writeFileSync(
      path,
      JSON.stringify({
        version: 4,
        updated_at: new Date().toISOString(),
        workspaces: {
          outer: { canonical_path: outer, present: true, lifecycle: { state: "active" } },
          inner: { canonical_path: inner, present: true, lifecycle: { state: "active" } },
          inactive: { canonical_path: home, present: true, lifecycle: { state: "forgetting" } },
        },
        adoptions: {},
        forget_operations: {},
      }),
    );
    expect(registeredWorkspaceForProject(path, inner)).toBe(inner);
    rmSync(home, { recursive: true, force: true });
  });

  test("outside a registered workspace it waits without touching the daemon", async () => {
    const home = mkdtempSync(join(tmpdir(), "glosa-monitor-idle-"));
    const project = join(home, "project");
    mkdirSync(project);
    const abort = new AbortController();
    let fetches = 0;
    let waits = 0;
    await runClaudeMonitor(
      { sessionId: "session-1", projectDir: project, pluginRoot: join(home, "plugin") },
      {
        home: () => home,
        fetch: (async () => {
          fetches += 1;
          throw new Error("unexpected daemon call");
        }) as unknown as typeof fetch,
        stdout: { write: () => true },
        random: () => 0,
        sleep: async () => {},
        waitForWorkspaceChange: async () => {
          waits += 1;
          abort.abort();
        },
        now: () => 0,
      },
      abort.signal,
    );
    expect(waits).toBe(1);
    expect(fetches).toBe(0);
    expect(existsSync(join(home, "daemon.lock"))).toBe(false);
    rmSync(home, { recursive: true, force: true });
  });

  test("park probe delay is a fixed 15-18s window with no backoff growth", () => {
    expect(parkProbeDelay(() => 0)).toBe(PARK_PROBE_BASE_MS);
    expect(parkProbeDelay(() => 1)).toBe(PARK_PROBE_BASE_MS + PARK_PROBE_JITTER_MS);
    expect(parkProbeDelay(() => 0.5)).toBeLessThan(PARK_PROBE_BASE_MS + PARK_PROBE_JITTER_MS);
  });

  test("a plain EOF (no superseded frame) retries as today — no ownership probe is ever consulted", async () => {
    const home = mkdtempSync(join(tmpdir(), "glosa-monitor-eof-"));
    const project = realpathSync(mkdtempSync(join(tmpdir(), "glosa-monitor-eof-project-")));
    seedWorkspace(home, project);
    const daemon = seedFakeDaemon(home);
    withFakeGlobalFetch(daemon);

    const abort = new AbortController();
    let registerCalls = 0;
    let streamCalls = 0;
    let statusCalls = 0;
    const sleeps: number[] = [];
    const deps: MonitorDeps = {
      home: () => home,
      fetch: (async (input: RequestInfo | URL) => {
        const href = input.toString();
        if (href.endsWith("/api/sessions/register")) {
          registerCalls += 1;
          return new Response(JSON.stringify({ session_id: "session-1", workspace: project }), { status: 200 });
        }
        if (href.endsWith("/stream/status")) {
          statusCalls += 1;
          return new Response(JSON.stringify({ connected: false, transport: null }), { status: 200 });
        }
        if (href.endsWith("/stream")) {
          streamCalls += 1;
          return streamResponse([]); // clean EOF, no frames at all
        }
        throw new Error(`unexpected fetch ${href}`);
      }) as unknown as typeof fetch,
      stdout: { write: (_chunk, callback) => callback() },
      random: () => 0,
      sleep: async (ms, signal) => {
        sleeps.push(ms);
        if (!signal.aborted) abort.abort(); // stop after the loop's very first retry sleep
      },
      waitForWorkspaceChange: async () => {},
      now: () => 0,
    };
    await runClaudeMonitor({ sessionId: "session-1", projectDir: project, pluginRoot: "/plugin" }, deps, abort.signal);

    expect({ registerCalls, streamCalls, statusCalls, sleeps }).toEqual({
      registerCalls: 1,
      streamCalls: 1,
      statusCalls: 0, // #206: an ordinary EOF never consults the ownership probe
      sleeps: [MONITOR_MIN_DELAY_MS],
    });
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  test("superseded parks without reconnecting; a connected probe keeps it parked; a free probe reconnects (#206)", async () => {
    const home = mkdtempSync(join(tmpdir(), "glosa-monitor-park-"));
    const project = realpathSync(mkdtempSync(join(tmpdir(), "glosa-monitor-park-project-")));
    seedWorkspace(home, project);
    const daemon = seedFakeDaemon(home);
    withFakeGlobalFetch(daemon);

    const abort = new AbortController();
    let registerCalls = 0;
    let streamCalls = 0;
    let statusCalls = 0;
    const sleeps: number[] = [];
    const writes: string[] = [];
    // #206 F-7: a fake clock that only advances when a sleep call genuinely resolves — the
    // request-timeout race leg below never resolves (this fake fetch always answers first), so it
    // contributes no elapsed time, keeping `parkUntilFree`'s absolute-cadence math exact.
    let clock = 0;
    const deps: MonitorDeps = {
      home: () => home,
      fetch: (async (input: RequestInfo | URL) => {
        const href = input.toString();
        if (href.endsWith("/api/sessions/register")) {
          registerCalls += 1;
          return new Response(JSON.stringify({ session_id: "session-1", workspace: project }), { status: 200 });
        }
        if (href.endsWith("/stream/status")) {
          statusCalls += 1;
          // First probe: still connected (the new owner hasn't left yet) — stay parked.
          // Second probe: free — re-enter the connect loop.
          const connected = statusCalls === 1;
          return new Response(JSON.stringify({ connected, transport: connected ? "monitor" : null }), {
            status: 200,
          });
        }
        if (href.endsWith("/stream")) {
          streamCalls += 1;
          if (streamCalls === 1) return streamResponse([sseFrame("superseded", { transport: "monitor" })]);
          abort.abort(); // reconnection proven — stop the loop here
          return streamResponse([]);
        }
        throw new Error(`unexpected fetch ${href}`);
      }) as unknown as typeof fetch,
      stdout: { write: (chunk, callback) => (writes.push(String(chunk)), callback()) },
      random: () => 0,
      // #206 F-7 race: `probeStreamConnected` races the real status fetch against a
      // `PARK_PROBE_REQUEST_TIMEOUT_MS` sleep. This fake fetch always answers, so that sleep must
      // never resolve here — otherwise a same-tick "resolve immediately" mock could spuriously win
      // the race and turn every probe into a timeout, never reaching the fetch's real answer.
      sleep: async (ms) => {
        sleeps.push(ms);
        if (ms === PARK_PROBE_REQUEST_TIMEOUT_MS) return new Promise<void>(() => {});
        clock += ms;
      },
      waitForWorkspaceChange: async () => {},
      now: () => clock,
    };
    await runClaudeMonitor({ sessionId: "session-1", projectDir: project, pluginRoot: "/plugin" }, deps, abort.signal);

    expect({ registerCalls, streamCalls, statusCalls, sleeps, writes }).toEqual({
      // Exactly one register/stream pair before the park, and one more after the free probe — never
      // a register/stream call WHILE parked, and never an ordinary retry sleep for a superseded end.
      registerCalls: 2,
      streamCalls: 2,
      statusCalls: 2,
      // Each probe's own request-timeout race sleep (`PARK_PROBE_REQUEST_TIMEOUT_MS`) is invoked
      // once per probe too, alongside the interval sleep that precedes it — it never actually wins
      // here because this fake fetch always answers before it (see the `sleep` mock above).
      sleeps: [
        PARK_PROBE_BASE_MS,
        PARK_PROBE_REQUEST_TIMEOUT_MS,
        PARK_PROBE_BASE_MS,
        PARK_PROBE_REQUEST_TIMEOUT_MS,
        MONITOR_MIN_DELAY_MS,
      ],
      writes: [],
    });
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  test("an in-flight delivery/ack failure does not mask an already-issued superseded frame (barrier, #206)", async () => {
    const home = mkdtempSync(join(tmpdir(), "glosa-monitor-barrier-"));
    const project = realpathSync(mkdtempSync(join(tmpdir(), "glosa-monitor-barrier-project-")));
    seedWorkspace(home, project);
    const daemon = seedFakeDaemon(home);
    withFakeGlobalFetch(daemon);

    const abort = new AbortController();
    let registerCalls = 0;
    let streamCalls = 0;
    let ackCalls = 0;
    let statusCalls = 0;
    const sleeps: number[] = [];
    const writes: string[] = [];
    let clock = 0; // #206 F-7: see the "superseded parks" test above for why this stays exact
    const deps: MonitorDeps = {
      home: () => home,
      fetch: (async (input: RequestInfo | URL) => {
        const href = input.toString();
        if (href.endsWith("/api/sessions/register")) {
          registerCalls += 1;
          return new Response(JSON.stringify({ session_id: "session-1", workspace: project }), { status: 200 });
        }
        if (href.endsWith("/transport-ack")) {
          ackCalls += 1;
          // Replacement already deleted this connection's pending acknowledgement — the expected
          // shape of a mid-delivery displacement, not a reason to reconnect and re-displace.
          return new Response(null, { status: 409 });
        }
        if (href.endsWith("/stream/status")) {
          statusCalls += 1;
          return new Response(JSON.stringify({ connected: false, transport: null }), { status: 200 });
        }
        if (href.endsWith("/stream")) {
          streamCalls += 1;
          if (streamCalls === 1) {
            return streamResponse([sseFrame("delivery", ENTRY), sseFrame("superseded", { transport: "monitor" })]);
          }
          abort.abort(); // reconnection proven — stop the loop here
          return streamResponse([]);
        }
        throw new Error(`unexpected fetch ${href}`);
      }) as unknown as typeof fetch,
      stdout: { write: (chunk, callback) => (writes.push(String(chunk)), callback()) },
      random: () => 0,
      // #206 precedence race: after a failure, `registerAndStream` races the next `reader.read()`
      // against this deadline sleep. The next chunk (the `superseded` frame) is already buffered in
      // the fake stream, so the read must win deterministically — a sleep this short never resolves
      // (and is deliberately excluded from `sleeps`, since its real requested value is derived from
      // wall-clock `Date.now()` and is not an exact, predictable constant like the values below).
      // F-7's separate request-timeout race (`PARK_PROBE_REQUEST_TIMEOUT_MS`) IS a fixed constant,
      // so it's recorded, then also made to never resolve — this fake fetch always answers first.
      sleep: async (ms) => {
        if (ms <= STREAM_FAILURE_DEADLINE_MS) return new Promise<void>(() => {});
        sleeps.push(ms);
        if (ms === PARK_PROBE_REQUEST_TIMEOUT_MS) return new Promise<void>(() => {});
        clock += ms;
      },
      waitForWorkspaceChange: async () => {},
      now: () => clock,
    };
    await runClaudeMonitor({ sessionId: "session-1", projectDir: project, pluginRoot: "/plugin" }, deps, abort.signal);

    expect({ registerCalls, streamCalls, ackCalls, statusCalls, sleeps }).toEqual({
      // The delivery line was written and the ack was attempted (and failed) BEFORE the superseded
      // frame — precedence still classifies the end as superseded: one park-probe sleep (never a
      // 5s ordinary retry), then exactly one reconnect once the probe reports free.
      registerCalls: 2,
      streamCalls: 2,
      ackCalls: 1,
      statusCalls: 1,
      sleeps: [PARK_PROBE_BASE_MS, PARK_PROBE_REQUEST_TIMEOUT_MS, MONITOR_MIN_DELAY_MS],
    });
    expect(writes).toEqual([`[glosa ${ENTRY.id}] ${JSON.stringify(ENTRY)}\n`]);
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  test("only a literal connected:false frees a parked client — malformed bodies and non-2xx all stay parked (#206 review round 1, F-6)", async () => {
    const home = mkdtempSync(join(tmpdir(), "glosa-monitor-f6-body-"));
    const project = realpathSync(mkdtempSync(join(tmpdir(), "glosa-monitor-f6-body-project-")));
    seedWorkspace(home, project);
    const daemon = seedFakeDaemon(home);
    withFakeGlobalFetch(daemon);

    const abort = new AbortController();
    let registerCalls = 0;
    let streamCalls = 0;
    let statusCalls = 0;
    const sleeps: number[] = [];
    let clock = 0;
    // Five inconclusive probe cycles, each a shape a naive `body.connected === true ? true : false`
    // reading would wrongly treat as free, followed by the ONE response that legitimately is:
    //   1. {}                         — no `connected` field at all
    //   2. []                         — a JSON array, not an object
    //   3. {connected:null}           — the field is present but not a boolean
    //   4. null                       — a top-level JSON null: reading a field off it THROWS
    //   5. {connected:false} on a 500 — a non-2xx status must win over a matching shape
    //   6. a thrown network error
    //   7. {connected:false} on a 200 — the ONLY response that may end the park
    const bodiesByCycle: Array<() => Response> = [
      () => new Response(JSON.stringify({}), { status: 200 }),
      () => new Response(JSON.stringify([]), { status: 200 }),
      () => new Response(JSON.stringify({ connected: null }), { status: 200 }),
      () => new Response("null", { status: 200 }),
      () => new Response(JSON.stringify({ connected: false }), { status: 500 }),
    ];
    const deps: MonitorDeps = {
      home: () => home,
      fetch: (async (input: RequestInfo | URL) => {
        const href = input.toString();
        if (href.endsWith("/api/sessions/register")) {
          registerCalls += 1;
          return new Response(JSON.stringify({ session_id: "session-1", workspace: project }), { status: 200 });
        }
        if (href.endsWith("/stream/status")) {
          statusCalls += 1;
          if (statusCalls <= bodiesByCycle.length) return bodiesByCycle[statusCalls - 1]!();
          if (statusCalls === bodiesByCycle.length + 1) throw new Error("simulated network error");
          return new Response(JSON.stringify({ connected: false, transport: null }), { status: 200 });
        }
        if (href.endsWith("/stream")) {
          streamCalls += 1;
          if (streamCalls === 1) return streamResponse([sseFrame("superseded", { transport: "monitor" })]);
          abort.abort(); // reconnection proven — stop the loop here
          return streamResponse([]);
        }
        throw new Error(`unexpected fetch ${href}`);
      }) as unknown as typeof fetch,
      stdout: { write: (_chunk, callback) => callback() },
      random: () => 0,
      sleep: async (ms) => {
        sleeps.push(ms);
        if (ms === PARK_PROBE_REQUEST_TIMEOUT_MS) return new Promise<void>(() => {});
        clock += ms;
      },
      waitForWorkspaceChange: async () => {},
      now: () => clock,
    };
    await runClaudeMonitor({ sessionId: "session-1", projectDir: project, pluginRoot: "/plugin" }, deps, abort.signal);

    expect({ registerCalls, streamCalls, statusCalls, sleeps }).toEqual({
      // One connect before the park, six inconclusive probes that must NOT trigger a reconnect,
      // and exactly one more connect once the seventh probe reports a literal `connected:false`.
      registerCalls: 2,
      streamCalls: 2,
      statusCalls: 7,
      sleeps: [
        PARK_PROBE_BASE_MS,
        PARK_PROBE_REQUEST_TIMEOUT_MS,
        PARK_PROBE_BASE_MS,
        PARK_PROBE_REQUEST_TIMEOUT_MS,
        PARK_PROBE_BASE_MS,
        PARK_PROBE_REQUEST_TIMEOUT_MS,
        PARK_PROBE_BASE_MS,
        PARK_PROBE_REQUEST_TIMEOUT_MS,
        PARK_PROBE_BASE_MS,
        PARK_PROBE_REQUEST_TIMEOUT_MS,
        PARK_PROBE_BASE_MS,
        PARK_PROBE_REQUEST_TIMEOUT_MS,
        PARK_PROBE_BASE_MS,
        PARK_PROBE_REQUEST_TIMEOUT_MS,
        MONITOR_MIN_DELAY_MS,
      ],
    });
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  test("a daemon-discovery failure during a parked probe is inconclusive, not free (#206 review round 1, F-6)", async () => {
    const home = mkdtempSync(join(tmpdir(), "glosa-monitor-f6-discovery-"));
    const project = realpathSync(mkdtempSync(join(tmpdir(), "glosa-monitor-f6-discovery-project-")));
    seedWorkspace(home, project);
    const daemon = seedFakeDaemon(home);

    let handshakeCalls = 0;
    // Handshake #1 is the initial connect; handshake #2 is the FIRST park probe's own discovery —
    // failing exactly that one proves a discovery failure mid-park is inconclusive, not free.
    withFakeGlobalFetch(daemon, {
      handshakeOk: () => {
        handshakeCalls += 1;
        return handshakeCalls !== 2;
      },
    });

    const abort = new AbortController();
    let registerCalls = 0;
    let streamCalls = 0;
    let statusCalls = 0;
    const sleeps: number[] = [];
    let clock = 0;
    const deps: MonitorDeps = {
      home: () => home,
      fetch: (async (input: RequestInfo | URL) => {
        const href = input.toString();
        if (href.endsWith("/api/sessions/register")) {
          registerCalls += 1;
          return new Response(JSON.stringify({ session_id: "session-1", workspace: project }), { status: 200 });
        }
        if (href.endsWith("/stream/status")) {
          statusCalls += 1;
          return new Response(JSON.stringify({ connected: false, transport: null }), { status: 200 });
        }
        if (href.endsWith("/stream")) {
          streamCalls += 1;
          if (streamCalls === 1) return streamResponse([sseFrame("superseded", { transport: "monitor" })]);
          abort.abort();
          return streamResponse([]);
        }
        throw new Error(`unexpected fetch ${href}`);
      }) as unknown as typeof fetch,
      stdout: { write: (_chunk, callback) => callback() },
      random: () => 0,
      sleep: async (ms) => {
        sleeps.push(ms);
        if (ms === PARK_PROBE_REQUEST_TIMEOUT_MS) return new Promise<void>(() => {});
        clock += ms;
      },
      waitForWorkspaceChange: async () => {},
      now: () => clock,
    };
    await runClaudeMonitor({ sessionId: "session-1", projectDir: project, pluginRoot: "/plugin" }, deps, abort.signal);

    // First park probe: discovery itself fails -> inconclusive, the HTTP status route is never
    // reached for that cycle (but the race still starts its own timeout leg unconditionally).
    // Second park probe: discovery succeeds, connected:false -> free.
    expect({ registerCalls, streamCalls, statusCalls, sleeps }).toEqual({
      registerCalls: 2,
      streamCalls: 2,
      statusCalls: 1,
      sleeps: [
        PARK_PROBE_BASE_MS,
        PARK_PROBE_REQUEST_TIMEOUT_MS,
        PARK_PROBE_BASE_MS,
        PARK_PROBE_REQUEST_TIMEOUT_MS,
        MONITOR_MIN_DELAY_MS,
      ],
    });
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  test("a never-answering ownership probe times out and stays inconclusive instead of hanging the park loop forever (#206 review round 1, F-7)", async () => {
    const home = mkdtempSync(join(tmpdir(), "glosa-monitor-f7-hang-"));
    const project = realpathSync(mkdtempSync(join(tmpdir(), "glosa-monitor-f7-hang-project-")));
    seedWorkspace(home, project);
    const daemon = seedFakeDaemon(home);
    withFakeGlobalFetch(daemon);

    const abort = new AbortController();
    let registerCalls = 0;
    let streamCalls = 0;
    let statusCalls = 0;
    const sleeps: number[] = [];
    let clock = 0;
    // Which park-probe CYCLE we're in, bumped exactly when that cycle's own interval sleep is
    // requested — strictly before that cycle's probe (and its internal timeout race) ever starts,
    // per `parkUntilFree`'s own program order. Deciding the timeout race's fate from THIS (rather
    // than from `statusCalls`, which the fetch handler only bumps after several of the probe's own
    // internal awaits) avoids a real ordering race between "was this cycle's fetch handler already
    // reached" and "has this cycle's timeout-race sleep already been evaluated".
    let cycle = 0;
    const deps: MonitorDeps = {
      home: () => home,
      fetch: (async (input: RequestInfo | URL) => {
        const href = input.toString();
        if (href.endsWith("/api/sessions/register")) {
          registerCalls += 1;
          return new Response(JSON.stringify({ session_id: "session-1", workspace: project }), { status: 200 });
        }
        if (href.endsWith("/stream/status")) {
          statusCalls += 1;
          if (statusCalls === 1) return new Promise<Response>(() => {}); // accepted, never answers
          return new Response(JSON.stringify({ connected: false, transport: null }), { status: 200 });
        }
        if (href.endsWith("/stream")) {
          streamCalls += 1;
          if (streamCalls === 1) return streamResponse([sseFrame("superseded", { transport: "monitor" })]);
          abort.abort(); // reconnection proven — the loop did NOT hang forever
          return streamResponse([]);
        }
        throw new Error(`unexpected fetch ${href}`);
      }) as unknown as typeof fetch,
      stdout: { write: (_chunk, callback) => callback() },
      random: () => 0,
      // The request-timeout leg (`PARK_PROBE_REQUEST_TIMEOUT_MS`) must resolve immediately for the
      // FIRST probe (its fetch never answers, so this timeout is the only way the race can ever
      // complete) but must never resolve for the SECOND (its fetch answers normally, and the real
      // answer must be what wins) — driven entirely by injected deps, no real waiting either way.
      sleep: async (ms) => {
        sleeps.push(ms);
        if (ms === PARK_PROBE_BASE_MS) {
          cycle += 1;
          clock += ms;
          return;
        }
        if (ms === PARK_PROBE_REQUEST_TIMEOUT_MS) {
          if (cycle >= 2) return new Promise<void>(() => {});
          return;
        }
        clock += ms;
      },
      waitForWorkspaceChange: async () => {},
      now: () => clock,
    };
    await runClaudeMonitor({ sessionId: "session-1", projectDir: project, pluginRoot: "/plugin" }, deps, abort.signal);

    expect({ registerCalls, streamCalls, statusCalls, sleeps }).toEqual({
      // The hung first probe timed out (inconclusive) instead of blocking the loop forever; the
      // second probe's real, prompt answer is what actually ends the park. Both cycles invoke the
      // request-timeout race (`Promise.race` starts both legs unconditionally) — only the first
      // cycle's actually resolves via that leg.
      registerCalls: 2,
      streamCalls: 2,
      statusCalls: 2,
      sleeps: [
        PARK_PROBE_BASE_MS,
        PARK_PROBE_REQUEST_TIMEOUT_MS,
        PARK_PROBE_BASE_MS,
        PARK_PROBE_REQUEST_TIMEOUT_MS,
        MONITOR_MIN_DELAY_MS,
      ],
    });
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  test("a slow-but-answered probe does not push the next probe past the contract's interval — absolute cadence compensates for elapsed time (#206 review round 1, F-7)", async () => {
    const home = mkdtempSync(join(tmpdir(), "glosa-monitor-f7-cadence-"));
    const project = realpathSync(mkdtempSync(join(tmpdir(), "glosa-monitor-f7-cadence-project-")));
    seedWorkspace(home, project);
    const daemon = seedFakeDaemon(home);
    withFakeGlobalFetch(daemon);

    const abort = new AbortController();
    let registerCalls = 0;
    let streamCalls = 0;
    let statusCalls = 0;
    const sleeps: number[] = [];
    let clock = 0;
    const ELAPSED_DURING_PROBE = 4_000; // well under the interval and under the request timeout
    const deps: MonitorDeps = {
      home: () => home,
      fetch: (async (input: RequestInfo | URL) => {
        const href = input.toString();
        if (href.endsWith("/api/sessions/register")) {
          registerCalls += 1;
          return new Response(JSON.stringify({ session_id: "session-1", workspace: project }), { status: 200 });
        }
        if (href.endsWith("/stream/status")) {
          statusCalls += 1;
          // The FIRST probe's own request "takes" ELAPSED_DURING_PROBE simulated milliseconds
          // (advancing the injected clock) before it answers "still busy"; the SECOND probe answers
          // immediately with "free".
          if (statusCalls === 1) clock += ELAPSED_DURING_PROBE;
          const connected = statusCalls < 2;
          return new Response(JSON.stringify({ connected, transport: connected ? "monitor" : null }), {
            status: 200,
          });
        }
        if (href.endsWith("/stream")) {
          streamCalls += 1;
          if (streamCalls === 1) return streamResponse([sseFrame("superseded", { transport: "monitor" })]);
          abort.abort();
          return streamResponse([]);
        }
        throw new Error(`unexpected fetch ${href}`);
      }) as unknown as typeof fetch,
      stdout: { write: (_chunk, callback) => callback() },
      random: () => 0,
      sleep: async (ms) => {
        sleeps.push(ms);
        if (ms === PARK_PROBE_REQUEST_TIMEOUT_MS) return new Promise<void>(() => {});
        clock += ms;
      },
      waitForWorkspaceChange: async () => {},
      now: () => clock,
    };
    await runClaudeMonitor({ sessionId: "session-1", projectDir: project, pluginRoot: "/plugin" }, deps, abort.signal);

    expect({ registerCalls, streamCalls, statusCalls, sleeps }).toEqual({
      registerCalls: 2,
      streamCalls: 2,
      statusCalls: 2,
      // The first interval sleep is the full base delay; the first probe itself then "takes"
      // ELAPSED_DURING_PROBE, so the SECOND interval sleep is shortened by exactly that much —
      // proving the next probe is scheduled from an absolute cadence anchored to the previous
      // SCHEDULED time, not "a fresh full interval on top of however long the last one took".
      sleeps: [
        PARK_PROBE_BASE_MS,
        PARK_PROBE_REQUEST_TIMEOUT_MS,
        PARK_PROBE_BASE_MS - ELAPSED_DURING_PROBE,
        PARK_PROBE_REQUEST_TIMEOUT_MS,
        MONITOR_MIN_DELAY_MS,
      ],
    });
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });
});

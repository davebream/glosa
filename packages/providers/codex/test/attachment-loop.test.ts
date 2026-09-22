// SPDX-License-Identifier: Apache-2.0
// #206: the Codex attachment's connect/park/retry state machine, exercised with fully injected
// deps and NO real socket of any kind — `app-server.test.ts`'s `protocolPeer` helper binds a real
// Unix socket under a temp-dir path that exceeds macOS's 104-byte limit in this checkout's local
// check runtime, so that file cannot run here. Everything this suite needs to prove about
// `runCodexAttachment`'s own decisions (park vs retry, when it may register/stream, and the
// in-flight-failure precedence barrier) is reachable through `CodexAttachDeps` alone.
import { describe, expect, test } from "bun:test";
import type { DeliverableEntry } from "@glosa/daemon";
import {
  CODEX_ATTACH_MIN_DELAY_MS,
  CODEX_PARK_PROBE_BASE_MS,
  CODEX_PARK_PROBE_JITTER_MS,
  CODEX_PARK_PROBE_REQUEST_TIMEOUT_MS,
  type CodexAttachDeps,
  type CodexControlClient,
  codexParkProbeDelay,
  runCodexAttachment,
} from "../src/app-server.ts";

/** #206 F-7: `probeSessionConnected` races the real status request against a
 * `CODEX_PARK_PROBE_REQUEST_TIMEOUT_MS` sleep. A fake `sleep` that always resolves immediately
 * would make that race non-deterministic (a same-tick "resolve immediately" mock can spuriously
 * win against a real, slightly-slower promise chain), so every test below routes its `sleep` mock
 * through this helper: the timeout leg never resolves unless the test explicitly wants a timeout,
 * and every OTHER sleep call advances a fake clock by its own ms so `now()` stays in lockstep with
 * `parkUntilFree`'s absolute-cadence math — all without any real waiting. */
function trackedSleep(
  sleeps: number[],
  options: { clock?: { advance(ms: number): void }; timesOutAt?: () => boolean } = {},
): CodexAttachDeps["sleep"] {
  return async (ms) => {
    sleeps.push(ms);
    if (ms === CODEX_PARK_PROBE_REQUEST_TIMEOUT_MS && (options.timesOutAt?.() ?? false)) return;
    if (ms === CODEX_PARK_PROBE_REQUEST_TIMEOUT_MS) return new Promise<void>(() => {});
    options.clock?.advance(ms);
  };
}

const ENTRY: DeliverableEntry = {
  id: "entry-1",
  kind: "annotation",
  status: "pending",
  text: "Review this sentence.",
  bytes: 21,
  detail: { artifact_path: "notes.md" },
  truncation: { truncated: false, omitted_bytes: 0, omitted_hunks: 0 },
  retrieval: { command: "glosa inbox get entry-1", mcp_tool: "glosa_inbox_get" },
};

function fakeControl(overrides: Partial<CodexControlClient> = {}): CodexControlClient {
  let finishClosed = () => {};
  return {
    resume: async () => {},
    deliver: async () => {},
    onTurnCompleted: () => () => {},
    closed: new Promise<void>((resolve) => {
      finishClosed = resolve;
    }),
    close() {
      finishClosed();
    },
    ...overrides,
  };
}

describe("Codex attachment park/retry state machine (#206, socket-free)", () => {
  test("park probe delay is a fixed 15-18s window with no backoff growth", () => {
    expect(codexParkProbeDelay(() => 0)).toBe(CODEX_PARK_PROBE_BASE_MS);
    expect(codexParkProbeDelay(() => 1)).toBe(CODEX_PARK_PROBE_BASE_MS + CODEX_PARK_PROBE_JITTER_MS);
    expect(codexParkProbeDelay(() => 0.5)).toBeLessThan(CODEX_PARK_PROBE_BASE_MS + CODEX_PARK_PROBE_JITTER_MS);
  });

  test("a plain EOF (ended:'eof') retries as today — no ownership probe is ever consulted", async () => {
    const controller = new AbortController();
    let connectAttempts = 0;
    let statusCalls = 0;
    const sleeps: number[] = [];
    const deps: CodexAttachDeps = {
      createControlClient: async () => fakeControl(),
      createDaemonClient: async () => ({
        register: async () => {},
        heartbeat: async () => {},
        acknowledgeStreamTransport: async () => {},
        sessionStreamStatus: async () => {
          statusCalls += 1;
          return { connected: false, transport: null };
        },
        openSessionStream: async () => {
          connectAttempts += 1;
          if (connectAttempts >= 2) controller.abort();
          return { ended: "eof" as const };
        },
      }),
      random: () => 0,
      sleep: async (ms, signal) => {
        sleeps.push(ms);
        if (signal.aborted) return;
      },
      now: () => 0, // never entered: an ordinary EOF never reaches parkUntilFree
    };
    await runCodexAttachment(
      { sessionId: "thread-1", workspace: "/workspace", cwd: "/agent" },
      deps,
      controller.signal,
    );

    expect({ connectAttempts, statusCalls, sleeps }).toEqual({
      connectAttempts: 2,
      statusCalls: 0, // #206: an ordinary EOF never consults the ownership probe
      // One retry sleep per attempt, growing — unchanged ordinary-EOF backoff, never a park probe.
      sleeps: [CODEX_ATTACH_MIN_DELAY_MS, 8_000],
    });
  });

  test("superseded parks without reconnecting; a connected probe keeps it parked; a free probe reconnects (#206)", async () => {
    const controller = new AbortController();
    let connectAttempts = 0;
    let registerCalls = 0;
    let statusCalls = 0;
    const sleeps: number[] = [];
    let clock = 0;
    const deps: CodexAttachDeps = {
      createControlClient: async () => fakeControl(),
      createDaemonClient: async () => ({
        register: async () => {
          registerCalls += 1;
        },
        heartbeat: async () => {},
        acknowledgeStreamTransport: async () => {},
        sessionStreamStatus: async () => {
          statusCalls += 1;
          // First probe: the new owner is still connected — stay parked. Second: free — reconnect.
          const connected = statusCalls === 1;
          return { connected, transport: connected ? "codex_app_server" : null };
        },
        openSessionStream: async () => {
          connectAttempts += 1;
          if (connectAttempts === 1) return { ended: "superseded" as const };
          controller.abort(); // reconnection proven — stop the loop here
          return { ended: "eof" as const };
        },
      }),
      random: () => 0,
      sleep: trackedSleep(sleeps, { clock: { advance: (ms) => (clock += ms) } }),
      now: () => clock,
    };
    await runCodexAttachment(
      { sessionId: "thread-1", workspace: "/workspace", cwd: "/agent" },
      deps,
      controller.signal,
    );

    expect({ connectAttempts, registerCalls, statusCalls, sleeps }).toEqual({
      // Exactly one connect before the park and one more after the free probe — never a
      // register/stream call WHILE parked, and never an ordinary retry sleep for a superseded end.
      // Each probe's own request-timeout race sleep is invoked once per probe too (`Promise.race`
      // starts both legs unconditionally) — it never actually wins here since this fake daemon
      // client always answers.
      connectAttempts: 2,
      registerCalls: 2,
      statusCalls: 2,
      sleeps: [
        CODEX_PARK_PROBE_BASE_MS,
        CODEX_PARK_PROBE_REQUEST_TIMEOUT_MS,
        CODEX_PARK_PROBE_BASE_MS,
        CODEX_PARK_PROBE_REQUEST_TIMEOUT_MS,
        CODEX_ATTACH_MIN_DELAY_MS,
      ],
    });
  });

  test("inconclusive probes (daemon-client creation failure, thrown status error) all keep it parked", async () => {
    const controller = new AbortController();
    let connectAttempts = 0;
    let statusAttempts = 0;
    let daemonClientAttempts = 0;
    const sleeps: number[] = [];
    let clock = 0;
    const deps: CodexAttachDeps = {
      createControlClient: async () => fakeControl(),
      createDaemonClient: async () => {
        daemonClientAttempts += 1;
        // The FIRST park probe's own `createDaemonClient` call fails outright — "daemon
        // unreachable" — before it can even ask for status. Every other call succeeds.
        if (daemonClientAttempts === 2) throw new Error("daemon unreachable");
        return {
          register: async () => {},
          heartbeat: async () => {},
          acknowledgeStreamTransport: async () => {},
          sessionStreamStatus: async () => {
            statusAttempts += 1;
            if (statusAttempts === 1) throw new Error("network error"); // the SECOND park probe
            return { connected: false, transport: null }; // the THIRD park probe — now free
          },
          openSessionStream: async () => {
            connectAttempts += 1;
            if (connectAttempts === 1) return { ended: "superseded" as const };
            controller.abort(); // reconnection proven — stop the loop here
            return { ended: "eof" as const };
          },
        };
      },
      random: () => 0,
      sleep: trackedSleep(sleeps, { clock: { advance: (ms) => (clock += ms) } }),
      now: () => clock,
    };

    await runCodexAttachment(
      { sessionId: "thread-1", workspace: "/workspace", cwd: "/agent" },
      deps,
      controller.signal,
    );

    // Probe 1: `createDaemonClient` itself throws -> inconclusive, the status route is never
    // reached. Probe 2: `sessionStreamStatus` throws -> inconclusive. Probe 3: connected:false ->
    // free. Each probe's own request-timeout race sleep is invoked unconditionally too.
    expect({ connectAttempts, statusAttempts, sleeps }).toEqual({
      connectAttempts: 2,
      statusAttempts: 2,
      sleeps: [
        CODEX_PARK_PROBE_BASE_MS,
        CODEX_PARK_PROBE_REQUEST_TIMEOUT_MS,
        CODEX_PARK_PROBE_BASE_MS,
        CODEX_PARK_PROBE_REQUEST_TIMEOUT_MS,
        CODEX_PARK_PROBE_BASE_MS,
        CODEX_PARK_PROBE_REQUEST_TIMEOUT_MS,
        CODEX_ATTACH_MIN_DELAY_MS,
      ],
    });
  });

  test("a daemon client with no sessionStreamStatus support is treated as inconclusive, not free", async () => {
    const controller = new AbortController();
    let connectAttempts = 0;
    let parkCycles = 0;
    const sleeps: number[] = [];
    let clock = 0;
    const deps: CodexAttachDeps = {
      createControlClient: async () => fakeControl(),
      createDaemonClient: async () => ({
        register: async () => {},
        heartbeat: async () => {},
        acknowledgeStreamTransport: async () => {},
        // no sessionStreamStatus at all
        openSessionStream: async () => {
          connectAttempts += 1;
          if (connectAttempts === 1) return { ended: "superseded" as const };
          return { ended: "eof" as const };
        },
      }),
      random: () => 0,
      sleep: trackedSleep(sleeps, {
        clock: { advance: (ms) => (clock += ms) },
        timesOutAt: () => false, // never lets the (irrelevant — no status method) race "resolve" via timeout
      }),
      now: () => clock,
    };
    // Bounded: abort after three full park cycles to prove it never reconnects on its own, however
    // long we let it keep discovering the same (still-absent) status method.
    const originalSleep = deps.sleep;
    deps.sleep = async (ms, signal) => {
      if (ms === CODEX_PARK_PROBE_BASE_MS) {
        parkCycles += 1;
        if (parkCycles > 3) controller.abort();
      }
      return originalSleep(ms, signal);
    };

    await runCodexAttachment(
      { sessionId: "thread-1", workspace: "/workspace", cwd: "/agent" },
      deps,
      controller.signal,
    );

    expect(connectAttempts).toBe(1); // never reconnected — every probe stayed inconclusive
    expect(sleeps).toEqual([
      CODEX_PARK_PROBE_BASE_MS,
      CODEX_PARK_PROBE_REQUEST_TIMEOUT_MS,
      CODEX_PARK_PROBE_BASE_MS,
      CODEX_PARK_PROBE_REQUEST_TIMEOUT_MS,
      CODEX_PARK_PROBE_BASE_MS,
      CODEX_PARK_PROBE_REQUEST_TIMEOUT_MS,
      CODEX_PARK_PROBE_BASE_MS,
    ]);
  });

  test("an in-flight delivery/ack failure does not mask an already-issued superseded frame (barrier, #206)", async () => {
    // Models the real `openSessionStream` precedence contract (daemon-client.ts / #206 criterion 2)
    // as a pure fake: `onEntry` fails (the transport acknowledgement lost its pending record to the
    // replacement), yet the stream still resolves — never rejects — `ended:"superseded"` once its
    // own read loop reaches EOF. This proves `runCodexAttachment` keys off that resolved value
    // (parking, not retrying) rather than assuming any onEntry failure means an ordinary error.
    const controller = new AbortController();
    let connectAttempts = 0;
    let registerCalls = 0;
    let ackCalls = 0;
    let statusCalls = 0;
    const delivered: DeliverableEntry[] = [];
    const sleeps: number[] = [];
    let clock = 0;
    const deps: CodexAttachDeps = {
      createControlClient: async () => fakeControl({ deliver: async (_threadId, entry) => void delivered.push(entry) }),
      createDaemonClient: async () => ({
        register: async () => {
          registerCalls += 1;
        },
        heartbeat: async () => {},
        acknowledgeStreamTransport: async () => {
          ackCalls += 1;
          throw new Error("stream acknowledgement failed (409)"); // replacement deleted the pending ack
        },
        sessionStreamStatus: async () => {
          statusCalls += 1;
          return { connected: false, transport: null }; // free on the very first probe
        },
        openSessionStream: async (_sessionId, _transport, onEntry) => {
          connectAttempts += 1;
          if (connectAttempts === 1) {
            await onEntry(ENTRY).catch(() => {}); // deliver succeeds, the ack throws — swallowed here
            return { ended: "superseded" as const }; // precedence: superseded wins over that failure
          }
          controller.abort();
          return { ended: "eof" as const };
        },
      }),
      random: () => 0,
      sleep: trackedSleep(sleeps, { clock: { advance: (ms) => (clock += ms) } }),
      now: () => clock,
    };
    await runCodexAttachment(
      { sessionId: "thread-1", workspace: "/workspace", cwd: "/agent" },
      deps,
      controller.signal,
    );

    expect({ connectAttempts, registerCalls, ackCalls, statusCalls, sleeps, delivered }).toEqual({
      connectAttempts: 2,
      registerCalls: 2,
      ackCalls: 1,
      statusCalls: 1,
      sleeps: [CODEX_PARK_PROBE_BASE_MS, CODEX_PARK_PROBE_REQUEST_TIMEOUT_MS, CODEX_ATTACH_MIN_DELAY_MS],
      delivered: [ENTRY],
    });
  });

  test("issue #155: a signal frame is steered into the thread as one `[glosa signal <id>]` line, then acknowledged with its own token", async () => {
    const controller = new AbortController();
    const notified: string[] = [];
    const acks: Array<[string, string, string]> = [];
    const sleeps: number[] = [];
    const deps: CodexAttachDeps = {
      createControlClient: async () => fakeControl({ notify: async (_threadId, line) => void notified.push(line) }),
      createDaemonClient: async () => ({
        register: async () => {},
        heartbeat: async () => {},
        acknowledgeStreamTransport: async () => {},
        acknowledgeSignal: async (sessionId, signalId, token) => void acks.push([sessionId, signalId, token]),
        openSessionStream: async (_sessionId, _transport, _onEntry, _signal, _onOpen, onSignal) => {
          await onSignal?.({
            id: "sig-1",
            kind: "conflict",
            message: "a person took over entry:e1.",
            ack_token: "tok-1",
          });
          controller.abort();
          return { ended: "eof" as const };
        },
      }),
      random: () => 0,
      sleep: trackedSleep(sleeps),
      now: () => 0,
    };
    await runCodexAttachment(
      { sessionId: "thread-1", workspace: "/workspace", cwd: "/agent" },
      deps,
      controller.signal,
    );

    expect(notified).toEqual(["[glosa signal sig-1] conflict: a person took over entry:e1."]);
    expect(acks).toEqual([["thread-1", "sig-1", "tok-1"]]);
  });

  test("only a literal connected:false frees a parked client — malformed bodies stay parked (#206 review round 1, F-6)", async () => {
    const controller = new AbortController();
    let connectAttempts = 0;
    let statusCalls = 0;
    const sleeps: number[] = [];
    let clock = 0;
    // Four inconclusive shapes a naive `status.connected === true ? true : false` reading would
    // wrongly treat as free, followed by the ONE response that legitimately is:
    //   1. {}                     — no `connected` field at all
    //   2. {connected:null}       — the field is present but not a boolean
    //   3. {connected:"false"}    — a string, not the boolean primitive
    //   4. {}                     — again, to prove repeats stay inconclusive too
    //   5. {connected:false}      — the ONLY response that may end the park
    const bodiesByCycle: Array<() => { connected?: unknown; transport: string | null }> = [
      () => ({ transport: "codex_app_server" }),
      () => ({ connected: null, transport: "codex_app_server" }),
      () => ({ connected: "false", transport: "codex_app_server" }),
      () => ({ transport: "codex_app_server" }),
    ];
    const deps: CodexAttachDeps = {
      createControlClient: async () => fakeControl(),
      createDaemonClient: async () => ({
        register: async () => {},
        heartbeat: async () => {},
        acknowledgeStreamTransport: async () => {},
        sessionStreamStatus: async () => {
          statusCalls += 1;
          if (statusCalls <= bodiesByCycle.length) {
            return bodiesByCycle[statusCalls - 1]!() as { connected: boolean; transport: string | null };
          }
          return { connected: false, transport: null };
        },
        openSessionStream: async () => {
          connectAttempts += 1;
          if (connectAttempts === 1) return { ended: "superseded" as const };
          controller.abort(); // reconnection proven — stop the loop here
          return { ended: "eof" as const };
        },
      }),
      random: () => 0,
      sleep: trackedSleep(sleeps, { clock: { advance: (ms) => (clock += ms) } }),
      now: () => clock,
    };

    await runCodexAttachment(
      { sessionId: "thread-1", workspace: "/workspace", cwd: "/agent" },
      deps,
      controller.signal,
    );

    expect({ connectAttempts, statusCalls, sleeps }).toEqual({
      // One connect before the park, four inconclusive probes that must NOT trigger a reconnect,
      // and exactly one more connect once the fifth probe reports a literal `connected:false`.
      connectAttempts: 2,
      statusCalls: 5,
      sleeps: [
        CODEX_PARK_PROBE_BASE_MS,
        CODEX_PARK_PROBE_REQUEST_TIMEOUT_MS,
        CODEX_PARK_PROBE_BASE_MS,
        CODEX_PARK_PROBE_REQUEST_TIMEOUT_MS,
        CODEX_PARK_PROBE_BASE_MS,
        CODEX_PARK_PROBE_REQUEST_TIMEOUT_MS,
        CODEX_PARK_PROBE_BASE_MS,
        CODEX_PARK_PROBE_REQUEST_TIMEOUT_MS,
        CODEX_PARK_PROBE_BASE_MS,
        CODEX_PARK_PROBE_REQUEST_TIMEOUT_MS,
        CODEX_ATTACH_MIN_DELAY_MS,
      ],
    });
  });

  test("a never-answering ownership probe times out and stays inconclusive instead of hanging the park loop forever (#206 review round 1, F-7)", async () => {
    const controller = new AbortController();
    let connectAttempts = 0;
    let statusCalls = 0;
    const sleeps: number[] = [];
    let clock = 0;
    const deps: CodexAttachDeps = {
      createControlClient: async () => fakeControl(),
      createDaemonClient: async () => ({
        register: async () => {},
        heartbeat: async () => {},
        acknowledgeStreamTransport: async () => {},
        sessionStreamStatus: async () => {
          statusCalls += 1;
          if (statusCalls === 1) return new Promise<{ connected: boolean; transport: string | null }>(() => {}); // never answers
          return { connected: false, transport: null };
        },
        openSessionStream: async () => {
          connectAttempts += 1;
          if (connectAttempts === 1) return { ended: "superseded" as const };
          controller.abort(); // reconnection proven — the loop did NOT hang forever
          return { ended: "eof" as const };
        },
      }),
      random: () => 0,
      // The request-timeout leg must resolve immediately for the FIRST probe (its own status call
      // never answers, so this timeout is the only way the race can ever complete) but must never
      // resolve for the SECOND (its status call answers normally, and that real answer must win) —
      // driven entirely by injected deps, no real waiting either way. `cycle` is bumped exactly
      // when that cycle's OWN interval sleep fires, strictly before its probe starts (per
      // `parkUntilFree`'s own program order), avoiding any race against how many of the probe's own
      // internal awaits have resolved yet.
      sleep: trackedSleep(sleeps, {
        clock: { advance: (ms) => (clock += ms) },
        timesOutAt: () => cycle < 2,
      }),
      now: () => clock,
    };
    let cycle = 0;
    const originalSleep = deps.sleep;
    deps.sleep = (ms, signal) => {
      if (ms === CODEX_PARK_PROBE_BASE_MS) cycle += 1;
      return originalSleep(ms, signal);
    };

    await runCodexAttachment(
      { sessionId: "thread-1", workspace: "/workspace", cwd: "/agent" },
      deps,
      controller.signal,
    );

    expect({ connectAttempts, statusCalls, sleeps }).toEqual({
      // The hung first probe timed out (inconclusive) instead of blocking the loop forever; the
      // second probe's real, prompt answer is what actually ends the park. Both cycles invoke the
      // request-timeout race unconditionally — only the first cycle's actually resolves via it.
      connectAttempts: 2,
      statusCalls: 2,
      sleeps: [
        CODEX_PARK_PROBE_BASE_MS,
        CODEX_PARK_PROBE_REQUEST_TIMEOUT_MS,
        CODEX_PARK_PROBE_BASE_MS,
        CODEX_PARK_PROBE_REQUEST_TIMEOUT_MS,
        CODEX_ATTACH_MIN_DELAY_MS,
      ],
    });
  });

  test("a slow-but-answered probe does not push the next probe past the contract's interval — absolute cadence compensates for elapsed time (#206 review round 1, F-7)", async () => {
    const controller = new AbortController();
    let connectAttempts = 0;
    let statusCalls = 0;
    const sleeps: number[] = [];
    let clock = 0;
    const ELAPSED_DURING_PROBE = 4_000; // well under the interval and under the request timeout
    const deps: CodexAttachDeps = {
      createControlClient: async () => fakeControl(),
      createDaemonClient: async () => ({
        register: async () => {},
        heartbeat: async () => {},
        acknowledgeStreamTransport: async () => {},
        sessionStreamStatus: async () => {
          statusCalls += 1;
          // The FIRST probe's own request "takes" ELAPSED_DURING_PROBE simulated milliseconds
          // (advancing the injected clock) before it answers "still busy"; the SECOND probe
          // answers immediately with "free".
          if (statusCalls === 1) clock += ELAPSED_DURING_PROBE;
          const connected = statusCalls < 2;
          return { connected, transport: connected ? "codex_app_server" : null };
        },
        openSessionStream: async () => {
          connectAttempts += 1;
          if (connectAttempts === 1) return { ended: "superseded" as const };
          controller.abort();
          return { ended: "eof" as const };
        },
      }),
      random: () => 0,
      sleep: trackedSleep(sleeps, { clock: { advance: (ms) => (clock += ms) } }),
      now: () => clock,
    };

    await runCodexAttachment(
      { sessionId: "thread-1", workspace: "/workspace", cwd: "/agent" },
      deps,
      controller.signal,
    );

    expect({ connectAttempts, statusCalls, sleeps }).toEqual({
      connectAttempts: 2,
      statusCalls: 2,
      // The first interval sleep is the full base delay; the first probe itself then "takes"
      // ELAPSED_DURING_PROBE, so the SECOND interval sleep is shortened by exactly that much —
      // proving the next probe is scheduled from an absolute cadence anchored to the previous
      // SCHEDULED time, not "a fresh full interval on top of however long the last one took".
      sleeps: [
        CODEX_PARK_PROBE_BASE_MS,
        CODEX_PARK_PROBE_REQUEST_TIMEOUT_MS,
        CODEX_PARK_PROBE_BASE_MS - ELAPSED_DURING_PROBE,
        CODEX_PARK_PROBE_REQUEST_TIMEOUT_MS,
        CODEX_ATTACH_MIN_DELAY_MS,
      ],
    });
  });
});

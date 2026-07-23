// SPDX-License-Identifier: Apache-2.0
// P5.2 (T8 release gate — concurrency). The existing concurrency suites
// (bus/concurrency.test.ts, bus/mutex.test.ts, registry/lockfile-fallback.test.ts,
// sessions-routes.test.ts's "two concurrent drain calls") all prove correctness under concurrent
// PROMISES inside ONE test process — real and valuable (the daemon is single-process, so its own
// event-loop interleaving is exactly what those tests exercise), but they never prove the daemon
// correctly serializes writes when the REQUESTS themselves arrive over a real network socket from
// an actually separate OS process, the way two real `glosa` CLI invocations (or a CLI call racing
// a hook hitting the daemon at the same moment) would in production. `lifecycle.test.ts`'s
// "bootDaemon — subprocess fault/concurrency" describe DOES spawn real OS processes, but only to
// race DAEMON BOOT (the lock file) — not to race WRITES to one already-running daemon's
// workspace-level state (inbox/journal/lease).
//
// This file closes that gap: ONE real `glosa __daemon` subprocess (same `spawnDaemon` helper
// http.test.ts/lifecycle.test.ts already use), hit with genuinely concurrent `fetch()` calls over
// real loopback sockets. Since HTTP/TCP carries no OS-process identity to the server, a daemon
// bug in serializing concurrent WRITES to the same workspace would be equally exposed whether the
// two requests originated from one client process or two — what matters (and what nothing else
// tests) is that the requests actually raced as real concurrent socket I/O against a real,
// separate daemon process, not as concurrent Promises against an in-process `createApiFetch` mock.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tokenPath } from "../src/token.ts";
import { cleanupHome, freshHome, randomPort, spawnDaemon, stopDaemon, waitForHandshake } from "./helpers.ts";

const TOKEN = "concurrency-real-subprocess-test-token-0123456789";
const SUBPROCESS_TEST_TIMEOUT_MS = 20_000;

describe("real daemon subprocess — genuinely concurrent HTTP requests against ONE workspace", () => {
  let home: string;
  let port: number;
  let workspaceRoot: string;
  let proc: Bun.Subprocess;

  beforeEach(async () => {
    home = freshHome();
    port = randomPort();
    workspaceRoot = mkdtempSync(join(tmpdir(), "glosa-concurrency-ws-"));
    mkdirSync(home, { recursive: true });
    writeFileSync(tokenPath(home), TOKEN, { mode: 0o600 });
    proc = spawnDaemon(home, port, { GLOSA_CLASSF_PORT: String(port + 1) });
    const hs = await waitForHandshake(port, 15_000, proc);
    expect(hs, `daemon handshake failed (exitCode=${proc.exitCode})`).not.toBeNull();
  });

  afterEach(async () => {
    await stopDaemon(home, proc);
    cleanupHome(home);
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  function apiUrl(path: string): string {
    return `http://127.0.0.1:${port}${path}`;
  }
  function apiReq(path: string, body: unknown): Request {
    return new Request(apiUrl(path), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Origin: `http://127.0.0.1:${port}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  function it(name: string, fn: () => Promise<void> | void): void {
    test(name, fn, SUBPROCESS_TEST_TIMEOUT_MS);
  }

  it("N real concurrent apply-begin requests for the SAME entry, from N different sessions, over real sockets: exactly one lease wins, everyone else gets a real 409, and the journal ends up with exactly one apply_begin", async () => {
    const N = 8;
    const sessions = Array.from({ length: N }, (_, i) => `session-${i}`);

    // Genuinely concurrent: all N requests are fired in the same microtask, each traveling over
    // its own real TCP connection to the one live daemon process — not sequential awaits.
    const responses = await Promise.all(
      sessions.map((session) => fetch(apiReq("/api/workspaces/apply-begin", { path: workspaceRoot, entry: "e1", session }))),
    );
    const bodies = await Promise.all(responses.map((r) => r.json()));

    const wins = responses.filter((r) => r.status === 201);
    const conflicts = responses.filter((r) => r.status === 409);
    expect(wins).toHaveLength(1); // exactly one lease ever granted, no matter how many raced in
    expect(conflicts).toHaveLength(N - 1);
    for (const body of bodies) {
      if (typeof body.lease_id === "string") {
        expect(body.entry).toBe("e1"); // the winner really is for the entry we asked about
      } else {
        expect(body.type).toContain("lease-conflict");
      }
    }

    // The durable proof, read directly off disk: the real journal this real subprocess wrote has
    // exactly ONE apply_begin line for e1 — not zero (lost write), not N (the mutex didn't hold).
    const journalPath = join(workspaceRoot, ".glosa", "journal.ndjson");
    const journalText = readFileSync(journalPath, "utf8");
    const lines = journalText.split("\n").filter((l) => l.length > 0);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow(); // never a torn/corrupt line
    const applyBeginLines = lines.filter((l) => l.includes('"apply_begin"'));
    expect(applyBeginLines).toHaveLength(1);
  });

  it("concurrent apply-begin requests against TWO DIFFERENT real workspaces never contend with each other — the mutex is genuinely workspace-scoped, not a global daemon-wide lock", async () => {
    // A pure status-code assertion here (both calls return 201) can't tell "correctly
    // workspace-scoped" apart from "accidentally global": with a global mutex the two requests
    // would just serialize in TIME instead of running in parallel, and each would still see its
    // own bus's null lease and eventually succeed — well within this test's own timeout. The only
    // thing that actually distinguishes the two implementations is whether contention on one
    // workspace ever makes a concurrent request against a DIFFERENT workspace wait.
    //
    // `applyBegin` gives us a real, non-trivial, unconditional cost to exploit for timing:
    // `initShadowRepo` (git/shadow.ts) spawns ~7 real `git` subprocesses EVERY call, warm or not,
    // before it ever looks at lease state — all inside `this.mutex.runExclusive(this.root, ...)`.
    // So N genuinely concurrent apply-begin requests against one workspace root queue up N real,
    // measurable chunks of work on that root's mutex slot, whether or not each one goes on to win
    // the lease. If a SEPARATE workspace's concurrent request has to wait behind any of that
    // queue, the mutex isn't actually per-root.
    const baselineWorkspaceRoot = mkdtempSync(join(tmpdir(), "glosa-concurrency-ws-baseline-"));
    const otherWorkspaceRoot = mkdtempSync(join(tmpdir(), "glosa-concurrency-ws2-"));
    try {
      // Baseline: one solo, uncontended apply-begin against its own fresh workspace — establishes
      // roughly what this daemon/machine's real per-call cost is right now (git spawns + fsync'd
      // journal append), with no queuing of any kind.
      const baselineStart = performance.now();
      const baselineRes = await fetch(
        apiReq("/api/workspaces/apply-begin", { path: baselineWorkspaceRoot, entry: "e1", session: "sess-baseline" }),
      );
      const baselineMs = performance.now() - baselineStart;
      expect(baselineRes.status).toBe(201);

      // Load workspace A (the suite's shared `workspaceRoot`) with N genuinely concurrent
      // apply-begin requests — real fetch() calls fired in the same microtask, each racing the
      // others through workspace A's mutex slot exactly like the test above proves. Only one can
      // ever win the lease, but every one of the N pays the real initShadowRepo cost before it
      // finds that out, so this queues up ~N * baselineMs of real serialized work on root A.
      const N = 15;
      const loadResponses = Promise.all(
        Array.from({ length: N }, (_, i) =>
          fetch(apiReq("/api/workspaces/apply-begin", { path: workspaceRoot, entry: "e1", session: `sess-load-${i}` })),
        ),
      );

      // Fired immediately after (same synchronous turn, so genuinely overlapping with A's queue,
      // never after it drains): a single apply-begin against the fresh, otherwise-untouched
      // `otherWorkspaceRoot`. Only this call's own latency is timed.
      const bStart = performance.now();
      const resB = await fetch(
        apiReq("/api/workspaces/apply-begin", { path: otherWorkspaceRoot, entry: "e1", session: "sess-b" }),
      );
      const bMs = performance.now() - bStart;
      expect(resB.status).toBe(201);

      for (const res of await loadResponses) expect([201, 409]).toContain(res.status);

      // The discriminating assertion: workspace B's solo request, fired while workspace A's
      // mutex slot has N requests queued up on it, completes close to the UNLOADED baseline —
      // not proportionally to N. Substitute a single global mutex for the real per-root one and
      // this fails hard: B would be enqueued behind some/all of A's N pending critical sections
      // (up to ~N * baselineMs in the worst case, and even on average far more than a few times
      // baselineMs). The multiple below is generous headroom for scheduling jitter on a healthy
      // per-root implementation, while staying well under what any real global-lock queuing would
      // produce with N=15 competitors ahead of or around B.
      expect(bMs).toBeLessThan(Math.max(baselineMs * 4, 300));
    } finally {
      rmSync(baselineWorkspaceRoot, { recursive: true, force: true });
      rmSync(otherWorkspaceRoot, { recursive: true, force: true });
    }
  });
});

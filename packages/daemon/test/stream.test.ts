// P3.2 — `GET /w/:slug/stream` (A1 §5.5, full protocol A1 §8) against a REAL bound `Bun.serve`
// (not the direct-pipeline-call harness http-routes.test.ts uses) — a streaming response needs
// real sockets to test realistically: `server.timeout(req, 0)`'s idle-timeout override, chunk-
// boundary framing over the wire, and an actual client disconnect for the teardown/no-leak test
// all require a live connection, not a bare `Response` object handed back from a function call.
// The correctness bar this file exists for (per the task brief): the journal-offset cursor never
// loses an event across a reconnect, including across a simulated daemon restart. Route-schema-
// level auth/404 coverage for this route already lives in http-routes.test.ts; this file adds a
// couple of the same checks over real transport for realism, per http.test.ts's own precedent of
// duplicating a few pipeline checks at the live-server level.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiFetch, type ApiContext } from "../src/http.ts";
import { createJournalStreamResponse } from "../src/stream.ts";
import { WorkspaceBus } from "../src/bus/bus.ts";
import { WorkspaceIndex } from "../src/registry/workspace-index.ts";
import { SessionRegistry } from "../src/registry/session-registry.ts";
import { WorkspaceBusRegistry } from "../src/bus/workspace-bus-registry.ts";
import { canonicalize } from "../src/registry/slug.ts";
import { parseSseStream, type ParsedSseEvent } from "../src/sse.ts";
import { randomPort } from "./helpers.ts";

const TOKEN = "stream-test-token-0123456789abcdef";

interface Harness {
  home: string;
  root: string;
  port: number;
  server: ReturnType<typeof Bun.serve>;
  busRegistry: WorkspaceBusRegistry;
  slug: string;
}

/** Boots a real listener wrapping the real `createApiFetch` pipeline. `idleTimeout: 2` (seconds)
 * is deliberately short and NOT the production default — it exists so the "survives past the
 * server's idle timeout" test can prove `server.timeout(req, 0)`'s override actually fires
 * without waiting anywhere near Bun's real 10s default. */
async function buildHarness(opts: { home?: string; root?: string; port?: number } = {}): Promise<Harness> {
  const home = opts.home ?? mkdtempSync(join(tmpdir(), "glosa-stream-home-"));
  const root = opts.root ?? canonicalize(mkdtempSync(join(tmpdir(), "glosa-stream-ws-")));
  const port = opts.port ?? randomPort();

  const workspaceIndex = new WorkspaceIndex({ home });
  const sessionRegistry = new SessionRegistry({ index: workspaceIndex });
  const busRegistry = new WorkspaceBusRegistry();
  workspaceIndex.setLiveSessionPredicate((p) => sessionRegistry.forWorkspace(p).length > 0);
  workspaceIndex.setOnHardRemove((p) => busRegistry.evict(p));

  const entry = await workspaceIndex.upsertWorkspace(root, "glosa-open");

  const ctx: ApiContext = {
    port,
    classFPort: port + 1,
    token: TOKEN,
    instanceId: "gl-stream-test",
    startedAt: new Date().toISOString(),
    workspaceIndex,
    sessionRegistry,
    getWorkspaceBus: (r) => busRegistry.get(r),
  };
  const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: createApiFetch(ctx), idleTimeout: 2 });
  return { home, root, port, server, busRegistry, slug: entry.slug };
}

async function teardownHarness(h: Harness): Promise<void> {
  await h.server.stop(true);
  await h.busRegistry.close(h.root);
  rmSync(h.home, { recursive: true, force: true });
  rmSync(h.root, { recursive: true, force: true });
}

function streamUrl(h: Harness, since?: number): string {
  return `http://127.0.0.1:${h.port}/w/${h.slug}/stream${since !== undefined ? `?since=${since}` : ""}`;
}

/** `reader.cancel()` alone does NOT reliably tear down the underlying HTTP connection in Bun's
 * fetch client — it stops OUR OWN reading, but the socket can be left in the keep-alive pool
 * still "owned" by the still-open server-side SSE response, which then wedges the NEXT `fetch()`
 * to the same host:port (it queues behind a response that never finishes). An `AbortController`
 * is what actually closes the connection (and is also what fires the server's `req.signal`
 * "abort" listener — see stream.ts) — `disconnect()` below is the real "this client went away"
 * primitive every test in this file uses, not `reader.cancel()`. */
async function connect(
  h: Harness,
  headers: Record<string, string> = {},
  since?: number,
): Promise<{ res: Response; reader: ReadableStreamDefaultReader<Uint8Array>; disconnect: () => Promise<void> }> {
  const controller = new AbortController();
  const res = await fetch(streamUrl(h, since), {
    headers: { Authorization: `Bearer ${TOKEN}`, ...headers },
    signal: controller.signal,
  });
  const reader = res.body!.getReader();
  const disconnect = async () => {
    controller.abort();
    await reader.cancel().catch(() => {}); // release the reader lock too; an AbortError here is expected
  };
  return { res, reader, disconnect };
}

/** Reads exactly `count` non-heartbeat SSE events off `reader` (parseSseStream already drops
 * heartbeats), or throws once `timeoutMs` elapses — a hung reconnect/live-push is a real test
 * failure, not a suite that hangs forever. At most one `iterator.next()` call is ever in flight
 * at a time (the timeout is one shared promise, not re-created per loop iteration), so this never
 * races concurrent reads against the same async generator. */
async function readEvents(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  count: number,
  timeoutMs = 5000,
): Promise<ParsedSseEvent[]> {
  const iterator = parseSseStream(reader)[Symbol.asyncIterator]();
  const timeout = Bun.sleep(timeoutMs).then(() => "timeout" as const);
  const events: ParsedSseEvent[] = [];
  while (events.length < count) {
    const result = await Promise.race([iterator.next(), timeout]);
    if (result === "timeout") throw new Error(`timed out waiting for ${count} event(s) — got ${events.length}`);
    if (result.done) throw new Error(`stream ended early — got ${events.length}/${count} event(s)`);
    events.push(result.value);
  }
  return events;
}

/** `readEvents(reader, 1, ...)` narrowed to a single guaranteed-defined event — avoids
 * `noUncheckedIndexedAccess` friction (`const [x] = arr` types `x` as possibly-`undefined`) at
 * every single-event call site below. `readEvents` itself already guarantees exactly 1 element or
 * a thrown timeout/early-end error, so the fallback throw here is unreachable in practice. */
async function readEvent(reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs = 5000): Promise<ParsedSseEvent> {
  const [event] = await readEvents(reader, 1, timeoutMs);
  if (!event) throw new Error("unreachable — readEvents(reader, 1) always returns exactly 1 element or throws");
  return event;
}

describe("GET /w/:slug/stream — SSE protocol (A1 §8)", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await buildHarness();
  });

  afterEach(async () => {
    await teardownHarness(h);
  });

  test("first connect: one snapshot frame with the artifact list + per-artifact source_sha256 + inbox state, id = current cursor", async () => {
    writeFileSync(join(h.root, "notes.md"), "# hi\n");
    const { reader, disconnect } = await connect(h);
    const snap = await readEvent(reader);
    expect(snap.event).toBe("snapshot");
    // Not asserted as exactly "-1": a pre-existing untracked file makes reconcile's own
    // offline-catchup mint a baseline checkpoint event before the snapshot is taken, so the
    // journal isn't empty by the time this connects — currentCursor() is whatever it legitimately
    // is at that point, just required to be a valid cursor (a base-10 integer >= -1).
    expect(snap.id).toMatch(/^-?\d+$/);
    expect(Number(snap.id)).toBeGreaterThanOrEqual(-1);
    const data = JSON.parse(snap.data);
    expect(data.artifacts).toEqual([{ path: "notes.md", class: "R", source_sha256: expect.any(String) }]);
    expect(data.inbox).toEqual({ pending_count: 0, attention: [] });
    await disconnect();
  });

  test("snapshot's inbox state surfaces an open attention entry, matching GET /w/:slug/inbox's shape", async () => {
    const bus = h.busRegistry.get(h.root);
    await bus.reconcileOnce();
    await bus.createEntry("att-1", { kind: "attention_request", question: "which approach?" });

    const { reader, disconnect } = await connect(h);
    const snap = await readEvent(reader);
    const data = JSON.parse(snap.data);
    expect(data.inbox.pending_count).toBe(1);
    expect(data.inbox.attention).toEqual([{ id: "att-1", status: "open" }]);
    await disconnect();
  });

  test("live push: a connected client sees a `journal` frame after a WorkspaceBus append, with the correct sequential cursor", async () => {
    const { reader, disconnect } = await connect(h);
    const snap = await readEvent(reader);

    const bus = h.busRegistry.get(h.root);
    await bus.createEntry("live-1", { kind: "annotation" });

    const ev = await readEvent(reader);
    expect(ev.event).toBe("journal");
    expect(Number(ev.id)).toBe(Number(snap.id) + 1);
    expect(JSON.parse(ev.data).entry).toBe("live-1");
    await disconnect();
  });

  test("HEADLINE: reconnect via Last-Event-ID loses no events — every event appended while disconnected replays exactly once, in order", async () => {
    const { reader: reader1, disconnect: disconnect1 } = await connect(h);
    const snap = await readEvent(reader1);
    const startCursor = Number(snap.id);
    await disconnect1();

    const bus = h.busRegistry.get(h.root);
    await bus.createEntry("e1", { kind: "annotation" });
    await bus.createEntry("e2", { kind: "annotation" });
    await bus.createEntry("e3", { kind: "annotation" });

    const { reader: reader2, disconnect: disconnect2 } = await connect(h, { "Last-Event-ID": String(startCursor) });
    const events = await readEvents(reader2, 3);
    expect(events.map((e) => e.event)).toEqual(["journal", "journal", "journal"]);
    expect(events.map((e) => Number(e.id))).toEqual([startCursor + 1, startCursor + 2, startCursor + 3]); // no gaps, no dups
    expect(events.map((e) => JSON.parse(e.data).entry)).toEqual(["e1", "e2", "e3"]);
    await disconnect2();
  });

  test("same reconnect guarantee via the ?since= fallback (no custom header)", async () => {
    const { reader: reader1, disconnect: disconnect1 } = await connect(h);
    const snap = await readEvent(reader1);
    const startCursor = Number(snap.id);
    await disconnect1();

    const bus = h.busRegistry.get(h.root);
    await bus.createEntry("f1", { kind: "annotation" });
    await bus.createEntry("f2", { kind: "annotation" });

    const { reader: reader2, disconnect: disconnect2 } = await connect(h, {}, startCursor);
    const events = await readEvents(reader2, 2);
    expect(events.map((e) => Number(e.id))).toEqual([startCursor + 1, startCursor + 2]);
    expect(events.map((e) => JSON.parse(e.data).entry)).toEqual(["f1", "f2"]);
    await disconnect2();
  });

  test("reconnecting exactly at the current tail (nothing missed) yields no replayed frames before the next live one", async () => {
    const { reader: reader1, disconnect: disconnect1 } = await connect(h);
    await readEvent(reader1); // snapshot
    const bus = h.busRegistry.get(h.root);
    await bus.createEntry("g1", { kind: "annotation" });
    const live = await readEvent(reader1); // catch it live
    await disconnect1();

    const { reader: reader2, disconnect: disconnect2 } = await connect(h, { "Last-Event-ID": live.id! });
    await bus.createEntry("g2", { kind: "annotation" }); // the only thing this reconnect should ever see
    const ev = await readEvent(reader2);
    expect(Number(ev.id)).toBe(Number(live.id) + 1);
    expect(JSON.parse(ev.data).entry).toBe("g2");
    await disconnect2();
  });

  test("HEADLINE: reconnect resumes correctly across a simulated daemon restart — same journal file, same sequence numbers", async () => {
    const { reader: reader1, disconnect: disconnect1 } = await connect(h);
    const snap = await readEvent(reader1);
    const startCursor = Number(snap.id);
    await disconnect1();

    const bus1 = h.busRegistry.get(h.root);
    await bus1.createEntry("r1", { kind: "annotation" });
    await bus1.createEntry("r2", { kind: "annotation" });

    // "Restart": tear down this daemon's server + bus entirely (releasing the journal fd, exactly
    // like process exit would), then boot a completely fresh one — fresh WorkspaceIndex/
    // SessionRegistry/WorkspaceBusRegistry/WorkspaceBus instances — against the SAME home/root/
    // port. WorkspaceIndex is disk-backed (home persists), so it rediscovers the workspace/slug
    // from disk without re-registering it, matching what a real daemon restart does.
    await h.server.stop(true);
    await h.busRegistry.close(h.root);
    const h2 = await buildHarness({ home: h.home, root: h.root, port: h.port });

    const { reader: reader2, disconnect: disconnect2 } = await connect(h2, { "Last-Event-ID": String(startCursor) });
    const events = await readEvents(reader2, 2);
    expect(events.map((e) => Number(e.id))).toEqual([startCursor + 1, startCursor + 2]); // identical sequence numbers to the pre-restart bus
    expect(events.map((e) => JSON.parse(e.data).entry)).toEqual(["r1", "r2"]);
    await disconnect2();
    await teardownHarness(h2); // h.home/h.root are shared with h2 — the outer afterEach's re-rm is a harmless no-op
  });

  test("idle-timeout override: the connection survives past the server's own (short, 2s) idleTimeout with zero traffic, then still delivers a live push", async () => {
    const { reader, disconnect } = await connect(h);
    await readEvents(reader, 1); // consume the snapshot

    // Nothing sent for longer than the server's 2s idleTimeout, well short of the 15s default
    // heartbeat too — if `server.timeout(req, 0)` weren't applied to this response, Bun would
    // have force-closed the socket by now.
    await Bun.sleep(2500);

    const bus = h.busRegistry.get(h.root);
    await bus.createEntry("still-alive", { kind: "annotation" });
    const ev = await readEvent(reader, 3000);
    expect(ev.event).toBe("journal");
    expect(JSON.parse(ev.data).entry).toBe("still-alive");
    await disconnect();
  }, 10_000);

  test("teardown/no-leak: client disconnect unsubscribes the WorkspaceBus listener", async () => {
    const bus = h.busRegistry.get(h.root);
    expect(bus.listenerCount()).toBe(0);

    const { reader, disconnect } = await connect(h);
    await readEvents(reader, 1); // snapshot — proves the subscription is live by this point
    expect(bus.listenerCount()).toBe(1);

    await disconnect();
    // Server-side teardown runs off the client's disconnect asynchronously — poll rather than
    // asserting immediately.
    const deadline = Date.now() + 3000;
    while (bus.listenerCount() > 0 && Date.now() < deadline) await Bun.sleep(25);
    expect(bus.listenerCount()).toBe(0);
  });

  test("unknown slug → 404 over real transport", async () => {
    const res = await fetch(`http://127.0.0.1:${h.port}/w/does-not-exist/stream`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });

  test("no Bearer → 401 over real transport", async () => {
    const res = await fetch(streamUrl(h));
    expect(res.status).toBe(401);
  });

  test("foreign Origin → 403 over real transport (authed-read rejects a foreign, non-absent Origin)", async () => {
    const res = await fetch(streamUrl(h), {
      headers: { Authorization: `Bearer ${TOKEN}`, Origin: "http://evil.example.com" },
    });
    expect(res.status).toBe(403);
  });

  test("X-Contract-Version major mismatch → 409, never reaches the stream handler (shared pipeline gate, same as every other route)", async () => {
    const res = await fetch(streamUrl(h), {
      headers: { Authorization: `Bearer ${TOKEN}`, "X-Contract-Version": "99.0" },
    });
    expect(res.status).toBe(409);
  });

  test("review fix: an out-of-range Last-Event-ID (< -1, e.g. -999) is treated as absent — 200 with a fresh snapshot, not a 500", async () => {
    const res = await fetch(streamUrl(h), {
      headers: { Authorization: `Bearer ${TOKEN}`, "Last-Event-ID": "-999" },
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const ev = await readEvent(reader);
    expect(ev.event).toBe("snapshot"); // fell back to first-connect, exactly as an absent cursor would
    await reader.cancel();
  });

  test("review fix: same out-of-range fallback via the ?since= query param", async () => {
    const res = await fetch(streamUrl(h, -999), { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const ev = await readEvent(reader);
    expect(ev.event).toBe("snapshot");
    await reader.cancel();
  });
});

describe("createJournalStreamResponse — heartbeat (A1 §8.3)", () => {
  test("emits `event: heartbeat` frames with no id at the configured interval; parseSseStream drops them", async () => {
    const root = mkdtempSync(join(tmpdir(), "glosa-stream-heartbeat-"));
    const bus = new WorkspaceBus(root, {});
    await bus.reconcile();

    const req = new Request("http://127.0.0.1:1/w/x/stream");
    const response = createJournalStreamResponse(root, bus, req, undefined, {
      heartbeatMs: 40,
      watchArtifacts: false,
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let raw = "";
    const deadline = Date.now() + 2000;
    while (!raw.includes("event: heartbeat") && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      raw += decoder.decode(value);
    }
    // The exact frame, verbatim: no `id:` line, empty `data:`. (sse.test.ts separately proves
    // parseSseStream never yields a heartbeat frame to a caller — this test only needs to prove
    // the SERVER actually emits the wire bytes at the configured cadence.)
    expect(raw).toContain("event: heartbeat\ndata: \n\n");

    await reader.cancel();
    await bus.close();
    rmSync(root, { recursive: true, force: true });
  });
});

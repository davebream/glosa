// SPDX-License-Identifier: Apache-2.0
// P4.2 — `GET /w/:slug/transcript/stream` + `POST /w/:slug/transcript/compose` (A1 §5.8/§8, A2
// §F16) against a REAL bound `Bun.serve` — same rationale as the top-level stream.test.ts: a
// streaming response needs real sockets for `server.timeout(req,0)`, chunk-boundary framing, and
// real client disconnects. Route-schema-level auth coverage (401/403/409 via the shared pipeline)
// is asserted here too rather than split into a separate file, since standing up the harness is
// identical either way.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentProvider,
  AgentProviderRegistry,
  type DeliverableEntry,
  type DeliveryResult,
  type SessionBinding,
} from "../../src/agent-provider/interface.ts";
import { WorkspaceBusRegistry } from "../../src/bus/workspace-bus-registry.ts";
import { CapabilityStore } from "../../src/capability.ts";
import { type ApiContext, createApiFetch } from "../../src/http.ts";
import { SessionRegistry } from "../../src/registry/session-registry.ts";
import { canonicalize } from "../../src/registry/slug.ts";
import { WorkspaceIndex } from "../../src/registry/workspace-index.ts";
import { type ParsedSseEvent, parseSseStream } from "../../src/sse.ts";
import { createTranscriptStreamResponse } from "../../src/transcript/stream.ts";
import { randomPort } from "../helpers.ts";

const TOKEN = "transcript-test-token-0123456789abcdef";

interface Harness {
  home: string;
  root: string;
  claudeConfigDir: string;
  savedClaudeConfigDir: string | undefined;
  port: number;
  server: ReturnType<typeof Bun.serve>;
  sessionRegistry: SessionRegistry;
  busRegistry: WorkspaceBusRegistry;
  slug: string;
  delivered: Array<{ session: SessionBinding; entry: DeliverableEntry }>;
  deliveryResult: { current: DeliveryResult };
}

// `confineTranscriptPath` (transcript/root.ts) reads `Bun.env.CLAUDE_CONFIG_DIR` at call time —
// same save/restore-in-beforeEach/afterEach discipline as git/shadow.test.ts's own
// `Bun.env.GIT_CONFIG_GLOBAL` handling, since it's a process-global the daemon under test reads
// live, not something `Bun.serve` can scope per-listener.
async function buildHarness(
  opts: { home?: string; root?: string; claudeConfigDir?: string; port?: number; withProvider?: boolean } = {},
): Promise<Harness> {
  const home = opts.home ?? mkdtempSync(join(tmpdir(), "glosa-transcript-home-"));
  const root = opts.root ?? canonicalize(mkdtempSync(join(tmpdir(), "glosa-transcript-ws-")));
  const claudeConfigDir = opts.claudeConfigDir ?? mkdtempSync(join(tmpdir(), "glosa-transcript-claude-"));
  const port = opts.port ?? randomPort();

  const savedClaudeConfigDir = Bun.env.CLAUDE_CONFIG_DIR;
  Bun.env.CLAUDE_CONFIG_DIR = claudeConfigDir;

  const workspaceIndex = new WorkspaceIndex({ home });
  const sessionRegistry = new SessionRegistry({ index: workspaceIndex });
  const busRegistry = new WorkspaceBusRegistry();
  workspaceIndex.setLiveSessionPredicate((p) => sessionRegistry.forWorkspace(p).length > 0);
  workspaceIndex.setOnHardRemove((p) => busRegistry.evict(p));

  const entry = await workspaceIndex.upsertWorkspace(root, "glosa-open");
  const delivered: Array<{ session: SessionBinding; entry: DeliverableEntry }> = [];
  const deliveryResult = { current: { via: "gate", outcome: "attempted" } as DeliveryResult };
  const providerRegistry = new AgentProviderRegistry();
  if (opts.withProvider !== false) {
    const provider: AgentProvider = {
      id: "claude-code",
      capabilities: () => ({ push: true, gate: true, boundaryDrain: true, mcpPull: true }),
      detectSession: () => null,
      deliver: async (session, deliverable) => {
        delivered.push({ session, entry: deliverable });
        return deliveryResult.current;
      },
      liveness: () => "alive",
      transcriptPath: (session) => session.transcript_path ?? null,
    };
    providerRegistry.register(provider);
  }

  const ctx: ApiContext = {
    port,
    classFPort: port + 1,
    token: TOKEN,
    instanceId: "gl-transcript-test",
    startedAt: new Date().toISOString(),
    workspaceIndex,
    sessionRegistry,
    getWorkspaceBus: (r) => busRegistry.get(r),
    capabilityStore: new CapabilityStore(),
    providerRegistry,
  };
  const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: createApiFetch(ctx), idleTimeout: 2 });
  return {
    home,
    root,
    claudeConfigDir,
    savedClaudeConfigDir,
    port,
    server,
    sessionRegistry,
    busRegistry,
    slug: entry.slug,
    delivered,
    deliveryResult,
  };
}

async function teardownHarness(h: Harness): Promise<void> {
  await h.server.stop(true);
  if (h.savedClaudeConfigDir === undefined) delete Bun.env.CLAUDE_CONFIG_DIR;
  else Bun.env.CLAUDE_CONFIG_DIR = h.savedClaudeConfigDir;
  rmSync(h.home, { recursive: true, force: true });
  rmSync(h.root, { recursive: true, force: true });
  rmSync(h.claudeConfigDir, { recursive: true, force: true });
}

function transcriptStreamUrl(h: Harness, since?: string): string {
  return `http://127.0.0.1:${h.port}/w/${h.slug}/transcript/stream${since !== undefined ? `?since=${since}` : ""}`;
}

async function connect(
  h: Harness,
  headers: Record<string, string> = {},
): Promise<{ res: Response; reader: ReadableStreamDefaultReader<Uint8Array>; disconnect: () => Promise<void> }> {
  const controller = new AbortController();
  const res = await fetch(transcriptStreamUrl(h), {
    headers: { Authorization: `Bearer ${TOKEN}`, ...headers },
    signal: controller.signal,
  });
  const reader = res.body!.getReader();
  const disconnect = async () => {
    controller.abort();
    await reader.cancel().catch(() => {});
  };
  return { res, reader, disconnect };
}

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
    if (result === "timeout")
      throw new Error(`timed out waiting for ${count} event(s) — got ${events.length}: ${JSON.stringify(events)}`);
    if (result.done) throw new Error(`stream ended early — got ${events.length}/${count} event(s)`);
    events.push(result.value);
  }
  return events;
}

async function readEvent(reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs = 5000): Promise<ParsedSseEvent> {
  const [event] = await readEvents(reader, 1, timeoutMs);
  if (!event) throw new Error("unreachable");
  return event;
}

function writeTranscriptLine(path: string, obj: unknown): void {
  appendFileSync(path, JSON.stringify(obj) + "\n");
}

describe("GET /w/:slug/transcript/stream (A1 §5.8, A2 §F16)", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await buildHarness();
  });

  afterEach(async () => {
    await teardownHarness(h);
  });

  test("no session registered for the slug → 404 'no session registered', not a generic stream error", async () => {
    const res = await fetch(transcriptStreamUrl(h), { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.title).toContain("no session registered");
  });

  test("a session bound to the workspace but with no transcript_path is ALSO 'no session registered' (nothing to mirror)", async () => {
    await h.sessionRegistry.register({ session_id: "s1", provider: "claude-code", cwd: h.root, source: "startup" });
    const res = await fetch(transcriptStreamUrl(h), { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(404);
  });

  test("a transcript_path OUTSIDE $CLAUDE_CONFIG_DIR is refused — 400 invalid-path, never opened", async () => {
    const outsidePath = join(mkdtempSync(join(tmpdir(), "glosa-outside-")), "evil.jsonl");
    writeFileSync(
      outsidePath,
      JSON.stringify({ type: "user", uuid: "u1", message: { role: "user", content: "hi" } }) + "\n",
    );
    await h.sessionRegistry.register({
      session_id: "s1",
      provider: "claude-code",
      cwd: h.root,
      transcript_path: outsidePath,
      source: "startup",
    });

    const res = await fetch(transcriptStreamUrl(h), { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.type).toContain("invalid-path");
  });

  test("a symlink under CLAUDE_CONFIG_DIR pointing OUTSIDE it is also refused (realpath confinement, same as F24)", async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "glosa-outside-target-"));
    const outsideFile = join(outsideDir, "real.jsonl");
    writeFileSync(
      outsideFile,
      JSON.stringify({ type: "user", uuid: "u1", message: { role: "user", content: "hi" } }) + "\n",
    );
    const linkPath = join(h.claudeConfigDir, "sneaky.jsonl");
    symlinkSync(outsideFile, linkPath);

    await h.sessionRegistry.register({
      session_id: "s1",
      provider: "claude-code",
      cwd: h.root,
      transcript_path: linkPath,
      source: "startup",
    });

    const res = await fetch(transcriptStreamUrl(h), { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(400);
    rmSync(outsideDir, { recursive: true, force: true });
  });

  test("HEADLINE: transcript inside CLAUDE_CONFIG_DIR streams normalized events, in order", async () => {
    const transcriptPath = join(h.claudeConfigDir, "projects", "proj-a", "sess1.jsonl");
    mkdirSync(join(h.claudeConfigDir, "projects", "proj-a"), { recursive: true });
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({ type: "user", uuid: "u1", message: { role: "user", content: "hello" } }),
        JSON.stringify({ type: "assistant", uuid: "a1", message: { role: "assistant", content: "hi there" } }),
      ].join("\n") + "\n",
    );
    await h.sessionRegistry.register({
      session_id: "s1",
      provider: "claude-code",
      cwd: h.root,
      transcript_path: transcriptPath,
      source: "startup",
    });

    const { reader, disconnect } = await connect(h);
    const events = await readEvents(reader, 2);
    expect(events.map((e) => e.event)).toEqual(["transcript", "transcript"]);
    expect(JSON.parse(events[0]!.data)).toEqual({ type: "prose", role: "user", content: "hello", id: "u1" });
    expect(JSON.parse(events[1]!.data)).toEqual({ type: "prose", role: "assistant", content: "hi there", id: "a1" });
    await disconnect();
  });

  test("a fresh session with no transcript bytes yet → mirror_unavailable, not a hard error (200, stream stays open)", async () => {
    const transcriptPath = join(h.claudeConfigDir, "sess-empty.jsonl");
    // Deliberately never created — the registered session hasn't written its first turn yet.
    await h.sessionRegistry.register({
      session_id: "s1",
      provider: "claude-code",
      cwd: h.root,
      transcript_path: transcriptPath,
      source: "startup",
    });

    const res = await fetch(transcriptStreamUrl(h), { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    // Read raw bytes rather than parseSseStream (which drops nothing but mirror_unavailable is a
    // real, non-heartbeat frame we want to see explicitly).
    const decoder = new TextDecoder();
    let raw = "";
    const deadline = Date.now() + 3000;
    while (!raw.includes("event: mirror_unavailable") && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      raw += decoder.decode(value);
    }
    expect(raw).toContain("event: mirror_unavailable");
    await reader.cancel();
  });

  test("reconnect via Last-Event-ID resumes from the exact byte offset — no duplicate, no loss", async () => {
    const transcriptPath = join(h.claudeConfigDir, "sess2.jsonl");
    writeFileSync(
      transcriptPath,
      JSON.stringify({ type: "user", uuid: "u1", message: { role: "user", content: "line one" } }) + "\n",
    );
    await h.sessionRegistry.register({
      session_id: "s1",
      provider: "claude-code",
      cwd: h.root,
      transcript_path: transcriptPath,
      source: "startup",
    });

    const { reader: reader1, disconnect: disconnect1 } = await connect(h);
    const first = await readEvent(reader1);
    expect(JSON.parse(first.data).content).toBe("line one");
    await disconnect1();

    writeTranscriptLine(transcriptPath, {
      type: "assistant",
      uuid: "a1",
      message: { role: "assistant", content: "line two" },
    });

    const { reader: reader2, disconnect: disconnect2 } = await connect(h, { "Last-Event-ID": first.id! });
    const second = await readEvent(reader2);
    expect(JSON.parse(second.data).content).toBe("line two");
    await disconnect2();
  });

  test("live push: a connected client sees a new transcript event as soon as it's appended to the file", async () => {
    const transcriptPath = join(h.claudeConfigDir, "sess-live.jsonl");
    writeFileSync(transcriptPath, "");
    await h.sessionRegistry.register({
      session_id: "s1",
      provider: "claude-code",
      cwd: h.root,
      transcript_path: transcriptPath,
      source: "startup",
    });

    const { reader, disconnect } = await connect(h);
    // Give the chokidar watcher a moment to attach before the first write.
    await Bun.sleep(150);
    writeTranscriptLine(transcriptPath, { type: "user", uuid: "u1", message: { role: "user", content: "live turn" } });

    const ev = await readEvent(reader, 4000);
    expect(ev.event).toBe("transcript");
    expect(JSON.parse(ev.data).content).toBe("live turn");
    await disconnect();
  });

  // NOTE: this exercises the RECONNECT-time truncation/rotation check (the same branch a live
  // chokidar `change` mid-stream would hit) rather than a live in-connection filesystem event —
  // deliberately, matching stream.ts's own existing precedent (its journal/artifact suite always
  // passes `watchArtifacts: false` for anything correctness-sensitive; see that file's own "best-
  // effort" docstring). A directly-watched single file's `change` event for a truncate-to-empty
  // write was observed not to fire reliably from chokidar/fsevents in this sandboxed environment
  // even with multi-second waits (verified independently outside `bun test`), so asserting on it
  // here would make the suite flaky for a reason that has nothing to do with THIS module's own
  // correctness — the resync decision itself (`stat.ino !== cursor.inode || stat.size <
  // cursor.byte_offset`) is the same code whichever caller (watcher callback or reconnect) invokes
  // it, and is exercised deterministically below.
  test("reconnecting with a cursor whose offset now exceeds the (truncated) file's size → resync_required, not a crash or silent replay", async () => {
    const transcriptPath = join(h.claudeConfigDir, "sess-clear.jsonl");
    writeFileSync(
      transcriptPath,
      JSON.stringify({ type: "user", uuid: "u1", message: { role: "user", content: "before clear" } }) + "\n",
    );
    await h.sessionRegistry.register({
      session_id: "s1",
      provider: "claude-code",
      cwd: h.root,
      transcript_path: transcriptPath,
      source: "startup",
    });

    const { reader: reader1, disconnect: disconnect1 } = await connect(h);
    const first = await readEvent(reader1);
    await disconnect1();

    writeFileSync(transcriptPath, ""); // truncate — simulates /clear rewriting the file to empty, same inode

    const { reader: reader2, disconnect: disconnect2 } = await connect(h, { "Last-Event-ID": first.id! });
    const ev = await readEvent(reader2);
    expect(ev.event).toBe("resync_required");
    await disconnect2();
  });

  test("reconnecting after the transcript was rotated to a NEW inode (a /resume-like file swap) → resync_required", async () => {
    const transcriptPath = join(h.claudeConfigDir, "sess-rotate.jsonl");
    writeFileSync(
      transcriptPath,
      JSON.stringify({ type: "user", uuid: "u1", message: { role: "user", content: "old file" } }) + "\n",
    );
    await h.sessionRegistry.register({
      session_id: "s1",
      provider: "claude-code",
      cwd: h.root,
      transcript_path: transcriptPath,
      source: "startup",
    });

    const { reader: reader1, disconnect: disconnect1 } = await connect(h);
    const first = await readEvent(reader1);
    await disconnect1();

    // Simulate a rotation: replace the file's inode entirely (unlink + recreate), matching how a
    // real `/resume`-triggered file swap changes identity even if the path stays the same.
    rmSync(transcriptPath);
    writeFileSync(
      transcriptPath,
      JSON.stringify({ type: "user", uuid: "u2", message: { role: "user", content: "new file" } }) + "\n",
    );

    const { reader: reader2, disconnect: disconnect2 } = await connect(h, { "Last-Event-ID": first.id! });
    const ev = await readEvent(reader2);
    expect(ev.event).toBe("resync_required");
    await disconnect2();
  });

  test("an out-of-range/undecodable Last-Event-ID is tolerated as absent — 200, fresh read from 0, never a 500", async () => {
    const transcriptPath = join(h.claudeConfigDir, "sess-garbage-cursor.jsonl");
    writeFileSync(
      transcriptPath,
      JSON.stringify({ type: "user", uuid: "u1", message: { role: "user", content: "hi" } }) + "\n",
    );
    await h.sessionRegistry.register({
      session_id: "s1",
      provider: "claude-code",
      cwd: h.root,
      transcript_path: transcriptPath,
      source: "startup",
    });

    const { reader, disconnect } = await connect(h, { "Last-Event-ID": "not-a-real-cursor!!" });
    const ev = await readEvent(reader);
    expect(ev.event).toBe("transcript");
    expect(JSON.parse(ev.data).content).toBe("hi");
    await disconnect();
  });

  test("no Bearer → 401", async () => {
    const res = await fetch(transcriptStreamUrl(h));
    expect(res.status).toBe(401);
  });

  test("foreign Origin → 403 (authed-read rejects a foreign, non-absent Origin)", async () => {
    const res = await fetch(transcriptStreamUrl(h), {
      headers: { Authorization: `Bearer ${TOKEN}`, Origin: "http://evil.example.com" },
    });
    expect(res.status).toBe(403);
  });

  test("X-Contract-Version major mismatch → 409, never reaches the transcript handler", async () => {
    const res = await fetch(transcriptStreamUrl(h), {
      headers: { Authorization: `Bearer ${TOKEN}`, "X-Contract-Version": "99.0" },
    });
    expect(res.status).toBe(409);
  });

  test("unknown slug → 404 (workspace resolution runs before session lookup)", async () => {
    const res = await fetch(`http://127.0.0.1:${h.port}/w/does-not-exist/transcript/stream`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /w/:slug/transcript/compose — out-of-band composer (F32/R6)", () => {
  let h: Harness;
  const MESSAGE_ID = "123e4567-e89b-42d3-a456-426614174000";

  beforeEach(async () => {
    h = await buildHarness();
  });

  afterEach(async () => {
    await teardownHarness(h);
  });

  function composeReq(body: unknown, extraHeaders: Record<string, string> = {}) {
    return fetch(`http://127.0.0.1:${h.port}/w/${h.slug}/transcript/compose`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        Origin: `http://127.0.0.1:${h.port}`,
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    });
  }

  test("queues an immutable, exact-session message and NEVER writes the transcript file", async () => {
    const transcriptPath = join(h.claudeConfigDir, "sess-compose.jsonl");
    writeFileSync(transcriptPath, "");
    await h.sessionRegistry.register({
      session_id: "s1",
      provider: "claude-code",
      cwd: "/different/producer/cwd",
      workspace_binding: h.root,
      transcript_path: transcriptPath,
      source: "startup",
    });

    const res = await composeReq({ message_id: MESSAGE_ID, text: "please also check the edge case" });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toMatchObject({
      message_id: MESSAGE_ID,
      accepted: true,
      delivered: false,
      state: "queued",
      delivery: { via: "gate", outcome: "attempted" },
    });
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]).toMatchObject({
      session: { session_id: "s1", workspace: h.root },
      entry: {
        id: MESSAGE_ID,
        kind: "conversation_message",
        message: "please also check the edge case",
        message_bytes: 31,
        target_session_id: "s1",
      },
    });

    // The transcript file on disk is completely untouched by the composer.
    expect(statSync(transcriptPath).size).toBe(0);
  });

  test("cwd-only registration is rejected; composer routing requires an explicit binding", async () => {
    await h.sessionRegistry.register({ session_id: "s1", provider: "claude-code", cwd: h.root, source: "startup" });
    const res = await composeReq({ message_id: MESSAGE_ID, text: "hello" });
    expect(res.status).toBe(404);
    expect((await res.json()).type).toContain("no-bound-session");
  });

  test("only stale explicit bindings return a recoverable conflict", async () => {
    await h.sessionRegistry.register({
      session_id: "s1",
      provider: "claude-code",
      cwd: h.root,
      workspace_binding: h.root,
      source: "startup",
      lease_expiry: "2000-01-01T00:00:00.000Z",
    });
    const res = await composeReq({ message_id: MESSAGE_ID, text: "hello" });
    expect(res.status).toBe(409);
    expect((await res.json()).type).toContain("bound-session-stale");
  });

  test("a zero-provider daemon remains valid and reports delivery unavailable safely", async () => {
    await teardownHarness(h);
    h = await buildHarness({ withProvider: false });
    await h.sessionRegistry.register({
      session_id: "s1",
      provider: "claude-code",
      cwd: h.root,
      workspace_binding: h.root,
      source: "startup",
    });
    const res = await composeReq({ message_id: MESSAGE_ID, text: "hello" });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.type).toContain("delivery-unavailable");
    expect(JSON.stringify(body)).not.toContain(h.root);
  });

  test("multiple live bindings require a valid hint and expose only safe candidates", async () => {
    for (const [session_id, provider] of [
      ["s1", "claude-code"],
      ["s2", "codex"],
    ] as const) {
      await h.sessionRegistry.register({
        session_id,
        provider,
        cwd: `/producer/${session_id}`,
        workspace_binding: h.root,
        source: "startup",
      });
    }
    const res = await composeReq({ message_id: MESSAGE_ID, text: "hello" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.type).toContain("session-selection-required");
    expect(body.candidates).toEqual([
      expect.objectContaining({ session_id: "s1", provider: "claude-code" }),
      expect.objectContaining({ session_id: "s2", provider: "codex" }),
    ]);
    expect(JSON.stringify(body)).not.toContain(h.root);
    expect(JSON.stringify(body)).not.toContain("/producer/");

    const hinted = await composeReq({ message_id: MESSAGE_ID, text: "hello", session_hint: "s1" });
    expect(hinted.status).toBe(202);
    expect(h.delivered[0]?.session.session_id).toBe("s1");
  });

  test("an invalid session hint is rejected instead of silently choosing the sole live binding", async () => {
    await h.sessionRegistry.register({
      session_id: "s1",
      provider: "claude-code",
      cwd: h.root,
      workspace_binding: h.root,
      source: "startup",
    });
    const res = await composeReq({ message_id: MESSAGE_ID, text: "hello", session_hint: "not-s1" });
    expect(res.status).toBe(409);
    expect((await res.json()).type).toContain("session-selection-required");
    expect(h.delivered).toHaveLength(0);
  });

  test("same ID/text/target is idempotent; changed text conflicts", async () => {
    await h.sessionRegistry.register({
      session_id: "s1",
      provider: "claude-code",
      cwd: h.root,
      workspace_binding: h.root,
      source: "startup",
    });
    expect((await composeReq({ message_id: MESSAGE_ID, text: "same" })).status).toBe(202);
    expect((await composeReq({ message_id: MESSAGE_ID, text: "same" })).status).toBe(202);
    expect(h.delivered).toHaveLength(1);
    h.sessionRegistry.deregister("s1");
    expect((await composeReq({ message_id: MESSAGE_ID, text: "same" })).status).toBe(202);
    const conflict = await composeReq({ message_id: MESSAGE_ID, text: "changed" });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).type).toContain("idempotency-conflict");
  });

  test("a failed attempt retries the immutable entry and records reason re_nudge", async () => {
    await h.sessionRegistry.register({
      session_id: "s1",
      provider: "claude-code",
      cwd: h.root,
      workspace_binding: h.root,
      source: "startup",
    });
    h.deliveryResult.current = { via: "gate", outcome: "failed", error: "/private/transcript token-secret" };
    const failed = await composeReq({ message_id: MESSAGE_ID, text: "retry me" });
    expect(failed.status).toBe(502);
    const failedBody = await failed.json();
    expect(failedBody.state).toBe("failed");
    expect(JSON.stringify(failedBody)).not.toContain("token-secret");

    h.deliveryResult.current = { via: "gate", outcome: "attempted" };
    expect((await composeReq({ message_id: MESSAGE_ID, text: "retry me" })).status).toBe(202);
    expect(h.delivered).toHaveLength(2);
    const attempts = h.busRegistry.get(h.root).state.entries[MESSAGE_ID]!.deliveryAttempts as Array<{
      reason?: string;
    }>;
    expect(attempts?.map((attempt) => attempt.reason)).toEqual(["initial", "re_nudge"]);
  });

  test("a presented acknowledgement is the only success state and status survives lookup", async () => {
    await h.sessionRegistry.register({
      session_id: "s1",
      provider: "claude-code",
      cwd: h.root,
      workspace_binding: h.root,
      source: "startup",
    });
    expect((await composeReq({ message_id: MESSAGE_ID, text: "ack me" })).status).toBe(202);
    const ack = await fetch(`http://127.0.0.1:${h.port}/api/sessions/s1/conversation/${MESSAGE_ID}/ack`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        Origin: `http://127.0.0.1:${h.port}`,
      },
      body: JSON.stringify({ outcome: "presented" }),
    });
    expect(ack.status).toBe(200);
    const status = await fetch(`http://127.0.0.1:${h.port}/w/${h.slug}/transcript/compose/${MESSAGE_ID}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ message_id: MESSAGE_ID, delivered: true, state: "presented" });
    expect((await composeReq({ message_id: MESSAGE_ID, text: "ack me" })).status).toBe(200);
    expect(h.delivered).toHaveLength(1);
  });

  test("blank and over-16-KiB presentations are rejected without truncation", async () => {
    await h.sessionRegistry.register({
      session_id: "s1",
      provider: "claude-code",
      cwd: h.root,
      workspace_binding: h.root,
      source: "startup",
    });
    expect((await composeReq({ message_id: MESSAGE_ID, text: "   \n" })).status).toBe(400);
    const over = await composeReq({ message_id: MESSAGE_ID, text: "🙂".repeat(4096) });
    expect(over.status).toBe(400);
    expect(h.delivered).toHaveLength(0);
  });

  test("no session registered → 404", async () => {
    const res = await composeReq({ text: "hello" });
    expect(res.status).toBe(404);
  });

  test("missing/empty text → 400 validation-failed", async () => {
    await h.sessionRegistry.register({
      session_id: "s1",
      provider: "claude-code",
      cwd: h.root,
      workspace_binding: h.root,
      source: "startup",
    });
    const res = await composeReq({ text: "" });
    expect(res.status).toBe(400);
  });

  test("no Bearer → 401", async () => {
    const res = await fetch(`http://127.0.0.1:${h.port}/w/${h.slug}/transcript/compose`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(res.status).toBe(401);
  });

  test("missing Origin (state-changing route) → 403", async () => {
    await h.sessionRegistry.register({
      session_id: "s1",
      provider: "claude-code",
      cwd: h.root,
      workspace_binding: h.root,
      source: "startup",
    });
    const res = await fetch(`http://127.0.0.1:${h.port}/w/${h.slug}/transcript/compose`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("createTranscriptStreamResponse — shutdown", () => {
  test("daemon shutdown emits `bye` and closes the transcript stream", async () => {
    const root = mkdtempSync(join(tmpdir(), "glosa-transcript-shutdown-"));
    const transcriptPath = join(root, "session.jsonl");
    writeFileSync(
      transcriptPath,
      JSON.stringify({ type: "user", uuid: "u1", message: { role: "user", content: "before restart" } }) + "\n",
    );
    const shutdown = new AbortController();
    const response = createTranscriptStreamResponse(
      transcriptPath,
      new Request("http://127.0.0.1:1/w/x/transcript/stream"),
      undefined,
      { heartbeatMs: 60_000, watchFile: false, shutdownSignal: shutdown.signal },
    );
    const events = parseSseStream(response.body!.getReader())[Symbol.asyncIterator]();

    expect((await events.next()).value?.event).toBe("transcript");
    shutdown.abort();
    expect((await events.next()).value?.event).toBe("bye");
    expect((await events.next()).done).toBe(true);

    rmSync(root, { recursive: true, force: true });
  });
});

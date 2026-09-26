// SPDX-License-Identifier: Apache-2.0
// #389: attention is daemon-wide for the desktop shell's Dock badge and notifications (feature map
// §4, decision 4). Pins the four things that make it so: `GET /api/workspaces` rows count attention
// exactly as each workspace's tray does, and count chats waiting on a decision; every workspace
// stream hears every workspace's attention changes; `chats_changed` names the workspace; and the bus
// registry lets several daemon-lifetime observers attach without displacing each other (#155's
// session signals keep working beside the attention feed).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttentionFeed } from "../src/bus/attention-feed.ts";
import type { AttentionRequestPayload, WorkspaceBus } from "../src/bus/bus.ts";
import { WorkspaceBusRegistry } from "../src/bus/workspace-bus-registry.ts";
import { ManagedChatService } from "../src/chats/service.ts";
import { SessionRegistry } from "../src/registry/session-registry.ts";
import { canonicalize } from "../src/registry/slug.ts";
import { WorkspaceIndex } from "../src/registry/workspace-index.ts";
import { CapabilityStore } from "../src/security/capability.ts";
import { type ApiContext, createApiFetch } from "../src/transport/http.ts";
import { type ParsedSseEvent, parseSseStream } from "../src/transport/sse.ts";
import { workspaceRegistrationId } from "../src/workspace.ts";
import { randomPort, waitForHandshake } from "./helpers.ts";

const TOKEN = "attention-wide-token-0123456789abcdef";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDir(prefix: string): string {
  const dir = canonicalize(mkdtempSync(join(tmpdir(), prefix)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

let entrySeq = 0;
function nextEntryId(): string {
  entrySeq++;
  return `inb-${Math.floor(Date.now() / 1000)}-${entrySeq.toString(16).padStart(4, "0")}`;
}

function ask(message: string): AttentionRequestPayload {
  return { kind: "attention_request", action: "ask", message };
}

/** A stand-in for the managed chat service: only the members `GET /api/workspaces` and the stream
 * relay read. Chat routes never run in these tests. */
function fakeChats(counts: Map<string, number>, owners: Map<string, { workspaceId: string; workspaceEpoch: string }>) {
  const listeners = new Set<(change: { chatId?: string }) => void>();
  return {
    pendingDecisionCounts: () => counts,
    store: { listeners, workspaceOf: (chatId: string) => owners.get(chatId) },
    fire: (chatId?: string) => {
      for (const listener of listeners) listener(chatId === undefined ? {} : { chatId });
    },
  };
}

interface Harness {
  port: number;
  busRegistry: WorkspaceBusRegistry;
  workspaceIndex: WorkspaceIndex;
  a: { slug: string; root: string; registration_id: string; first_seen: string };
  b: { slug: string; root: string; registration_id: string; first_seen: string };
}

async function buildHarness(managedChats?: ReturnType<typeof fakeChats>): Promise<Harness> {
  const home = tempDir("glosa-attn-home-");
  const rootA = tempDir("glosa-attn-a-");
  const rootB = tempDir("glosa-attn-b-");
  const port = randomPort();
  const workspaceIndex = new WorkspaceIndex({ home });
  const sessionRegistry = new SessionRegistry({ index: workspaceIndex });
  const busRegistry = new WorkspaceBusRegistry();
  workspaceIndex.setLiveSessionPredicate((p) => sessionRegistry.forWorkspace(p).length > 0);
  workspaceIndex.setOnHardRemove((p) => busRegistry.evict(p));
  // The production composition (lifecycle/daemon.ts): the feed observes each bus as it opens.
  const attentionFeed = new AttentionFeed(
    (workspace) => workspaceIndex.getWorkspaceByRegistration(workspaceRegistrationId(workspace))?.slug,
  );
  busRegistry.addOnOpen((bus, workspace) => {
    const unsubscribe = attentionFeed.attach(bus, workspace);
    bus.closeSignal().addEventListener("abort", unsubscribe, { once: true });
  });
  const a = await workspaceIndex.upsertWorkspace(rootA, "glosa-open");
  const b = await workspaceIndex.upsertWorkspace(rootB, "glosa-open");
  const ctx: ApiContext = {
    port,
    classFPort: port + 1,
    token: TOKEN,
    instanceId: "gl-attention-wide-test",
    startedAt: new Date().toISOString(),
    workspaceIndex,
    sessionRegistry,
    getWorkspaceBus: (r) => busRegistry.get(r),
    capabilityStore: new CapabilityStore(),
    attentionFeed,
    ...(managedChats ? { managedChats: managedChats as unknown as ApiContext["managedChats"] } : {}),
  };
  const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: createApiFetch(ctx) });
  cleanups.push(async () => {
    await server.stop(true);
    await busRegistry.closeAll();
  });
  if (!(await waitForHandshake(port))) throw new Error(`attention test server did not answer on ${port}`);
  const pick = (e: typeof a) => ({
    slug: e.slug,
    root: e.worktree_path,
    registration_id: e.registration_id,
    first_seen: e.first_seen,
  });
  return { port, busRegistry, workspaceIndex, a: pick(a), b: pick(b) };
}

function authed(port: number, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  });
}

/** Opens a workspace stream and returns a reader that waits for the first frame matching `want`. */
async function openStream(port: number, slug: string) {
  const controller = new AbortController();
  const res = await authed(port, `/w/${slug}/stream`, { signal: controller.signal });
  expect(res.status).toBe(200);
  const frames: ParsedSseEvent[] = [];
  const waiters: { want: (f: ParsedSseEvent) => boolean; resolve: (f: ParsedSseEvent) => void }[] = [];
  let pumpError: unknown;
  const pump = (async () => {
    try {
      for await (const frame of parseSseStream(res.body!.getReader())) {
        frames.push(frame);
        for (const waiter of [...waiters]) {
          if (waiter.want(frame)) {
            waiters.splice(waiters.indexOf(waiter), 1);
            waiter.resolve(frame);
          }
        }
      }
    } catch (error) {
      // An abort is the cleanup; anything else is a broken reader, and must fail the test by name
      // rather than surface as a timeout.
      if (!controller.signal.aborted) pumpError = error;
    }
  })();
  cleanups.push(async () => {
    controller.abort();
    await pump;
  });
  const next = (want: (f: ParsedSseEvent) => boolean, ms = 3000): Promise<ParsedSseEvent> => {
    if (pumpError !== undefined) return Promise.reject(pumpError);
    const seen = frames.find(want);
    if (seen) {
      frames.splice(frames.indexOf(seen), 1);
      return Promise.resolve(seen);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no matching frame within the timeout")), ms);
      waiters.push({
        want,
        resolve: (f) => {
          clearTimeout(timer);
          frames.splice(frames.indexOf(f), 1);
          resolve(f);
        },
      });
    });
  };
  // The first frame is the snapshot; wait for it so later frames are live ones.
  await next((f) => f.event === "snapshot");
  return { next, frames };
}

const dataOf = (f: ParsedSseEvent): unknown => (f.data === "" ? undefined : JSON.parse(f.data));

const isAttention = (slug: string) => (f: ParsedSseEvent) =>
  f.event === "attention_changed" && (dataOf(f) as { slug?: string }).slug === slug;

async function busFor(h: Harness, root: string): Promise<WorkspaceBus> {
  const bus = h.busRegistry.get(root);
  await bus.reconcileOnce();
  return bus;
}

describe("GET /api/workspaces counts attention the way each tray does (#389)", () => {
  test("attention_count equals every workspace's inbox pending_count", async () => {
    const h = await buildHarness();
    const busA = await busFor(h, h.a.root);
    const busB = await busFor(h, h.b.root);
    await busA.createAttentionRequest(nextEntryId(), ask("one"));
    const seenId = nextEntryId();
    await busB.createAttentionRequest(seenId, ask("two"));
    await busB.createAttentionRequest(nextEntryId(), ask("three"));
    // `seen` is still waiting on the person, so it still counts, in the tray and on the row.
    await busB.markAttentionSeen(seenId);

    const rows = (await (await authed(h.port, "/api/workspaces")).json()) as {
      slug: string;
      attention_count: number;
      decision_count: number;
      has_attention: boolean;
    }[];
    for (const ws of [h.a, h.b]) {
      const inbox = (await (await authed(h.port, `/w/${ws.slug}/inbox`)).json()) as { pending_count: number };
      const row = rows.find((r) => r.slug === ws.slug)!;
      expect(row.attention_count).toBe(inbox.pending_count);
      expect(row.has_attention).toBe(inbox.pending_count > 0);
      expect(row.decision_count).toBe(0);
    }
    expect(rows.find((r) => r.slug === h.a.slug)!.attention_count).toBe(1);
    expect(rows.find((r) => r.slug === h.b.slug)!.attention_count).toBe(2);
  });

  test("decision_count is each workspace's chats waiting on a decision", async () => {
    const counts = new Map<string, number>();
    const chats = fakeChats(counts, new Map());
    const h = await buildHarness(chats);
    counts.set(`${h.b.registration_id}:${h.b.first_seen}`, 2);
    const rows = (await (await authed(h.port, "/api/workspaces")).json()) as {
      slug: string;
      decision_count: number;
    }[];
    expect(rows.find((r) => r.slug === h.a.slug)!.decision_count).toBe(0);
    expect(rows.find((r) => r.slug === h.b.slug)!.decision_count).toBe(2);
  });

  test("pendingDecisionCounts counts a chat once, only for pending decisions, per registration", () => {
    const decision = (status: string) => ({ status });
    const store = {
      all: () => [
        { workspaceId: "w1", workspaceEpoch: "e1", decisions: [decision("pending"), decision("pending")] },
        { workspaceId: "w1", workspaceEpoch: "e1", decisions: [decision("answered")] },
        { workspaceId: "w1", workspaceEpoch: "e2", decisions: [decision("pending")] },
        { workspaceId: "w2", workspaceEpoch: "e1", decisions: [decision("expired"), decision("pending")] },
        { workspaceId: "w3", workspaceEpoch: "e1", decisions: [] },
      ],
    };
    const counts = ManagedChatService.prototype.pendingDecisionCounts.call({ store } as never);
    expect(Object.fromEntries(counts)).toEqual({ "w1:e1": 1, "w1:e2": 1, "w2:e1": 1 });
  });
});

describe("every workspace stream hears every workspace's attention (#389)", () => {
  test("a stream on A gets attention_changed for B when B's request is created, seen and answered", async () => {
    const h = await buildHarness();
    const stream = await openStream(h.port, h.a.slug);
    const busB = await busFor(h, h.b.root);
    const id = nextEntryId();
    await busB.createAttentionRequest(id, ask("review this"));
    expect(dataOf(await stream.next(isAttention(h.b.slug)))).toEqual({ slug: h.b.slug });
    await busB.markAttentionSeen(id);
    await stream.next(isAttention(h.b.slug));
    await busB.completeAttention(id, { outcome: "done", response: "ok" });
    await stream.next(isAttention(h.b.slug));
  });

  test("a stream hears its own workspace's attention too, and nothing for non-attention entries", async () => {
    const h = await buildHarness();
    const stream = await openStream(h.port, h.a.slug);
    const busA = await busFor(h, h.a.root);
    await busA.createAttentionRequest(nextEntryId(), ask("own"));
    await stream.next(isAttention(h.a.slug));
    await busA.createEntry(nextEntryId(), { kind: "annotation", body: "a margin note" });
    await expect(stream.next((f) => f.event === "attention_changed", 400)).rejects.toThrow("no matching frame");
  });
});

describe("chats_changed names the workspace (#389)", () => {
  test("a chat change in B reaches A's stream with B's slug", async () => {
    const owners = new Map<string, { workspaceId: string; workspaceEpoch: string }>();
    const chats = fakeChats(new Map(), owners);
    const h = await buildHarness(chats);
    owners.set("chat-b", { workspaceId: h.b.registration_id, workspaceEpoch: h.b.first_seen });
    const stream = await openStream(h.port, h.a.slug);
    chats.fire("chat-b");
    const frame = await stream.next((f) => f.event === "chats_changed");
    expect(dataOf(frame)).toEqual({ slug: h.b.slug, slugs: [h.b.slug] });
  });

  test("a change that cannot be tied to one workspace says so with an empty list", async () => {
    const chats = fakeChats(new Map(), new Map());
    const h = await buildHarness(chats);
    const stream = await openStream(h.port, h.a.slug);
    chats.fire();
    const frame = await stream.next((f) => f.event === "chats_changed");
    expect(dataOf(frame)).toEqual({ slugs: [] });
  });
});

describe("the bus registry takes several open observers (#389, #155)", () => {
  test("two observers both see a bus open, and one added later still sees the open bus", async () => {
    const registry = new WorkspaceBusRegistry();
    cleanups.push(() => registry.closeAll());
    const root = tempDir("glosa-attn-reg-");
    const first: WorkspaceBus[] = [];
    const second: WorkspaceBus[] = [];
    registry.addOnOpen((bus) => first.push(bus));
    registry.addOnOpen((bus) => second.push(bus));
    const bus = registry.get(root);
    expect(first).toEqual([bus]);
    expect(second).toEqual([bus]);
    const late: WorkspaceBus[] = [];
    registry.addOnOpen((b) => late.push(b));
    expect(late).toEqual([bus]);
    registry.get(root);
    expect(first).toHaveLength(1);
  });

  test("a throwing observer never stops the others or fails the open", async () => {
    const registry = new WorkspaceBusRegistry();
    cleanups.push(() => registry.closeAll());
    const seen: WorkspaceBus[] = [];
    registry.addOnOpen(() => {
      throw new Error("broken observer");
    });
    registry.addOnOpen((bus) => seen.push(bus));
    const bus = registry.get(tempDir("glosa-attn-reg2-"));
    expect(seen).toEqual([bus]);
  });
});

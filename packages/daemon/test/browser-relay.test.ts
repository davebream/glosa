// SPDX-License-Identifier: Apache-2.0
// Desk browser tabs for a managed chat's agent (#440, contract 1.24, A1 §5.25, A3 §5 row 14): the
// relay's own rules, the three managed tools that call it, and the stream and answer route through
// the real `createApiFetch` pipeline on a real loopback server. What is under test: a request goes
// only to the newest desk window on the chat's own workspace and is refused at once when there is
// none; only web addresses, never glosa's own ports; a chat drives only tabs it opened; a closed
// window, a timeout, a late or foreign answer and a run stopped mid-request each end the call.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BROWSER_REFUSALS, BrowserRelay, type BrowserRequestFrame } from "../src/agents/browser-relay.ts";
import { createManagedTools } from "../src/agents/managed-tools.ts";
import { WorkspaceBusRegistry } from "../src/bus/workspace-bus-registry.ts";
import type { ChatState } from "../src/chats/store.ts";
import { SessionRegistry } from "../src/registry/session-registry.ts";
import { canonicalize } from "../src/registry/slug.ts";
import { WorkspaceIndex } from "../src/registry/workspace-index.ts";
import { CapabilityStore } from "../src/security/capability.ts";
import { type ApiContext, createApiFetch } from "../src/transport/http.ts";
import { type ParsedSseEvent, parseSseStream } from "../src/transport/sse.ts";
import { randomPort, waitForHandshake } from "./helpers.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const chatA = { id: "chat-a", workspaceId: "ws-1", provider: "claude-code" };
const chatB = { id: "chat-b", workspaceId: "ws-1", provider: "codex" };
const active = () => {};

/** A desk window that answers every request with `reply`, or holds it when `reply` is absent. */
function host(relay: BrowserRelay, workspaceId: string, reply?: (frame: BrowserRequestFrame) => unknown) {
  const frames: BrowserRequestFrame[] = [];
  const unregister = relay.register(workspaceId, (frame) => {
    frames.push(frame);
    if (reply) queueMicrotask(() => relay.answer(workspaceId, frame.id, reply(frame)));
  });
  return { frames, unregister };
}

const opened = (tab: string) => (frame: BrowserRequestFrame) => ({
  ok: true,
  tab: frame.tab ?? tab,
  url: frame.url ?? "https://example.com/",
  title: "Example",
  ...(frame.action === "read" ? { text: "Hello", truncated: false } : {}),
});

describe("BrowserRelay", () => {
  test("with no desk window on the chat's workspace the tool is refused at once and nothing is sent", async () => {
    const relay = new BrowserRelay();
    const elsewhere = host(relay, "ws-other", opened("t1"));
    expect(await relay.request(chatA, { action: "open", url: "https://example.com/" }, active)).toEqual({
      ok: false,
      reason: BROWSER_REFUSALS.noWindow,
    });
    expect(elsewhere.frames).toEqual([]);
  });

  test("only web addresses, and never glosa's own ports on a loopback name", async () => {
    const relay = new BrowserRelay();
    relay.setGlosaPorts([7777, 7778]);
    const window = host(relay, "ws-1", opened("t1"));
    for (const url of ["file:///etc/hosts", "javascript:alert(1)", "not a url", "chrome://settings"]) {
      expect(await relay.request(chatA, { action: "open", url }, active)).toEqual({
        ok: false,
        reason: BROWSER_REFUSALS.notWeb,
      });
    }
    for (const url of [
      "http://127.0.0.1:7777/api/handshake",
      "http://localhost:7778/",
      "http://glosa.localhost:7777/",
      "http://[::1]:7777/",
      "http://127.8.9.10:7778/doc/x",
    ]) {
      expect(await relay.request(chatA, { action: "open", url }, active)).toEqual({
        ok: false,
        reason: BROWSER_REFUSALS.glosa,
      });
    }
    expect(window.frames).toEqual([]);
    // Another local server, and glosa's port number on a host that is not this machine, are pages.
    expect(await relay.request(chatA, { action: "open", url: "http://127.0.0.1:3000/" }, active)).toMatchObject({
      ok: true,
    });
    expect(await relay.request(chatA, { action: "open", url: "https://example.com:7777/" }, active)).toMatchObject({
      ok: true,
    });
    expect(window.frames.map((frame) => frame.url)).toEqual(["http://127.0.0.1:3000/", "https://example.com:7777/"]);
  });

  test("the newest desk window receives the request, with the chat and provider it is for", async () => {
    const relay = new BrowserRelay({ newId: () => "req-1" });
    const older = host(relay, "ws-1", opened("t-old"));
    const newer = host(relay, "ws-1", opened("t-new"));
    const result = await relay.request(chatA, { action: "open", url: "https://example.com/" }, active);
    expect(result).toEqual({ ok: true, tab: "t-new", url: "https://example.com/", title: "Example" });
    expect(older.frames).toEqual([]);
    expect(newer.frames).toEqual([
      { id: "req-1", chat_id: "chat-a", provider: "claude-code", action: "open", url: "https://example.com/" },
    ]);
    newer.unregister();
    expect(await relay.request(chatA, { action: "open", url: "https://example.com/" }, active)).toMatchObject({
      ok: true,
      tab: "t-old",
    });
  });

  test("a chat moves and reads only tabs it opened; another chat's tab and an unknown one are refused", async () => {
    const relay = new BrowserRelay();
    const window = host(relay, "ws-1", opened("tab-a"));
    const open = await relay.request(chatA, { action: "open", url: "https://example.com/" }, active);
    expect(open).toMatchObject({ ok: true, tab: "tab-a" });

    expect(
      await relay.request(chatA, { action: "navigate", tab: "tab-a", url: "https://example.org/" }, active),
    ).toMatchObject({ ok: true, tab: "tab-a", url: "https://example.org/" });
    expect(await relay.request(chatA, { action: "read", tab: "tab-a", maxChars: 5000 }, active)).toMatchObject({
      ok: true,
      text: "Hello",
    });
    expect(window.frames.at(-1)).toMatchObject({ action: "read", tab: "tab-a", max_chars: 5000 });
    const sent = window.frames.length;

    for (const call of [
      { action: "read", tab: "tab-a", maxChars: 5000 } as const,
      { action: "navigate", tab: "tab-a", url: "https://example.org/" } as const,
    ]) {
      expect(await relay.request(chatB, call, active)).toEqual({ ok: false, reason: BROWSER_REFUSALS.notYours });
    }
    expect(
      await relay.request(chatA, { action: "read", tab: "a-tab-the-person-opened", maxChars: 5000 }, active),
    ).toEqual({
      ok: false,
      reason: BROWSER_REFUSALS.notYours,
    });
    expect(window.frames.length).toBe(sent);
  });

  test("a refused open records no tab, so the chat cannot drive the tab id it was refused with", async () => {
    const relay = new BrowserRelay();
    host(relay, "ws-1", () => ({ ok: false, reason: "The page did not load." }));
    expect(await relay.request(chatA, { action: "open", url: "https://example.com/" }, active)).toEqual({
      ok: false,
      reason: "The page did not load.",
    });
    expect(await relay.request(chatA, { action: "read", tab: "anything", maxChars: 5000 }, active)).toEqual({
      ok: false,
      reason: BROWSER_REFUSALS.notYours,
    });
  });

  test("a window that closes fails what it held, and a later answer to it is refused", async () => {
    const relay = new BrowserRelay({ newId: () => "req-held" });
    const window = host(relay, "ws-1");
    const pending = relay.request(chatA, { action: "open", url: "https://example.com/" }, active);
    await Promise.resolve();
    expect(window.frames).toHaveLength(1);
    window.unregister();
    expect(await pending).toEqual({ ok: false, reason: BROWSER_REFUSALS.closed });
    expect(relay.answer("ws-1", "req-held", { ok: true, tab: "t", url: "https://example.com/", title: "" })).toBe(
      false,
    );
  });

  test("a window that never answers times out, and its late answer is refused", async () => {
    const relay = new BrowserRelay({ newId: () => "req-slow", timeoutMs: { open: 20 } });
    host(relay, "ws-1");
    expect(await relay.request(chatA, { action: "open", url: "https://example.com/" }, active)).toEqual({
      ok: false,
      reason: BROWSER_REFUSALS.timeout,
    });
    expect(relay.answer("ws-1", "req-slow", { ok: true, tab: "t", url: "https://example.com/", title: "" })).toBe(
      false,
    );
  });

  test("an answer from another workspace, or a malformed one, settles nothing", async () => {
    const relay = new BrowserRelay({ newId: () => "req-1" });
    host(relay, "ws-1");
    const pending = relay.request(chatA, { action: "open", url: "https://example.com/" }, active);
    await Promise.resolve();
    const good = { ok: true as const, tab: "t", url: "https://example.com/", title: "Example" };
    expect(relay.answer("ws-2", "req-1", good)).toBe(false);
    expect(relay.answer("ws-1", "req-1", { ...good, script: "extra keys are refused" })).toBe(false);
    expect(relay.answer("ws-1", "req-1", { ok: true })).toBe(false);
    expect(relay.answer("ws-1", "req-1", { ok: false, reason: "" })).toBe(false);
    expect(relay.answer("ws-1", "req-1", good)).toBe(true);
    expect(await pending).toEqual(good);
    expect(relay.answer("ws-1", "req-1", good)).toBe(false);
  });

  test("a run that stopped is refused before the window is asked, and one that stops mid-request keeps no tab", async () => {
    const relay = new BrowserRelay();
    const window = host(relay, "ws-1", opened("tab-late"));
    const stopped = () => {
      throw new Error("revoked");
    };
    await expect(relay.request(chatA, { action: "open", url: "https://example.com/" }, stopped)).rejects.toThrow(
      "revoked",
    );
    expect(window.frames).toEqual([]);

    let running = true;
    const stopsWhileWaiting = () => {
      if (!running) throw new Error("revoked");
    };
    const pending = relay.request(chatA, { action: "open", url: "https://example.com/" }, stopsWhileWaiting);
    running = false;
    await expect(pending).rejects.toThrow("revoked");
    expect(window.frames).toHaveLength(1);
    expect(await relay.request(chatA, { action: "read", tab: "tab-late", maxChars: 5000 }, active)).toEqual({
      ok: false,
      reason: BROWSER_REFUSALS.notYours,
    });
  });
});

describe("the managed browser tools", () => {
  const chat = {
    id: "chat-a",
    workspaceId: "ws-1",
    provider: "claude-code",
    sessionId: "session-a",
    workspacePath: "/tmp/ws",
  } as unknown as ChatState;
  const context = { chat, assertActive() {}, reservations: new Set<string>() };
  const noBus = async () => {
    throw new Error("the browser tools never need the bus");
  };

  test("are offered only when the daemon has a relay", () => {
    const names = (tools: ReturnType<typeof createManagedTools>) =>
      tools.list.map((tool) => (tool as { name: string }).name);
    expect(names(createManagedTools(noBus))).not.toContain("glosa_browser_open");
    expect(names(createManagedTools(noBus, undefined, undefined, new BrowserRelay()))).toEqual(
      expect.arrayContaining(["glosa_browser_open", "glosa_browser_navigate", "glosa_browser_read"]),
    );
  });

  test("return a refusal as the tool's result, so its reason reaches the agent", async () => {
    const tools = createManagedTools(noBus, undefined, undefined, new BrowserRelay());
    expect(await tools.call(context, "glosa_browser_open", { url: "https://example.com/" })).toEqual({
      ok: false,
      reason: BROWSER_REFUSALS.noWindow,
    });
  });

  test("send the chat's own identity and the read cap, and default the cap to 100,000", async () => {
    const relay = new BrowserRelay();
    const window = host(relay, "ws-1", opened("tab-1"));
    const tools = createManagedTools(noBus, undefined, undefined, relay);
    expect(await tools.call(context, "glosa_browser_open", { url: "https://example.com/" })).toMatchObject({
      ok: true,
      tab: "tab-1",
    });
    await tools.call(context, "glosa_browser_read", { tab: "tab-1" });
    await tools.call(context, "glosa_browser_read", { tab: "tab-1", max_chars: 2000 });
    expect(window.frames.map((frame) => [frame.chat_id, frame.provider, frame.action, frame.max_chars])).toEqual([
      ["chat-a", "claude-code", "open", undefined],
      ["chat-a", "claude-code", "read", 100_000],
      ["chat-a", "claude-code", "read", 2000],
    ]);
    await expect(tools.call(context, "glosa_browser_read", { tab: "tab-1", max_chars: 10 })).rejects.toThrow();
    await expect(
      tools.call(context, "glosa_browser_open", { url: "https://example.com/", session_id: "another-session" }),
    ).rejects.toThrow("another session");
  });
});

describe("the browser stream and answer route (A1 §5.25)", () => {
  const TOKEN = "browser-relay-token-0123456789abcdef";

  async function serve() {
    const home = mkdtempSync(join(tmpdir(), "glosa-browser-relay-home-"));
    const root = canonicalize(mkdtempSync(join(tmpdir(), "glosa-browser-relay-root-")));
    cleanups.push(() => {
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    });
    const port = randomPort();
    const workspaceIndex = new WorkspaceIndex({ home });
    const sessionRegistry = new SessionRegistry({ index: workspaceIndex });
    const busRegistry = new WorkspaceBusRegistry();
    const entry = await workspaceIndex.upsertWorkspace(root, "glosa-open");
    const relay = new BrowserRelay();
    const ctx: ApiContext = {
      port,
      classFPort: port + 1,
      token: TOKEN,
      instanceId: "gl-browser-relay-test",
      startedAt: new Date().toISOString(),
      workspaceIndex,
      sessionRegistry,
      getWorkspaceBus: (r) => busRegistry.get(r),
      capabilityStore: new CapabilityStore(),
      home,
      browserRelay: relay,
    };
    const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: createApiFetch(ctx) });
    cleanups.push(async () => {
      await server.stop(true);
      await busRegistry.closeAll();
    });
    if (!(await waitForHandshake(port))) throw new Error(`browser relay test server did not answer on ${port}`);
    const chat = { id: "chat-a", workspaceId: entry.registration_id, provider: "claude-code" };
    return { port, slug: entry.slug, relay, chat };
  }

  async function stream(port: number, slug: string, query: string) {
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/w/${slug}/stream${query}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    const frames: ParsedSseEvent[] = [];
    const pump = (async () => {
      try {
        for await (const frame of parseSseStream(res.body!.getReader())) frames.push(frame);
      } catch {}
    })();
    const close = async () => {
      controller.abort();
      await pump;
    };
    cleanups.push(close);
    const until = async (want: () => boolean, what: string) => {
      const deadline = Date.now() + 3000;
      while (!want()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await Bun.sleep(10);
      }
    };
    await until(() => frames.some((frame) => frame.event === "snapshot"), "the snapshot");
    return { frames, close, until };
  }

  const answer = (port: number, slug: string, id: string, body: unknown, origin = `http://127.0.0.1:${port}`) =>
    fetch(`http://127.0.0.1:${port}/w/${slug}/browser-requests/${id}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  test("only a stream that asked with browser=1 hosts tabs, and its page's answer settles the tool", async () => {
    const h = await serve();
    const plain = await stream(h.port, h.slug, "");
    expect(await h.relay.request(h.chat, { action: "open", url: "https://example.com/" }, active)).toEqual({
      ok: false,
      reason: BROWSER_REFUSALS.noWindow,
    });

    const desk = await stream(h.port, h.slug, "?browser=1");
    const pending = h.relay.request(h.chat, { action: "open", url: "https://example.com/" }, active);
    await desk.until(() => desk.frames.some((frame) => frame.event === "browser_request"), "a browser_request");
    const frame = JSON.parse(desk.frames.find((f) => f.event === "browser_request")!.data);
    expect(frame).toMatchObject({
      chat_id: "chat-a",
      provider: "claude-code",
      action: "open",
      url: "https://example.com/",
    });
    expect(plain.frames.some((f) => f.event === "browser_request")).toBe(false);

    const good = { ok: true as const, tab: "tab-1", url: "https://example.com/", title: "Example" };
    expect((await answer(h.port, h.slug, frame.id, good, "https://evil.example")).status).toBe(403);
    expect((await answer(h.port, h.slug, frame.id, { ok: "yes" })).status).toBe(404);
    const accepted = await answer(h.port, h.slug, frame.id, good);
    expect(accepted.status).toBe(204);
    expect(await pending).toEqual(good);
    expect((await answer(h.port, h.slug, frame.id, good)).status).toBe(404);
  });

  test("closing the desk window's stream fails the request it held", async () => {
    const h = await serve();
    const desk = await stream(h.port, h.slug, "?browser=1");
    const pending = h.relay.request(h.chat, { action: "open", url: "https://example.com/" }, active);
    await desk.until(() => desk.frames.some((frame) => frame.event === "browser_request"), "a browser_request");
    await desk.close();
    expect(await pending).toEqual({ ok: false, reason: BROWSER_REFUSALS.closed });
  });
});

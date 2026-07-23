// SPDX-License-Identifier: Apache-2.0
// P3.3 — pure logic tests for data-access.js (R6's ONE data-access module). No DOM: `fetchFn`/
// `storage` are hand-rolled fakes, exactly the injection points data-access.js exists to expose.
import { describe, expect, test } from "bun:test";
import { computeBackoffMs, createDataAccess, DataAccessError, openStream, parseSseStream } from "../src/data-access.js";

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("createDataAccess — request shape", () => {
  test("getArtifacts sends the Bearer token from storage and hits the right path", async () => {
    const calls: Array<[string, RequestInit]> = [];
    const fetchFn = async (path: string, init: RequestInit) => {
      calls.push([path, init]);
      return jsonResponse(200, [{ path: "a.md" }]);
    };
    const da = createDataAccess({ fetchFn, storage: fakeStorage({ glosa_token: "tok-123" }) });

    const result = await da.getArtifacts("ws-abc");

    expect(result).toEqual([{ path: "a.md" }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe("/w/ws-abc/artifacts");
    const headers = new Headers(calls[0]![1].headers);
    expect(headers.get("Authorization")).toBe("Bearer tok-123");
  });

  test("getArtifact with render:'html' appends ?render=html and URL-encodes the path", async () => {
    const calls: string[] = [];
    const fetchFn = async (path: string) => {
      calls.push(path);
      return jsonResponse(200, { source_path: "a b.md" });
    };
    const da = createDataAccess({ fetchFn, storage: fakeStorage() });

    await da.getArtifact("ws", "a b.md", { render: "html" });

    expect(calls[0]).toBe("/w/ws/artifacts/a%20b.md?render=html");
  });

  test("getArtifact without render omits the query string", async () => {
    const calls: string[] = [];
    const fetchFn = async (path: string) => {
      calls.push(path);
      return jsonResponse(200, {});
    };
    const da = createDataAccess({ fetchFn, storage: fakeStorage() });
    await da.getArtifact("ws", "a.md");
    expect(calls[0]).toBe("/w/ws/artifacts/a.md");
  });

  test("mintClassFCapability POSTs /w/:slug/capability/:artifactPath and URL-encodes the path", async () => {
    const calls: Array<[string, RequestInit]> = [];
    const fetchFn = async (path: string, init: RequestInit) => {
      calls.push([path, init]);
      return jsonResponse(200, { url: "http://127.0.0.1:4647/doc/tok/notes.html", nonce: "n", expires_in_s: 600 });
    };
    const da = createDataAccess({ fetchFn, storage: fakeStorage() });

    const result = await da.mintClassFCapability("ws", "output/docs/rendered preview.html");

    // encodePathSegments encodes each path segment separately (preserving the `/` separators) —
    // only the segment containing a space gets percent-encoded.
    expect(calls[0]![0]).toBe("/w/ws/capability/output/docs/rendered%20preview.html");
    expect(calls[0]![1].method).toBe("POST");
    expect(result.url).toBe("http://127.0.0.1:4647/doc/tok/notes.html");
    expect(result.nonce).toBe("n");
  });

  test("postAnnotation POSTs JSON to /w/:slug/annotations", async () => {
    let captured: { path: string; init: RequestInit } | null = null;
    const fetchFn = async (path: string, init: RequestInit) => {
      captured = { path, init };
      return jsonResponse(201, { id: "inb-1", status: "pending" });
    };
    const da = createDataAccess({ fetchFn, storage: fakeStorage() });
    const record = { body: "x", intent: "content", target: { quote: { exact: "x" } } };

    const result = await da.postAnnotation("ws", record);

    expect(result).toEqual({ id: "inb-1", status: "pending" });
    expect(captured!.path).toBe("/w/ws/annotations");
    expect(captured!.init.method).toBe("POST");
    expect(JSON.parse(captured!.init.body as string)).toEqual(record);
  });

  test("attention reads and mutations stay inside the single data-access module", async () => {
    const calls: Array<[string, RequestInit]> = [];
    const fetchFn = async (path: string, init: RequestInit = {}) => {
      calls.push([path, init]);
      return jsonResponse(200, path.endsWith("/inbox") ? { pending_count: 0, attention: [] } : { status: "done" });
    };
    const da = createDataAccess({ fetchFn, storage: fakeStorage({ glosa_token: "tok" }) });

    await da.getInbox("ws");
    await da.markAttentionSeen("ws", "att 1");
    await da.respondToAttention("ws", "att 1", { outcome: "changes_requested", response: "Please revise" });

    expect(calls.map(([path]) => path)).toEqual([
      "/w/ws/inbox",
      "/w/ws/inbox/att%201/seen",
      "/w/ws/inbox/att%201/response",
    ]);
    expect(calls[1]![1].method).toBe("POST");
    expect(JSON.parse(calls[2]![1].body as string)).toEqual({ outcome: "changes_requested", response: "Please revise" });
  });

  test("conversation compose and reconnect status carry stable message/session identity", async () => {
    const calls: Array<[string, RequestInit]> = [];
    const fetchFn = async (path: string, init: RequestInit = {}) => {
      calls.push([path, init]);
      return jsonResponse(200, { message_id: "m-1", delivered: true, state: "presented" });
    };
    const da = createDataAccess({ fetchFn, storage: fakeStorage({ glosa_token: "tok" }) });

    await da.sendComposerMessage("ws", "exact text", { messageId: "m-1", sessionHint: "session-a" });
    await da.getComposerMessageStatus("ws", "m-1");

    expect(calls.map(([path]) => path)).toEqual([
      "/w/ws/transcript/compose",
      "/w/ws/transcript/compose/m-1",
    ]);
    expect(JSON.parse(calls[0]![1].body as string)).toEqual({
      text: "exact text",
      message_id: "m-1",
      session_hint: "session-a",
    });
  });

  test("putArtifact PUTs the content with an If-Match header when given", async () => {
    let captured: { path: string; init: RequestInit } | null = null;
    const fetchFn = async (path: string, init: RequestInit) => {
      captured = { path, init };
      return jsonResponse(200, { source_sha256: "abc" });
    };
    const da = createDataAccess({ fetchFn, storage: fakeStorage() });

    await da.putArtifact("ws", "notes.md", "new content", { ifMatch: "old-sha" });

    expect(captured!.path).toBe("/w/ws/artifacts/notes.md");
    expect(captured!.init.method).toBe("PUT");
    expect(captured!.init.body).toBe("new content");
    const headers = new Headers(captured!.init.headers);
    expect(headers.get("If-Match")).toBe("old-sha");
  });

  test("a non-ok response throws DataAccessError carrying the parsed problem+json body", async () => {
    const fetchFn = async () =>
      new Response(JSON.stringify({ type: "https://glosa.local/errors/not-found", title: "nope", status: 404 }), {
        status: 404,
        headers: { "Content-Type": "application/problem+json" },
      });
    const da = createDataAccess({ fetchFn, storage: fakeStorage() });

    await expect(da.getArtifacts("ws")).rejects.toThrow(DataAccessError);
    try {
      await da.getArtifacts("ws");
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DataAccessError);
      expect((err as DataAccessError).status).toBe(404);
      expect((err as DataAccessError).problem?.title).toBe("nope");
    }
  });

  test("401 clears the stale credential and requests the unpaired screen exactly once", async () => {
    const storage = fakeStorage({ glosa_token: "stale" });
    let unauthorized = 0;
    const da = createDataAccess({
      storage,
      fetchFn: async () => jsonResponse(401, { title: "missing or invalid bearer token" }),
      onUnauthorized: () => unauthorized++,
    });

    await expect(da.getArtifacts("ws")).rejects.toThrow(DataAccessError);
    await expect(da.getWorkspaces()).rejects.toThrow(DataAccessError);

    expect(storage.getItem("glosa_token")).toBeNull();
    expect(unauthorized).toBe(1);
  });

  test("no token in storage → no Authorization header sent", async () => {
    const calls: RequestInit[] = [];
    const fetchFn = async (_path: string, init: RequestInit) => {
      calls.push(init);
      return jsonResponse(200, []);
    };
    const da = createDataAccess({ fetchFn, storage: fakeStorage() });
    await da.getArtifacts("ws");
    const headers = new Headers(calls[0]!.headers);
    expect(headers.has("Authorization")).toBe(false);
  });
});

describe("computeBackoffMs — A1 §8.2 reconnect schedule", () => {
  test("attempt 0 with no jitter → exactly the 250ms base", () => {
    expect(computeBackoffMs(0, () => 0.5)).toBe(250); // rand()=0.5 → jitter term is 0
  });

  test("doubles each attempt, capped at 5000ms", () => {
    expect(computeBackoffMs(1, () => 0.5)).toBe(500);
    expect(computeBackoffMs(2, () => 0.5)).toBe(1000);
    expect(computeBackoffMs(3, () => 0.5)).toBe(2000);
    expect(computeBackoffMs(4, () => 0.5)).toBe(4000);
    expect(computeBackoffMs(5, () => 0.5)).toBe(5000); // would be 8000 uncapped
    expect(computeBackoffMs(10, () => 0.5)).toBe(5000); // stays capped
  });

  test("jitter stays within ±20% of the raw (pre-jitter) value", () => {
    const raw = 250 * 2 ** 3; // attempt 3, uncapped
    const min = raw - raw * 0.2;
    const max = raw + raw * 0.2;
    for (const rand of [0, 0.25, 0.5, 0.75, 1]) {
      const value = computeBackoffMs(3, () => rand);
      expect(value).toBeGreaterThanOrEqual(Math.round(min));
      expect(value).toBeLessThanOrEqual(Math.round(max));
    }
  });

  test("never returns a negative wait", () => {
    expect(computeBackoffMs(0, () => 0)).toBeGreaterThanOrEqual(0);
  });
});

describe("parseSseStream — the client-side wire parser", () => {
  function readerFor(chunks: string[]): ReadableStreamDefaultReader<Uint8Array> {
    const encoder = new TextEncoder();
    let i = 0;
    return {
      read: async () => {
        if (i < chunks.length) return { done: false, value: encoder.encode(chunks[i++]) };
        return { done: true, value: undefined };
      },
      // Minimal stub — nothing under test calls the rest of the reader interface.
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;
  }

  test("reassembles a frame split across two chunks", async () => {
    const frames = [];
    const reader = readerFor(["id: 3\nevent: jour", 'nal\ndata: {"a":1}\n\n']);
    for await (const frame of parseSseStream(reader)) frames.push(frame);
    expect(frames).toEqual([{ id: "3", event: "journal", data: '{"a":1}' }]);
  });

  test("drops heartbeat frames silently", async () => {
    const reader = readerFor(["event: heartbeat\ndata: \n\nevent: journal\ndata: {}\n\n"]);
    const frames = [];
    for await (const frame of parseSseStream(reader)) frames.push(frame);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.event).toBe("journal");
  });
});

describe("openStream — reconnect + Last-Event-ID + onReconnect", () => {
  function streamResponse(frames: string[]): Response {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    });
    return new Response(body, { status: 200 });
  }

  test("onReconnect fires only from the SECOND connect onward, carrying Last-Event-ID from the first", async () => {
    const requests: RequestInit[] = [];
    let call = 0;
    const fetchFn = async (_path: string, init: RequestInit) => {
      requests.push(init);
      call += 1;
      if (call === 1) return streamResponse(['id: 7\nevent: journal\ndata: {"n":1}\n\n']); // then the body closes → "drop"
      return streamResponse(['id: 8\nevent: journal\ndata: {"n":2}\n\n']);
    };

    const events: Array<{ event: string; data: unknown }> = [];
    const reconnects: number[] = [];
    let stop: (() => void) | null = null;

    await new Promise<void>((resolve) => {
      let seen = 0;
      stop = openStream({
        fetchFn,
        storage: fakeStorage(),
        slug: "ws",
        sleepFn: async () => {}, // no real delay in the test
        onEvent: (frame: { event: string; data: unknown }) => {
          events.push(frame);
          seen += 1;
          if (seen === 2) resolve();
        },
        onReconnect: () => reconnects.push(call),
      });
    });
    stop!();

    expect(events.map((e) => e.data)).toEqual([{ n: 1 }, { n: 2 }]);
    expect(reconnects).toEqual([2]); // fired once, on the SECOND connect only
    expect(requests).toHaveLength(2);
    expect(new Headers(requests[0]!.headers).has("Last-Event-ID")).toBe(false); // first connect
    expect(new Headers(requests[1]!.headers).get("Last-Event-ID")).toBe("7"); // reconnect resumes from the last cursor seen
  });

  test("onStatus reports one 'down' per outage and one 'up' on recovery — deduped across failed retries", async () => {
    let call = 0;
    const fetchFn = async () => {
      call += 1;
      if (call === 1) return streamResponse(['id: 1\nevent: journal\ndata: {"n":1}\n\n']); // closes → drop
      if (call <= 3) throw new Error("daemon down"); // two failed retries — still ONE 'down'
      return streamResponse(['id: 2\nevent: journal\ndata: {"n":2}\n\n']);
    };

    const statuses: string[] = [];
    let stop: (() => void) | null = null;
    await new Promise<void>((resolve) => {
      let seen = 0;
      stop = openStream({
        fetchFn,
        storage: fakeStorage(),
        slug: "ws",
        sleepFn: async () => {},
        onEvent: () => {
          seen += 1;
          if (seen === 2) resolve();
        },
        onStatus: (s: string) => statuses.push(s),
      });
    });
    stop!();

    expect(statuses).toEqual(["down", "up"]);
  });

  test("`bye` reconnects immediately without surfacing an outage and preserves the cursor", async () => {
    const requests: RequestInit[] = [];
    const sleeps: number[] = [];
    const statuses: string[] = [];
    const events: Array<{ event: string; data: unknown }> = [];
    let call = 0;
    const fetchFn = async (_path: string, init: RequestInit) => {
      requests.push(init);
      call += 1;
      if (call === 1) {
        return streamResponse([
          'id: 7\nevent: journal\ndata: {"n":1}\n\n',
          "event: bye\ndata: \n\n",
        ]);
      }
      return streamResponse(['id: 8\nevent: journal\ndata: {"n":2}\n\n']);
    };

    let stop: (() => void) | null = null;
    await new Promise<void>((resolve) => {
      stop = openStream({
        fetchFn,
        storage: fakeStorage(),
        slug: "ws",
        sleepFn: async (ms: number) => void sleeps.push(ms),
        onStatus: (status: string) => statuses.push(status),
        onEvent: (frame: { event: string; data: unknown }) => {
          events.push(frame);
          if (events.length === 2) resolve();
        },
      });
    });
    stop!();

    expect(events.map((event) => event.event)).toEqual(["journal", "journal"]);
    expect(requests).toHaveLength(2);
    expect(new Headers(requests[1]!.headers).get("Last-Event-ID")).toBe("7");
    expect(sleeps).toEqual([]);
    expect(statuses).toEqual([]);
  });

  test("a resync_required frame clears the stored cursor — the next connect carries no Last-Event-ID", async () => {
    const requests: RequestInit[] = [];
    let call = 0;
    const fetchFn = async (_path: string, init: RequestInit) => {
      requests.push(init);
      call += 1;
      if (call === 1) return streamResponse(["event: resync_required\ndata: \n\n"]);
      return streamResponse(['id: 1\nevent: journal\ndata: {"n":1}\n\n']);
    };

    let stop: (() => void) | null = null;
    await new Promise<void>((resolve) => {
      stop = openStream({
        fetchFn,
        storage: fakeStorage(),
        slug: "ws",
        sleepFn: async () => {},
        onEvent: () => resolve(),
        onReconnect: () => {},
      });
    });
    stop!();

    expect(requests).toHaveLength(2);
    expect(new Headers(requests[1]!.headers).has("Last-Event-ID")).toBe(false);
  });

  test("401 stops reconnecting, removes the stale token, and returns the tab to unpaired", async () => {
    const storage = fakeStorage({ glosa_token: "stale" });
    let requests = 0;
    let stop: (() => void) | null = null;
    await new Promise<void>((resolve) => {
      stop = openStream({
        slug: "ws",
        storage,
        fetchFn: async () => {
          requests += 1;
          return jsonResponse(401, { title: "missing or invalid bearer token" });
        },
        sleepFn: async () => {
          throw new Error("401 must not enter reconnect backoff");
        },
        onUnauthorized: resolve,
      });
    });
    stop!();

    expect(requests).toBe(1);
    expect(storage.getItem("glosa_token")).toBeNull();
  });
});

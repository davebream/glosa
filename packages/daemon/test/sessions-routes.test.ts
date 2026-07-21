// SPDX-License-Identifier: Apache-2.0
// P4.3 — the `/api/sessions/...` surface `glosa hook <event>` calls into (A2 §F08/R2): register,
// heartbeat, deregister, drain. Same harness style as http-routes.test.ts — a real `createApiFetch`
// pipeline in-process against real `WorkspaceIndex`/`SessionRegistry`/`WorkspaceBusRegistry`
// instances over real tmp workspaces.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiFetch, type ApiContext } from "../src/http.ts";
import { CapabilityStore } from "../src/capability.ts";
import { WorkspaceIndex } from "../src/registry/workspace-index.ts";
import { SessionRegistry } from "../src/registry/session-registry.ts";
import { WorkspaceBusRegistry } from "../src/bus/workspace-bus-registry.ts";
import { canonicalize } from "../src/registry/slug.ts";

const TOKEN = "sessions-route-test-token-0123456789";
const PORT = 4646;

describe("/api/sessions/... (A2 §F08/R2)", () => {
  let home: string;
  let root: string;
  let workspaceIndex: WorkspaceIndex;
  let sessionRegistry: SessionRegistry;
  let busRegistry: WorkspaceBusRegistry;
  let ctx: ApiContext;
  let fetchFn: (req: Request) => Promise<Response>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "glosa-sessions-home-"));
    root = canonicalize(mkdtempSync(join(tmpdir(), "glosa-sessions-ws-")));

    workspaceIndex = new WorkspaceIndex({ home });
    sessionRegistry = new SessionRegistry({ index: workspaceIndex });
    busRegistry = new WorkspaceBusRegistry();
    workspaceIndex.setLiveSessionPredicate((p) => sessionRegistry.forWorkspace(p).length > 0);
    workspaceIndex.setOnHardRemove((p) => busRegistry.evict(p));

    ctx = {
      port: PORT,
      classFPort: PORT + 1,
      token: TOKEN,
      instanceId: "gl-test",
      startedAt: new Date().toISOString(),
      workspaceIndex,
      sessionRegistry,
      getWorkspaceBus: (r) => busRegistry.get(r),
      capabilityStore: new CapabilityStore(),
    };
    fetchFn = createApiFetch(ctx);
  });

  afterEach(async () => {
    await busRegistry.close(root);
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  function req(path: string, init: RequestInit = {}): Request {
    const headers = new Headers(init.headers);
    headers.set("Host", `127.0.0.1:${PORT}`);
    if (!headers.has("Authorization")) headers.set("Authorization", `Bearer ${TOKEN}`);
    headers.set("Origin", `http://127.0.0.1:${PORT}`);
    return new Request(`http://127.0.0.1:${PORT}${path}`, { ...init, headers });
  }

  test("POST /api/sessions/register creates a live registry record and returns drained_workspaces:[]", async () => {
    const res = await fetchFn(
      req("/api/sessions/register", {
        method: "POST",
        body: JSON.stringify({ session_id: "sess-1", provider: "claude-code", cwd: root, source: "startup" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ session_id: "sess-1", workspace: root, drained_workspaces: [] });
    expect(sessionRegistry.liveness("sess-1")).toBe("alive");
    expect(sessionRegistry.get("sess-1")?.cwd).toBe(root);
  });

  test("POST /api/sessions/register with a missing field -> 400 validation-failed", async () => {
    const res = await fetchFn(req("/api/sessions/register", { method: "POST", body: JSON.stringify({ session_id: "sess-1" }) }));
    expect(res.status).toBe(400);
  });

  test("POST /api/sessions/register with a cwd that doesn't exist -> 400 invalid-path", async () => {
    const res = await fetchFn(
      req("/api/sessions/register", {
        method: "POST",
        body: JSON.stringify({ session_id: "sess-1", provider: "claude-code", cwd: "/no/such/dir/at/all", source: "startup" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("register -> drained_workspaces surfaces a previously-parked workspace (R2)", async () => {
    // Park the workspace by asking the registry to route to it while no session is live.
    sessionRegistry.markParked(root);
    const res = await fetchFn(
      req("/api/sessions/register", {
        method: "POST",
        body: JSON.stringify({ session_id: "sess-1", provider: "claude-code", cwd: root, source: "startup" }),
      }),
    );
    const body = await res.json();
    expect(body.drained_workspaces).toEqual([root]);
  });

  test("POST /api/sessions/:id/heartbeat extends the lease for a known session", async () => {
    await sessionRegistry.register({ session_id: "sess-1", provider: "claude-code", cwd: root, source: "startup" });
    const res = await fetchFn(req("/api/sessions/sess-1/heartbeat", { method: "POST" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("POST /api/sessions/:id/heartbeat for an unknown session is a silent 200, not a 404", async () => {
    const res = await fetchFn(req("/api/sessions/unknown-session/heartbeat", { method: "POST" }));
    expect(res.status).toBe(200);
  });

  test("POST /api/sessions/:id/deregister removes the session from the live registry", async () => {
    await sessionRegistry.register({ session_id: "sess-1", provider: "claude-code", cwd: root, source: "startup" });
    const res = await fetchFn(req("/api/sessions/sess-1/deregister", { method: "POST" }));
    expect(res.status).toBe(200);
    expect(sessionRegistry.get("sess-1")).toBeNull();
  });

  describe("POST /api/sessions/:id/drain", () => {
    test("drains pending entries for the session's workspace, records A5 §F23-conformant delivery_attempts, bounded to 8", async () => {
      await sessionRegistry.register({ session_id: "sess-1", provider: "claude-code", cwd: root, source: "startup" });
      const bus = busRegistry.get(root);
      for (let i = 0; i < 10; i++) await bus.createEntry(`e${i}`, { kind: "annotation" });

      const res = await fetchFn(req("/api/sessions/sess-1/drain", { method: "POST", body: "" }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.count).toBe(8); // DRAIN_MAX
      expect(body.drained).toHaveLength(8);

      for (const item of body.drained) {
        const attempts = bus.state.entries[item.id]?.deliveryAttempts as { via?: string; outcome?: string; reason?: string }[] | undefined;
        // Default `via` (no `via` in the request body) is "userprompt" — the drain route's own
        // default; `outcome:"presented"` because this route IS the hook response surfacing it.
        expect(attempts?.[0]).toMatchObject({ via: "userprompt", outcome: "presented", reason: "initial" });
        // A5 §F23 — status untouched by a delivery_attempt.
        expect(bus.state.entries[item.id]?.status).toBe("pending");
      }
    });

    test("a caller-supplied via ('stop'/'gate'/'asyncRewake') is recorded verbatim", async () => {
      await sessionRegistry.register({ session_id: "sess-1", provider: "claude-code", cwd: root, source: "startup" });
      const bus = busRegistry.get(root);
      await bus.createEntry("e1", { kind: "annotation" });

      await fetchFn(req("/api/sessions/sess-1/drain", { method: "POST", body: JSON.stringify({ via: "stop" }) }));
      const attempts = bus.state.entries.e1?.deliveryAttempts as { via?: string }[] | undefined;
      expect(attempts?.[0]?.via).toBe("stop");
    });

    test("a second drain call does NOT re-return already-attempted entries", async () => {
      await sessionRegistry.register({ session_id: "sess-1", provider: "claude-code", cwd: root, source: "startup" });
      const bus = busRegistry.get(root);
      await bus.createEntry("e1", { kind: "annotation" });

      const first = await (await fetchFn(req("/api/sessions/sess-1/drain", { method: "POST", body: "" }))).json();
      expect(first.count).toBe(1);
      const second = await (await fetchFn(req("/api/sessions/sess-1/drain", { method: "POST", body: "" }))).json();
      expect(second.count).toBe(0);
    });

    test("an already-terminal entry is never drained", async () => {
      await sessionRegistry.register({ session_id: "sess-1", provider: "claude-code", cwd: root, source: "startup" });
      const bus = busRegistry.get(root);
      await bus.createEntry("e1", { kind: "annotation" });
      await bus.commitTransition("e1", "applied");

      const body = await (await fetchFn(req("/api/sessions/sess-1/drain", { method: "POST", body: "" }))).json();
      expect(body.count).toBe(0);
    });

    // P4.3 concurrency review fix #7b — the filter is "non-terminal AND not yet SUCCESSFULLY
    // delivered", not "zero attempts": a prior FAILED attempt must not permanently exclude an
    // entry from the boundary-drain safety net.
    test("an entry with only a FAILED prior attempt IS re-drained, recorded with reason:'re_nudge'", async () => {
      await sessionRegistry.register({ session_id: "sess-1", provider: "claude-code", cwd: root, source: "startup" });
      const bus = busRegistry.get(root);
      await bus.createEntry("e1", { kind: "annotation" });
      // Simulate a provider's own failed rung attempt (e.g. ClaudeCodeProvider.deliver()'s
      // channel rung throwing) recorded BEFORE this entry ever reaches the drain route.
      await bus.recordDeliveryAttempt("e1", { via: "channel", session: "sess-1", outcome: "failed", reason: "initial", error: "ECONNRESET" });

      const body = await (await fetchFn(req("/api/sessions/sess-1/drain", { method: "POST", body: "" }))).json();
      expect(body.count).toBe(1);
      expect(body.drained[0].id).toBe("e1");

      const attempts = bus.state.entries.e1?.deliveryAttempts as { via?: string; outcome?: string; reason?: string }[] | undefined;
      expect(attempts).toHaveLength(2);
      expect(attempts?.[0]).toMatchObject({ outcome: "failed", reason: "initial" });
      expect(attempts?.[1]).toMatchObject({ outcome: "presented", reason: "re_nudge" });
    });

    test("an entry already SUCCESSFULLY delivered (outcome:'presented') is NOT re-drained, even though it's still non-terminal", async () => {
      await sessionRegistry.register({ session_id: "sess-1", provider: "claude-code", cwd: root, source: "startup" });
      const bus = busRegistry.get(root);
      await bus.createEntry("e1", { kind: "annotation" });
      await bus.recordDeliveryAttempt("e1", { via: "channel", session: "sess-1", outcome: "transport_accepted", reason: "initial" });

      const body = await (await fetchFn(req("/api/sessions/sess-1/drain", { method: "POST", body: "" }))).json();
      expect(body.count).toBe(0);
    });

    test("two concurrent drain calls on the same workspace never double-select the same entry (P4.3 concurrency review fix #7a)", async () => {
      await sessionRegistry.register({ session_id: "sess-1", provider: "claude-code", cwd: root, source: "startup" });
      const bus = busRegistry.get(root);
      for (let i = 0; i < 4; i++) await bus.createEntry(`e${i}`, { kind: "annotation" });

      const [bodyA, bodyB] = await Promise.all([
        fetchFn(req("/api/sessions/sess-1/drain", { method: "POST", body: JSON.stringify({ limit: 4 }) })).then((r) => r.json()),
        fetchFn(req("/api/sessions/sess-1/drain", { method: "POST", body: JSON.stringify({ limit: 4 }) })).then((r) => r.json()),
      ]);

      const idsA = bodyA.drained.map((e: { id: string }) => e.id);
      const idsB = bodyB.drained.map((e: { id: string }) => e.id);
      const overlap = idsA.filter((id: string) => idsB.includes(id));
      expect(overlap).toHaveLength(0); // no entry selected by both calls
      expect(idsA.length + idsB.length).toBe(4); // together they cover everything, exactly once each

      // Every entry has EXACTLY one delivery_attempt — never two from a double-select.
      for (let i = 0; i < 4; i++) {
        const attempts = bus.state.entries[`e${i}`]?.deliveryAttempts as unknown[] | undefined;
        expect(attempts).toHaveLength(1);
      }
    });

    test("respects a caller-supplied limit under the DRAIN_MAX cap", async () => {
      await sessionRegistry.register({ session_id: "sess-1", provider: "claude-code", cwd: root, source: "startup" });
      const bus = busRegistry.get(root);
      for (let i = 0; i < 5; i++) await bus.createEntry(`e${i}`, { kind: "annotation" });

      const body = await (
        await fetchFn(req("/api/sessions/sess-1/drain", { method: "POST", body: JSON.stringify({ limit: 2 }) }))
      ).json();
      expect(body.count).toBe(2);
    });

    test("unknown session_id -> 404", async () => {
      const res = await fetchFn(req("/api/sessions/unknown/drain", { method: "POST", body: "" }));
      expect(res.status).toBe(404);
    });
  });

  test("state-changing auth: register with no Origin -> 403", async () => {
    const headers = new Headers();
    headers.set("Host", `127.0.0.1:${PORT}`);
    headers.set("Authorization", `Bearer ${TOKEN}`);
    const res = await fetchFn(
      new Request(`http://127.0.0.1:${PORT}/api/sessions/register`, {
        method: "POST",
        headers,
        body: JSON.stringify({ session_id: "x", provider: "claude-code", cwd: root, source: "startup" }),
      }),
    );
    expect(res.status).toBe(403);
  });

  test("register with no Bearer -> 401", async () => {
    const headers = new Headers();
    headers.set("Host", `127.0.0.1:${PORT}`);
    headers.set("Origin", `http://127.0.0.1:${PORT}`);
    const res = await fetchFn(
      new Request(`http://127.0.0.1:${PORT}/api/sessions/register`, {
        method: "POST",
        headers,
        body: JSON.stringify({ session_id: "x", provider: "claude-code", cwd: root, source: "startup" }),
      }),
    );
    expect(res.status).toBe(401);
  });
});

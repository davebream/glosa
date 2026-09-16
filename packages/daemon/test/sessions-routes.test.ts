// SPDX-License-Identifier: Apache-2.0
// P4.3 — the `/api/sessions/...` surface the monitor, the Codex attachment, and the MCP shim call
// into (A2 §F08/R2): register, heartbeat, deregister, drain. Same harness style as
// http-routes.test.ts — a real `createApiFetch` pipeline in-process against real
// `WorkspaceIndex`/`SessionRegistry`/`WorkspaceBusRegistry` instances over real tmp workspaces.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionPushRegistry } from "../src/agent-provider/push-registry.ts";
import { WorkspaceBusRegistry } from "../src/bus/workspace-bus-registry.ts";
import { SessionRegistry } from "../src/registry/session-registry.ts";
import { canonicalize } from "../src/registry/slug.ts";
import { WorkspaceIndex } from "../src/registry/workspace-index.ts";
import { CapabilityStore } from "../src/security/capability.ts";
import { type ApiContext, createApiFetch } from "../src/transport/http.ts";

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

  function actionableAnnotation(body = "Please clarify this sentence.") {
    return {
      kind: "annotation",
      artifact_path: "notes.md",
      body,
      intent: "content",
      target: { quote: { exact: "sentence" }, position: { start: 1, end: 9 } },
    };
  }

  test("binding registers an unknown generic session, revives an expired lease, and preserves metadata", async () => {
    const workspace = await workspaceIndex.upsertWorkspace(root, "session");
    const bind = (body: unknown) =>
      fetchFn(req(`/w/${workspace.slug}/session-binding`, { method: "POST", body: JSON.stringify(body) }));
    expect((await bind({ session_id: "manual" })).status).toBe(200);
    expect(sessionRegistry.get("manual")).toMatchObject({ provider: "mcp", cwd: root, workspace_binding: root });
    await sessionRegistry.register({
      session_id: "manual",
      provider: "codex",
      cwd: root,
      source: "mcp",
      transcript_path: "/fixture.jsonl",
      lease_expiry: new Date(0).toISOString(),
    });
    expect(sessionRegistry.liveness("manual")).toBe("stale");
    expect((await bind({ session_id: "manual" })).status).toBe(200);
    expect(sessionRegistry.liveness("manual")).toBe("alive");
    expect(sessionRegistry.get("manual")).toMatchObject({ provider: "codex", transcript_path: "/fixture.jsonl" });
    expect((await bind({ session_id: "manual", provider: "claude-code" })).status).toBe(409);
    expect((await bind({ session_id: "bad", cwd: "/nonexistent-recovery-cwd" })).status).toBe(400);
    expect(sessionRegistry.get("bad")).toBeNull();
  });

  test("an explicit bind records the caller's source, and `manual` when it supplies none (A2 §F08, R2)", async () => {
    const workspace = await workspaceIndex.upsertWorkspace(root, "session");
    const bind = (body: unknown) =>
      fetchFn(req(`/w/${workspace.slug}/session-binding`, { method: "POST", body: JSON.stringify(body) }));
    expect((await bind({ session_id: "bare" })).status).toBe(200);
    expect(sessionRegistry.get("bare")?.source).toBe("manual");
    expect((await bind({ session_id: "from-cli", source: "cli" })).status).toBe(200);
    expect(sessionRegistry.get("from-cli")?.source).toBe("cli");
  });

  for (const end of ["cancel", "shutdown", "revoke", "replace"] as const) {
    test(`open stream alone keeps session alive; ${end} cleans up its lease handle`, async () => {
      let ms = 0;
      const callbacks = new Set<() => void>();
      sessionRegistry = new SessionRegistry({
        index: workspaceIndex,
        now: () => new Date(ms),
        scheduleRefresh: (callback) => {
          callbacks.add(callback);
          return () => {
            callbacks.delete(callback);
          };
        },
      });
      ctx.sessionRegistry = sessionRegistry;
      ctx.pushRegistry = new SessionPushRegistry();
      const shutdown = new AbortController();
      const generation = new AbortController();
      ctx.shutdownSignal = shutdown.signal;
      ctx.token = {
        current: () => TOKEN,
        generationSignal: () => generation.signal,
        snapshot: () => ({ token: TOKEN, signal: generation.signal }),
      };
      await sessionRegistry.register({
        session_id: "stream-session",
        provider: "claude-code",
        cwd: root,
        workspace_binding: root,
        source: "monitor",
      });
      const response = await fetchFn(req("/api/sessions/stream-session/stream?transport=monitor"));
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      await reader.read();
      for (let i = 0; i < 8; i++) {
        ms += 20_000;
        for (const callback of callbacks) callback();
        await sessionRegistry.heartbeat("barrier");
        expect(sessionRegistry.liveness("stream-session")).toBe("alive");
      }
      if (end === "cancel") await reader.cancel();
      if (end === "shutdown" || end === "revoke") {
        if (end === "shutdown") shutdown.abort();
        else generation.abort();
        // #206: shutdown and revocation are still byte-identical plain EOF — no superseded frame.
        expect(await reader.read()).toEqual({ done: true, value: undefined });
      }
      if (end === "replace") {
        const next = await fetchFn(req("/api/sessions/stream-session/stream?transport=monitor"));
        // #206: the displaced reader's next read consumes the terminal `superseded` frame, THEN EOF.
        const superseded = await reader.read();
        expect(superseded.done).toBe(false);
        expect(new TextDecoder().decode(superseded.value)).toBe(
          `event: superseded\ndata: ${JSON.stringify({ transport: "monitor" })}\n\n`,
        );
        expect((await reader.read()).done).toBe(true);
        expect(callbacks.size).toBe(1);
        await reader.cancel(); // old reader cannot release the replacement
        expect(callbacks.size).toBe(1);
        await next.body!.cancel();
      }
      expect(callbacks.size).toBe(0);
      expect(ctx.pushRegistry.has("stream-session")).toBe(false);
      expect(sessionRegistry.liveness("stream-session")).toBe("alive");
      ms += 60_000;
      expect(sessionRegistry.liveness("stream-session")).toBe("stale");
    });
  }

  test("GET /api/sessions/:id/stream/status answers from the push registry alone: unknown, connected, displaced, closed", async () => {
    ctx.pushRegistry = new SessionPushRegistry();

    const unknown = await fetchFn(req("/api/sessions/nobody-here/stream/status"));
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toEqual({ connected: false, transport: null });
    expect(sessionRegistry.get("nobody-here")).toBeNull(); // no registration, no heartbeat, no lease

    await sessionRegistry.register({
      session_id: "probe-session",
      provider: "claude-code",
      cwd: root,
      workspace_binding: root,
      source: "monitor",
    });
    const first = await fetchFn(req("/api/sessions/probe-session/stream?transport=monitor"));
    expect(first.status).toBe(200);
    const firstReader = first.body!.getReader();
    await firstReader.read(); // consume ": connected"

    const connected = await fetchFn(req("/api/sessions/probe-session/stream/status"));
    expect(await connected.json()).toEqual({ connected: true, transport: "monitor" });

    const second = await fetchFn(req("/api/sessions/probe-session/stream?transport=monitor"));
    expect(second.status).toBe(200);
    await firstReader.read(); // the displaced reader's own superseded frame
    const stillConnected = await fetchFn(req("/api/sessions/probe-session/stream/status"));
    expect(await stillConnected.json()).toEqual({ connected: true, transport: "monitor" }); // now the REPLACEMENT

    await second.body!.cancel();
    const afterClose = await fetchFn(req("/api/sessions/probe-session/stream/status"));
    expect(await afterClose.json()).toEqual({ connected: false, transport: null });
  });

  async function ack(sessionId: string, deliveryId: string, outcome: "presented" | "failed" = "presented") {
    return fetchFn(
      req(`/api/sessions/${sessionId}/deliveries/${deliveryId}/ack`, {
        method: "POST",
        body: JSON.stringify({ outcome }),
      }),
    );
  }

  test("POST /api/sessions/register creates a live registry record and returns only the resolved identity", async () => {
    const res = await fetchFn(
      req("/api/sessions/register", {
        method: "POST",
        body: JSON.stringify({ session_id: "sess-1", provider: "claude-code", cwd: root, source: "startup" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    // R2's park is journal state, not daemon memory (AGENTS.md invariant 2), so a registration has
    // no "workspaces I just un-parked" list to report. The response carries identity only; the
    // drain that actually surfaces parked work is the separate `POST /api/sessions/:id/drain`.
    expect(body).toEqual({ session_id: "sess-1", workspace: root });
    expect(sessionRegistry.liveness("sess-1")).toBe("alive");
    expect(sessionRegistry.get("sess-1")?.cwd).toBe(root);
  });

  test("POST /api/sessions/register with a missing field -> 400 validation-failed", async () => {
    const res = await fetchFn(
      req("/api/sessions/register", { method: "POST", body: JSON.stringify({ session_id: "sess-1" }) }),
    );
    expect(res.status).toBe(400);
  });

  test("POST /api/sessions/register with a cwd that doesn't exist -> 400 invalid-path", async () => {
    const res = await fetchFn(
      req("/api/sessions/register", {
        method: "POST",
        body: JSON.stringify({
          session_id: "sess-1",
          provider: "claude-code",
          cwd: "/no/such/dir/at/all",
          source: "startup",
        }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("R2 park -> drain: an entry created with NO live session is drained by the next session to register", async () => {
    // R2: "No live session -> the entry parks; next session registration for that workspace drains
    // it." The park IS the entry staying non-terminal in the workspace journal — there is no
    // separate in-memory park ledger, which is why a park survives a daemon restart.
    expect(sessionRegistry.forWorkspace(root)).toHaveLength(0);
    const bus = busRegistry.get(root);
    await bus.createEntry("parked-1", actionableAnnotation("Parked before any session existed."));

    const registered = await fetchFn(
      req("/api/sessions/register", {
        method: "POST",
        body: JSON.stringify({ session_id: "sess-1", provider: "claude-code", cwd: root, source: "startup" }),
      }),
    );
    expect(registered.status).toBe(200);

    const res = await fetchFn(req("/api/sessions/sess-1/drain", { method: "POST", body: "" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.drained.map((entry: { id: string }) => entry.id)).toEqual(["parked-1"]);
  });

  test("provider-neutral stream emits parked annotations and keeps them pull-eligible until agent ack", async () => {
    ctx.pushRegistry = new SessionPushRegistry();
    const workspace = await workspaceIndex.upsertWorkspace(root, "glosa-open");
    const bus = busRegistry.get(root);
    await bus.createEntry("monitor-entry", actionableAnnotation("Parked for the monitor."));
    await sessionRegistry.register({
      session_id: "monitor-session",
      provider: "claude-code",
      cwd: root,
      workspace_binding: root,
      source: "monitor",
    });

    const response = await fetchFn(req("/api/sessions/monitor-session/stream"));
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let received = "";
    while (!received.includes("event: delivery")) {
      const chunk = await reader.read();
      expect(chunk.done).toBe(false);
      received += decoder.decode(chunk.value);
    }
    expect(received).toContain('"id":"monitor-entry"');

    const prematurePresented = await fetchFn(
      req("/api/sessions/monitor-session/stream/monitor-entry/ack", {
        method: "POST",
        body: JSON.stringify({ outcome: "presented" }),
      }),
    );
    expect(prematurePresented.status).toBe(409);

    const transportAck = await fetchFn(
      req("/api/sessions/monitor-session/stream/monitor-entry/transport-ack", { method: "POST", body: "{}" }),
    );
    expect(transportAck.status).toBe(200);
    await Bun.sleep(0);
    const attempts = bus.state.entries["monitor-entry"]?.deliveryAttempts as Array<Record<string, unknown>>;
    expect(attempts.at(-1)).toMatchObject({
      via: "monitor",
      outcome: "transport_accepted",
      session: "monitor-session",
    });

    const stillEligible = await bus.previewDelivery(1, { session: "monitor-session" }, () => null);
    expect(stillEligible.entries.map((entry) => entry.id)).toEqual(["monitor-entry"]);

    const presented = await fetchFn(
      req("/api/sessions/monitor-session/stream/monitor-entry/ack", {
        method: "POST",
        body: JSON.stringify({ outcome: "presented" }),
      }),
    );
    expect(presented.status).toBe(200);
    const afterAck = await bus.previewDelivery(1, { session: "monitor-session" }, () => null);
    expect(afterAck.entries).toHaveLength(0);
    await reader.cancel();
    expect(workspace.canonical_path).toBe(root);
  });

  test("Codex stream requires the exact bound session and journals codex_app_server acceptance", async () => {
    ctx.pushRegistry = new SessionPushRegistry();
    await workspaceIndex.upsertWorkspace(root, "glosa-open");
    const bus = busRegistry.get(root);
    await sessionRegistry.register({
      session_id: "codex-bound",
      provider: "codex",
      cwd: root,
      workspace_binding: root,
      source: "codex-app-server",
    });
    await sessionRegistry.register({
      session_id: "codex-unbound",
      provider: "codex",
      cwd: root,
      source: "mcp",
    });

    const unbound = await fetchFn(req("/api/sessions/codex-unbound/stream?transport=codex_app_server"));
    expect(unbound.status).toBe(409);

    const response = await fetchFn(req("/api/sessions/codex-bound/stream?transport=codex_app_server"));
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let received = "";
    const createdAt = Date.now();
    await bus.createEntry("codex-entry", actionableAnnotation("Reach only the bound Codex thread."));
    while (!received.includes('"id":"codex-entry"')) {
      const chunk = await reader.read();
      expect(chunk.done).toBe(false);
      received += decoder.decode(chunk.value);
    }
    expect(Date.now() - createdAt).toBeLessThan(1_000);
    const accepted = await fetchFn(
      req("/api/sessions/codex-bound/stream/codex-entry/transport-ack", { method: "POST", body: "{}" }),
    );
    expect(accepted.status).toBe(200);
    const acceptedAttempts = bus.state.entries["codex-entry"]?.deliveryAttempts as Array<Record<string, unknown>>;
    expect(acceptedAttempts.at(-1)).toMatchObject({
      via: "codex_app_server",
      outcome: "transport_accepted",
      session: "codex-bound",
    });
    const presented = await fetchFn(
      req("/api/sessions/codex-bound/stream/codex-entry/ack", {
        method: "POST",
        body: JSON.stringify({ outcome: "presented" }),
      }),
    );
    expect(presented.status).toBe(200);
    const presentedAttempts = bus.state.entries["codex-entry"]?.deliveryAttempts as Array<Record<string, unknown>>;
    expect(presentedAttempts.at(-1)).toMatchObject({
      via: "codex_app_server",
      outcome: "presented",
    });

    await bus.createEntry("codex-message", {
      kind: "conversation_message",
      text: "Composer text reaches Codex as user input.",
      target_session_id: "codex-bound",
      provider: "codex",
    });
    while (!received.includes('"id":"codex-message"')) {
      const chunk = await reader.read();
      expect(chunk.done).toBe(false);
      received += decoder.decode(chunk.value);
    }
    expect(received).toContain('"kind":"conversation_message"');
    expect(received).toContain('"target_session_id":"codex-bound"');
    const messageAccepted = await fetchFn(
      req("/api/sessions/codex-bound/stream/codex-message/transport-ack", { method: "POST", body: "{}" }),
    );
    expect(messageAccepted.status).toBe(200);
    await reader.cancel();
  });

  test("POST /api/sessions/:id/heartbeat extends the lease for a known session", async () => {
    await sessionRegistry.register({ session_id: "sess-1", provider: "claude-code", cwd: root, source: "startup" });
    const res = await fetchFn(req("/api/sessions/sess-1/heartbeat", { method: "POST" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("POST /api/sessions/:id/heartbeat for an unknown session is a typed 404", async () => {
    const res = await fetchFn(req("/api/sessions/unknown-session/heartbeat", { method: "POST" }));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      type: "https://glosa.local/errors/session-not-registered",
      title: "session not registered — re-register by calling any glosa tool",
    });
  });

  test("POST /api/sessions/:id/deregister removes the session from the live registry", async () => {
    await sessionRegistry.register({ session_id: "sess-1", provider: "claude-code", cwd: root, source: "startup" });
    const res = await fetchFn(req("/api/sessions/sess-1/deregister", { method: "POST" }));
    expect(res.status).toBe(200);
    expect(sessionRegistry.get("sess-1")).toBeNull();
  });

  describe("POST /api/sessions/:id/drain", () => {
    test("SPA annotation producer reaches Claude/Codex MCP pull as actionable content", async () => {
      writeFileSync(join(root, "notes.md"), "Grace upon grace.\n");
      await sessionRegistry.register({
        session_id: "sess-claude",
        provider: "claude-code",
        cwd: root,
        source: "startup",
      });
      const slug = workspaceIndex.list({ presentOnly: true })[0]!.slug;
      const created = await fetchFn(
        req(`/w/${slug}/annotations`, {
          method: "POST",
          body: JSON.stringify({
            artifact_path: "notes.md",
            body: "Explain how this connects to the next paragraph.",
            intent: "content",
            target: { quote: { exact: "Grace upon grace." }, position: { start: 0, end: 17 } },
          }),
        }),
      );
      expect(created.status).toBe(201);
      const prepared = await (
        await fetchFn(
          req("/api/sessions/sess-claude/drain", { method: "POST", body: JSON.stringify({ via: "mcp_pull" }) }),
        )
      ).json();
      expect(prepared.drained[0].text).toContain("artifact: notes.md");
      expect(prepared.drained[0].text).toContain("Explain how this connects");
      expect(prepared.drained[0].text).toContain('"exact":"Grace upon grace."');
    });

    test("SPA edit producer reaches the Codex MCP pull as bounded checkpoint hunks", async () => {
      writeFileSync(join(root, "notes.md"), "Before\n");
      await sessionRegistry.register({ session_id: "sess-codex", provider: "codex", cwd: root, source: "startup" });
      const slug = workspaceIndex.list({ presentOnly: true })[0]!.slug;
      const saved = await fetchFn(req(`/w/${slug}/artifacts/notes.md`, { method: "PUT", body: "After\n" }));
      expect(saved.status).toBe(200);
      expect((await saved.json()).inbox_id).toBeString();
      const prepared = await (
        await fetchFn(
          req("/api/sessions/sess-codex/drain", { method: "POST", body: JSON.stringify({ via: "mcp_pull" }) }),
        )
      ).json();
      expect(prepared.drained[0].kind).toBe("human_edit");
      expect(prepared.drained[0].text).toContain("checkpoints:");
      expect(prepared.drained[0].text).toContain("-Before");
      expect(prepared.drained[0].text).toContain("+After");
      expect(prepared.drained[0].detail.artifact_body).toBeUndefined();
    });

    test("drains pending entries for the session's workspace, records A5 §F23-conformant delivery_attempts, bounded to 8", async () => {
      await sessionRegistry.register({ session_id: "sess-1", provider: "claude-code", cwd: root, source: "startup" });
      const bus = busRegistry.get(root);
      for (let i = 0; i < 10; i++) await bus.createEntry(`e${i}`, actionableAnnotation(`Comment ${i}`));

      const res = await fetchFn(req("/api/sessions/sess-1/drain", { method: "POST", body: "" }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.count).toBe(8); // DRAIN_MAX
      expect(body.drained).toHaveLength(8);

      // Preparing content does not claim it was shown. The output owner acknowledges only after
      // its stdout/MCP response write succeeds.
      for (const item of body.drained) expect(bus.state.entries[item.id]?.deliveryAttempts).toHaveLength(0);
      expect((await ack("sess-1", body.delivery_id)).status).toBe(200);

      for (const item of body.drained) {
        const attempts = bus.state.entries[item.id]?.deliveryAttempts as
          | { via?: string; outcome?: string; reason?: string }[]
          | undefined;
        // `via` is always "mcp_pull" — the drain route only ever surfaces an MCP pull (#152);
        // `outcome:"presented"` because the acknowledged pull response IS what surfaced it.
        expect(attempts?.[0]).toMatchObject({ via: "mcp_pull", outcome: "presented", reason: "initial" });
        // A5 §F23 — status untouched by a delivery_attempt.
        expect(bus.state.entries[item.id]?.status).toBe("pending");
      }
    });

    test("a caller-supplied via other than mcp_pull is refused — the removed hook transports never re-enter the journal (#152)", async () => {
      await sessionRegistry.register({ session_id: "sess-1", provider: "claude-code", cwd: root, source: "startup" });
      const bus = busRegistry.get(root);
      await bus.createEntry("e1", actionableAnnotation());

      for (const via of ["stop", "gate", "userprompt", "asyncRewake", "channel"]) {
        const res = await fetchFn(req("/api/sessions/sess-1/drain", { method: "POST", body: JSON.stringify({ via }) }));
        expect(res.status).toBe(400);
      }
      expect(bus.state.entries.e1?.deliveryAttempts).toHaveLength(0);

      const prepared = await (
        await fetchFn(req("/api/sessions/sess-1/drain", { method: "POST", body: JSON.stringify({ via: "mcp_pull" }) }))
      ).json();
      await ack("sess-1", prepared.delivery_id);
      const attempts = bus.state.entries.e1?.deliveryAttempts as { via?: string }[] | undefined;
      expect(attempts?.[0]?.via).toBe("mcp_pull");
    });

    test("a second drain call does NOT re-return already-attempted entries", async () => {
      await sessionRegistry.register({ session_id: "sess-1", provider: "claude-code", cwd: root, source: "startup" });
      const bus = busRegistry.get(root);
      await bus.createEntry("e1", actionableAnnotation());

      const first = await (await fetchFn(req("/api/sessions/sess-1/drain", { method: "POST", body: "" }))).json();
      expect(first.count).toBe(1);
      const second = await (await fetchFn(req("/api/sessions/sess-1/drain", { method: "POST", body: "" }))).json();
      expect(second.count).toBe(0);
      await ack("sess-1", first.delivery_id);
    });

    test("an already-terminal entry is never drained", async () => {
      await sessionRegistry.register({ session_id: "sess-1", provider: "claude-code", cwd: root, source: "startup" });
      const bus = busRegistry.get(root);
      await bus.createEntry("e1", actionableAnnotation());
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
      await bus.createEntry("e1", actionableAnnotation());
      // Simulate a provider's own failed rung attempt (e.g. ClaudeCodeProvider.deliver()'s
      // monitor rung throwing) recorded BEFORE this entry ever reaches the drain route.
      await bus.recordDeliveryAttempt("e1", {
        via: "monitor",
        session: "sess-1",
        outcome: "failed",
        reason: "initial",
        error: "ECONNRESET",
      });

      const body = await (await fetchFn(req("/api/sessions/sess-1/drain", { method: "POST", body: "" }))).json();
      expect(body.count).toBe(1);
      expect(body.drained[0].id).toBe("e1");

      expect(bus.state.entries.e1?.deliveryAttempts).toHaveLength(1);
      await ack("sess-1", body.delivery_id);

      const attempts = bus.state.entries.e1?.deliveryAttempts as
        | { via?: string; outcome?: string; reason?: string }[]
        | undefined;
      expect(attempts).toHaveLength(2);
      expect(attempts?.[0]).toMatchObject({ outcome: "failed", reason: "initial" });
      expect(attempts?.[1]).toMatchObject({ outcome: "presented", reason: "re_nudge" });
    });

    test("transport_accepted remains drainable until an MCP pull output is acknowledged presented", async () => {
      await sessionRegistry.register({ session_id: "sess-1", provider: "claude-code", cwd: root, source: "startup" });
      const bus = busRegistry.get(root);
      await bus.createEntry("e1", actionableAnnotation());
      await bus.recordDeliveryAttempt("e1", {
        via: "monitor",
        session: "sess-1",
        outcome: "transport_accepted",
        reason: "initial",
      });

      const body = await (await fetchFn(req("/api/sessions/sess-1/drain", { method: "POST", body: "" }))).json();
      expect(body.count).toBe(1);
      await ack("sess-1", body.delivery_id);
      expect(bus.state.entries.e1?.deliveryAttempts).toEqual([
        expect.objectContaining({ outcome: "transport_accepted", reason: "initial" }),
        expect.objectContaining({ outcome: "presented", reason: "re_nudge" }),
      ]);
    });

    test("two concurrent drain calls on the same workspace never double-select the same entry (P4.3 concurrency review fix #7a)", async () => {
      await sessionRegistry.register({ session_id: "sess-1", provider: "claude-code", cwd: root, source: "startup" });
      const bus = busRegistry.get(root);
      for (let i = 0; i < 4; i++) await bus.createEntry(`e${i}`, actionableAnnotation(`Comment ${i}`));

      const [bodyA, bodyB] = await Promise.all([
        fetchFn(req("/api/sessions/sess-1/drain", { method: "POST", body: JSON.stringify({ limit: 4 }) })).then((r) =>
          r.json(),
        ),
        fetchFn(req("/api/sessions/sess-1/drain", { method: "POST", body: JSON.stringify({ limit: 4 }) })).then((r) =>
          r.json(),
        ),
      ]);

      const idsA = bodyA.drained.map((e: { id: string }) => e.id);
      const idsB = bodyB.drained.map((e: { id: string }) => e.id);
      const overlap = idsA.filter((id: string) => idsB.includes(id));
      expect(overlap).toHaveLength(0); // no entry selected by both calls
      expect(idsA.length + idsB.length).toBe(4); // together they cover everything, exactly once each

      if (bodyA.delivery_id) await ack("sess-1", bodyA.delivery_id);
      if (bodyB.delivery_id) await ack("sess-1", bodyB.delivery_id);

      // Every entry has EXACTLY one delivery_attempt — never two from a double-select.
      for (let i = 0; i < 4; i++) {
        const attempts = bus.state.entries[`e${i}`]?.deliveryAttempts as unknown[] | undefined;
        expect(attempts).toHaveLength(1);
      }
    });

    test("respects a caller-supplied limit under the DRAIN_MAX cap", async () => {
      await sessionRegistry.register({ session_id: "sess-1", provider: "claude-code", cwd: root, source: "startup" });
      const bus = busRegistry.get(root);
      for (let i = 0; i < 5; i++) await bus.createEntry(`e${i}`, actionableAnnotation(`Comment ${i}`));

      const body = await (
        await fetchFn(req("/api/sessions/sess-1/drain", { method: "POST", body: JSON.stringify({ limit: 2 }) }))
      ).json();
      expect(body.count).toBe(2);
    });

    test("distinct glosa-open/session workspace entries and a resumed session drain without a daemon restart", async () => {
      const nested = join(root, "subdir");
      mkdirSync(nested);
      await workspaceIndex.upsertWorkspace(nested, "glosa-open");

      for (const source of ["startup", "resume"]) {
        const registration = await fetchFn(
          req("/api/sessions/register", {
            method: "POST",
            body: JSON.stringify({ session_id: "sess-resumed", provider: "claude-code", cwd: root, source }),
          }),
        );
        expect(registration.status).toBe(200);

        const drain = await fetchFn(
          req("/api/sessions/sess-resumed/drain", {
            method: "POST",
            body: JSON.stringify({ via: "mcp_pull" }),
          }),
        );
        expect(drain.status).toBe(200);
        expect(await drain.json()).toMatchObject({ count: 0, drained: [] });
      }

      const entries = workspaceIndex
        .list({ presentOnly: true })
        .map(({ canonical_path, source }) => ({ canonical_path, source }));
      expect(entries).toHaveLength(2);
      expect(entries).toContainEqual({ canonical_path: root, source: "session" });
      expect(entries).toContainEqual({ canonical_path: nested, source: "glosa-open" });
      expect(sessionRegistry.get("sess-resumed")?.source).toBe("resume");
    });

    test("a registered-session bus failure returns a safe 500 and logs request context, message, and stack", async () => {
      await sessionRegistry.register({ session_id: "sess-1", provider: "claude-code", cwd: root, source: "startup" });
      const failure = new Error("forced bus resolution failure");
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      ctx.getWorkspaceBus = () => {
        throw failure;
      };

      try {
        const res = await fetchFn(
          req("/api/sessions/sess-1/drain?private=query-secret", {
            method: "POST",
            body: JSON.stringify({ via: "mcp_pull", private: "body-secret" }),
          }),
        );

        expect(res.status).toBe(500);
        expect(res.headers.get("Content-Type")).toBe("application/problem+json");
        expect(await res.json()).toEqual({
          type: "https://glosa.local/errors/internal",
          title: "internal error",
          status: 500,
        });

        expect(errorSpy).toHaveBeenCalledTimes(1);
        const logged = errorSpy.mock.calls.flat().join("\n");
        expect(logged).toContain("POST /api/sessions/sess-1/drain");
        expect(logged).toContain(failure.message);
        expect(logged).toContain(failure.stack as string);
        expect(logged).not.toContain("query-secret");
        expect(logged).not.toContain("body-secret");
        expect(logged).not.toContain(TOKEN);
      } finally {
        errorSpy.mockRestore();
      }
    });

    // #38 (github): the reported production failure — a registered session's drain hit a real
    // (not forced-via-stub) bus failure, specifically offline catch-up's shadow-git bootstrap, and
    // came back as an unhandled 500 with no recovery short of a daemon restart. Delivery itself
    // never touches git — it must succeed even when shadow-git can't be bootstrapped.
    test("a broken shadow-git bootstrap does not fail a registered session's drain", async () => {
      writeFileSync(join(root, "notes.md"), "hello");
      const busDir = join(root, ".glosa");
      mkdirSync(busDir, { recursive: true });
      writeFileSync(join(busDir, "shadow.git"), "not a directory"); // blocks initShadowRepo's mkdirSync

      await sessionRegistry.register({
        session_id: "sess-shadow-broken",
        provider: "claude-code",
        cwd: root,
        source: "startup",
      });
      const res = await fetchFn(
        req("/api/sessions/sess-shadow-broken/drain", { method: "POST", body: JSON.stringify({ via: "mcp_pull" }) }),
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ count: 0, drained: [] });
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

  describe("GET /w/:slug/watch (#153 Part 2)", () => {
    test("criterion 4 — coexists with the monitor: opening or ending a watch neither closes a live session stream nor releases its lease", async () => {
      ctx.pushRegistry = new SessionPushRegistry();
      const workspace = await workspaceIndex.upsertWorkspace(root, "session");
      await sessionRegistry.register({
        session_id: "sess-coexist",
        provider: "claude-code",
        cwd: root,
        workspace_binding: root,
        source: "monitor",
      });

      const stream = await fetchFn(req("/api/sessions/sess-coexist/stream?transport=monitor"));
      expect(stream.status).toBe(200);
      const reader = stream.body!.getReader();
      await reader.read(); // the ": connected" comment
      expect(ctx.pushRegistry.has("sess-coexist")).toBe(true);

      const controller = new AbortController();
      const watch = fetchFn(
        req(`/w/${workspace.slug}/watch?session=sess-coexist&wait_ms=5000`, { signal: controller.signal }),
      );
      await Bun.sleep(20);
      // The watch is holding, but the monitor stream is untouched by it.
      expect(ctx.pushRegistry.has("sess-coexist")).toBe(true);

      controller.abort();
      const watchResult = await watch;
      expect(watchResult.status).toBe(200);
      // Ending the watch does not end the stream.
      expect(ctx.pushRegistry.has("sess-coexist")).toBe(true);
      await reader.cancel();
    });

    test("W3 — a rebind mid-hold ends the watch rather than serving (or later appending against) a workspace the session has left", async () => {
      const workspace = await workspaceIndex.upsertWorkspace(root, "session");
      await sessionRegistry.bind("sess-rebind", root);
      const other = canonicalize(mkdtempSync(join(tmpdir(), "glosa-sessions-ws-other-")));

      const started = Date.now();
      const watch = fetchFn(req(`/w/${workspace.slug}/watch?session=sess-rebind&wait_ms=30000`));
      await Bun.sleep(20);
      await sessionRegistry.bind("sess-rebind", other);

      const res = await watch;
      expect(res.status).toBe(200);
      expect(Date.now() - started).toBeLessThan(5_000);
      rmSync(other, { recursive: true, force: true });
    });

    test("W3 — a deregister mid-hold ends the watch", async () => {
      const workspace = await workspaceIndex.upsertWorkspace(root, "session");
      await sessionRegistry.bind("sess-deregister", root);

      const started = Date.now();
      const watch = fetchFn(req(`/w/${workspace.slug}/watch?session=sess-deregister&wait_ms=30000`));
      await Bun.sleep(20);
      await sessionRegistry.deregister("sess-deregister");

      const res = await watch;
      expect(res.status).toBe(200);
      expect(Date.now() - started).toBeLessThan(5_000);
    });

    test("W3 — a workspace eviction/close mid-hold ends the watch", async () => {
      const workspace = await workspaceIndex.upsertWorkspace(root, "session");
      await sessionRegistry.bind("sess-evict", root);

      const started = Date.now();
      const watch = fetchFn(req(`/w/${workspace.slug}/watch?session=sess-evict&wait_ms=30000`));
      await Bun.sleep(20);
      await busRegistry.evict(root);

      const res = await watch;
      expect(res.status).toBe(200);
      expect(Date.now() - started).toBeLessThan(5_000);
    });

    test("W3 — two concurrent watches by the same session both keep their lease; neither cancels the other's hold", async () => {
      writeFileSync(join(root, "draft.md"), "one\n");
      const workspace = await workspaceIndex.upsertWorkspace(root, "session");
      const bus = busRegistry.get(root);
      // `reconcileOnce`, not the bare `reconcile`: it flags this instance as already reconciled, so
      // the watch route's own `resolveBus -> reconcileOnce()` call is a same-tick no-op instead of a
      // second, concurrently-queued reconcile pass whose offline-catchup step could race the write
      // below and commit it first — a test-harness race, not a product one (confirmed by a direct
      // repro before this fix).
      await bus.reconcileOnce();
      await sessionRegistry.bind("sess-dual", root);

      const watchA = fetchFn(req(`/w/${workspace.slug}/watch?session=sess-dual&path=draft.md&wait_ms=10000`));
      await Bun.sleep(20);
      const watchB = fetchFn(req(`/w/${workspace.slug}/watch?session=sess-dual&path=draft.md&wait_ms=10000`));
      await Bun.sleep(20);

      writeFileSync(join(root, "draft.md"), "one\ntwo\n");
      const captured = await bus.captureExternalEdit();
      expect(captured.entries).toHaveLength(1);

      const [resA, resB] = await Promise.all([watchA, watchB]);
      expect(resA.status).toBe(200);
      expect(resB.status).toBe(200);
      const bodyA = await resA.json();
      const bodyB = await resB.json();
      // Neither request's admission cancelled the other's hold — BOTH independently woke on the
      // same capture rather than one returning an empty answer because its lease was displaced.
      expect(bodyA.entries).toHaveLength(1);
      expect(bodyB.entries).toHaveLength(1);
      expect(bodyA.entries[0].id).toBe(captured.entries[0]);
      expect(bodyB.entries[0].id).toBe(captured.entries[0]);
    });

    test("validation: unknown session, unbound session, foreign (bound elsewhere) session, and a bad wait_ms are all refused", async () => {
      const workspace = await workspaceIndex.upsertWorkspace(root, "session");
      const unknown = await fetchFn(req(`/w/${workspace.slug}/watch?session=nobody`));
      expect(unknown.status).toBe(404);

      await sessionRegistry.register({ session_id: "sess-unbound", provider: "mcp", cwd: root, source: "mcp" });
      const unbound = await fetchFn(req(`/w/${workspace.slug}/watch?session=sess-unbound`));
      expect(unbound.status).toBe(409);

      const other = canonicalize(mkdtempSync(join(tmpdir(), "glosa-sessions-ws-foreign-")));
      await sessionRegistry.bind("sess-foreign", other);
      const foreign = await fetchFn(req(`/w/${workspace.slug}/watch?session=sess-foreign`));
      expect(foreign.status).toBe(409);
      rmSync(other, { recursive: true, force: true });

      await sessionRegistry.bind("sess-badwait", root);
      const badWait = await fetchFn(req(`/w/${workspace.slug}/watch?session=sess-badwait&wait_ms=abc`));
      expect(badWait.status).toBe(400);
      const tooLong = await fetchFn(req(`/w/${workspace.slug}/watch?session=sess-badwait&wait_ms=99999999`));
      expect(tooLong.status).toBe(400);
    });

    test("client disconnect ends the hold and releases the subscription and lease hold", async () => {
      const workspace = await workspaceIndex.upsertWorkspace(root, "session");
      const bus = busRegistry.get(root);
      await bus.reconcileOnce();
      await sessionRegistry.bind("sess-disconnect", root);

      const controller = new AbortController();
      const before = bus.listenerCount();
      const watch = fetchFn(
        req(`/w/${workspace.slug}/watch?session=sess-disconnect&wait_ms=30000`, { signal: controller.signal }),
      );
      await Bun.sleep(20);
      expect(bus.listenerCount()).toBe(before + 1);

      controller.abort();
      const res = await watch;
      expect(res.status).toBe(200);
      expect(bus.listenerCount()).toBe(before);
    });
  });
});

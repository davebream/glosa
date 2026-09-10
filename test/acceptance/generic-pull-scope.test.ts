// SPDX-License-Identifier: Apache-2.0
// Issue #205 — a generic `glosa_inbox_pull` collapses onto one shared synthetic MCP session id
// (`mcp.ts`'s `syntheticId`), and nothing prevented a second concurrent pull's registration from
// overwriting the first's `cwd` on that one mutable registry row before the first's own drain
// resolved its workspace scope — `handleCompositeSessionDrain`'s `sessionRoutesToWorkspace` re-reads
// the row LIVE, inside the drain, not once at route entry. Two concurrent pulls asking for distinct
// workspaces could therefore drain under each other's scope.
//
// Shape A (an in-shim lock holding registration across the handler) was proposed first and
// REJECTED by independent design review: the session id is published on the authenticated status
// route and accepted with no owner capability by register/bind/deregister, so any other bearer can
// move the row while a shim-local lane holds its pull — see contract.md's "Design outcome". Shape B
// ships instead: the generic pull sends its own scope on the drain request, captured once and used
// for the whole selection, immune to the row moving underneath it afterward.
//
// Real producer boundary throughout (glosa-checks.md): the real `createMcpServer` over an in-memory
// MCP transport (`packages/cli/test/mcp.test.ts`'s own pattern), and the real composite-drain route
// over a real `SessionRegistry`/`WorkspaceIndex`/`WorkspaceBusRegistry` via `createApiFetch` in temp
// dirs (`packages/daemon/test/composite-session-drain.test.ts`'s own pattern). Only a
// `DaemonHookClient` adapter and the ordering barrier below are test-owned glue — the existing
// `HookClient` fake in mcp.test.ts discards its session id on drain and cannot fail on this defect
// (A4; see that file's line-56 test, which this suite never touches).
import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  DaemonHookClient,
  DrainOptions,
  DrainResult,
  RegisterSessionInput,
  RegisterSessionResult,
  ScopedPullDrainOptions,
} from "../../packages/cli/src/daemon-client.ts";
import { createMcpServer, type McpDeps } from "../../packages/cli/src/mcp.ts";
import { WorkspaceBusRegistry } from "../../packages/daemon/src/bus/workspace-bus-registry.ts";
import { CompositeDeliveryRegistry } from "../../packages/daemon/src/delivery/composite-reservations.ts";
import { SessionRegistry } from "../../packages/daemon/src/registry/session-registry.ts";
import { canonicalize } from "../../packages/daemon/src/registry/slug.ts";
import { type WorkspaceEntry, WorkspaceIndex } from "../../packages/daemon/src/registry/workspace-index.ts";
import { CapabilityStore } from "../../packages/daemon/src/security/capability.ts";
import { type ApiContext, createApiFetch } from "../../packages/daemon/src/transport/http.ts";

const TOKEN = "generic-pull-scope-token-0123456789";
const PORT = 4646;

function annotation(body: string) {
  return {
    kind: "annotation",
    artifact_path: "notes.md",
    body,
    intent: "content",
    target: { quote: { exact: "sentence" }, position: { start: 0, end: 8 } },
  };
}

interface Fixture {
  /** A non-canonical spelling of `aRoot`: a symlink this fixture CREATES pointing at it. An agent
   * supplies whatever spelling it has, and the daemon must not assume a caller pre-canonicalises.
   * Built explicitly rather than relying on the ambient `/var` -> `/private/var` symlink macOS
   * happens to provide — the isolated check runtime's TMPDIR is already canonical, so an ambient
   * spelling makes this case pass or fail on the environment rather than on the code. */
  aRaw: string;
  home: string;
  aRoot: string;
  bRoot: string;
  a: WorkspaceEntry;
  b: WorkspaceEntry;
  workspaceIndex: WorkspaceIndex;
  sessionRegistry: SessionRegistry;
  busRegistry: WorkspaceBusRegistry;
  ctx: ApiContext;
  fetchFn: (req: Request) => Promise<Response>;
}

/** Two workspaces where neither is an ancestor of the other — independent siblings under `tmpdir`,
 * never one nested inside the other — each seeded with a uniquely identifiable entry, so a response
 * is attributed by the entry it actually carries rather than by counting entries (A1). `now`, when
 * given, becomes the registry's own clock — needed only by the A10 lease-expiry case, which must
 * advance time past `lease_expiry` deterministically rather than sleeping (`L-issue-184-learning-3`
 * is about a different log-capture rule, but the same "no real waiting" discipline applies here). */
async function buildFixture(now?: () => Date): Promise<Fixture> {
  const home = mkdtempSync(join(tmpdir(), "glosa-205-home-"));
  const aRoot = canonicalize(mkdtempSync(join(tmpdir(), "glosa-205-a-")));
  const bRoot = canonicalize(mkdtempSync(join(tmpdir(), "glosa-205-b-")));
  // A second, non-canonical name for aRoot. `canonicalize(aRawSpelling) === aRoot`, but the two
  // strings differ, which is all a routing comparison sees.
  const aRawSpelling = join(home, "a-by-symlink");
  symlinkSync(aRoot, aRawSpelling, "dir");
  const workspaceIndex = new WorkspaceIndex({ home });
  const sessionRegistry = new SessionRegistry({ index: workspaceIndex, ...(now ? { now } : {}) });
  const busRegistry = new WorkspaceBusRegistry();
  workspaceIndex.setLiveSessionPredicate((path) => sessionRegistry.forWorkspace(path).length > 0);
  const ctx: ApiContext = {
    port: PORT,
    classFPort: PORT + 1,
    token: TOKEN,
    instanceId: "gl-205-test",
    startedAt: new Date().toISOString(),
    workspaceIndex,
    sessionRegistry,
    getWorkspaceBus: (workspace) => busRegistry.get(workspace),
    capabilityStore: new CapabilityStore(),
  };
  const fetchFn = createApiFetch(ctx);
  const a = await workspaceIndex.upsertWorkspace(aRoot, "glosa-open");
  const b = await workspaceIndex.upsertWorkspace(bRoot, "glosa-open");
  await busRegistry.get(a).createEntry("a-entry", annotation("workspace A"));
  await busRegistry.get(b).createEntry("b-entry", annotation("workspace B"));
  return { home, aRaw: aRawSpelling, aRoot, bRoot, a, b, workspaceIndex, sessionRegistry, busRegistry, ctx, fetchFn };
}

async function teardownFixture(fx: Fixture): Promise<void> {
  await fx.busRegistry.closeAll();
  rmSync(fx.home, { recursive: true, force: true });
  rmSync(fx.aRoot, { recursive: true, force: true });
  rmSync(fx.bRoot, { recursive: true, force: true });
}

/** The one raw-route call site every fake `DaemonHookClient` below shares — real HTTP-route code
 * (`createApiFetch`), never a stand-in that discards its session id or scope (A4). */
async function callRoute(fx: Fixture, path: string, body?: unknown): Promise<Response> {
  const headers = new Headers();
  headers.set("Host", `127.0.0.1:${PORT}`);
  headers.set("Authorization", `Bearer ${TOKEN}`);
  headers.set("Origin", `http://127.0.0.1:${PORT}`);
  const res = await fx.fetchFn(
    new Request(`http://127.0.0.1:${PORT}${path}`, {
      method: "POST",
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  );
  if (!res.ok) throw new Error(`${path} failed: ${res.status} ${await res.text()}`);
  return res;
}

function structured(result: CallToolResult): Record<string, unknown> {
  expect(result.structuredContent).toBeDefined();
  return result.structuredContent!;
}

interface Overlap {
  events: string[];
  resultA: CallToolResult;
  resultB: CallToolResult;
}

/**
 * Drives two genuinely concurrent `glosa_inbox_pull` calls through the real `createMcpServer`,
 * sharing the one synthetic session id every generic pull on a shim process shares. Neither
 * `client.callTool` call is awaited before the other is issued (A2's "issued before either
 * completes"), and the recorded `events` order is produced by real completions, not by hoping the
 * scheduler cooperates:
 *
 *   - `register(A)`/`register(B)` are pushed only once that call's own real
 *     `POST /api/sessions/register` has resolved.
 *   - `drainScoped` for workspace A explicitly awaits `register(B)`'s completion before proceeding
 *     — this is the exact seam `understand.md` traces: call A's own `ensureSession` releases its
 *     per-session serialization (and so starts A's handler) BEFORE call B's chained registration
 *     — which was merely queued behind it on the same session id — actually runs. Without this
 *     gate the interleaving is only probabilistic; with it, `drain(A)` cannot be recorded before
 *     `register(B)`, and if `register(B)` somehow never happened, this call hangs and the test
 *     times out rather than passing vacuously (the A2 falsifier).
 *   - `drainScoped` for workspace B has no gate at all: its position relative to `drain(A)` is
 *     deliberately left free, since B's own ordering is not what A2 asserts.
 */
async function driveOverlappingPulls(fx: Fixture): Promise<Overlap> {
  const events: string[] = [];
  let resolveBRegistered!: () => void;
  const bRegistered = new Promise<void>((resolve) => {
    resolveBRegistered = resolve;
  });

  const client: DaemonHookClient = {
    async register(input: RegisterSessionInput): Promise<RegisterSessionResult> {
      const res = await callRoute(fx, "/api/sessions/register", input);
      const result = (await res.json()) as RegisterSessionResult;
      if (input.cwd === fx.aRoot) {
        events.push("register(A)");
      } else if (input.cwd === fx.bRoot) {
        events.push("register(B)");
        resolveBRegistered();
      }
      return result;
    },
    async heartbeat(sessionId: string): Promise<void> {
      await callRoute(fx, `/api/sessions/${encodeURIComponent(sessionId)}/heartbeat`);
    },
    async deregister(sessionId: string): Promise<void> {
      await callRoute(fx, `/api/sessions/${encodeURIComponent(sessionId)}/deregister`);
    },
    async drain(sessionId: string, opts?: DrainOptions): Promise<DrainResult> {
      const res = await callRoute(fx, `/api/sessions/${encodeURIComponent(sessionId)}/drain`, opts ?? {});
      return res.json();
    },
    async drainScoped(sessionId: string, opts: ScopedPullDrainOptions): Promise<DrainResult> {
      if (opts.workspace === fx.aRoot) {
        await bRegistered;
        events.push("drain(A)");
      } else if (opts.workspace === fx.bRoot) {
        events.push("drain(B)");
      }
      const res = await callRoute(fx, `/api/sessions/${encodeURIComponent(sessionId)}/drain`, {
        via: "mcp_pull",
        limit: opts.limit,
        scope: opts.workspace,
      });
      return res.json();
    },
  };

  const deps: McpDeps = {
    createHookClient: async () => client,
    createApiClient: async () => ({}) as never,
    cwd: () => fx.aRoot,
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const runtime = createMcpServer(deps);
  await runtime.connect(serverTransport);
  const mcpClient = new Client({ name: "glosa-205-test", version: "1" }, { capabilities: {} });
  await mcpClient.connect(clientTransport);
  try {
    const callA = mcpClient.callTool({ name: "glosa_inbox_pull", arguments: { workspace: fx.aRoot } });
    const callB = mcpClient.callTool({ name: "glosa_inbox_pull", arguments: { workspace: fx.bRoot } });
    const [resultA, resultB] = await Promise.all([callA, callB]);
    return { events, resultA: resultA as CallToolResult, resultB: resultB as CallToolResult };
  } finally {
    await mcpClient.close();
    await runtime.close();
  }
}

describe("generic pull scope is immutable for the whole drain (issue #205)", () => {
  test("two overlapping pulls each drain the workspace they asked for", async () => {
    const fx = await buildFixture();
    try {
      const { resultA, resultB } = await driveOverlappingPulls(fx);
      const entriesA = structured(resultA).entries as Array<{ id: string; workspace?: string }>;
      const entriesB = structured(resultB).entries as Array<{ id: string; workspace?: string }>;
      // Assertions are on the entry ids and workspace labels the responses actually carried — never
      // on the request arguments, and never merely "both calls succeeded" (A1, A4).
      expect(entriesA.map((e) => e.id)).toEqual(["a-entry"]);
      expect(entriesA[0]?.workspace).toBe(fx.a.canonical_path);
      expect(entriesB.map((e) => e.id)).toEqual(["b-entry"]);
      expect(entriesB[0]?.workspace).toBe(fx.b.canonical_path);
    } finally {
      await teardownFixture(fx);
    }
  });

  test("the observed order was register(A), register(B), drain(A)", async () => {
    const fx = await buildFixture();
    try {
      const { events } = await driveOverlappingPulls(fx);
      const idxRegA = events.indexOf("register(A)");
      const idxRegB = events.indexOf("register(B)");
      const idxDrainA = events.indexOf("drain(A)");
      // Recorded, not assumed (A2): every index is real or -1, and the ordering below is asserted
      // on those real recordings — a scheduler that serialized the two calls before this seam would
      // either produce a different recorded order (a loud failure) or hang `drain(A)`'s explicit
      // wait on `register(B)` forever (a timeout), never a silent pass.
      expect(idxRegA).toBeGreaterThanOrEqual(0);
      expect(idxRegB).toBeGreaterThan(idxRegA);
      expect(idxDrainA).toBeGreaterThan(idxRegB);
    } finally {
      await teardownFixture(fx);
    }
  });

  test("a paused scoped drain is not redirected by a real re-register of the same session", async () => {
    const fx = await buildFixture();
    try {
      const sessionId = "s-paused-205";
      await callRoute(fx, "/api/sessions/register", {
        session_id: sessionId,
        provider: "mcp",
        cwd: fx.a.canonical_path,
        source: "mcp",
      });

      // Paused at the EARLIEST seam inside the route — before the composite mutex is even
      // acquired, so before `handleCompositeSessionDrain`'s own workspace-selection filter has run
      // at all. This is deliberately earlier than pausing inside `bus.previewDelivery`: a first
      // attempt at this case paused there and stayed green on the unablated-scope tree too, because
      // workspace selection had ALREADY run (and already used the captured scope) before that
      // later point — a green ablation that proves nothing (`L-issue-140-3`). Pausing before
      // `prepare()` proves the row move genuinely happens before ANY selection code executes, so a
      // version that re-read the row inside the closure would be caught here.
      const compositeRegistry = new CompositeDeliveryRegistry();
      const originalPrepare = compositeRegistry.prepare.bind(compositeRegistry);
      let resolvePaused!: () => void;
      const paused = new Promise<void>((resolve) => {
        resolvePaused = resolve;
      });
      let resolveResume!: () => void;
      const resumeGate = new Promise<void>((resolve) => {
        resolveResume = resolve;
      });
      const prepareSpy = spyOn(compositeRegistry, "prepare").mockImplementationOnce((async (
        operation: () => Promise<unknown>,
      ) => {
        resolvePaused();
        await resumeGate;
        return originalPrepare(operation);
      }) as typeof compositeRegistry.prepare);
      fx.ctx.compositeDeliveryRegistry = compositeRegistry;

      try {
        const drainPromise = callRoute(fx, `/api/sessions/${sessionId}/drain`, {
          via: "mcp_pull",
          scope: fx.a.canonical_path,
        }).then((res) => res.json());

        await paused;
        // The real mover this case exists to defeat (A3, the case shape A was rejected on): a
        // second, genuine `register` for the exact same session id, through the real route — not a
        // simulated race, an actual concurrent caller moving the row while the paused drain still
        // holds its own already-admitted scope.
        await callRoute(fx, "/api/sessions/register", {
          session_id: sessionId,
          provider: "mcp",
          cwd: fx.b.canonical_path,
          source: "mcp",
        });
        expect(fx.sessionRegistry.get(sessionId)?.cwd).toBe(fx.b.canonical_path);

        resolveResume();
        const body = (await drainPromise) as { drained: Array<{ id: string; workspace: string }> };
        expect(body.drained.map((e) => e.id)).toEqual(["a-entry"]);
        expect(body.drained.every((e) => e.workspace === fx.a.canonical_path)).toBe(true);
      } finally {
        prepareSpy.mockRestore();
      }
    } finally {
      await teardownFixture(fx);
    }
  });

  test("an unscoped drain still resolves scope from the session row", async () => {
    const fx = await buildFixture();
    try {
      const sessionId = "s-unscoped-205";
      await callRoute(fx, "/api/sessions/register", {
        session_id: sessionId,
        provider: "mcp",
        cwd: fx.a.canonical_path,
        source: "mcp",
      });
      // A genuine re-registration, the way any of the four hook transports (gate/stop/userprompt/
      // asyncRewake) would see it — this route accepts no scope from them, additive-optional field
      // (A6, contract item 5).
      await callRoute(fx, "/api/sessions/register", {
        session_id: sessionId,
        provider: "mcp",
        cwd: fx.b.canonical_path,
        source: "mcp",
      });
      const res = await callRoute(fx, `/api/sessions/${sessionId}/drain`, { via: "stop" });
      const body = (await res.json()) as { drained: Array<{ id: string; workspace: string }> };
      expect(body.drained.map((e) => e.id)).toEqual(["b-entry"]);
      expect(body.drained[0]?.workspace).toBe(fx.b.canonical_path);
    } finally {
      await teardownFixture(fx);
    }
  });

  test("a bound session ignores the workspace argument and is unaffected", async () => {
    const fx = await buildFixture();
    try {
      const calls: string[] = [];
      const client: DaemonHookClient = {
        async register(input: RegisterSessionInput) {
          return (await callRoute(fx, "/api/sessions/register", input)).json();
        },
        async heartbeat(sessionId: string) {
          await callRoute(fx, `/api/sessions/${encodeURIComponent(sessionId)}/heartbeat`);
        },
        async deregister(sessionId: string) {
          await callRoute(fx, `/api/sessions/${encodeURIComponent(sessionId)}/deregister`);
        },
        async drain(sessionId: string, opts?: DrainOptions) {
          calls.push("drain");
          return (await callRoute(fx, `/api/sessions/${encodeURIComponent(sessionId)}/drain`, opts ?? {})).json();
        },
        async drainScoped(sessionId: string, opts: ScopedPullDrainOptions) {
          calls.push("drainScoped");
          return (
            await callRoute(fx, `/api/sessions/${encodeURIComponent(sessionId)}/drain`, {
              via: "mcp_pull",
              limit: opts.limit,
              scope: opts.workspace,
            })
          ).json();
        },
      };
      const deps: McpDeps = {
        createHookClient: async () => client,
        createApiClient: async () => ({}) as never,
        session: () => ({ session_id: "host-205", provider: "mcp", cwd: fx.a.canonical_path }),
      };
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const runtime = createMcpServer(deps);
      await runtime.connect(serverTransport);
      const mcpClient = new Client({ name: "glosa-205-a5", version: "1" }, { capabilities: {} });
      await mcpClient.connect(clientTransport);
      try {
        // Asks for workspace B — the MCP host session's own bound identity governs `cwd` instead,
        // per `identity()`, and never reaches `drainScoped` at all.
        const result = (await mcpClient.callTool({
          name: "glosa_inbox_pull",
          arguments: { workspace: fx.b.canonical_path },
        })) as CallToolResult;
        const entries = structured(result).entries as Array<{ id: string; workspace?: string }>;
        expect(entries.map((e) => e.id)).toEqual(["a-entry"]);
        expect(entries[0]?.workspace).toBe(fx.a.canonical_path);
        expect(calls).toEqual(["drain"]);
      } finally {
        await mcpClient.close();
        await runtime.close();
      }
    } finally {
      await teardownFixture(fx);
    }
  });

  test("no shipping module builds the drain route outside the daemon client", () => {
    // Same claim shape as `packages/daemon/test/registry/import-guard.test.ts` (L-issue-146-3):
    // bounded to "no shipping module reaches around this by inattention", not "cannot by intent".
    // Real privacy is the compiler's: `call` (daemon-client.ts's raw path builder) is a function
    // local to `createHttpDaemonClient`'s closure, never a module-level export another file could
    // import. This scan is the fast, independently-failing check of the same fact, over source
    // text rather than `tsc` alone — it would catch a future reimplementation that skips the
    // client's typed `drain`/`drainScoped` methods and builds the literal route itself.
    const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
    const DAEMON_CLIENT_FILE = "packages/cli/src/daemon-client.ts";
    const HTTP_TRANSPORT_FILE = "packages/daemon/src/transport/http.ts";
    const DRAIN_ROUTE_SEGMENT = "/drain";

    function shippingSourceFiles(): string[] {
      const files: string[] = [];
      for (const entry of readdirSync(join(REPO_ROOT, "packages"), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const srcDir = join(REPO_ROOT, "packages", entry.name, "src");
        let names: string[];
        try {
          names = readdirSync(srcDir, { recursive: true }) as string[];
        } catch {
          continue;
        }
        for (const name of names) {
          if (!name.endsWith(".ts") && !name.endsWith(".tsx")) continue;
          files.push(join(srcDir, name));
        }
      }
      return files;
    }

    const offenders: string[] = [];
    for (const file of shippingSourceFiles()) {
      const relativePath = relative(REPO_ROOT, file).split(sep).join("/");
      if (relativePath === DAEMON_CLIENT_FILE || relativePath === HTTP_TRANSPORT_FILE) continue;
      if (readFileSync(file, "utf8").includes(DRAIN_ROUTE_SEGMENT)) offenders.push(relativePath);
    }
    expect(offenders).toEqual([]);
  });

  // Both cases below were found by probing the FIRST implementation of this fix, which took the
  // request's `scope` verbatim. Every routing comparison in the daemon (`isCwdAncestorOf`,
  // `workspace_binding === canonical_path`) is a literal string match against a canonical path,
  // and the fixture above has to call `canonicalize()` on its own temp dirs for exactly that
  // reason. A caller does not. See `contract.md` A9.
  test("a non-canonical spelling of the same workspace drains it and registers no duplicate workspace", async () => {
    const fx = await buildFixture();
    try {
      expect(fx.aRaw).not.toBe(fx.aRoot);
      await callRoute(fx, "/api/sessions/register", {
        session_id: "raw-spelling-session",
        provider: "mcp",
        cwd: fx.aRaw,
        source: "mcp",
      });
      const before = fx.workspaceIndex.list({}).map((entry) => entry.canonical_path);
      const drained = (await (
        await callRoute(fx, "/api/sessions/raw-spelling-session/drain", {
          via: "mcp_pull",
          limit: 8,
          scope: fx.aRaw,
        })
      ).json()) as { count: number; drained: Array<{ id: string }> };
      const after = fx.workspaceIndex.list({}).map((entry) => entry.canonical_path);

      // It must drain workspace A's own entry...
      expect(drained.drained.map((entry) => entry.id)).toEqual(["a-entry"]);
      expect(drained.count).toBe(1);
      // ...and it must not have reached that answer by durably registering a second index row for
      // a directory that already had one. The un-canonicalised version returned the right entry
      // and still grew the index by one, so asserting the entry alone cannot fail on this defect.
      expect(after).toEqual(before);
    } finally {
      await teardownFixture(fx);
    }
  });

  test("a scope that resolves to no directory is refused, not silently row-scoped", async () => {
    const fx = await buildFixture();
    try {
      await callRoute(fx, "/api/sessions/register", {
        session_id: "bad-scope-session",
        provider: "mcp",
        cwd: fx.aRoot,
        source: "mcp",
      });
      const headers = new Headers({ "Content-Type": "application/json" });
      headers.set("Host", `127.0.0.1:${PORT}`);
      headers.set("Authorization", `Bearer ${TOKEN}`);
      headers.set("Origin", `http://127.0.0.1:${PORT}`);
      const res = await fx.fetchFn(
        new Request(`http://127.0.0.1:${PORT}/api/sessions/bad-scope-session/drain`, {
          method: "POST",
          headers,
          body: JSON.stringify({ via: "mcp_pull", limit: 8, scope: join(fx.aRoot, "does-not-exist") }),
        }),
      );
      // Falling back to the row would hand this request exactly the behaviour it asked not to have.
      expect(res.status).toBe(400);
      expect(((await res.json()) as { title: string }).title).toContain("scope");
    } finally {
      await teardownFixture(fx);
    }
  });

  test("a scope naming an existing FILE is refused, and registers no workspace for it", async () => {
    const fx = await buildFixture();
    try {
      await callRoute(fx, "/api/sessions/register", {
        session_id: "file-scope-session",
        provider: "mcp",
        cwd: fx.aRoot,
        source: "mcp",
      });
      // `canonicalOrNull` is realpath-only, so a regular file canonicalises happily. Without the
      // directory check it reaches `getOrRegisterWorkspace` and is registered AS a workspace.
      const filePath = join(fx.aRoot, "not-a-directory.md");
      writeFileSync(filePath, "# not a workspace\n");
      const before = fx.workspaceIndex.list({}).map((entry) => entry.canonical_path);
      const headers = new Headers({ "Content-Type": "application/json" });
      headers.set("Host", `127.0.0.1:${PORT}`);
      headers.set("Authorization", `Bearer ${TOKEN}`);
      headers.set("Origin", `http://127.0.0.1:${PORT}`);
      const res = await fx.fetchFn(
        new Request(`http://127.0.0.1:${PORT}/api/sessions/file-scope-session/drain`, {
          method: "POST",
          headers,
          body: JSON.stringify({ via: "mcp_pull", limit: 8, scope: filePath }),
        }),
      );
      expect(res.status).toBe(400);
      expect(fx.workspaceIndex.list({}).map((entry) => entry.canonical_path)).toEqual(before);
    } finally {
      await teardownFixture(fx);
    }
  });

  test("a bound session's drain ignores scope entirely, including a malformed one", async () => {
    const fx = await buildFixture();
    try {
      // A1 §5.15 says a bound session's drain never reads `scope`. If validation ran ahead of the
      // bound branch, this request would 400 over a field the contract says is ignored.
      await callRoute(fx, "/api/sessions/register", {
        session_id: "bound-scope-session",
        provider: "mcp",
        cwd: fx.aRoot,
        source: "mcp",
        workspace_binding: fx.a.canonical_path,
      });
      const headers = new Headers({ "Content-Type": "application/json" });
      headers.set("Host", `127.0.0.1:${PORT}`);
      headers.set("Authorization", `Bearer ${TOKEN}`);
      headers.set("Origin", `http://127.0.0.1:${PORT}`);
      const res = await fx.fetchFn(
        new Request(`http://127.0.0.1:${PORT}/api/sessions/bound-scope-session/drain`, {
          method: "POST",
          headers,
          body: JSON.stringify({ via: "mcp_pull", limit: 8, scope: join(fx.aRoot, "does-not-exist") }),
        }),
      );
      expect(res.status).not.toBe(400);
      const drained = (await res.json()) as { drained: Array<{ id: string }> };
      expect(drained.drained.map((entry) => entry.id)).toEqual(["a-entry"]);
    } finally {
      await teardownFixture(fx);
    }
  });

  // A10: a second design pass, after an independent outcome review found that shape B's own
  // selection requires the requester's row to exist AND be alive — so a mutable row can no longer
  // REDIRECT an admitted drain (A3), but can still SUPPRESS it, by disappearing between admission
  // (record captured, scope validated) and selection. Settled against the normative text rather
  // than by taste: A5 §F23 says "no code path inside a scoped drain re-reads the row for its OWN
  // routing decision", and A1 §5.15 says the scope is "captured once at the request and used for
  // the whole drain" — an admitted drain completing on its captured scope is the only reading of
  // those two sentences consistent with each other once the row can vanish mid-drain.
  //
  // Paused at the SAME seam `a paused scoped drain is not redirected...` (A3) already uses:
  // `CompositeDeliveryRegistry.prepare`, entered after `handleSessionDrain` has captured `record`
  // and validated `scope`, before any selection code runs.
  function pauseAtCompositePrepare(fx: Fixture): { paused: Promise<void>; resume: () => void; restore: () => void } {
    const compositeRegistry = new CompositeDeliveryRegistry();
    const originalPrepare = compositeRegistry.prepare.bind(compositeRegistry);
    let resolvePaused!: () => void;
    const paused = new Promise<void>((resolve) => {
      resolvePaused = resolve;
    });
    let resolveResume!: () => void;
    const resumeGate = new Promise<void>((resolve) => {
      resolveResume = resolve;
    });
    const prepareSpy = spyOn(compositeRegistry, "prepare").mockImplementationOnce((async (
      operation: () => Promise<unknown>,
    ) => {
      resolvePaused();
      await resumeGate;
      return originalPrepare(operation);
    }) as typeof compositeRegistry.prepare);
    fx.ctx.compositeDeliveryRegistry = compositeRegistry;
    return { paused, resume: () => resolveResume(), restore: () => prepareSpy.mockRestore() };
  }

  for (const mode of ["deregistration", "lease expiry"] as const) {
    test(`an admitted scoped drain survives requester loss and acknowledges its captured transaction (${mode})`, async () => {
      // Only the lease-expiry mode needs a controllable clock; the registry's real clock is fine
      // for deregistration, and giving both modes the same fixture-building call keeps the two
      // cases from silently drifting apart in setup.
      let ms = Date.now();
      const fx = await buildFixture(mode === "lease expiry" ? () => new Date(ms) : undefined);
      try {
        const sessionId = "s-loss-205";
        await callRoute(fx, "/api/sessions/register", {
          session_id: sessionId,
          provider: "mcp",
          cwd: fx.a.canonical_path,
          source: "mcp",
        });
        expect(fx.sessionRegistry.liveness(sessionId)).toBe("alive");

        const { paused, resume, restore } = pauseAtCompositePrepare(fx);
        try {
          const drainPromise = callRoute(fx, `/api/sessions/${sessionId}/drain`, {
            via: "mcp_pull",
            scope: fx.a.canonical_path,
          }).then((res) => res.json());

          await paused;
          // The requester is now gone, one way or the other — AFTER admission (record captured,
          // scope validated) and BEFORE selection. This is exactly what A10 requires survive: the
          // in-flight drain's result must not change because of it.
          if (mode === "deregistration") {
            await callRoute(fx, `/api/sessions/${sessionId}/deregister`);
            expect(fx.sessionRegistry.get(sessionId)).toBeNull();
          } else {
            ms += 61_000; // past the default 60s lease TTL — an injected clock, never a real sleep
            expect(fx.sessionRegistry.liveness(sessionId)).toBe("stale");
          }

          resume();
          const body = (await drainPromise) as {
            delivery_id: string | null;
            drained: Array<{ id: string; workspace: string }>;
          };
          // 1. The captured workspace's entry drained.
          expect(body.drained.map((e) => e.id)).toEqual(["a-entry"]);
          expect(body.drained.every((e) => e.workspace === fx.a.canonical_path)).toBe(true);
          expect(body.delivery_id).toStartWith("cmp_");

          // 2. The composite acknowledgement succeeded — mechanism 2, moved ahead of the now-missing
          // (or now-stale) row requirement, and only for the composite-token branch.
          const ackRes = await callRoute(fx, `/api/sessions/${sessionId}/deliveries/${body.delivery_id}/ack`, {
            outcome: "presented",
          });
          expect(await ackRes.json()).toEqual({ acknowledged: true });

          // 3. Exactly one `presented` attempt landed in the journal for the captured transaction.
          const attempts = (fx.busRegistry.get(fx.a).state.entries["a-entry"]?.deliveryAttempts ?? []) as Array<{
            outcome?: string;
          }>;
          expect(attempts).toHaveLength(1);
          expect(attempts[0]?.outcome).toBe("presented");
        } finally {
          restore();
        }
      } finally {
        await teardownFixture(fx);
      }
    });
  }

  test("a present but malformed scope is refused, never treated as an omitted field", async () => {
    const fx = await buildFixture();
    try {
      await callRoute(fx, "/api/sessions/register", {
        session_id: "malformed-scope-session",
        provider: "mcp",
        cwd: fx.aRoot,
        source: "mcp",
      });
      const before = fx.workspaceIndex.list({}).map((entry) => entry.canonical_path);
      const headers = new Headers({ "Content-Type": "application/json" });
      headers.set("Host", `127.0.0.1:${PORT}`);
      headers.set("Authorization", `Bearer ${TOKEN}`);
      headers.set("Origin", `http://127.0.0.1:${PORT}`);
      // Each of these is PRESENT and unusable. Folding the type test into the body parse makes all
      // three indistinguishable from omission, so the request silently regains the row-derived
      // routing it explicitly asked not to have — A9, and A1 §5.15's "anything other than an
      // existing directory is refused".
      for (const malformed of ["", null, 42, { path: "/tmp" }, []]) {
        const res = await fx.fetchFn(
          new Request(`http://127.0.0.1:${PORT}/api/sessions/malformed-scope-session/drain`, {
            method: "POST",
            headers,
            body: JSON.stringify({ via: "mcp_pull", limit: 8, scope: malformed }),
          }),
        );
        expect(res.status, `scope: ${JSON.stringify(malformed)} must be refused, not ignored`).toBe(400);
      }
      // And none of them may have drained or registered anything on the way past.
      expect(fx.workspaceIndex.list({}).map((entry) => entry.canonical_path)).toEqual(before);
    } finally {
      await teardownFixture(fx);
    }
  });
});

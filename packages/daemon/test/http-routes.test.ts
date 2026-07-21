// SPDX-License-Identifier: Apache-2.0
// P3.1 — per-route schema + error-path coverage for the A1 §5 route catalog. Runs the real
// `createApiFetch` pipeline IN-PROCESS (no subprocess) against a hand-built `ApiContext` backed by
// real `WorkspaceIndex`/`SessionRegistry`/`WorkspaceBusRegistry` instances over real tmp
// workspaces — this is what lets these tests drive the shadow-git/journal internals directly
// (pre-registering a workspace, minting real checkpoints with known attributions) that a subprocess
// integration test has no way to reach. Pipeline-level / real-subprocess attack coverage
// (Host-rebinding, real HTTP transport) stays in http.test.ts; this file is route-schema-level.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiFetch, type ApiContext } from "../src/http.ts";
import { CapabilityStore } from "../src/capability.ts";
import { WorkspaceIndex } from "../src/registry/workspace-index.ts";
import { SessionRegistry } from "../src/registry/session-registry.ts";
import { WorkspaceBusRegistry } from "../src/bus/workspace-bus-registry.ts";
import { canonicalize } from "../src/registry/slug.ts";
import { journalPath } from "../src/bus/paths.ts";
import { checkpoint, headSha } from "../src/git/shadow.ts";
import { readFileSync } from "node:fs";

const TOKEN = "route-test-token-0123456789abcdef";
const PORT = 4646; // arbitrary — never actually bound, only compared against the Host header

describe("A1 §5 route catalog", () => {
  let home: string;
  let root: string;
  let workspaceIndex: WorkspaceIndex;
  let sessionRegistry: SessionRegistry;
  let busRegistry: WorkspaceBusRegistry;
  let ctx: ApiContext;
  let fetchFn: (req: Request) => Promise<Response>;
  let slug: string;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "glosa-routes-home-"));
    root = canonicalize(mkdtempSync(join(tmpdir(), "glosa-routes-ws-")));

    workspaceIndex = new WorkspaceIndex({ home });
    sessionRegistry = new SessionRegistry({ index: workspaceIndex });
    busRegistry = new WorkspaceBusRegistry();
    workspaceIndex.setLiveSessionPredicate((p) => sessionRegistry.forWorkspace(p).length > 0);
    workspaceIndex.setOnHardRemove((p) => busRegistry.evict(p));

    const entry = await workspaceIndex.upsertWorkspace(root, "glosa-open");
    slug = entry.slug;

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
    for (const r of [root]) await busRegistry.close(r);
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  function req(path: string, init: RequestInit = {}): Request {
    const headers = new Headers(init.headers);
    headers.set("Host", `127.0.0.1:${PORT}`);
    if (!headers.has("Authorization")) headers.set("Authorization", `Bearer ${TOKEN}`);
    return new Request(`http://127.0.0.1:${PORT}${path}`, { ...init, headers });
  }
  function stateChangingReq(path: string, init: RequestInit = {}): Request {
    return req(path, { ...init, headers: { ...init.headers, Origin: `http://127.0.0.1:${PORT}` } });
  }

  // --- GET /api/workspaces (5.2) ---

  test("GET /api/workspaces lists the registered, present workspace", async () => {
    const res = await fetchFn(req("/api/workspaces"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([{ slug, path: root, last_seen: expect.any(String), has_attention: false }]);
  });

  test("GET /api/workspaces omits a soft-deleted (present:false) workspace", async () => {
    rmSync(root, { recursive: true, force: true });
    await workspaceIndex.gc({ force: true });
    const res = await fetchFn(req("/api/workspaces"));
    expect(await res.json()).toEqual([]);
    // recreate for afterEach's cleanup + other tests in this block sharing `root`
    mkdirSync(root, { recursive: true });
  });

  // --- GET /w/:slug/artifacts (5.3) ---

  test("GET /w/:slug/artifacts lists tracked files with exact schema fields", async () => {
    writeFileSync(join(root, "notes.md"), "# hello\n");
    writeFileSync(join(root, "ignored.json"), "{}"); // not a tracked extension
    const res = await fetchFn(req(`/w/${slug}/artifacts`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0]).toEqual({
      path: "notes.md",
      class: "R",
      size_bytes: expect.any(Number),
      mtime: expect.any(String),
      source_sha256: expect.any(String),
      stale: false,
    });
  });

  test("GET /w/:slug/artifacts on an unknown slug → 404 not-found", async () => {
    const res = await fetchFn(req("/w/does-not-exist/artifacts"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.type).toContain("not-found");
  });

  test("class F (.html) artifact is classified F in the listing", async () => {
    writeFileSync(join(root, "page.html"), "<p>hi</p>");
    const res = await fetchFn(req(`/w/${slug}/artifacts`));
    const body = await res.json();
    expect(body[0].class).toBe("F");
  });

  // --- GET /w/:slug/artifacts/:path (5.4) ---

  test("GET artifact raw (no ?render) returns source_path/source_sha256/class/content, no rendered_html", async () => {
    writeFileSync(join(root, "notes.md"), "# Title\n\nBody text.\n");
    const res = await fetchFn(req(`/w/${slug}/artifacts/notes.md`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source_path).toBe("notes.md");
    expect(body.class).toBe("R");
    expect(body.content).toBe("# Title\n\nBody text.\n");
    expect(typeof body.source_sha256).toBe("string");
    expect(body.rendered_html).toBeUndefined();
  });

  test("GET artifact ?render=html includes rendered_html with data-line stamps", async () => {
    writeFileSync(join(root, "notes.md"), "# Title\n\nBody text.\n");
    const res = await fetchFn(req(`/w/${slug}/artifacts/notes.md?render=html`));
    const body = await res.json();
    expect(body.rendered_html).toContain("data-line");
    expect(body.rendered_html).toContain("<h1");
    // heading is the first line (0-based line 0)
    expect(body.rendered_html).toMatch(/<h1[^>]*data-line="0"/);
  });

  test("GET class-F artifact returns metadata only, never HTML content", async () => {
    writeFileSync(join(root, "page.html"), "<p>hi</p>");
    const res = await fetchFn(req(`/w/${slug}/artifacts/page.html`));
    const body = await res.json();
    // objectContaining, not toEqual: this pins the fields the route guarantees TODAY without
    // locking the shape as final — a future `manifest_path` addition (P6.1, A1 §5.4's own example
    // response includes it) must not fail this test.
    expect(body).toEqual(expect.objectContaining({ source_path: "page.html", source_sha256: expect.any(String), class: "F" }));
    expect(body.content).toBeUndefined();
  });

  test("GET artifact with a literal traversal path → 404 (the WHATWG URL parser collapses the .. segments before routing ever sees them — same class of outcome as the /app/../secret case in http.test.ts)", async () => {
    const res = await fetchFn(req(`/w/${slug}/artifacts/../../../etc/passwd`));
    expect(res.status).toBe(404);
  });

  test("GET artifact via a symlink pointing outside the workspace → 400 invalid-path (the real, HTTP-reachable escape confinePath's realpath check exists to catch — A3 §5 #4)", async () => {
    const outside = mkdtempSync(join(tmpdir(), "glosa-routes-outside-"));
    writeFileSync(join(outside, "secret.md"), "top secret\n");
    symlinkSync(join(outside, "secret.md"), join(root, "escape.md"));
    const res = await fetchFn(req(`/w/${slug}/artifacts/escape.md`));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.type).toContain("invalid-path");
    rmSync(outside, { recursive: true, force: true });
  });

  test("GET artifact that is within the workspace but not tracked → 404 not-found", async () => {
    writeFileSync(join(root, "untracked.json"), "{}");
    const res = await fetchFn(req(`/w/${slug}/artifacts/untracked.json`));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.type).toContain("not-found");
  });

  // --- PUT /w/:slug/artifacts/:path (P3.3 addition, NOT in A1 §5) ---

  test("PUT artifact writes the file, checkpoints it human-attributed, and the subsequent diff surfaces human (not session/unknown)", async () => {
    writeFileSync(join(root, "notes.md"), "# Title\n\nOriginal.\n");
    const bus = ctx.getWorkspaceBus(root);
    await bus.reconcile(); // establishes the baseline commit
    const before = await headSha(root);

    const res = await fetchFn(
      stateChangingReq(`/w/${slug}/artifacts/notes.md`, {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
        body: "# Title\n\nEdited via glosa.\n",
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source_path).toBe("notes.md");
    expect(body.class).toBe("R");
    expect(body.content).toBe("# Title\n\nEdited via glosa.\n");
    expect(body.rendered_html).toContain("Edited via glosa");
    expect(typeof body.source_sha256).toBe("string");

    expect(readFileSync(join(root, "notes.md"), "utf8")).toBe("# Title\n\nEdited via glosa.\n");

    const after = await headSha(root);
    expect(after).not.toBe(before);

    const diffRes = await fetchFn(req(`/w/${slug}/diff?from=${before}&to=${after}`));
    expect(diffRes.status).toBe(200);
    const diffBody = await diffRes.json();
    const hunk = diffBody.hunks.find((h: { path: string }) => h.path === "notes.md");
    expect(hunk).toBeDefined();
    expect(hunk.attribution).toBe("human"); // A4 §F05 — glosa's own editor, human BY CONSTRUCTION
    expect(hunk.diff).toContain("Edited via glosa");
  });

  test("PUT artifact accepts a JSON {content} body, not just raw text", async () => {
    writeFileSync(join(root, "notes.md"), "original\n");
    const res = await fetchFn(
      stateChangingReq(`/w/${slug}/artifacts/notes.md`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "wrapped content\n" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(readFileSync(join(root, "notes.md"), "utf8")).toBe("wrapped content\n");
  });

  test("PUT artifact with a correct If-Match source_sha256 succeeds", async () => {
    writeFileSync(join(root, "notes.md"), "original\n");
    const getRes = await fetchFn(req(`/w/${slug}/artifacts/notes.md`));
    const sha = (await getRes.json()).source_sha256;

    const res = await fetchFn(
      stateChangingReq(`/w/${slug}/artifacts/notes.md`, {
        method: "PUT",
        headers: { "Content-Type": "text/plain", "If-Match": sha },
        body: "updated\n",
      }),
    );
    expect(res.status).toBe(200);
  });

  test("PUT artifact with a stale If-Match source_sha256 → 409 conflict, file left unchanged", async () => {
    writeFileSync(join(root, "notes.md"), "original\n");
    const res = await fetchFn(
      stateChangingReq(`/w/${slug}/artifacts/notes.md`, {
        method: "PUT",
        headers: { "Content-Type": "text/plain", "If-Match": "0000000000000000000000000000000000000000000000000000000000000000" },
        body: "updated\n",
      }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).type).toContain("conflict");
    expect(readFileSync(join(root, "notes.md"), "utf8")).toBe("original\n");
  });

  test("PUT artifact with an empty body → 400 validation-failed", async () => {
    writeFileSync(join(root, "notes.md"), "original\n");
    const res = await fetchFn(
      stateChangingReq(`/w/${slug}/artifacts/notes.md`, {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
        body: "",
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).type).toContain("validation-failed");
  });

  test("PUT artifact on a class-F (.html) path → 400 validation-failed, never writes", async () => {
    writeFileSync(join(root, "page.html"), "<p>original</p>");
    const res = await fetchFn(
      stateChangingReq(`/w/${slug}/artifacts/page.html`, {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
        body: "<p>hacked</p>",
      }),
    );
    expect(res.status).toBe(400);
    expect(readFileSync(join(root, "page.html"), "utf8")).toBe("<p>original</p>");
  });

  test("PUT artifact that is within the workspace but not tracked → 404 not-found", async () => {
    writeFileSync(join(root, "untracked.json"), "{}");
    const res = await fetchFn(
      stateChangingReq(`/w/${slug}/artifacts/untracked.json`, {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(404);
  });

  test("PUT artifact via a symlink pointing outside the workspace → 400 invalid-path", async () => {
    const outside = mkdtempSync(join(tmpdir(), "glosa-routes-outside-"));
    writeFileSync(join(outside, "secret.md"), "top secret\n");
    symlinkSync(join(outside, "secret.md"), join(root, "escape.md"));
    const res = await fetchFn(
      stateChangingReq(`/w/${slug}/artifacts/escape.md`, {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
        body: "pwned\n",
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).type).toContain("invalid-path");
    rmSync(outside, { recursive: true, force: true });
  });

  test("PUT artifact on an unknown slug → 404", async () => {
    const res = await fetchFn(
      stateChangingReq("/w/does-not-exist/artifacts/notes.md", {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
        body: "x\n",
      }),
    );
    expect(res.status).toBe(404);
  });

  test("PUT artifact with no Bearer → 401", async () => {
    writeFileSync(join(root, "notes.md"), "original\n");
    const res = await fetchFn(
      new Request(`http://127.0.0.1:${PORT}/w/${slug}/artifacts/notes.md`, {
        method: "PUT",
        headers: { Host: `127.0.0.1:${PORT}`, "Content-Type": "text/plain" },
        body: "x\n",
      }),
    );
    expect(res.status).toBe(401);
  });

  test("PUT artifact with no Origin → 403 (state-changing route class)", async () => {
    writeFileSync(join(root, "notes.md"), "original\n");
    const res = await fetchFn(
      req(`/w/${slug}/artifacts/notes.md`, {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
        body: "x\n",
      }),
    );
    expect(res.status).toBe(403);
  });

  // --- POST /w/:slug/annotations (5.6) ---

  function annotationBody(overrides: Record<string, unknown> = {}) {
    return {
      body: "consider tightening this",
      intent: "content",
      target: {
        chunk_id: "chunk-004",
        quote: { exact: "some text", prefix: "before ", suffix: " after" },
        position: { start: 10, end: 19 },
      },
      ...overrides,
    };
  }

  test("POST annotation → 201 {id, status:pending}, persisted to the journal as entry_created", async () => {
    const res = await fetchFn(
      stateChangingReq(`/w/${slug}/annotations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(annotationBody()),
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.status).toBe("pending");
    expect(typeof body.id).toBe("string");

    const journal = readFileSync(journalPath(root), "utf8");
    const lines = journal.split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l));
    const created = lines.find((l) => l.event === "entry_created" && l.entry === body.id);
    expect(created).toBeDefined();
    expect(created.detail.kind).toBe("annotation");
  });

  test("POST annotation cannot spoof kind: a client-supplied kind:attention_request is dropped, entry persists as kind:annotation (review fix #1)", async () => {
    const res = await fetchFn(
      stateChangingReq(`/w/${slug}/annotations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(annotationBody({ kind: "attention_request", junk_field: "ignored" })),
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.status).toBe("pending");

    const journal = readFileSync(journalPath(root), "utf8");
    const lines = journal.split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l));
    const created = lines.find((l) => l.event === "entry_created" && l.entry === body.id);
    expect(created.detail.kind).toBe("annotation"); // NOT attention_request — never surfaces in the attention tray

    const inboxRes = await fetchFn(req(`/w/${slug}/inbox`));
    expect(await inboxRes.json()).toEqual({ pending_count: 0, attention: [] });
  });

  test("POST annotations/:id/withdraw → 200 {status:rejected}; the journal keeps the entry, delivery stops (terminal)", async () => {
    const createRes = await fetchFn(
      stateChangingReq(`/w/${slug}/annotations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(annotationBody()),
      }),
    );
    const { id } = await createRes.json();

    const res = await fetchFn(stateChangingReq(`/w/${slug}/annotations/${id}/withdraw`, { method: "POST" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id, status: "rejected" });

    // Append-only truth: the entry_created line is still there, joined by the terminal transition.
    const journal = readFileSync(journalPath(root), "utf8");
    const lines = journal.split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l));
    expect(lines.find((l) => l.event === "entry_created" && l.entry === id)).toBeDefined();
    const transition = lines.find((l) => l.event === "transition_committed" && l.entry === id);
    expect(transition.detail.to).toBe("rejected");
    expect(transition.by).toBe("human");
  });

  test("POST withdraw on an already-terminal entry → 409 conflict (a session may have closed it first)", async () => {
    const createRes = await fetchFn(
      stateChangingReq(`/w/${slug}/annotations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(annotationBody()),
      }),
    );
    const { id } = await createRes.json();
    await fetchFn(stateChangingReq(`/w/${slug}/annotations/${id}/withdraw`, { method: "POST" }));

    const res = await fetchFn(stateChangingReq(`/w/${slug}/annotations/${id}/withdraw`, { method: "POST" }));
    expect(res.status).toBe(409);
    expect((await res.json()).type).toContain("conflict");
  });

  test("POST withdraw on an unknown entry id → 404", async () => {
    const res = await fetchFn(stateChangingReq(`/w/${slug}/annotations/inb-never-existed/withdraw`, { method: "POST" }));
    expect(res.status).toBe(404);
  });

  test("POST annotation missing body.body → 400 validation-failed", async () => {
    const res = await fetchFn(
      stateChangingReq(`/w/${slug}/annotations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(annotationBody({ body: undefined })),
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).type).toContain("validation-failed");
  });

  test("POST annotation with an invalid intent → 400 validation-failed", async () => {
    const res = await fetchFn(
      stateChangingReq(`/w/${slug}/annotations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(annotationBody({ intent: "not-a-real-intent" })),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("POST annotation missing target.quote.exact → 400 validation-failed", async () => {
    const res = await fetchFn(
      stateChangingReq(`/w/${slug}/annotations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: "x", intent: "content", target: { quote: {} } }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("POST annotation on unknown slug → 404", async () => {
    const res = await fetchFn(
      stateChangingReq("/w/does-not-exist/annotations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(annotationBody()),
      }),
    );
    expect(res.status).toBe(404);
  });

  // --- GET /w/:slug/diff (5.7) ---

  test("GET diff between two checkpoints returns a unified diff per file with the correct attribution — a lease-attributed change and an unknown change both surface correctly", async () => {
    const bus = ctx.getWorkspaceBus(root);
    await bus.reconcile(); // establishes the baseline commit

    // File A: edited under a proven apply-lease -> attributed session:<id>.
    const { leaseId: _leaseId, preSha: from } = await bus.applyBegin("entry-1", "sess-a");
    writeFileSync(join(root, "leased.md"), "edited under lease\n");
    await bus.resolveEntry("entry-1", "applied", "sess-a");

    // File B: written directly on disk with no lease at all -> the next checkpoint attributes it
    // "unknown" (A4 §F05 — never falsely "session").
    writeFileSync(join(root, "drifted.md"), "no lease touched this\n");
    const to = await checkpoint(root, { attribution: "unknown", kind: "auto_checkpoint" });

    const res = await fetchFn(req(`/w/${slug}/diff?from=${from}&to=${to}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.from).toBe(from);
    expect(body.to).toBe(to);

    const leased = body.hunks.find((h: { path: string }) => h.path === "leased.md");
    const drifted = body.hunks.find((h: { path: string }) => h.path === "drifted.md");
    expect(leased).toBeDefined();
    expect(leased.attribution).toBe("session:sess-a");
    expect(leased.diff).toContain("edited under lease");
    expect(drifted).toBeDefined();
    expect(drifted.attribution).toBe("unknown");
  });

  test("GET diff with an unknown checkpoint id → 400 validation-failed", async () => {
    // A tracked file must exist BEFORE reconcile() runs — reconcile's offline-catchup only
    // initializes the shadow repo when there's already something to track (git/shadow.ts), so a
    // file written afterward would leave `checkpoint()` with no repo to commit into.
    writeFileSync(join(root, "a.md"), "content\n");
    const bus = ctx.getWorkspaceBus(root);
    await bus.reconcile(); // baseline commit now exists — a real, resolvable "from"
    const head = await headSha(root);
    const res = await fetchFn(req(`/w/${slug}/diff?from=${head}&to=0000000000000000000000000000000000000000`));
    expect(res.status).toBe(400);
    expect((await res.json()).type).toContain("validation-failed");
  });

  test("GET diff missing from/to → 400 validation-failed", async () => {
    const res = await fetchFn(req(`/w/${slug}/diff`));
    expect(res.status).toBe(400);
  });

  test("GET diff with since= → 400 validation-failed (P3.5 — named-token resolution not yet built)", async () => {
    const res = await fetchFn(req(`/w/${slug}/diff?since=yesterday`));
    expect(res.status).toBe(400);
  });

  test("GET diff on an unknown slug → 404", async () => {
    const res = await fetchFn(req("/w/does-not-exist/diff?from=a&to=b"));
    expect(res.status).toBe(404);
  });

  test("GET diff with to=working diffs a checkpoint against the LIVE working tree, not another checkpoint", async () => {
    writeFileSync(join(root, "notes.md"), "v1\n");
    const bus = ctx.getWorkspaceBus(root);
    await bus.reconcile(); // baseline
    const from = await headSha(root);

    writeFileSync(join(root, "notes.md"), "v2 — uncommitted\n"); // dirty on disk, never checkpointed

    const res = await fetchFn(req(`/w/${slug}/diff?from=${from}&to=working`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.to).toBe("working");
    const hunk = body.hunks.find((h: { path: string }) => h.path === "notes.md");
    expect(hunk).toBeDefined();
    expect(hunk.diff).toContain("uncommitted");
  });

  // --- GET /w/:slug/checkpoints (A6 §F31) ---

  test("GET checkpoints lists the workspace's history newest-first with by/summary/bytes_changed", async () => {
    writeFileSync(join(root, "notes.md"), "v1\n");
    const bus = ctx.getWorkspaceBus(root);
    await bus.reconcile(); // baseline: unknown/baseline

    await bus.applyBegin("entry-1", "sess-a");
    writeFileSync(join(root, "notes.md"), "v2 — leased\n");
    await bus.resolveEntry("entry-1", "applied", "sess-a");

    const res = await fetchFn(req(`/w/${slug}/checkpoints`));
    expect(res.status).toBe(200);
    const rows = await res.json();
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows[0].by).toBe("session:sess-a"); // newest first
    expect(typeof rows[0].checkpoint_id).toBe("string");
    expect(typeof rows[0].at).toBe("string");
    expect(rows[0].bytes_changed).toBeGreaterThan(0);
    expect(rows.at(-1).by).toBe("unknown"); // the baseline
  });

  test("GET checkpoints with ?limit=1 returns only the newest row", async () => {
    writeFileSync(join(root, "notes.md"), "v1\n");
    const bus = ctx.getWorkspaceBus(root);
    await bus.reconcile();
    writeFileSync(join(root, "notes.md"), "v2\n");
    await bus.humanEditCheckpoint();

    const res = await fetchFn(req(`/w/${slug}/checkpoints?limit=1`));
    const rows = await res.json();
    expect(rows).toHaveLength(1);
    expect(rows[0].by).toBe("human");
  });

  test("GET checkpoints with an unrecognized ?since= → 400 validation-failed", async () => {
    writeFileSync(join(root, "notes.md"), "v1\n");
    const bus = ctx.getWorkspaceBus(root);
    await bus.reconcile();

    const res = await fetchFn(req(`/w/${slug}/checkpoints?since=not-a-real-token`));
    expect(res.status).toBe(400);
    expect((await res.json()).type).toContain("validation-failed");
  });

  test("GET checkpoints with ?limit=0 → 400 validation-failed", async () => {
    const res = await fetchFn(req(`/w/${slug}/checkpoints?limit=0`));
    expect(res.status).toBe(400);
  });

  test("GET checkpoints on an unknown slug → 404", async () => {
    const res = await fetchFn(req("/w/does-not-exist/checkpoints"));
    expect(res.status).toBe(404);
  });

  test("GET checkpoints on a workspace with nothing ever tracked → 200 empty array, not an error", async () => {
    const res = await fetchFn(req(`/w/${slug}/checkpoints`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  // --- POST /w/:slug/restore (A6 §F31 acceptance cases) ---

  test("dirty-worktree refusal: an on-disk edit with no checkpoint yet blocks restore without force → 409 restore-conflict, file unchanged, would-be-lost diff included", async () => {
    writeFileSync(join(root, "notes.md"), "v1 — checkpointed\n");
    const bus = ctx.getWorkspaceBus(root);
    // reconcileOnce (not the bare reconcile()) — it flags this BUS INSTANCE as already-reconciled,
    // so the restore route's own `resolveBus` call below is a true no-op instead of running its
    // FIRST-EVER reconcile (and thus offline catch-up) on top of the drift this test is about to
    // introduce, which would otherwise auto-checkpoint it away before the dirty check ever runs.
    await bus.reconcileOnce(); // establishes the baseline checkpoint
    const baseline = await headSha(root);

    writeFileSync(join(root, "notes.md"), "v1 — checkpointed, then edited on disk\n"); // dirty vs baseline, never checkpointed

    const res = await fetchFn(
      stateChangingReq(`/w/${slug}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "notes.md", to: baseline }),
      }),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.type).toContain("restore-conflict");
    expect(body.path).toBe("notes.md");
    expect(body.would_be_lost_diff).toContain("edited on disk");
    expect(readFileSync(join(root, "notes.md"), "utf8")).toBe("v1 — checkpointed, then edited on disk\n");
  });

  test("restore-creates-checkpoint: force:true overwrites the dirty file, matches the target checkpoint's bytes, and records a NEW by:human kind:restore checkpoint (history not rewritten)", async () => {
    writeFileSync(join(root, "notes.md"), "v1 — original\n");
    const bus = ctx.getWorkspaceBus(root);
    await bus.reconcileOnce(); // baseline; see the dirty-worktree-refusal test above for why reconcileOnce (not bare reconcile())
    const target = await headSha(root);

    writeFileSync(join(root, "notes.md"), "v2 — a real checkpointed change\n");
    await bus.humanEditCheckpoint(); // HEAD now differs from `target` — restoring to `target` is a genuine content change, not a no-op
    const beforeCount = (await fetchFn(req(`/w/${slug}/checkpoints`)).then((r) => r.json())).length;

    writeFileSync(join(root, "notes.md"), "v3 — dirty, about to be discarded\n");

    const res = await fetchFn(
      stateChangingReq(`/w/${slug}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "notes.md", to: target, force: true }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.path).toBe("notes.md");
    expect(body.restored_to).toBe(target);
    expect(typeof body.checkpoint_id).toBe("string");

    const afterSha = await headSha(root);
    expect(afterSha).not.toBe(target); // a NEW checkpoint, not a rewind of HEAD back onto the target
    expect(afterSha.startsWith(body.checkpoint_id)).toBe(true); // checkpoint_id is HEAD's short sha

    expect(readFileSync(join(root, "notes.md"), "utf8")).toBe("v1 — original\n"); // bytes match the target checkpoint

    const rows = await fetchFn(req(`/w/${slug}/checkpoints`)).then((r) => r.json());
    expect(rows.length).toBe(beforeCount + 1); // append-only — the count GREW, nothing was rewritten
    expect(rows[0]).toMatchObject({ by: "human", summary: "restore", checkpoint_id: body.checkpoint_id });
  });

  test("restore-then-diff-clean: after a successful restore, diffing the restored-to checkpoint against the working tree is empty", async () => {
    writeFileSync(join(root, "notes.md"), "v1 — target state\n");
    const bus = ctx.getWorkspaceBus(root);
    await bus.reconcile();
    const target = await headSha(root);

    writeFileSync(join(root, "notes.md"), "v2 — different content\n");
    await bus.humanEditCheckpoint(); // a real checkpoint now sits between target and HEAD

    const restoreRes = await fetchFn(
      stateChangingReq(`/w/${slug}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "notes.md", to: target, force: true }),
      }),
    );
    expect(restoreRes.status).toBe(200);

    const diffRes = await fetchFn(req(`/w/${slug}/diff?from=${target}&to=working`));
    expect(diffRes.status).toBe(200);
    const diffBody = await diffRes.json();
    const hunk = diffBody.hunks.find((h: { path: string }) => h.path === "notes.md");
    expect(hunk).toBeUndefined(); // clean — working tree exactly matches the restored-to checkpoint again
  });

  test("restore with an unknown checkpoint id in `to` → 400 validation-failed", async () => {
    writeFileSync(join(root, "notes.md"), "v1\n");
    const bus = ctx.getWorkspaceBus(root);
    await bus.reconcile();

    const res = await fetchFn(
      stateChangingReq(`/w/${slug}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "notes.md", to: "0000000000000000000000000000000000000000000000000000000000000000" }),
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).type).toContain("validation-failed");
  });

  test("restore on a path that is within the workspace but not tracked → 404", async () => {
    writeFileSync(join(root, "untracked.json"), "{}");
    const bus = ctx.getWorkspaceBus(root);
    writeFileSync(join(root, "notes.md"), "v1\n");
    await bus.reconcile();
    const sha = await headSha(root);

    const res = await fetchFn(
      stateChangingReq(`/w/${slug}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "untracked.json", to: sha }),
      }),
    );
    expect(res.status).toBe(404);
  });

  test("restore via a symlink pointing outside the workspace → 400 invalid-path", async () => {
    writeFileSync(join(root, "notes.md"), "v1\n");
    const bus = ctx.getWorkspaceBus(root);
    await bus.reconcile();
    const sha = await headSha(root);
    const outside = mkdtempSync(join(tmpdir(), "glosa-routes-outside-"));
    writeFileSync(join(outside, "secret.md"), "top secret\n");
    symlinkSync(join(outside, "secret.md"), join(root, "escape.md"));

    const res = await fetchFn(
      stateChangingReq(`/w/${slug}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "escape.md", to: sha }),
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).type).toContain("invalid-path");
    rmSync(outside, { recursive: true, force: true });
  });

  test("restore on an unknown slug → 404", async () => {
    const res = await fetchFn(
      stateChangingReq("/w/does-not-exist/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "notes.md", to: "abc" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  test("restore with missing path/to in the body → 400 validation-failed", async () => {
    const res = await fetchFn(
      stateChangingReq(`/w/${slug}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "notes.md" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("restore with no Origin → 403 (state-changing route class)", async () => {
    writeFileSync(join(root, "notes.md"), "v1\n");
    const res = await fetchFn(
      req(`/w/${slug}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "notes.md", to: "abc" }),
      }),
    );
    expect(res.status).toBe(403);
  });

  // --- WorkspaceBus.reconcileOnce (review fix #2) ---

  test("reconcileOnce reconciles once per INSTANCE, not once per root string — a fresh instance after evict()+reopen reconciles again", async () => {
    const bus1 = ctx.getWorkspaceBus(root);
    await bus1.reconcileOnce();
    await bus1.createEntry("e1", { kind: "annotation" });
    expect(bus1.state.entries["e1"]).toBeDefined();

    // A second reconcileOnce() on the SAME instance is a no-op (nothing new to prove wrong here —
    // just confirms it doesn't throw/regress).
    await bus1.reconcileOnce();
    expect(bus1.state.entries["e1"]).toBeDefined();

    // Simulates WorkspaceIndex hard-remove -> onHardRemove -> busRegistry.evict() -> a LATER
    // getWorkspaceBus(root) constructing a brand-new instance.
    await busRegistry.evict(root);
    const bus2 = ctx.getWorkspaceBus(root);
    expect(bus2).not.toBe(bus1);
    expect(bus2.state.entries).toEqual({}); // fresh instance, nothing folded in yet — proves it's NOT pre-marked reconciled

    await bus2.reconcileOnce(); // must actually replay the journal — this is exactly what the fix guarantees
    expect(bus2.state.entries["e1"]).toBeDefined(); // e1 (written via bus1, before eviction) is recovered from disk
  });

  // --- GET /w/:slug/inbox (5.9) ---

  test("GET inbox on a workspace with no attention entries → pending_count 0", async () => {
    const res = await fetchFn(req(`/w/${slug}/inbox`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pending_count: 0, attention: [] });
  });

  test("GET inbox surfaces an open attention_request entry", async () => {
    const bus = ctx.getWorkspaceBus(root);
    await bus.reconcile();
    await bus.createEntry("att-1", { kind: "attention_request", question: "which approach?" });

    const res = await fetchFn(req(`/w/${slug}/inbox`));
    const body = await res.json();
    expect(body.pending_count).toBe(1);
    expect(body.attention).toHaveLength(1);
    expect(body.attention[0]).toMatchObject({ id: "att-1", status: "open" });
    expect(typeof body.attention[0].created_at).toBe("string");
  });

  test("GET inbox does NOT surface a common (non-attention) entry like an annotation", async () => {
    const bus = ctx.getWorkspaceBus(root);
    await bus.reconcile();
    await bus.createEntry("common-1", { kind: "annotation" });

    const res = await fetchFn(req(`/w/${slug}/inbox`));
    expect(await res.json()).toEqual({ pending_count: 0, attention: [] });
  });

  // --- POST /w/:slug/session-binding (5.11) ---

  test("POST session-binding with a live registered session → 200 {bound:true}", async () => {
    await sessionRegistry.register({
      session_id: "sess-live",
      provider: "claude-code",
      cwd: root,
      source: "hook",
    });
    const res = await fetchFn(
      stateChangingReq(`/w/${slug}/session-binding`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: "sess-live" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ bound: true, session_id: "sess-live" });
    expect(sessionRegistry.get("sess-live")?.workspace_binding).toBe(root);
  });

  test("POST session-binding with an unknown session_id → 404", async () => {
    const res = await fetchFn(
      stateChangingReq(`/w/${slug}/session-binding`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: "does-not-exist" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  test("POST session-binding on an unknown workspace slug → 404", async () => {
    const res = await fetchFn(
      stateChangingReq("/w/does-not-exist/session-binding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: "x" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  // --- GET /w/:slug/stream (5.5) — schema/auth-pipeline level only; the real SSE mechanics
  // (snapshot/reconnect/heartbeat/live-push/teardown, P3.2) are covered in stream.test.ts against
  // a real bound Bun.serve, which is what a streaming response actually needs to be tested
  // realistically. This file's `fetchFn` calls the pipeline directly with no `server` arg, which
  // `handleStream`/stream.ts tolerate (the idle-timeout override is skipped, harmlessly) — exactly
  // what makes it safe to keep this route's auth/404 coverage in the fast, no-socket harness.

  test("GET /w/:slug/stream → 200 text/event-stream, auth pipeline runs (P3.2 — full SSE mechanics in stream.test.ts)", async () => {
    const res = await fetchFn(req(`/w/${slug}/stream`));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    await res.body?.cancel(); // never actually read — just proving the pipeline reaches the route
  });
  test("GET /w/:slug/stream with no Bearer → 401 (pipeline runs even for the real route)", async () => {
    const res = await fetchFn(new Request(`http://127.0.0.1:${PORT}/w/${slug}/stream`, { headers: { Host: `127.0.0.1:${PORT}` } }));
    expect(res.status).toBe(401);
  });
  test("GET /w/:slug/stream on an unknown slug → 404, not 200", async () => {
    const res = await fetchFn(req("/w/does-not-exist/stream"));
    expect(res.status).toBe(404);
  });

  // P4.2 replaced this route's shell with the real thing (transcript/stream.ts) — full mechanics
  // (auth pipeline, confinement, normalized events, resync, fail-soft) live in the dedicated
  // packages/daemon/test/transcript/stream.test.ts; this file only proves the shared pipeline
  // still reaches the route and that "no session registered" is a 404, not a 501.
  test("GET /w/:slug/transcript/stream on a workspace with no registered session → 404 (P4.2 — no longer a 501 shell)", async () => {
    const res = await fetchFn(req(`/w/${slug}/transcript/stream`));
    expect(res.status).toBe(404);
  });

  // --- Remaining route SHELLS (5.10) ---

  test("POST /w/:slug/inbox/:id/response → 501 not-implemented (F12)", async () => {
    const res = await fetchFn(stateChangingReq(`/w/${slug}/inbox/att-1/response`, { method: "POST" }));
    expect(res.status).toBe(501);
  });

  // --- GET /w/:slug/capability/:artifactPath (5.12/§7, P4.1) — the class-F capability mint ---

  test("GET /w/:slug/capability/:artifactPath with missing Origin → 403 (state-changing route class)", async () => {
    const res = await fetchFn(req(`/w/${slug}/capability/notes.html`));
    expect(res.status).toBe(403);
  });

  test("GET /w/:slug/capability/:artifactPath with a FOREIGN Origin → 403 — the mint shares the pipeline, not pinned per-route", async () => {
    const res = await fetchFn(req(`/w/${slug}/capability/notes.html`, { headers: { Origin: "http://evil.example.com" } }));
    expect(res.status).toBe(403);
  });

  test("GET /w/:slug/capability/:artifactPath via a symlink escape → 400 invalid-path, never reaches the mint (review fix #3)", async () => {
    const outside = mkdtempSync(join(tmpdir(), "glosa-routes-outside-"));
    writeFileSync(join(outside, "secret.html"), "<p>nope</p>");
    symlinkSync(join(outside, "secret.html"), join(root, "cap-escape.html"));
    const res = await fetchFn(stateChangingReq(`/w/${slug}/capability/cap-escape.html`));
    expect(res.status).toBe(400);
    expect((await res.json()).type).toContain("invalid-path");
    rmSync(outside, { recursive: true, force: true });
  });

  test("GET /w/:slug/capability/:artifactPath on a class-R (.md) artifact → 400 invalid-path — class R never goes through this listener (A1 §7)", async () => {
    writeFileSync(join(root, "notes.md"), "# hello\n");
    const res = await fetchFn(stateChangingReq(`/w/${slug}/capability/notes.md`));
    expect(res.status).toBe(400);
    expect((await res.json()).type).toContain("invalid-path");
  });

  test("GET /w/:slug/capability/:artifactPath on a confined-but-untracked path → 404, not 400 (§6 step 4)", async () => {
    const res = await fetchFn(stateChangingReq(`/w/${slug}/capability/does-not-exist.html`));
    expect(res.status).toBe(404);
  });

  test("GET /w/:slug/capability/:artifactPath on a tracked class-F artifact → 200 with {url, nonce, expires_in_s}", async () => {
    writeFileSync(join(root, "speech-notes.html"), "<html><body><p>hi</p></body></html>");
    const res = await fetchFn(stateChangingReq(`/w/${slug}/capability/speech-notes.html`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.url.startsWith(`http://127.0.0.1:${ctx.classFPort}/doc/`)).toBe(true);
    expect(body.url).toMatch(/\/doc\/[0-9a-f]{64}\/speech-notes\.html$/);
    expect(typeof body.nonce).toBe("string");
    expect(body.nonce).toMatch(/^[0-9a-f]{64}$/); // 256-bit hex
    expect(body.expires_in_s).toBe(600);
  });

  test("GET /w/:slug/capability/:artifactPath mints a FRESH token+nonce on every call — never reused across mints", async () => {
    writeFileSync(join(root, "speech-notes.html"), "<html><body><p>hi</p></body></html>");
    const res1 = await fetchFn(stateChangingReq(`/w/${slug}/capability/speech-notes.html`));
    const res2 = await fetchFn(stateChangingReq(`/w/${slug}/capability/speech-notes.html`));
    const [body1, body2] = await Promise.all([res1.json(), res2.json()]);
    expect(body1.url).not.toBe(body2.url);
    expect(body1.nonce).not.toBe(body2.nonce);
  });

  // --- Pipeline gates (A1 §1/§3/§4) still hold through the NEW routes ---

  test("POST annotation over 1 MiB → 413 (the pipeline's body cap runs before this route's own validation)", async () => {
    const oversized = "x".repeat(1024 * 1024 + 1);
    const res = await fetchFn(
      stateChangingReq(`/w/${slug}/annotations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: oversized,
      }),
    );
    expect(res.status).toBe(413);
  });

  test("GET /w/:slug/artifacts with X-Contract-Version major mismatch → 409, never reaches the route", async () => {
    const res = await fetchFn(req(`/w/${slug}/artifacts`, { headers: { "X-Contract-Version": "99.0" } }));
    expect(res.status).toBe(409);
  });

  test("GET /w/:slug/diff with a Host mismatch → 400, no body, before any route/slug lookup", async () => {
    const res = await fetchFn(
      new Request(`http://127.0.0.1:${PORT}/w/${slug}/diff?from=a&to=b`, { headers: { Host: "evil.com" } }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("");
  });

  test("POST /w/:slug/session-binding with a foreign Origin → 403, even for a slug that IS registered", async () => {
    const res = await fetchFn(
      req(`/w/${slug}/session-binding`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "http://evil.example.com" },
        body: JSON.stringify({ session_id: "x" }),
      }),
    );
    expect(res.status).toBe(403);
  });

  test("GET /w/:slug/inbox with a foreign Origin → 403 (reads reject foreign, per authed-read class)", async () => {
    const res = await fetchFn(req(`/w/${slug}/inbox`, { headers: { Origin: "http://evil.example.com" } }));
    expect(res.status).toBe(403);
  });
});

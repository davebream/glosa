// SPDX-License-Identifier: Apache-2.0
// The badge-facing fold and the live retention-facing one, over the real daemon (#153, contract
// A3 and A3b). Since #152 the badge has exactly one source: the `GET /api/status` workspace row
// (`spa/src/agent-feedback.js` reads `connection.workspace.pending_count`); the former
// `GET /w/:slug/wiring` fallback no longer exists, so a second surface cannot disagree with it.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXTERNAL_EDIT_KIND } from "../src/bus/external-edit.ts";
import { tokenPath } from "../src/security/token.ts";
import { cleanupHome, freshHome, randomPort, spawnDaemon, stopDaemon, waitForHandshake } from "./helpers.ts";

const TOKEN = "external-edit-http-token-0123456789abcdef";
const TEST_TIMEOUT_MS = 20_000;

/** One `entry_created` line per kind, written straight into a bus journal — the same bytes the
 * daemon writes. Journal-only on purpose: these folds read the journal and never the inbox file,
 * which is what lets them run against a bare `~/.glosa/state/<id>` directory. */
function entryLine(id: string, kind: string, seq: number): string {
  return JSON.stringify({
    v: 1,
    event_id: `01TESTEVENT000000000000000${seq}`,
    at: "2026-09-11T00:00:00.000Z",
    entry: id,
    event: "entry_created",
    by: kind === EXTERNAL_EDIT_KIND ? "watcher" : "daemon",
    detail: { kind, payload_kind: kind },
  });
}

describe("external_edit and the counts the daemon serves — real subprocess", () => {
  let home: string;
  let port: number;
  let proc: Bun.Subprocess;
  const dirs: string[] = [];

  beforeEach(async () => {
    home = freshHome();
    port = randomPort();
    mkdirSync(home, { recursive: true });
    writeFileSync(tokenPath(home), TOKEN, { mode: 0o600 });
    proc = spawnDaemon(home, port, { GLOSA_CLASSF_PORT: String(port + 1) });
    expect(await waitForHandshake(port, 15_000, proc)).not.toBeNull();
  });

  afterEach(async () => {
    await stopDaemon(home, proc);
    cleanupHome(home);
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function authed(path: string): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  }

  function postAuthed(path: string, body: unknown): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Origin: `http://127.0.0.1:${port}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  /** Registers a session and explicitly binds it to `slug` — a watch requires exactly this, the
   * same as the session stream. */
  async function boundSession(slug: string, dir: string, sessionId: string): Promise<void> {
    const registered = await postAuthed("/api/sessions/register", {
      session_id: sessionId,
      provider: "mcp",
      cwd: dir,
      source: "mcp",
    });
    expect(registered.status).toBe(200);
    const bound = await postAuthed(`/w/${slug}/session-binding`, { session_id: sessionId });
    expect(bound.status).toBe(200);
  }

  async function openWorkspace(): Promise<{ slug: string; dir: string }> {
    const dir = mkdtempSync(join(tmpdir(), "glosa-ee-http-"));
    dirs.push(dir);
    writeFileSync(join(dir, "notes.md"), "one\n");
    const res = await fetch(`http://127.0.0.1:${port}/api/workspaces/open`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Origin: `http://127.0.0.1:${port}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ path: dir }),
    });
    expect(res.status).toBe(200);
    return { slug: (await res.json()).slug as string, dir };
  }

  function it(name: string, fn: () => Promise<void>): void {
    test(name, fn, TEST_TIMEOUT_MS);
  }

  it("the SPA badge's own value (GET /api/status workspace row) counts the annotation and not the external_edit", async () => {
    const { slug, dir } = await openWorkspace();
    writeFileSync(
      join(dir, ".glosa", "journal.ndjson"),
      `${entryLine("inb-annotation", "annotation", 1)}\n${entryLine("inb-external", EXTERNAL_EDIT_KIND, 2)}\n`,
    );

    const body = await (await authed("/api/status")).json();
    const row = body.workspaces.find((workspace: { slug: string }) => workspace.slug === slug);

    expect(row).toBeDefined();
    // This field is the one `agent-feedback.js` renders.
    expect(row.pending_count).toBe(1);
  });

  it("the removed wiring route is gone rather than a second, possibly disagreeing surface (#152)", async () => {
    const { slug } = await openWorkspace();
    expect((await authed(`/w/${slug}/wiring`)).status).toBe(404);
  });

  it("a workspace whose ONLY entry is an external_edit shows a badge of zero", async () => {
    const { slug, dir } = await openWorkspace();
    writeFileSync(join(dir, ".glosa", "journal.ndjson"), `${entryLine("inb-external", EXTERNAL_EDIT_KIND, 5)}\n`);

    const status = await (await authed("/api/status")).json();
    const row = status.workspaces.find((workspace: { slug: string }) => workspace.slug === slug);

    expect(row.pending_count).toBe(0);
    // ...and it is still an open, undismissed entry rather than something that quietly vanished —
    // `has_attention` stays false because its kind is `common`, which is the structural exclusion.
    expect(row.has_attention).toBe(false);
  });

  it("orphan-scan (live, via GET /api/status) still reports a bus whose only pending item is an external_edit", async () => {
    // The retention-facing half of A3b, on its live path. `orphaned_state` is what `glosa doctor`
    // turns into "N pending annotation(s) stranded in M orphaned dirs", and an undismissed
    // `external_edit` is exactly the parked work this scanner exists to find.
    const orphanId = "ab".repeat(32);
    const busDir = join(home, "state", orphanId);
    mkdirSync(busDir, { recursive: true });
    writeFileSync(join(busDir, "journal.ndjson"), `${entryLine("inb-external", EXTERNAL_EDIT_KIND, 6)}\n`);

    const body = await (await authed("/api/status")).json();
    expect(body.orphaned_state).toEqual([{ registration_id: orphanId, pending_count: 1 }]);
  });

  it("dismissing it clears the retention signal too — the entry is closable, not permanent", async () => {
    const orphanId = "ef".repeat(32);
    const busDir = join(home, "state", orphanId);
    mkdirSync(busDir, { recursive: true });
    const dismissed = JSON.stringify({
      v: 1,
      event_id: "01TESTEVENT0000000000000007",
      at: "2026-09-11T00:01:00.000Z",
      entry: "inb-external",
      event: "transition_committed",
      by: "human",
      detail: { to: "dismissed" },
    });
    writeFileSync(
      join(busDir, "journal.ndjson"),
      `${entryLine("inb-external", EXTERNAL_EDIT_KIND, 6)}\n${dismissed}\n`,
    );

    const body = await (await authed("/api/status")).json();
    expect(body.orphaned_state).toEqual([]);
  });

  // Criterion 5 / A1 §8.3: `Bun.serve` closes an idle connection at its own default (~10s on Bun
  // 1.2.7 per this task's premise probe) unless the handler calls `server.timeout(req, 0)` —
  // which neither route did before this task. Only a REAL bound daemon subprocess can observe
  // this: `http-routes.test.ts`'s in-process `createApiFetch` calls have no bound `server` at all
  // (there is nothing to time out), so they are structurally blind to the defect this proves fixed.
  test("a watch held for 15s (past the ~10s idle default) returns 200 with entries:[] and the current latest_checkpoint", async () => {
    const { slug, dir } = await openWorkspace();
    await boundSession(slug, dir, "sess-watch-15s");

    const started = Date.now();
    const res = await authed(`/w/${slug}/watch?session=sess-watch-15s&wait_ms=15000`);
    const elapsed = Date.now() - started;

    expect(res.status).toBe(200);
    expect(elapsed).toBeGreaterThanOrEqual(14_000);
    const body = await res.json();
    expect(body).toEqual({ entries: [], has_more: false, latest_checkpoint: null });
  }, 25_000);

  test("F-8 — a watch is a read: on a workspace whose bus is COLD after a daemon restart, the journal is byte-identical across one", async () => {
    // Reconciling self-heals and checkpoints, which `bus/peek.ts` spells out is exactly what a
    // plain GET must not cause. The window where that matters is a bus nobody has opened yet: the
    // registry survives a restart on disk while buses do not, so after one the first request to
    // touch a workspace could be a watch.
    //
    // Making this observable took three arrangements, each learned by ablating a version that
    // proved nothing. The restart is one: watching an already-open workspace leaves a reconcile
    // with nothing to do, so it passed with the fix reverted. Editing the manuscript while the
    // daemon is DOWN is the second — a reconcile only writes when it finds drift, so with no
    // offline edit a cold bus reconciles silently and the journal is byte-identical either way.
    //
    // The third is what the test is really built around. A watch cannot reach a cold bus at all:
    // bindings live in memory, so the restart drops this session's, and the route refuses a watch
    // that has no binding. That refusal plus "binding hydrates" is the whole guarantee — there is
    // no order of requests that reaches a watch before someone has reconciled. So both halves are
    // asserted here, and the byte comparison measures what the watch adds on top of the bind.
    //
    // What this test does NOT pin is the watch's non-reconciling resolver itself: with the bind
    // hydrating first, swapping it back for the reconciling one is an observable no-op, and it
    // stays green. `resolveBusForRead`'s own comment says so rather than letting the name of this
    // test imply otherwise.
    const { slug, dir } = await openWorkspace();
    const journal = join(dir, ".glosa", "journal.ndjson");

    await stopDaemon(home, proc);
    writeFileSync(join(dir, "notes.md"), "one\nedited while the daemon was down\n");
    proc = spawnDaemon(home, port, { GLOSA_CLASSF_PORT: String(port + 1) });
    expect(await waitForHandshake(port, 15_000, proc)).not.toBeNull();

    // Half one: unbound, the watch is refused outright rather than served off a cold bus.
    const unbound = await authed(`/w/${slug}/watch?session=sess-watch-cold&wait_ms=0`);
    expect(unbound.status).toBe(404);
    expect(readFileSync(journal).toString()).not.toContain(EXTERNAL_EDIT_KIND);

    // Half two: binding is what hydrates, so it is the bind that reports the offline drift.
    await boundSession(slug, dir, "sess-watch-cold");
    const before = readFileSync(journal);
    expect(before.toString()).toContain(EXTERNAL_EDIT_KIND);

    const res = await authed(`/w/${slug}/watch?session=sess-watch-cold&wait_ms=0`);
    expect(res.status).toBe(200);

    const after = existsSync(journal) ? readFileSync(journal) : Buffer.alloc(0);
    expect({ changed: !before.equals(after), size: after.length }).toEqual({ changed: false, size: before.length });
  }, 40_000);

  test("F-8b — a session bound by REGISTER, never by the binding route, does not get a silently cold watch", async () => {
    // Review round 3 disproved the ordering claim this route's hydration rested on. `register`
    // accepts `workspace_binding` in its body and never resolves a bus, so a session can be live
    // and explicitly bound without anything having reconciled its workspace. The watch that
    // follows would then serve a 200 with no entries for an edit made while the daemon was down —
    // silently wrong, which is worse than an error.
    const { slug, dir } = await openWorkspace();
    const journal = join(dir, ".glosa", "journal.ndjson");

    await stopDaemon(home, proc);
    writeFileSync(join(dir, "notes.md"), "one\nedited while the daemon was down\n");
    proc = spawnDaemon(home, port, { GLOSA_CLASSF_PORT: String(port + 1) });
    expect(await waitForHandshake(port, 15_000, proc)).not.toBeNull();

    // Bound by register alone — the session-binding route is never called.
    const registered = await postAuthed("/api/sessions/register", {
      session_id: "sess-register-bound",
      provider: "mcp",
      cwd: dir,
      source: "mcp",
      workspace_binding: dir,
    });
    expect(registered.status).toBe(200);

    const res = await authed(`/w/${slug}/watch?session=sess-register-bound&wait_ms=0`);
    const after = readFileSync(journal).toString();

    // Whatever the answer is, it must not be "200 with nothing to report" off an unhydrated bus.
    // Either the workspace was hydrated (so the drift is reported), or the watch says it cannot
    // answer yet. Silence is the one outcome this pins out.
    const body = res.status === 200 ? ((await res.json()) as { entries: unknown[] }) : null;
    expect({
      hydrated: after.includes(EXTERNAL_EDIT_KIND),
      silentlyEmpty: res.status === 200 && body?.entries.length === 0,
    }).toEqual({ hydrated: true, silentlyEmpty: false });
  }, 40_000);

  test("watch/transport-ack refuses an entry id no watch handed this session, and accepts it once one has", async () => {
    // Honest provenance (AGENTS.md invariant 3): a `transport_accepted` record asserts the entry
    // reached this session. Scope alone cannot assert that — entry ids show up in ordinary reads,
    // so gating on "is an external_edit in the bound workspace" let any token bearer mint a
    // delivery that never happened, and `presented` then gates on that same forged record.
    const { slug, dir } = await openWorkspace();
    const journal = join(dir, ".glosa", "journal.ndjson");

    await stopDaemon(home, proc);
    writeFileSync(join(dir, "notes.md"), "one\nedited while the daemon was down\n");
    proc = spawnDaemon(home, port, { GLOSA_CLASSF_PORT: String(port + 1) });
    expect(await waitForHandshake(port, 15_000, proc)).not.toBeNull();
    await boundSession(slug, dir, "sess-ack-provenance");

    // The bind reported the offline edit, so a real external_edit id exists and is in scope — the
    // id an attacker would name. Nothing has been watched yet.
    const found = readFileSync(journal)
      .toString()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { event: string; entry?: string; detail?: { kind?: string } })
      .find((event) => event.event === "entry_created" && event.detail?.kind === EXTERNAL_EDIT_KIND)?.entry;
    expect(found).toBeString();
    const externalEditId = found as string;

    const forged = await postAuthed("/api/sessions/sess-ack-provenance/watch/transport-ack", {
      entries: [externalEditId],
    });
    expect(forged.status).toBe(409);
    // The refusal has to be a refusal to WRITE, not just a status code.
    expect(readFileSync(journal).toString()).not.toContain("transport_accepted");

    // Once a watch has actually handed the entry over, the same call is the legitimate one.
    const watched = await authed(`/w/${slug}/watch?session=sess-ack-provenance&wait_ms=0`);
    expect(watched.status).toBe(200);
    expect(((await watched.json()) as { entries: Array<{ id: string }> }).entries.map((e) => e.id)).toContain(
      externalEditId,
    );

    const honest = await postAuthed("/api/sessions/sess-ack-provenance/watch/transport-ack", {
      entries: [externalEditId],
    });
    expect(honest.status).toBe(200);
    expect(await honest.json()).toEqual({ accepted: [externalEditId] });
    expect(readFileSync(journal).toString()).toContain("transport_accepted");
  }, 40_000);

  test("entry-status held for 15s (past the ~10s idle default) returns 200 rather than closing early", async () => {
    const { dir } = await openWorkspace();
    const created = await postAuthed("/api/workspaces/attention-request", {
      path: dir,
      action: "review",
      message: "still open at 15s?",
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    const started = Date.now();
    const res = await authed(
      `/api/workspaces/entry-status?path=${encodeURIComponent(dir)}&entry=${encodeURIComponent(id)}&wait_ms=15000`,
    );
    const elapsed = Date.now() - started;

    expect(res.status).toBe(200);
    expect(elapsed).toBeGreaterThanOrEqual(14_000);
    const body = await res.json();
    expect(body).toMatchObject({ id, status: "open", waited: true });
  }, 25_000);
});

// SPDX-License-Identifier: Apache-2.0
// The two badge-facing folds and the live retention-facing one, over the real daemon (#153,
// contract A3 and A3b).
//
// Why two separate badge assertions rather than one. `spa/src/agent-feedback.js` renders
// `connection.workspace.pending_count ?? wiring.pending_count` — the `GET /api/status` workspace
// row FIRST, and `GET /w/:slug/wiring` only as a fallback. Those are two distinct call sites of
// the badge-facing fold, so each gets its own assertion reading its own value; excluding at one
// and asserting at the other would be a guard whose value proves nothing.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    // This field, not `wiring.pending_count`, is the one `agent-feedback.js` prefers.
    expect(row.pending_count).toBe(1);
  });

  it("the wiring fallback (GET /w/:slug/wiring) excludes it too, read from its own endpoint", async () => {
    const { slug, dir } = await openWorkspace();
    writeFileSync(
      join(dir, ".glosa", "journal.ndjson"),
      `${entryLine("inb-annotation", "annotation", 3)}\n${entryLine("inb-external", EXTERNAL_EDIT_KIND, 4)}\n`,
    );

    const wiring = await (await authed(`/w/${slug}/wiring`)).json();
    expect(wiring.pending_count).toBe(1);
  });

  it("a workspace whose ONLY entry is an external_edit shows a badge of zero on both surfaces", async () => {
    const { slug, dir } = await openWorkspace();
    writeFileSync(join(dir, ".glosa", "journal.ndjson"), `${entryLine("inb-external", EXTERNAL_EDIT_KIND, 5)}\n`);

    const status = await (await authed("/api/status")).json();
    const row = status.workspaces.find((workspace: { slug: string }) => workspace.slug === slug);
    const wiring = await (await authed(`/w/${slug}/wiring`)).json();

    expect(row.pending_count).toBe(0);
    expect(wiring.pending_count).toBe(0);
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
});

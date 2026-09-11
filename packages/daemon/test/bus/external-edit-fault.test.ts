// SPDX-License-Identifier: Apache-2.0
// Contract A7 — the checkpoint→entry gap, against a real production daemon OS process.
//
// The quiet-window capture has a forced ordering: the entry names the commit it reports, so the
// commit is written first. A crash in that window is PERMANENT, not transient — `checkpoint()` is
// idempotent (A4 §F21: nothing staged → return HEAD, no commit), so neither the next quiet window
// nor offline catch-up on restart ever sees that diff again, and `selfHealInbox` repairs a
// different gap. What survives is shadow history, which is why the recovery compares the last
// emitted `until_checkpoint` against the current shadow HEAD.
//
// This kills a real daemon at the first durable write AFTER that commit (the inbox temp fsync,
// through the same explicit composition seam `real-daemon-fault.test.ts` uses), restarts a normal
// production daemon, and asserts the entry exists exactly once.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXTERNAL_EDIT_KIND } from "../../src/bus/external-edit.ts";
import { tokenPath } from "../../src/security/token.ts";
import { cleanupHome, freshHome, randomPort, spawnDaemon, stopDaemon, waitForHandshake } from "../helpers.ts";

const FIXTURE = fileURLToPath(new URL("../fixtures/fault-injected-daemon.ts", import.meta.url));
const TOKEN = "external-edit-fault-token-0123456789abcdef";
const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function openRequest(port: number, workspace: string): Request {
  return new Request(`http://127.0.0.1:${port}/api/workspaces/open`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Origin: `http://127.0.0.1:${port}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ path: workspace }),
  });
}

function journalEvents(workspace: string): Array<{ event: string; entry?: string; detail?: Record<string, unknown> }> {
  const path = join(workspace, ".glosa", "journal.ndjson");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function externalEditEntryIds(workspace: string): string[] {
  return journalEvents(workspace)
    .filter((event) => event.event === "entry_created" && event.detail?.payload_kind === EXTERNAL_EDIT_KIND)
    .map((event) => event.entry as string);
}

function inboxIds(workspace: string): string[] {
  const dir = join(workspace, ".glosa", "inbox");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length));
}

async function driftCommits(workspace: string): Promise<string[]> {
  const proc = Bun.spawn({
    cmd: [
      "git",
      `--git-dir=${join(workspace, ".glosa", "shadow.git")}`,
      `--work-tree=${workspace}`,
      "log",
      "--format=%H%x1f%(trailers:key=Glosa-Kind,valueonly,separator=%x2c)",
      "HEAD",
    ],
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\x1f"))
    .filter(([, kind]) => (kind ?? "").trim() === "auto_checkpoint")
    .map(([sha]) => sha as string);
}

describe("A7 — a crash between the drift checkpoint and its entry, over a real daemon process", () => {
  test("the killed daemon leaves a commit with no entry; a restart recovers it exactly once", async () => {
    const home = freshHome();
    const workspace = mkdtempSync(join(tmpdir(), "glosa-ee-fault-ws-"));
    roots.push(home, workspace);
    writeFileSync(tokenPath(home), TOKEN, { mode: 0o600 });
    writeFileSync(join(workspace, "notes.md"), "one\n");
    const port = randomPort();

    // `inbox:temp-fsynced` is the FIRST durable write after the drift commit, so a kill there
    // reproduces exactly the gap: commit on disk, no inbox payload, no `entry_created`.
    const killed = Bun.spawn({
      cmd: [process.execPath, FIXTURE, "inbox:temp-fsynced"],
      env: { ...Bun.env, GLOSA_HOME: home, GLOSA_PORT: String(port), GLOSA_CLASSF_PORT: String(port + 1) },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    let restarted: Bun.Subprocess | undefined;
    try {
      expect(await waitForHandshake(port, 15_000, killed)).not.toBeNull();
      // Registering the workspace is what starts its daemon-lifetime watcher — no stream is ever
      // opened here, which is the point of the amendment this criterion sits on.
      const opened = await (await fetch(openRequest(port, workspace))).json();
      expect(opened.slug).toBeString();

      // An external save, then the real 2-second quiet window.
      writeFileSync(join(workspace, "notes.md"), "one\ntwo\n");
      const exitCode = await Promise.race([killed.exited, Bun.sleep(20_000).then(() => null)]);
      expect(exitCode, "daemon never reached the injected checkpoint — no crash window observed").not.toBeNull();

      // The gap, as durable evidence: the drift commit landed, the entry did not.
      const orphaned = await driftCommits(workspace);
      expect(orphaned).toHaveLength(1);
      expect(externalEditEntryIds(workspace)).toEqual([]);
      expect(inboxIds(workspace)).toEqual([]);

      // A normal production daemon — no fault seam — recovers on its reconcile.
      restarted = spawnDaemon(home, port, { GLOSA_CLASSF_PORT: String(port + 1) });
      expect(await waitForHandshake(port, 15_000, restarted)).not.toBeNull();
      await fetch(openRequest(port, workspace));

      const recoveredIds = externalEditEntryIds(workspace);
      expect(recoveredIds).toHaveLength(1);
      expect(inboxIds(workspace)).toEqual(recoveredIds);

      const payload = JSON.parse(
        readFileSync(join(workspace, ".glosa", "inbox", `${recoveredIds[0]}.json`), "utf8"),
      ) as Record<string, unknown>;
      expect(payload.kind).toBe(EXTERNAL_EDIT_KIND);
      expect(payload.path).toBe("notes.md");
      expect(payload.until_checkpoint).toBe(orphaned[0]);
      // At restart the daemon cannot prove the edit was seen live, so it claims the lesser thing.
      expect(payload.source).toBe("offline_catchup");

      // Exactly once, not once per restart: a second reconcile must add nothing.
      await stopDaemon(home, restarted);
      restarted = spawnDaemon(home, port, { GLOSA_CLASSF_PORT: String(port + 1) });
      expect(await waitForHandshake(port, 15_000, restarted)).not.toBeNull();
      await fetch(openRequest(port, workspace));
      expect(externalEditEntryIds(workspace)).toEqual(recoveredIds);
      expect(inboxIds(workspace)).toEqual(recoveredIds);
    } finally {
      if (restarted) await stopDaemon(home, restarted);
      if (killed.exitCode === null) await stopDaemon(home, killed);
      cleanupHome(home);
    }
  }, 60_000);
});

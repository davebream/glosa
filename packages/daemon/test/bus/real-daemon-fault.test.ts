// SPDX-License-Identifier: Apache-2.0
// T8 storage/fault fidelity layer: a real production daemon OS process, composed through an
// explicit test-only injection seam, is killed at each write checkpoint in the immutable-inbox ->
// entry_created transaction. A fresh production daemon then reclaims the stale lock and reconciles
// the same durable workspace.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tokenPath } from "../../src/token.ts";
import { cleanupHome, freshHome, randomPort, spawnDaemon, stopDaemon, waitForHandshake } from "../helpers.ts";

const FIXTURE = fileURLToPath(new URL("../fixtures/fault-injected-daemon.ts", import.meta.url));
const TOKEN = "real-daemon-fault-token-0123456789abcdef";
const roots: string[] = [];

const CHECKPOINTS = [
  "inbox:temp-fsynced",
  "inbox:linked",
  "inbox:published",
  "journal:written",
  "journal:fsynced",
] as const;

function spawnFaultDaemon(home: string, port: number, checkpoint: (typeof CHECKPOINTS)[number]): Bun.Subprocess {
  return Bun.spawn({
    cmd: [process.execPath, FIXTURE, checkpoint],
    env: { ...Bun.env, GLOSA_HOME: home, GLOSA_PORT: String(port), GLOSA_CLASSF_PORT: String(port + 1) },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
}

function request(port: number, path: string, body: unknown): Request {
  return new Request(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Origin: `http://127.0.0.1:${port}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("T8 production daemon process kill/restart at immutable-inbox transaction write checkpoints", () => {
  for (const checkpoint of CHECKPOINTS) {
    test(`${checkpoint}: recovery is exactly one legal state and accepts the next durable write`, async () => {
      const home = freshHome();
      const workspace = mkdtempSync(join(tmpdir(), "glosa-real-fault-ws-"));
      roots.push(home, workspace);
      writeFileSync(tokenPath(home), TOKEN, { mode: 0o600 });
      writeFileSync(join(workspace, "notes.md"), "# Durable\n");
      const port = randomPort();

      const killed = spawnFaultDaemon(home, port, checkpoint);
      let restarted: Bun.Subprocess | undefined;
      try {
        expect(await waitForHandshake(port, 15_000, killed)).not.toBeNull();
        const opened = await (await fetch(request(port, "/api/workspaces/open", { path: workspace }))).json();
        expect(opened.slug).toBeString();

        const mutation = fetch(
          request(port, "/api/workspaces/attention-request", {
            path: workspace,
            message: `kill at ${checkpoint}`,
            target_path: "notes.md",
          }),
        ).catch(() => null);
        const exitCode = await Promise.race([killed.exited, Bun.sleep(5_000).then(() => null)]);
        expect(exitCode, `daemon never reached injected checkpoint ${checkpoint}`).not.toBeNull();
        await mutation;

        restarted = spawnDaemon(home, port, { GLOSA_CLASSF_PORT: String(port + 1) });
        expect(await waitForHandshake(port, 15_000, restarted)).not.toBeNull();
        await fetch(request(port, "/api/workspaces/open", { path: workspace }));

        const inboxDir = join(workspace, ".glosa", "inbox");
        const inboxIds = existsSync(inboxDir)
          ? readdirSync(inboxDir)
              .filter((name) => name.endsWith(".json"))
              .map((name) => name.slice(0, -5))
          : [];
        const tempFiles = existsSync(inboxDir) ? readdirSync(inboxDir).filter((name) => name.endsWith(".tmp")) : [];
        expect(tempFiles).toEqual([]);

        const journal = readFileSync(join(workspace, ".glosa", "journal.ndjson"), "utf8");
        const events = journal
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { event: string; entry?: string });
        const createdIds = events.filter((event) => event.event === "entry_created").map((event) => event.entry);

        if (checkpoint === "inbox:temp-fsynced") {
          expect(inboxIds).toEqual([]);
          expect(createdIds).toEqual([]);
        } else {
          expect(inboxIds).toHaveLength(1);
          expect(createdIds).toEqual(inboxIds);
        }

        const next = await fetch(
          request(port, "/api/workspaces/attention-request", {
            path: workspace,
            message: "write after restart",
            target_path: "notes.md",
          }),
        );
        expect(next.status).toBe(201);
      } finally {
        if (restarted) await stopDaemon(home, restarted);
        if (killed.exitCode === null) await stopDaemon(home, killed);
        cleanupHome(home);
      }
    }, 30_000);
  }
});

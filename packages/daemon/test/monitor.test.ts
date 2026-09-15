// SPDX-License-Identifier: Apache-2.0
// Real plugin-monitor process against a real daemon. The owned stdout line and journal event are
// the synchronization points; no fixed sleep stands in for delivery.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadToken } from "../src/security/token.ts";
import { type WorkspaceIndexFile, workspaceIndexPath } from "../src/registry/workspace-index.ts";
import { randomPort, spawnDaemon, stopDaemon, waitForHandshake, waitUntil } from "./helpers.ts";

const MAIN = join(import.meta.dir, "../../cli/src/main.ts");
const PLUGIN_ROOT = join(import.meta.dir, "../../../glosa-plugin");

describe("Claude monitor integration", () => {
  test("real glosa monitor idles until glosa open, streams parked entries, reconnects after restart, and never replaces the daemon", async () => {
    const home = mkdtempSync(join(tmpdir(), "glosa-monitor-real-home-"));
    const projectPath = mkdtempSync(join(tmpdir(), "glosa-monitor-real-project-"));
    const project = realpathSync(projectPath);
    const port = randomPort();
    writeFileSync(join(project, "notes.md"), "A sentence for review.\n");
    let daemon = spawnDaemon(home, port);
    const handshake = await waitForHandshake(port, 10_000, daemon);
    expect(handshake).not.toBeNull();
    const daemonPid = handshake!.pid;
    const env = {
      ...Bun.env,
      GLOSA_HOME: home,
      GLOSA_PORT: String(port),
      CLAUDE_CODE_SESSION_ID: "monitor-real-session",
    } as Record<string, string>;
    const monitor = Bun.spawn({
      cmd: [process.execPath, MAIN, "monitor", "--plugin-root", PLUGIN_ROOT, "--project-dir", project],
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      expect(existsSync(workspaceIndexPath(home))).toBe(false);
      const opened = Bun.spawnSync({
        cmd: [process.execPath, MAIN, "open", "--url", project],
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(opened.exitCode).toBe(0);

      const index = JSON.parse(readFileSync(workspaceIndexPath(home), "utf8")) as WorkspaceIndexFile;
      const workspace = Object.values(index.workspaces).find((entry) => entry.canonical_path === project);
      expect(workspace).toBeDefined();
      const token = loadToken(home)!;
      const base = `http://127.0.0.1:${port}`;
      const created = await fetch(`${base}/w/${workspace!.slug}/annotations`, {
        method: "POST",
        headers: {
          Host: `127.0.0.1:${port}`,
          Origin: base,
          Authorization: `Bearer ${token}`,
          "X-Contract-Version": "1.0",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          kind: "annotation",
          artifact_path: "notes.md",
          body: "Please make this more specific.",
          intent: "content",
          target: { quote: { exact: "sentence" }, position: { start: 2, end: 10 } },
        }),
      });
      expect(created.status).toBe(201);
      const entryId = ((await created.json()) as { id: string }).id;

      const reader = monitor.stdout.getReader();
      const decoder = new TextDecoder();
      let output = "";
      const received = await Promise.race([
        (async () => {
          while (!output.includes("\n")) {
            const chunk = await reader.read();
            if (chunk.done) return false;
            output += decoder.decode(chunk.value);
          }
          return true;
        })(),
        Bun.sleep(8_000).then(() => false),
      ]);
      expect(received).toBe(true);
      expect(output).toStartWith(`[glosa ${entryId}] `);
      expect(output.trim().split("\n")).toHaveLength(1);
      expect(handshake!.pid).toBe(daemonPid);

      const journal = join(workspace!.bus_path, "journal.ndjson");
      expect(
        await waitUntil(() => {
          try {
            return (
              readFileSync(journal, "utf8").includes('"via":"monitor"') &&
              readFileSync(journal, "utf8").includes('"outcome":"transport_accepted"')
            );
          } catch {
            return false;
          }
        }, 3_000),
      ).toBe(true);

      await stopDaemon(home, daemon);
      daemon = spawnDaemon(home, port);
      const restarted = await waitForHandshake(port, 10_000, daemon);
      expect(restarted).not.toBeNull();
      expect(restarted!.pid).not.toBe(daemonPid);
      const second = await fetch(`${base}/w/${workspace!.slug}/annotations`, {
        method: "POST",
        headers: {
          Host: `127.0.0.1:${port}`,
          Origin: base,
          Authorization: `Bearer ${token}`,
          "X-Contract-Version": "1.0",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          kind: "annotation",
          artifact_path: "notes.md",
          body: "Delivered after daemon restart.",
          intent: "content",
          target: { quote: { exact: "review" }, position: { start: 15, end: 21 } },
        }),
      });
      expect(second.status).toBe(201);
      const secondId = ((await second.json()) as { id: string }).id;
      const reconnected = await Promise.race([
        (async () => {
          while (!output.includes(`[glosa ${secondId}] `)) {
            const chunk = await reader.read();
            if (chunk.done) return false;
            output += decoder.decode(chunk.value);
          }
          return true;
        })(),
        Bun.sleep(9_000).then(() => false),
      ]);
      expect(reconnected).toBe(true);
    } finally {
      if (monitor.exitCode === null) monitor.kill("SIGTERM");
      await monitor.exited;
      await stopDaemon(home, daemon);
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  }, 20_000);
});

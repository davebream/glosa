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

/** Continuously drains one owned process's stdout into a growing line array in the background —
 * never read on demand, so two processes' output can be told apart even when they arrive
 * interleaved. Counting happens per OWN process's stream (issue #206 review lesson: "count lines
 * per process from its own stdout"). */
/** `lines` is what the assertions read; `stamped` carries the same lines with the millisecond each
 * arrived, which is what a CI-only failure needs to be diagnosable — whether the displaced side
 * came back through its park probe or through an ordinary retry is a question about WHEN (#206,
 * run 35039592341, where neither could be told apart from the retained log). */
function trackLines(stream: ReadableStream<Uint8Array>): {
  lines: string[];
  stamped: string[];
  done: Promise<void>;
} {
  const startedAt = Date.now();
  const stamped: string[] = [];
  const lines: string[] = [];
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const done = (async () => {
    for (;;) {
      const { done: finished, value } = await reader.read();
      if (finished) return;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n");
      while (boundary >= 0) {
        lines.push(buffer.slice(0, boundary));
        stamped.push(`+${String(Date.now() - startedAt).padStart(6)}ms ${buffer.slice(0, boundary).slice(0, 120)}`);
        buffer = buffer.slice(boundary + 1);
        boundary = buffer.indexOf("\n");
      }
    }
  })();
  return { lines, stamped, done };
}

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

  test("#206: two real glosa monitor processes sharing one session converge — the displaced one prints at most once and never ping-pongs; killing the owner lets the parked one re-acquire within 30s; a daemon restart still reconnects it", async () => {
    const home = mkdtempSync(join(tmpdir(), "glosa-monitor-two-home-"));
    const projectPath = mkdtempSync(join(tmpdir(), "glosa-monitor-two-project-"));
    const project = realpathSync(projectPath);
    const port = randomPort();
    const SENTENCES = [
      "Alpha remark stands here.",
      "Bravo clause continues.",
      "Charlie notion follows.",
      "Delta insight arrives.",
      "Echo thought completes.",
    ];
    const content = `${SENTENCES.join(" ")}\n`;
    writeFileSync(join(project, "notes.md"), content);

    let daemon = spawnDaemon(home, port);
    const handshake = await waitForHandshake(port, 10_000, daemon);
    expect(handshake).not.toBeNull();
    const daemonPid = handshake!.pid;
    const sessionId = "two-monitor-session";
    const env = {
      ...Bun.env,
      GLOSA_HOME: home,
      GLOSA_PORT: String(port),
      CLAUDE_CODE_SESSION_ID: sessionId,
    } as Record<string, string>;

    function spawnMonitor() {
      return Bun.spawn({
        cmd: [process.execPath, MAIN, "monitor", "--plugin-root", PLUGIN_ROOT, "--project-dir", project],
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
    }

    const monitorA = spawnMonitor();
    const trackA = trackLines(monitorA.stdout);
    const errorsA = trackLines(monitorA.stderr);
    let monitorB: ReturnType<typeof spawnMonitor> | undefined;
    let trackB: ReturnType<typeof trackLines> | undefined;
    let errorsB: ReturnType<typeof trackLines> | undefined;

    try {
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

      async function createEntry(word: string): Promise<string> {
        const start = content.indexOf(word);
        expect(start).toBeGreaterThanOrEqual(0);
        const res = await fetch(`${base}/w/${workspace!.slug}/annotations`, {
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
            body: `Please clarify "${word}".`,
            intent: "content",
            target: { quote: { exact: word }, position: { start, end: start + word.length } },
          }),
        });
        expect(res.status).toBe(201);
        return ((await res.json()) as { id: string }).id;
      }

      // 1. Monitor A alone: it must own the very first entry.
      const id1 = await createEntry("remark");
      expect(await waitUntil(() => trackA.lines.some((l) => l.includes(`[glosa ${id1}] `)), 8_000)).toBe(true);

      // 2. Monitor B joins with the SAME session id — the daemon displaces A's push connection.
      monitorB = spawnMonitor();
      trackB = trackLines(monitorB.stdout);
      errorsB = trackLines(monitorB.stderr);

      // `id1` is only `transport_accepted`, never MCP-`presented` (out of scope: re-emission to a
      // fresh connection's empty `sent` set, #206's "amplifier"), so B's own pump necessarily
      // re-emits it the moment its connection becomes the registry's live one. That re-emission is
      // this test's OWN deterministic proof that displacement is now complete — not a race guess.
      expect(await waitUntil(() => trackB!.lines.some((l) => l.includes(`[glosa ${id1}] `)), 8_000)).toBe(true);

      // 3. Bounded settle window with NO new work: `id1` is still only `transport_accepted`, so if
      // A ever reconnects on its own (an ablated build's ordinary retry floor is 5s), it would
      // immediately re-fetch and reprint it — the exact amplifier this test uses as its displacement
      // proof above, now used as a NEGATIVE proof of no alternation. The fix's park probe floor is
      // 15s, comfortably outside this window, so a correct build reconnects only much later — this
      // window must end well before that. 12s covers more than two ordinary-retry cycles at the 5s
      // floor without reaching the park probe's own earliest possible firing.
      await Bun.sleep(12_000);
      expect(trackA.lines.filter((l) => l.includes(`[glosa ${id1}] `))).toHaveLength(1);

      // 4. Ownership keeps working going forward, and stays with B alone — the displaced side must
      // not alternate back in even once, however long it keeps discovering the same daemon/workspace
      // on every parked probe.
      const id2 = await createEntry("clause");
      expect(await waitUntil(() => trackB!.lines.some((l) => l.includes(`[glosa ${id2}] `)), 8_000)).toBe(true);
      // Compared as an object carrying both timelines: when this fails on a runner nobody can
      // attach to, the message itself has to say WHEN each side printed what, since that is what
      // separates "the displaced side re-acquired through its probe" from "it never parked and
      // took an ordinary retry".
      expect({
        aPrintedId2: trackA.lines.filter((l) => l.includes(`[glosa ${id2}] `)).length,
        aTimeline: trackA.stamped,
        bTimeline: trackB!.stamped,
      }).toEqual({ aPrintedId2: 0, aTimeline: trackA.stamped, bTimeline: trackB!.stamped });

      const id3 = await createEntry("notion");
      expect(await waitUntil(() => trackB!.lines.some((l) => l.includes(`[glosa ${id3}] `)), 8_000)).toBe(true);
      expect(trackA.lines.filter((l) => l.includes(`[glosa ${id3}] `))).toHaveLength(0);
      // The FIRST entry is still the only thing A ever printed — not reprinted, not alternated.
      const aDeliveryLines = trackA.lines.filter((l) => l.includes("[glosa "));
      expect(aDeliveryLines).toHaveLength(1);
      expect(aDeliveryLines[0]).toInclude(`[glosa ${id1}] `);

      // 5. Kill the owner (B). The parked side (A) must re-acquire within 30s (<=18s probe window
      // plus its own reconnect), with no daemon restart involved.
      monitorB.kill("SIGTERM");
      await monitorB.exited;
      const id4 = await createEntry("insight");
      expect(await waitUntil(() => trackA.lines.some((l) => l.includes(`[glosa ${id4}] `)), 30_000)).toBe(true);

      // 6. A daemon restart still reconnects the (now sole) owner, same as the single-monitor case.
      await stopDaemon(home, daemon);
      daemon = spawnDaemon(home, port);
      const restarted = await waitForHandshake(port, 10_000, daemon);
      expect(restarted).not.toBeNull();
      expect(restarted!.pid).not.toBe(daemonPid);
      const id5 = await createEntry("thought");
      expect(await waitUntil(() => trackA.lines.some((l) => l.includes(`[glosa ${id5}] `)), 10_000)).toBe(true);
    } catch (error) {
      throw new Error(
        `${error}\n${JSON.stringify(
          {
            a: {
              pid: monitorA.pid,
              exitCode: monitorA.exitCode,
              signal: monitorA.signalCode,
              stdout: trackA.stamped,
              stderr: errorsA.stamped,
            },
            b: monitorB
              ? {
                  pid: monitorB.pid,
                  exitCode: monitorB.exitCode,
                  signal: monitorB.signalCode,
                  stdout: trackB?.stamped,
                  stderr: errorsB?.stamped,
                }
              : null,
          },
          null,
          2,
        )}`,
        { cause: error },
      );
    } finally {
      if (monitorA.exitCode === null) monitorA.kill("SIGTERM");
      await monitorA.exited;
      if (monitorB && monitorB.exitCode === null) monitorB.kill("SIGTERM");
      if (monitorB) await monitorB.exited;
      await Promise.all([trackA.done, errorsA.done, trackB?.done, errorsB?.done]);
      await stopDaemon(home, daemon);
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  }, 80_000);
});

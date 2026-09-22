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

  // #306: three things now start a monitor for one Claude session — the plugin's `always` entry,
  // its `on-skill-invoke:glosa-connect` entry, and the skill's own Monitor-tool fallback. Before
  // the singleton guard this test proved the DISPLACEMENT that resulted, using monitor B's
  // re-emission of an already-transport-accepted entry as the proof. That re-emission was also
  // the user-visible defect: the same `[glosa <id>]` line twice. The guard removes the cause, so
  // the old proof is now unreachable by construction and this test proves the guard instead.
  //
  // Displacement itself is deliberately NOT removed from the daemon (it is the only recovery from
  // a wedged incumbent, and Codex shares that rail); it is covered where it lives, in
  // `agent-provider/push-registry.test.ts` and the monitor's own park unit tests.
  test("#306: a second glosa monitor for one session never attaches — it exits quietly, the first keeps the stream, and killing the owner (even with SIGKILL) frees the slot for a fresh one", async () => {
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

    // `legacyArgs` spawns the form an already-installed `monitors.json` still sends; the default
    // is the form the `glosa-connect` skill can actually produce, which has no CLAUDE_PLUGIN_ROOT
    // to pass. Both must work, so both are exercised here.
    function spawnMonitor(legacyArgs = false) {
      const args = legacyArgs ? ["--plugin-root", PLUGIN_ROOT, "--project-dir", project] : ["--project-dir", project];
      return Bun.spawn({
        cmd: [process.execPath, MAIN, "monitor", ...args],
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
    }

    const monitorA = spawnMonitor(true);
    const trackA = trackLines(monitorA.stdout);
    const errorsA = trackLines(monitorA.stderr);
    let monitorB: ReturnType<typeof spawnMonitor> | undefined;
    let trackB: ReturnType<typeof trackLines> | undefined;
    let errorsB: ReturnType<typeof trackLines> | undefined;
    let monitorC: ReturnType<typeof spawnMonitor> | undefined;
    let trackC: ReturnType<typeof trackLines> | undefined;
    let errorsC: ReturnType<typeof trackLines> | undefined;

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

      // 2. Monitor B joins with the SAME session id. The guard must stop it before it registers:
      // it exits 0, and — critically — prints NOTHING on stdout, because a monitor's stdout lines
      // are messages in the user's conversation. It says why on stderr, where `doctor` can look.
      monitorB = spawnMonitor();
      trackB = trackLines(monitorB.stdout);
      errorsB = trackLines(monitorB.stderr);
      // Bounded, not a bare `await monitorB.exited`: without the guard B never exits at all, and
      // an unbounded await would surface that as a suite timeout naming nothing. Asserted as an
      // object so the ablated build reports WHAT B did instead — still running, and streaming.
      const bExit = await Promise.race([monitorB.exited, Bun.sleep(15_000).then(() => "still-running")]);
      expect({ bExit, bDeliveryLines: trackB.lines.filter((l) => l.includes("[glosa ")) }).toEqual({
        bExit: 0,
        bDeliveryLines: [],
      });
      await Promise.all([trackB.done, errorsB.done]);
      expect(errorsB.lines.join("\n")).toInclude(`session ${sessionId} already has a live monitor`);

      // 3. Ownership never moved, so `id1` was never re-emitted. Before the guard, B's fresh
      // connection re-sent it the instant it displaced A — that duplicate was this test's old
      // proof of displacement AND the defect #306 is about. Ablating the guard restores both.
      await Bun.sleep(2_000);
      expect(trackA.lines.filter((l) => l.includes(`[glosa ${id1}] `))).toHaveLength(1);

      // 4. A is still the owner and still delivers. Compared as an object carrying the timeline,
      // because when this fails on a runner nobody can attach to, the message itself has to say
      // when each side printed what.
      const id2 = await createEntry("clause");
      expect(await waitUntil(() => trackA.lines.some((l) => l.includes(`[glosa ${id2}] `)), 8_000)).toBe(true);
      expect({
        bDeliveryLines: trackB!.lines.filter((l) => l.includes("[glosa ")).length,
        aTimeline: trackA.stamped,
      }).toEqual({ bDeliveryLines: 0, aTimeline: trackA.stamped });

      // 5. SIGKILL the owner. This is the property a pid-file lock cannot offer: the holder gets
      // no chance to clean up, yet the kernel drops its `flock` with the process, so a fresh
      // monitor acquires immediately rather than waiting out a staleness heuristic. Delivery
      // resumes on the NEW process with no daemon restart involved.
      monitorA.kill("SIGKILL");
      await monitorA.exited;
      monitorC = spawnMonitor();
      trackC = trackLines(monitorC.stdout);
      errorsC = trackLines(monitorC.stderr);
      const id3 = await createEntry("notion");
      expect(await waitUntil(() => trackC!.lines.some((l) => l.includes(`[glosa ${id3}] `)), 30_000)).toBe(true);

      // 6. A daemon restart still reconnects the (now sole) owner, same as the single-monitor case.
      await stopDaemon(home, daemon);
      daemon = spawnDaemon(home, port);
      const restarted = await waitForHandshake(port, 10_000, daemon);
      expect(restarted).not.toBeNull();
      expect(restarted!.pid).not.toBe(daemonPid);
      const id5 = await createEntry("thought");
      expect(await waitUntil(() => trackC!.lines.some((l) => l.includes(`[glosa ${id5}] `)), 10_000)).toBe(true);
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
            c: monitorC
              ? {
                  pid: monitorC.pid,
                  exitCode: monitorC.exitCode,
                  signal: monitorC.signalCode,
                  stdout: trackC?.stamped,
                  stderr: errorsC?.stamped,
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
      if (monitorC && monitorC.exitCode === null) monitorC.kill("SIGTERM");
      if (monitorC) await monitorC.exited;
      await Promise.all([trackA.done, errorsA.done, trackB?.done, errorsB?.done, trackC?.done, errorsC?.done]);
      await stopDaemon(home, daemon);
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  }, 80_000);
});

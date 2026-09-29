// SPDX-License-Identifier: Apache-2.0
// The install lifetime policy against a real daemon (#432, docs/design/2026-09-29-install-lifetime-
// and-restart.md). Each test stages an installed copy of glosa's sources in a temp dir (no
// packages/daemon/test, so it is not a source checkout), starts a daemon from it through that copy's
// own CLI, and then changes the copy underneath the running daemon, the way a package manager does.
import { afterEach, describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeBuildId } from "../src/lifecycle/build-id.ts";
import {
  lockOf,
  randomPort,
  stopDetachedDaemon,
  superviseDaemonHome,
  trackDetachedDaemon,
  waitUntil,
} from "./helpers.ts";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const scratch: string[] = [];
const running: { home: string; pid: number; instanceId: string }[] = [];

afterEach(async () => {
  for (const daemon of running.splice(0)) {
    if (lockOf(daemon.home)?.pid === daemon.pid) await stopDetachedDaemon(daemon.home, daemon);
  }
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Stage {
  root: string;
  home: string;
  port: number;
  workspace: string;
  cli: (args: string[], env?: Record<string, string>) => { code: number; stdout: string; stderr: string };
}

/** An installed copy of glosa: the published source trees and package.json, with the checkout's
 *  node_modules linked in (a symlink the guard records but never follows). */
function stage(options: { sourceCheckout?: boolean } = {}): Stage {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "glosa-lifetime-")));
  scratch.push(base);
  const root = join(base, "install");
  for (const dir of ["packages/cli/src", "packages/daemon/src", "packages/spa/src"]) {
    cpSync(join(REPO, dir), join(root, dir), { recursive: true });
  }
  for (const provider of ["claude-code", "codex", "wispr-flow"]) {
    cpSync(join(REPO, "packages/providers", provider, "src"), join(root, "packages/providers", provider, "src"), {
      recursive: true,
    });
  }
  cpSync(join(REPO, "package.json"), join(root, "package.json"));
  symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"));
  if (options.sourceCheckout) mkdirSync(join(root, "packages", "daemon", "test"), { recursive: true });
  const home = join(base, "home");
  const workspace = join(base, "workspace");
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "notes.md"), "# Notes\n\nA paragraph.\n");
  const port = randomPort();
  superviseDaemonHome(home);
  const cli = (args: string[], env: Record<string, string> = {}) => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, join(root, "packages", "cli", "src", "main.ts"), ...args],
      env: {
        HOME: base,
        PATH: Bun.env.PATH ?? "/usr/bin:/bin",
        GLOSA_HOME: home,
        GLOSA_PORT: String(port),
        GLOSA_INSTALL_SWEEP_MS: "100",
        // The copy is seconds old; only the boot-refusal test wants it to count as "changing".
        GLOSA_INSTALL_BOOT_MARGIN_MS: "0",
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: result.exitCode ?? -1, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  };
  return { root, home, port, workspace, cli };
}

/** Opens the workspace through the staged CLI, which spawns a detached daemon from the copy. */
function openWorkspace(s: Stage): { pid: number; instanceId: string; buildId: string } {
  const opened = s.cli(["open", s.workspace, "--url", "--json"]);
  expect(opened.code, opened.stderr + opened.stdout).toBe(0);
  const lock = lockOf(s.home);
  if (!lock) throw new Error("no daemon lock after glosa open");
  const daemon = { home: s.home, pid: lock.pid, instanceId: lock.instance_id };
  trackDetachedDaemon(s.home, daemon);
  running.push(daemon);
  return { pid: lock.pid, instanceId: lock.instance_id, buildId: lock.build_id as string };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Fetches an SPA asset until the daemon is gone, recording every status and body it answered. */
async function pollAsset(
  port: number,
  path: string,
  until: () => boolean,
): Promise<{ status: number; body: string }[]> {
  const seen: { status: number; body: string }[] = [];
  const deadline = Date.now() + 15_000;
  while (!until() && Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(1000) });
      seen.push({ status: res.status, body: await res.text() });
    } catch {
      // refused while the listener closes: never a response from another build
    }
    await Bun.sleep(25);
  }
  return seen;
}

const daemonLog = (s: Stage) => readFileSync(join(s.home, "daemon.log"), "utf8");

describe("an installed daemon whose install changes under it (#432)", () => {
  test("T1 upgrade in place: old bytes only, a graceful exit, and the next command starts the new build with state intact", async () => {
    const s = stage();
    const first = openWorkspace(s);
    const asset = join(s.root, "packages", "spa", "src", "bootstrap.js");
    const original = readFileSync(asset, "utf8");
    const registry = readFileSync(join(s.home, "workspaces.json"), "utf8");
    const token = readFileSync(join(s.home, "token"), "utf8");

    // A package manager's write: new bytes renamed over the file.
    writeFileSync(`${asset}.new`, `${original}\n// the next build\n`);
    renameSync(`${asset}.new`, asset);
    const seen = await pollAsset(s.port, "/app/bootstrap.js", () => !pidAlive(first.pid));

    expect(await waitUntil(() => !pidAlive(first.pid), 10_000), "daemon did not retire after its install changed").toBe(
      true,
    );
    expect(seen.length).toBeGreaterThan(0);
    for (const answer of seen) {
      expect(answer.status, "the old daemon answered with an error while retiring").toBe(200);
      expect(answer.body === original, "the old daemon served bytes of the new tree").toBe(true);
    }
    expect(existsSync(join(s.home, "daemon.lock"))).toBe(false);
    const log = daemonLog(s);
    expect(log).toContain("install changed");
    expect(log).toContain(`${first.instanceId} graceful shutdown complete`);
    expect(log).not.toContain("forced shutdown complete");

    const status = s.cli(["status", "--json"]);
    expect(status.code, status.stderr + status.stdout).toBe(0);
    const next = lockOf(s.home);
    if (!next) throw new Error("no daemon after the next command");
    const nextDaemon = { home: s.home, pid: next.pid, instanceId: next.instance_id };
    trackDetachedDaemon(s.home, nextDaemon);
    running.push(nextDaemon);
    expect(next.instance_id).not.toBe(first.instanceId);
    expect(next.build_id).toBe(computeBuildId(s.root));
    expect(next.build_id).not.toBe(first.buildId);
    expect(readFileSync(join(s.home, "workspaces.json"), "utf8")).toBe(registry);
    expect(readFileSync(join(s.home, "token"), "utf8")).toBe(token);
  }, 45_000);

  test("T2 removal: the daemon never answers with an error and retires gracefully once its tree is gone", async () => {
    const s = stage();
    const daemon = openWorkspace(s);
    rmSync(s.root, { recursive: true, force: true });
    const seen = await pollAsset(s.port, "/app/bootstrap.js", () => !pidAlive(daemon.pid));
    expect(
      await waitUntil(() => !pidAlive(daemon.pid), 10_000),
      "daemon did not retire after its tree was removed",
    ).toBe(true);
    for (const answer of seen) expect(answer.status, "a removed tree produced an error response").toBe(200);
    expect(existsSync(join(s.home, "daemon.lock"))).toBe(false);
    expect(daemonLog(s)).toContain(`${daemon.instanceId} graceful shutdown complete`);
  }, 45_000);

  test("T3 boot refusal: a daemon started while its tree is changing exits 5 and the CLI says to run it again", () => {
    const s = stage();
    // A 10-minute margin makes the seconds-old copy count as "changed while loading".
    const status = s.cli(["status", "--json"], { GLOSA_INSTALL_BOOT_MARGIN_MS: "600000" });
    // `glosa status` never fails; it reports an unreachable daemon and why.
    const data = (JSON.parse(status.stdout) as { data: { daemon_reachable: boolean; reason?: string } }).data;
    expect(data.daemon_reachable).toBe(false);
    expect(data.reason).toContain("glosa's files changed while it was starting");
    expect(lockOf(s.home)).toBeNull();
    expect(daemonLog(s)).toContain("install changed during boot");
  }, 45_000);

  test("C1 control: a source checkout is never guarded; it serves the edit and keeps running", async () => {
    const s = stage({ sourceCheckout: true });
    const daemon = openWorkspace(s);
    const asset = join(s.root, "packages", "spa", "src", "bootstrap.js");
    writeFileSync(asset, `${readFileSync(asset, "utf8")}\n// an edit\n`);
    await Bun.sleep(600); // six sweep intervals
    expect(pidAlive(daemon.pid)).toBe(true);
    const res = await fetch(`http://127.0.0.1:${s.port}/app/bootstrap.js`);
    expect(await res.text()).toContain("// an edit");
  }, 45_000);
});

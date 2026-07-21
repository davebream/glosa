// SPDX-License-Identifier: Apache-2.0
// P5.1 — `glosa doctor [dir] --json` (A6 §F26/§F30): 12 enumerated checks. Uses REAL directories
// and a REAL shadow-git repo (built the same way the daemon itself would, via `WorkspaceBus`) for
// the filesystem-level checks — only the daemon+proto check and the git/claude version PROBES are
// faked (this test must not depend on which git/claude version happens to be on the runner).
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tokenPath, WorkspaceBus } from "@glosa/daemon";
import type { GlosaApiClient } from "../src/api-client.ts";
import { printDoctorResult, runDoctor, type DoctorDeps } from "../src/doctor.ts";
import { runInit } from "../src/init.ts";
import { FakeGlosaApiClient, daemonUnreachable } from "./fake-api-client.ts";
import { captureStdout } from "./test-utils.ts";

let dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "glosa-doctor-test-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function realRunVersionProbe(cmd: string[]): string | null {
  try {
    const proc = Bun.spawnSync({ cmd, stdout: "pipe", stderr: "pipe" });
    if (!proc.success) return null;
    return proc.stdout.toString("utf8").trim();
  } catch {
    return null;
  }
}

function makeDeps(overrides: Partial<DoctorDeps> = {}): { deps: DoctorDeps; client: FakeGlosaApiClient; home: string } {
  const client = new FakeGlosaApiClient();
  const home = freshDir();
  const deps: DoctorDeps = {
    createClient: async () => client as unknown as GlosaApiClient,
    platform: () => "darwin",
    bunVersion: () => "1.2.7",
    which: (cmd) => (cmd === "git" ? "/usr/bin/git" : cmd === "open" ? "/usr/bin/open" : null),
    runVersionProbe: (cmd) => {
      if (cmd.includes("--version") && cmd[0] === "/usr/bin/git") return "git version 2.43.0";
      // the workspace check's own `git --git-dir=... rev-parse --verify -q HEAD` probe is real —
      // this test wants to prove doctor actually detects a real baseline commit, not a fake one.
      return realRunVersionProbe(cmd);
    },
    glosaHome: () => home,
    claudeConfigDir: () => freshDir(),
    ...overrides,
  };
  return { deps, client, home };
}

function findCheck(checks: { name: string; status: string; detail: string }[], name: string) {
  return checks.find((c) => c.name === name);
}

describe("glosa doctor", () => {
  test("non-darwin platform -> only the platform check runs, exit 5", async () => {
    const { deps } = makeDeps({ platform: () => "linux" });
    const dir = freshDir();
    const result = await runDoctor(dir, deps);
    expect(result.exitCode).toBe(5);
    expect(result.data.checks).toHaveLength(1);
    expect(result.data.checks[0]).toMatchObject({ name: "platform", status: "fail" });
  });

  test("token file with wrong permissions -> FAIL, overall exit 9 (degraded)", async () => {
    const { deps, home } = makeDeps();
    writeFileSync(tokenPath(home), "deadbeef", { mode: 0o644 });
    chmodSync(tokenPath(home), 0o644); // force the exact mode regardless of umask
    const dir = freshDir();
    const result = await runDoctor(dir, deps);
    const tokenCheck = findCheck(result.data.checks, "token/pairing");
    expect(tokenCheck?.status).toBe("fail");
    expect(result.exitCode).toBe(9);
    expect(statSync(tokenPath(home)).mode & 0o777).not.toBe(0o600);
  });

  test("token file absent -> WARN, not fail (not yet paired)", async () => {
    const { deps } = makeDeps();
    const dir = freshDir();
    const result = await runDoctor(dir, deps);
    expect(findCheck(result.data.checks, "token/pairing")?.status).toBe("warn");
  });

  test("workspace not yet opened (.glosa missing) -> WARN", async () => {
    const { deps } = makeDeps();
    const dir = freshDir();
    const result = await runDoctor(dir, deps);
    expect(findCheck(result.data.checks, "workspace")?.status).toBe("warn");
  });

  test("workspace opened (real shadow-git baseline) with a tracked artifact -> pass", async () => {
    const { deps } = makeDeps();
    const dir = freshDir();
    writeFileSync(join(dir, "notes.md"), "# hello\n");
    const bus = new WorkspaceBus(dir);
    await bus.reconcile(); // real initShadowRepo + baseline commit, same as the daemon's own resolveBus
    await bus.close();

    const result = await runDoctor(dir, deps);
    const workspaceCheck = findCheck(result.data.checks, "workspace");
    expect(workspaceCheck?.status).toBe("pass");
    expect(workspaceCheck?.detail).toContain("1 tracked artifact");
  });

  test("hooks: no manifest -> WARN; after `glosa init`, matches -> pass; after external drift -> FAIL", async () => {
    const { deps } = makeDeps();
    const dir = freshDir();

    const before = await runDoctor(dir, deps);
    expect(findCheck(before.data.checks, "hooks")?.status).toBe("warn");

    await runInit({ dir });
    const afterInit = await runDoctor(dir, deps);
    expect(findCheck(afterInit.data.checks, "hooks")?.status).toBe("pass");

    // Externally edit one of glosa's own hook entries — same "drift" `runUninstall` itself detects.
    const settingsPath = join(dir, ".claude", "settings.json");
    const settings = JSON.parse(await Bun.file(settingsPath).text());
    settings.hooks.SessionStart[0].hooks[0].timeout = 999;
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

    const afterDrift = await runDoctor(dir, deps);
    const hooksCheck = findCheck(afterDrift.data.checks, "hooks");
    expect(hooksCheck?.status).toBe("fail");
    expect(afterDrift.exitCode).toBe(9);
  });

  test("channel check is honestly reported as unverifiable (skip), never a fabricated pass", async () => {
    const { deps } = makeDeps();
    const dir = freshDir();
    const result = await runDoctor(dir, deps);
    expect(findCheck(result.data.checks, "channel")?.status).toBe("skip");
  });

  test("daemon+proto: unreachable daemon -> FAIL", async () => {
    const { deps } = makeDeps({ createClient: async () => { throw daemonUnreachable(); } });
    const dir = freshDir();
    const result = await runDoctor(dir, deps);
    expect(findCheck(result.data.checks, "daemon+proto")?.status).toBe("fail");
    expect(result.exitCode).toBe(9);
  });

  test("--json envelope has exactly the documented top-level keys", async () => {
    const { deps } = makeDeps();
    const dir = freshDir();
    const result = await runDoctor(dir, deps);
    const out = captureStdout(() => printDoctorResult(result, true));
    const parsed = JSON.parse(out);
    expect(Object.keys(parsed).sort()).toEqual(["command", "data", "error", "exit_code", "glosa_json", "ok", "warnings"].sort());
    expect(parsed.command).toBe("doctor");
    expect(Array.isArray(parsed.data.checks)).toBe(true);
    expect(parsed.data.checks).toHaveLength(12);
  });
});

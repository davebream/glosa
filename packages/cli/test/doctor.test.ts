// SPDX-License-Identifier: Apache-2.0
// P5.1 — `glosa doctor [dir] --json` (A6 §F26/§F30): 15 enumerated checks. Uses REAL directories
// and a REAL shadow-git repo (built the same way the daemon itself would, via `WorkspaceBus`) for
// the filesystem-level checks — only the daemon+proto check and the git/claude version PROBES are
// faked (this test must not depend on which git/claude version happens to be on the runner).
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tokenPath, WorkspaceBus } from "@glosa/daemon";
import type { GlosaApiClient } from "../src/api-client.ts";
import { type DoctorDeps, printDoctorResult, realDoctorDeps, runDoctor } from "../src/doctor.ts";
import { runInit } from "../src/init.ts";
import { daemonUnreachable, FakeGlosaApiClient } from "./fake-api-client.ts";
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
  test("realDoctorDeps wires ambient probes without touching the daemon", async () => {
    const marker = {} as GlosaApiClient;
    const home = freshDir();
    const deps = realDoctorDeps(async () => marker, () => home);

    expect(await deps.createClient()).toBe(marker);
    expect(deps.platform()).toBe(process.platform);
    expect(deps.bunVersion()).toBe(Bun.version);
    expect(deps.glosaHome()).toBe(home);
    expect(deps.which("bun")).toBe(Bun.which("bun", { PATH: Bun.env.PATH ?? "" }));
    expect(deps.runVersionProbe([join(home, "definitely-missing-binary"), "--version"])).toBeNull();
    expect(deps.claudeConfigDir()).toBeTruthy();
  });

  test("realDoctorDeps scrubs ANTHROPIC_API_KEY from successful version probes", () => {
    const secret = "w03-doctor-secret-sentinel";
    const control = "w03-doctor-control-sentinel";
    const modulePath = join(import.meta.dir, "../src/doctor.ts");
    const child = Bun.spawnSync({
      cmd: [
        process.execPath,
        "-e",
        `const { realDoctorDeps } = await import(${JSON.stringify(modulePath)});
         const output = realDoctorDeps(async () => ({}), () => "/tmp").runVersionProbe(["/usr/bin/env"]);
         process.stdout.write(JSON.stringify({ present: output !== null, control: output?.includes(${JSON.stringify(control)}) ?? false, secret: output?.includes(${JSON.stringify(secret)}) ?? false }));`,
      ],
      env: { ...Bun.env, ANTHROPIC_API_KEY: secret, W03_DOCTOR_CONTROL: control },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(child.success).toBe(true);
    expect(JSON.parse(child.stdout.toString("utf8"))).toEqual({ present: true, control: true, secret: false });
  });

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

  test("optional Channel check is honestly skipped without degrading fallback compatibility", async () => {
    const { deps } = makeDeps();
    const dir = freshDir();
    const result = await runDoctor(dir, deps);
    expect(findCheck(result.data.checks, "channel")?.status).toBe("skip");
    expect(findCheck(result.data.checks, "channel")?.detail).toContain("optional");
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
    expect(parsed.data.checks).toHaveLength(15);
  });

  test("pending-delivery: queued entries without wiring -> WARN; with wiring -> pass; daemon down -> SKIP", async () => {
    const { deps, client } = makeDeps();
    const dir = freshDir();
    client.statusResult.workspaces = [
      { slug: "ws", path: dir, last_seen: "2026-07-26T00:00:00Z", pending_count: 2, has_attention: false },
    ];

    // No init manifest -> hooks check warns -> queued entries are stranded.
    const stranded = await runDoctor(dir, deps);
    const strandedCheck = findCheck(stranded.data.checks, "pending-delivery");
    expect(strandedCheck?.status).toBe("warn");
    expect(strandedCheck?.detail).toContain("2 annotation(s)");
    expect(strandedCheck?.detail).toContain("delivery is not wired");

    // After init the hooks check passes -> same queue is merely pending, not stranded.
    await runInit({ dir });
    const wired = await runDoctor(dir, deps);
    expect(findCheck(wired.data.checks, "pending-delivery")?.status).toBe("pass");

    // Daemon unreachable -> SKIP, never a duplicate warn on top of check 6's fail.
    const { deps: downDeps } = makeDeps({ createClient: async () => { throw daemonUnreachable(); } });
    const down = await runDoctor(dir, downDeps);
    expect(findCheck(down.data.checks, "pending-delivery")?.status).toBe("skip");
  });

  test("orphaned-state: orphans reported -> WARN with recovery hint; none -> pass; daemon down -> SKIP", async () => {
    const { deps, client } = makeDeps();
    const dir = freshDir();

    const clean = await runDoctor(dir, deps);
    expect(findCheck(clean.data.checks, "orphaned-state")?.status).toBe("pass");

    client.statusResult.orphaned_state = [{ registration_id: "eb3b3cf9deadbeef", pending_count: 1 }];
    const orphaned = await runDoctor(dir, deps);
    const orphanCheck = findCheck(orphaned.data.checks, "orphaned-state");
    expect(orphanCheck?.status).toBe("warn");
    expect(orphanCheck?.detail).toContain("1 pending annotation(s) in 1 orphaned home-state dir(s)");
    expect(orphanCheck?.detail).toContain("glosa open");

    const { deps: downDeps } = makeDeps({ createClient: async () => { throw daemonUnreachable(); } });
    const down = await runDoctor(dir, downDeps);
    expect(findCheck(down.data.checks, "orphaned-state")?.status).toBe("skip");
  });

  test("mcp-enabled: no settings layers -> pass; enabled+defined -> pass; enabled-but-undefined -> WARN", async () => {
    const { deps } = makeDeps();
    const dir = freshDir();

    // No settings layers at all — nothing force-enables an undefined server.
    const bare = await runDoctor(dir, deps);
    expect(findCheck(bare.data.checks, "mcp-enabled")?.status).toBe("pass");

    // Init installs the .mcp.json entry; a local layer enabling "glosa" is then consistent.
    await runInit({ dir });
    writeFileSync(join(dir, ".claude", "settings.local.json"), JSON.stringify({ enabledMcpjsonServers: ["glosa"] }));
    const consistent = await runDoctor(dir, deps);
    expect(findCheck(consistent.data.checks, "mcp-enabled")?.status).toBe("pass");

    // Drop the .mcp.json definition while the enablement stays — the half-wired trap.
    const mcpPath = join(dir, ".mcp.json");
    const mcp = JSON.parse(await Bun.file(mcpPath).text());
    delete mcp.mcpServers.glosa;
    writeFileSync(mcpPath, JSON.stringify(mcp, null, 2));

    const trapped = await runDoctor(dir, deps);
    const trap = findCheck(trapped.data.checks, "mcp-enabled");
    expect(trap?.status).toBe("warn");
    expect(trap?.detail).toContain("settings.local.json");
    expect(trap?.detail).toContain("does not define it");
  });

  test("mcp-enabled: invalid settings layer JSON is tolerated (check still runs)", async () => {
    const { deps } = makeDeps();
    const dir = freshDir();
    await runInit({ dir });
    writeFileSync(join(dir, ".claude", "settings.local.json"), "{not json");
    const result = await runDoctor(dir, deps);
    expect(findCheck(result.data.checks, "mcp-enabled")?.status).toBe("pass");
  });
});

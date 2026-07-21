// P4.3 — `glosa init`'s transactional merge/backup/uninstall (A6 §F26). Every test drives
// `runInit`/`runUninstall` directly against a real tmp workspace dir (real fs, real JSON files) —
// no mocking of the merge logic itself, only of `resolveGlosaBin` (so hook command strings are
// deterministic across a test run) and, for the mid-run-failure case, the atomic writer (so a
// SPECIFIC file in the settings→mcp→manifest sequence can be made to fail without relying on OS
// permission tricks a sandboxed/root test runner might bypass).
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHANNEL_COMMAND,
  defaultResolveGlosaBin,
  runInit,
  runUninstall,
  type GlosaBinResolution,
} from "../src/init.ts";
import { BUILD_ID } from "../../daemon/src/build-id.ts";

let dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "glosa-init-test-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function settingsPathOf(dir: string): string {
  return join(dir, ".claude", "settings.json");
}
function mcpPathOf(dir: string): string {
  return join(dir, ".mcp.json");
}
function manifestPathOf(dir: string): string {
  return join(dir, ".claude", ".glosa-init.json");
}
function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}
function backupsFor(path: string): string[] {
  const dir = path.split("/").slice(0, -1).join("/");
  const base = `${path.split("/").pop()}.glosa-backup-`;
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith(base)) : [];
}

const BIN_A: GlosaBinResolution = { command: "glosa", args: [], mode: "path" };

/** The REAL bun-run fallback shape (A6 §F26) — a distinct `glosaRoot` per call so several of
 * these are still all mutually different commands while EACH ONE still matches glosa's in-band
 * hook signature (`hookRoleOf` in init.ts recognizes `bun run --silent .../packages/cli/src/
 * main.ts hook <role>` regardless of the specific root prefix). This is what a real GLOSA_BIN
 * change looks like — unlike an arbitrary/synthetic command string, which would never be
 * recognized as glosa's own and so could never be RECONCILED, only ever newly inserted. */
function bunRunBin(glosaRoot: string): GlosaBinResolution {
  return { command: "bun", args: ["run", "--silent", `${glosaRoot}/packages/cli/src/main.ts`], mode: "bun-run" };
}

describe("glosa init — fresh install", () => {
  test("creates settings.json + .mcp.json + .glosa-init.json with the exact F26 hook entries and prints the channel command", async () => {
    const dir = freshDir();
    const result = await runInit({ dir, resolveGlosaBin: () => BIN_A });

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.changed).toBe(true);
    expect(result.data.channel_command).toBe(CHANNEL_COMMAND);
    expect(result.data.channel_command).not.toContain("--channels");
    expect(result.data.files.settings.created).toBe(true);
    expect(result.data.files.mcp.created).toBe(true);
    expect(result.data.files.settings.backedUp).toBe(false); // nothing to back up — file didn't exist
    expect(result.data.files.mcp.backedUp).toBe(false);

    const settings = readJson(settingsPathOf(dir));
    const sessionStartGroup = settings.hooks.SessionStart[0];
    expect(sessionStartGroup.matcher).toBe("startup|resume|clear|compact");
    expect(sessionStartGroup.hooks).toEqual([
      { type: "command", command: "glosa hook session-start", timeout: 10 },
      { type: "command", command: "glosa hook rewake-watch", timeout: 0, asyncRewake: true },
    ]);
    expect(settings.hooks.SessionEnd[0].hooks[0]).toEqual({ type: "command", command: "glosa hook session-end", timeout: 5 });
    expect(settings.hooks.UserPromptSubmit[0].hooks[0]).toEqual({
      type: "command",
      command: "glosa hook user-prompt-submit",
      timeout: 10,
    });
    expect(settings.hooks.Stop[0].hooks[0]).toEqual({ type: "command", command: "glosa hook stop", timeout: 10 });
    expect(settings.hooks.Notification[0].hooks[0]).toEqual({
      type: "command",
      command: "glosa hook notification",
      timeout: 5,
    });

    const mcp = readJson(mcpPathOf(dir));
    expect(mcp.mcpServers.glosa).toEqual({ type: "stdio", command: "glosa", args: ["mcp"] });

    const manifest = readJson(manifestPathOf(dir));
    expect(manifest.version).toBe(1);
    expect(manifest.glosa_bin).toEqual(BIN_A);
    expect(manifest.files.settings.created).toBe(true);
    expect(manifest.files.mcp.created).toBe(true);
    expect(manifest.files.settings.inserted.length).toBe(6); // 2 SessionStart + 4 singles
    expect(manifest.files.mcp.inserted).toEqual([{ pointer: "/mcpServers/glosa", sha256: expect.any(String) }]);
  });

  test("a foreign sibling hook under the same event is left completely untouched", async () => {
    const dir = freshDir();
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      settingsPathOf(dir),
      JSON.stringify(
        { hooks: { Stop: [{ hooks: [{ type: "command", command: "my-other-tool check", timeout: 30 }] }] } },
        null,
        2,
      ),
    );

    await runInit({ dir, resolveGlosaBin: () => BIN_A });

    const settings = readJson(settingsPathOf(dir));
    const stopHooks = settings.hooks.Stop.flatMap((g: any) => g.hooks);
    expect(stopHooks).toContainEqual({ type: "command", command: "my-other-tool check", timeout: 30 });
    expect(stopHooks).toContainEqual({ type: "command", command: "glosa hook stop", timeout: 10 });
  });
});

describe("glosa init — hook reconciliation across a GLOSA_BIN change (P4.3 review fix #1)", () => {
  test("init(BIN_A) then init(BIN_B) RECONCILES the existing hooks in place — never duplicates them", async () => {
    const dir = freshDir();
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      settingsPathOf(dir),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "my-other-tool check", timeout: 30 }] }] } }, null, 2),
    );

    await runInit({ dir, resolveGlosaBin: () => BIN_A }); // path mode: "glosa hook <role>"
    const binB = bunRunBin("/opt/glosa"); // bun-run mode: "bun run --silent /opt/glosa/packages/cli/src/main.ts hook <role>"
    const result = await runInit({ dir, resolveGlosaBin: () => binB });

    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);

    const settings = readJson(settingsPathOf(dir));
    // Exactly 2 SessionStart hooks (not 4 — the reviewer's repro), exactly 1 Stop hook that's
    // OURS (plus the foreign one, untouched) — never a duplicate.
    expect(settings.hooks.SessionStart[0].hooks).toHaveLength(2);
    const ourStopHooks = settings.hooks.Stop.flatMap((g: any) => g.hooks).filter((h: any) => h.command.includes("hook stop"));
    expect(ourStopHooks).toHaveLength(1);

    // Updated TO binB's commands — BIN_A's old command string is gone entirely.
    const allCommands = Object.values(settings.hooks)
      .flatMap((groups: any) => groups.flatMap((g: any) => g.hooks))
      .map((h: any) => h.command);
    expect(allCommands).not.toContain("glosa hook session-start");
    expect(allCommands).toContain(`bun run --silent /opt/glosa/packages/cli/src/main.ts hook session-start`);
    expect(allCommands).toContain(`bun run --silent /opt/glosa/packages/cli/src/main.ts hook stop`);

    // The foreign hook is preserved byte-for-byte, untouched by the reconciliation.
    const stopHooks = settings.hooks.Stop.flatMap((g: any) => g.hooks);
    expect(stopHooks).toContainEqual({ type: "command", command: "my-other-tool check", timeout: 30 });

    // The manifest's recorded pointers were updated too (not duplicated) — same count as a fresh
    // install, not double.
    const manifest = readJson(manifestPathOf(dir));
    expect(manifest.files.settings.inserted).toHaveLength(6);
  });

  test("--force also reconciles drifted hooks (not just the MCP conflict path)", async () => {
    const dir = freshDir();
    await runInit({ dir, resolveGlosaBin: () => BIN_A });
    const binB = bunRunBin("/opt/glosa-2");
    const result = await runInit({ dir, resolveGlosaBin: () => binB, force: true });

    expect(result.changed).toBe(true);
    const settings = readJson(settingsPathOf(dir));
    expect(settings.hooks.SessionStart[0].hooks).toHaveLength(2);
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe(`bun run --silent /opt/glosa-2/packages/cli/src/main.ts hook session-start`);
  });

  test("re-running with the SAME (already-reconciled) bin a second time is a true no-op", async () => {
    const dir = freshDir();
    await runInit({ dir, resolveGlosaBin: () => BIN_A });
    const binB = bunRunBin("/opt/glosa-3");
    await runInit({ dir, resolveGlosaBin: () => binB });
    const again = await runInit({ dir, resolveGlosaBin: () => binB });
    expect(again.changed).toBe(false);
  });
});

describe("glosa init — idempotency", () => {
  test("a second init with nothing new to add: changed:false, exit 0, no backup taken", async () => {
    const dir = freshDir();
    await runInit({ dir, resolveGlosaBin: () => BIN_A });
    const second = await runInit({ dir, resolveGlosaBin: () => BIN_A });

    expect(second.ok).toBe(true);
    expect(second.exitCode).toBe(0);
    expect(second.changed).toBe(false);
    expect(backupsFor(settingsPathOf(dir))).toHaveLength(0);
    expect(backupsFor(mcpPathOf(dir))).toHaveLength(0);
  });
});

describe("glosa init — backups", () => {
  test("a genuine content change to an EXISTING file takes a backup; unrelated repeats retain at most 5", async () => {
    const dir = freshDir();
    await runInit({ dir, resolveGlosaBin: () => BIN_A }); // run 0 — creates the file (no backup)

    // Seven more runs, each a REAL bun-run GLOSA_BIN with a distinct root — still recognized as
    // glosa's own by `hookRoleOf`'s signature match, but genuinely different command text each
    // time, so every run reconciles the existing hooks in place (a real content change, and
    // therefore a backup of what came before).
    for (let i = 1; i <= 7; i++) {
      const bin = bunRunBin(`/glosa-root-${i}`);
      const at = new Date(2026, 0, i, 0, 0, i); // distinct second per run -> distinct backup filenames
      const result = await runInit({ dir, resolveGlosaBin: () => bin, now: () => at });
      expect(result.changed).toBe(true);
      expect(result.data.files.settings.backedUp).toBe(true);
    }

    expect(backupsFor(settingsPathOf(dir))).toHaveLength(5); // retained cap (A6 §F26)
    // Reconciled in place throughout — never accumulated duplicates (P4.3 review fix #1).
    const settings = readJson(settingsPathOf(dir));
    expect(settings.hooks.SessionStart[0].hooks).toHaveLength(2);
    expect(settings.hooks.Stop[0].hooks).toHaveLength(1);
  });

  test("skip if identical to newest: re-running with the SAME bin after a real change takes no additional backup", async () => {
    const dir = freshDir();
    await runInit({ dir, resolveGlosaBin: () => BIN_A });
    const binB = bunRunBin("/glosa-root-b");
    await runInit({ dir, resolveGlosaBin: () => binB, now: () => new Date(2026, 0, 1) });
    const afterFirstChange = backupsFor(settingsPathOf(dir)).length;
    expect(afterFirstChange).toBe(1);

    // Same bin again — nothing new to merge, so this is the idempotent no-op path, not a backup
    // opportunity at all.
    await runInit({ dir, resolveGlosaBin: () => binB, now: () => new Date(2026, 0, 2) });
    expect(backupsFor(settingsPathOf(dir))).toHaveLength(afterFirstChange);
  });
});

describe("glosa init — invalid JSON", () => {
  test("malformed settings.json aborts with exit 6 and touches NOTHING", async () => {
    const dir = freshDir();
    mkdirSync(join(dir, ".claude"), { recursive: true });
    const malformed = "{ this is not valid json";
    writeFileSync(settingsPathOf(dir), malformed);

    const result = await runInit({ dir, resolveGlosaBin: () => BIN_A });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(6);
    expect(result.error?.kind).toBe("foreign_config_conflict");
    expect(readFileSync(settingsPathOf(dir), "utf8")).toBe(malformed); // byte-identical, untouched
    expect(existsSync(mcpPathOf(dir))).toBe(false); // never even got to the second file
    expect(existsSync(manifestPathOf(dir))).toBe(false);
  });
});

describe("glosa init — foreign MCP 'glosa' key", () => {
  function writeForeignMcp(dir: string) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      mcpPathOf(dir),
      JSON.stringify({ mcpServers: { glosa: { type: "stdio", command: "some-other-tool", args: ["serve"] } } }, null, 2),
    );
  }

  test("not owned by glosa (no manifest) -> exit 6, .mcp.json left untouched", async () => {
    const dir = freshDir();
    writeForeignMcp(dir);
    const before = readFileSync(mcpPathOf(dir), "utf8");

    const result = await runInit({ dir, resolveGlosaBin: () => BIN_A });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(6);
    expect(result.error?.code).toBe("mcp-key-conflict");
    expect(readFileSync(mcpPathOf(dir), "utf8")).toBe(before);
  });

  test("--force overwrites it and takes a backup of the foreign content", async () => {
    const dir = freshDir();
    writeForeignMcp(dir);

    const result = await runInit({ dir, resolveGlosaBin: () => BIN_A, force: true });

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.data.files.mcp.backedUp).toBe(true);
    const mcp = readJson(mcpPathOf(dir));
    expect(mcp.mcpServers.glosa).toEqual({ type: "stdio", command: "glosa", args: ["mcp"] });
    expect(backupsFor(mcpPathOf(dir))).toHaveLength(1);
  });
});

describe("glosa init — --print/--dry-run", () => {
  test("returns a unified diff and writes NOTHING to disk", async () => {
    const dir = freshDir();
    const result = await runInit({ dir, print: true, resolveGlosaBin: () => BIN_A });

    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.diff).toBeDefined();
    expect(result.diff).toContain("+++");
    expect(result.diff).toContain("glosa hook session-start");
    expect(existsSync(settingsPathOf(dir))).toBe(false);
    expect(existsSync(mcpPathOf(dir))).toBe(false);
    expect(existsSync(manifestPathOf(dir))).toBe(false);
  });

  test("an mcp-only change shows NO settings.json diff section (P4.3 review fix #3)", async () => {
    const dir = freshDir();
    await runInit({ dir, resolveGlosaBin: () => BIN_A }); // baseline: both files installed, matching

    // Force an mcp-only conflict resolution: pre-seed a foreign mcp entry, --force it — settings
    // stays byte-identical (already matches BIN_A), only .mcp.json actually changes.
    const mcp = readJson(mcpPathOf(dir));
    mcp.mcpServers.glosa = { type: "stdio", command: "someone-else", args: [] };
    writeFileSync(mcpPathOf(dir), JSON.stringify(mcp, null, 2));

    const result = await runInit({ dir, print: true, force: true, resolveGlosaBin: () => BIN_A });

    expect(result.changed).toBe(true); // mcp really is changing
    expect(result.diff).toContain(mcpPathOf(dir));
    expect(result.diff).not.toContain(settingsPathOf(dir)); // settings has NOTHING to show
  });

  test("a settings-only change shows NO .mcp.json diff section", async () => {
    const dir = freshDir();
    await runInit({ dir, resolveGlosaBin: () => BIN_A });

    // Hand-remove ONE of glosa's own hooks so the next init has something to reconcile in
    // settings.json specifically — GLOSA_BIN itself stays the same, so .mcp.json (whose only
    // input is `bin`) has nothing at all to change.
    const settings = readJson(settingsPathOf(dir));
    settings.hooks.Notification = [];
    writeFileSync(settingsPathOf(dir), JSON.stringify(settings, null, 2));

    const result = await runInit({ dir, print: true, resolveGlosaBin: () => BIN_A });

    expect(result.changed).toBe(true);
    expect(result.diff).toContain(settingsPathOf(dir));
    expect(result.diff).not.toContain(mcpPathOf(dir));
  });
});

describe("glosa init — mid-run failure rolls back (no half-install)", () => {
  test("settings.json write succeeds, .mcp.json write fails -> settings.json is restored to its pre-run content, manifest untouched, exit != 0", async () => {
    const dir = freshDir();
    await runInit({ dir, resolveGlosaBin: () => BIN_A }); // baseline install, run 0

    const settingsBefore = readFileSync(settingsPathOf(dir), "utf8");
    const mcpBefore = readFileSync(mcpPathOf(dir), "utf8");
    const manifestBefore = readFileSync(manifestPathOf(dir), "utf8");

    const binV2: GlosaBinResolution = { command: "glosa-v2", args: [], mode: "path" }; // forces a real settings.json change
    const mcpTarget = mcpPathOf(dir);
    const result = await runInit({
      dir,
      resolveGlosaBin: () => binV2,
      writeFileAtomic: (path, content) => {
        if (path === mcpTarget) throw new Error("simulated disk failure writing .mcp.json");
        writeFileSync(path, content);
      },
    });

    expect(result.ok).toBe(false);
    expect(result.exitCode).not.toBe(0);
    // Every file this run touched is back to EXACTLY what it held before this run started.
    expect(readFileSync(settingsPathOf(dir), "utf8")).toBe(settingsBefore);
    expect(readFileSync(mcpPathOf(dir), "utf8")).toBe(mcpBefore);
    expect(readFileSync(manifestPathOf(dir), "utf8")).toBe(manifestBefore);
  });
});

describe("glosa init — GLOSA_BIN resolution (A6 §F26)", () => {
  const REAL_PATH = process.env.PATH;
  afterEach(() => {
    process.env.PATH = REAL_PATH;
  });

  function fakeGlosaOnPath(dir: string, printedBuildId: string): void {
    const binDir = join(dir, "fakebin");
    mkdirSync(binDir, { recursive: true });
    const scriptPath = join(binDir, "glosa");
    writeFileSync(scriptPath, `#!/bin/sh\necho "${printedBuildId}"\n`);
    chmodSync(scriptPath, 0o755);
    process.env.PATH = `${binDir}:${process.env.PATH}`;
  }

  test("bare 'glosa' on PATH with a matching --build-id resolves to the path form", () => {
    const dir = freshDir();
    fakeGlosaOnPath(dir, BUILD_ID);
    const resolved = defaultResolveGlosaBin("/irrelevant/glosa-root");
    expect(resolved).toEqual({ command: "glosa", args: [], mode: "path" });
  });

  test("'glosa' on PATH but a BUILD-ID MISMATCH falls back to the bun-run form", () => {
    const dir = freshDir();
    fakeGlosaOnPath(dir, "9.9.9"); // stale/foreign glosa binary
    const resolved = defaultResolveGlosaBin("/some/glosa-root");
    expect(resolved.mode).toBe("bun-run");
    expect(resolved.command).toBe("bun");
    expect(resolved.args).toEqual(["run", "--silent", "/some/glosa-root/packages/cli/src/main.ts"]);
  });

  test("'glosa' on PATH with extra --build-id output is treated as nonmatching", () => {
    const dir = freshDir();
    fakeGlosaOnPath(dir, `${BUILD_ID}\nunexpected output`);
    expect(defaultResolveGlosaBin("/some/glosa-root").mode).toBe("bun-run");
  });

  test("'glosa' on PATH that does not support --build-id falls back to the bun-run form", () => {
    const dir = freshDir();
    const binDir = join(dir, "fakebin");
    mkdirSync(binDir, { recursive: true });
    const scriptPath = join(binDir, "glosa");
    writeFileSync(scriptPath, "#!/bin/sh\nexit 2\n");
    chmodSync(scriptPath, 0o755);
    process.env.PATH = `${binDir}:${process.env.PATH}`;

    expect(defaultResolveGlosaBin("/some/glosa-root")).toEqual({
      command: "bun",
      args: ["run", "--silent", "/some/glosa-root/packages/cli/src/main.ts"],
      mode: "bun-run",
    });
  });

  test("no 'glosa' on PATH at all falls back to the bun-run form", () => {
    process.env.PATH = freshDir(); // an empty dir, guaranteed no `glosa` binary
    const resolved = defaultResolveGlosaBin("/some/other-root");
    expect(resolved).toEqual({
      command: "bun",
      args: ["run", "--silent", "/some/other-root/packages/cli/src/main.ts"],
      mode: "bun-run",
    });
  });
});

describe("glosa init — concurrent access (P4.3 concurrency review fix #6)", () => {
  test("a runInit call WAITS while another process holds the whole-transaction lock, then proceeds with a fully-populated manifest — never an interleaved, corrupted one", async () => {
    const dir = freshDir();
    mkdirSync(join(dir, ".claude"), { recursive: true });
    const lockPath = `${manifestPathOf(dir)}.lock`;

    // Simulate "process A" already mid-transaction, holding the lock.
    writeFileSync(lockPath, JSON.stringify({ pid: 999999, started: new Date().toISOString() }));

    // "Process B" (this real call) starts while the lock is held.
    const resultPromise = runInit({ dir, resolveGlosaBin: () => BIN_A });

    // It must actually be BLOCKED, not racing ahead — nothing written yet.
    await Bun.sleep(50);
    expect(existsSync(settingsPathOf(dir))).toBe(false);
    expect(existsSync(mcpPathOf(dir))).toBe(false);

    // "Process A" finishes and releases the lock — only now can B proceed.
    rmSync(lockPath, { force: true });

    const result = await resultPromise;
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);

    // The manifest is FULLY populated — the exact thing the race used to corrupt (an
    // interleaved process seeing a null/stale manifest mid-write and clobbering it with an
    // empty `inserted` array).
    const manifest = readJson(manifestPathOf(dir));
    expect(manifest.files.settings.inserted).toHaveLength(6);
    expect(manifest.files.mcp.inserted).toHaveLength(1);

    // Uninstall afterward cleanly removes everything — nothing was silently orphaned.
    const uninstallResult = await runUninstall({ dir });
    expect(uninstallResult.ok).toBe(true);
    expect(existsSync(settingsPathOf(dir))).toBe(false);
    expect(existsSync(mcpPathOf(dir))).toBe(false);
    expect(existsSync(manifestPathOf(dir))).toBe(false);
  });

  test("a stale lock (older than 30s) is reclaimed rather than waited out indefinitely", async () => {
    const dir = freshDir();
    mkdirSync(join(dir, ".claude"), { recursive: true });
    const lockPath = `${manifestPathOf(dir)}.lock`;
    writeFileSync(lockPath, JSON.stringify({ pid: 999999, started: new Date(2020, 0, 1).toISOString() }));

    const result = await runInit({ dir, resolveGlosaBin: () => BIN_A });

    expect(result.ok).toBe(true);
    expect(existsSync(lockPath)).toBe(false); // released cleanly after this run
  });

  test("the lock is released even when the run fails (mid-run rollback path)", async () => {
    const dir = freshDir();
    await runInit({ dir, resolveGlosaBin: () => BIN_A });
    const lockPath = `${manifestPathOf(dir)}.lock`;
    const mcpTarget = mcpPathOf(dir);

    const result = await runInit({
      dir,
      resolveGlosaBin: () => bunRunBin("/opt/glosa-lock-fail"),
      writeFileAtomic: (path, content) => {
        if (path === mcpTarget) throw new Error("simulated failure");
        writeFileSync(path, content);
      },
    });

    expect(result.ok).toBe(false);
    expect(existsSync(lockPath)).toBe(false); // NOT left behind, even on the rollback path
  });
});

describe("glosa uninstall", () => {
  test("clean removal: both files were created by glosa and end up empty -> both deleted, manifest deleted", async () => {
    const dir = freshDir();
    await runInit({ dir, resolveGlosaBin: () => BIN_A });

    const result = await runUninstall({ dir });

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(existsSync(settingsPathOf(dir))).toBe(false);
    expect(existsSync(mcpPathOf(dir))).toBe(false);
    expect(existsSync(manifestPathOf(dir))).toBe(false);
  });

  test("a file that pre-existed (created:false) survives uninstall with its foreign content intact, glosa's own hooks removed", async () => {
    const dir = freshDir();
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      settingsPathOf(dir),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "my-other-tool check", timeout: 30 }] }] } }, null, 2),
    );
    await runInit({ dir, resolveGlosaBin: () => BIN_A });

    await runUninstall({ dir });

    expect(existsSync(settingsPathOf(dir))).toBe(true);
    const settings = readJson(settingsPathOf(dir));
    const stopHooks = settings.hooks.Stop.flatMap((g: any) => g.hooks);
    expect(stopHooks).toEqual([{ type: "command", command: "my-other-tool check", timeout: 30 }]);
    // .mcp.json DID NOT pre-exist -> glosa created it -> it's now empty -> deleted.
    expect(existsSync(mcpPathOf(dir))).toBe(false);
  });

  test("an externally-edited node is left in place, warned about, and the overall exit code is 9 — everything else still gets cleaned up", async () => {
    const dir = freshDir();
    await runInit({ dir, resolveGlosaBin: () => BIN_A });

    // Mutate the recorded "stop" hook's timeout by hand — its hash no longer matches what the
    // manifest recorded.
    const settings = readJson(settingsPathOf(dir));
    settings.hooks.Stop[0].hooks[0].timeout = 999;
    writeFileSync(settingsPathOf(dir), JSON.stringify(settings, null, 2));

    const result = await runUninstall({ dir });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(9);
    expect(result.warnings.some((w) => w.code === "external-edit")).toBe(true);

    // The edited node is untouched...
    expect(existsSync(settingsPathOf(dir))).toBe(true);
    const after = readJson(settingsPathOf(dir));
    expect(after.hooks.Stop[0].hooks[0].timeout).toBe(999);
    // ...but every OTHER glosa hook (unaffected by the edit) was still cleanly removed.
    expect(after.hooks.SessionStart).toBeUndefined();
    expect(after.hooks.SessionEnd).toBeUndefined();
    // manifest survives (not a clean removal) so a future uninstall attempt can still act on it.
    expect(existsSync(manifestPathOf(dir))).toBe(true);
  });

  test("no manifest at all -> nothing to uninstall, exit 0 with a warning, never throws", async () => {
    const dir = freshDir();
    const result = await runUninstall({ dir });
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.warnings.some((w) => w.code === "no-manifest")).toBe(true);
  });

  test("mid-run failure rolls back (no half-uninstall) — P4.3 review fix #4", async () => {
    const dir = freshDir();
    // Both files pre-exist with foreign content alongside glosa's own hooks (created:false) —
    // uninstall reconciles them down to just the foreign content (the "write" branch, not
    // "delete"), which is exactly the failure point the review flagged.
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      settingsPathOf(dir),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "my-other-tool check", timeout: 30 }] }] } }, null, 2),
    );
    writeFileSync(mcpPathOf(dir), JSON.stringify({ mcpServers: { "some-other-server": { type: "stdio", command: "x", args: [] } } }, null, 2));
    await runInit({ dir, resolveGlosaBin: () => BIN_A });

    const settingsBefore = readFileSync(settingsPathOf(dir), "utf8");
    const mcpBefore = readFileSync(mcpPathOf(dir), "utf8");
    const manifestBefore = readFileSync(manifestPathOf(dir), "utf8");

    const mcpTarget = mcpPathOf(dir);
    const result = await runUninstall({
      dir,
      writeFileAtomic: (path, content) => {
        if (path === mcpTarget) throw new Error("simulated disk failure writing .mcp.json");
        writeFileSync(path, content);
      },
    });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(70);
    expect(result.error?.code).toBe("internal");
    // Every file this run touched is back to EXACTLY what it held before this run started —
    // settings.json's own reconciliation (which succeeded before mcp's failed) is undone too.
    expect(readFileSync(settingsPathOf(dir), "utf8")).toBe(settingsBefore);
    expect(readFileSync(mcpPathOf(dir), "utf8")).toBe(mcpBefore);
    expect(readFileSync(manifestPathOf(dir), "utf8")).toBe(manifestBefore);
  });
});

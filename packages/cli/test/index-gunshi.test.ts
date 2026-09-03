// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILD_ID } from "../../daemon/src/lifecycle/build-id.ts";
import { randomPort } from "../../daemon/test/helpers.ts";
import { createHttpDaemonClient } from "../src/daemon-client.ts";
import { run } from "../src/index.ts";
import { CLI_VERSION } from "../src/version.ts";
import { useTempHome } from "./home.ts";

// Scoped init checks the opposite-scope manifest even in print mode. Keep this command-boundary
// suite independent of the developer's real user-scope installation.
useTempHome();

const CLI_PATH = join(import.meta.dir, "../src/main.ts");
const PUBLIC_COMMANDS = [
  "open",
  "init",
  "resolve",
  "apply-begin",
  "request-review",
  "doctor",
  "status",
  "inbox",
  "metadata",
  "session",
  "token",
  "update",
] as const;

let dirs: string[] = [];
const originalPort = Bun.env.GLOSA_PORT;

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
  if (originalPort === undefined) delete Bun.env.GLOSA_PORT;
  else Bun.env.GLOSA_PORT = originalPort;
});

/** A `.git` marker makes this fixture read as a scratch git repo rather than a bare temp
 * directory, so `glosa init`'s risky-target guard (issue #96) doesn't fire on tests here that
 * exercise `init` incidentally while testing flag-parsing surface, not the guard itself. */
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "glosa-gunshi-test-"));
  mkdirSync(join(dir, ".git"));
  dirs.push(dir);
  return dir;
}

function runCli(
  args: readonly string[],
  options: { stdin?: string; env?: Record<string, string | undefined> } = {},
): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync({
    cmd: [process.execPath, CLI_PATH, ...args],
    cwd: process.cwd(),
    env: { ...Bun.env, ...options.env },
    stdin: options.stdin === undefined ? "ignore" : new Blob([options.stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString("utf8"),
    stderr: result.stderr.toString("utf8"),
  };
}

async function captureRun(args: readonly string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);
  let stdout = "";
  let stderr = "";
  // biome-ignore lint: test-only stream capture
  (process.stdout.write as any) = (chunk: string | Uint8Array) => {
    stdout += chunk.toString();
    return true;
  };
  // biome-ignore lint: test-only stream capture
  (process.stderr.write as any) = (chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  };
  try {
    return { exitCode: await run(args), stdout, stderr };
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
}

describe("Gunshi command surface", () => {
  test("root and command help are generated for every public command", () => {
    const root = runCli(["--help"]);
    expect(root.exitCode).toBe(0);
    for (const command of PUBLIC_COMMANDS) {
      expect(root.stdout).toContain(command);
      const help = runCli([command, "--help"]);
      expect(help.exitCode).toBe(0);
      expect(help.stdout).toContain(`glosa ${command}`);
      expect(help.stderr).toBe("");
    }
    expect(root.stdout).toContain("complete");
    expect(root.stdout).not.toContain("__daemon");
    expect(root.stdout).not.toContain("hook");
    expect(root.stdout).not.toContain("mcp");
    expect(root.stdout).not.toContain("checkpoints");
    expect(root.stderr).toBe("");
    expect(runCli(["request-review", "--help"]).stdout).toContain("--require-approval");
  });

  test("no-args and version output preserve their contracts", () => {
    expect(runCli([])).toEqual({
      exitCode: 0,
      stdout: "glosa — writing-first workspace for AI coding agents\n",
      stderr: "",
    });
    expect(runCli(["--version"])).toEqual({
      exitCode: 0,
      stdout: `glosa ${CLI_VERSION}\n`,
      stderr: "",
    });
    expect(runCli(["--build-id"])).toEqual({
      exitCode: 0,
      stdout: `${BUILD_ID}\n`,
      stderr: "",
    });
  });

  test("global flags work before and after the subcommand", async () => {
    const before = await captureRun(["--port", "4711", "--quiet", "init", freshDir(), "--agent", "codex", "--print"]);
    expect(before.exitCode).toBe(0);
    expect(before.stderr).toBe("");
    expect(Bun.env.GLOSA_PORT).toBe("4711");

    const after = await captureRun(["init", freshDir(), "--agent", "codex", "--dry-run", "--verbose", "--port=4712"]);
    expect(after.exitCode).toBe(0);
    expect(after.stderr).toBe("");
    expect(Bun.env.GLOSA_PORT).toBe("4712");
  });

  test("--json remains explicit and works before or after the command", () => {
    for (const args of [
      ["--json", "init", freshDir(), "--agent", "codex", "--print"],
      ["init", freshDir(), "--agent", "codex", "--print", "--json"],
    ]) {
      const result = runCli(args);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(Object.keys(JSON.parse(result.stdout))).toEqual([
        "glosa_json",
        "ok",
        "command",
        "exit_code",
        "data",
        "warnings",
        "error",
      ]);
    }
  });

  test("validation failures are strict and never leak Gunshi output or stacks", () => {
    const json = runCli(["resolve", "--unknown", "--json"]);
    expect(json.exitCode).toBe(2);
    expect(json.stderr).toBe("");
    expect(json.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(json.stdout)).toMatchObject({
      glosa_json: 1,
      ok: false,
      command: "resolve",
      exit_code: 2,
      error: { code: "usage", kind: "usage" },
    });

    const missing = runCli(["apply-begin", "entry", "--session"]);
    expect(missing.exitCode).toBe(2);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).not.toContain("ArgsValidationError");
    expect(missing.stderr).not.toContain(" at ");

    const surplus = runCli(["resolve", "entry", "applied", "extra", "--session", "session"]);
    expect(surplus.exitCode).toBe(2);
    expect(surplus.stdout).toBe("");
    expect(surplus.stderr).toContain("Unexpected positional argument: extra");
    expect(surplus.stderr).not.toContain("ArgsValidationError");

    const invalidDuration = runCli(["request-review", "draft.md", "--wait", "later", "--json"]);
    expect(invalidDuration.exitCode).toBe(2);
    expect(invalidDuration.stderr).toBe("");
    expect(invalidDuration.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(invalidDuration.stdout)).toMatchObject({
      glosa_json: 1,
      ok: false,
      command: "request-review",
      exit_code: 2,
      error: { code: "usage", kind: "usage" },
    });
  });

  test("open: --init and --no-init are mutually exclusive (usage error before any daemon call)", () => {
    const r = runCli(["open", "/tmp/nowhere", "--init", "--no-init"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("--init and --no-init are mutually exclusive");
  });

  test("manual parser functions are gone", () => {
    const source = readFileSync(join(import.meta.dir, "../src/index.ts"), "utf8");
    expect(source).not.toContain("parseInitArgs");
    expect(source).not.toContain("extractGlobalFlags");
    expect(source).not.toContain("parseFlags");
  });
});

describe("Gunshi completion", () => {
  test("generates scripts for every supported shell", () => {
    for (const shell of ["bash", "zsh", "fish", "powershell"]) {
      const result = runCli(["complete", shell]);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.length).toBeGreaterThan(100);
      expect(result.stdout.toLowerCase()).toContain("glosa");
    }
  });

  test("suggests public commands and global/local flags but hides protocol commands", () => {
    const commands = runCli(["complete", "--", ""]);
    for (const command of PUBLIC_COMMANDS) expect(commands.stdout).toContain(command);
    for (const hidden of ["hook", "mcp", "__daemon", "checkpoints", "diff", "restore"]) {
      expect(commands.stdout).not.toContain(hidden);
    }

    expect(runCli(["complete", "--", "--j"]).stdout).toContain("--json");
    expect(runCli(["complete", "--", "open", "--q"]).stdout).toContain("--quiet");
    expect(runCli(["complete", "--", "init", "--d"]).stdout).toContain("--dry-run");
  });
});

describe("internal protocol compatibility", () => {
  test("hook failure retains its exact bytes and MCP accepts an empty stdio session", () => {
    expect(runCli(["hook"])).toEqual({
      exitCode: 2,
      stdout: "",
      stderr: "glosa hook: missing <event>\n",
    });
    expect(runCli(["mcp"])).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
  });

  test("documented placeholders remain hidden and preserve their response", () => {
    for (const command of ["checkpoints", "diff", "restore"]) {
      expect(runCli([command])).toEqual({
        exitCode: 2,
        stdout: "",
        stderr: `glosa: command not yet implemented: ${command}\n`,
      });
    }
  });

  test("a hook yields silently when daemon discovery exceeds its private budget", () => {
    const port = randomPort();
    const squatter = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch: () => Response.json({ not: "a glosa handshake" }),
    });
    try {
      const started = performance.now();
      const result = runCli(["hook", "notification"], {
        env: { GLOSA_PORT: String(port) },
        stdin: JSON.stringify({ session_id: "hook-session", cwd: process.cwd() }),
      });

      expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
      expect(performance.now() - started).toBeLessThan(5000);
    } finally {
      squatter.stop();
    }
  }, 7000);

  test("malformed hook input stays visible even when daemon discovery would fail", () => {
    const port = randomPort();
    const squatter = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch: () => Response.json({ not: "a glosa handshake" }),
    });
    try {
      const result = runCli(["hook", "notification"], {
        env: { GLOSA_PORT: String(port) },
        stdin: "{}",
      });

      expect(result).toEqual({
        exitCode: 2,
        stdout: "",
        stderr: "notification: hook input missing session_id/cwd",
      });
    } finally {
      squatter.stop();
    }
  });

  test("an explicit daemon client keeps the actionable discovery error", async () => {
    const port = randomPort();
    const squatter = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch: () => Response.json({ not: "a glosa handshake" }),
    });
    Bun.env.GLOSA_PORT = String(port);
    try {
      await expect(createHttpDaemonClient({ ensureTimeoutMs: 100 })).rejects.toMatchObject({
        code: "DAEMON_UNREACHABLE",
        message: expect.stringContaining("100ms wall-clock budget"),
      });
    } finally {
      squatter.stop();
    }
  });
});

describe("glosa update — command boundary", () => {
  // Runs from this source checkout, so classifyInstall sees the repo's own .git and refuses at
  // exit 2 BEFORE any network call. That is what makes these safe to run in CI: they exercise the
  // full gunshi -> runUpdate -> printUpdateResult path without an outbound request.
  test("refuses to self-update a source checkout, with a copy-pasteable manual command", () => {
    const r = runCli(["update", "--check", "--json"]);
    expect(r.exitCode).toBe(2);
    const parsed = JSON.parse(r.stdout);
    expect(parsed).toMatchObject({
      glosa_json: 1,
      ok: false,
      command: "update",
      exit_code: 2,
      error: { code: "update-unmanaged-install" },
    });
    expect(parsed.data.install_kind).toBe("source-checkout");
    expect(parsed.data.manual_command).toBe("git pull && bun install");
  });

  // The defect this catches is invisible to every unit test: if the handler never passes `json`
  // into runUpdate, the --json path is unreachable in the shipped command while all its tests pass.
  test("--json reaches runUpdate, producing exactly one JSON object on stdout", () => {
    const r = runCli(["update", "--check", "--json"]);
    expect(r.stdout.trimEnd().split("\n")).toHaveLength(1);
    expect(() => JSON.parse(r.stdout)).not.toThrow();
  });

  test("human mode writes the refusal to stderr, not stdout", () => {
    const r = runCli(["update", "--check"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("git pull && bun install");
    expect(r.stdout).toBe("");
  });

  test("mutually exclusive --to and --channel is a usage error", () => {
    const r = runCli(["update", "--to", "0.1.0-alpha.3", "--channel", "alpha", "--json"]);
    expect(r.exitCode).toBe(2);
    expect(JSON.parse(r.stdout)).toMatchObject({ command: "update", error: { code: "usage" } });
  });

  test("a plaintext registry is refused before anything reaches the network", () => {
    const r = runCli(["update", "--registry", "http://127.0.0.1:4873", "--check", "--json"]);
    expect(r.exitCode).toBe(2);
    expect(JSON.parse(r.stdout).error.code).toBe("update-invalid-registry");
  });

  // `update` declares zero positionals, so assertNoSurplusPositionals rejects this at the gunshi
  // boundary. The command attribution only works because "update" is in PUBLIC_COMMANDS.
  test("a surplus positional is a usage error attributed to `update`", () => {
    const r = runCli(["update", "0.1.0-alpha.3", "--json"]);
    expect(r.exitCode).toBe(2);
    expect(JSON.parse(r.stdout)).toMatchObject({ command: "update", error: { code: "usage" } });
  });
});

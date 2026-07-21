import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/index.ts";
import { CLI_VERSION } from "../src/version.ts";
import { BUILD_ID } from "../../daemon/src/build-id.ts";

const CLI_PATH = join(import.meta.dir, "../src/main.ts");
const PUBLIC_COMMANDS = [
  "open",
  "init",
  "resolve",
  "apply-begin",
  "request-review",
  "doctor",
  "status",
] as const;

let dirs: string[] = [];
const originalPort = Bun.env.GLOSA_PORT;

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
  if (originalPort === undefined) delete Bun.env.GLOSA_PORT;
  else Bun.env.GLOSA_PORT = originalPort;
});

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "glosa-gunshi-test-"));
  dirs.push(dir);
  return dir;
}

function runCli(args: readonly string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync({
    cmd: [process.execPath, CLI_PATH, ...args],
    cwd: process.cwd(),
    env: Bun.env,
    stdin: "ignore",
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
    const before = await captureRun([
      "--port",
      "4711",
      "--quiet",
      "init",
      freshDir(),
      "--print",
    ]);
    expect(before.exitCode).toBe(0);
    expect(before.stderr).toBe("");
    expect(Bun.env.GLOSA_PORT).toBe("4711");

    const after = await captureRun([
      "init",
      freshDir(),
      "--dry-run",
      "--verbose",
      "--port=4712",
    ]);
    expect(after.exitCode).toBe(0);
    expect(after.stderr).toBe("");
    expect(Bun.env.GLOSA_PORT).toBe("4712");
  });

  test("--json remains explicit and works before or after the command", () => {
    for (const args of [
      ["--json", "init", freshDir(), "--print"],
      ["init", freshDir(), "--print", "--json"],
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
  test("hook and mcp failures retain their exact bytes", () => {
    expect(runCli(["hook"])).toEqual({
      exitCode: 2,
      stdout: "",
      stderr: "glosa hook: missing <event>\n",
    });
    expect(runCli(["mcp"])).toEqual({
      exitCode: 70,
      stdout: "",
      stderr: "glosa mcp: stdio MCP server not yet implemented (P5.4)\n",
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
});

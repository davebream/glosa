// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILD_ID } from "../../daemon/src/lifecycle/build-id.ts";
import { randomPort } from "../../daemon/test/helpers.ts";
import { createHttpDaemonClient } from "../src/daemon-client.ts";
import { EXIT_CODES } from "../src/envelope.ts";
import type { GlosaApiClient } from "../src/api-client.ts";
import { run, type CliRunDependencies } from "../src/index.ts";
import { FakeGlosaApiClient } from "./fake-api-client.ts";
import { CLI_VERSION } from "../src/version.ts";
import { useTempHome } from "./home.ts";

// Keep this command-boundary suite independent of the developer's real Glosa installation.
useTempHome();

const CLI_PATH = join(import.meta.dir, "../src/main.ts");
const PUBLIC_COMMANDS = [
  "open",
  "resolve",
  "apply-begin",
  "claim",
  "release",
  "request-review",
  "doctor",
  "status",
  "inbox",
  "metadata",
  "session",
  "token",
  "dictation",
  "update",
  "forget",
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
 * directory, so `doctor`'s workspace-root advice (issue #96) stays quiet on tests here that
 * exercise it incidentally while testing flag-parsing surface. */
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

async function captureRun(
  args: readonly string[],
  deps: CliRunDependencies = {},
): Promise<{
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
    return { exitCode: await run(args, deps), stdout, stderr };
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
    expect(runCli(["dictation", "--help"]).stdout).toContain("--provider");
    // An entry id already names one workspace, so both lease commands must let a caller standing
    // somewhere else say which — `inbox get`, the other entry-id command, always could.
    for (const command of ["resolve", "apply-begin", "claim", "release", "inbox"]) {
      expect(runCli([command, "--help"]).stdout).toContain("--workspace");
    }
  });

  test("no-args and version output preserve their contracts", () => {
    expect(runCli([])).toEqual({
      exitCode: 0,
      stdout: "glosa: writing-first workspace for AI coding agents\n",
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

  /** `doctor` against an injected client: the one public command that completes offline with a
   * full envelope and exit 0 (no daemon spawn, no network), so flag parsing can be observed
   * through a real command rather than a stand-in. */
  function offlineDoctorDeps(): CliRunDependencies {
    const glosaHome = freshDir();
    return {
      doctor: {
        createClient: async () => new FakeGlosaApiClient() as unknown as GlosaApiClient,
        glosaHome: () => glosaHome,
      },
    };
  }

  test("global flags work before and after the subcommand", async () => {
    const before = await captureRun(["--port", "4711", "--quiet", "doctor", freshDir()], offlineDoctorDeps());
    expect(before.exitCode).toBe(0);
    expect(before.stderr).toBe("");
    expect(Bun.env.GLOSA_PORT).toBe("4711");

    const after = await captureRun(["doctor", freshDir(), "--verbose", "--port=4712"], offlineDoctorDeps());
    expect(after.exitCode).toBe(0);
    expect(after.stderr).toBe("");
    expect(Bun.env.GLOSA_PORT).toBe("4712");
  });

  test("dictation status reaches the local command boundary and emits the stable JSON envelope", async () => {
    const result = await captureRun(["dictation", "status", "--json"], {
      dictation: { home: freshDir() },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      glosa_json: 1,
      ok: true,
      command: "dictation",
      data: { state: "unconfigured" },
    });
  });

  test("--json remains explicit and works before or after the command", async () => {
    for (const args of [
      ["--json", "doctor", freshDir()],
      ["doctor", freshDir(), "--json"],
    ]) {
      const result = await captureRun(args, offlineDoctorDeps());
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

  test("inbox: `list` needs no id, `get` still requires one, and a genuine surplus positional still errors (issue #142)", () => {
    const missingId = runCli(["inbox", "get"]);
    expect(missingId.exitCode).toBe(2);
    expect(missingId.stderr).toContain("missing <id>");

    const unsupported = runCli(["inbox", "bogus-action"]);
    expect(unsupported.exitCode).toBe(2);
    expect(unsupported.stderr).toContain("unsupported action");

    // `assertNoSurplusPositionals` (index.ts:1060-1067) counts DECLARED positionals regardless of
    // `required` — `action`+`id` stay 2 declared slots for `inbox` even with `id` now optional,
    // so a THIRD positional is still rejected before any handler or daemon call runs.
    const trueSurplus = runCli(["inbox", "list", "a", "b"]);
    expect(trueSurplus.exitCode).toBe(2);
    expect(trueSurplus.stderr).toContain("Unexpected positional argument: b");
    expect(trueSurplus.stderr).not.toContain("ArgsValidationError");
  });

  // The real parser must dispatch to the client factory, not reject the optional id as surplus.
  test("inbox: a single stray positional after `list` is NOT rejected as surplus — it reaches the daemon", async () => {
    let calls = 0;
    const result = await captureRun(["inbox", "list", "extra-arg"], {
      inbox: {
        createClient: async () => {
          calls++;
          throw new Error("command dispatch sentinel");
        },
      },
    });
    expect(calls).toBe(1);
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("command dispatch sentinel");
    expect(result.stderr).not.toContain("Unexpected positional argument");
    expect(result.stdout).toBe("");
  });

  test("open: the removed --init/--no-init flags are unknown options (#152)", () => {
    const r = runCli(["open", "/tmp/nowhere", "--init"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("Unknown option: --init");
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

  test("glosa monitor needs only the session id — the form the glosa-connect skill can actually produce (#306)", async () => {
    // Measured in a live Claude Code session: a Bash/Monitor command inherits
    // CLAUDE_CODE_SESSION_ID but NOT CLAUDE_PLUGIN_ROOT or CLAUDE_PROJECT_DIR. So the skill can
    // never pass `--plugin-root`, and requiring it made the documented fallback command
    // impossible to run. Nothing ever read it.
    const home = mkdtempSync(join(tmpdir(), "glosa-monitor-args-"));
    try {
      const env = { GLOSA_HOME: home, CLAUDE_CODE_SESSION_ID: "args-session" };
      // No daemon is running, so a monitor that got past argument parsing idles rather than
      // exiting; a USAGE exit is what proves it was REFUSED. Bounded so a pass cannot hang.
      const started = Bun.spawn({
        cmd: [process.execPath, CLI_PATH, "monitor", "--project-dir", home],
        env: { ...Bun.env, ...env },
        stdout: "pipe",
        stderr: "pipe",
      });
      // Raced, not polled on `exitCode`: that field is only settled once the child is awaited, so
      // reading it directly would report "still running" for a process that had already refused —
      // a check that cannot observe what it claims.
      // Raced, not polled on `exitCode`: that field is only settled once the child is awaited, so
      // reading it directly would report "still running" for a process that had already refused —
      // a check that cannot observe what it claims. stderr is read only AFTER the process is
      // stopped, because a live monitor never closes it.
      const outcome = await Promise.race([started.exited, Bun.sleep(1_500).then(() => "still-running" as const)]);
      started.kill("SIGTERM");
      await started.exited;
      expect({ outcome, stderr: await new Response(started.stderr).text() }).toMatchObject({
        outcome: "still-running",
      });

      // Without a session id there is nothing to key the stream or the singleton lock on, so this
      // one stays required.
      const noSession = runCli(["monitor", "--project-dir", home], {
        env: { GLOSA_HOME: home, CLAUDE_CODE_SESSION_ID: undefined },
      });
      expect(noSession.exitCode).toBe(EXIT_CODES.USAGE);
      expect(noSession.stderr).toContain("CLAUDE_CODE_SESSION_ID is required");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("suggests public commands and global/local flags but hides protocol commands", () => {
    const commands = runCli(["complete", "--", ""]);
    for (const command of PUBLIC_COMMANDS) expect(commands.stdout).toContain(command);
    for (const hidden of ["hook", "mcp", "monitor", "codex-attach", "__daemon", "checkpoints", "diff", "restore"]) {
      expect(commands.stdout).not.toContain(hidden);
    }

    expect(runCli(["complete", "--", "--j"]).stdout).toContain("--json");
    expect(runCli(["complete", "--", "open", "--q"]).stdout).toContain("--quiet");
    expect(runCli(["complete", "--", ""]).stdout).not.toContain("init");
  });
});

describe("internal protocol compatibility", () => {
  test("MCP accepts an empty stdio session", () => {
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

  // #152: `glosa hook <event>` is a silent exit-0 stub for one release, so a machine still
  // carrying old `settings.json` / `.codex/hooks.json` entries never shows a failing hook on every
  // prompt. It prints nothing, reads nothing, and never touches daemon discovery — a squatted port
  // that would stall discovery must not slow it down either.
  test("`glosa hook` in every legacy shape is a silent, instant exit 0 that never discovers a daemon", () => {
    const port = randomPort();
    const squatter = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch: () => Response.json({ not: "a glosa handshake" }),
    });
    try {
      const started = performance.now();
      for (const argv of [
        ["hook"],
        ["hook", "session-start"],
        ["hook", "notification"],
        ["hook", "stop", "--provider", "codex"],
        ["hook", "user-prompt-submit"],
        ["hook", "rewake-watch"],
        ["hook", "no-such-event"],
      ]) {
        expect(
          runCli(argv, {
            env: { GLOSA_PORT: String(port) },
            stdin: JSON.stringify({ session_id: "hook-session", cwd: process.cwd() }),
          }),
        ).toEqual({ exitCode: 0, stdout: "", stderr: "" });
      }
      expect(runCli(["hook", "notification"], { env: { GLOSA_PORT: String(port) }, stdin: "{}" })).toEqual({
        exitCode: 0,
        stdout: "",
        stderr: "",
      });
      expect(performance.now() - started).toBeLessThan(5000);
    } finally {
      squatter.stop();
    }
  }, 10_000);

  // Issue #139: the error a user meets must say what was FOUND, not merely that time ran out. A
  // held port with nothing answering on it is a proven diagnosis and outranks the budget that
  // expired while proving it — "discovery exceeded its budget" left a user with nothing to act on
  // while a wedged daemon sat on the port.
  //
  // This pins the client half: the daemon's diagnosis reaches the caller as DAEMON_UNREACHABLE with
  // its text intact. The ordering itself is pinned on a controlled clock in the daemon's
  // lifecycle.test.ts. The budget here is 1000ms rather than 100ms (#283): a slow CI runner spent
  // 100ms before the port was ever probed, and the budget error it then returned was correct. The
  // squatter never answers a handshake, so the poll still runs the budget out before the diagnosis
  // is returned, and one call costs about the budget.
  test("an explicit daemon client keeps the actionable discovery error", async () => {
    const port = randomPort();
    const squatter = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch: () => Response.json({ not: "a glosa handshake" }),
    });
    Bun.env.GLOSA_PORT = String(port);
    try {
      await expect(createHttpDaemonClient({ ensureTimeoutMs: 1000 })).rejects.toMatchObject({
        code: "DAEMON_UNREACHABLE",
        message: expect.stringMatching(new RegExp(`a process is bound to port ${port}\\b.*lsof`)),
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

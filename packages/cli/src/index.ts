// @glosa/cli — programmatic entry. See docs/requirements.md R8 + docs/appendices/A6.
// `init`/`hook <event>`/`__daemon` (P4.3/P1.2) and the P5.1 command surface
// (open/resolve/apply-begin/request-review/doctor/status) all dispatch from here. `mcp` stays a
// stub (P5.4's scope); `checkpoints`/`diff`/`restore` (A6 §F31) are deliberately NOT dispatched —
// they fall through to the generic "not yet implemented" message below, same footing as `mcp`
// before this task, since BUILD-PLAN.md's P5.1 line doesn't list them among this task's
// deliverables.
import { glosaHome } from "@glosa/daemon";
import { RewakeCoordinator, RewakeLeaseStore } from "@glosa/providers-claude-code";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHttpGlosaClient } from "./api-client.ts";
import { createHttpDaemonClient } from "./daemon-client.ts";
import { printDoctorResult, realDoctorDeps, runDoctor } from "./doctor.ts";
import { runHook, type HookDeps } from "./hook.ts";
import { CLI_VERSION, runInit, runUninstall, type InitResult, type UninstallResult } from "./init.ts";
import { printOpenResult, realOpenDeps, runOpen } from "./open.ts";
import { printRequestReviewResult, realRequestReviewDeps, runRequestReview } from "./request-review.ts";
import { parseDurationMs } from "./envelope.ts";
import { printApplyBeginResult, printResolveResult, runApplyBegin, runResolve } from "./resolve.ts";
import { printStatusResult, runStatus } from "./status.ts";

interface ParsedInitArgs {
  dir: string;
  print: boolean;
  force: boolean;
  uninstall: boolean;
  json: boolean;
}

function parseInitArgs(argv: readonly string[]): ParsedInitArgs {
  let dir = process.cwd();
  let print = false;
  let force = false;
  let uninstall = false;
  let json = false;
  for (const arg of argv) {
    if (arg === "--print" || arg === "--dry-run") print = true;
    else if (arg === "--force") force = true;
    else if (arg === "--uninstall") uninstall = true;
    else if (arg === "--json") json = true;
    else if (arg === "--restore-backup") {
      // Recorded but not yet a distinct code path here — see init.ts's header for what's shipped.
    } else if (!arg.startsWith("-")) dir = arg;
  }
  return { dir, print, force, uninstall, json };
}

function printInitResult(result: InitResult, json: boolean): void {
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ glosa_json: 1, ok: result.ok, command: "init", exit_code: result.exitCode, data: result.data, warnings: result.warnings, error: result.error ?? null })}\n`,
    );
    return;
  }
  if (result.diff !== undefined) {
    process.stdout.write(result.diff);
    return;
  }
  if (!result.ok) {
    process.stderr.write(`glosa init: ${result.error?.message ?? "failed"}\n`);
    if (result.error?.hint) process.stderr.write(`  hint: ${result.error.hint}\n`);
    return;
  }
  if (!result.changed) {
    process.stdout.write("glosa init: already up to date, nothing to do\n");
    return;
  }
  process.stdout.write("glosa init: installed hooks + MCP entry\n");
  process.stdout.write(`  settings: ${result.data.files.settings.path}\n`);
  process.stdout.write(`  mcp:      ${result.data.files.mcp.path}\n`);
  process.stdout.write(`\nActivate channels for this session with:\n  ${result.data.channel_command}\n`);
}

function printUninstallResult(result: UninstallResult, json: boolean): void {
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ glosa_json: 1, ok: result.ok, command: "init", exit_code: result.exitCode, data: { removed: result.removed }, warnings: result.warnings, error: result.error ?? null })}\n`,
    );
    return;
  }
  if (result.error) {
    process.stderr.write(`glosa init --uninstall: ${result.error.message}\n`);
    return;
  }
  for (const w of result.warnings) process.stderr.write(`glosa init --uninstall: ${w.message}\n`);
  process.stdout.write(result.removed.length > 0 ? `glosa init --uninstall: removed ${result.removed.length} node(s)\n` : "glosa init --uninstall: nothing to remove\n");
}

// ---------------------------------------------------------------------------------------------
// P5.1 — global flags (A6 §F26: "--json --quiet --verbose --port/GLOSA_PORT --help --version")
// and the per-command argument parsers for open/resolve/apply-begin/request-review/doctor/status.
// `--version`/`--help` were already handled above (position-0 only, pre-existing); `--port`,
// `--quiet`, and `--verbose` are extracted HERE, before any subcommand ever sees `argv`, because
// none of the per-command parsers below recognize them — left in place, `--port 4650` would be
// silently misread as a positional arg (e.g. `dir`) by a parser that just checks
// `!arg.startsWith("-")`. `--json` is deliberately NOT extracted globally: every parser already
// checks for it itself (mirrors `parseInitArgs`'s existing convention), so a command's own parser
// stays the single place that decides its `json` flag.
// ---------------------------------------------------------------------------------------------

interface GlobalFlags {
  rest: string[];
  quiet: boolean;
  verbose: boolean;
}

function extractGlobalFlags(argv: readonly string[]): GlobalFlags {
  const rest: string[] = [];
  let quiet = false;
  let verbose = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--port") {
      const value = argv[i + 1];
      if (value !== undefined) {
        Bun.env.GLOSA_PORT = value;
        i++;
      }
      continue;
    }
    if (arg.startsWith("--port=")) {
      Bun.env.GLOSA_PORT = arg.slice("--port=".length);
      continue;
    }
    if (arg === "--quiet") {
      quiet = true;
      continue;
    }
    if (arg === "--verbose") {
      verbose = true;
      continue;
    }
    rest.push(arg);
  }
  return { rest, quiet, verbose };
}

/** A tiny generic flag parser shared by resolve/apply-begin/request-review: `--flag value` or
 * `--flag=value` for anything in `valueFlags`, `--json` recognized unconditionally, everything
 * else that doesn't start with `-` is positional (in argv order). */
function parseFlags(argv: readonly string[], valueFlags: readonly string[]): { positional: string[]; values: Record<string, string>; json: boolean } {
  const positional: string[] = [];
  const values: Record<string, string> = {};
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--json") {
      json = true;
      continue;
    }
    let matched = false;
    for (const flag of valueFlags) {
      if (arg === `--${flag}`) {
        values[flag] = argv[i + 1] ?? "";
        i++;
        matched = true;
        break;
      }
      if (arg.startsWith(`--${flag}=`)) {
        values[flag] = arg.slice(flag.length + 3);
        matched = true;
        break;
      }
    }
    if (matched) continue;
    if (!arg.startsWith("-")) positional.push(arg);
  }
  return { positional, values, json };
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ""; // nothing piped in — e.g. a manually-invoked `glosa hook rewake-watch`
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** `rewake-watch`'s daemon-spawned rearm (A2 §F07) has no live Claude Code hook invocation
 * feeding it stdin — it's a plain detached child THIS CLI spawned, not one Claude Code is
 * currently running a hook cycle for. Its session identity travels via env vars instead
 * (`spawnRewakeWatcher` below sets them); every other event always gets real hook JSON on stdin. */
function sessionFromEnv(): unknown {
  const sessionId = Bun.env.GLOSA_HOOK_SESSION_ID;
  const cwd = Bun.env.GLOSA_HOOK_SESSION_CWD;
  if (!sessionId || !cwd) return {};
  return { session_id: sessionId, cwd, hook_event_name: "SessionStart", source: "rewake-rearm" };
}

const MAIN_PATH = fileURLToPath(new URL("./main.ts", import.meta.url));

/** Production `spawnWatcher` for `RewakeCoordinator` — a detached `glosa hook rewake-watch`
 * child, session identity carried via env (see `sessionFromEnv`'s docstring). Mirrors
 * `lifecycle.ts`'s `spawnAndWait` shape (scrub `ANTHROPIC_API_KEY`, `unref()`, redirect std{out,
 * err} so the parent hook process can exit immediately without waiting on it). */
function spawnRewakeWatcher(sessionId: string, cwd: string): number {
  const env = { ...Bun.env } as Record<string, string | undefined>;
  delete env.ANTHROPIC_API_KEY;
  env.GLOSA_HOOK_SESSION_ID = sessionId;
  env.GLOSA_HOOK_SESSION_CWD = cwd;
  const child = Bun.spawn({
    cmd: [process.execPath, MAIN_PATH, "hook", "rewake-watch"],
    env,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  child.unref();
  return child.pid;
}

let cachedHookDeps: HookDeps | undefined;

/** Built once per process (a hook invocation is a short-lived one-shot CLI call, so "once per
 * process" and "once per invocation" are the same thing) — real `DaemonHookClient` (HTTP,
 * `ensureDaemon`-backed) + a real per-session `RewakeLeaseStore` rooted at
 * `<glosaHome>/.sessions` (A2 §F07's literal path). */
async function hookDeps(): Promise<HookDeps> {
  if (cachedHookDeps) return cachedHookDeps;
  const daemonClient = await createHttpDaemonClient();
  const leases = new RewakeLeaseStore({ dir: join(glosaHome(), ".sessions") });
  const rewake = new RewakeCoordinator({
    leases,
    spawnWatcher: (sessionId) => {
      // `RewakeCoordinator` only knows the session id, not its cwd — read it back off the
      // registry would mean another daemon round trip; simplest correct source is the SAME hook
      // input this dispatch already parsed, threaded through via env at the ONE call site that
      // needs it (`handleSessionStart`/`handleStop` in hook.ts never call this directly — Bun
      // closures capture `lastKnownCwd` set just before `runHook` below).
      return spawnRewakeWatcher(sessionId, lastKnownCwd ?? process.cwd());
    },
  });
  cachedHookDeps = { daemonClient, rewake, leases };
  return cachedHookDeps;
}

let lastKnownCwd: string | undefined;

/**
 * Run the glosa CLI. Returns a process exit code (A6 §F26 stable codes).
 */
export async function run(argv: readonly string[]): Promise<number> {
  // Global flags (A6 §F26) — extracted BEFORE any subcommand parser ever sees the remaining argv,
  // per this section's own header comment above `extractGlobalFlags`.
  const { rest, quiet } = extractGlobalFlags(argv);
  const cmd = rest[0];
  const cmdArgs = rest.slice(1);

  if (cmd === "--version" || cmd === "-v") {
    process.stdout.write(`glosa ${CLI_VERSION}\n`);
    return 0;
  }
  if (cmd === undefined || cmd === "--help" || cmd === "-h") {
    process.stdout.write("glosa — writing-first workspace for AI coding agents\n");
    return 0;
  }
  if (cmd === "__daemon") {
    // The daemon role (A5 §F13) — binds the port, wins the lock CAS, serves, and never
    // returns normally; every exit happens inside bootDaemon via explicit process.exit().
    const { bootDaemon } = await import("@glosa/daemon");
    await bootDaemon();
    return 0; // unreachable
  }
  if (cmd === "init") {
    const parsed = parseInitArgs(cmdArgs);
    if (parsed.uninstall) {
      const result = await runUninstall({ dir: parsed.dir });
      printUninstallResult(result, parsed.json);
      return result.exitCode;
    }
    const result = await runInit({ dir: parsed.dir, print: parsed.print, force: parsed.force });
    printInitResult(result, parsed.json);
    return result.exitCode;
  }
  if (cmd === "hook") {
    const event = cmdArgs[0];
    if (event === undefined) {
      process.stderr.write("glosa hook: missing <event>\n");
      return 2;
    }
    const raw = await readStdin();
    let input: unknown;
    try {
      input = raw.trim().length > 0 ? JSON.parse(raw) : sessionFromEnv();
    } catch {
      process.stderr.write("glosa hook: stdin is not valid JSON\n");
      return 2;
    }
    const cwd = (input as { cwd?: unknown } | null)?.cwd;
    if (typeof cwd === "string") lastKnownCwd = cwd;
    const outcome = await runHook(event, input, await hookDeps());
    if (outcome.stdout) process.stdout.write(outcome.stdout);
    if (outcome.stderr) process.stderr.write(outcome.stderr);
    return outcome.exitCode;
  }
  if (cmd === "mcp") {
    // The stdio MCP shim (A6 §F26/R4 rung-1/rung-4) — proxies the channel push + the pull tool,
    // never binds/locks (R1: "the MCP shim only proxies, never binds/locks"). The real
    // protocol-level stdio server is the P5.4 rehearsal's scope (it needs a live Claude Code
    // client to hand-shake with); this entry point exists so `.mcp.json`'s `command`/`args`
    // resolve to something real today rather than 404ing.
    process.stderr.write("glosa mcp: stdio MCP server not yet implemented (P5.4)\n");
    return 70;
  }
  if (cmd === "open") {
    const parsed = parseFlags(cmdArgs, []);
    const dir = parsed.positional[0] ?? process.cwd();
    const result = await runOpen(dir, realOpenDeps(createHttpGlosaClient));
    printOpenResult(result, parsed.json, quiet);
    return result.exitCode;
  }
  if (cmd === "resolve") {
    const parsed = parseFlags(cmdArgs, ["session", "note"]);
    const result = await runResolve(
      {
        dir: process.cwd(),
        id: parsed.positional[0],
        outcome: parsed.positional[1],
        session: parsed.values.session,
        note: parsed.values.note,
      },
      { createClient: createHttpGlosaClient },
    );
    printResolveResult(result, parsed.json);
    return result.exitCode;
  }
  if (cmd === "apply-begin") {
    const parsed = parseFlags(cmdArgs, ["session"]);
    const result = await runApplyBegin(
      { dir: process.cwd(), id: parsed.positional[0], session: parsed.values.session },
      { createClient: createHttpGlosaClient },
    );
    printApplyBeginResult(result, parsed.json);
    return result.exitCode;
  }
  if (cmd === "request-review") {
    const parsed = parseFlags(cmdArgs, ["message", "action", "wait"]);
    let waitMs: number | undefined;
    if (parsed.values.wait !== undefined) {
      const parsedMs = parseDurationMs(parsed.values.wait);
      if (parsedMs === null) {
        process.stderr.write(`glosa request-review: --wait value '${parsed.values.wait}' is not a valid duration\n`);
        return 2;
      }
      waitMs = parsedMs;
    }
    const result = await runRequestReview(
      {
        dir: process.cwd(),
        path: parsed.positional[0],
        message: parsed.values.message,
        action: parsed.values.action,
        waitMs,
      },
      realRequestReviewDeps(createHttpGlosaClient),
    );
    printRequestReviewResult(result, parsed.json);
    return result.exitCode;
  }
  if (cmd === "doctor") {
    const parsed = parseFlags(cmdArgs, []);
    const dir = parsed.positional[0] ?? process.cwd();
    const result = await runDoctor(dir, realDoctorDeps(createHttpGlosaClient, glosaHome));
    printDoctorResult(result, parsed.json);
    return result.exitCode;
  }
  if (cmd === "status") {
    const parsed = parseFlags(cmdArgs, []);
    const dir = parsed.positional[0] ?? process.cwd();
    const result = await runStatus(dir, { createClient: createHttpGlosaClient });
    printStatusResult(result, parsed.json);
    return result.exitCode;
  }
  // `checkpoints`/`diff`/`restore` (A6 §F31) are documented but out of THIS task's scope (see this
  // file's header comment) — they fall through to here, same as any genuinely unknown command.
  process.stderr.write(`glosa: command not yet implemented: ${cmd}\n`);
  return 2; // usage
}

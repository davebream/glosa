// @glosa/cli — programmatic entry. See docs/requirements.md R8 + docs/appendices/A6.
// The rest of the command surface (open/resolve/apply-begin/request-review/doctor/status), plus
// the real `hook <event>`/`mcp` internal entry points, is implemented in P5.1/P4.3's remaining
// scope. `init` (A6 §F26) lands here now — the transactional hook/MCP merge doesn't depend on
// anything else in that surface.
import { glosaHome } from "@glosa/daemon";
import { RewakeCoordinator, RewakeLeaseStore } from "@glosa/providers-claude-code";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHttpDaemonClient } from "./daemon-client.ts";
import { runHook, type HookDeps } from "./hook.ts";
import { CLI_VERSION, runInit, runUninstall, type InitResult, type UninstallResult } from "./init.ts";

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
  const cmd = argv[0];
  if (cmd === "--version" || cmd === "-v") {
    process.stdout.write(`glosa ${CLI_VERSION}\n`);
    return 0;
  }
  if (cmd === undefined || cmd === "--help" || cmd === "-h") {
    process.stdout.write("glosa — writing-first workspace for AI coding agents (CLI pending P5.1)\n");
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
    const parsed = parseInitArgs(argv.slice(1));
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
    const event = argv[1];
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
  process.stderr.write(`glosa: command not yet implemented: ${cmd}\n`);
  return 2; // usage
}

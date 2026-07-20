// @glosa/cli — programmatic entry. See docs/requirements.md R8 + docs/appendices/A6.
// The real command surface (open/init/resolve/apply-begin/request-review/doctor/status/mcp/hook,
// each with --json + stable exit codes) is implemented in P5.1. This stub keeps the entrypoint
// wired and returns a stable exit code so `main.ts` and the monorepo resolve today.

/**
 * Run the glosa CLI. Returns a process exit code (A6 §F26 stable codes).
 * Scaffold stub: unknown/absent command → usage, exit 2 (0 for --version/--help).
 */
export async function run(argv: readonly string[]): Promise<number> {
  const cmd = argv[0];
  if (cmd === "--version" || cmd === "-v") {
    process.stdout.write("glosa 0.0.0\n");
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
  process.stderr.write(`glosa: command not yet implemented: ${cmd}\n`);
  return 2; // usage
}

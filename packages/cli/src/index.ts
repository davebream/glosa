// @glosa/cli - typed Gunshi command boundary. Domain runners retain the A6 output contract.
import completion from "@gunshi/plugin-completion";
import {
  ArgsValidationError,
  cli,
  define,
  isArgsValidationError,
  isCommandNotFoundError,
  lazy,
  plugin,
  type Args,
  type Command,
  type CommandContext,
  type CommandRunner,
  type GunshiParams,
} from "gunshi";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT_CODES, printJsonEnvelope, usageEnvelope } from "./envelope.ts";
import type { HookDeps } from "./hook.ts";
import type { InitResult, UninstallResult } from "./init.ts";
import { CLI_VERSION } from "./version.ts";

const DESCRIPTION = "Writing-first workspace for AI coding agents";
const PUBLIC_COMMANDS = new Set([
  "open",
  "init",
  "resolve",
  "apply-begin",
  "request-review",
  "doctor",
  "status",
]);

type GlobalValues = {
  json?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  port?: string;
};

const GLOBAL_ARGS = {
  json: {
    type: "boolean",
    description: "Emit the stable A6 JSON envelope",
  },
  quiet: {
    type: "boolean",
    description: "Suppress non-essential human output",
  },
  verbose: {
    type: "boolean",
    description: "Enable verbose diagnostics",
  },
  port: {
    type: "string",
    description: "Override GLOSA_PORT for this invocation",
  },
} as const satisfies Args;

type DefaultContext = Readonly<CommandContext<GunshiParams>>;

function withGlobals<T extends DefaultContext>(context: T): T["values"] & GlobalValues {
  return context.values as T["values"] & GlobalValues;
}

function lazyHandler<A extends Args>(
  definition: Command<{ args: A; extensions: {} }>,
  runner: CommandRunner<{ args: A; extensions: {} }>,
) {
  return lazy<{ args: A; extensions: {} }>(async () => runner, definition);
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
  for (const warning of result.warnings) {
    process.stderr.write(`glosa init --uninstall: ${warning.message}\n`);
  }
  process.stdout.write(
    result.removed.length > 0
      ? `glosa init --uninstall: removed ${result.removed.length} node(s)\n`
      : "glosa init --uninstall: nothing to remove\n",
  );
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function sessionFromEnv(): unknown {
  const sessionId = Bun.env.GLOSA_HOOK_SESSION_ID;
  const cwd = Bun.env.GLOSA_HOOK_SESSION_CWD;
  if (!sessionId || !cwd) return {};
  return { session_id: sessionId, cwd, hook_event_name: "SessionStart", source: "rewake-rearm" };
}

const MAIN_PATH = fileURLToPath(new URL("./main.ts", import.meta.url));

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
let lastKnownCwd: string | undefined;

async function hookDeps(): Promise<HookDeps> {
  if (cachedHookDeps) return cachedHookDeps;
  const [{ createHttpDaemonClient }, { glosaHome }, provider] = await Promise.all([
    import("./daemon-client.ts"),
    import("@glosa/daemon"),
    import("@glosa/providers-claude-code"),
  ]);
  const daemonClient = await createHttpDaemonClient();
  const leases = new provider.RewakeLeaseStore({ dir: join(glosaHome(), ".sessions") });
  const rewake = new provider.RewakeCoordinator({
    leases,
    spawnWatcher: (sessionId) => spawnRewakeWatcher(sessionId, lastKnownCwd ?? process.cwd()),
  });
  cachedHookDeps = { daemonClient, rewake, leases };
  return cachedHookDeps;
}

const globalOptions = plugin({
  id: "glosa:global-options",
  setup(context) {
    for (const [name, schema] of Object.entries(GLOBAL_ARGS)) {
      context.addGlobalOption(name, schema);
    }
  },
});

function createSubCommands(setExitCode: (code: number) => void) {
  const open = lazyHandler(
    {
      name: "open",
      description: "Open a workspace in glosa",
      args: {
        ...GLOBAL_ARGS,
        dir: { type: "positional", required: false, description: "Workspace directory or file" },
        url: { type: "boolean", description: "Print the ready URL without opening a browser" },
      },
    },
    async (context) => {
      const values = withGlobals(context);
      const [{ createHttpGlosaClient }, openModule] = await Promise.all([
        import("./api-client.ts"),
        import("./open.ts"),
      ]);
      const urlOnly = Boolean(values.url);
      const result = await openModule.runOpen(
        (values.dir as string | undefined) ?? process.cwd(),
        openModule.realOpenDeps(createHttpGlosaClient),
        { launchBrowser: !urlOnly },
      );
      openModule.printOpenResult(result, Boolean(values.json), Boolean(values.quiet) || urlOnly);
      setExitCode(result.exitCode);
    },
  );

  const init = lazyHandler(
    {
      name: "init",
      description: "Install or remove glosa's Claude Code integration",
      toKebab: true,
      args: {
        ...GLOBAL_ARGS,
        dir: { type: "positional", required: false, description: "Workspace directory" },
        print: { type: "boolean", description: "Print the planned diff without writing" },
        "dry-run": { type: "boolean", description: "Alias for --print" },
        force: { type: "boolean", description: "Replace conflicting glosa-owned configuration" },
        uninstall: { type: "boolean", description: "Remove configuration owned by glosa" },
        "restore-backup": {
          type: "boolean",
          description: "Reserved for the documented backup restore flow",
          hidden: true,
        },
      },
    },
    async (context) => {
      const values = withGlobals(context);
      const initModule = await import("./init.ts");
      const dir = (values.dir as string | undefined) ?? process.cwd();
      if (values.uninstall) {
        const result = await initModule.runUninstall({ dir });
        printUninstallResult(result, Boolean(values.json));
        setExitCode(result.exitCode);
        return;
      }
      const result = await initModule.runInit({
        dir,
        print: Boolean(values.print) || Boolean(values["dry-run"]),
        force: Boolean(values.force),
      });
      printInitResult(result, Boolean(values.json));
      setExitCode(result.exitCode);
    },
  );

  const resolve = lazyHandler(
    {
      name: "resolve",
      description: "Resolve an inbox entry",
      args: {
        ...GLOBAL_ARGS,
        id: { type: "positional", required: true, description: "Inbox entry ID" },
        outcome: {
          type: "positional",
          required: true,
          description: "Resolution outcome: applied, rejected, deferred, or stale",
        },
        session: { type: "string", required: true, description: "Applying session ID" },
        note: { type: "string", description: "Optional resolution note" },
      },
    },
    async (context) => {
      const values = withGlobals(context);
      const [{ createHttpGlosaClient }, resolveModule] = await Promise.all([
        import("./api-client.ts"),
        import("./resolve.ts"),
      ]);
      const result = await resolveModule.runResolve(
        {
          dir: process.cwd(),
          id: values.id as string,
          outcome: values.outcome as string,
          session: values.session as string,
          note: values.note as string | undefined,
        },
        { createClient: createHttpGlosaClient },
      );
      resolveModule.printResolveResult(result, Boolean(values.json));
      setExitCode(result.exitCode);
    },
  );

  const applyBegin = lazyHandler(
    {
      name: "apply-begin",
      description: "Acquire an entry application lease",
      args: {
        ...GLOBAL_ARGS,
        id: { type: "positional", required: true, description: "Inbox entry ID" },
        session: { type: "string", required: true, description: "Applying session ID" },
      },
    },
    async (context) => {
      const values = withGlobals(context);
      const [{ createHttpGlosaClient }, resolveModule] = await Promise.all([
        import("./api-client.ts"),
        import("./resolve.ts"),
      ]);
      const result = await resolveModule.runApplyBegin(
        { dir: process.cwd(), id: values.id as string, session: values.session as string },
        { createClient: createHttpGlosaClient },
      );
      resolveModule.printApplyBeginResult(result, Boolean(values.json));
      setExitCode(result.exitCode);
    },
  );

  const requestReview = lazyHandler(
    {
      name: "request-review",
      description: "Request human review of an artifact",
      args: {
        ...GLOBAL_ARGS,
        path: { type: "positional", required: true, description: "Artifact path" },
        message: { type: "string", description: "Message shown with the request" },
        action: { type: "string", description: "Requested review action" },
        wait: { type: "string", description: "Wait for a verdict for this duration" },
      },
    },
    async (context) => {
      const values = withGlobals(context);
      const [{ createHttpGlosaClient }, requestModule, { parseDurationMs }] = await Promise.all([
        import("./api-client.ts"),
        import("./request-review.ts"),
        import("./envelope.ts"),
      ]);
      let waitMs: number | undefined;
      if (values.wait !== undefined) {
        const parsed = parseDurationMs(values.wait as string);
        if (parsed === null) {
          const message = `--wait value '${values.wait}' is not a valid duration`;
          if (values.json) printJsonEnvelope(usageEnvelope("request-review", message));
          else process.stderr.write(`glosa request-review: ${message}\n`);
          setExitCode(EXIT_CODES.USAGE);
          return;
        }
        waitMs = parsed;
      }
      const result = await requestModule.runRequestReview(
        {
          dir: process.cwd(),
          path: values.path as string,
          message: values.message as string | undefined,
          action: values.action as string | undefined,
          waitMs,
        },
        requestModule.realRequestReviewDeps(createHttpGlosaClient),
      );
      requestModule.printRequestReviewResult(result, Boolean(values.json));
      setExitCode(result.exitCode);
    },
  );

  const doctor = lazyHandler(
    {
      name: "doctor",
      description: "Check the local glosa installation",
      args: {
        ...GLOBAL_ARGS,
        dir: { type: "positional", required: false, description: "Workspace directory" },
      },
    },
    async (context) => {
      const values = withGlobals(context);
      const [{ createHttpGlosaClient }, { glosaHome }, doctorModule] = await Promise.all([
        import("./api-client.ts"),
        import("@glosa/daemon"),
        import("./doctor.ts"),
      ]);
      const result = await doctorModule.runDoctor(
        (values.dir as string | undefined) ?? process.cwd(),
        doctorModule.realDoctorDeps(createHttpGlosaClient, glosaHome),
      );
      doctorModule.printDoctorResult(result, Boolean(values.json));
      setExitCode(result.exitCode);
    },
  );

  const status = lazyHandler(
    {
      name: "status",
      description: "Show daemon and workspace status",
      args: {
        ...GLOBAL_ARGS,
        dir: { type: "positional", required: false, description: "Workspace directory" },
      },
    },
    async (context) => {
      const values = withGlobals(context);
      const [{ createHttpGlosaClient }, statusModule] = await Promise.all([
        import("./api-client.ts"),
        import("./status.ts"),
      ]);
      const result = await statusModule.runStatus(
        (values.dir as string | undefined) ?? process.cwd(),
        { createClient: createHttpGlosaClient },
      );
      statusModule.printStatusResult(result, Boolean(values.json));
      setExitCode(result.exitCode);
    },
  );

  const hook = lazyHandler(
    {
      name: "hook",
      description: "Claude Code hook protocol entry point",
      internal: true,
      args: {
        event: { type: "positional", required: false },
      },
    },
    async (context) => {
      const values = withGlobals(context);
      if (values.event === undefined) {
        process.stderr.write("glosa hook: missing <event>\n");
        setExitCode(EXIT_CODES.USAGE);
        return;
      }
      const raw = await readStdin();
      let input: unknown;
      try {
        input = raw.trim().length > 0 ? JSON.parse(raw) : sessionFromEnv();
      } catch {
        process.stderr.write("glosa hook: stdin is not valid JSON\n");
        setExitCode(EXIT_CODES.USAGE);
        return;
      }
      const cwd = (input as { cwd?: unknown } | null)?.cwd;
      if (typeof cwd === "string") lastKnownCwd = cwd;
      const { runHook } = await import("./hook.ts");
      const outcome = await runHook(values.event as string, input, await hookDeps());
      if (outcome.stdout) process.stdout.write(outcome.stdout);
      if (outcome.stderr) process.stderr.write(outcome.stderr);
      setExitCode(outcome.exitCode);
    },
  );

  const mcp = lazyHandler(
    { name: "mcp", description: "MCP stdio protocol entry point", internal: true },
    async () => {
      process.stderr.write("glosa mcp: stdio MCP server not yet implemented (P5.4)\n");
      setExitCode(EXIT_CODES.INTERNAL);
    },
  );

  const daemon = lazyHandler(
    { name: "__daemon", description: "Detached daemon process", internal: true },
    async () => {
      const { bootDaemon } = await import("@glosa/daemon");
      await bootDaemon();
    },
  );

  const placeholder = (name: string) =>
    lazyHandler(
      { name, description: "Reserved command", internal: true },
      async () => {
        process.stderr.write(`glosa: command not yet implemented: ${name}\n`);
        setExitCode(EXIT_CODES.USAGE);
      },
    );

  return {
    open,
    init,
    resolve,
    "apply-begin": applyBegin,
    "request-review": requestReview,
    doctor,
    status,
    hook,
    mcp,
    __daemon: daemon,
    checkpoints: placeholder("checkpoints"),
    diff: placeholder("diff"),
    restore: placeholder("restore"),
  };
}

function commandNameForError(argv: readonly string[], error: unknown): string {
  if (isCommandNotFoundError(error)) return error.commandName;
  return argv.find((arg) => PUBLIC_COMMANDS.has(arg)) ?? "glosa";
}

function usageMessage(error: unknown): string {
  if (error instanceof AggregateError) {
    const messages = error.errors
      .filter((item): item is Error => item instanceof Error)
      .map((item) => item.message);
    if (messages.length > 0) return messages.join("; ");
  }
  return error instanceof Error ? error.message : String(error);
}

function isUsageError(error: unknown): boolean {
  if (isArgsValidationError(error) || isCommandNotFoundError(error)) return true;
  if (error instanceof AggregateError) return error.errors.every(isUsageError);
  return error instanceof ArgsValidationError;
}

function writeBoundaryError(argv: readonly string[], error: unknown, exitCode: number): void {
  const command = commandNameForError(argv, error);
  const message = usageMessage(error);
  if (argv.includes("--json")) {
    if (exitCode === EXIT_CODES.USAGE) {
      printJsonEnvelope(usageEnvelope(command, message));
    } else {
      printJsonEnvelope({
        ok: false,
        command,
        exitCode,
        data: {},
        warnings: [],
        error: { code: "internal", kind: "internal", message: "Internal CLI error" },
      });
    }
    return;
  }
  process.stderr.write(`glosa${command === "glosa" ? "" : ` ${command}`}: ${message}\n`);
}

function assertNoSurplusPositionals(context: DefaultContext): void {
  if (context.name === "complete" || context.callMode === "unexpected") return;
  const declared = Object.values(context.args).filter((arg) => arg.type === "positional").length;
  const consumedCommandPath = context.commandPath.length;
  if (context.positionals.length <= declared + consumedCommandPath) return;
  const unexpected = context.positionals[declared + consumedCommandPath];
  throw new ArgsValidationError(`Unexpected positional argument: ${unexpected}`);
}

function normalizeGunshiArgs(argv: readonly string[]): string[] {
  const normalized: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] as string;
    if (arg === "--") {
      normalized.push(...argv.slice(index));
      break;
    }
    const value = argv[index + 1];
    if (arg === "--port" && value !== undefined && !value.startsWith("-")) {
      // Gunshi 0.37.1 discovers the command before resolving a spaced global option value.
      // The equals form keeps command discovery correct while Gunshi still owns validation.
      normalized.push(`--port=${value}`);
      index++;
      continue;
    }
    normalized.push(arg);
  }
  return normalized;
}

/** Run the glosa CLI and return an A6 process exit code. */
export async function run(argv: readonly string[]): Promise<number> {
  let exitCode: number = EXIT_CODES.OK;
  const root = define({
    name: "glosa",
    description: DESCRIPTION,
    args: GLOBAL_ARGS,
    run() {
      process.stdout.write("glosa — writing-first workspace for AI coding agents\n");
    },
  });

  try {
    const rendered = await cli(normalizeGunshiArgs(argv), root, {
      name: "glosa",
      version: CLI_VERSION,
      description: DESCRIPTION,
      plugins: [globalOptions, completion()],
      subCommands: createSubCommands((code) => {
        exitCode = code;
      }),
      strict: true,
      usageSilent: true,
      onBeforeCommand(context) {
        assertNoSurplusPositionals(context as DefaultContext);
        const values = withGlobals(context as DefaultContext);
        if (typeof values.port === "string") Bun.env.GLOSA_PORT = values.port;
      },
    });

    if (typeof rendered === "string") {
      const output = rendered === CLI_VERSION ? `glosa ${rendered}` : rendered;
      process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
    }
    return exitCode;
  } catch (error) {
    const code = isUsageError(error) ? EXIT_CODES.USAGE : EXIT_CODES.INTERNAL;
    writeBoundaryError(argv, error, code);
    return code;
  }
}

// SPDX-License-Identifier: Apache-2.0
// @glosa/cli - typed Gunshi command boundary. Domain runners retain the A6 output contract.

import { realpathSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import completion from "@gunshi/plugin-completion";
import {
  type Args,
  ArgsValidationError,
  type Command,
  type CommandContext,
  type CommandRunner,
  cli,
  define,
  type GunshiParams,
  isArgsValidationError,
  isCommandNotFoundError,
  lazy,
  plugin,
} from "gunshi";
import type { GlosaApiClient } from "./api-client.ts";
import { EXIT_CODES, printJsonEnvelope, usageEnvelope } from "./envelope.ts";
import type { HookDeps } from "./hook.ts";
import type { InitResult, ProviderId, UninstallResult } from "./scoped-init.ts";
import { CLI_VERSION } from "./version.ts";

const DESCRIPTION = "Writing-first workspace for AI coding agents";
const HOOK_ENSURE_TIMEOUT_MS = 3000;
const PUBLIC_COMMANDS = new Set([
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

export interface CliRunDependencies {
  /** Init-specific host dependencies. Omit in production to use the real home and PATH. */
  init?: {
    homeDir?: string;
    glosaHomeDir?: string;
    which?: (executable: string) => string | null;
  };
  /** Doctor-specific seams for command-boundary tests. Omit in production for the real daemon. */
  doctor?: {
    createClient?: () => Promise<GlosaApiClient>;
    glosaHome?: () => string;
  };
}

function withGlobals<T extends DefaultContext>(context: T): T["values"] & GlobalValues {
  return context.values as T["values"] & GlobalValues;
}

function lazyHandler<A extends Args>(
  definition: Command<{ args: A; extensions: {} }>,
  runner: CommandRunner<{ args: A; extensions: {} }>,
) {
  return lazy<{ args: A; extensions: {} }>(async () => runner, definition);
}

/**
 * The workspace root `init`/`doctor` operate on, plus anything worth telling the user about it
 * (issue #96).
 *
 * With NO `dir` argument, the cwd is resolved to its enclosing git repository — the same root
 * `glosa open` now resolves a file to, and the only root at which `.claude/settings.json` and
 * `.mcp.json` actually take effect. Running `glosa init` from `<repo>/docs` used to wire
 * `<repo>/docs/.claude/`, which Claude Code never reads.
 *
 * An EXPLICIT `dir` is always honoured literally — silently retargeting an argument the user
 * typed would be worse than the bug — but a non-root directory inside a repo gets a warning
 * naming the root, so the two commands can still be reconciled by hand.
 */
async function resolveCommandDir(
  explicitDir: string | undefined,
  cwd: string,
): Promise<{ dir: string; warnings: { code: string; message: string }[] }> {
  const { enclosingGitRoot } = await import("../../daemon/src/index.ts");
  if (explicitDir === undefined) {
    const root = enclosingGitRoot(cwd);
    return { dir: root ?? cwd, warnings: [] };
  }
  const root = enclosingGitRoot(explicitDir);
  // `enclosingGitRoot` returns a realpath'd absolute path, so `.`, `./sub`, and a symlinked
  // checkout must be canonicalized the same way before the "is this already the root?" compare —
  // otherwise `glosa init .` at a repo root would warn about itself.
  const canonicalDir = (() => {
    try {
      return realpathSync(resolvePath(cwd, explicitDir));
    } catch {
      return resolvePath(cwd, explicitDir);
    }
  })();
  if (root !== null && root !== canonicalDir) {
    return {
      dir: explicitDir,
      warnings: [
        {
          code: "not-repository-root",
          message: `${explicitDir} is inside the git repository ${root} but is not its root — agent configuration written here is not what Claude Code loads for the project. Did you mean \`${root}\`?`,
        },
      ],
    };
  }
  return { dir: explicitDir, warnings: [] };
}

function printInitResult(result: InitResult, json: boolean): void {
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ glosa_json: 1, ok: result.ok, command: "init", exit_code: result.exitCode, data: result.data, warnings: result.warnings, error: result.error ?? null })}\n`,
    );
    return;
  }
  // Command-level warnings (e.g. #96's "this dir isn't the repo root") sit alongside, not inside,
  // the diff/changed/error branches below — print them first so they're never lost regardless of
  // which of those branches returns early.
  for (const warning of result.warnings) {
    process.stderr.write(`glosa init: warning: ${warning.message}\n`);
  }
  // `--print` on an already-wired workspace produces `diff: ""`. Branching on `!== undefined`
  // alone made that case write an empty string and exit 0 — `glosa init --print` said literally
  // nothing, which reads as a broken command rather than as "nothing to change" (issue #96).
  if (result.diff !== undefined) {
    if (result.diff.length > 0) process.stdout.write(result.diff);
    else if (result.changed) {
      // No file would change, but the run is still `changed` — a provider is being adopted into
      // the manifest, or a legacy manifest is being migrated. Say which, rather than implying
      // `init` would be a complete no-op.
      process.stdout.write("glosa init: no file changes; only the glosa ownership manifest would be updated\n");
    } else process.stdout.write("glosa init: already up to date, nothing to do\n");
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
  process.stdout.write(`  scope:     ${result.data.scope}\n`);
  process.stdout.write(`  providers: ${result.data.providers.join(", ")}\n`);
  for (const file of Object.values(result.data.files)) process.stdout.write(`  ${file.path}\n`);
  if (result.data.activation_help.length > 0) {
    process.stdout.write(`\nActivation help:\n${result.data.activation_help.map((line) => `  ${line}`).join("\n")}\n`);
  }
  if (result.data.providers.includes("claude-code")) {
    process.stdout.write(
      "\nRestart or /resume your Claude Code session so it loads glosa; until then annotations are queued, not delivered.\n",
    );
  }
}

function printUninstallResult(result: UninstallResult, json: boolean): void {
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ glosa_json: 1, ok: result.ok, command: "init", exit_code: result.exitCode, data: { ...result.data, removed: result.removed }, warnings: result.warnings, error: result.error ?? null })}\n`,
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

const INIT_AGENT_HINT = "pass --agent claude-code, --agent codex, or --agent all";

function normalizeInitAgents(values: unknown): { agents?: ProviderId[]; error?: string } {
  if (values === undefined) return {};
  const raw = Array.isArray(values) ? values.map(String) : [String(values)];
  const unique = [...new Set(raw)];
  if (unique.includes("all") && unique.length > 1)
    return { error: "--agent all cannot be combined with another --agent" };
  if (unique.some((value) => value !== "all" && value !== "claude-code" && value !== "codex")) {
    return { error: `--agent must be claude-code, codex, or all` };
  }
  return { agents: unique.includes("all") ? ["claude-code", "codex"] : (unique as ProviderId[]) };
}

export async function promptInitAgents(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stderr,
): Promise<ProviderId[]> {
  const prompt = createInterface({ input, output });
  try {
    const answer = await prompt.question("Select agent integration: [1] Claude Code  [2] Codex  [3] all\nChoice: ");
    if (answer.trim() === "1") return ["claude-code"];
    if (answer.trim() === "2") return ["codex"];
    if (answer.trim() === "3") return ["claude-code", "codex"];
    throw new ArgsValidationError(`invalid provider selection; ${INIT_AGENT_HINT}`);
  } finally {
    prompt.close();
  }
}

function writeOutput(stream: NodeJS.WritableStream, value: string): Promise<void> {
  if (!value) return Promise.resolve();
  return new Promise((resolve, reject) => {
    stream.write(value, (error?: Error | null) => (error ? reject(error) : resolve()));
  });
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
    import("../../daemon/src/index.ts"),
    import("../../providers/claude-code/src/index.ts"),
  ]);
  const daemonClient = await createHttpDaemonClient({ ensureTimeoutMs: HOOK_ENSURE_TIMEOUT_MS });
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

function createSubCommands(setExitCode: (code: number) => void, deps: CliRunDependencies) {
  const initRoots = {
    homeDir: deps.init?.homeDir,
    glosaHomeDir: deps.init?.glosaHomeDir,
  };
  const open = lazyHandler(
    {
      name: "open",
      description: "Open a workspace or document in glosa",
      args: {
        ...GLOBAL_ARGS,
        target: { type: "positional", required: false, description: "Workspace directory or file" },
        focus: {
          type: "positional",
          required: false,
          description: "Artifact to focus inside a workspace directory",
        },
        url: { type: "boolean", description: "Print the ready URL without opening a browser" },
        preview: {
          type: "boolean",
          description: "Open locked in Preview mode (hides Annotate/Edit affordances)",
        },
        bind: {
          type: "string",
          description: "Bind a live agent session after registration (nonfatal on failure)",
        },
        document: {
          type: "boolean",
          description: "Force document surface (single-file UX, no navigator)",
        },
        workspace: {
          type: "boolean",
          description: "Force workspace surface (sidebar / multi-file chrome)",
        },
        "external-state": {
          type: "boolean",
          description: "Store directory state under GLOSA_HOME instead of beside it",
        },
        init: {
          type: "boolean",
          description: "Wire the workspace (run `glosa init`) without prompting",
        },
        "no-init": {
          type: "boolean",
          description: "Never prompt to wire the workspace",
        },
      },
    },
    async (context) => {
      const values = withGlobals(context);
      const [{ createHttpGlosaClient }, openModule] = await Promise.all([
        import("./api-client.ts"),
        import("./open.ts"),
      ]);
      const urlOnly = Boolean(values.url);
      const document = Boolean(values.document);
      const workspace = Boolean(values.workspace);
      if (document && workspace) {
        process.stderr.write("glosa open: --document and --workspace are mutually exclusive\n");
        setExitCode(2);
        return;
      }
      if (values.init && values["no-init"]) {
        process.stderr.write("glosa open: --init and --no-init are mutually exclusive\n");
        setExitCode(2);
        return;
      }
      const result = await openModule.runOpen(
        (values.target as string | undefined) ?? process.cwd(),
        openModule.realOpenDeps(createHttpGlosaClient),
        {
          launchBrowser: !urlOnly,
          externalState: Boolean(values["external-state"]),
          previewLock: Boolean(values.preview),
          bindSessionId: typeof values.bind === "string" ? values.bind : undefined,
          focus: values.focus as string | undefined,
          surface: document ? "document" : workspace ? "workspace" : "auto",
        },
      );
      openModule.printOpenResult(result, Boolean(values.json), Boolean(values.quiet) || urlOnly);
      // Consent-gated wiring offer AFTER the warning + URL print so the prompt reads as a
      // follow-up to the not-initialized warning. Never changes open's exit code.
      await openModule.maybeOfferInit(result, {
        initFlag: Boolean(values.init),
        noInitFlag: Boolean(values["no-init"]),
        json: Boolean(values.json),
      });
      setExitCode(result.exitCode);
    },
  );

  const init = lazyHandler(
    {
      name: "init",
      description: "Install or remove glosa agent integrations",
      toKebab: true,
      args: {
        ...GLOBAL_ARGS,
        dir: { type: "positional", required: false, description: "Workspace directory" },
        scope: { type: "string", description: "Installation scope: workspace or user" },
        agent: {
          type: "string",
          multiple: true,
          description: "Agent provider: claude-code, codex, or all (repeatable)",
        },
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
      const initModule = await import("./scoped-init.ts");
      const { dir, warnings: dirWarnings } = await resolveCommandDir(values.dir as string | undefined, process.cwd());
      const scope = (values.scope as string | undefined) ?? "workspace";
      if (scope !== "workspace" && scope !== "user") {
        const message = "--scope must be workspace or user";
        if (values.json) printJsonEnvelope(usageEnvelope("init", message));
        else process.stderr.write(`glosa init: ${message}\n`);
        setExitCode(EXIT_CODES.USAGE);
        return;
      }
      const normalized = normalizeInitAgents(values.agent);
      if (normalized.error) {
        if (values.json) printJsonEnvelope(usageEnvelope("init", normalized.error));
        else process.stderr.write(`glosa init: ${normalized.error}\n`);
        setExitCode(EXIT_CODES.USAGE);
        return;
      }
      if (values.uninstall) {
        const result = await initModule.runScopedUninstall({
          dir,
          scope,
          agents: normalized.agents,
          ...initRoots,
        });
        printUninstallResult({ ...result, warnings: [...dirWarnings, ...result.warnings] }, Boolean(values.json));
        setExitCode(result.exitCode);
        return;
      }
      // Refuse to write agent config into a temp directory or a bare parent holding several
      // unrelated git repos (issue #96) — this is what following `glosa open`'s pre-fix
      // `not-initialized` hint into `/private/tmp` or a `~/code`-style parent would have done.
      // Scope `user` writes under $HOME/$GLOSA_HOME regardless of `dir` (see the provider
      // descriptors' `targets()`), so the guard only applies to `workspace` scope, where `dir`
      // itself is the write target.
      if (scope === "workspace" && !values.force) {
        const { classifyInitTarget } = await import("../../daemon/src/index.ts");
        const verdict = classifyInitTarget(dir);
        if (verdict.risk !== "none") {
          let proceed = false;
          if (!values.json && process.stdin.isTTY) {
            const { confirmOnTty } = await import("./confirm.ts");
            proceed = await confirmOnTty(`${verdict.detail}\nWrite glosa's agent config into ${dir} anyway?`);
          }
          if (!proceed) {
            const message = `${verdict.detail} — refusing to write agent config here`;
            const hint = "pass --force to proceed anyway, or run `glosa init` against the intended project root";
            if (values.json) {
              printJsonEnvelope({
                ok: false,
                command: "init",
                exitCode: EXIT_CODES.USAGE,
                data: {},
                warnings: dirWarnings,
                error: { code: "unsafe-init-target", kind: "usage", message, hint },
              });
            } else {
              for (const warning of dirWarnings) process.stderr.write(`glosa init: warning: ${warning.message}\n`);
              process.stderr.write(`glosa init: ${message}\n  hint: ${hint}\n`);
            }
            setExitCode(EXIT_CODES.USAGE);
            return;
          }
        }
      }
      let agents = normalized.agents;
      if (!agents) {
        const detected = initModule.detectInstallProviders(dir, {
          ...initRoots,
          which: deps.init?.which,
        });
        if (detected.length === 1) {
          agents = detected;
        } else if (values.json || !process.stdin.isTTY) {
          const message = `provider selection is ambiguous; ${INIT_AGENT_HINT}`;
          if (values.json) printJsonEnvelope(usageEnvelope("init", message));
          else process.stderr.write(`glosa init: ${message}\n`);
          setExitCode(EXIT_CODES.USAGE);
          return;
        } else {
          agents = await promptInitAgents();
        }
      }
      const result = await initModule.runScopedInit({
        dir,
        scope,
        agents,
        print: Boolean(values.print) || Boolean(values["dry-run"]),
        force: Boolean(values.force),
        ...initRoots,
      });
      printInitResult({ ...result, warnings: [...dirWarnings, ...result.warnings] }, Boolean(values.json));
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
        "require-approval": {
          type: "boolean",
          description: "Require explicit final approval of the saved artifact revision",
        },
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
          requireApproval: values["require-approval"] as boolean | undefined,
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
        import("../../daemon/src/index.ts"),
        import("./doctor.ts"),
      ]);
      const { dir, warnings: dirWarnings } = await resolveCommandDir(values.dir as string | undefined, process.cwd());
      const result = await doctorModule.runDoctor(
        dir,
        doctorModule.realDoctorDeps(
          deps.doctor?.createClient ?? createHttpGlosaClient,
          deps.doctor?.glosaHome ?? glosaHome,
        ),
      );
      const withDirWarnings =
        dirWarnings.length === 0 ? result : { ...result, warnings: [...dirWarnings, ...result.warnings] };
      doctorModule.printDoctorResult(withDirWarnings, Boolean(values.json));
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
      const result = await statusModule.runStatus((values.dir as string | undefined) ?? process.cwd(), {
        createClient: createHttpGlosaClient,
      });
      statusModule.printStatusResult(result, Boolean(values.json));
      setExitCode(result.exitCode);
    },
  );

  const inbox = lazyHandler(
    {
      name: "inbox",
      description: "Retrieve an actionable inbox presentation",
      args: {
        ...GLOBAL_ARGS,
        action: { type: "positional", required: true, description: "Inbox action (get)" },
        id: { type: "positional", required: true, description: "Inbox entry ID" },
        cursor: { type: "string", description: "Opaque continuation cursor" },
        workspace: { type: "string", description: "Workspace directory" },
      },
    },
    async (context) => {
      const values = withGlobals(context);
      if (values.action !== "get") {
        process.stderr.write(`glosa inbox: unsupported action '${String(values.action)}'\n`);
        setExitCode(EXIT_CODES.USAGE);
        return;
      }
      const [{ createHttpGlosaClient }, inboxModule] = await Promise.all([
        import("./api-client.ts"),
        import("./inbox.ts"),
      ]);
      const result = await inboxModule.runInboxGet(
        {
          workspace: (values.workspace as string | undefined) ?? process.cwd(),
          id: values.id as string,
          cursor: values.cursor as string | undefined,
        },
        { createClient: createHttpGlosaClient },
      );
      inboxModule.printInboxGetResult(result, Boolean(values.json));
      setExitCode(result.exitCode);
    },
  );

  const metadata = lazyHandler(
    {
      name: "metadata",
      description: "Set, show, or clear declarative workspace metadata",
      args: {
        ...GLOBAL_ARGS,
        action: { type: "positional", required: true, description: "Metadata action: set, show, or clear" },
        file: { type: "positional", required: false, description: "Descriptor JSON file for set" },
        workspace: { type: "string", description: "Workspace directory" },
      },
    },
    async (context) => {
      const values = withGlobals(context);
      const [{ createHttpGlosaClient }, metadataModule] = await Promise.all([
        import("./api-client.ts"),
        import("./metadata.ts"),
      ]);
      const result = await metadataModule.runMetadata(
        {
          action: values.action as string,
          file: values.file as string | undefined,
          workspace: (values.workspace as string | undefined) ?? process.cwd(),
        },
        createHttpGlosaClient,
      );
      metadataModule.printMetadataResult(result, Boolean(values.json));
      setExitCode(result.exitCode);
    },
  );

  const session = lazyHandler(
    {
      name: "session",
      description: "Bind a live agent session to a workspace",
      args: {
        ...GLOBAL_ARGS,
        action: { type: "positional", required: true, description: "Session action (bind)" },
        id: { type: "positional", required: true, description: "Live session ID" },
        workspace: { type: "string", description: "Workspace directory" },
      },
    },
    async (context) => {
      const values = withGlobals(context);
      if (values.action !== "bind") {
        const message = `unsupported session action '${String(values.action)}'`;
        if (values.json) printJsonEnvelope(usageEnvelope("session", message));
        else process.stderr.write(`glosa session: ${message}\n`);
        setExitCode(EXIT_CODES.USAGE);
        return;
      }
      const [{ createHttpGlosaClient }, sessionModule] = await Promise.all([
        import("./api-client.ts"),
        import("./session.ts"),
      ]);
      const result = await sessionModule.runSessionBind(
        (values.workspace as string | undefined) ?? process.cwd(),
        values.id as string,
        createHttpGlosaClient,
      );
      sessionModule.printSessionBindResult(result, Boolean(values.json));
      setExitCode(result.exitCode);
    },
  );

  const token = lazyHandler(
    {
      name: "token",
      description: "Rotate or revoke the local pairing credential",
      args: {
        ...GLOBAL_ARGS,
        action: { type: "positional", required: true, description: "Token action: rotate or revoke" },
      },
    },
    async (context) => {
      const values = withGlobals(context);
      if (values.action !== "rotate" && values.action !== "revoke") {
        const message = `unsupported token action '${String(values.action)}'`;
        if (values.json) printJsonEnvelope(usageEnvelope("token", message));
        else process.stderr.write(`glosa token: ${message}\n`);
        setExitCode(EXIT_CODES.USAGE);
        return;
      }
      const tokenModule = await import("./token.ts");
      const result = tokenModule.runToken(values.action);
      tokenModule.printTokenResult(result, Boolean(values.json));
      setExitCode(result.exitCode);
    },
  );

  const update = lazyHandler(
    {
      name: "update",
      description: "Upgrade this glosa installation",
      args: {
        ...GLOBAL_ARGS,
        check: { type: "boolean", description: "Report what would change without installing" },
        "dry-run": { type: "boolean", description: "Alias for --check" },
        force: { type: "boolean", description: "Install the resolved target regardless of version comparison" },
        channel: { type: "string", description: "Release channel (dist-tag) to follow" },
        to: { type: "string", description: "Install this exact version" },
        registry: { type: "string", description: "Registry to resolve the release from" },
        "allow-offsite-tarball": {
          type: "boolean",
          description: "Accept a tarball hosted off the configured registry",
        },
      },
    },
    async (context) => {
      const values = withGlobals(context);
      // ONE import, ALL THREE symbols. Nothing may `await import` after this point — the package
      // directory is replaced underneath this process while the installer runs, so a later lazy
      // import can resolve to a file that no longer exists.
      const { runUpdate, printUpdateResult, realUpdateDeps } = await import("./update.ts");
      const result = await runUpdate(
        {
          // `json` is not only a printer concern: runUpdate branches on it to choose inherited vs
          // piped-and-redacted installer stdio, and to suppress the pre-spawn block. Omitting it
          // here would make the whole --json path unreachable in the shipped command.
          json: Boolean(values.json),
          quiet: Boolean(values.quiet),
          check: Boolean(values.check || values["dry-run"]),
          force: Boolean(values.force),
          channel: values.channel as string | undefined,
          to: values.to as string | undefined,
          registry: values.registry as string | undefined,
          allowOffsiteTarball: Boolean(values["allow-offsite-tarball"]),
        },
        realUpdateDeps(),
      );
      printUpdateResult(result, Boolean(values.json), { quiet: Boolean(values.quiet) });
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
        provider: { type: "string", description: "Hook provider: claude-code or codex" },
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
      const { runHook, validateHookInvocation } = await import("./hook.ts");
      const providerId = (values.provider as string | undefined) ?? "claude-code";
      const validation = validateHookInvocation(values.event as string, input, providerId);
      if (validation) {
        await writeOutput(process.stdout, validation.stdout);
        await writeOutput(process.stderr, validation.stderr);
        setExitCode(validation.exitCode);
        return;
      }
      let deps: HookDeps;
      try {
        deps = await hookDeps();
      } catch (error) {
        // Hooks are one rung in the durable delivery ladder. If daemon discovery cannot finish
        // inside the hook-specific budget, yield silently so the host prompt is never delayed or
        // discarded; explicit CLI and MCP clients retain the actionable error.
        if (typeof error === "object" && error !== null && "code" in error && error.code === "DAEMON_UNREACHABLE") {
          setExitCode(EXIT_CODES.OK);
          return;
        }
        throw error;
      }
      const outcome = await runHook(values.event as string, input, deps, process.pid, providerId);
      try {
        await writeOutput(process.stdout, outcome.stdout);
        await writeOutput(process.stderr, outcome.stderr);
        if (outcome.delivery) {
          await deps.daemonClient.acknowledge?.(outcome.delivery.sessionId, outcome.delivery.deliveryId, "presented");
        }
      } catch (error) {
        if (outcome.delivery) {
          await deps.daemonClient.acknowledge?.(
            outcome.delivery.sessionId,
            outcome.delivery.deliveryId,
            "failed",
            error instanceof Error ? error.message : String(error),
          );
        }
        throw error;
      }
      setExitCode(outcome.exitCode);
    },
  );

  const mcp = lazyHandler({ name: "mcp", description: "MCP stdio protocol entry point", internal: true }, async () => {
    const [{ createHttpDaemonClient }, { createHttpGlosaClient }, { runMcpServer }] = await Promise.all([
      import("./daemon-client.ts"),
      import("./api-client.ts"),
      import("./mcp.ts"),
    ]);
    await runMcpServer({
      createHookClient: createHttpDaemonClient,
      createApiClient: createHttpGlosaClient,
      sessionId: () => process.env.CLAUDE_CODE_SESSION_ID,
    });
  });

  const daemon = lazyHandler({ name: "__daemon", description: "Detached daemon process", internal: true }, async () => {
    const { bootDaemon } = await import("../../daemon/src/index.ts");
    const { ClaudeCodeProvider } = await import("../../providers/claude-code/src/index.ts");
    const { CodexProvider } = await import("../../providers/codex/src/index.ts");
    await bootDaemon({
      providerFactories: [
        ({ sessionRegistry, pushRegistry }) =>
          new ClaudeCodeProvider({
            liveness: sessionRegistry,
            channelsEnabled: (session) => pushRegistry.has(session.session_id),
            sendChannel: (session, entry) => pushRegistry.send(session.session_id, entry),
          }),
        ({ sessionRegistry }) => new CodexProvider({ liveness: sessionRegistry }),
      ],
    });
  });

  const placeholder = (name: string) =>
    lazyHandler({ name, description: "Reserved command", internal: true }, async () => {
      process.stderr.write(`glosa: command not yet implemented: ${name}\n`);
      setExitCode(EXIT_CODES.USAGE);
    });

  return {
    open,
    init,
    resolve,
    "apply-begin": applyBegin,
    "request-review": requestReview,
    doctor,
    status,
    inbox,
    metadata,
    session,
    token,
    update,
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
    const messages = error.errors.filter((item): item is Error => item instanceof Error).map((item) => item.message);
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
export async function run(argv: readonly string[], deps: CliRunDependencies = {}): Promise<number> {
  if (argv.length === 1 && argv[0] === "--build-id") {
    const { BUILD_ID } = await import("../../daemon/src/lifecycle/build-id.ts");
    process.stdout.write(`${BUILD_ID}\n`);
    return EXIT_CODES.OK;
  }

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
      }, deps),
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

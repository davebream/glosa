// SPDX-License-Identifier: Apache-2.0
// @glosa/cli - typed Gunshi command boundary. Domain runners retain the A6 output contract.

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
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
import { CLI_VERSION } from "./version.ts";

const DESCRIPTION = "Writing-first workspace for AI coding agents";
const PUBLIC_COMMANDS = new Set([
  "open",
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
  "forget",
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
  /** Inbox command-boundary seam; production retains the HTTP client. */
  inbox?: { createClient?: () => Promise<GlosaApiClient> };
  /** The user-home seam for the workspace-root boundary (issue #146) `resolveCommandDir` applies
   * to `doctor`'s cwd default. Omit in production to use the real home. */
  home?: { homeDir?: string };
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
 * The workspace root `doctor` operates on, plus anything worth telling the user about it
 * (issue #96).
 *
 * With NO `dir` argument, the cwd is resolved to its enclosing git repository — the same root
 * `glosa open` resolves a file to.
 *
 * An EXPLICIT `dir` is always honoured literally — silently retargeting an argument the user
 * typed would be worse than the bug — but a non-root directory inside a repo gets a warning
 * naming the root, so the two commands can still be reconciled by hand.
 *
 * `home` is the injectable user-home seam for the boundary in `enclosingGitRootWithin` (issue
 * #146): on a machine whose home is itself a git checkout, the enclosing-repository walk used to
 * reach `$HOME` with nothing to stop it. Callers pass the real `os.homedir()` (or a test's
 * `--init`-scoped override) explicitly rather than letting this function call it internally,
 * because `os.homedir()` does not follow a mutated `process.env.HOME` under the pinned Bun — a
 * boundary with no such seam could never be handed a fake home by a test.
 */
async function resolveCommandDir(
  explicitDir: string | undefined,
  cwd: string,
  home: string,
): Promise<{ dir: string; warnings: { code: string; message: string }[] }> {
  const { enclosingGitRootWithin } = await import("../../daemon/src/index.ts");
  if (explicitDir === undefined) {
    const root = enclosingGitRootWithin(cwd, home);
    return { dir: root ?? cwd, warnings: [] };
  }
  const root = enclosingGitRootWithin(explicitDir, home);
  // `enclosingGitRootWithin` returns a realpath'd absolute path, so `.`, `./sub`, and a symlinked
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

const globalOptions = plugin({
  id: "glosa:global-options",
  setup(context) {
    for (const [name, schema] of Object.entries(GLOBAL_ARGS)) {
      context.addGlobalOption(name, schema);
    }
  },
});

function createSubCommands(setExitCode: (code: number) => void, deps: CliRunDependencies) {
  // The user-home seam for the #146 workspace-root boundary (`resolveCommandDir` for `doctor`).
  const userHome = deps.home?.homeDir ?? homedir();
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
        read: {
          type: "boolean",
          description: "Open locked in Read mode (hides Review/Edit affordances)",
        },
        preview: {
          type: "boolean",
          description: "Deprecated alias for --read",
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
      const result = await openModule.runOpen(
        (values.target as string | undefined) ?? process.cwd(),
        openModule.realOpenDeps(createHttpGlosaClient),
        {
          launchBrowser: !urlOnly,
          externalState: Boolean(values["external-state"]),
          readLock: Boolean(values.read) || Boolean(values.preview),
          bindSessionId: typeof values.bind === "string" ? values.bind : undefined,
          focus: values.focus as string | undefined,
          surface: document ? "document" : workspace ? "workspace" : "auto",
        },
      );
      openModule.printOpenResult(result, Boolean(values.json), Boolean(values.quiet) || urlOnly);
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
        workspace: { type: "string", description: "Workspace directory (defaults to the cwd)" },
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
          dir: (values.workspace as string | undefined) ?? process.cwd(),
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
        workspace: { type: "string", description: "Workspace directory (defaults to the cwd)" },
      },
    },
    async (context) => {
      const values = withGlobals(context);
      const [{ createHttpGlosaClient }, resolveModule] = await Promise.all([
        import("./api-client.ts"),
        import("./resolve.ts"),
      ]);
      const result = await resolveModule.runApplyBegin(
        {
          dir: (values.workspace as string | undefined) ?? process.cwd(),
          id: values.id as string,
          session: values.session as string,
        },
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
        workspace: { type: "string", description: "Registered workspace slug for shadow diagnosis/repair" },
        "repair-baseline": {
          type: "boolean",
          description: "Explicitly start a new baseline after shadow history loss (requires --workspace)",
        },
      },
    },
    async (context) => {
      const values = withGlobals(context);
      const [{ createHttpGlosaClient }, { glosaHome }, doctorModule] = await Promise.all([
        import("./api-client.ts"),
        import("../../daemon/src/index.ts"),
        import("./doctor.ts"),
      ]);
      const { dir, warnings: dirWarnings } = await resolveCommandDir(
        values.dir as string | undefined,
        process.cwd(),
        userHome,
      );
      const result = await doctorModule.runDoctor(
        dir,
        doctorModule.realDoctorDeps(
          deps.doctor?.createClient ?? createHttpGlosaClient,
          deps.doctor?.glosaHome ?? glosaHome,
        ),
        { workspace: values.workspace as string | undefined, repairBaseline: Boolean(values["repair-baseline"]) },
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
      description: "List inbox entries, retrieve an actionable presentation, or dismiss one",
      args: {
        ...GLOBAL_ARGS,
        action: { type: "positional", required: true, description: "Inbox action (list, get, dismiss)" },
        id: { type: "positional", required: false, description: "Inbox entry ID (required for get, dismiss)" },
        all: { type: "boolean", description: "Include terminal entries (list only)" },
        cursor: { type: "string", description: "Opaque continuation cursor" },
        note: { type: "string", description: "Optional note recorded with the dismiss" },
        workspace: { type: "string", description: "Workspace directory" },
      },
    },
    async (context) => {
      const values = withGlobals(context);
      const [{ createHttpGlosaClient }, inboxModule] = await Promise.all([
        import("./api-client.ts"),
        import("./inbox.ts"),
      ]);
      const workspace = (values.workspace as string | undefined) ?? process.cwd();
      if (values.action === "list") {
        const result = await inboxModule.runInboxList(
          { workspace, all: Boolean(values.all) },
          { createClient: deps.inbox?.createClient ?? createHttpGlosaClient },
        );
        inboxModule.printInboxListResult(result, Boolean(values.json));
        setExitCode(result.exitCode);
        return;
      }
      if (values.action === "dismiss") {
        const result = await inboxModule.runInboxDismiss(
          { workspace, id: values.id as string | undefined, note: values.note as string | undefined },
          { createClient: deps.inbox?.createClient ?? createHttpGlosaClient },
        );
        inboxModule.printInboxDismissResult(result, Boolean(values.json));
        setExitCode(result.exitCode);
        return;
      }
      if (values.action !== "get") {
        process.stderr.write(`glosa inbox: unsupported action '${String(values.action)}'\n`);
        setExitCode(EXIT_CODES.USAGE);
        return;
      }
      if (!values.id) {
        process.stderr.write("glosa inbox get: missing <id>\n");
        setExitCode(EXIT_CODES.USAGE);
        return;
      }
      const result = await inboxModule.runInboxGet(
        {
          workspace,
          id: values.id as string,
          cursor: values.cursor as string | undefined,
        },
        { createClient: deps.inbox?.createClient ?? createHttpGlosaClient },
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
        provider: { type: "string", description: "Session provider when not available from the environment" },
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
      const { discoverClaudeMcpSession } = await import("../../providers/claude-code/src/provider.ts");
      const { discoverCodexMcpSession } = await import("../../providers/codex/src/provider.ts");
      const identity = sessionModule.discoverMcpIdentity(
        [discoverClaudeMcpSession(process.env, process.cwd()), discoverCodexMcpSession(process.env, process.cwd())],
        values.provider as string | undefined,
      );
      if (identity && identity.session_id !== values.id) throw new Error("session_id does not match the host session");
      const result = await sessionModule.runSessionBind(
        (values.workspace as string | undefined) ?? process.cwd(),
        values.id as string,
        createHttpGlosaClient,
        { provider: (values.provider as string | undefined) ?? identity?.provider, cwd: process.cwd() },
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

  const forget = lazyHandler(
    {
      name: "forget",
      description: "Permanently delete a workspace's registration and bus (never work-tree files)",
      args: {
        ...GLOBAL_ARGS,
        workspace: { type: "positional", required: true, description: "Workspace slug (see `glosa status --json`)" },
        yes: { type: "boolean", description: "Skip the interactive confirmation prompt" },
      },
    },
    async (context) => {
      const values = withGlobals(context);
      const [{ createHttpGlosaClient }, forgetModule] = await Promise.all([
        import("./api-client.ts"),
        import("./forget.ts"),
      ]);
      const result = await forgetModule.runForget(
        { slug: values.workspace as string | undefined, yes: Boolean(values.yes), json: Boolean(values.json) },
        { createClient: createHttpGlosaClient },
      );
      forgetModule.printForgetResult(result, Boolean(values.json));
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

  // One-release compatibility stub (#152): machines still carrying `glosa hook <event>` entries
  // in an old `settings.json` / `.codex/hooks.json` must not see a failing hook on every prompt.
  // Prints nothing, reads nothing, exits 0. Deleted in the release after; hooks are not a rail.
  const hook = lazyHandler(
    {
      name: "hook",
      description: "Removed; silent no-op kept for one release",
      internal: true,
      args: {
        event: { type: "positional", required: false },
        provider: { type: "string" },
      },
    },
    async () => {
      setExitCode(EXIT_CODES.OK);
    },
  );

  const mcp = lazyHandler({ name: "mcp", description: "MCP stdio protocol entry point", internal: true }, async () => {
    const [{ createHttpDaemonClient }, { createHttpGlosaClient }, { runMcpServer }] = await Promise.all([
      import("./daemon-client.ts"),
      import("./api-client.ts"),
      import("./mcp.ts"),
    ]);
    const { discoverClaudeMcpSession } = await import("../../providers/claude-code/src/provider.ts");
    const { discoverCodexMcpSession } = await import("../../providers/codex/src/provider.ts");
    const { codexAttachmentRuntime, runCodexAttachment } = await import("../../providers/codex/src/app-server.ts");
    const { discoverMcpIdentity } = await import("./session.ts");
    await runMcpServer({
      createHookClient: (signal) => createHttpDaemonClient({ signal }),
      createApiClient: (signal) => createHttpGlosaClient({ signal }),
      startCodexAttachment: (options, signal) =>
        runCodexAttachment(
          options,
          {
            ...codexAttachmentRuntime,
            createDaemonClient: (clientSignal) => createHttpDaemonClient({ signal: clientSignal }),
          },
          signal,
        ),
      session: (provider) =>
        discoverMcpIdentity(
          [discoverClaudeMcpSession(process.env, process.cwd()), discoverCodexMcpSession(process.env, process.cwd())],
          provider,
        ),
    });
  });

  const monitor = lazyHandler(
    {
      name: "monitor",
      description: "Claude Code plugin session monitor",
      internal: true,
      args: {
        "plugin-root": { type: "string", description: "Absolute Claude plugin root" },
        "project-dir": { type: "string", description: "Absolute Claude project directory" },
      },
    },
    async (context) => {
      const values = withGlobals(context);
      const sessionId = process.env.CLAUDE_CODE_SESSION_ID;
      const pluginRoot = values["plugin-root"] as string | undefined;
      const projectDir = values["project-dir"] as string | undefined;
      if (!sessionId || !pluginRoot || !projectDir) {
        process.stderr.write("glosa monitor: CLAUDE_CODE_SESSION_ID, --plugin-root, and --project-dir are required\n");
        setExitCode(EXIT_CODES.USAGE);
        return;
      }
      const { runClaudeMonitor } = await import("../../providers/claude-code/src/monitor.ts");
      const shutdown = new AbortController();
      const stop = () => shutdown.abort();
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
      process.once("SIGHUP", stop);
      try {
        await runClaudeMonitor({ sessionId, pluginRoot, projectDir }, undefined, shutdown.signal);
      } finally {
        process.off("SIGTERM", stop);
        process.off("SIGINT", stop);
        process.off("SIGHUP", stop);
      }
    },
  );

  const codexAttach = lazyHandler(
    {
      name: "codex-attach",
      description: "Attach a bound Codex thread to its local app-server control socket",
      internal: true,
      args: {
        ...GLOBAL_ARGS,
        id: { type: "positional", required: true, description: "Exact Codex thread ID" },
        workspace: { type: "string", description: "Bound glosa workspace directory" },
        cwd: { type: "string", description: "Codex session working directory" },
        socket: { type: "string", description: "App-server Unix socket path" },
      },
    },
    async (context) => {
      const values = withGlobals(context);
      const { createHttpDaemonClient } = await import("./daemon-client.ts");
      const { codexAttachmentRuntime, runCodexAttachment } = await import("../../providers/codex/src/app-server.ts");
      const shutdown = new AbortController();
      const stop = () => shutdown.abort();
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
      process.once("SIGHUP", stop);
      try {
        await runCodexAttachment(
          {
            sessionId: values.id as string,
            workspace: (values.workspace as string | undefined) ?? process.cwd(),
            cwd: (values.cwd as string | undefined) ?? process.cwd(),
            socketPath: values.socket as string | undefined,
          },
          {
            ...codexAttachmentRuntime,
            createDaemonClient: (signal) => createHttpDaemonClient({ signal }),
          },
          shutdown.signal,
        );
      } finally {
        process.off("SIGTERM", stop);
        process.off("SIGINT", stop);
        process.off("SIGHUP", stop);
      }
    },
  );

  const daemon = lazyHandler({ name: "__daemon", description: "Detached daemon process", internal: true }, async () => {
    const { bootDaemon } = await import("../../daemon/src/index.ts");
    const { ClaudeCodeProvider } = await import("../../providers/claude-code/src/index.ts");
    const { CodexProvider } = await import("../../providers/codex/src/index.ts");
    await bootDaemon({
      providerFactories: [
        ({ sessionRegistry, pushRegistry }) =>
          new ClaudeCodeProvider({
            liveness: sessionRegistry,
            pushAvailable: (session) => pushRegistry.transport(session.session_id) === "monitor",
            sendPush: (session, entry) => pushRegistry.send(session.session_id, entry),
          }),
        ({ sessionRegistry, pushRegistry }) =>
          new CodexProvider({
            liveness: sessionRegistry,
            pushAvailable: (session) => pushRegistry.transport(session.session_id) === "codex_app_server",
            sendPush: (session, entry) => pushRegistry.send(session.session_id, entry),
          }),
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
    resolve,
    "apply-begin": applyBegin,
    "request-review": requestReview,
    doctor,
    status,
    inbox,
    metadata,
    session,
    "codex-attach": codexAttach,
    token,
    update,
    forget,
    hook,
    mcp,
    monitor,
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

/** Commands whose stderr is consumed by a machine, not read by a person: the detached daemon logs
 * it, the agent hooks and the MCP server hand it to their host. None of them should carry advice. */
const DEV_NOTICE_SILENT_COMMANDS = new Set(["__daemon", "hook", "mcp", "monitor", "codex-attach", "complete"]);

let devNoticeShown = false;

/**
 * Tell a developer, once, that this checkout is talking to its own daemon rather than the one their
 * published `glosa` uses (A5 §F13). Without it the difference shows up as an inexplicably empty
 * workspace list — the state is in `~/.glosa`, and a checkout deliberately no longer looks there.
 *
 * Emitted from the CLI boundary rather than the resolvers so `glosaHome()`/`glosaPort()` stay pure
 * and safe to call anywhere, any number of times.
 */
async function noticeDevDefaults(argv: readonly string[]): Promise<void> {
  if (devNoticeShown) return;
  const command = argv[0];
  if (command === undefined || command.startsWith("-") || DEV_NOTICE_SILENT_COMMANDS.has(command)) return;
  // A6's output contract is that a successful command writes NOTHING to stderr, and the command
  // surface tests hold it exactly. An interactive terminal is the one place this advice can go
  // without becoming output some caller has to parse around: a pipe, a capture or a `--json`/
  // `--quiet` consumer sees the same bytes it always did.
  if (!process.stderr.isTTY) return;
  if (argv.includes("--json") || argv.includes("--quiet")) return;
  const { usingDevDefaults, glosaPort } = await import("../../daemon/src/lifecycle/port.ts");
  if (!usingDevDefaults()) return;
  const { glosaHome } = await import("../../daemon/src/lifecycle/home.ts");
  devNoticeShown = true;
  process.stderr.write(
    `glosa: running from a source checkout — using GLOSA_HOME=${glosaHome()} and GLOSA_PORT=${glosaPort()} ` +
      "so this checkout cannot disturb an installed glosa. Set either variable to override.\n",
  );
}

/** Run the glosa CLI and return an A6 process exit code. */
export async function run(argv: readonly string[], deps: CliRunDependencies = {}): Promise<number> {
  if (argv.length === 1 && argv[0] === "--build-id") {
    const { BUILD_ID } = await import("../../daemon/src/lifecycle/build-id.ts");
    process.stdout.write(`${BUILD_ID}\n`);
    return EXIT_CODES.OK;
  }

  await noticeDevDefaults(argv);

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

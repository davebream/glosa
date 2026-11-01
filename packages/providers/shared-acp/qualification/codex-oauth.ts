// SPDX-License-Identifier: Apache-2.0
// Explicit offline native qualification: bun run <this-file> /absolute/path/to/codex
// Uses a synthetic token and never sends a prompt, logs in or contacts a provider.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  CODEX_WORKSPACE_PERMISSION,
  CodexManagedAdapter,
  codexWorkspacePermissionArgs,
  codexWorkspacePermissionConfig,
} from "../../codex/src/managed.ts";
import { RuntimeSupervisor } from "../../../daemon/src/agents/supervisor.ts";
import type {
  AgentEvent,
  OwnedProcess,
  ProcessLauncher,
  SessionLaunchSpec,
} from "../../../daemon/src/agents/interface.ts";
import type { ManagedOAuthBroker } from "../../../daemon/src/agents/oauth-interface.ts";

if (process.platform !== "darwin" || !process.argv[2])
  throw new Error("Provide an absolute Codex executable on macOS. This probe requires the OS network-denial sandbox.");
const executable = realpathSync(process.argv[2]);
const root = realpathSync(mkdtempSync(join(tmpdir(), "glosa-native-oauth-")));
const denyNetwork = "(version 1)(allow default)(deny network*)";
let supervisor: RuntimeSupervisor | undefined;
let connection: Awaited<ReturnType<CodexManagedAdapter["connect"]>> | undefined;
try {
  for (const name of ["profile", "workspace", "home"]) mkdirSync(join(root, name));
  const env = { HOME: join(root, "home"), CODEX_HOME: join(root, "profile"), PATH: "/usr/bin:/bin" };
  const version = spawnSync("/usr/bin/sandbox-exec", ["-p", denyNetwork, executable, "--version"], {
    env,
    encoding: "utf8",
    timeout: 5000,
  });
  if (version.status !== 0 || version.stdout.trim() !== "codex-cli 0.156.1")
    throw new Error("This probe qualifies the pinned Codex 0.156.1 runtime only.");
  // A syscall-level witness distinguishes OS denial from an unreachable network endpoint.
  const network = spawnSync(
    "/usr/bin/sandbox-exec",
    [
      "-p",
      denyNetwork,
      "/usr/bin/python3",
      "-c",
      "import socket,sys\ntry: socket.socket().connect(('127.0.0.1',9))\nexcept OSError as e: sys.exit(0 if e.errno==1 else 2)\nsys.exit(3)",
    ],
    { env, timeout: 5000 },
  );
  if (network.status !== 0) throw new Error("The network-denial negative control did not observe EPERM.");
  supervisor = new RuntimeSupervisor(join(root, "owner"));
  const account = { accountId: "sentinel", status: "signed-in", planEnabled: true, label: "Synthetic" };
  const adapter = new CodexManagedAdapter({
    oauth: {
      getAccount: () => account,
      lease: async () => ({
        accessToken: "synthetic-sentinel-never-real",
        credentialVersion: "v1",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    } as unknown as ManagedOAuthBroker,
  });
  const observed = join(root, "mcp.txt");
  const events: AgentEvent[] = [];
  let owned: OwnedProcess | undefined;
  let shell: { exitCode: number; stdout: string } | undefined;
  const launcher: ProcessLauncher = {
    async spawn(options) {
      let buffer = "";
      owned = await supervisor!.spawn({
        ...options,
        command: "/usr/bin/sandbox-exec",
        args: ["-p", denyNetwork, options.command, ...options.args],
        onData(channel, bytes) {
          if (channel === "stdout") {
            buffer += Buffer.from(bytes).toString("utf8");
            let boundary: number;
            while ((boundary = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 1);
              const frame = JSON.parse(line);
              if (frame.id === "credential-child-witness") shell = frame.result;
            }
          }
          options.onData(channel, bytes);
        },
      });
      return owned;
    },
  };
  const spec = {
    profile: {
      provider: "codex",
      auth: { identity: "oauth:sentinel" },
      authentication: { mode: "oauth", credentialRef: "sentinel" },
    },
    manifest: { executable },
    configRoot: join(root, "profile"),
    cwd: join(root, "workspace"),
    env,
    servers: [
      {
        id: "witness",
        enabled: true,
        transport: "stdio",
        command: "/bin/sh",
        args: [
          "-c",
          'if test -z "$ACCESS_TOKEN"; then echo token-absent; else echo token-present; fi > "$1"',
          "witness",
          observed,
        ],
      },
    ],
  } as unknown as SessionLaunchSpec;
  const nativeStartedAt = performance.now();
  connection = await adapter.connect(spec, launcher, (event) => events.push(event));
  const connectedAt = performance.now();
  const model = connection.capabilities.models[0];
  if (!model?.efforts[0])
    throw new Error("Native model catalog unavailable. No entitlement is inferred from this catalog.");
  // Token inheritance and filesystem confinement have separate native witnesses. A restricted
  // native filesystem sandbox cannot initialize underneath this outer network-denial sandbox.
  await connection.prepareTurn!({ model: model.id, effort: model.efforts[0], permissionMode: "default" });
  const preparedAt = performance.now();
  await owned!.write(
    `${JSON.stringify({ id: "credential-child-witness", method: "command/exec", params: { command: ["/bin/sh", "-c", 'if test -z "$ACCESS_TOKEN"; then echo token-absent; else echo token-present; fi'], cwd: spec.cwd, sandboxPolicy: { type: "externalSandbox", networkAccess: "restricted" }, timeoutMs: 10_000 } })}\n`,
  );
  const deadline = Date.now() + 3000;
  while ((!shell || !existsSync(observed)) && Date.now() < deadline) await Bun.sleep(10);
  if (shell?.exitCode !== 0 || shell.stdout !== "token-absent\n")
    throw new Error("Native shell credential exclusion failed");
  if (!existsSync(observed) || readFileSync(observed, "utf8").trim() !== "token-absent")
    throw new Error("Native MCP credential exclusion failed");
  if (!events.some((event) => event.type === "session")) throw new Error("Native session was not confirmed");
  await connection.close();
  connection = undefined;
  if (supervisor.activeCount !== 0 || supervisor.recoveryRequired)
    throw new Error("Native descendant cleanup was not confirmed");
  const workspaceConfinement = await qualifyNativeWorkspace(executable, join(root, "confinement"));
  console.log(
    JSON.stringify({
      version: version.stdout.trim(),
      executableSha256: createHash("sha256").update(readFileSync(executable)).digest("hex"),
      shell: "token-absent",
      mcp: "token-absent",
      network: "EPERM",
      prompts: 0,
      nativeSession: true,
      descendantCleanup: true,
      coldConnectMs: Number((connectedAt - nativeStartedAt).toFixed(2)),
      prepareMs: Number((preparedAt - connectedAt).toFixed(2)),
      nativeProbeAndCleanupMs: Number((performance.now() - preparedAt).toFixed(2)),
      warmReuse: false,
      workspaceConfinement,
    }),
  );
} finally {
  try {
    await connection?.close();
  } finally {
    await supervisor?.close();
    rmSync(root, { recursive: true, force: true });
  }
}

/** Native filesystem enforcement against disposable files and a local-only provider. No catalog,
 * credentials, prompt or outer sandbox is involved. The native profile itself denies network. */
async function qualifyNativeWorkspace(executable: string, root: string) {
  mkdirSync(root);
  for (const name of ["home", "profile", "workspace", "outside", "external-temp"]) mkdirSync(join(root, name));
  const cwd = realpathSync(join(root, "workspace"));
  const inside = join(cwd, "inside.txt"),
    outside = join(root, "outside", "private.txt");
  writeFileSync(inside, "inside-sentinel");
  writeFileSync(outside, "outside-sentinel");
  const homeSecret = join(root, "home", "private.txt");
  writeFileSync(homeSecret, "home-sentinel");
  symlinkSync(outside, join(cwd, "escape"));
  const slashTmpWrite = join("/tmp", `glosa-confinement-${randomUUID()}`);
  const requests: string[] = [];
  const stub = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname !== "/health") requests.push(request.url);
      return new Response("local-only fixture", { status: 503 });
    },
  });
  const supervisor = new RuntimeSupervisor(join(root, "owner"));
  let owned: OwnedProcess | undefined;
  const pending = new Map<
    number,
    { resolve(value: Record<string, unknown>): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  >();
  let sequence = 0,
    buffer = "";
  const request = (method: string, params: object): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Native confinement request timed out: ${method}`));
      }, 5000);
      pending.set(id, { resolve, reject, timer });
      void owned!.write(`${JSON.stringify({ id, method, params })}\n`).catch(reject);
    });
  try {
    await fetch(`http://127.0.0.1:${stub.port}/health`);
    owned = await supervisor.spawn({
      command: executable,
      args: [
        ...codexWorkspacePermissionArgs(cwd),
        "-c",
        'model_provider="offline_fixture"',
        "-c",
        `model_providers.offline_fixture={name="Offline fixture",base_url="http://127.0.0.1:${stub.port}/v1",wire_api="responses",requires_openai_auth=false,supports_websockets=false}`,
        "-c",
        "analytics.enabled=false",
        "-c",
        "feedback.enabled=false",
        "-c",
        "check_for_update_on_startup=false",
        "-c",
        'otel.exporter="none"',
        "-c",
        'otel.trace_exporter="none"',
        "-c",
        'otel.metrics_exporter="none"',
        ...[
          "apps",
          "plugins",
          "memories",
          "tool_suggest",
          "remote_control",
          "remote_plugin",
          "codex_hooks",
          "hooks",
          "plugin_hooks",
          "api_key_model_discovery",
        ].flatMap((name) => ["-c", `features.${name}=false`]),
        "app-server",
        "--listen",
        "stdio://",
      ],
      cwd,
      env: {
        HOME: join(root, "home"),
        CODEX_HOME: join(root, "profile"),
        PATH: "/usr/bin:/bin",
        TMPDIR: join(root, "external-temp"),
      },
      onData(channel, bytes) {
        if (channel !== "stdout") return;
        buffer += Buffer.from(bytes).toString("utf8");
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          const frame = JSON.parse(line) as { id?: number; result?: Record<string, unknown>; error?: unknown };
          const waiter = frame.id === undefined ? undefined : pending.get(frame.id);
          if (!waiter) continue;
          clearTimeout(waiter.timer);
          pending.delete(frame.id!);
          if (frame.error) waiter.reject(new Error("Native confinement operation was rejected"));
          else waiter.resolve(frame.result ?? {});
        }
      },
    });
    await request("initialize", {
      clientInfo: { name: "glosa", version: "1" },
      capabilities: { experimentalApi: true },
    });
    await owned.write(`${JSON.stringify({ method: "initialized" })}\n`);
    const configuration = await request("config/read", { includeLayers: true, cwd });
    const effectiveConfig = configuration.config as Record<string, unknown>;
    const configured = effectiveConfig.permissions as Record<
      string,
      { filesystem: Record<string, unknown>; network: { enabled: boolean } }
    >;
    const actual = configured[CODEX_WORKSPACE_PERMISSION];
    const wanted = codexWorkspacePermissionConfig(cwd).permissions[CODEX_WORKSPACE_PERMISSION];
    const filesystem = Object.fromEntries(
      Object.entries(actual?.filesystem ?? {}).filter(([, value]) => value != null),
    );
    if (
      effectiveConfig.default_permissions !== ":read-only" ||
      actual?.network.enabled !== false ||
      Object.keys(filesystem).length !== Object.keys(wanted.filesystem).length ||
      Object.entries(wanted.filesystem).some(([key, value]) => filesystem[key] !== value)
    )
      throw new Error("Native restricted filesystem policy was not confirmed");
    const thread = await request("thread/start", {
      cwd,
      model: "offline-fixture-model",
      permissions: CODEX_WORKSPACE_PERMISSION,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
    });
    const active = thread.activePermissionProfile as { id?: string };
    if (
      active?.id !== CODEX_WORKSPACE_PERMISSION ||
      thread.approvalPolicy !== "on-request" ||
      thread.approvalsReviewer !== "user"
    )
      throw new Error("Native restricted thread policy was not confirmed");
    const execute = (command: string[]) =>
      request("command/exec", { command, cwd, permissionProfile: CODEX_WORKSPACE_PERMISSION, timeoutMs: 2000 });
    const insideRead = await execute(["/bin/cat", inside]);
    const insideWrite = join(cwd, "written.txt");
    const write = await execute(["/bin/sh", "-c", 'printf inside-write > "$1"', "witness", insideWrite]);
    if (
      insideRead.exitCode !== 0 ||
      insideRead.stdout !== "inside-sentinel" ||
      write.exitCode !== 0 ||
      readFileSync(insideWrite, "utf8") !== "inside-write"
    )
      throw new Error("Native workspace access did not permit its own files");
    for (const [name, path] of [
      ["outside", outside],
      ["symlink", join(cwd, "escape")],
      ["home", homeSecret],
    ]) {
      const result = await execute(["/bin/cat", path!]);
      if (
        result.exitCode === 0 ||
        String(result.stdout).includes("sentinel") ||
        !String(result.stderr).includes("Operation not permitted")
      )
        throw new Error(`Native ${name} read confinement failed`);
    }
    for (const [name, path] of [
      ["outside", join(root, "outside", "written.txt")],
      ["tmpdir", join(root, "external-temp", "written.txt")],
      ["slash-tmp", slashTmpWrite],
    ]) {
      const result = await execute(["/bin/sh", "-c", 'printf forbidden > "$1"', "witness", path!]);
      if (result.exitCode === 0 || existsSync(path!)) throw new Error(`Native ${name} write confinement failed`);
    }
    const network = await execute([
      "/usr/bin/curl",
      "--max-time",
      "1",
      `http://127.0.0.1:${stub.port}/denied-network-witness`,
    ]);
    if (network.exitCode === 0 || requests.length) throw new Error("Native restricted network confinement failed");
    await owned.stop();
    if (supervisor.activeCount !== 0 || supervisor.recoveryRequired)
      throw new Error("Native confinement cleanup was not confirmed");
    return {
      profile: CODEX_WORKSPACE_PERMISSION,
      insideRead: true,
      insideWrite: true,
      outsideRead: "denied",
      symlinkRead: "denied",
      homeRead: "denied",
      outsideWrite: "denied",
      tmpdirWrite: "denied",
      slashTmpWrite: "denied",
      network: "denied",
      prompts: 0,
      providerRequests: requests.length,
      cleanup: true,
    };
  } finally {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Native qualification stopped"));
    }
    await owned?.stop();
    await supervisor.close();
    await stub.stop(true);
    rmSync(slashTmpWrite, { force: true });
  }
}

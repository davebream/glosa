// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface PackResult {
  filename: string;
  files: Array<{ path: string }>;
}

interface DaemonLock {
  pid: number;
}

const root = resolve(import.meta.dir, "..");
const temp = mkdtempSync(join(tmpdir(), "glosa-package-smoke-"));
const packDir = join(temp, "pack");
const bunHome = join(temp, "bun");
const home = join(temp, "home");
const glosaHome = join(temp, "glosa-home");
const workspace = join(temp, "workspace");
let daemonPid: number | undefined;

const portReservation = Bun.serve({
  port: 0,
  fetch: () => new Response("reserved"),
});
const isolatedPort = portReservation.port;
portReservation.stop(true);

function fail(message: string): never {
  throw new Error(message);
}

function run(command: string, args: string[], env: Record<string, string> = {}): string {
  const result = Bun.spawnSync({
    cmd: [command, ...args],
    cwd: root,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  if (result.exitCode !== 0) {
    fail(`${command} ${args.join(" ")} exited ${result.exitCode}\n${stdout}${stderr}`);
  }
  return stdout;
}

function readLock(): DaemonLock | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(glosaHome, "daemon.lock"), "utf8")) as Partial<DaemonLock>;
    return typeof parsed.pid === "number" ? { pid: parsed.pid } : undefined;
  } catch {
    return undefined;
  }
}

function assertPackContents(files: string[]): void {
  const required = [
    "package.json",
    "packages/cli/src/main.ts",
    "packages/daemon/src/index.ts",
    "packages/providers/claude-code/src/index.ts",
    "packages/providers/codex/src/index.ts",
    "packages/spa/src/index.ts",
    "README.md",
    "CHANGELOG.md",
    "LICENSE",
    "NOTICE",
    "THIRD_PARTY_NOTICES.md",
  ];
  for (const path of required) {
    if (!files.includes(path)) fail(`npm tarball is missing required file: ${path}`);
  }

  const forbidden = [
    /(^|\/)test(s)?\//,
    /^docs\//,
    /^\.context\//,
    /^\.agents\//,
    /^\.codex\//,
    /^\.impeccable\//,
    /(^|\/)CLAUDE\.md$/,
    /(^|\/)AGENTS\.md$/,
  ];
  const leaked = files.filter((path) => forbidden.some((pattern) => pattern.test(path)));
  if (leaked.length > 0) fail(`npm tarball includes internal files:\n${leaked.join("\n")}`);
}

try {
  mkdirSync(packDir, { recursive: true });
  mkdirSync(bunHome, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  await Bun.write(join(workspace, "smoke.md"), "# Package smoke test\n");

  const packed = JSON.parse(
    run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", packDir]),
  ) as PackResult[];
  const result = packed[0] ?? fail("npm pack returned no artifact");
  assertPackContents(result.files.map((file) => file.path));

  const tarball = join(packDir, result.filename);
  if (!existsSync(tarball)) fail(`npm pack did not create ${tarball}`);

  const isolatedEnv = {
    BUN_INSTALL: bunHome,
    GLOSA_HOME: glosaHome,
    GLOSA_PORT: String(isolatedPort),
    HOME: home,
    PATH: `${join(bunHome, "bin")}:${process.env.PATH ?? ""}`,
  };
  run(process.execPath, ["add", "--global", tarball], isolatedEnv);

  const glosa = join(bunHome, "bin", "glosa");
  if (!existsSync(glosa)) fail("isolated global install did not create the glosa executable");
  const expectedVersion = `glosa ${JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version}\n`;
  if (run(glosa, ["--version"], isolatedEnv) !== expectedVersion) fail("installed CLI version does not match package.json");
  if (!run(glosa, ["--help"], isolatedEnv).includes("glosa open")) fail("installed CLI help omits the open command");
  if (!run(glosa, ["complete", "bash"], isolatedEnv).includes("bash completion for glosa")) {
    fail("installed CLI did not generate bash completion");
  }

  const url = run(glosa, ["open", "--url", workspace], isolatedEnv).trim();
  if (!/^http:\/\/127\.0\.0\.1:\d+\/#t=/.test(url)) fail(`glosa open --url returned an unexpected URL: ${url}`);
  daemonPid = readLock()?.pid;
  if (!daemonPid) fail("glosa open --url did not leave an owned daemon lock");

  process.stdout.write(`package smoke passed (${result.files.length} files, ${result.filename})\n`);
} finally {
  if (daemonPid) {
    try {
      process.kill(daemonPid, "SIGTERM");
    } catch {
      // The daemon may have already stopped after a failed assertion.
    }
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        process.kill(daemonPid, 0);
        await Bun.sleep(20);
      } catch {
        break;
      }
    }
  }
  rmSync(temp, { recursive: true, force: true });
}

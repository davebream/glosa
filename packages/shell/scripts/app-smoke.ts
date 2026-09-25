// SPDX-License-Identifier: Apache-2.0
// Smoke-tests a built glosa.app the way a person with no Bun and no terminal install meets it (#371).
// Every command runs with PATH=/usr/bin:/bin:/usr/sbin:/sbin, so nothing can lean on a Bun, a node
// or a glosa from the host: the bundle must be complete on its own. Node APIs only (shell tsconfig).
//
// Usage: bun scripts/app-smoke.ts --app <path to glosa.app> [--stage <build/stage>] [--signed]
//
// The app is copied (ditto, which keeps the signature) into a temp directory first. Run in place
// inside the checkout, Bun would resolve a missing dependency from the repository's own
// node_modules by walking up the tree, and a bundle with no node_modules at all would pass.
//
//   S0 the bundle carries the license texts and every root dependency, and with --stage, exactly
//      the staged tree
//   S1 the bundled Bun is the packageManager pin
//   S2 the launcher prints the release version
//   S3 the bundled sources hash to the same build id as the checkout's
//   S4 Info.plist carries the version, the microphone string and the macOS floor
//   S5 the code signature verifies (ad hoc or Developer ID; notarization when stapled)
//   S6 the CLI recorded the launcher, and the recorded path runs with no Bun on PATH
//   S7 `glosa doctor` reports this install as an app-bundle and names the launcher
//   S8 the bundle is not mistaken for a source checkout (no ~/.glosa-dev home)
//   S9 `glosa open --url` pairs, and the daemon it spawned runs on the bundled Bun

import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** The doctor row name for installs; a test pins it to the CLI's INSTALL_CHECK. */
export const SMOKE_INSTALL_ROW = "install";
const BARE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
}

function fail(check: string, message: string): never {
  throw new Error(`${check}: ${message}`);
}

function exec(command: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string): Result {
  const result = spawnSync(command, args, { encoding: "utf8", env, cwd, timeout: 120_000 });
  if (result.error) return { status: null, stdout: "", stderr: result.error.message };
  return { status: result.status, stdout: String(result.stdout), stderr: String(result.stderr) };
}

function expectOk(check: string, result: Result, what: string): string {
  if (result.status !== 0) fail(check, `${what} exited ${result.status}\n${result.stdout}${result.stderr}`);
  return result.stdout;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv: string[]): { app: string; stage: string | undefined; signed: boolean } {
  let app: string | undefined;
  let stage: string | undefined;
  let signed = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--app") app = argv[++i];
    else if (argv[i] === "--stage") stage = argv[++i];
    else if (argv[i] === "--signed") signed = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!app) throw new Error("usage: app-smoke.ts --app <path to glosa.app> [--stage <dir>] [--signed]");
  return { app, stage, signed };
}

/** Every regular file under `dir` as `relative path -> size`. Symlinks are listed as `-> target`. */
export function treeListing(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (abs: string): void => {
    for (const name of readdirSync(abs)) {
      const path = join(abs, name);
      const rel = relative(dir, path).split(sep).join("/");
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) out.set(rel, `-> ${readlinkSync(path)}`);
      else if (stat.isDirectory()) walk(path);
      else out.set(rel, String(stat.size));
    }
  };
  walk(dir);
  return out;
}

/** Differences between two listings, as sentences; empty when identical. At most `limit` lines. */
export function listingDifferences(expected: Map<string, string>, actual: Map<string, string>, limit = 10): string[] {
  const problems: string[] = [];
  for (const [path, size] of expected) {
    if (!actual.has(path)) problems.push(`missing from the app: ${path}`);
    else if (actual.get(path) !== size)
      problems.push(`differs in the app: ${path} (${size} staged, ${actual.get(path)} shipped)`);
  }
  for (const path of actual.keys()) if (!expected.has(path)) problems.push(`not staged but shipped: ${path}`);
  return problems.length > limit ? [...problems.slice(0, limit), `and ${problems.length - limit} more`] : problems;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(options.app)) throw new Error(`${options.app} does not exist`);
  // Short base: <GLOSA_HOME>/run/api.sock must stay under macOS's 104-byte AF_UNIX path limit.
  const temp = realpathSync(mkdtempSync("/tmp/glosa-app-smoke-"));
  const app = join(temp, "glosa.app");
  const copied = spawnSync("/usr/bin/ditto", [options.app, app], { encoding: "utf8" });
  if (copied.status !== 0) throw new Error(`ditto ${options.app} failed: ${String(copied.stderr)}`);
  const resources = join(app, "Contents", "Resources");
  const bun = join(resources, "bin", "bun");
  const launcher = join(resources, "bin", "glosa");
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const rootManifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    version: string;
    packageManager: string;
    dependencies?: Record<string, string>;
  };
  const version = rootManifest.version;
  const pin = rootManifest.packageManager.replace(/^bun@/, "");

  const glosaHome = join(temp, "gh");
  const home = join(temp, "home");
  const workspace = join(temp, "ws");
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "smoke.md"), "# App smoke test\n");
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: BARE_PATH,
    GLOSA_HOME: glosaHome,
    GLOSA_PORT: String(port),
    LANG: "en_US.UTF-8",
  };
  let daemonPid: number | undefined;
  const passed: string[] = [];

  try {
    // S0: nothing above the copy can lend it a node_modules, and the bundle carries its own.
    for (let dir = dirname(app); dir !== dirname(dir); dir = dirname(dir)) {
      if (existsSync(join(dir, "node_modules"))) fail("S0", `${dir}/node_modules would stand in for the bundle's own`);
    }
    for (const license of ["electron-LICENSE.txt", "chromium-LICENSES.html", "bun-LICENSE.md"]) {
      if (!existsSync(join(resources, "licenses", license))) fail("S0", `the app does not carry licenses/${license}`);
    }
    for (const dep of Object.keys(rootManifest.dependencies ?? {})) {
      if (!existsSync(join(resources, "glosa", "node_modules", dep, "package.json")))
        fail("S0", `the app does not carry node_modules/${dep}`);
    }
    if (options.stage !== undefined) {
      const differences = listingDifferences(
        treeListing(join(options.stage, "glosa")),
        treeListing(join(resources, "glosa")),
      );
      if (differences.length > 0) fail("S0", `the app's glosa/ is not the staged tree:\n${differences.join("\n")}`);
      passed.push("S0 the bundle is the staged tree, file for file");
    } else {
      passed.push("S0 every root dependency is bundled");
    }

    // S1
    const bunVersion = expectOk("S1", exec(bun, ["--version"], env), "bin/bun --version").trim();
    if (bunVersion !== pin) fail("S1", `bin/bun is ${bunVersion}, the packageManager pin is ${pin}`);
    passed.push(`S1 bun ${bunVersion}`);

    // S2
    const printed = expectOk("S2", exec(launcher, ["--version"], env), "bin/glosa --version");
    if (printed !== `glosa ${version}\n`) fail("S2", `bin/glosa --version printed ${JSON.stringify(printed)}`);
    passed.push(`S2 ${printed.trim()}`);

    // S3: BUILD_ID hashes packages/*/src, so equality proves the staged sources are the checkout's.
    const bundled = expectOk("S3", exec(launcher, ["--build-id"], env), "bin/glosa --build-id").trim();
    const checkoutEnv = {
      ...env,
      GLOSA_HOME: join(temp, "checkout-home"),
      PATH: `${dirname(process.execPath)}:${BARE_PATH}`,
    };
    const checkout = expectOk(
      "S3",
      exec(process.execPath, [join(repoRoot, "packages", "cli", "src", "main.ts"), "--build-id"], checkoutEnv),
      "the checkout's --build-id",
    ).trim();
    if (!new RegExp(`^${version.replace(/[.]/g, "\\.")}-[0-9a-f]{16}$`).test(bundled))
      fail("S3", `unexpected build id ${bundled}`);
    if (bundled !== checkout)
      fail("S3", `bundle ${bundled} differs from checkout ${checkout}: staging changed the sources`);
    passed.push(`S3 build ${bundled}`);

    // S4
    const plist = join(app, "Contents", "Info.plist");
    const plistValue = (key: string): string =>
      expectOk("S4", exec("/usr/bin/plutil", ["-extract", key, "raw", plist], env), `plutil ${key}`).trim();
    if (plistValue("CFBundleShortVersionString") !== version)
      fail("S4", "CFBundleShortVersionString is not the release version");
    if (!plistValue("NSMicrophoneUsageDescription").includes("Dictate"))
      fail("S4", "NSMicrophoneUsageDescription is missing");
    if (plistValue("LSMinimumSystemVersion") !== "13.0") fail("S4", "LSMinimumSystemVersion is not 13.0");
    passed.push("S4 Info.plist");

    // S5
    expectOk(
      "S5",
      exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", app], env),
      "codesign --verify",
    );
    expectOk("S5", exec("/usr/bin/codesign", ["--verify", "--strict", bun], env), "codesign --verify bin/bun");
    if (options.signed) {
      const details = exec("/usr/bin/codesign", ["-dvv", app], env);
      if (!details.stderr.includes("Authority=Developer ID Application"))
        fail("S5", "the app is not signed with a Developer ID");
      const bunEntitlements = exec("/usr/bin/codesign", ["-d", "--entitlements", ":-", bun], env);
      if (!`${bunEntitlements.stdout}${bunEntitlements.stderr}`.includes("com.apple.security.cs.allow-jit"))
        fail("S5", "bin/bun is not signed with the allow-jit entitlement");
      if (exec("/usr/bin/xcrun", ["stapler", "validate", app], env).status === 0) {
        expectOk(
          "S5",
          exec("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose", app], env),
          "spctl --assess",
        );
        passed.push("S5 Developer ID, notarized and stapled");
      } else {
        passed.push("S5 Developer ID (not notarized)");
      }
    } else {
      passed.push("S5 ad-hoc signature verifies");
    }

    // S6: the bundled CLI recorded the launcher (never main.ts, whose shebang needs bun on PATH),
    // and the recorded path is what the plugin shim and the shell exec: it must run bare.
    const recorded = join(glosaHome, "bin", "glosa");
    if (!existsSync(recorded)) fail("S6", `${recorded} was not recorded`);
    const target = readlinkSync(recorded);
    if (realpathSync(target) !== realpathSync(launcher))
      fail("S6", `recorded ${target}, expected the launcher ${launcher}`);
    const viaRecorded = expectOk("S6", exec(recorded, ["--version"], env), `${recorded} --version`);
    if (viaRecorded !== `glosa ${version}\n`)
      fail("S6", `the recorded executable printed ${JSON.stringify(viaRecorded)}`);
    passed.push("S6 recorded the launcher");

    // S7: doctor exits 0 or 9 (a bare temp home may fail a browser or plugin check); the install row
    // must name the bundle kind and this launcher as the recorded executable.
    const doctor = exec(launcher, ["doctor", "--json"], env, workspace);
    if (doctor.status !== 0 && doctor.status !== 9)
      fail("S7", `glosa doctor exited ${doctor.status}\n${doctor.stderr}`);
    const envelope = JSON.parse(doctor.stdout) as {
      data?: { checks?: Array<{ name: string; status: string; detail: string }> };
    };
    const row = envelope.data?.checks?.find((check) => check.name === SMOKE_INSTALL_ROW);
    if (!row) fail("S7", `glosa doctor has no ${SMOKE_INSTALL_ROW} row`);
    if (!row.detail.includes("app-bundle"))
      fail("S7", `the ${SMOKE_INSTALL_ROW} row does not say app-bundle: ${row.detail}`);
    if (!row.detail.includes("(this install)") || row.status !== "pass")
      fail(
        "S7",
        `the ${SMOKE_INSTALL_ROW} row does not report the launcher as this install: ${row.status} ${row.detail}`,
      );
    passed.push("S7 doctor reports app-bundle, recorded here");

    // S8: with GLOSA_HOME unset, the CLI derives ~/.glosa. A leaked packages/daemon/test would make it
    // derive ~/.glosa-dev/<install-id> and a dev port instead.
    const s8Home = join(temp, "s8");
    mkdirSync(s8Home, { recursive: true });
    expectOk(
      "S8",
      exec(launcher, ["--version"], { HOME: s8Home, PATH: BARE_PATH }),
      "bin/glosa --version with no GLOSA_HOME",
    );
    if (!existsSync(join(s8Home, ".glosa", "bin", "glosa"))) fail("S8", "~/.glosa was not used");
    if (existsSync(join(s8Home, ".glosa-dev"))) fail("S8", "the bundle ran as a source checkout (~/.glosa-dev exists)");
    passed.push("S8 production home");

    // S9: pairing through the fragment's single-use presentation token, and a daemon on the bundled Bun.
    const opened = expectOk(
      "S9",
      exec(launcher, ["open", "--url", "--json", workspace], env),
      "glosa open --url --json",
    );
    const body = JSON.parse(opened) as { ok?: boolean; data?: { url?: string } };
    const url = body.data?.url ?? fail("S9", `glosa open printed no url: ${opened}`);
    if (!/^http:\/\/glosa\.localhost:\d+\/(?:[^#]*)#p=[0-9a-f]{64}&/.test(url)) fail("S9", `unexpected url ${url}`);
    if (url.includes("#t=") || url.includes("&t=")) fail("S9", `the url leaked the durable token: ${url}`);
    const lock = JSON.parse(readFileSync(join(glosaHome, "daemon.lock"), "utf8")) as { pid?: number };
    daemonPid = typeof lock.pid === "number" ? lock.pid : fail("S9", "daemon.lock has no pid");
    const command = expectOk("S9", exec("/bin/ps", ["-p", String(daemonPid), "-o", "command="], env), "ps").trim();
    if (!command.startsWith(`${bun} `)) fail("S9", `the daemon runs on ${command.split(" ")[0]}, not the bundled Bun`);
    if (
      !command.includes(join(resources, "glosa", "packages", "cli", "src", "main.ts")) ||
      !command.endsWith("__daemon")
    )
      fail("S9", `the daemon is not the bundled CLI: ${command}`);
    passed.push("S9 paired; daemon on the bundled Bun");

    process.stdout.write(`app smoke passed for ${app}\n  ${passed.join("\n  ")}\n`);
  } finally {
    if (daemonPid !== undefined) {
      try {
        process.kill(daemonPid, "SIGTERM");
      } catch {
        // Already gone after a failed assertion.
      }
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          process.kill(daemonPid, 0);
          await sleep(50);
        } catch {
          break;
        }
      }
    }
    rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    process.stderr.write(`app-smoke: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

// SPDX-License-Identifier: Apache-2.0
// The pacman package's installed-package smoke (#432). package-app.ts --smoke runs it on an x86_64
// Linux host with Docker, after building the package and a test-only upgrade package.
//
// The harness runs here, on the host. The product runs only inside fresh Arch Linux containers
// (pinned image digest, pinned Arch Linux Archive snapshot) that receive nothing but the package
// files, read-only: no checkout, no harness code, no Bun or Node. Every stage is declared up front,
// and the run fails when a declared stage did not run, so nothing can be skipped quietly.
//
//   P*  the built package, read with bsdtar on the host
//   D*  a container: install, dependencies, ownership, the CLI on the bundled Bun, recording,
//       doctor, update, open, MCP, and --no-install with a dependency removed
//   L*  the same container: the install lifetime policy (docs/design/2026-09-29-install-lifetime-
//       and-restart.md) across an upgrade, a removal and a reinstall under a running daemon
//
// Usage: bun scripts/linux-package-smoke.ts --package <glosa.pacman> --upgrade <glosa.pacman>
//          --stage <build/stage> --unpacked <dist/x64/linux-unpacked> [--report <file.json>]
// Node APIs only (the shell's tsconfig typechecks it with Node types).
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listingDifferences, treeListing } from "./app-smoke.ts";
import {
  forbiddenPackagePaths,
  installFunctions,
  listingUnder,
  PACKAGE_EXTRAS,
  parseDesktopEntry,
  parsePackageListing,
  parsePkgInfo,
} from "./pacman-package.ts";
import { pacmanVersion } from "./package-app.ts";

/** archlinux:base, pinned by digest so every run starts from the same bytes. */
export const IMAGE = "archlinux:base@sha256:f3691b4dde62ba4c4b6f0ae2c1fbf28e8c0c8c4b9a35c7e06dc1f70e21aa29f6";
/** The Arch Linux Archive day the repositories are read from, so dependencies resolve the same way
 *  on every run. `GLOSA_SMOKE_ARCHIVE_DATE` (YYYY/MM/DD) overrides it when the snapshot ages out. */
export const ARCHIVE_DATE = "2026/09/28";
const USER = "glosa-smoke";
const HOME = `/home/${USER}`;
const LAUNCHER = "/opt/glosa/resources/bin/glosa";
const BUN = "/opt/glosa/resources/bin/bun";

export const DECLARED_STAGES = [
  "P0 package metadata",
  "P1 package contents",
  "P2 bundled Bun",
  "P3 desktop entry",
  "D0 a clean system",
  "D1 install resolves dependencies",
  "D2 package-owned files",
  "D3 shared libraries",
  "D4 CLI on the bundled Bun",
  "D5 recorded executable",
  "D6 doctor names the install",
  "D7 update refuses with pacman",
  "D8 open pairs on the bundled Bun",
  "D9 MCP answers",
  "D10 a missing dependency fails without the network",
  "L1 upgrade under a running daemon",
  "L2 removal under a running daemon",
  "L3 reinstall",
] as const;

interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
}

function exec(command: string, args: string[], input?: string, timeoutMs = 300_000): Result {
  const r = spawnSync(command, args, { encoding: "utf8", input, timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024 });
  if (r.error) return { status: null, stdout: "", stderr: r.error.message };
  return { status: r.status, stdout: String(r.stdout), stderr: String(r.stderr) };
}

class StageFailure extends Error {}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new StageFailure(message);
}
const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");

/** A disposable container. Commands run as root unless `user` is set; a product command runs as the
 *  unprivileged user with a bare PATH, its own HOME and a port of its own. */
class Container {
  readonly name: string;
  private constructor(name: string) {
    this.name = name;
  }

  static start(packageDir: string): Container {
    const name = `glosa-smoke-${randomBytes(4).toString("hex")}`;
    const r = exec("docker", [
      "run",
      "-d",
      "--init",
      "--platform",
      "linux/amd64",
      "--name",
      name,
      "-v",
      `${packageDir}:/pkgs:ro`,
      IMAGE,
      "sleep",
      "infinity",
    ]);
    if (r.status !== 0) throw new Error(`docker run failed: ${r.stderr}`);
    return new Container(name);
  }

  sh(script: string, options: { user?: boolean; env?: Record<string, string>; input?: string } = {}): Result {
    const args = ["exec"];
    if (options.input !== undefined) args.push("-i");
    if (options.user) {
      args.push("-u", USER, "-w", HOME, "-e", `HOME=${HOME}`, "-e", "PATH=/usr/bin:/bin");
    }
    for (const [key, value] of Object.entries(options.env ?? {})) args.push("-e", `${key}=${value}`);
    args.push(this.name, "sh", "-c", script);
    return exec("docker", args, options.input);
  }

  /** stdout of a command that must succeed. */
  out(script: string, options: Parameters<Container["sh"]>[1] = {}): string {
    const r = this.sh(script, options);
    check(r.status === 0, `\`${script}\` exited ${r.status}: ${(r.stdout + r.stderr).slice(-1500)}`);
    return r.stdout;
  }

  remove(): void {
    exec("docker", ["rm", "-f", this.name]);
  }
}

interface DaemonLock {
  pid: number;
  instance_id: string;
  build_id: string;
  port: number;
}

function parseArgs(argv: string[]) {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i] ?? "";
    const value = argv[i + 1];
    if (!["--package", "--upgrade", "--stage", "--unpacked", "--report"].includes(key) || value === undefined)
      throw new Error(`unknown or incomplete argument: ${key}`);
    values.set(key, value);
  }
  for (const key of ["--package", "--upgrade", "--stage", "--unpacked"])
    if (!values.has(key)) throw new Error(`missing ${key}`);
  return {
    pkg: values.get("--package") as string,
    upgrade: values.get("--upgrade") as string,
    stage: values.get("--stage") as string,
    unpacked: values.get("--unpacked") as string,
    report:
      values.get("--report") ?? join(process.cwd(), "..", "..", ".context", "test-results", "pacman", "report.json"),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const shellManifest = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
  ) as { version: string; build: { pacman: { depends: string[] } } };
  const version = shellManifest.version;
  const results: { stage: string; ok: boolean; seconds: number; problem?: string }[] = [];
  const archiveDate = process.env.GLOSA_SMOKE_ARCHIVE_DATE ?? ARCHIVE_DATE;
  let container: Container | null = null;

  const stage = async (id: (typeof DECLARED_STAGES)[number], body: () => void | Promise<void>): Promise<void> => {
    const started = Date.now();
    try {
      await body();
      results.push({ stage: id, ok: true, seconds: (Date.now() - started) / 1000 });
      process.stdout.write(`linux-package-smoke: ok   ${id}\n`);
    } catch (error) {
      const problem = error instanceof Error ? error.message : String(error);
      results.push({ stage: id, ok: false, seconds: (Date.now() - started) / 1000, problem });
      process.stdout.write(`linux-package-smoke: FAIL ${id}: ${problem}\n`);
    }
  };

  // ---- P: the built package, on the host ----------------------------------------------------
  const listing = parsePackageListing(exec("bsdtar", ["-tvf", options.pkg]).stdout);
  const extract = (member: string) => exec("bsdtar", ["-xOf", options.pkg, member]).stdout;

  await stage("P0 package metadata", () => {
    const info = parsePkgInfo(extract(".PKGINFO"));
    check(info.get("pkgname")?.[0] === "glosa", `pkgname is ${info.get("pkgname")}`);
    check(info.get("pkgver")?.[0] === `${pacmanVersion(version)}-1`, `pkgver is ${info.get("pkgver")}`);
    check(info.get("arch")?.[0] === "x86_64", `arch is ${info.get("arch")}`);
    check(info.get("license")?.[0] === "Apache-2.0", `license is ${info.get("license")}`);
    check(info.get("url")?.[0] === "https://github.com/davebream/glosa", `url is ${info.get("url")}`);
    const depends = info.get("depend") ?? [];
    check(
      JSON.stringify(depends) === JSON.stringify(shellManifest.build.pacman.depends),
      `depends ${depends.join(", ")} differ from the declared ${shellManifest.build.pacman.depends.join(", ")}`,
    );
    const functions = installFunctions(extract(".INSTALL"));
    check(
      JSON.stringify([...functions.keys()].sort()) === JSON.stringify(["post_install", "post_remove"]),
      `.INSTALL defines ${[...functions.keys()].join(", ")}`,
    );
    for (const [name, body] of functions)
      check(
        body.every((line) => line === ":"),
        `${name} does something: ${body.join("; ")}`,
      );
  });

  await stage("P1 package contents", () => {
    const shipped = listingUnder(listing, "opt/glosa");
    const unpacked = treeListing(options.unpacked);
    const differences = listingDifferences(unpacked, shipped);
    check(differences.length === 0, `opt/glosa differs from the unpacked app: ${differences.join("; ")}`);
    const staged = treeListing(join(options.stage, "glosa"));
    const glosa = listingUnder(listing, "opt/glosa/resources/glosa");
    const stagedDiff = listingDifferences(staged, glosa);
    check(stagedDiff.length === 0, `resources/glosa differs from the staged tree: ${stagedDiff.join("; ")}`);
    for (const extra of PACKAGE_EXTRAS) check(listing.has(extra), `missing from the package: ${extra}`);
    for (const license of ["electron-LICENSE.txt", "chromium-LICENSES.html", "bun-LICENSE.md"])
      check(listing.has(`opt/glosa/resources/licenses/${license}`), `missing from the package: licenses/${license}`);
    const link = listing.get("usr/bin/glosa");
    check(link?.link === LAUNCHER && link.uid === "0", `usr/bin/glosa is ${JSON.stringify(link)}`);
    const sandbox = listing.get("opt/glosa/chrome-sandbox");
    check(sandbox?.mode === "-rwsr-xr-x" && sandbox.uid === "0", `chrome-sandbox is ${JSON.stringify(sandbox)}`);
    check(extract("opt/glosa/resources/package-type") === "pacman\n", "resources/package-type is not `pacman`");
    const forbidden = forbiddenPackagePaths(listing.keys());
    check(forbidden.length === 0, forbidden.slice(0, 10).join("; "));
  });

  await stage("P2 bundled Bun", () => {
    const bun = readFileSync(join(options.stage, "bin", "bun"));
    check(
      bun.subarray(0, 4).toString("hex") === "7f454c46" && bun.readUInt16LE(18) === 0x3e,
      "staged Bun is not x86-64 ELF",
    );
    const shipped = spawnSync("bsdtar", ["-xOf", options.pkg, "opt/glosa/resources/bin/bun"], {
      maxBuffer: 512 * 1024 * 1024,
    });
    check(sha(shipped.stdout) === sha(bun), "the shipped Bun is not the staged, SHASUMS-verified one");
  });

  await stage("P3 desktop entry", () => {
    const text = extract("usr/share/applications/glosa.desktop");
    const entry = parseDesktopEntry(text);
    check(entry.get("Exec") === "/opt/glosa/glosa %U", `Exec is ${entry.get("Exec")}`);
    check(entry.get("MimeType")?.split(";").includes("x-scheme-handler/glosa"), `MimeType is ${entry.get("MimeType")}`);
    check(
      entry.get("Icon") === "glosa" && entry.get("StartupWMClass") === "glosa",
      "Icon or StartupWMClass is not glosa",
    );
    check(!/no-sandbox/.test(text), "the desktop entry disables the sandbox");
    check(!/—/.test(text), "the desktop entry carries an em dash");
  });

  // ---- D and L: a fresh container ------------------------------------------------------------
  const pkgDir = dirname(options.pkg);
  const pkgA = `/pkgs/${basename(options.pkg)}`;
  if (dirname(options.upgrade) !== pkgDir) throw new Error("--package and --upgrade must share a directory");
  const pkgB = `/pkgs/${basename(options.upgrade)}`;
  const pacman = "pacman --noconfirm --disable-sandbox";
  const port = String(20_000 + Math.floor(Math.random() * 20_000));
  /** The running container; every D and L stage runs after it started. */
  const box = (): Container => {
    if (!container) throw new StageFailure("the container is not running");
    return container;
  };
  const product = (script: string, env: Record<string, string> = {}) =>
    box().sh(script, { user: true, env: { GLOSA_PORT: port, ...env } });
  const readLock = (): DaemonLock | null => {
    const r = box().sh(`cat ${HOME}/.glosa/daemon.lock 2>/dev/null`);
    try {
      return JSON.parse(r.stdout) as DaemonLock;
    } catch {
      return null;
    }
  };
  const alive = (pid: number) => box().sh(`kill -0 ${pid} 2>/dev/null`).status === 0;
  const waitGone = async (pid: number, seconds: number) => {
    for (let i = 0; i < seconds * 10 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
    return !alive(pid);
  };
  const file = (path: string) => box().sh(`cat ${path} 2>/dev/null`).stdout;
  const registration = () => {
    const index = JSON.parse(file(`${HOME}/.glosa/workspaces.json`) || "{}") as Record<string, unknown>;
    const rows = Object.values((index.workspaces as Record<string, Record<string, unknown>>) ?? index);
    return JSON.stringify(rows.map((row) => [row.slug, row.registration_id, row.first_seen]));
  };

  try {
    container = Container.start(pkgDir);
    const c = container;

    await stage("D0 a clean system", () => {
      for (const tool of ["bun", "node", "git"])
        check(c.sh(`command -v ${tool}`).status !== 0, `${tool} is already installed before glosa`);
      check(c.sh("test -e /opt/glosa").status !== 0, "/opt/glosa exists before the install");
    });

    await stage("D1 install resolves dependencies", () => {
      c.out(
        `printf 'Server = https://archive.archlinux.org/repos/${archiveDate}/$repo/os/$arch\\n' > /etc/pacman.d/mirrorlist`,
      );
      c.out(`${pacman} -Syu`);
      c.out(`${pacman} -U ${pkgA}`);
      check(c.out("pacman -Q glosa").trim() === `glosa ${pacmanVersion(version)}-1`, "glosa is not installed");
      check(/as a dependency/.test(c.out("pacman -Qi git")), "git was not installed as glosa's dependency");
      for (const tool of ["bun", "node"])
        check(c.sh(`command -v ${tool}`).status !== 0, `${tool} came with the install`);
      c.out(`useradd -m ${USER}`);
    });

    await stage("D2 package-owned files", () => {
      check(/is owned by glosa/.test(c.out("pacman -Qo /usr/bin/glosa")), "/usr/bin/glosa is not glosa's");
      check(c.out("readlink /usr/bin/glosa").trim() === LAUNCHER, "/usr/bin/glosa does not point at the launcher");
      check(
        c.out("stat -c '%a %U:%G' /opt/glosa/chrome-sandbox").trim() === "4755 root:root",
        "chrome-sandbox is not root 4755",
      );
    });

    await stage("D3 shared libraries", () => {
      const missing = c.out(
        `for f in $(find /opt/glosa -maxdepth 1 -type f -perm -u+x) /opt/glosa/*.so*; do ldd "$f" 2>/dev/null | grep 'not found' | sed "s|^|$f: |"; done; true`,
      );
      check(missing.trim() === "", `libraries not found:\n${missing}`);
    });

    await stage("D4 CLI on the bundled Bun", () => {
      const r = product("glosa --version");
      check(r.status === 0 && r.stdout.trim() === `glosa ${version}`, `glosa --version said ${r.stdout}${r.stderr}`);
    });

    await stage("D5 recorded executable", () => {
      check(
        c.out(`readlink ${HOME}/.glosa/bin/glosa`).trim() === LAUNCHER,
        "an absent record did not become the launcher",
      );
      const cases = [
        ["dangling", `ln -s /nowhere/glosa h/bin/glosa`, `readlink h/bin/glosa`, LAUNCHER],
        [
          "foreign",
          `mkdir -p other && printf '#!/bin/sh\\n' > other/glosa && chmod +x other/glosa && ln -s ${HOME}/other/glosa h/bin/glosa`,
          `readlink h/bin/glosa`,
          `${HOME}/other/glosa`,
        ],
        ["pinned", `printf 'pinned\\n' > h/bin/glosa`, `cat h/bin/glosa`, "pinned"],
      ] as const;
      for (const [label, setup, read, expected] of cases) {
        product(`rm -rf h && mkdir -p h/bin && ${setup}`);
        check(product("glosa --version", { GLOSA_HOME: `${HOME}/h` }).status === 0, `${label}: glosa --version failed`);
        const now = product(read).stdout.trim();
        check(now === expected, `${label} record became ${now}, expected ${expected}`);
      }
    });

    await stage("D6 doctor names the install", () => {
      const doctor = JSON.parse(product("glosa doctor --json").stdout) as {
        data: { checks: { name: string; status: string; detail: string }[] };
      };
      const row = doctor.data.checks.find((entry) => entry.name === "install");
      check(row?.status === "pass", `install row is ${JSON.stringify(row)}`);
      check(
        row.detail.startsWith("this glosa: pacman at /opt/glosa/resources/glosa;"),
        `install row says ${row.detail}`,
      );
      check(row.detail.includes(`recorded: ${LAUNCHER} (this install)`), `install row says ${row.detail}`);
      check(!/brew/i.test(row.detail), "the install row mentions Homebrew");
    });

    await stage("D7 update refuses with pacman", () => {
      const r = product("glosa update --json");
      const update = JSON.parse(r.stdout) as { data: { install_kind: string }; error?: { code: string; hint: string } };
      check(r.status === 2, `glosa update exited ${r.status}`);
      check(update.data.install_kind === "pacman" && update.error?.code === "update-unmanaged-install", r.stdout);
      check(/sudo pacman -U/.test(update.error.hint) && !/brew/i.test(r.stdout), `update said ${update.error.hint}`);
    });

    await stage("D8 open pairs on the bundled Bun", () => {
      product("mkdir -p ws && printf '# Notes\\n\\nA paragraph.\\n' > ws/notes.md");
      const opened = JSON.parse(product("glosa open ws --url --json").stdout) as { ok: boolean; data: { url: string } };
      check(opened.ok && opened.data.url.includes("#p=") && !opened.data.url.includes("#t="), JSON.stringify(opened));
      const lock = readLock();
      check(lock !== null, "no daemon lock after glosa open");
      const cmdline = c.out(`tr '\\0' ' ' < /proc/${lock.pid}/cmdline`);
      check(cmdline.includes(BUN) && cmdline.trim().endsWith("__daemon"), `the daemon runs as ${cmdline}`);
    });

    await stage("D9 MCP answers", () => {
      const initialize = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "glosa-smoke", version: "1" } } })}\n`;
      const r = container?.sh("timeout 60 glosa mcp", {
        user: true,
        env: { GLOSA_PORT: port },
        input: initialize,
      }) as Result;
      check(/"serverInfo"/.test(r.stdout), `glosa mcp did not answer initialize: ${(r.stdout + r.stderr).slice(-800)}`);
    });

    await stage("D10 a missing dependency fails without the network", () => {
      // The launcher runs Bun with --no-install: a hole in the package must fail loudly, never be
      // filled from a registry. The registry points at a closed port, and the run gets a fresh HOME
      // so anything Bun writes can be attributed to it. Bun creates ~/.bun/install/cache on every
      // run and keeps its transpiler cache there (`@t@`); a downloaded package would be anything else.
      c.out("mv /opt/glosa/resources/glosa/node_modules /opt/glosa/resources/glosa/node_modules.aside");
      try {
        const env = {
          BUN_CONFIG_REGISTRY: "http://127.0.0.1:9",
          HOME: `${HOME}/fresh`,
          GLOSA_HOME: `${HOME}/fresh/.glosa`,
        };
        product(`mkdir -p ${HOME}/fresh`);
        const r = product("glosa --version", env);
        const output = r.stdout + r.stderr;
        check(r.status !== 0, "the CLI started with its dependencies removed");
        check(/Cannot find (module|package)/.test(output), `unexpected failure: ${output.slice(-600)}`);
        check(
          !/127\.0\.0\.1:9|ConnectionRefused|Resolving|downloading/i.test(output),
          `Bun reached for the network: ${output.slice(-600)}`,
        );
        const fetched = product(
          `find ${HOME}/fresh/.bun/install/cache -mindepth 1 -maxdepth 1 ! -name '@t@' 2>/dev/null`,
        ).stdout.trim();
        check(fetched === "", `Bun cached a package: ${fetched}`);
      } finally {
        c.out("mv /opt/glosa/resources/glosa/node_modules.aside /opt/glosa/resources/glosa/node_modules");
      }
    });

    const tokenBefore = sha(file(`${HOME}/.glosa/token`));
    const registrationBefore = registration();

    await stage("L1 upgrade under a running daemon", async () => {
      const before = readLock();
      check(before !== null, "no daemon is running before the upgrade");
      const original = sha(file("/opt/glosa/resources/glosa/packages/spa/src/bootstrap.js"));
      // A poller inside the container, as the page would be: every answer must be the old build's
      // bytes or a refused connection; never the new bytes, never an error.
      c.out(
        `nohup sh -c 'n=0; while kill -0 ${before.pid} 2>/dev/null && [ $n -lt 1200 ]; do code=$(curl -s -o /tmp/p.js -w "%{http_code}" http://127.0.0.1:${before.port}/app/bootstrap.js); case "$code" in 200) [ "$(sha256sum /tmp/p.js | cut -d" " -f1)" = "${original}" ] && echo old || echo NEW;; 000|"") echo refused;; *) echo "http-$code";; esac; n=$((n+1)); sleep 0.05; done' > /tmp/poll.log 2>&1 &`,
      );
      c.out(`${pacman} -U ${pkgB}`);
      check(await waitGone(before.pid, 30), "the old daemon did not retire after its install changed");
      const seen = file("/tmp/poll.log").split("\n").filter(Boolean);
      check(seen.includes("old"), "the poller never reached the old daemon");
      const bad = seen.filter((line) => line !== "old" && line !== "refused");
      check(bad.length === 0, `the old daemon answered ${[...new Set(bad)].join(", ")}`);
      const log = file(`${HOME}/.glosa/daemon.log`);
      check(log.includes(`${before.instance_id} install changed`), "the old daemon did not log the change");
      check(
        log.includes(`${before.instance_id} graceful shutdown complete`),
        "the old daemon did not drain gracefully",
      );
      check(product("glosa status --json").status === 0, "glosa status failed after the upgrade");
      const after = readLock();
      check(after !== null && after.instance_id !== before.instance_id, "the next command did not start a new daemon");
      check(after.build_id !== before.build_id, `the new daemon runs the old build ${after.build_id}`);
      check(sha(file(`${HOME}/.glosa/token`)) === tokenBefore, "the pairing token changed");
      check(registration() === registrationBefore, "the workspace registration changed");
    });

    await stage("L2 removal under a running daemon", async () => {
      const before = readLock();
      check(before !== null, "no daemon is running before the removal");
      c.out(`${pacman} -R glosa`);
      check(
        c.sh("test -e /opt/glosa || test -L /usr/bin/glosa || test -e /usr/bin/glosa").status !== 0,
        "files remain",
      );
      check(await waitGone(before.pid, 30), "the daemon did not retire after its install was removed");
      check(
        c.sh(`test -e ${HOME}/.glosa/daemon.lock || test -S ${HOME}/.glosa/run/api.sock`).status !== 0,
        "lock or socket left",
      );
      check(
        file(`${HOME}/.glosa/daemon.log`).includes(`${before.instance_id} graceful shutdown complete`),
        "not graceful",
      );
      check(sha(file(`${HOME}/.glosa/token`)) === tokenBefore, "the pairing token changed");
      check(
        c.sh(`test -L ${HOME}/.glosa/bin/glosa && ! test -e ${HOME}/.glosa/bin/glosa`).status === 0,
        "record not dangling",
      );
    });

    await stage("L3 reinstall", () => {
      c.out(`${pacman} -U ${pkgA}`);
      check(c.sh(`test -e ${HOME}/.glosa/bin/glosa`).status === 0, "the recorded launcher did not resolve again");
      const reopened = JSON.parse(product("glosa open ws --url --json").stdout) as { ok: boolean };
      check(reopened.ok, "reopening the workspace failed");
      check(registration() === registrationBefore, "the workspace registration changed");
      check(sha(file(`${HOME}/.glosa/token`)) === tokenBefore, "the pairing token changed");
    });
  } finally {
    container?.remove();
  }

  const ran = results.map((r) => r.stage);
  const unrun = DECLARED_STAGES.filter((id) => !ran.includes(id));
  mkdirSync(dirname(options.report), { recursive: true });
  writeFileSync(options.report, `${JSON.stringify({ version, archiveDate, image: IMAGE, results, unrun }, null, 2)}\n`);
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0 || unrun.length > 0) {
    throw new Error(
      `${failed.length} stage(s) failed, ${unrun.length} did not run: ${[...failed.map((f) => f.stage), ...unrun].join(", ")}`,
    );
  }
  process.stdout.write(`linux-package-smoke: all ${results.length} stages passed; report ${options.report}\n`);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    process.stderr.write(`linux-package-smoke: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

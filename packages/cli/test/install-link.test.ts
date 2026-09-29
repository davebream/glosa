// SPDX-License-Identifier: Apache-2.0
// The recorded executable at `<GLOSA_HOME>/bin/glosa` (#371): what every CLI entry records, when it
// leaves an existing record alone, and what `readRecordedExecutable` reports for each state.
import { afterEach, describe, expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyInstall, recordingPlan } from "../src/install-kind.ts";
import { ensureRecordedExecutable, readPackageType, readRecordedExecutable } from "../src/install-link.ts";

const roots: string[] = [];
function tempRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "glosa-install-link-")));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A real file standing in for an install's executable, so a link to it resolves. */
function executable(root: string, name: string): string {
  const path = join(root, name, "glosa");
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(path, "#!/bin/sh\n");
  return path;
}

describe("ensureRecordedExecutable", () => {
  test("first run records the executable as a symlink at <home>/bin/glosa", () => {
    const root = tempRoot();
    const home = join(root, "home");
    const a = executable(root, "a");
    const dest = ensureRecordedExecutable(home, a);
    expect(dest).toBe(join(home, "bin", "glosa"));
    expect(lstatSync(dest).isSymbolicLink()).toBe(true);
    expect(readlinkSync(dest)).toBe(a);
    expect(statSync(join(home, "bin")).mode & 0o777).toBe(0o700);
  });

  test("a later run from another install repoints the link (last CLI wins, non-bundled)", () => {
    const root = tempRoot();
    const home = join(root, "home");
    const a = executable(root, "a");
    const b = executable(root, "b");
    ensureRecordedExecutable(home, a);
    ensureRecordedExecutable(home, b);
    expect(readlinkSync(join(home, "bin", "glosa"))).toBe(b);
  });

  test("a regular file at <home>/bin/glosa is never touched", () => {
    const root = tempRoot();
    const home = join(root, "home");
    mkdirSync(join(home, "bin"), { recursive: true });
    const dest = join(home, "bin", "glosa");
    writeFileSync(dest, "#!/bin/sh\necho pinned\n");
    ensureRecordedExecutable(home, executable(root, "a"));
    ensureRecordedExecutable(home, executable(root, "b"), { onlyWhenAbsent: true });
    expect(lstatSync(dest).isSymbolicLink()).toBe(false);
    expect(readFileSync(dest, "utf8")).toBe("#!/bin/sh\necho pinned\n");
  });

  test("onlyWhenAbsent records when nothing is recorded", () => {
    const root = tempRoot();
    const home = join(root, "home");
    const launcher = executable(root, "bundle");
    ensureRecordedExecutable(home, launcher, { onlyWhenAbsent: true });
    expect(readlinkSync(join(home, "bin", "glosa"))).toBe(launcher);
  });

  test("onlyWhenAbsent leaves a live symlink to another install alone", () => {
    const root = tempRoot();
    const home = join(root, "home");
    const terminal = executable(root, "terminal");
    const launcher = executable(root, "bundle");
    ensureRecordedExecutable(home, terminal);
    ensureRecordedExecutable(home, launcher, { onlyWhenAbsent: true });
    expect(readlinkSync(join(home, "bin", "glosa"))).toBe(terminal);
  });

  test("onlyWhenAbsent replaces a dangling symlink", () => {
    const root = tempRoot();
    const home = join(root, "home");
    mkdirSync(join(home, "bin"), { recursive: true });
    symlinkSync(join(root, "removed", "glosa"), join(home, "bin", "glosa"));
    const launcher = executable(root, "bundle");
    ensureRecordedExecutable(home, launcher, { onlyWhenAbsent: true });
    expect(readlinkSync(join(home, "bin", "glosa"))).toBe(launcher);
  });
});

describe("readRecordedExecutable", () => {
  test("reports none, file, dangling and symlink, with the symlink's realpath resolved", () => {
    const root = tempRoot();

    const none = join(root, "none");
    expect(readRecordedExecutable(none)).toEqual({ path: join(none, "bin", "glosa"), state: "none" });

    const file = join(root, "file");
    mkdirSync(join(file, "bin"), { recursive: true });
    writeFileSync(join(file, "bin", "glosa"), "#!/bin/sh\n");
    expect(readRecordedExecutable(file)).toEqual({ path: join(file, "bin", "glosa"), state: "file" });

    const dangling = join(root, "dangling");
    mkdirSync(join(dangling, "bin"), { recursive: true });
    symlinkSync("/nonexistent/glosa", join(dangling, "bin", "glosa"));
    expect(readRecordedExecutable(dangling)).toEqual({
      path: join(dangling, "bin", "glosa"),
      state: "dangling",
      target: "/nonexistent/glosa",
    });

    // A link to a link: `resolved` follows the whole chain, `target` is the first hop only.
    const real = executable(root, "real");
    const hop = join(root, "hop");
    symlinkSync(real, hop);
    const linked = join(root, "linked");
    mkdirSync(join(linked, "bin"), { recursive: true });
    symlinkSync(hop, join(linked, "bin", "glosa"));
    expect(readRecordedExecutable(linked)).toEqual({
      path: join(linked, "bin", "glosa"),
      state: "symlink",
      target: hop,
      resolved: real,
    });
  });
});

describe("the entrypoint", () => {
  test("a checkout CLI records its own main.ts on every entry", () => {
    const root = tempRoot();
    const home = join(root, "home");
    const main = realpathSync(join(import.meta.dir, "..", "src", "main.ts"));
    const run = Bun.spawnSync({
      cmd: [process.execPath, main, "--version"],
      env: { HOME: root, PATH: "/usr/bin:/bin", GLOSA_HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(run.exitCode).toBe(0);
    expect(readlinkSync(join(home, "bin", "glosa"))).toBe(main);
  });
});

/** The Linux package's resources tree in a temp dir (#432): `glosa/` is the package root, `bin/glosa`
 *  the launcher beside it, and `package-type` the marker the build writes. */
function pacmanLayout(root: string, marker: string | null = "pacman\n"): { packageRoot: string; launcher: string } {
  const resources = join(root, "opt", "glosa", "resources");
  const packageRoot = join(resources, "glosa");
  mkdirSync(join(packageRoot, "packages", "cli", "src"), { recursive: true });
  mkdirSync(join(resources, "bin"), { recursive: true });
  writeFileSync(join(resources, "bin", "glosa"), "#!/bin/sh\n");
  if (marker !== null) writeFileSync(join(resources, "package-type"), marker);
  return { packageRoot, launcher: join(resources, "bin", "glosa") };
}

/** What the entrypoint does for the CLI at `packageRoot`, minus spawning it: classify with the
 *  marker, plan, record. main.ts is exactly this wiring. */
function recordAs(home: string, packageRoot: string): void {
  const { kind } = classifyInstall(packageRoot, false, readPackageType(packageRoot));
  const plan = recordingPlan(kind, packageRoot, join(packageRoot, "packages", "cli", "src", "main.ts"));
  ensureRecordedExecutable(home, plan.executable, { onlyWhenAbsent: plan.onlyWhenAbsent });
}

describe("readPackageType (#432)", () => {
  test("reads the trimmed marker beside the package root", () => {
    const { packageRoot } = pacmanLayout(tempRoot());
    expect(readPackageType(packageRoot)).toBe("pacman");
  });

  test("a missing marker, a directory, junk content or an oversized file is no marker", () => {
    expect(readPackageType(pacmanLayout(tempRoot(), null).packageRoot)).toBeNull();
    expect(readPackageType(pacmanLayout(tempRoot(), "Pac Man\n").packageRoot)).toBeNull();
    expect(readPackageType(pacmanLayout(tempRoot(), `${"a".repeat(65)}\n`).packageRoot)).toBeNull();
    const dir = pacmanLayout(tempRoot(), null);
    mkdirSync(join(dir.packageRoot, "..", "package-type"));
    expect(readPackageType(dir.packageRoot)).toBeNull();
  });
});

describe("the Linux package records its launcher only when nothing live is recorded (#432)", () => {
  test("absent: the package's launcher is recorded", () => {
    const root = tempRoot();
    const home = join(root, "home");
    const { packageRoot, launcher } = pacmanLayout(root);
    recordAs(home, packageRoot);
    expect(readlinkSync(join(home, "bin", "glosa"))).toBe(launcher);
  });

  test("dangling: a record pointing at a removed install is replaced by the launcher", () => {
    const root = tempRoot();
    const home = join(root, "home");
    mkdirSync(join(home, "bin"), { recursive: true });
    symlinkSync(join(root, "gone", "glosa"), join(home, "bin", "glosa"));
    const { packageRoot, launcher } = pacmanLayout(root);
    recordAs(home, packageRoot);
    expect(readlinkSync(join(home, "bin", "glosa"))).toBe(launcher);
  });

  test("foreign: a live record of a terminal install keeps ownership", () => {
    const root = tempRoot();
    const home = join(root, "home");
    const terminal = executable(root, "terminal");
    mkdirSync(join(home, "bin"), { recursive: true });
    symlinkSync(terminal, join(home, "bin", "glosa"));
    recordAs(home, pacmanLayout(root).packageRoot);
    expect(readlinkSync(join(home, "bin", "glosa"))).toBe(terminal);
  });

  test("pinned: a hand-placed regular file is never touched", () => {
    const root = tempRoot();
    const home = join(root, "home");
    mkdirSync(join(home, "bin"), { recursive: true });
    writeFileSync(join(home, "bin", "glosa"), '#!/bin/sh\nexec /somewhere/else "$@"\n');
    recordAs(home, pacmanLayout(root).packageRoot);
    expect(lstatSync(join(home, "bin", "glosa")).isFile()).toBe(true);
    expect(readFileSync(join(home, "bin", "glosa"), "utf8")).toContain("/somewhere/else");
  });

  test("without the marker the same tree would take over a terminal install's record (the bug #432 fixes)", () => {
    const root = tempRoot();
    const home = join(root, "home");
    const terminal = executable(root, "terminal");
    mkdirSync(join(home, "bin"), { recursive: true });
    symlinkSync(terminal, join(home, "bin", "glosa"));
    const { packageRoot } = pacmanLayout(root, null);
    recordAs(home, packageRoot);
    expect(readlinkSync(join(home, "bin", "glosa"))).toBe(join(packageRoot, "packages", "cli", "src", "main.ts"));
  });
});

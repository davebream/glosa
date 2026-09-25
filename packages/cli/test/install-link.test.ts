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
import { ensureRecordedExecutable, readRecordedExecutable } from "../src/install-link.ts";

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

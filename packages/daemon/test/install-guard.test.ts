// SPDX-License-Identifier: Apache-2.0
// The install lifetime guard (#432, R-L2..R-L4): what a snapshot of an install notices, what the
// boot check refuses, and when a fenced daemon retires. Real directories and files; only the clock
// and the retirement callbacks are injected.
import { afterEach, describe, expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activateInstallGuard,
  assertInstallUnchanged,
  bootMarginNs,
  bootVerdict,
  captureInstallSnapshot,
  InstallChangedError,
  InstallGuard,
  type InstallSnapshot,
  linuxProcessStartNs,
  verifySnapshot,
} from "../src/lifecycle/install-guard.ts";

const roots: string[] = [];
afterEach(() => {
  activateInstallGuard(null);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A small installed tree: a package root with sources, a nested dependency and a runtime binary. */
function tree(): { root: string; file: string; bun: string; snapshot: () => InstallSnapshot } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "glosa-install-guard-")));
  roots.push(base);
  const root = join(base, "resources", "glosa");
  mkdirSync(join(root, "packages", "spa", "src"), { recursive: true });
  mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{"version":"1.0.0"}\n');
  writeFileSync(join(root, "packages", "spa", "src", "shell.html"), "<html>one</html>\n");
  writeFileSync(join(root, "node_modules", "dep", "index.js"), "export {};\n");
  mkdirSync(join(base, "resources", "bin"), { recursive: true });
  const bun = join(base, "resources", "bin", "bun");
  writeFileSync(bun, "#!/bin/sh\n");
  const file = join(root, "packages", "spa", "src", "shell.html");
  return {
    root,
    file,
    bun,
    snapshot: () => captureInstallSnapshot({ root, files: [join(root, "package.json"), file], execPath: bun }),
  };
}

describe("verifySnapshot notices every way a package manager replaces a file", () => {
  test("an unchanged tree verifies, again and again (control)", () => {
    const t = tree();
    const snapshot = t.snapshot();
    for (let i = 0; i < 3; i++) expect(verifySnapshot(snapshot)).toEqual({ ok: true });
  });

  test("rename over the file (write-to-temp-and-rename)", () => {
    const t = tree();
    const snapshot = t.snapshot();
    writeFileSync(`${t.file}.tmp`, "<html>two</html>\n");
    renameSync(`${t.file}.tmp`, t.file);
    expect(verifySnapshot(snapshot)).toMatchObject({ ok: false, why: "identity" });
  });

  test("unlink then create (what pacman does), even with the old mtime restored", () => {
    const t = tree();
    const before = lstatSync(t.file);
    const snapshot = t.snapshot();
    unlinkSync(t.file);
    writeFileSync(t.file, "<html>one</html>\n");
    utimesSync(t.file, before.atime, before.mtime);
    expect(verifySnapshot(snapshot)).toMatchObject({ ok: false, why: "identity" });
  });

  test("a file added to a directory", () => {
    const t = tree();
    const snapshot = t.snapshot();
    writeFileSync(join(t.root, "node_modules", "dep", "extra.js"), "export {};\n");
    expect(verifySnapshot(snapshot)).toMatchObject({ ok: false, why: "identity" });
  });

  test("the whole root replaced (the brew cask pattern)", () => {
    const t = tree();
    const snapshot = t.snapshot();
    renameSync(t.root, `${t.root}.old`);
    mkdirSync(join(t.root, "packages", "spa", "src"), { recursive: true });
    expect(verifySnapshot(snapshot)).toMatchObject({ ok: false });
  });

  test("the root removed (pacman -R)", () => {
    const t = tree();
    const snapshot = t.snapshot();
    rmSync(t.root, { recursive: true, force: true });
    expect(verifySnapshot(snapshot)).toMatchObject({ ok: false, why: "missing" });
  });

  test("the runtime binary replaced", () => {
    const t = tree();
    const snapshot = t.snapshot();
    unlinkSync(t.bun);
    writeFileSync(t.bun, "#!/bin/sh\n");
    expect(verifySnapshot(snapshot)).toMatchObject({ ok: false, path: t.bun });
  });

  test("a symlinked directory is recorded, never followed: changes behind it are not this install's", () => {
    const t = tree();
    const outside = join(t.root, "..", "..", "shared");
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(t.root, "node_modules", "linked"));
    const snapshot = t.snapshot();
    writeFileSync(join(outside, "changed.js"), "export {};\n");
    expect(verifySnapshot(snapshot)).toEqual({ ok: true });
  });

  test("named residual: an in-place rewrite of a file outside the curated set is not detected", () => {
    // A package manager never writes this way (it unlinks or renames); recorded so no one reads the
    // guard as complete. Same size, restored mtime, same inode, directory untouched.
    const t = tree();
    const dep = join(t.root, "node_modules", "dep", "index.js");
    const before = lstatSync(dep);
    const snapshot = t.snapshot();
    writeFileSync(dep, "export ;{}\n");
    utimesSync(dep, before.atime, before.mtime);
    // ctime still moves on a real filesystem, but the file was never in the snapshot's entries.
    expect(snapshot.entries.has(dep)).toBe(false);
    expect(verifySnapshot(snapshot)).toEqual({ ok: true });
  });
});

describe("bootVerdict refuses a tree that changed while the process loaded (R-L2)", () => {
  test("an entry changed after start minus the margin is a refusal; an older tree is not", () => {
    const t = tree();
    const snapshot = t.snapshot();
    const newest = [...snapshot.entries.values()].reduce((max, e) => (e.ctimeNs > max ? e.ctimeNs : max), 0n);
    expect(bootVerdict(snapshot, newest + 10_000_000_000n, 1_000_000_000n)).toEqual({ ok: true });
    expect(bootVerdict(snapshot, newest + 500_000_000n, 1_000_000_000n)).toMatchObject({
      ok: false,
      why: "after-start",
    });
  });

  test("a Linux start time is the boot (now minus uptime) plus the kernel's start ticks, to 10 ms", () => {
    // A process name may hold spaces and parentheses; the fields start after the last ")".
    const selfStat = "4242 (bun (x) y) S 1 4242 4242 0 -1 4194560 1234 0 0 0 5 2 0 0 20 0 7 0 50000 123456789 2000";
    const now = 2_000_000_000_500_000_000n; // 2e9 s and a half past the epoch
    // Booted 1000.25 s ago; started 50000 ticks (500 s) after boot.
    expect(linuxProcessStartNs(selfStat, "1000.25 3900.10\n", now)).toBe(1_999_999_500_250_000_000n);
    // The boot's fraction of a second counts: /proc/stat's whole-second btime would drop it.
    expect(linuxProcessStartNs(selfStat, "1000.99 3900.10\n", now)).toBe(1_999_999_499_510_000_000n);
    expect(linuxProcessStartNs(selfStat, "garbage", now)).toBeNull();
    expect(linuxProcessStartNs("4242 (bun) S 1", "1000.25 3900.10\n", now)).toBeNull();
  });

  test("the margin is 100 ms on Linux, 500 ms elsewhere, and overridable for tests", () => {
    expect(bootMarginNs("linux", {})).toBe(100_000_000n);
    expect(bootMarginNs("darwin", {})).toBe(500_000_000n);
    expect(bootMarginNs("linux", { GLOSA_INSTALL_BOOT_MARGIN_MS: "600000" })).toBe(600_000_000_000n);
  });
});

describe("InstallGuard: pinned, fenced, retiring (R-L3, R-L4)", () => {
  function guardFor(t: ReturnType<typeof tree>, opts: { busy?: () => boolean; now?: () => number } = {}) {
    const retired: string[] = [];
    const lines: string[] = [];
    const guard = new InstallGuard({
      snapshot: t.snapshot(),
      canRetire: () => !(opts.busy?.() ?? false),
      retire: (change) => retired.push(change.why),
      log: (line) => lines.push(line),
      now: opts.now,
      settleMaxMs: 30_000,
    });
    return { guard, retired, lines };
  }

  test("an unchanged install never fences and never retires", () => {
    const t = tree();
    const { guard, retired } = guardFor(t);
    for (let i = 0; i < 3; i++) guard.sweep();
    expect(() => guard.assertUnchanged("a spawn")).not.toThrow();
    expect(guard.fenced).toBe(false);
    expect(retired).toEqual([]);
  });

  test("a guarded operation after a change is refused, fences the daemon, and stays refused", () => {
    const t = tree();
    const { guard } = guardFor(t);
    rmSync(t.file);
    expect(() => guard.assertUnchanged("a spawn")).toThrow(InstallChangedError);
    expect(guard.fenced).toBe(true);
    writeFileSync(t.file, "<html>one</html>\n");
    // Fencing is one-way: putting a file back does not make the tree the one this daemon booted from.
    expect(() => guard.assertUnchanged("another spawn")).toThrow(InstallChangedError);
  });

  test("the daemon retires once the writes have settled, exactly once", () => {
    const t = tree();
    const { guard, retired } = guardFor(t);
    writeFileSync(join(t.root, "node_modules", "dep", "extra.js"), "export {};\n");
    guard.sweep(); // detects and fences
    expect(retired).toEqual([]);
    guard.sweep(); // nothing moved since: settled
    guard.sweep();
    expect(retired).toEqual(["identity"]);
    expect(guard.state).toBe("retiring");
  });

  test("while files keep changing it waits, up to the settle cap", () => {
    let clock = 0;
    const t = tree();
    const { guard, retired } = guardFor(t, { now: () => clock });
    writeFileSync(join(t.root, "a.js"), "1");
    guard.sweep();
    writeFileSync(join(t.root, "b.js"), "2");
    guard.sweep();
    expect(retired).toEqual([]);
    clock = 30_000;
    writeFileSync(join(t.root, "c.js"), "3");
    guard.sweep();
    expect(retired).toEqual(["identity"]);
  });

  test("a removed root retires without waiting to settle", () => {
    const t = tree();
    const { guard, retired } = guardFor(t);
    rmSync(t.root, { recursive: true, force: true });
    guard.sweep();
    guard.sweep();
    expect(retired).toEqual(["missing"]);
  });

  test("busy managed chats defer retirement, logged once, until they finish", () => {
    let busy = true;
    const t = tree();
    const { guard, retired, lines } = guardFor(t, { busy: () => busy });
    rmSync(t.root, { recursive: true, force: true });
    for (let i = 0; i < 4; i++) guard.sweep();
    expect(retired).toEqual([]);
    expect(lines.filter((line) => line.includes("waiting for managed chats"))).toHaveLength(1);
    busy = false;
    guard.sweep();
    expect(retired).toEqual(["missing"]);
  });

  test("the process-wide gate is a no-op until a guard is activated, then refuses", () => {
    const t = tree();
    expect(() => assertInstallUnchanged("a spawn")).not.toThrow();
    const { guard } = guardFor(t);
    activateInstallGuard(guard);
    expect(() => assertInstallUnchanged("a spawn")).not.toThrow();
    rmSync(t.file);
    expect(() => assertInstallUnchanged("a spawn")).toThrow(InstallChangedError);
  });
});

// SPDX-License-Identifier: Apache-2.0
// Stable launcher target recorded by the installed CLI. The plugin only reads this path.
//
// Recording rules (A6 "Recorded executable", #371):
// - Every CLI entry records itself at `<GLOSA_HOME>/bin/glosa`; the last CLI to run wins.
// - A regular file there is never touched: it is the hand-pinned escape hatch.
// - The CLI inside the desktop app records itself only when nothing is recorded
//   (`onlyWhenAbsent`), where a dangling symlink counts as nothing. A live symlink to another
//   install is left alone, so a terminal install keeps ownership.
import {
  accessSync,
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { packageTypePath } from "./install-kind.ts";

export type RecordedExecutable =
  | { path: string; state: "none" }
  | { path: string; state: "file" }
  | { path: string; state: "managed-pin"; target: string; resolved: string | null }
  | { path: string; state: "dangling"; target: string }
  | { path: string; state: "symlink"; target: string; resolved: string };

const PIN_MARKER = "# glosa-managed-install-pin-v1";

function pinScript(target: string): string {
  if (!isAbsolute(target) || /[\r\n\0]/.test(target))
    throw new Error("install selection needs an absolute executable path");
  const quoted = `'${target.replaceAll("'", "'\\''")}'`;
  return `#!/bin/sh\n${PIN_MARKER}\n# target-base64: ${Buffer.from(target).toString("base64")}\nexec ${quoted} "$@"\n`;
}

function selectedTarget(path: string, size: number): string | null {
  if (size > 4096) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const match = /^#!\/bin\/sh\n# glosa-managed-install-pin-v1\n# target-base64: ([A-Za-z0-9+/=]+)\n/.exec(raw);
    if (!match) return null;
    const target = Buffer.from(match[1] ?? "", "base64").toString("utf8");
    return raw === pinScript(target) ? target : null;
  } catch {
    return null;
  }
}

/** What `<home>/bin/glosa` holds right now. Never throws; a missing entry is `none`, a symlink
 *  whose target no longer resolves is `dangling`, and `resolved` is the target's realpath. */
export function readRecordedExecutable(home: string): RecordedExecutable {
  const path = join(home, "bin", "glosa");
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch {
    return { path, state: "none" };
  }
  if (!stat.isSymbolicLink()) {
    const target = stat.isFile() ? selectedTarget(path, stat.size) : null;
    if (target === null) return { path, state: "file" };
    let resolved: string | null = null;
    try {
      resolved = realpathSync(target);
    } catch {
      // Keep a missing selected app visible to doctor instead of silently falling back.
    }
    return { path, state: "managed-pin", target, resolved };
  }
  let target: string;
  try {
    target = readlinkSync(path);
  } catch {
    return { path, state: "none" };
  }
  try {
    return { path, state: "symlink", target, resolved: realpathSync(path) };
  } catch {
    return { path, state: "dangling", target };
  }
}

export interface EnsureOptions {
  /** The bundled CLI's rule (#371): record only when nothing is recorded, where a dangling
   *  symlink is nothing. A live symlink to another install is left alone. */
  onlyWhenAbsent?: boolean;
}

export function ensureRecordedExecutable(home: string, executable: string, options: EnsureOptions = {}): string {
  const destination = join(home, "bin", "glosa");
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const recorded = readRecordedExecutable(home);
  if (recorded.state === "file" || recorded.state === "managed-pin") return destination;
  if (recorded.state === "symlink" && recorded.target === executable) return destination;
  if (options.onlyWhenAbsent && recorded.state === "symlink") return destination;
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    unlinkSync(temporary);
  } catch {
    // no stale temporary link
  }
  symlinkSync(executable, temporary);
  try {
    renameSync(temporary, destination);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // best effort
    }
    throw error;
  }
  return destination;
}

/** An explicit selection is a regular executable, so ordinary CLI entrypoints leave it alone. */
export function selectRecordedExecutable(home: string, executable: string): string {
  accessSync(executable, constants.X_OK);
  const destination = join(home, "bin", "glosa");
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  if (readRecordedExecutable(home).state === "file") throw new Error(`${destination} is a hand-pinned file`);
  const temporary = `${destination}.${process.pid}.select.tmp`;
  const fd = openSync(temporary, "wx", 0o700);
  try {
    writeSync(fd, pinScript(executable));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    if (readRecordedExecutable(home).state === "file") throw new Error(`${destination} became a hand-pinned file`);
    renameSync(temporary, destination);
  } catch (error) {
    unlinkSync(temporary);
    throw error;
  }
  return destination;
}

/** Removes only a wrapper glosa generated. The invoking CLI becomes the ordinary recorded link. */
export function restoreAutomaticRecording(home: string, executable: string): string {
  const destination = join(home, "bin", "glosa");
  const recorded = readRecordedExecutable(home);
  if (recorded.state === "file") throw new Error(`${destination} is a hand-pinned file`);
  if (recorded.state !== "managed-pin") return ensureRecordedExecutable(home, executable);
  const temporary = `${destination}.${process.pid}.auto.tmp`;
  symlinkSync(executable, temporary);
  try {
    if (readRecordedExecutable(home).state !== "managed-pin")
      throw new Error("install selection changed while resetting it");
    renameSync(temporary, destination);
  } catch (error) {
    unlinkSync(temporary);
    throw error;
  }
  return destination;
}

/** The package manager the Linux desktop package names in its marker (#432), or null. Never throws:
 *  a missing file, a directory, anything over 64 bytes, or content that is not one short lowercase
 *  word reads as no marker at all, so a stray file can never change how an install is classified. */
export function readPackageType(packageRoot: string): string | null {
  const path = packageTypePath(packageRoot);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 64) return null;
    const value = readFileSync(path, "utf8").trim();
    return /^[a-z0-9-]{1,32}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

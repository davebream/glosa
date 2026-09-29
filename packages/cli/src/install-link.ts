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
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { packageTypePath } from "./install-kind.ts";

export type RecordedExecutable =
  | { path: string; state: "none" }
  | { path: string; state: "file" }
  | { path: string; state: "dangling"; target: string }
  | { path: string; state: "symlink"; target: string; resolved: string };

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
  if (!stat.isSymbolicLink()) return { path, state: "file" };
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
  if (recorded.state === "file") return destination;
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

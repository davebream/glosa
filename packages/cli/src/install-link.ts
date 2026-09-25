// SPDX-License-Identifier: Apache-2.0
// Stable launcher target recorded by the installed CLI. The plugin only reads this path.
//
// Recording rules (A6 "Recorded executable", #371):
// - Every CLI entry records itself at `<GLOSA_HOME>/bin/glosa`; the last CLI to run wins.
// - A regular file there is never touched: it is the hand-pinned escape hatch.
// - The CLI inside the desktop app records itself only when nothing is recorded
//   (`onlyWhenAbsent`), where a dangling symlink counts as nothing. A live symlink to another
//   install is left alone, so a terminal install keeps ownership.
import { lstatSync, mkdirSync, readlinkSync, realpathSync, renameSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

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

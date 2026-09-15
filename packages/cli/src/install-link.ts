// SPDX-License-Identifier: Apache-2.0
// Stable launcher target recorded by the installed CLI. The plugin only reads this path.
import { lstatSync, mkdirSync, readlinkSync, renameSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

export function ensureRecordedExecutable(home: string, executable: string): string {
  const destination = join(home, "bin", "glosa");
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  try {
    const stat = lstatSync(destination);
    if (!stat.isSymbolicLink()) return destination;
    if (readlinkSync(destination) === executable) return destination;
  } catch {
    // Missing is the normal first-run case.
  }
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

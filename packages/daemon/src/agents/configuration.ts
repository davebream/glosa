// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** Hash only authority-bearing configuration, never credentials or skill descriptions. */
export function configurationRevision(paths: string[], select?: (path: string, value: unknown) => unknown): string {
  const hash = createHash("sha256");
  for (const path of [...new Set(paths)].sort()) {
    hash.update(path).update("\0");
    try {
      const bytes = readFileSync(path);
      if (bytes.length > 4 * 1024 * 1024) throw new Error("Native configuration exceeds the size limit.");
      hash.update(select ? JSON.stringify(select(path, JSON.parse(bytes.toString("utf8")))) : bytes);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      hash.update("absent");
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

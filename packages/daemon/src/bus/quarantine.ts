// @glosa/daemon — appends a raw bad line to `.glosa/journal.quarantine.ndjson` (A4 §F04). The
// journal itself is never rewritten (append-only, even to excise bad lines); this is where the
// excluded raw bytes go instead, so nothing is silently lost.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { fsyncContainingDir, writeAllSync } from "./io.ts";

export function quarantineLine(quarantinePath: string, rawLine: string): void {
  mkdirSync(dirname(quarantinePath), { recursive: true });
  quarantineRawBytes(quarantinePath, Buffer.from(rawLine + "\n", "utf8"));
}

/** Same sink, used by reconcile.ts's torn-tail truncation to quarantine the raw torn bytes
 * (which may not even be a full line, let alone valid JSON). */
export function quarantineRawBytes(quarantinePath: string, bytes: Buffer): void {
  mkdirSync(dirname(quarantinePath), { recursive: true });
  const isNew = !existsSync(quarantinePath);
  const fd = openSync(quarantinePath, "a");
  try {
    writeAllSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (isNew) fsyncContainingDir(quarantinePath);
}

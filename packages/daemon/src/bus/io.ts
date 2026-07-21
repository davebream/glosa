// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — tiny fs helpers shared by journal.ts and inbox.ts: an offset-advancing write
// loop that tolerates a short writeSync (A4 §F04 — "writeSync may write fewer bytes"), and a
// directory-fsync helper for the "fsync the containing dir once at file creation" rule.
// POSIX-only (openSync on a directory) — fine, v1 is macOS-only (CLAUDE.md).
import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/** Writes every byte of `buf` to `fd`, looping over `writeSync`'s return value instead of
 * assuming a single call flushes the whole buffer. */
export function writeAllSync(fd: number, buf: Buffer): void {
  let written = 0;
  while (written < buf.byteLength) {
    written += writeSync(fd, buf, written, buf.byteLength - written);
  }
}

/** fsyncs the directory containing `path` — needed once when a file is first created so the
 * directory entry itself is durable, not just the file's contents. */
export function fsyncContainingDir(path: string): void {
  const dfd = openSync(dirname(path), "r");
  try {
    fsyncSync(dfd);
  } finally {
    closeSync(dfd);
  }
}

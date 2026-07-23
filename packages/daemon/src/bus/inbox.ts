// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — inbox entries: immutable, write-once `.glosa/inbox/<id>.json` (A4 §F04). Temp
// file in the same dir -> fsyncSync -> hardlink to the final path -> fsync the directory; writing
// an id that already exists is rejected, never overwritten. Callers serialize through the
// per-workspace mutex (mutex.ts) — this module doesn't take a lock of its own, it just needs to
// not be called concurrently for the same id, which the mutex guarantees.
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { fsyncContainingDir, writeAllSync } from "./io.ts";
import { inboxDir, inboxEntryPath } from "./paths.ts";
import type { WorkspaceTarget } from "../workspace.ts";

export interface InboxEntryExistsError extends Error {
  code: "EEXIST";
}

function inboxEntryExistsError(id: string): InboxEntryExistsError {
  const err = new Error(`inbox entry already exists (immutable, write-once): ${id}`) as InboxEntryExistsError;
  err.code = "EEXIST";
  return err;
}

/** Writes `.glosa/inbox/<id>.json` exactly once. Throws `EEXIST` if the final path already
 * exists — inbox entries are never overwritten, by construction.
 *
 * Uses `linkSync` (hardlink), not `renameSync`, as the publish step: a rename onto an existing
 * destination silently clobbers it, which would make "write-once" a caller convention rather
 * than a filesystem guarantee. `link()` is atomic and refuses (`EEXIST`) if the destination
 * already exists, so this is real write-once at the syscall level. The temp file is then
 * unlinked — the hardlink already gave us the final name, the temp name was only scaffolding.
 *
 * Also fsyncs the containing directory after the link: reconcile step 3 (self-heal) treats "an
 * inbox file with no matching `entry_created`" as recoverable, but relies on the inverse — a file
 * whose rename/link has been durably observed — never silently un-happening. Without this fsync,
 * a power loss could make the new directory entry vanish AFTER `entry_created` was already
 * fsynced to the journal, producing the one gap reconcile has no recovery path for. */
export function writeInboxEntryOnce(workspaceRoot: WorkspaceTarget, id: string, payload: unknown): void {
  const dir = inboxDir(workspaceRoot);
  mkdirSync(dir, { recursive: true });
  const finalPath = inboxEntryPath(workspaceRoot, id);

  const tempPath = join(dir, `.${id}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  const data = Buffer.from(JSON.stringify(payload), "utf8");
  const fd = openSync(tempPath, "wx");
  try {
    writeAllSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  try {
    linkSync(tempPath, finalPath);
  } catch (err) {
    try {
      unlinkSync(tempPath); // don't leave scaffolding behind on a rejected write
    } catch {
      // best-effort
    }
    if ((err as NodeJS.ErrnoException).code === "EEXIST") throw inboxEntryExistsError(id);
    throw err;
  }
  unlinkSync(tempPath); // the link gave us the final name — the temp name is redundant now
  fsyncContainingDir(finalPath);
}

/** Returns the parsed entry, or `null` if it's missing or unparseable (never throws — mirrors
 * `lock.ts#readLock`'s "malformed/missing both mean unusable" convention). */
export function readInboxEntry(workspaceRoot: WorkspaceTarget, id: string): unknown | null {
  try {
    return JSON.parse(readFileSync(inboxEntryPath(workspaceRoot, id), "utf8"));
  } catch {
    return null;
  }
}

/** Final (`*.json`) entry ids only. A `*.tmp` file from a crash between write and rename is
 * never listed here — it's inert by construction, not a phantom entry. */
export function listInboxEntryIds(workspaceRoot: WorkspaceTarget): string[] {
  const dir = inboxDir(workspaceRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json") && !name.startsWith("."))
    .map((name) => name.slice(0, -".json".length))
    .sort();
}

/** Best-effort removal of orphaned `*.tmp` files left by a crash-before-rename. They're already
 * inert (never listed by `listInboxEntryIds`); this just tidies the directory. Failure here is
 * non-fatal — reconcile must not fail startup over housekeeping. */
export function cleanupOrphanInboxTempFiles(workspaceRoot: WorkspaceTarget): void {
  const dir = inboxDir(workspaceRoot);
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".tmp")) continue;
    try {
      unlinkSync(join(dir, name));
    } catch {
      // best-effort
    }
  }
}

// SPDX-License-Identifier: Apache-2.0
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { fsyncContainingDir, writeAllSync } from "../bus/io.ts";
import { privateDirectory } from "../chats/journal.ts";

const prepared = z
  .object({ schema: z.literal(1), nonce: z.uuid(), at: z.iso.datetime(), bootId: z.string().optional() })
  .strict();
const exit = z
  .object({
    schema: z.literal(1),
    nonce: z.uuid(),
    pid: z.number().int().positive().optional(),
    pgid: z.number().int().positive().optional(),
    code: z.number().nullable(),
    signal: z.string().nullable(),
    groupEmpty: z.boolean(),
    at: z.iso.datetime(),
  })
  .strict();

export function writeOwnership(path: string, value: unknown): void {
  const pending = `${path}.pending`;
  const fd = openSync(pending, "wx", 0o600);
  try {
    writeAllSync(fd, Buffer.from(JSON.stringify(value)));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(pending, path);
  fsyncContainingDir(path);
}
function readPrivate(path: string): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536) throw new Error("unsafe ownership record");
    return JSON.parse(readFileSync(fd, "utf8"));
  } finally {
    closeSync(fd);
  }
}
export function prepareOwnership(root: string, nonce: string): string {
  const dir = privateDirectory(join(root, "runs", nonce));
  writeOwnership(
    join(dir, "prepared.json"),
    prepared.parse({ schema: 1, nonce, at: new Date().toISOString(), bootId: bootIdentity() }),
  );
  return dir;
}
export function confirmedExit(root: string, nonce: string): z.infer<typeof exit> | undefined {
  try {
    const value = exit.parse(readPrivate(join(root, "runs", nonce, "exit.json")));
    return value.nonce === nonce && value.groupEmpty ? value : undefined;
  } catch {
    return undefined;
  }
}
// Never use a saved PID to signal a process after restart: it may now belong to someone else.
// An absent/corrupt receipt consumes capacity until recovery proves the old run has ended.
export function unresolvedOwnership(root: string): Set<string> {
  const dir = join(root, "runs");
  if (!existsSync(dir)) return new Set();
  const boot = bootIdentity();
  return new Set(
    readdirSync(dir).filter((nonce) => {
      if (!z.uuid().safeParse(nonce).success || confirmedExit(root, nonce)) return false;
      try {
        const previous = prepared.parse(readPrivate(join(dir, nonce, "prepared.json")));
        if (previous.nonce === nonce && boot && previous.bootId && previous.bootId !== boot) return false;
      } catch {
        /* Corrupt ownership stays unknown. */
      }
      return true;
    }),
  );
}

let cachedBoot: string | undefined;
function bootIdentity(): string | undefined {
  if (cachedBoot) return cachedBoot;
  try {
    const result = Bun.spawnSync(["/usr/sbin/sysctl", "-n", "kern.bootsessionuuid"], {
      env: { PATH: "/usr/bin:/bin:/usr/sbin" },
      stdout: "pipe",
      stderr: "ignore",
    });
    const value = result.stdout.toString().trim();
    if (result.exitCode === 0 && /^[a-fA-F0-9-]{36}$/.test(value)) cachedBoot = value;
  } catch {
    /* Lack of a boot identity never authorizes process cleanup. */
  }
  return cachedBoot;
}

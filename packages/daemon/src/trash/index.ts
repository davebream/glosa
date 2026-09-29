// SPDX-License-Identifier: Apache-2.0
// Only OS Trash moves. Never fall back to erasing or copying workspace contents.
import {
  constants,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, basename, join, relative, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { FileOperationError } from "../security/file-path-guard.ts";

export interface TrashLocation {
  location: string;
  info?: string;
  dev: number;
  ino: number;
}
const unavailable = (reason: string) =>
  new FileOperationError(503, "trash-unavailable", "glosa could not move this item to the Trash.", { reason });
function existing(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
function privateDirectory(path: string) {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700)
    throw unavailable("unsafe-trash-directory");
}
export async function trashItem(source: string): Promise<TrashLocation | null> {
  if (process.platform === "darwin") return trashItemMac(source);
  if (process.platform !== "linux") throw unavailable("unsupported-platform");
  return trashItemLinux(source);
}
/** Inject only the process boundary and deadline; executable, arguments and environment stay fixed. */
export async function trashItemMac(
  source: string,
  {
    spawn = (argv, options) => Bun.spawn(argv, options),
    timeoutMs = 10_000,
  }: {
    spawn?: (
      argv: string[],
      options: { cwd: string; env: Record<string, string>; stdin: "ignore"; stdout: "pipe"; stderr: "pipe" },
    ) => {
      stdout: ReadableStream;
      stderr: ReadableStream;
      exited: Promise<number>;
      kill(signal: "SIGKILL"): unknown;
    };
    timeoutMs?: number;
  } = {},
): Promise<TrashLocation> {
  const identity = lstatSync(source);
  const child = spawn(
    ["/usr/bin/osascript", fileURLToPath(new URL("./macos-trash.applescript", import.meta.url)), source],
    {
      cwd: "/",
      env: { PATH: "/usr/bin:/bin" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  const [output, , code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]).finally(() => clearTimeout(timer));
  const location = !timedOut && code === 0 && output.startsWith("OK ") ? output.slice(3).replace(/\r?\n$/, "") : null;
  if (location && isAbsolute(location)) {
    const moved = existing(location);
    if (moved && !moved.isSymbolicLink() && moved.dev === identity.dev && moved.ino === identity.ino)
      return { location, dev: moved.dev, ino: moved.ino };
  }
  if (existing(source)) throw unavailable(timedOut ? "timeout" : "helper-failed");
  // Source absence alone does not prove a successful move. Do not offer an unsafe retry.
  throw new FileOperationError(
    503,
    "file-operation-uncertain",
    "The item is no longer at its original path. Check the Trash before trying again.",
    { outcome: "uncertain" },
  );
}
/** Freedesktop Trash with an injectable data home for isolated cross-platform conformance tests. */
export async function trashItemLinux(source: string, options: { dataHome?: string } = {}): Promise<TrashLocation> {
  const identity = lstatSync(source);
  const dataHome =
    options.dataHome ??
    (process.env.XDG_DATA_HOME && isAbsolute(process.env.XDG_DATA_HOME)
      ? process.env.XDG_DATA_HOME
      : join(homedir(), ".local/share"));
  if (!isAbsolute(dataHome)) throw unavailable("unsafe-trash-directory");
  for (let path = dataHome; dirname(path) !== path; path = dirname(path)) {
    if (existing(path)?.isSymbolicLink()) throw unavailable("unsafe-trash-directory");
  }
  mkdirSync(dataHome, { recursive: true, mode: 0o700 });
  let trash = join(dataHome, "Trash"),
    topdir: string | null = null;
  if (lstatSync(dataHome).dev !== identity.dev) {
    topdir = dirname(source);
    while (dirname(topdir) !== topdir && lstatSync(dirname(topdir)).dev === identity.dev) topdir = dirname(topdir);
    const shared = join(topdir, ".Trash"),
      sharedStat = existing(shared);
    trash = join(topdir, `.Trash-${process.getuid?.()}`);
    if (sharedStat?.isDirectory() && !sharedStat.isSymbolicLink() && sharedStat.mode & 0o1000) {
      const candidate = join(shared, String(process.getuid?.()));
      try {
        privateDirectory(candidate);
        trash = candidate;
      } catch {
        /* Required per-user fallback. */
      }
    }
  }
  try {
    privateDirectory(trash);
    privateDirectory(join(trash, "files"));
    privateDirectory(join(trash, "info"));
    if (lstatSync(trash).dev !== identity.dev) throw unavailable("cross-device");
    for (let n = 0; n < 100; n++) {
      const original = basename(source),
        suffix = n ? `.${n + 1}` : "";
      const name =
        Buffer.byteLength(`${original + suffix}.trashinfo`) <= 255
          ? original + suffix
          : `item-${randomBytes(16).toString("hex")}`;
      const location = join(trash, "files", name),
        info = join(trash, "info", `${name}.trashinfo`);
      if (existing(location) || existing(info)) continue;
      const date = new Date(),
        pad = (value: number) => String(value).padStart(2, "0");
      const when = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
      let fd: number;
      try {
        fd = openSync(info, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }
      try {
        writeFileSync(
          fd,
          `[Trash Info]\nPath=${encodeURI(topdir ? relative(topdir, source) : source)
            .replaceAll("#", "%23")
            .replaceAll("?", "%3F")}\nDeletionDate=${when}\n`,
        );
        fsyncSync(fd);
      } catch (error) {
        unlinkSync(info);
        throw error;
      } finally {
        closeSync(fd);
      }
      try {
        if (existing(location)) throw unavailable("path-exists");
        const fresh = lstatSync(source);
        if (fresh.dev !== identity.dev || fresh.ino !== identity.ino) throw unavailable("source-changed");
        renameSync(source, location);
      } catch (error) {
        unlinkSync(info);
        throw error;
      }
      return { location, info, dev: identity.dev, ino: identity.ino };
    }
    throw unavailable("name-collision");
  } catch (error) {
    if (error instanceof FileOperationError) throw error;
    throw unavailable("no-trash-directory");
  }
}
export function verifyTrash(item: TrashLocation): string {
  const stat = existing(item.location);
  if (!stat || stat.isSymbolicLink() || stat.dev !== item.dev || stat.ino !== item.ino)
    throw new FileOperationError(409, "undo-unavailable", "This item is no longer in the Trash.", {
      reason: "not-in-trash",
    });
  return item.location;
}
export function finishTrashRestore(item: TrashLocation) {
  if (item.info)
    try {
      unlinkSync(item.info);
    } catch {
      /* Restored bytes outrank stale Trash metadata. */
    }
}

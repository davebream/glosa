// SPDX-License-Identifier: Apache-2.0
// Display-only inventory. Never import the workspace bus or versioned inventory here.
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, type Stats } from "node:fs";
import { join } from "node:path";
import ignore, { type Ignore } from "ignore";
import { buildMatcherPredicates, IMAGE_ASSET_EXTENSIONS, loadMatcherConfig } from "./matcher.ts";
import { confinePath } from "./security/confine-path.ts";
import { workspaceBusPath, workspaceWorktree, type WorkspaceTarget } from "./workspace.ts";

export const READ_ONLY_LIMIT = 10_000;
export interface ReadOnlyFile {
  kind: "read-only";
  path: string;
  size_bytes: number;
  version: string;
}
export interface ReadOnlyListing {
  files: ReadOnlyFile[];
  omitted_count: number;
  complete: boolean;
  warning: string | null;
}
export class ReadOnlyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Read guards deliberately allow dotfiles, unlike the stricter filesystem mutation guard. */
export function readOnlyPath(workspace: WorkspaceTarget, path: string): { raw: string; stat: Stats } {
  const root = workspaceWorktree(workspace);
  const parts = path.split("/");
  if (
    !confinePath(root, path).ok ||
    path.includes("\\") ||
    parts.some(
      (part, index) =>
        !part ||
        part === "." ||
        part.toLowerCase() === ".git" ||
        part.toLowerCase() === ".glosa" ||
        (index < parts.length - 1 && part.startsWith(".")),
    )
  )
    throw new ReadOnlyError(400, "Choose a regular file inside this folder, without symlinks or parent paths.");
  const policy = buildMatcherPredicates(loadMatcherConfig(root, workspaceBusPath(workspace)));
  let raw = root;
  let stat: Stats | undefined;
  for (const [index, part] of parts.entries()) {
    const aliases = readdirSync(raw).filter((name) => name.normalize("NFC") === part.normalize("NFC"));
    if (aliases.length !== 1) throw new ReadOnlyError(404, "The file is missing or its name is ambiguous.");
    raw = join(raw, aliases[0]!);
    stat = lstatSync(raw);
    const relative = parts
      .slice(0, index + 1)
      .join("/")
      .normalize("NFC");
    if (
      stat.isSymbolicLink() ||
      policy.isExcluded(relative) ||
      (stat.isDirectory() && policy.isPrunedDir(relative)) ||
      (index < parts.length - 1 && !stat.isDirectory()) ||
      raw === workspaceBusPath(workspace)
    )
      throw new ReadOnlyError(400, "This location cannot be read by glosa.");
  }
  if (!stat || (!stat.isFile() && !stat.isDirectory()) || !confinePath(root, path).ok)
    throw new ReadOnlyError(400, "Only ordinary files can be previewed.");
  return { raw, stat };
}

/** Descriptor-bound, limited reads also cover ignore files. Recheck parents and inode after reading. */
function bytesAt(workspace: WorkspaceTarget, path: string, limit: number): Buffer {
  const { raw } = readOnlyPath(workspace, path);
  const fd = openSync(raw, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) throw new ReadOnlyError(400, "Only ordinary files can be previewed.");
    if (before.size > limit) throw new ReadOnlyError(413, "This file exceeds the preview limit.");
    const buffer = Buffer.alloc(Math.min(before.size + 1, limit + 1));
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    const after = readOnlyPath(workspace, path).stat;
    if (
      length !== before.size ||
      after.ino !== before.ino ||
      after.dev !== before.dev ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new ReadOnlyError(409, "The file changed while loading. Try again.");
    return buffer.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}

type IgnoreScope = { directory: string; rules: Ignore };
function addIgnore(workspace: WorkspaceTarget, directory: string, scopes: IgnoreScope[]): IgnoreScope[] {
  const path = directory ? `${directory}/.gitignore` : ".gitignore";
  try {
    const bytes = bytesAt(workspace, path, 2 * 1024 * 1024);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return [...scopes, { directory, rules: ignore({ ignorecase: false }).add(text) }];
  } catch (error) {
    // Missing ignore files are normal; unreadable or symlinked rules must not silently expose files.
    try {
      lstatSync(join(workspaceWorktree(workspace), path));
    } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code === "ENOENT") return scopes;
    }
    throw error;
  }
}
function ignored(path: string, directory: boolean, scopes: IgnoreScope[]): boolean {
  let result = false;
  for (const scope of scopes) {
    const local = scope.directory ? path.slice(scope.directory.length + 1) : path;
    const match = scope.rules.test(local + (directory ? "/" : ""));
    if (match.ignored) result = true;
    else if (match.unignored) result = false;
  }
  return result;
}
function eligible(workspace: WorkspaceTarget, path: string, size: number): boolean {
  const config = loadMatcherConfig(workspaceWorktree(workspace), workspaceBusPath(workspace));
  const policy = buildMatcherPredicates(config);
  return (
    !IMAGE_ASSET_EXTENSIONS.test(path) &&
    !policy.isExcluded(path) &&
    !(policy.isIncluded(path) && size <= config.artifacts.maxFileBytes)
  );
}
function permittedByIgnore(workspace: WorkspaceTarget, path: string): boolean {
  let scopes: IgnoreScope[] = [];
  const parts = path.split("/");
  for (let index = 0; index < parts.length; index++) {
    scopes = addIgnore(workspace, parts.slice(0, index).join("/"), scopes);
    if (ignored(parts.slice(0, index + 1).join("/"), index < parts.length - 1, scopes)) return false;
  }
  return true;
}
export function scanReadOnlyFiles(
  workspace: WorkspaceTarget,
  showIgnored: boolean,
  limit = READ_ONLY_LIMIT,
): ReadOnlyListing {
  const files: ReadOnlyFile[] = [];
  let total = 0,
    complete = true;
  const root = workspaceWorktree(workspace);
  const config = loadMatcherConfig(root, workspaceBusPath(workspace));
  const policy = buildMatcherPredicates(config);
  const visit = (directory: string, inherited: IgnoreScope[]) => {
    try {
      const scopes = showIgnored ? [] : addIgnore(workspace, directory, inherited);
      const raw = directory ? readOnlyPath(workspace, directory).raw : root;
      const names = readdirSync(raw).sort((a, b) =>
        Buffer.compare(Buffer.from(a.normalize("NFC")), Buffer.from(b.normalize("NFC"))),
      );
      if (directory) readOnlyPath(workspace, directory);
      const counts = new Map<string, number>();
      for (const name of names) counts.set(name.normalize("NFC"), (counts.get(name.normalize("NFC")) ?? 0) + 1);
      for (const name of names) {
        if (counts.get(name.normalize("NFC")) !== 1) {
          complete = false;
          continue;
        }
        const path = (directory ? `${directory}/${name}` : name).normalize("NFC");
        if (name.toLowerCase() === ".git" || name.toLowerCase() === ".glosa" || policy.isExcluded(path)) continue;
        const stat = lstatSync(join(raw, name));
        if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) continue;
        if (stat.isDirectory() && (name.startsWith(".") || policy.isPrunedDir(path))) continue;
        if (!showIgnored && ignored(path, stat.isDirectory(), scopes)) continue;
        if (stat.isDirectory()) visit(path, scopes);
        else if (
          !IMAGE_ASSET_EXTENSIONS.test(path) &&
          !(policy.isIncluded(path) && stat.size <= config.artifacts.maxFileBytes)
        ) {
          if (!confinePath(root, path).ok || path.includes("\\")) {
            complete = false;
            continue;
          }
          const current = stat;
          total++;
          if (files.length < limit)
            files.push({
              kind: "read-only",
              path,
              size_bytes: current.size,
              version: `${current.dev}:${current.ino}:${current.mtimeMs}:${current.ctimeMs}:${current.size}`,
            });
        }
      }
    } catch {
      complete = false;
    }
  };
  visit("", []);
  return {
    files,
    omitted_count: total - files.length,
    complete,
    warning: complete ? null : "Some files could not be listed. Check folder access and ignore rules, then retry.",
  };
}

export function readOnlyFile(workspace: WorkspaceTarget, path: string, showIgnored: boolean) {
  const config = loadMatcherConfig(workspaceWorktree(workspace), workspaceBusPath(workspace));
  const { stat } = readOnlyPath(workspace, path);
  if (!stat.isFile() || !eligible(workspace, path, stat.size) || (!showIgnored && !permittedByIgnore(workspace, path)))
    throw new ReadOnlyError(404, "This file is no longer available as a read-only file.");
  const metadata = {
    path,
    size_bytes: stat.size,
    file_type: path.includes(".") ? path.split(".").at(-1)!.toUpperCase() : "File",
  };
  if (stat.size > config.artifacts.maxFileBytes)
    return { ...metadata, kind: "placeholder" as const, reason: "oversize" as const };
  const bytes = bytesAt(workspace, path, config.artifacts.maxFileBytes);
  let text: string;
  try {
    if (bytes.subarray(0, 8192).includes(0)) throw new Error("binary");
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ...metadata, kind: "placeholder" as const, reason: "binary" as const };
  }
  return { ...metadata, kind: "text" as const, text };
}

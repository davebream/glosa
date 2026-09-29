// SPDX-License-Identifier: Apache-2.0
import { lstatSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { buildWatchIgnored, loadMatcherConfig } from "../matcher.ts";
import { type WorkspaceTarget, workspaceBusPath, workspaceWorktree } from "../workspace.ts";
import { confinePath } from "./confine-path.ts";
import picomatch from "picomatch";

export class FileOperationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly data: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
export function filePath(workspace: WorkspaceTarget, path: string, missing: boolean | "parents" = false): string {
  const root = workspaceWorktree(workspace);
  const parts = path.split("/");
  if (
    !confinePath(root, path).ok ||
    path.includes("\\") ||
    parts.some(
      (part) =>
        !part ||
        part.startsWith(".") ||
        [...part].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
        /[ .]$/.test(part) ||
        Buffer.byteLength(part) > 255,
    )
  ) {
    throw new FileOperationError(
      400,
      "invalid-path",
      "Use a relative name without hidden segments, slashes or control characters.",
    );
  }
  const config = loadMatcherConfig(root, workspaceBusPath(workspace));
  const excludedAlias = picomatch(config.artifacts.exclude, { nocase: true, dot: true });
  const ignored = buildWatchIgnored(
    root,
    { artifacts: { ...config.artifacts, include: ["**/*"] } },
    { ignoreOversize: false },
  );
  let current = root;
  let missingParent = false;
  for (const [index, part] of parts.entries()) {
    const names = missingParent ? [] : readdirSync(current);
    const aliases = names.filter((name) => name.normalize("NFC") === part.normalize("NFC"));
    if (aliases.length > 1)
      throw new FileOperationError(409, "path-exists", "Two names have the same normalized spelling.");
    current = join(current, aliases[0] ?? part);
    let stat: import("node:fs").Stats | undefined;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" ||
        !missing ||
        (missing !== "parents" && index !== parts.length - 1)
      )
        throw new FileOperationError(404, "not-found", "The item or its parent is missing or unreadable.");
      missingParent = true;
    }
    const rel = relative(root, current).normalize("NFC");
    if (
      stat?.isSymbolicLink() ||
      (index < parts.length - 1 && !missingParent && !stat?.isDirectory()) ||
      ignored(current, stat) ||
      excludedAlias(rel) ||
      excludedAlias(`${rel}/`)
    )
      throw new FileOperationError(400, "invalid-path", "This location cannot be managed by glosa.");
    const bus = workspaceBusPath(workspace);
    if (current === bus || bus.startsWith(`${current}/`))
      throw new FileOperationError(409, "protected-path", "This folder contains workspace state.");
    if (index === parts.length - 1 && stat && !stat.isFile() && !stat.isDirectory())
      throw new FileOperationError(400, "invalid-path", "Only ordinary files and folders can be managed.");
  }
  return current;
}
export function prospectivePath(workspace: WorkspaceTarget, path: string): string {
  const target = filePath(workspace, path, true);
  try {
    lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return join(dirname(target), path.split("/").at(-1)!);
    throw error;
  }
  throw new FileOperationError(409, "path-exists", "An item with this name already exists.");
}
/** lstat-only, including hidden/untracked children: repository markers cannot hide below excludes. */
export function inspectFolder(root: string, protectedRoots: readonly string[] = []) {
  let count = 0;
  const paths: string[] = [];
  const visit = (directory: string) => {
    if (protectedRoots.some((path) => path === directory || path.startsWith(`${directory}/`)))
      throw new FileOperationError(409, "protected-path", "This folder contains another workspace.");
    for (const name of readdirSync(directory)) {
      if (++count > 20_000)
        throw new FileOperationError(409, "contains-repository", "This folder is too large to verify safely.");
      if (name.toLowerCase() === ".git")
        throw new FileOperationError(409, "contains-repository", "This folder contains a Git repository.");
      const path = join(directory, name),
        stat = lstatSync(path);
      if (stat.isDirectory()) visit(path);
      else paths.push(relative(root, path));
    }
  };
  visit(root);
  return paths;
}

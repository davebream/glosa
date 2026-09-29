// SPDX-License-Identifier: Apache-2.0
// History includes assets and directory structure without making them editable documents.
import { join, relative } from "node:path";
import { readdirSync } from "node:fs";
import { IMAGE_ASSET_EXTENSIONS, loadMatcherConfig, resolveMatchedFiles, resolveTrackedFiles } from "./matcher.ts";
import { type WorkspaceTarget, workspaceBusPath, workspaceTracking, workspaceWorktree } from "./workspace.ts";

export const DIRECTORY_HISTORY_PREFIX = ".glosa-history-v1/directories/";
export const HISTORY_IMAGE_LIMIT = 20 * 1024 * 1024;
export function directoryHistoryKey(path: string): string {
  return DIRECTORY_HISTORY_PREFIX + Buffer.from(path).toString("base64url");
}
export function directoryFromHistoryKey(key: string): string | null {
  if (!key.startsWith(DIRECTORY_HISTORY_PREFIX)) return null;
  const encoded = key.slice(DIRECTORY_HISTORY_PREFIX.length);
  const path = Buffer.from(encoded, "base64url").toString("utf8");
  return path && directoryHistoryKey(path) === key ? path : null;
}
export function historyPath(key: string): string {
  return directoryFromHistoryKey(key) ?? key;
}
export function pathWithin(path: string, parent: string): boolean {
  return !parent || path === parent || path.startsWith(`${parent}/`);
}
export function versionedInventory(workspace: WorkspaceTarget, documentPaths?: readonly string[]) {
  const names = new Map<string, Map<string, string>>();
  const nativeName = (parent: string, segment: string) => {
    let directory = names.get(parent);
    if (!directory) {
      directory = new Map(readdirSync(parent).map((name) => [name.normalize("NFC"), name]));
      names.set(parent, directory);
    }
    return directory.get(segment.normalize("NFC")) ?? segment;
  };
  const rawPath = (path: string) =>
    path
      .split("/")
      .reduce((parent, segment) => join(parent, nativeName(parent, segment)), workspaceWorktree(workspace));
  const documents = documentPaths
    ? documentPaths.map((path) => ({ path, rawPath: rawPath(path) }))
    : resolveTrackedFiles(workspace).tracked;
  if (workspaceTracking(workspace).mode === "bounded") return { files: documents, directories: [] };
  const root = workspaceWorktree(workspace);
  const config = loadMatcherConfig(root, workspaceBusPath(workspace));
  const assets = resolveMatchedFiles(root, {
    artifacts: {
      ...config.artifacts,
      exclude: [...config.artifacts.exclude, "**/.*/**"],
      include: ["**/*"],
      maxFileBytes: HISTORY_IMAGE_LIMIT,
    },
  });
  return {
    files: [...documents, ...assets.tracked.filter((file) => IMAGE_ASSET_EXTENSIONS.test(file.path))],
    directories: assets.directories
      .filter((dir) => dir.path && !dir.path.split("/").some((segment) => segment.startsWith(".")))
      .map((dir) => ({
        path: dir.path,
        rawPath: relative(root, dir.rawPath),
      })),
  };
}

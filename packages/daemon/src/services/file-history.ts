// SPDX-License-Identifier: Apache-2.0
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  lstatSync,
  readFileSync,
  openSync,
  closeSync,
  fsyncSync,
  renameSync,
  constants,
  readdirSync,
} from "node:fs";
import { dirname, extname, join } from "node:path";
import { commitExists } from "../checkpoint-diff.ts";
import { runGit, runGitBytes } from "../git/shadow.ts";
import { inspectImage } from "../images.ts";
import { IMAGE_ASSET_EXTENSIONS } from "../matcher.ts";
import { directoryFromHistoryKey, directoryHistoryKey, HISTORY_IMAGE_LIMIT, pathWithin } from "../versioned-files.ts";
import { FileOperationError, prospectivePath, filePath } from "../security/file-path-guard.ts";
import { type WorkspaceTarget, workspaceTracking } from "../workspace.ts";
import { findWorkspace, workspaceBus } from "./workspace-access.ts";
import type { ArtifactAccessDependencies } from "./artifact.ts";
import { renameReserved, documentAllowed, classification } from "./file-ops.ts";
import { buildMatcherPredicates, loadMatcherConfig } from "../matcher.ts";
import { createHash } from "node:crypto";

export interface HistoricalItem {
  path: string;
  kind: "file" | "image" | "folder";
  blob: string;
}
export async function snapshotItems(workspace: WorkspaceTarget, checkpoint: string): Promise<HistoricalItem[]> {
  if (!/^[a-f0-9]{7,40}$/.test(checkpoint) || !(await commitExists(workspace, checkpoint)))
    throw new FileOperationError(404, "unknown-checkpoint", "This version is unavailable.");
  const tree = await runGit(workspace, ["ls-tree", "-r", "-z", checkpoint]);
  return tree.stdout
    .split("\0")
    .filter(Boolean)
    .flatMap((line) => {
      const at = line.indexOf("\t"),
        key = line.slice(at + 1),
        header = line.slice(0, at).split(" "),
        blob = header[2]!;
      const directory = directoryFromHistoryKey(key);
      if (!directory && key.startsWith(".")) return [];
      return [
        {
          path: directory ?? key,
          kind: directory
            ? ("folder" as const)
            : IMAGE_ASSET_EXTENSIONS.test(key)
              ? ("image" as const)
              : ("file" as const),
          blob,
        },
      ];
    });
}
export async function checkpointContents(
  deps: ArtifactAccessDependencies,
  slug: string,
  checkpoint: string,
  path = "",
  offset = 0,
) {
  const workspace = findWorkspace(deps, slug);
  const items = (await snapshotItems(workspace, checkpoint)).filter((item) => !path || pathWithin(item.path, path));
  return {
    checkpoint,
    items: items.slice(offset, offset + 100).map(({ blob: _, ...item }) => item),
    next_cursor: offset + 100 < items.length ? String(offset + 100) : null,
  };
}
export async function historicalImage(
  deps: ArtifactAccessDependencies,
  slug: string,
  path: string,
  checkpoint: string,
) {
  const workspace = findWorkspace(deps, slug);
  const item = (await snapshotItems(workspace, checkpoint)).find((item) => item.path === path && item.kind === "image");
  if (!item) throw new FileOperationError(404, "not-found", "This image is not in this version.");
  const bytes = await readHistoricalBytes(workspace, item);
  const info = inspectImage(bytes);
  return { bytes, mime: info.mime };
}
async function readHistoricalBytes(workspace: WorkspaceTarget, item: HistoricalItem) {
  const size = Number((await runGit(workspace, ["cat-file", "-s", item.blob])).stdout.trim());
  if (!Number.isSafeInteger(size) || size > HISTORY_IMAGE_LIMIT)
    throw new FileOperationError(413, "image-too-large", "This saved file exceeds the restore size limit.");
  return (await runGitBytes(workspace, ["cat-file", "blob", item.blob])).stdout;
}
export async function restoreFileHistory(
  deps: ArtifactAccessDependencies,
  slug: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const workspace = findWorkspace(deps, slug);
  if (workspaceTracking(workspace).mode !== "matcher")
    throw new FileOperationError(409, "not-manageable", "Restore folders and images in a folder workspace.");
  if (typeof input.path !== "string" || typeof input.to !== "string")
    throw new FileOperationError(400, "validation-failed", "Choose a path and a version.");
  const requested = input.path,
    checkpoint = input.to;
  const destination = (typeof input.destination_path === "string" ? input.destination_path : requested).normalize(
    "NFC",
  );
  // The inventory names paths in this snapshot. Reversing later renames here would select a
  // different document when a person reused a name after the selected checkpoint.
  const historicPath = requested;
  const items = (await snapshotItems(workspace, checkpoint)).filter((item) => pathWithin(item.path, historicPath));
  const root = items.find((item) => item.path === historicPath);
  if (!root) throw new FileOperationError(404, "not-found", "This item is not in this version.");
  const bus = await workspaceBus(deps, workspace);
  const bytes = new Map<string, Uint8Array>();
  const config = loadMatcherConfig(workspace.worktree_path, workspace.bus_path),
    predicates = buildMatcherPredicates(config);
  let totalBytes = 0;
  if (items.length > 20_000)
    throw new FileOperationError(413, "validation-failed", "This folder is too large to restore in one operation.");
  for (const item of items) {
    const path = destination + item.path.slice(historicPath.length);
    if (
      path
        .split("/")
        .some(
          (part) =>
            !part ||
            part.startsWith(".") ||
            part.includes("\\") ||
            /[. ]$/.test(part) ||
            Buffer.byteLength(part) > 255 ||
            [...part].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127),
        ) ||
      predicates.isExcluded(path) ||
      predicates.isPrunedDir(path)
    )
      throw new FileOperationError(400, "invalid-path", "This saved path is excluded or unsafe at the destination.");
    if (
      item.kind === "image"
        ? extname(path) !== extname(item.path)
        : item.kind === "file" &&
          (!documentAllowed(workspace, path) ||
            classification(deps, workspace, item.path) !== classification(deps, workspace, path))
    )
      throw new FileOperationError(
        422,
        "format-not-allowed",
        "Restore to the same supported format and document class.",
      );
  }
  for (const item of items)
    if (item.kind !== "folder") {
      const value = await readHistoricalBytes(workspace, item);
      totalBytes += value.length;
      if (totalBytes > 256 * 1024 * 1024 || (item.kind === "file" && value.length > config.artifacts.maxFileBytes))
        throw new FileOperationError(413, "validation-failed", "These files exceed the restore size limit.");
      if (item.kind === "image") inspectImage(value);
      bytes.set(item.path, value);
    }
  // Destination publication is one rename. The staging directory is private and never a visible
  // partial restored folder; a failure removes only this operation's staging directory.
  const result = await bus.captureHumanFileOperation(() => {
    findWorkspace(deps, slug);
    const target = filePath(workspace, destination, true);
    let existing: ReturnType<typeof lstatSync> | undefined;
    try {
      existing = lstatSync(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (existing && (root.kind !== "image" || !existing.isFile() || destination !== requested))
      prospectivePath(workspace, destination);
    const originalHash = existing ? createHash("sha256").update(readFileSync(target)).digest("hex") : null;
    if (existing && input.force !== true)
      throw new FileOperationError(409, "dirty-artifact", "Restore this image over the current image?", {
        would_be_lost_diff: "The current image will be replaced. Its saved version remains in History.",
      });
    return {
      operation: { op: "restore", path: destination, scope: root.kind === "folder" ? "folder" : "file" },
      takeOver: Array.isArray(input.take_over)
        ? input.take_over.filter((id): id is string => typeof id === "string")
        : [],
      historyFiles: () =>
        new Map(
          items.map((item) => {
            const path = destination + item.path.slice(historicPath.length);
            return [
              item.kind === "folder" ? directoryHistoryKey(path) : path,
              item.kind === "folder" ? new Uint8Array() : bytes.get(item.path)!,
            ];
          }),
        ),
      mutate: () => {
        if (signal?.aborted)
          throw new FileOperationError(401, "unauthorized", "This connection is no longer authorized.");
        findWorkspace(deps, slug);
        filePath(workspace, destination, true);
        const staging = mkdtempSync(join(dirname(target), ".glosa-restore-"));
        try {
          const stagedRoot = join(staging, "item");
          if (root.kind === "folder") mkdirSync(stagedRoot);
          for (const item of items) {
            const suffix = item.path.slice(historicPath.length).replace(/^\//, "");
            if (suffix.split("/").some((part) => part === ".." || part.startsWith(".")))
              throw new FileOperationError(400, "invalid-path", "This historical path is not restorable.");
            const path = suffix ? join(stagedRoot, suffix) : stagedRoot;
            if (item.kind === "folder") mkdirSync(path, { recursive: true });
            else {
              mkdirSync(dirname(path), { recursive: true });
              const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
              try {
                writeFileSync(fd, bytes.get(item.path)!);
                fsyncSync(fd);
              } finally {
                closeSync(fd);
              }
            }
          }
          const syncTree = (path: string) => {
            if (!lstatSync(path).isDirectory()) return;
            for (const name of readdirSync(path)) syncTree(join(path, name));
            const fd = openSync(path, constants.O_RDONLY);
            try {
              fsyncSync(fd);
            } finally {
              closeSync(fd);
            }
          };
          syncTree(staging);
          if (existing) {
            const actual = filePath(workspace, destination),
              fresh = lstatSync(actual);
            if (
              fresh.dev !== existing.dev ||
              fresh.ino !== existing.ino ||
              createHash("sha256").update(readFileSync(actual)).digest("hex") !== originalHash
            )
              throw new FileOperationError(
                409,
                "dirty-artifact",
                "This image changed while restoring. Review it and try again.",
              );
            renameSync(stagedRoot, actual);
            const fd = openSync(dirname(actual), constants.O_RDONLY);
            try {
              fsyncSync(fd);
            } finally {
              closeSync(fd);
            }
          } else {
            prospectivePath(workspace, destination);
            renameReserved(workspace, destination, destination, stagedRoot);
          }
          return { path: destination, kind: root.kind, restored_to: checkpoint };
        } finally {
          rmSync(staging, { recursive: true, force: true });
        }
      },
    };
  });
  return { ...result.value, checkpoint: result.checkpoint, history_status: result.history_status };
}

// SPDX-License-Identifier: Apache-2.0
// Desk file operations never overwrite another item or invoke Git outside the shadow store.
import { randomBytes } from "node:crypto";
import {
  constants,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, extname, join, posix } from "node:path";
import { classifyWithAdapter } from "../adapters/interface.ts";
import { classifyArtifactPath } from "../artifact-render.ts";
import type { WorkspaceBus } from "../bus/bus.ts";
import type { FileOperation } from "../bus/file-operation.ts";
import { currentPayload } from "../bus/path-identity.ts";
import { isTerminal, entryKindOf } from "../bus/lifecycle.ts";
import { readInboxEntry } from "../bus/inbox.ts";
import { peekJournal } from "../bus/peek.ts";
import { buildMatcherPredicates, IMAGE_ASSET_EXTENSIONS, loadMatcherConfig } from "../matcher.ts";
import { FileOperationError, filePath, prospectivePath, inspectFolder } from "../security/file-path-guard.ts";
import { trashItem, verifyTrash, finishTrashRestore, type TrashLocation } from "../trash/index.ts";
import { versionedInventory, pathWithin, HISTORY_IMAGE_LIMIT } from "../versioned-files.ts";
import { type WorkspaceTarget, workspaceWorktree, workspaceTracking, workspaceBusPath } from "../workspace.ts";
import { findWorkspace, workspaceBus } from "./workspace-access.ts";
import type { ArtifactAccessDependencies } from "./artifact.ts";

type Identity = { dev: number; ino: number; ctimeMs: number; size: number };
type Receipt = {
  id: string;
  operation: FileOperation;
  identity: Identity;
  checkpoint: string;
  trash?: TrashLocation;
  used: boolean;
};
const receipts = new WeakMap<WorkspaceBus, Receipt[]>();
function identity(path: string): Identity {
  const st = lstatSync(path);
  return { dev: st.dev, ino: st.ino, ctimeMs: st.ctimeMs, size: st.size };
}
function same(a: Identity, b: Identity) {
  return a.dev === b.dev && a.ino === b.ino;
}
function exists(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
function syncDirectory(path: string) {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function manageable(workspace: WorkspaceTarget) {
  if (workspaceTracking(workspace).mode !== "matcher")
    throw new FileOperationError(409, "not-manageable", "File actions are available in folder workspaces.");
}
export function classification(deps: ArtifactAccessDependencies, workspace: WorkspaceTarget, path: string) {
  return classifyWithAdapter(
    deps.adapterRegistry?.forWorkspace(workspace),
    workspaceWorktree(workspace),
    path,
    classifyArtifactPath(path),
    workspace,
  );
}
export function documentAllowed(workspace: WorkspaceTarget, path: string) {
  const predicates = buildMatcherPredicates(
    loadMatcherConfig(workspaceWorktree(workspace), workspaceBusPath(workspace)),
  );
  return (
    predicates.isIncluded(path.normalize("NFC")) &&
    !predicates.isExcluded(path.normalize("NFC")) &&
    !IMAGE_ASSET_EXTENSIONS.test(path)
  );
}
export function fileFormats(deps: ArtifactAccessDependencies, slug: string) {
  const workspace = findWorkspace(deps, slug);
  const config = loadMatcherConfig(workspace.worktree_path, workspace.bus_path);
  const extensions = config.artifacts.include.flatMap((glob) => {
    const match = /(?:^|\/)\*\.([\w-]+)$/.exec(glob);
    return match ? [`.${match[1]}`] : [];
  });
  const documents = [...new Set([".md", ".txt", ...extensions])]
    .filter(
      (extension) =>
        !IMAGE_ASSET_EXTENSIONS.test(`new${extension}`) && classification(deps, workspace, `new${extension}`) === "R",
    )
    .map((extension) => ({ extension }));
  return {
    manageable: workspaceTracking(workspace).mode === "matcher",
    documents,
    default_extension: ".md",
    image_extensions: [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif"],
  };
}
function protectedRoots(deps: ArtifactAccessDependencies, workspace: WorkspaceTarget): string[] {
  const index = deps.workspaceIndex as typeof deps.workspaceIndex & {
    list?: () => Array<{ worktree_path: string; bus_path: string; canonical_path?: string }>;
  };
  return (
    index
      .list?.()
      .flatMap((entry) => [
        entry.worktree_path,
        entry.bus_path,
        ...(entry.canonical_path ? [entry.canonical_path] : []),
      ])
      .filter((path) => path !== workspaceWorktree(workspace)) ?? []
  );
}
export function inspectPath(deps: ArtifactAccessDependencies, slug: string, path: string) {
  const workspace = findWorkspace(deps, slug);
  manageable(workspace);
  const abs = filePath(workspace, path),
    stat = lstatSync(abs),
    inventory = versionedInventory(workspace);
  const files = inventory.files.filter((file) => pathWithin(file.path, path));
  const all = stat.isDirectory() ? inspectFolder(abs, protectedRoots(deps, workspace)) : [path];
  const state = peekJournal(workspace).state;
  let notes = 0;
  for (const [id, entry] of Object.entries(state.entries)) {
    if (isTerminal(entryKindOf(entry), entry.status)) continue;
    const payload = currentPayload(state, id, readInboxEntry(workspace, id)) as Record<string, unknown> | null;
    if (
      payload?.kind === "annotation" &&
      typeof payload.artifact_path === "string" &&
      pathWithin(payload.artifact_path, path)
    )
      notes++;
  }
  return {
    path,
    kind: stat.isDirectory() ? "folder" : "file",
    documents: files.filter((f) => !IMAGE_ASSET_EXTENSIONS.test(f.path)).length,
    images: files.filter((f) => IMAGE_ASSET_EXTENSIONS.test(f.path)).length,
    other_files: Math.max(0, all.length - files.length),
    open_notes: notes,
  };
}

/** A reserved target is replaced only while it still names our unchanged inode. Plain rename is
 * restricted to aliases of the same directory entry, never two existing hard links. */
export function renameReserved(workspace: WorkspaceTarget, from: string, to: string, externalSource?: string) {
  const source = externalSource ?? filePath(workspace, from);
  const target = filePath(workspace, to, true);
  const rawTarget = join(dirname(target), basename(to));
  const sourceStat = lstatSync(source),
    targetStat = exists(target);
  const alias =
    !externalSource &&
    targetStat &&
    same(sourceStat, targetStat) &&
    basename(from).normalize("NFC").toLowerCase() === basename(to).normalize("NFC").toLowerCase() &&
    !readdirSync(dirname(source)).includes(basename(to));
  if (targetStat && !alias) throw new FileOperationError(409, "path-exists", "An item with this name already exists.");
  if (alias) {
    filePath(workspace, from);
    renameSync(source, rawTarget);
    syncDirectory(dirname(rawTarget));
    return rawTarget;
  }
  const destination = prospectivePath(workspace, to);
  if (sourceStat.isDirectory()) mkdirSync(destination);
  else {
    const fd = openSync(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    closeSync(fd);
  }
  const reserved = identity(destination);
  try {
    if (!externalSource) filePath(workspace, from);
    filePath(workspace, to);
    if (!same(lstatSync(source), sourceStat))
      throw new FileOperationError(409, "path-exists", "The source changed during this operation.");
    const fresh = identity(destination);
    if (!same(fresh, reserved) || fresh.ctimeMs !== reserved.ctimeMs || fresh.size !== reserved.size)
      throw new FileOperationError(409, "path-exists", "The destination changed during this operation.");
    renameSync(source, destination);
    syncDirectory(dirname(destination));
    return destination;
  } catch (error) {
    const fresh = exists(destination);
    if (fresh && same(fresh, reserved) && fresh.ctimeMs === reserved.ctimeMs) {
      if (fresh.isDirectory()) rmdirSync(destination);
      else unlinkSync(destination);
    }
    throw error;
  }
}
function remember(
  bus: WorkspaceBus,
  operation: FileOperation,
  resultingPath: string,
  checkpoint: string,
  trash?: TrashLocation,
) {
  const list = receipts.get(bus) ?? [];
  const receipt: Receipt = {
    id: randomBytes(16).toString("hex"),
    operation,
    checkpoint,
    identity: identity(resultingPath),
    used: false,
    ...(trash ? { trash } : {}),
  };
  list.push(receipt);
  if (list.length > 50) list.shift();
  receipts.set(bus, list);
  return receipt.id;
}
export async function performFileOperation(
  deps: ArtifactAccessDependencies,
  slug: string,
  action: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const workspace = findWorkspace(deps, slug);
  manageable(workspace);
  const bus = await workspaceBus(deps, workspace);
  if (action === "undo") return undoOperation(deps, slug, bus, input.receipt, signal);
  const path = typeof input.path === "string" ? input.path : typeof input.from === "string" ? input.from : "";
  const to = typeof input.to === "string" ? input.to : undefined;
  const takeOver =
    Array.isArray(input.take_over) && input.take_over.every((id) => typeof id === "string")
      ? (input.take_over as string[])
      : [];
  const result = await bus.captureHumanFileOperation(() => {
    findWorkspace(deps, slug);
    let kind: "file" | "folder";
    if (action === "create") {
      if (input.kind !== "file" && input.kind !== "folder")
        throw new FileOperationError(400, "validation-failed", "Choose a file or folder.");
      kind = input.kind;
      prospectivePath(workspace, path);
      if (kind === "file" && (!documentAllowed(workspace, path) || classification(deps, workspace, path) !== "R"))
        throw new FileOperationError(422, "format-not-allowed", "glosa does not edit this format in this folder.");
    } else {
      const source = filePath(workspace, path),
        stat = lstatSync(source);
      if (protectedRoots(deps, workspace).includes(source))
        throw new FileOperationError(409, "protected-path", "This item is another workspace.");
      kind = stat.isDirectory() ? "folder" : "file";
      if (kind === "folder") inspectFolder(source, protectedRoots(deps, workspace));
      else if (!documentAllowed(workspace, path) && !IMAGE_ASSET_EXTENSIONS.test(path))
        throw new FileOperationError(409, "not-manageable", "This file is read-only in glosa.");
      else if (
        stat.isFile() &&
        stat.size >
          (IMAGE_ASSET_EXTENSIONS.test(path)
            ? HISTORY_IMAGE_LIMIT
            : loadMatcherConfig(workspace.worktree_path, workspace.bus_path).artifacts.maxFileBytes)
      )
        throw new FileOperationError(409, "not-manageable", "This file exceeds glosa's history size limit.");
    }
    if (action === "rename") {
      if (to === path) throw new FileOperationError(400, "validation-failed", "Choose a different name.");
      if (!to || posix.dirname(path) !== posix.dirname(to))
        throw new FileOperationError(400, "invalid-path", "Rename keeps the item in its current folder.");
      const source = filePath(workspace, path),
        target = filePath(workspace, to, true),
        targetStat = exists(target);
      if (
        targetStat &&
        !(
          same(lstatSync(source), targetStat) &&
          basename(path).normalize("NFC").toLowerCase() === basename(to).normalize("NFC").toLowerCase() &&
          !readdirSync(dirname(source)).includes(basename(to))
        )
      )
        throw new FileOperationError(409, "path-exists", "An item with this name already exists.");
      if (kind === "file") {
        if (
          IMAGE_ASSET_EXTENSIONS.test(path)
            ? extname(path) !== extname(to)
            : !documentAllowed(workspace, to) ||
              classification(deps, workspace, path) !== classification(deps, workspace, to)
        )
          throw new FileOperationError(
            422,
            "format-not-allowed",
            "Keep this item's supported format and rendering class.",
          );
      } else {
        const config = loadMatcherConfig(workspace.worktree_path, workspace.bus_path);
        const predicates = buildMatcherPredicates(config);
        const visible = (path: string) =>
          !path.split("/").some((part) => part.startsWith(".")) &&
          !predicates.isExcluded(path) &&
          (predicates.isIncluded(path) || IMAGE_ASSET_EXTENSIONS.test(path));
        for (const child of inspectFolder(filePath(workspace, path), protectedRoots(deps, workspace))) {
          const before = `${path}/${child}`,
            after = `${to}/${child}`;
          if (visible(before) !== visible(after))
            throw new FileOperationError(
              422,
              "tracking-would-change",
              "Renaming this folder would change which files glosa shows.",
            );
        }
        const inventory = versionedInventory(workspace);
        for (const file of inventory.files.filter((f) => pathWithin(f.path, path))) {
          const target = to + file.path.slice(path.length);
          if (
            !IMAGE_ASSET_EXTENSIONS.test(file.path) &&
            (!documentAllowed(workspace, target) ||
              classification(deps, workspace, file.path) !== classification(deps, workspace, target))
          )
            throw new FileOperationError(
              422,
              "tracking-would-change",
              "Renaming this folder would hide or change a document.",
            );
        }
      }
    }
    const operation: FileOperation = {
      op: action === "create" ? (kind === "folder" ? "mkdir" : "create") : (action as "rename" | "trash"),
      path: path.normalize("NFC"),
      ...(to ? { to: to.normalize("NFC") } : {}),
      scope: kind === "folder" ? "folder" : "file",
      ...(action === "rename" && to ? { rename: { from: path.normalize("NFC"), to: to.normalize("NFC") } } : {}),
    };
    return {
      operation,
      takeOver,
      mutate: async (before) => {
        if (signal?.aborted)
          throw new FileOperationError(401, "unauthorized", "This connection is no longer authorized.");
        const current = findWorkspace(deps, slug);
        if (current.registration_id !== workspace.registration_id)
          throw new FileOperationError(409, "not-manageable", "This workspace has changed.");
        let destination: string, trash: TrashLocation | undefined;
        if (action === "create") {
          destination = prospectivePath(workspace, path);
          if (kind === "folder") mkdirSync(destination);
          else {
            const fd = openSync(
              destination,
              constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
              0o666,
            );
            try {
              fsyncSync(fd);
            } finally {
              closeSync(fd);
            }
          }
          syncDirectory(dirname(destination));
        } else if (action === "rename" && to) destination = renameReserved(workspace, path, to);
        else if (action === "trash") {
          const source = filePath(workspace, path);
          if (kind === "folder") inspectFolder(source, protectedRoots(deps, workspace));
          trash = (await trashItem(source)) ?? undefined;
          if (!trash)
            throw new FileOperationError(503, "file-operation-uncertain", "Check the Trash before trying again.");
          destination = trash.location;
        } else throw new FileOperationError(400, "validation-failed", "Unknown file action.");
        return {
          path: to ?? path,
          from: action === "rename" ? path : undefined,
          to,
          kind,
          receipt: remember(bus, operation, destination, before, trash),
        };
      },
    };
  });
  return { ...result.value, checkpoint: result.checkpoint, history_status: result.history_status };
}
async function undoOperation(
  deps: ArtifactAccessDependencies,
  slug: string,
  bus: WorkspaceBus,
  id: unknown,
  signal?: AbortSignal,
) {
  const receipt = receipts.get(bus)?.find((item) => item.id === id);
  const refuse = (reason: string): never => {
    throw new FileOperationError(409, "undo-unavailable", `This operation cannot be undone: ${reason}.`, { reason });
  };
  if (!receipt) return refuse("expired");
  if (receipt.used) return refuse("already-undone");
  const workspace = findWorkspace(deps, slug),
    original = receipt.operation;
  let result: { value: { undone: FileOperation }; checkpoint: string; history_status: "recorded" | "pending" };
  try {
    result = await bus.captureHumanFileOperation(() => {
      const sourcePath = original.to ?? original.path;
      const source = receipt.trash ? verifyTrash(receipt.trash) : filePath(workspace, sourcePath);
      const current = identity(source);
      if (!same(current, receipt.identity)) return refuse("changed-since");
      if (original.op === "create" && (current.size !== 0 || current.ctimeMs !== receipt.identity.ctimeMs))
        return refuse("changed-since");
      if (original.op === "mkdir" && readdirSync(source).length) return refuse("changed-since");
      const rename = original.op === "rename" ? { from: sourcePath, to: original.path } : undefined;
      const operation: FileOperation = {
        op: "undo",
        path: sourcePath,
        to: original.path,
        scope: original.scope,
        ...(receipt.trash ? { restore_checkpoint: receipt.checkpoint } : {}),
        ...(rename ? { rename } : {}),
      };
      return {
        operation,
        mutate: async () => {
          if (signal?.aborted)
            throw new FileOperationError(401, "unauthorized", "This connection is no longer authorized.");
          findWorkspace(deps, slug);
          const fresh = identity(receipt.trash ? verifyTrash(receipt.trash) : filePath(workspace, sourcePath));
          if (
            !same(fresh, receipt.identity) ||
            (original.op === "create" && (fresh.size !== 0 || fresh.ctimeMs !== receipt.identity.ctimeMs))
          )
            return refuse("changed-since");
          if (original.op === "mkdir" && readdirSync(source).length) return refuse("changed-since");
          if (receipt.trash) {
            prospectivePath(workspace, original.path);
            verifyTrash(receipt.trash);
            renameReserved(workspace, original.path, original.path, source);
            finishTrashRestore(receipt.trash);
          } else if (original.op === "rename") renameReserved(workspace, sourcePath, original.path);
          else if (original.op === "mkdir") rmdirSync(filePath(workspace, sourcePath));
          else await trashItem(filePath(workspace, sourcePath));
          receipt.used = true;
          return { undone: original };
        },
      };
    });
  } catch (error) {
    if (error instanceof FileOperationError && error.code !== "undo-unavailable" && error.status !== 401)
      return refuse(error.code === "not-found" ? "changed-since" : error.code);
    throw error;
  }
  return { ...result.value, history_status: result.history_status };
}

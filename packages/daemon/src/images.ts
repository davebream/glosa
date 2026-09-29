// SPDX-License-Identifier: Apache-2.0
// Workspace images are versioned assets, separate from editable documents.
import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  readdirSync,
  linkSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, extname, join, posix, relative } from "node:path";
import { imageSize } from "image-size";
import { XMLValidator } from "fast-xml-parser";
import MarkdownIt from "markdown-it";
import {
  IMAGE_ASSET_EXTENSIONS,
  buildWatchIgnored,
  loadMatcherConfig,
  matchTrackedFile,
  resolveMatchedFiles,
} from "./matcher.ts";
import { filePath, FileOperationError } from "./security/file-path-guard.ts";
import { workspaceBusPath, workspaceTracking, workspaceWorktree, type WorkspaceTarget } from "./workspace.ts";

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const IMAGE_EXTENSIONS = IMAGE_ASSET_EXTENSIONS;
const types: Record<string, [string, string]> = {
  png: ["image/png", "png"],
  jpg: ["image/jpeg", "jpg"],
  gif: ["image/gif", "gif"],
  webp: ["image/webp", "webp"],
  svg: ["image/svg+xml", "svg"],
  avif: ["image/avif", "avif"],
};
const markdown = new MarkdownIt({ html: false });

export class ImageError extends Error {
  constructor(
    readonly status: number,
    readonly code: import("./transport/problem.ts").ProblemSlug,
    message: string,
  ) {
    super(message);
  }
}
const invalidPath = () =>
  new ImageError(400, "invalid-image-path", "Choose an image inside this workspace, without parent paths or symlinks.");

export function imageConfig(workspace: WorkspaceTarget) {
  const base = loadMatcherConfig(workspaceWorktree(workspace), workspaceBusPath(workspace));
  return {
    artifacts: {
      ...base.artifacts,
      exclude: [...base.artifacts.exclude, "**/.*/**"],
      include: ["**/*"],
      maxFileBytes: MAX_IMAGE_BYTES,
    },
  };
}

/** The watcher uses the same exclusion policy as reads, imports and listing. */
export function imageIgnored(workspace: WorkspaceTarget) {
  return buildWatchIgnored(workspaceWorktree(workspace), imageConfig(workspace), { ignoreOversize: false });
}

/** confinePath prevents escapes, but an in-root symlink is forbidden too. */
export function imagePath(workspace: WorkspaceTarget, path: string, allowMissing: boolean | "parents" = false): string {
  try {
    return filePath(workspace, path, allowMissing);
  } catch (error) {
    if (error instanceof FileOperationError)
      throw new ImageError(
        error.status,
        error.code === "not-found" ? "image-missing" : "invalid-image-path",
        error.message,
      );
    throw error;
  }
}

export function inspectImage(bytes: Uint8Array) {
  if (bytes.byteLength > MAX_IMAGE_BYTES)
    throw new ImageError(413, "image-too-large", "Images must be 20 MiB or smaller.");
  try {
    let size: { type?: string; width: number; height: number };
    try {
      size = imageSize(bytes);
    } catch {
      // An SVG without intrinsic dimensions is valid: browsers use a 300 × 150 viewport.
      // The XML/root check below still applies before any bytes are accepted.
      const xml = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (!/^\s*(?:<\?xml[^?]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/.test(xml)) throw new Error();
      size = { type: "svg", width: 300, height: 150 };
    }
    const kind = size.type ?? "";
    const type = types[kind];
    if (!type || size.width <= 0 || size.height <= 0 || !Number.isFinite(size.width * size.height)) throw new Error();
    if (kind === "svg") {
      const xml = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (
        /<!DOCTYPE|<!ENTITY/i.test(xml) ||
        XMLValidator.validate(xml) !== true ||
        !/^\s*(?:<\?xml[^?]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/.test(xml)
      )
        throw new Error();
    }
    return { mime: type[0], extension: type[1], width: size.width, height: size.height };
  } catch {
    throw new ImageError(422, "invalid-image", "Choose a valid PNG, JPEG, GIF, WebP, SVG or AVIF image.");
  }
}

/** No sibling walk for a loose document: only its explicit Markdown references. */
export function referencedImages(workspace: WorkspaceTarget): string[] {
  const tracking = workspaceTracking(workspace);
  if (tracking.mode !== "bounded") return [];
  const found = new Set<string>();
  for (const document of tracking.paths) {
    const file = matchTrackedFile(workspace, join(workspaceWorktree(workspace), document));
    if (!file || file.sizeBytes > 2 * 1024 * 1024 || !/\.md$/i.test(document)) continue;
    for (const token of markdown.parse(readFileSync(file.rawPath, "utf8"), {})) {
      for (const child of token.children ?? []) {
        const src = child.type === "image" ? child.attrGet("src") : null;
        if (!src || /^(?:[a-z][\w+.-]*:|\/)/i.test(src)) continue;
        try {
          const decoded = decodeURIComponent(src.split(/[?#]/)[0]!);
          if (decoded.split("/").includes("..")) continue;
          const path = posix.join(posix.dirname(document), decoded);
          imagePath(workspace, path, "parents");
          if (IMAGE_EXTENSIONS.test(path)) found.add(path);
        } catch {
          /* A placeholder explains refused or missing references. */
        }
      }
    }
  }
  return [...found];
}

function allowedLooseImage(workspace: WorkspaceTarget, path: string) {
  const tracking = workspaceTracking(workspace);
  return (
    tracking.mode !== "bounded" ||
    tracking.paths.some((doc) => path.startsWith(`${posix.join(posix.dirname(doc), "images")}/`)) ||
    referencedImages(workspace).includes(path)
  );
}

export function readImage(workspace: WorkspaceTarget, path: string) {
  if (!IMAGE_EXTENSIONS.test(path) || !allowedLooseImage(workspace, path)) throw invalidPath();
  const file = imagePath(workspace, path);
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd);
    if (!before.isFile()) throw invalidPath();
    if (before.size > MAX_IMAGE_BYTES)
      throw new ImageError(413, "image-too-large", "This image exceeds the 20 MiB preview limit.");
    imagePath(workspace, path);
    // A concurrently growing file must not defeat the read budget.
    const buffer = Buffer.alloc(Math.min(before.size + 1, MAX_IMAGE_BYTES + 1));
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > before.size) throw new ImageError(409, "invalid-image", "Image changed while loading. Try again.");
    const bytes = buffer.subarray(0, length);
    const after = lstatSync(file);
    if (after.isSymbolicLink() || before.ino !== after.ino || before.dev !== after.dev) throw invalidPath();
    imagePath(workspace, path);
    return { bytes, ...inspectImage(bytes), version: createHash("sha256").update(bytes).digest("hex") };
  } catch (error) {
    if (error instanceof ImageError) throw error;
    throw new ImageError(404, "image-missing", "Image is missing or unreadable.");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function looseImagePaths(workspace: WorkspaceTarget): string[] {
  const tracking = workspaceTracking(workspace);
  if (tracking.mode !== "bounded") return [];
  const paths = new Set(referencedImages(workspace));
  for (const doc of tracking.paths) {
    const directory = posix.join(posix.dirname(doc), "images");
    try {
      for (const name of readdirSync(imagePath(workspace, directory)).slice(0, 10_000)) {
        if (IMAGE_EXTENSIONS.test(name)) paths.add(posix.join(directory, name));
      }
    } catch {
      /* Imports may not exist yet. Never scan the document's siblings. */
    }
  }
  return [...paths];
}

export function listImages(workspace: WorkspaceTarget) {
  const root = workspaceWorktree(workspace);
  const tracking = workspaceTracking(workspace);
  const scan =
    tracking.mode === "matcher" ? resolveMatchedFiles(root, imageConfig(workspace), { limit: 10_000 }) : null;
  const paths = scan
    ? [...scan.tracked, ...scan.oversize].map((f) => relative(root, f.rawPath).split("\\").join("/"))
    : looseImagePaths(workspace);
  const images = paths
    .filter((path) => IMAGE_EXTENSIONS.test(path))
    .flatMap((path) => {
      try {
        const stat = lstatSync(imagePath(workspace, path));
        return [
          {
            kind: "image" as const,
            path,
            size_bytes: stat.size,
            version: `${stat.ino}:${stat.mtimeMs}:${stat.size}`,
            oversize: stat.size > MAX_IMAGE_BYTES,
          },
        ];
      } catch {
        return [];
      }
    });
  images.sort((a, b) => Buffer.compare(Buffer.from(a.path.normalize("NFC")), Buffer.from(b.path.normalize("NFC"))));
  return { images, directories: scan?.directories.map((dir) => dir.path) ?? [], truncated: scan?.truncated ?? false };
}

export function importImage(
  workspace: WorkspaceTarget,
  input: { name: string; bytes: Uint8Array; document?: string; directory?: string },
) {
  const info = inspectImage(input.bytes);
  if ((input.document === undefined) === (input.directory === undefined)) throw invalidPath();
  let directory = input.directory ?? "";
  if (input.document !== undefined) {
    const file = imagePath(workspace, input.document);
    if (!/\.md$/i.test(input.document) || !matchTrackedFile(workspace, file)) throw invalidPath();
    directory = posix.join(posix.dirname(input.document), "images");
  } else if (workspaceTracking(workspace).mode === "bounded") throw invalidPath();
  if (directory) {
    const target = imagePath(workspace, directory, input.document !== undefined);
    if (input.document !== undefined) {
      try {
        mkdirSync(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    if (!lstatSync(imagePath(workspace, directory)).isDirectory()) throw invalidPath();
  }
  const stem =
    posix
      .basename(input.name.replaceAll("\\", "/"), extname(input.name))
      .normalize("NFC")
      .replace(/[^\p{L}\p{N}_-]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "pasted-image";
  const path = posix.join(directory, `${stem}-${randomUUID().slice(0, 8)}.${info.extension}`);
  const destination = imagePath(workspace, path, true);
  // Link publishes a fully fsynced inode atomically WITHOUT rename's overwrite behavior.
  const temp = join(dirname(destination), `.glosa-image-${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let written = 0;
    while (written < input.bytes.length) written += writeSync(fd, input.bytes, written);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    imagePath(workspace, path, true);
    linkSync(temp, destination);
    unlinkSync(temp);
    const dir = openSync(dirname(destination), constants.O_RDONLY);
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temp);
    } catch {
      /* Already published, or creation failed. */
    }
  }
  return {
    kind: "image",
    path,
    mime: info.mime,
    size_bytes: input.bytes.length,
    version: createHash("sha256").update(input.bytes).digest("hex"),
    width: info.width,
    height: info.height,
    ...(input.document !== undefined ? { relative_path: posix.relative(posix.dirname(input.document), path) } : {}),
  };
}

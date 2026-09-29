// SPDX-License-Identifier: Apache-2.0
import { importImage, listImages, readImage, ImageError, MAX_IMAGE_BYTES } from "../images.ts";
import { decodePathCapture } from "../security/confine-path.ts";
import {
  findWorkspace,
  workspaceBus,
  WorkspaceLookupError,
  type WorkspaceAccess,
} from "../services/workspace-access.ts";
import { historicalImage } from "../services/file-history.ts";
import { directoryHistoryKey } from "../versioned-files.ts";
import { FileOperationError } from "../security/file-path-guard.ts";
import { posix } from "node:path";
import { workspaceTracking } from "../workspace.ts";
import { problem, type ProblemSlug } from "../transport/problem.ts";
import type { RouteMatch } from "./types.ts";

export function imageRoutes(deps: WorkspaceAccess, method: string, pathname: string): RouteMatch | null {
  const match = /^\/w\/([^/]+)\/images(?:\/(.+))?$/.exec(pathname);
  if (!match || !["GET", "POST"].includes(method) || (method === "POST" && match[2])) return null;
  return {
    routeClass: method === "GET" ? "authed-read" : "state-changing",
    bodyLimit: MAX_IMAGE_BYTES + 64 * 1024,
    handle: async (req, _server, authSignal) => {
      try {
        const slug = decodePathCapture(match[1]!);
        if (!slug.ok) throw new ImageError(400, "invalid-image-path", "Invalid workspace path.");
        let workspace = findWorkspace(deps, slug.path);
        if (method === "GET" && !match[2])
          return Response.json(listImages(workspace), { headers: { "Cache-Control": "no-store" } });
        if (method === "GET") {
          const path = decodePathCapture(match[2]!);
          if (!path.ok) throw new ImageError(400, "invalid-image-path", "Invalid image path.");
          const checkpoint = new URL(req.url).searchParams.get("checkpoint");
          const image = checkpoint
            ? { ...(await historicalImage(deps, slug.path, path.path, checkpoint)), version: checkpoint }
            : readImage(workspace, path.path);
          return new Response(new Uint8Array(image.bytes), {
            headers: {
              "Content-Type": image.mime,
              "Content-Length": String(image.bytes.length),
              "Cache-Control": "no-store",
              ETag: `"${image.version}"`,
              "X-Content-Type-Options": "nosniff",
              "Content-Security-Policy": "sandbox; default-src 'none'; frame-ancestors 'none'; base-uri 'none';",
            },
          });
        }
        let form: FormData;
        try {
          form = await req.formData();
        } catch {
          throw new ImageError(422, "invalid-image-upload", "Choose an image and a destination.");
        }
        const file = form.get("file");
        const document = form.get("document_path");
        const directory = form.get("directory_path");
        if (
          !(file instanceof File) ||
          file.size > MAX_IMAGE_BYTES ||
          (document !== null && typeof document !== "string") ||
          (directory !== null && typeof directory !== "string") ||
          [...form.keys()].some(
            (key) => !["file", "document_path", "directory_path"].includes(key) || form.getAll(key).length !== 1,
          )
        ) {
          throw new ImageError(
            file instanceof File && file.size > MAX_IMAGE_BYTES ? 413 : 422,
            "invalid-image-upload",
            "Choose an image up to 20 MiB and a destination.",
          );
        }
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (authSignal?.aborted) throw new ImageError(401, "unauthorized", "This connection is no longer authorized.");
        // Revalidate after every asynchronous boundary, before a synchronous filesystem commit.
        workspace = findWorkspace(deps, slug.path);
        const input = {
          name: file.name,
          bytes,
          ...(typeof document === "string" ? { document } : {}),
          ...(typeof directory === "string" ? { directory } : {}),
        };
        const imported =
          workspaceTracking(workspace).mode === "bounded"
            ? importImage(workspace, input)
            : await (await workspaceBus(deps, workspace)).captureHumanFileOperation(() => ({
                operation: {
                  op: "import",
                  path:
                    typeof directory === "string" ? directory : posix.join(posix.dirname(document as string), "images"),
                  scope: "folder",
                },
                mutate: () => {
                  if (authSignal?.aborted)
                    throw new ImageError(401, "unauthorized", "This connection is no longer authorized.");
                  workspace = findWorkspace(deps, slug.path);
                  return importImage(workspace, input);
                },
                historyFiles: (value) => {
                  const files = new Map([[value.path, bytes]]);
                  for (
                    let directory = posix.dirname(value.path);
                    directory !== ".";
                    directory = posix.dirname(directory)
                  )
                    files.set(directoryHistoryKey(directory), new Uint8Array());
                  return files;
                },
              }));
        const response =
          "value" in imported
            ? { ...imported.value, checkpoint: imported.checkpoint, history_status: imported.history_status }
            : imported;
        return Response.json(response, { status: 201 });
      } catch (error) {
        if (error instanceof FileOperationError)
          return problem(error.status, error.code as ProblemSlug, error.message, undefined, pathname, error.data);
        if (error instanceof ImageError) return problem(error.status, error.code, error.message, undefined, pathname);
        if (error instanceof WorkspaceLookupError)
          return problem(
            error.code === "not-found" ? 404 : 409,
            error.code,
            "Workspace is unavailable.",
            undefined,
            pathname,
          );
        throw error;
      }
    },
  };
}

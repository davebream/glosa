// SPDX-License-Identifier: Apache-2.0
import type { ArtifactAccessDependencies } from "../services/artifact.ts";
import { fileFormats, inspectPath, performFileOperation } from "../services/file-ops.ts";
import { checkpointContents, restoreFileHistory } from "../services/file-history.ts";
import { FileOperationError } from "../security/file-path-guard.ts";
import { WorkspaceLookupError } from "../services/workspace-access.ts";
import { problem, type ProblemSlug } from "../transport/problem.ts";
import type { RouteMatch } from "./types.ts";
export function fileRoutes(deps: ArtifactAccessDependencies, method: string, pathname: string): RouteMatch | null {
  const match = /^\/w\/([^/]+)\/files\/(formats|inspect|create|rename|trash|undo|history|restore)$/.exec(pathname);
  if (!match) return null;
  const action = match[2]!,
    read = ["formats", "inspect", "history"].includes(action);
  if (method !== (read ? "GET" : "POST")) return null;
  return {
    routeClass: read ? "authed-read" : "state-changing",
    handle: async (req, _server, signal) => {
      try {
        const slug = decodeURIComponent(match[1]!),
          query = new URL(req.url).searchParams;
        if (action === "formats") return Response.json(fileFormats(deps, slug));
        if (action === "inspect") return Response.json(inspectPath(deps, slug, query.get("path") ?? ""));
        if (action === "history") {
          const cursor = Number(query.get("cursor") ?? "0");
          if (!Number.isSafeInteger(cursor) || cursor < 0)
            throw new FileOperationError(400, "validation-failed", "Choose a valid history page.");
          return Response.json(
            await checkpointContents(deps, slug, query.get("checkpoint") ?? "", query.get("path") ?? "", cursor),
          );
        }
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          throw new FileOperationError(400, "validation-failed", "Send a JSON object.");
        }
        if (!body || typeof body !== "object" || Array.isArray(body))
          throw new FileOperationError(400, "validation-failed", "Send a JSON object.");
        if (signal?.aborted) return problem(401, "unauthorized", "This connection is no longer authorized.");
        const result =
          action === "restore"
            ? await restoreFileHistory(deps, slug, body as Record<string, unknown>, signal)
            : await performFileOperation(deps, slug, action, body as Record<string, unknown>, signal);
        return Response.json(result, { status: action === "create" ? 201 : 200 });
      } catch (error) {
        if (error instanceof FileOperationError)
          return problem(error.status, error.code as ProblemSlug, error.message, undefined, pathname, error.data);
        if (error instanceof WorkspaceLookupError)
          return problem(error.code === "not-found" ? 404 : 409, error.code, "Workspace is unavailable.");
        if ((error as NodeJS.ErrnoException).code === "EEXIST")
          return problem(409, "path-exists", "An item with this name already exists.");
        throw error;
      }
    },
  };
}

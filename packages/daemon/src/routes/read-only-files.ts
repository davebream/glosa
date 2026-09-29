// SPDX-License-Identifier: Apache-2.0
import { glosaHome } from "../lifecycle/home.ts";
import { ReadOnlyError, readOnlyFile } from "../read-only-files.ts";
import { ReadOnlyRegistry } from "../read-only-registry.ts";
import { FileViews, isFileView } from "../registry/file-views.ts";
import { decodePathCapture } from "../security/confine-path.ts";
import { findWorkspace, WorkspaceLookupError, type WorkspaceAccess } from "../services/workspace-access.ts";
import { problem } from "../transport/problem.ts";
import type { RouteMatch } from "./types.ts";
type Dependencies = WorkspaceAccess & { home?: string };
const services = new WeakMap<Dependencies, { views: FileViews; files: ReadOnlyRegistry }>();
export function readOnlyServices(deps: Dependencies) {
  let value = services.get(deps);
  if (!value) {
    value = { views: new FileViews(deps.home ?? glosaHome()), files: new ReadOnlyRegistry() };
    services.set(deps, value);
  }
  return value;
}
export function readOnlyRoutes(deps: Dependencies, method: string, pathname: string): RouteMatch | null {
  const match = /^\/w\/([^/]+)\/(file-view|read-only-files)(?:\/(.+))?$/.exec(pathname);
  if (
    !match ||
    (match[2] === "file-view" && match[3]) ||
    !(method === "GET" || (method === "PUT" && match[2] === "file-view"))
  )
    return null;
  return {
    routeClass: method === "GET" ? "authed-read" : "state-changing",
    handle: async (req, _server, signal) => {
      try {
        const slug = decodePathCapture(match[1]!);
        if (!slug.ok) throw new ReadOnlyError(400, "Invalid folder path.");
        const workspace = findWorkspace(deps, slug.path);
        if (workspace.kind !== "directory")
          throw new ReadOnlyError(422, "File browsing is available in folder workspaces.");
        const { views, files } = readOnlyServices(deps);
        const reply = (body: unknown) => Response.json(body, { headers: { "Cache-Control": "no-store" } });
        if (match[2] === "file-view") {
          if (method === "GET") return reply(views.get(workspace.canonical_path));
          let body: unknown;
          try {
            body = await req.json();
          } catch {
            throw new ReadOnlyError(422, "Choose a file view and whether to show ignored files.");
          }
          if (!isFileView(body) || Object.keys(body).some((key) => !["mode", "show_ignored"].includes(key)))
            throw new ReadOnlyError(422, "Choose a file view and whether to show ignored files.");
          if (signal?.aborted) return problem(401, "unauthorized", "This connection is no longer authorized.");
          if (findWorkspace(deps, slug.path).registration_id !== workspace.registration_id)
            throw new ReadOnlyError(409, "This workspace changed. Reload it.");
          try {
            const view = await views.set(workspace.canonical_path, body);
            files.invalidate(workspace);
            return reply(view);
          } catch (error) {
            throw new ReadOnlyError(409, (error as Error).message);
          }
        }
        const view = views.get(workspace.canonical_path);
        const listing = await files.list(workspace, view.show_ignored);
        if (signal?.aborted) return problem(401, "unauthorized", "This connection is no longer authorized.");
        const current = findWorkspace(deps, slug.path);
        if (current.registration_id !== workspace.registration_id || current.first_seen !== workspace.first_seen)
          throw new ReadOnlyError(409, "This workspace changed. Reload it.");
        if (!match[3]) return reply(listing);
        const path = decodePathCapture(match[3]);
        if (!path.ok) throw new ReadOnlyError(400, "Invalid file path.");
        if (!listing.files.some((file) => file.path === path.path.normalize("NFC")))
          throw new ReadOnlyError(404, "This file is not in the read-only listing. Refresh the file tree.");
        return reply(
          readOnlyFile(current, path.path.normalize("NFC"), views.get(workspace.canonical_path).show_ignored),
        );
      } catch (error) {
        if (error instanceof WorkspaceLookupError)
          return problem(error.code === "not-found" ? 404 : 409, error.code, error.message);
        const status = error instanceof ReadOnlyError ? error.status : 503;
        return problem(
          status,
          status === 400 ? "invalid-path" : status === 404 ? "not-found" : "read-only-unavailable",
          error instanceof Error ? error.message : "Files could not be loaded. Retry to refresh.",
        );
      }
    },
  };
}

// SPDX-License-Identifier: Apache-2.0

import {
  type AttentionDependencies,
  AttentionError,
  attentionEntryStatus,
  completeAttention,
  createAttention,
  listAttention,
  markAttentionSeen,
} from "../services/attention.ts";
import { findWorkspace, WorkspaceLookupError } from "../services/workspace-access.ts";
import { problem } from "../transport/problem.ts";
import type { RouteMatch } from "./types.ts";

function mapWorkspace(error: WorkspaceLookupError, pathname: string) {
  return error.code === "not-found"
    ? problem(404, "not-found", "unknown workspace", undefined, pathname)
    : problem(409, "workspace-adopting", "workspace adoption is in progress", undefined, pathname);
}

function mapError(error: unknown, pathname: string): Response {
  if (error instanceof WorkspaceLookupError) return mapWorkspace(error, pathname);
  if (!(error instanceof AttentionError)) throw error;
  switch (error.code) {
    case "invalid-workspace-path":
      return problem(400, "invalid-path", "path does not resolve to a real directory", undefined, pathname);
    case "message-too-large":
      return problem(400, "validation-failed", "message must be at most 4096 bytes", undefined, pathname);
    case "action-too-large":
      return problem(400, "validation-failed", "action must be at most 64 bytes", undefined, pathname);
    case "invalid-target-path":
      return problem(400, "invalid-path", "target_path must be workspace-relative and confined", undefined, pathname);
    case "approval-target-required":
      return problem(400, "validation-failed", "approval-mode requests require target_path", undefined, pathname);
    case "approval-target-unavailable":
      return problem(400, "invalid-path", "approval target must be an existing tracked artifact", undefined, pathname);
    case "approval-conflict":
      return problem(
        409,
        "approval-conflict",
        "an approval request is already active for this artifact",
        undefined,
        pathname,
      );
    case "approval-uniqueness-unprovable": {
      const entries = error.data.entries as string[];
      const named = entries.slice(0, 10);
      const elided = entries.length - named.length;
      const noun = entries.length === 1 ? "entry" : "entries";
      return problem(
        500,
        "approval-uniqueness-unprovable",
        "cannot prove this artifact has no open approval request",
        `inbox ${noun} ${named.join(", ")}${elided > 0 ? ` (+${elided} more)` : ""} could not be read, so the ` +
          `one-open-approval-per-artifact rule could not be checked; restore those payloads or resolve the ` +
          `${noun}, then retry`,
        pathname,
      );
    }
    case "unknown-attention":
      return problem(404, "not-found", "unknown attention request", undefined, pathname);
    case "invalid-review-outcome":
      return problem(
        400,
        "validation-failed",
        "review requests require approved or changes_requested",
        undefined,
        pathname,
      );
    case "invalid-generic-outcome":
      return problem(400, "validation-failed", "generic requests require outcome done", undefined, pathname);
    case "approval-outcome-required":
      return problem(400, "validation-failed", "approval-mode requests require outcome approved", undefined, pathname);
    case "approval-response-forbidden":
      return problem(
        400,
        "validation-failed",
        "approval-mode requests do not accept response text",
        undefined,
        pathname,
      );
    case "invalid-revision":
      return problem(400, "validation-failed", "revision_id must be a lowercase SHA-256 digest", undefined, pathname);
    case "approval-target-missing":
      return problem(409, "conflict", "approval request has no target artifact", undefined, pathname);
    case "artifact-revision-changed":
      return problem(
        409,
        "artifact-revision-changed",
        error.data.unavailable
          ? "the approval target is no longer available"
          : "the artifact changed before approval; review the latest revision and try again",
        undefined,
        pathname,
      );
    case "conflict":
      return problem(409, "conflict", error.data.message as string, undefined, pathname);
    case "entry-not-found":
      return problem(404, "not-found", "unknown inbox entry", undefined, pathname);
  }
}

async function seen(deps: AttentionDependencies, slug: string, id: string, pathname: string) {
  try {
    return Response.json(await markAttentionSeen(deps, slug, id));
  } catch (error) {
    return mapError(error, pathname);
  }
}

async function respond(deps: AttentionDependencies, slug: string, id: string, req: Request) {
  const pathname = new URL(req.url).pathname;
  try {
    findWorkspace(deps, slug);
  } catch (error) {
    return mapError(error, pathname);
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return problem(400, "validation-failed", "body must be valid JSON", undefined, pathname);
  }
  const parsed = body as Record<string, unknown> | null;
  const outcome = parsed?.outcome;
  if (outcome !== "done" && outcome !== "approved" && outcome !== "changes_requested") {
    return problem(
      400,
      "validation-failed",
      "outcome must be done, approved, or changes_requested",
      undefined,
      pathname,
    );
  }
  const response = parsed?.response;
  if (response !== undefined && (typeof response !== "string" || Buffer.byteLength(response, "utf8") > 4096)) {
    return problem(400, "validation-failed", "response must be a string of at most 4096 bytes", undefined, pathname);
  }
  try {
    return Response.json(
      await completeAttention(deps, slug, id, {
        outcome,
        ...(typeof response === "string" ? { response } : {}),
        ...(typeof parsed?.revision_id === "string" ? { revisionId: parsed.revision_id } : {}),
      }),
    );
  } catch (error) {
    return mapError(error, pathname);
  }
}

async function create(deps: AttentionDependencies, req: Request) {
  const pathname = new URL(req.url).pathname;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return problem(400, "validation-failed", "body must be valid JSON", undefined, pathname);
  }
  const parsed = body as Record<string, unknown> | null;
  if (typeof parsed?.path !== "string" || parsed.path.length === 0) {
    return problem(400, "validation-failed", "path is required", undefined, pathname);
  }
  if (parsed.approval_mode !== undefined && typeof parsed.approval_mode !== "boolean") {
    return problem(400, "validation-failed", "approval_mode must be a boolean", undefined, pathname);
  }
  try {
    const result = await createAttention(deps, {
      path: parsed.path,
      action: typeof parsed.action === "string" ? parsed.action : "review",
      approvalMode: parsed.approval_mode === true,
      ...(typeof parsed.message === "string" ? { message: parsed.message } : {}),
      ...(typeof parsed.target_path === "string" ? { targetPath: parsed.target_path } : {}),
    });
    return new Response(JSON.stringify(result), { status: 201, headers: { "Content-Type": "application/json" } });
  } catch (error) {
    return mapError(error, pathname);
  }
}

async function entryStatus(deps: AttentionDependencies, req: Request) {
  const url = new URL(req.url);
  const path = url.searchParams.get("path");
  const id = url.searchParams.get("entry");
  if (!path || !id) {
    return problem(400, "validation-failed", "path and entry query params are required", undefined, url.pathname);
  }
  try {
    return Response.json(await attentionEntryStatus(deps, path, id));
  } catch (error) {
    return mapError(error, url.pathname);
  }
}

export function attentionRoutes(deps: AttentionDependencies, method: string, pathname: string): RouteMatch | null {
  if (method === "POST" && pathname === "/api/workspaces/attention-request") {
    return { routeClass: "state-changing", handle: (req) => create(deps, req) };
  }
  if (method === "GET" && pathname === "/api/workspaces/entry-status") {
    return { routeClass: "authed-read", handle: (req) => entryStatus(deps, req) };
  }
  let match: RegExpMatchArray | null;
  if (method === "GET" && (match = pathname.match(/^\/w\/([^/]+)\/inbox$/))) {
    const slug = match[1] as string;
    return {
      routeClass: "authed-read",
      handle: () => {
        try {
          return Response.json(listAttention(deps, slug));
        } catch (error) {
          return mapError(error, pathname);
        }
      },
    };
  }
  if (method === "POST" && (match = pathname.match(/^\/w\/([^/]+)\/inbox\/([^/]+)\/seen$/))) {
    return {
      routeClass: "state-changing",
      handle: () => seen(deps, match![1] as string, match![2] as string, pathname),
    };
  }
  if (method === "POST" && (match = pathname.match(/^\/w\/([^/]+)\/inbox\/([^/]+)\/response$/))) {
    const slug = match[1] as string;
    const id = match[2] as string;
    return { routeClass: "state-changing", handle: (req) => respond(deps, slug, id, req) };
  }
  return null;
}

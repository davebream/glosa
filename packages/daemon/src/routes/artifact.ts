// SPDX-License-Identifier: Apache-2.0

import { CAPABILITY_TTL_MS } from "../security/capability.ts";
import {
  type ArtifactDependencies,
  ArtifactError,
  artifactCheckpoints,
  artifactDiff,
  createAnnotation,
  getArtifact,
  inboxPresentation,
  listAnnotations,
  listArtifacts,
  mintArtifactCapability,
  type PreparedArtifactSave,
  prepareArtifactSave,
  restoreArtifact,
  saveArtifact,
  withdrawAnnotation,
} from "../services/artifact.ts";
import { findWorkspace, WorkspaceLookupError } from "../services/workspace-access.ts";
import { problem, restoreConflictResponse } from "../transport/problem.ts";
import type { RouteMatch } from "./types.ts";

export interface ArtifactRouteDependencies extends ArtifactDependencies {
  classFPort: number;
}

const ANNOTATION_INTENTS = new Set(["content", "classification", "style"]);

function validateAnnotationBody(
  body: unknown,
): { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, reason: "body must be a JSON object" };
  }
  const parsed = body as Record<string, unknown>;
  if (typeof parsed.artifact_path !== "string" || parsed.artifact_path.length === 0) {
    return { ok: false, reason: "body.artifact_path is required" };
  }
  if (typeof parsed.body !== "string" || parsed.body.length === 0) {
    return { ok: false, reason: "body.body is required" };
  }
  if (typeof parsed.intent !== "string" || !ANNOTATION_INTENTS.has(parsed.intent)) {
    return { ok: false, reason: "body.intent must be one of content|classification|style" };
  }
  if (typeof parsed.target !== "object" || parsed.target === null || Array.isArray(parsed.target)) {
    return { ok: false, reason: "body.target is required" };
  }
  const quote = (parsed.target as Record<string, unknown>).quote;
  if (typeof quote !== "object" || quote === null || typeof (quote as Record<string, unknown>).exact !== "string") {
    return { ok: false, reason: "body.target.quote.exact is required" };
  }
  return { ok: true, value: parsed };
}

function mapWorkspace(error: WorkspaceLookupError, pathname: string): Response {
  return error.code === "not-found"
    ? problem(404, "not-found", "unknown workspace", undefined, pathname)
    : problem(409, "workspace-adopting", "workspace adoption is in progress", undefined, pathname);
}

interface ErrorContext {
  notFound?: "artifact" | "inbox";
  unknownCheckpoint?: "diff" | "checkpoints" | "restore";
}

function mapError(error: unknown, pathname: string, context: ErrorContext = {}): Response {
  if (error instanceof WorkspaceLookupError) return mapWorkspace(error, pathname);
  if (!(error instanceof ArtifactError)) throw error;
  switch (error.code) {
    case "invalid-path":
      return problem(400, "invalid-path", "path escapes the workspace or is malformed", undefined, pathname);
    case "not-found":
      return context.notFound === "inbox"
        ? problem(404, "not-found", "no such inbox entry", error.data.id as string, pathname)
        : problem(404, "not-found", "path within workspace but no such artifact", undefined, pathname);
    case "class-f-not-editable":
      return problem(
        400,
        "validation-failed",
        "class-F artifacts are not editable through this route",
        undefined,
        pathname,
      );
    case "source-changed":
      return problem(409, "conflict", "source_sha256 has changed since If-Match was captured", undefined, pathname);
    case "unknown-checkpoint": {
      const title =
        context.unknownCheckpoint === "checkpoints"
          ? "since is not a recognized token or known checkpoint"
          : context.unknownCheckpoint === "restore"
            ? "to is not a known checkpoint"
            : "from/to is not a known checkpoint";
      return problem(400, "validation-failed", title, undefined, pathname);
    }
    case "artifact-missing-at-checkpoint":
      return problem(404, "not-found", "artifact did not exist at that checkpoint", undefined, pathname);
    case "restore-conflict":
      return restoreConflictResponse(pathname, error.data.path as string, error.data.diff as string);
    case "annotation-not-found":
      return problem(404, "not-found", "no such annotation entry", error.data.id as string, pathname);
    case "annotation-closed":
      return problem(409, "conflict", "entry already closed", `status is ${String(error.data.status)}`, pathname);
    case "presentation-not-actionable":
      return problem(422, "validation-failed", "entry payload is not actionable", error.data.id as string, pathname);
    case "class-r-capability":
      return problem(400, "invalid-path", "capability minting is only for class-F artifacts", undefined, pathname);
  }
}

function requireWorkspace(deps: ArtifactRouteDependencies, slug: string, pathname: string): Response | null {
  try {
    findWorkspace(deps, slug);
    return null;
  } catch (error) {
    return mapError(error, pathname);
  }
}

function list(deps: ArtifactRouteDependencies, slug: string, pathname: string): Response {
  try {
    return Response.json(listArtifacts(deps, slug));
  } catch (error) {
    return mapError(error, pathname);
  }
}

function get(deps: ArtifactRouteDependencies, slug: string, path: string, req: Request): Response {
  const url = new URL(req.url);
  try {
    return Response.json(getArtifact(deps, slug, path, url.searchParams.get("render") === "html"));
  } catch (error) {
    return mapError(error, url.pathname, { notFound: "artifact" });
  }
}

async function put(deps: ArtifactRouteDependencies, slug: string, path: string, req: Request): Promise<Response> {
  const url = new URL(req.url);
  let prepared: PreparedArtifactSave;
  try {
    prepared = prepareArtifactSave(deps, slug, path, req.headers.get("If-Match") ?? undefined);
  } catch (error) {
    return mapError(error, url.pathname, { notFound: "artifact" });
  }

  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return problem(400, "validation-failed", "unable to read request body", undefined, url.pathname);
  }
  if (raw.length === 0) {
    return problem(400, "validation-failed", "request body must not be empty", undefined, url.pathname);
  }
  let content = raw;
  try {
    const parsed = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      typeof (parsed as Record<string, unknown>).content === "string"
    ) {
      content = (parsed as Record<string, unknown>).content as string;
    }
  } catch {
    // Bare source text is the common request shape.
  }

  try {
    return Response.json(await saveArtifact(deps, prepared, content));
  } catch (error) {
    return mapError(error, url.pathname, { notFound: "artifact" });
  }
}

async function listAnnotationsRoute(deps: ArtifactRouteDependencies, slug: string, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.searchParams.get("path");
  try {
    return Response.json({ annotations: await listAnnotations(deps, slug, path ?? undefined) });
  } catch (error) {
    return mapError(error, url.pathname);
  }
}

async function annotate(deps: ArtifactRouteDependencies, slug: string, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const workspaceError = requireWorkspace(deps, slug, url.pathname);
  if (workspaceError) return workspaceError;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return problem(400, "validation-failed", "body must be valid JSON", undefined, url.pathname);
  }
  const validated = validateAnnotationBody(body);
  if (!validated.ok) return problem(400, "validation-failed", validated.reason, undefined, url.pathname);
  try {
    const value = validated.value;
    const result = await createAnnotation(deps, slug, {
      artifactPath: value.artifact_path as string,
      ...(typeof value.captured_rendered_sha256 === "string"
        ? { capturedRenderedSha256: value.captured_rendered_sha256 }
        : {}),
      body: value.body,
      intent: value.intent,
      target: value.target,
    });
    return Response.json(result, { status: 201 });
  } catch (error) {
    return mapError(error, url.pathname);
  }
}

async function withdraw(
  deps: ArtifactRouteDependencies,
  slug: string,
  entryId: string,
  pathname: string,
): Promise<Response> {
  try {
    return Response.json(await withdrawAnnotation(deps, slug, entryId));
  } catch (error) {
    return mapError(error, pathname);
  }
}

async function diff(deps: ArtifactRouteDependencies, slug: string, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const workspaceError = requireWorkspace(deps, slug, url.pathname);
  if (workspaceError) return workspaceError;
  if (url.searchParams.get("since") !== null) {
    return problem(400, "validation-failed", "since= is not yet supported — use from=/to=", undefined, url.pathname);
  }
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (!from || !to) {
    return problem(400, "validation-failed", "from and to query params are required", undefined, url.pathname);
  }
  try {
    return Response.json(await artifactDiff(deps, slug, from, to));
  } catch (error) {
    return mapError(error, url.pathname, { unknownCheckpoint: "diff" });
  }
}

async function checkpoints(deps: ArtifactRouteDependencies, slug: string, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const workspaceError = requireWorkspace(deps, slug, url.pathname);
  if (workspaceError) return workspaceError;
  const rawLimit = url.searchParams.get("limit");
  let limit: number | undefined;
  if (rawLimit !== null) {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return problem(400, "validation-failed", "limit must be a positive integer", undefined, url.pathname);
    }
    limit = parsed;
  }
  try {
    return Response.json(
      await artifactCheckpoints(deps, slug, {
        ...(url.searchParams.get("since") !== null ? { since: url.searchParams.get("since") as string } : {}),
        ...(limit !== undefined ? { limit } : {}),
      }),
    );
  } catch (error) {
    return mapError(error, url.pathname, { unknownCheckpoint: "checkpoints" });
  }
}

async function restore(deps: ArtifactRouteDependencies, slug: string, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const workspaceError = requireWorkspace(deps, slug, url.pathname);
  if (workspaceError) return workspaceError;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return problem(400, "validation-failed", "body must be valid JSON", undefined, url.pathname);
  }
  const parsed = body as Record<string, unknown> | null;
  if (
    typeof parsed?.path !== "string" ||
    parsed.path.length === 0 ||
    typeof parsed.to !== "string" ||
    parsed.to.length === 0
  ) {
    return problem(400, "validation-failed", "path and to are required", undefined, url.pathname);
  }
  try {
    return Response.json(await restoreArtifact(deps, slug, parsed.path, parsed.to, parsed.force === true));
  } catch (error) {
    return mapError(error, url.pathname, { notFound: "artifact", unknownCheckpoint: "restore" });
  }
}

async function presentation(
  deps: ArtifactRouteDependencies,
  slug: string,
  entryId: string,
  req: Request,
): Promise<Response> {
  const url = new URL(req.url);
  try {
    const value = await inboxPresentation(deps, slug, entryId, url.searchParams.get("cursor") ?? undefined);
    return Response.json({ presentation: value });
  } catch (error) {
    return mapError(error, url.pathname, { notFound: "inbox" });
  }
}

function mint(deps: ArtifactRouteDependencies, slug: string, artifactPath: string, pathname: string): Response {
  try {
    const minted = mintArtifactCapability(deps, slug, artifactPath);
    return Response.json({
      url: `http://127.0.0.1:${deps.classFPort}/doc/${minted.token}/${minted.artifactBasename}`,
      nonce: minted.nonce,
      expires_in_s: CAPABILITY_TTL_MS / 1000,
    });
  } catch (error) {
    return mapError(error, pathname, { notFound: "artifact" });
  }
}

export function artifactRoutes(deps: ArtifactRouteDependencies, method: string, pathname: string): RouteMatch | null {
  let match: RegExpMatchArray | null;
  if (method === "GET" && (match = pathname.match(/^\/w\/([^/]+)\/artifacts$/))) {
    return { routeClass: "authed-read", handle: () => list(deps, match![1] as string, pathname) };
  }
  if (method === "GET" && (match = pathname.match(/^\/w\/([^/]+)\/inbox\/([^/]+)\/presentation$/))) {
    const slug = match[1] as string;
    const entryId = match[2] as string;
    return { routeClass: "authed-read", handle: (req) => presentation(deps, slug, entryId, req) };
  }
  if (method === "GET" && (match = pathname.match(/^\/w\/([^/]+)\/artifacts\/(.+)$/))) {
    const slug = match[1] as string;
    const path = match[2] as string;
    return { routeClass: "authed-read", handle: (req) => get(deps, slug, path, req) };
  }
  if (method === "PUT" && (match = pathname.match(/^\/w\/([^/]+)\/artifacts\/(.+)$/))) {
    const slug = match[1] as string;
    const path = match[2] as string;
    return { routeClass: "state-changing", handle: (req) => put(deps, slug, path, req) };
  }
  if (method === "GET" && (match = pathname.match(/^\/w\/([^/]+)\/annotations$/))) {
    const slug = match[1] as string;
    return { routeClass: "authed-read", handle: (req) => listAnnotationsRoute(deps, slug, req) };
  }
  if (method === "POST" && (match = pathname.match(/^\/w\/([^/]+)\/annotations$/))) {
    return { routeClass: "state-changing", handle: (req) => annotate(deps, match![1] as string, req) };
  }
  if (method === "POST" && (match = pathname.match(/^\/w\/([^/]+)\/annotations\/([^/]+)\/withdraw$/))) {
    const slug = match[1] as string;
    const entryId = match[2] as string;
    return { routeClass: "state-changing", handle: () => withdraw(deps, slug, entryId, pathname) };
  }
  if (method === "GET" && (match = pathname.match(/^\/w\/([^/]+)\/diff$/))) {
    return { routeClass: "authed-read", handle: (req) => diff(deps, match![1] as string, req) };
  }
  if (method === "GET" && (match = pathname.match(/^\/w\/([^/]+)\/checkpoints$/))) {
    return { routeClass: "authed-read", handle: (req) => checkpoints(deps, match![1] as string, req) };
  }
  if (method === "POST" && (match = pathname.match(/^\/w\/([^/]+)\/restore$/))) {
    return { routeClass: "state-changing", handle: (req) => restore(deps, match![1] as string, req) };
  }
  if (method === "POST" && (match = pathname.match(/^\/w\/([^/]+)\/capability\/(.+)$/))) {
    return {
      routeClass: "state-changing",
      handle: () => mint(deps, match![1] as string, match![2] as string, pathname),
    };
  }
  return null;
}

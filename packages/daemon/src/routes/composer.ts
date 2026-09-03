// SPDX-License-Identifier: Apache-2.0

import {
  type ComposerDependencies,
  ComposerError,
  composerMessageStatus,
  sendComposerMessage,
} from "../services/composer.ts";
import { findWorkspace, WorkspaceLookupError } from "../services/workspace-access.ts";
import { internalErrorResponse, problem } from "../transport/problem.ts";
import type { RouteMatch } from "./types.ts";

const MESSAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function composerProblem(status: number, slug: string, title: string, instance: string, extra = {}): Response {
  return new Response(
    JSON.stringify({ type: `https://glosa.local/errors/${slug}`, title, status, instance, ...extra }),
    {
      status,
      headers: { "Content-Type": "application/problem+json" },
    },
  );
}

function mapError(error: unknown, pathname: string): Response {
  if (error instanceof WorkspaceLookupError) {
    return error.code === "not-found"
      ? problem(404, "not-found", "unknown workspace", undefined, pathname)
      : problem(409, "workspace-adopting", "workspace adoption is in progress", undefined, pathname);
  }
  if (!(error instanceof ComposerError)) throw error;
  switch (error.code) {
    case "idempotency-conflict":
      return composerProblem(409, error.code, "message_id already identifies a different message", pathname);
    case "no-bound-session":
      return composerProblem(404, error.code, "no live session is explicitly bound", pathname, error.data);
    case "bound-session-stale":
      return composerProblem(
        409,
        error.code,
        typeof error.data.title === "string" ? error.data.title : "the bound session is stale",
        pathname,
        error.data,
      );
    case "session-selection-required":
      return composerProblem(
        409,
        error.code,
        typeof error.data.title === "string" ? error.data.title : "choose a live bound session",
        pathname,
        error.data,
      );
    case "delivery-unavailable":
      return composerProblem(503, error.code, "delivery is unavailable for this provider", pathname, error.data);
    case "message-too-large":
      return composerProblem(
        400,
        "validation-failed",
        "message exceeds the 16 KiB delivery limit",
        pathname,
        error.data,
      );
    case "delivery-failed":
      return composerProblem(502, error.code, "the provider could not start delivery", pathname, error.data);
    case "message-not-found":
      return problem(404, "not-found", "conversation message not found", undefined, pathname);
    case "internal":
      return internalErrorResponse();
  }
}

async function send(deps: ComposerDependencies, slug: string, req: Request): Promise<Response> {
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
  if (typeof parsed?.text !== "string" || parsed.text.trim().length === 0) {
    return problem(400, "validation-failed", "text is required", undefined, pathname);
  }
  if (
    parsed.message_id !== undefined &&
    (typeof parsed.message_id !== "string" || !MESSAGE_ID.test(parsed.message_id))
  ) {
    return problem(400, "validation-failed", "message_id must be a UUID", undefined, pathname);
  }
  try {
    const result = await sendComposerMessage(deps, slug, {
      text: parsed.text,
      ...(typeof parsed.message_id === "string" ? { messageId: parsed.message_id } : {}),
      ...(typeof parsed.session_hint === "string" ? { sessionHint: parsed.session_hint } : {}),
    });
    return Response.json(result, { status: result.delivered ? 200 : 202 });
  } catch (error) {
    return mapError(error, pathname);
  }
}

async function status(deps: ComposerDependencies, slug: string, messageId: string, pathname: string) {
  if (!MESSAGE_ID.test(messageId)) {
    return problem(400, "validation-failed", "message_id must be a UUID", undefined, pathname);
  }
  try {
    return Response.json(await composerMessageStatus(deps, slug, messageId));
  } catch (error) {
    return mapError(error, pathname);
  }
}

export function composerRoutes(deps: ComposerDependencies, method: string, pathname: string): RouteMatch | null {
  let match: RegExpMatchArray | null;
  if (method === "POST" && (match = pathname.match(/^\/w\/([^/]+)\/transcript\/compose$/))) {
    const slug = match[1] as string;
    return { routeClass: "state-changing", handle: (req) => send(deps, slug, req) };
  }
  if (method === "GET" && (match = pathname.match(/^\/w\/([^/]+)\/transcript\/compose\/([^/]+)$/))) {
    const slug = match[1] as string;
    const messageId = match[2] as string;
    return { routeClass: "authed-read", handle: () => status(deps, slug, messageId, pathname) };
  }
  return null;
}

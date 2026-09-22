// SPDX-License-Identifier: Apache-2.0
// Claims over HTTP (issue #155, A1 §5.11f). Two surfaces with two different callers:
//
//   /api/workspaces/claims…      an AGENT session, path-addressed like apply-begin/resolve. `by` on
//                                a release is fixed to "session" by the route, never the body.
//   /w/:slug/claims/:id/release  the SPA — a PERSON. Origin-gated like every SPA write, and `by` is
//                                fixed to "human" by the route: this is the human-wins override,
//                                so it needs no session and is never refused.
//
// The route decides nothing a claim means; `WorkspaceBus` does. What lives here is input shape,
// and the one mapping from a bus refusal to a problem body that every claim-shaped refusal shares
// (`claimProblem`) — apply-begin and resolve use it too, so a caller meets the same `claim-held`
// body whichever route it tripped on.
import type { WorkspaceBus } from "../bus/bus.ts";
import type { ClaimHolderSnapshot, ClaimMode, Tombstone } from "../bus/claims.ts";
import { artifactResource } from "../bus/claims.ts";
import { problem } from "../transport/problem.ts";
import type { RouteMatch } from "./types.ts";

export interface ClaimRouteDependencies {
  /** Resolves a caller-supplied workspace path to its bus, through the same lifecycle guards every
   * other path-addressed route uses (adopting/forgetting refusals included). */
  busForPath(rawPath: string): Promise<WorkspaceBus>;
  /** The same, for the SPA's slug-addressed routes. */
  busForSlug(slug: string): Promise<WorkspaceBus>;
  /** The principal to record for `sessionId`'s claim (issue #155 REQ-9). */
  principalFor(sessionId: string, req: Request): string;
}

type Coded = Error & { code?: string };

function codeOf(error: unknown): string | undefined {
  return error instanceof Error ? (error as Coded).code : undefined;
}

function holderExtensions(claim: ClaimHolderSnapshot): Record<string, unknown> {
  return {
    claim_id: claim.claim_id,
    holder_session: claim.holder_session,
    holder_principal: claim.holder_principal,
    mode: claim.mode,
    since: claim.since,
    expires_at: claim.expires_at,
    fence: claim.fence,
  };
}

function tombstoneExtensions(tombstone: Tombstone): Record<string, unknown> {
  return {
    claim_id: tombstone.claim_id,
    holder_session: tombstone.holder_session,
    fence: tombstone.fence,
    ended_at: tombstone.ended_at,
    reason: tombstone.reason,
  };
}

/** The problem body for a claim-shaped bus refusal, or `null` when `error` is not one. Every 409
 * here stays a 409, so the CLI's exit-code contract for `resolve` (exit 8 on any entry error) is
 * unchanged; the difference is that the body now says who and why. Titles carry the next step,
 * because the CLI prints `title` and never `detail`. */
export function claimProblem(error: unknown, pathname: string): Response | null {
  const code = codeOf(error);
  switch (code) {
    case "CLAIM_HELD": {
      const claim = (error as Coded & { claim: ClaimHolderSnapshot }).claim;
      return problem(
        409,
        "claim-held",
        `session ${claim.holder_session} holds an ${claim.mode} claim on this until ${claim.expires_at}`,
        `claim ${claim.claim_id} (fence ${claim.fence ?? "none"}) since ${claim.since}`,
        pathname,
        holderExtensions(claim),
      );
    }
    case "CLAIM_REVOKED":
    case "CLAIM_EXPIRED":
    case "CLAIM_SUPERSEDED": {
      const tombstone = (error as Coded & { tombstone: Tombstone }).tombstone;
      const title =
        code === "CLAIM_REVOKED"
          ? tombstone.reason === "released_by_human"
            ? "a person took this over — your claim was released; re-read the file before doing anything else"
            : "your claim was released — claim it again to continue"
          : code === "CLAIM_EXPIRED"
            ? "your claim expired — re-run apply-begin (or claim), then resolve again"
            : "your claim was superseded — someone else holds this now; claim it again to see who";
      return problem(
        409,
        code === "CLAIM_REVOKED" ? "claim-revoked" : code === "CLAIM_EXPIRED" ? "claim-expired" : "claim-superseded",
        title,
        code === "CLAIM_EXPIRED"
          ? "past its TTL the claim could no longer prove its pre..post interval, so that interval was recorded as unknown rather than attributed to the session"
          : `claim ${tombstone.claim_id} ended at ${tombstone.ended_at} (${tombstone.reason})`,
        pathname,
        tombstoneExtensions(tombstone),
      );
    }
    case "ENTRY_RESOLVED": {
      const resolved = error as Coded & { terminalBy: string | null; status: string };
      return problem(
        409,
        "entry-resolved",
        `entry is already ${resolved.status}${resolved.terminalBy ? ` (by ${resolved.terminalBy})` : ""}`,
        undefined,
        pathname,
        // `entry_status`, not `status`: RFC 9457 reserves `status` for the HTTP status code.
        { terminal_by: resolved.terminalBy, entry_status: resolved.status },
      );
    }
    case "NO_CLAIM":
      return problem(
        409,
        "no-claim",
        "you hold no claim on this entry — run apply-begin (or claim) first so the change can be attributed",
        undefined,
        pathname,
      );
    case "CLAIM_LIMIT": {
      const limit = error as Coded & { scope: string; limit: number };
      return problem(409, "claim-limit", (error as Error).message, undefined, pathname, {
        scope: limit.scope,
        limit: limit.limit,
      });
    }
    case "UNKNOWN_ENTRY":
      return problem(
        404,
        "not-found",
        "this workspace has no such inbox entry — pass --workspace to name the one that owns it",
        undefined,
        pathname,
      );
    case "NO_SUCH_CLAIM":
      return problem(404, "not-found", "no such claim in this workspace", undefined, pathname);
    case "WORKSPACE_NOT_FOUND":
      return problem(404, "not-found", "unknown workspace", undefined, pathname);
    case "INVALID_WORKSPACE_PATH":
      return problem(400, "invalid-path", "path does not resolve to a real directory", undefined, pathname);
    case "INVALID_RESOURCE":
      return problem(
        400,
        "validation-failed",
        "resources must be entry:<id> or artifact:<workspace-relative path>",
        undefined,
        pathname,
      );
    default:
      return null;
  }
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function stringField(body: Record<string, unknown> | null, key: string): string | null {
  const value = body?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function take(deps: ClaimRouteDependencies, req: Request): Promise<Response> {
  const pathname = new URL(req.url).pathname;
  const body = await readBody(req);
  if (!body) return problem(400, "validation-failed", "body must be a JSON object", undefined, pathname);
  const path = stringField(body, "path");
  const session = stringField(body, "session");
  const resources = body.resources;
  if (
    !path ||
    !session ||
    !Array.isArray(resources) ||
    resources.length === 0 ||
    !resources.every((resource) => typeof resource === "string")
  ) {
    return problem(
      400,
      "validation-failed",
      "path, session, and a non-empty resources[] of strings are required",
      undefined,
      pathname,
    );
  }
  const mode = body.mode ?? "exclusive";
  if (mode !== "exclusive" && mode !== "presence") {
    return problem(400, "validation-failed", "mode must be exclusive or presence", undefined, pathname);
  }
  const ttl = body.ttl_ms;
  if (ttl !== undefined && (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl <= 0)) {
    return problem(400, "validation-failed", "ttl_ms must be a positive integer", undefined, pathname);
  }
  try {
    const bus = await deps.busForPath(path);
    const result = await bus.claim(resources as string[], mode as ClaimMode, session, deps.principalFor(session, req), {
      ...(typeof ttl === "number" ? { ttlMs: ttl } : {}),
    });
    return Response.json(
      {
        claim_id: result.claimId,
        fence: result.fence,
        expires_at: result.expiresAt,
        paths: result.paths,
        mode,
        renewed: result.renewed,
      },
      // A renewal is not a new resource, so it is not a 201.
      { status: result.renewed ? 200 : 201 },
    );
  } catch (error) {
    const mapped = claimProblem(error, pathname);
    if (mapped) return mapped;
    throw error;
  }
}

async function renew(deps: ClaimRouteDependencies, claimId: string, req: Request): Promise<Response> {
  const pathname = new URL(req.url).pathname;
  const body = await readBody(req);
  const path = stringField(body, "path");
  const session = stringField(body, "session");
  if (!path || !session) return problem(400, "validation-failed", "path and session are required", undefined, pathname);
  try {
    const bus = await deps.busForPath(path);
    const result = await bus.renew(claimId, session);
    return Response.json({ claim_id: result.claimId, fence: result.fence, expires_at: result.expiresAt });
  } catch (error) {
    const mapped = claimProblem(error, pathname);
    if (mapped) return mapped;
    throw error;
  }
}

async function releaseBySession(deps: ClaimRouteDependencies, claimId: string, req: Request): Promise<Response> {
  const pathname = new URL(req.url).pathname;
  const body = await readBody(req);
  const path = stringField(body, "path");
  const session = stringField(body, "session");
  if (!path || !session) return problem(400, "validation-failed", "path and session are required", undefined, pathname);
  try {
    const bus = await deps.busForPath(path);
    const result = await bus.release(claimId, "session", session);
    return Response.json({ claim_id: claimId, released: result.released });
  } catch (error) {
    const mapped = claimProblem(error, pathname);
    if (mapped) return mapped;
    throw error;
  }
}

async function releaseByHuman(deps: ClaimRouteDependencies, slug: string, claimId: string, req: Request) {
  const pathname = new URL(req.url).pathname;
  try {
    const bus = await deps.busForSlug(slug);
    const result = await bus.release(claimId, "human");
    return Response.json({
      claim_id: claimId,
      released: result.released,
      ...(result.claim ? { holder_session: result.claim.holder_session } : {}),
    });
  } catch (error) {
    const mapped = claimProblem(error, pathname);
    if (mapped) return mapped;
    throw error;
  }
}

async function list(deps: ClaimRouteDependencies, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.searchParams.get("path");
  if (!path) return problem(400, "validation-failed", "path query param is required", undefined, url.pathname);
  const artifact = url.searchParams.get("artifact") ?? undefined;
  let snapshot: Awaited<ReturnType<WorkspaceBus["listClaims"]>>;
  try {
    snapshot = await (await deps.busForPath(path)).listClaims(artifact);
  } catch (error) {
    const mapped = claimProblem(error, url.pathname);
    if (mapped) return mapped;
    throw error;
  }
  const { claims, tombstones } = snapshot;
  // Resource strings only: `artifact:<workspace-relative>` / `entry:<id>`. Never an absolute path —
  // a claim is about a workspace's files, not about where this machine keeps them.
  return Response.json({
    claims: claims.map((claim) => ({
      claim_id: claim.claim_id,
      resources: claim.resources,
      artifacts: claim.paths.map(artifactResource),
      mode: claim.mode,
      holder_session: claim.holder_session,
      holder_principal: claim.holder_principal,
      fence: claim.fence,
      since: claim.since,
      expires_at: claim.expires_at,
    })),
    tombstones: tombstones.map((tombstone) => ({
      resource: tombstone.resource,
      ...tombstoneExtensions(tombstone),
    })),
  });
}

export function claimRoutes(deps: ClaimRouteDependencies, method: string, pathname: string): RouteMatch | null {
  if (method === "POST" && pathname === "/api/workspaces/claims") {
    return { routeClass: "state-changing", handle: (req) => take(deps, req) };
  }
  if (method === "GET" && pathname === "/api/workspaces/claims") {
    return { routeClass: "authed-read", handle: (req) => list(deps, req) };
  }
  let match: RegExpMatchArray | null;
  if (method === "POST" && (match = pathname.match(/^\/api\/workspaces\/claims\/([^/]+)\/(renew|release)$/))) {
    const claimId = decodeURIComponent(match[1] as string);
    return match[2] === "renew"
      ? { routeClass: "state-changing", handle: (req) => renew(deps, claimId, req) }
      : { routeClass: "state-changing", handle: (req) => releaseBySession(deps, claimId, req) };
  }
  if (method === "POST" && (match = pathname.match(/^\/w\/([^/]+)\/claims\/([^/]+)\/release$/))) {
    const slug = match[1] as string;
    const claimId = decodeURIComponent(match[2] as string);
    return { routeClass: "state-changing", handle: (req) => releaseByHuman(deps, slug, claimId, req) };
  }
  return null;
}

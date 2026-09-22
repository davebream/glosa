// SPDX-License-Identifier: Apache-2.0
import { repairBaseline, shadowHealth, ShadowAccessError, type ShadowAccess } from "../services/shadow.ts";
import { WorkspaceLookupError } from "../services/workspace-access.ts";
import { problem, type ProblemSlug } from "../transport/problem.ts";
import type { RouteMatch } from "./types.ts";

export function shadowRoutes(deps: ShadowAccess, method: string, pathname: string): RouteMatch | null {
  const match = /^\/w\/([^/]+)\/shadow\/(health|repair-baseline)$/.exec(pathname);
  if (!match || (match[2] === "health" ? method !== "GET" : method !== "POST")) return null;
  const repair = match[2] === "repair-baseline";
  return {
    routeClass: repair ? "state-changing" : "authed-read",
    async handle(req) {
      try {
        if (repair) {
          const body = await req.text();
          let parsed: unknown;
          try {
            parsed = JSON.parse(body);
          } catch {
            parsed = null;
          }
          if (
            new TextEncoder().encode(body).length > 1024 ||
            !parsed ||
            typeof parsed !== "object" ||
            Array.isArray(parsed) ||
            Object.keys(parsed).length !== 0
          ) {
            return problem(
              400,
              "validation-failed",
              "repair requires an empty JSON object (at most 1024 bytes)",
              undefined,
              pathname,
            );
          }
        }
        return Response.json(await (repair ? repairBaseline(deps, match[1]!) : shadowHealth(deps, match[1]!)));
      } catch (error) {
        if (error instanceof WorkspaceLookupError)
          return problem(error.code === "not-found" ? 404 : 409, error.code, error.message, undefined, pathname);
        if (error instanceof ShadowAccessError) return problem(409, error.code, error.message, undefined, pathname);
        const code = (error as { code?: string }).code;
        const slugs: Record<string, ProblemSlug> = {
          SHADOW_HISTORY_LOST: "shadow-history-lost",
          SHADOW_INVALID_HEAD: "shadow-invalid-head",
          SHADOW_REPAIR_PENDING: "shadow-repair-pending",
          SHADOW_NOT_OWNER: "shadow-not-owner",
          SHADOW_ALREADY_HEALTHY: "shadow-already-healthy",
          SHADOW_REPAIR_ID_CONFLICT: "shadow-repair-id-conflict",
          CLAIM_HELD: "claim-held",
          WORKSPACE_ADOPTED: "workspace-adopted",
          WORKSPACE_FORGOTTEN: "workspace-forgetting",
        };
        if (code && slugs[code]) return problem(409, slugs[code]!, (error as Error).message, undefined, pathname);
        throw error;
      }
    },
  };
}

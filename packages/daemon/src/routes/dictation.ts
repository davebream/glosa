// SPDX-License-Identifier: Apache-2.0

import { DictationProviderError, type DictationProviderRegistry } from "../dictation/interface.ts";
import { problem } from "../transport/problem.ts";
import type { RouteMatch } from "./types.ts";

export interface DictationRouteDependencies {
  registry?: DictationProviderRegistry;
}

function noStoreJson(body: unknown): Response {
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}

function mapError(error: unknown, pathname: string): Response {
  if (!(error instanceof DictationProviderError)) throw error;
  switch (error.code) {
    case "unconfigured":
      return problem(409, "dictation-unconfigured", "dictation is not configured", undefined, pathname);
    case "credential-unavailable":
      return problem(
        503,
        "dictation-credential-unavailable",
        "the configured dictation credential is unavailable",
        undefined,
        pathname,
      );
    case "authentication-failed":
      return problem(
        502,
        "dictation-authentication-failed",
        "the dictation provider rejected the configured credential",
        undefined,
        pathname,
      );
    case "rate-limited":
      return problem(
        429,
        "dictation-rate-limited",
        "the dictation provider is rate limiting requests",
        undefined,
        pathname,
      );
    case "timeout":
      return problem(504, "dictation-timeout", "the dictation provider did not respond in time", undefined, pathname);
    case "invalid-response":
      return problem(
        502,
        "dictation-invalid-response",
        "the dictation provider returned an invalid response",
        undefined,
        pathname,
      );
    case "provider-unavailable":
      return problem(
        502,
        "dictation-provider-unavailable",
        "the dictation provider is unavailable",
        undefined,
        pathname,
      );
  }
}

async function status(deps: DictationRouteDependencies): Promise<Response> {
  return noStoreJson(deps.registry ? await deps.registry.status() : { state: "unconfigured" });
}

async function createSession(
  deps: DictationRouteDependencies,
  pathname: string,
  signal?: AbortSignal,
): Promise<Response> {
  if (!deps.registry) {
    return problem(409, "dictation-unconfigured", "dictation is not configured", undefined, pathname);
  }
  try {
    return noStoreJson(await deps.registry.createSession(signal));
  } catch (error) {
    return mapError(error, pathname);
  }
}

export function dictationRoutes(deps: DictationRouteDependencies, method: string, pathname: string): RouteMatch | null {
  if (method === "GET" && pathname === "/api/dictation/status") {
    return { routeClass: "authed-read", handle: () => status(deps) };
  }
  if (method === "POST" && pathname === "/api/dictation/session") {
    return {
      routeClass: "state-changing",
      handle: (_req, _server, authSignal) => createSession(deps, pathname, authSignal),
    };
  }
  return null;
}

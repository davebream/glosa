// SPDX-License-Identifier: Apache-2.0
import {
  DICTATION_AUDIO_LIMIT,
  DICTATION_CONTEXT_LIMIT,
  DictationProviderError,
  DictationProviderRegistry,
} from "../dictation/interface.ts";
import { problem } from "../transport/problem.ts";
import type { RouteMatch } from "./types.ts";
const messages = {
  unconfigured: "Set up dictation in Settings.",
  "credential-unavailable":
    "Secure storage is unavailable. Unlock it and retry. Dictation settings can be refreshed in Settings.",
  "authentication-failed": "The dictation provider rejected the API key. Replace it in Settings.",
  "rate-limited": "The dictation provider is rate limiting requests. Try again later.",
  "quota-exceeded": "The provider API account has no available quota. Check API billing.",
  "model-unavailable": "This API key cannot access the transcription model.",
  timeout: "The dictation provider took too long to respond. Your draft is unchanged.",
  "provider-unavailable": "The dictation provider is unavailable. Your draft is unchanged.",
  "invalid-response": "The dictation provider returned an invalid transcript.",
  "invalid-input": "The recording or dictation settings are invalid.",
  "stale-settings": "Dictation settings changed. Refresh and try again.",
  busy: "Dictation is already processing a recording. Try again when it finishes.",
  cancelled: "Dictation was cancelled.",
};
export function dictationRoutes(
  deps: { registry?: DictationProviderRegistry; shutdownSignal?: AbortSignal },
  method: string,
  pathname: string,
): RouteMatch | null {
  if (
    !(
      (pathname === "/api/dictation/status" && method === "GET") ||
      (pathname === "/api/dictation/settings" && ["GET", "PUT", "DELETE"].includes(method)) ||
      (pathname === "/api/dictation/transcribe" && method === "POST")
    )
  )
    return null;
  const registry = deps.registry ?? new DictationProviderRegistry();
  return {
    routeClass: method === "GET" ? "authed-read" : "state-changing",
    bodyLimit: pathname.endsWith("/transcribe") ? DICTATION_AUDIO_LIMIT + 65536 : 16384,
    async handle(req, server, authSignal) {
      const signal = AbortSignal.any(
        [req.signal, authSignal, deps.shutdownSignal].filter((value): value is AbortSignal => !!value),
      );
      try {
        let result: unknown;
        if (method === "GET")
          result = pathname.endsWith("/status") ? await registry.status() : await registry.settings();
        else if (pathname.endsWith("/settings")) {
          const input = await req.json().catch(() => null);
          if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.revision !== "string")
            throw new DictationProviderError("invalid-input");
          if (
            Object.keys(input).some(
              (key) => !["enabled", "context", "cleanup", "revision", "consent_version", "api_key"].includes(key),
            ) ||
            (input.api_key !== undefined && typeof input.api_key !== "string")
          )
            throw new DictationProviderError("invalid-input");
          result =
            method === "DELETE" ? await registry.remove(input.revision, signal) : await registry.update(input, signal);
        } else {
          server?.timeout(req, 0);
          const form = await req.formData().catch(() => null);
          if (
            !form ||
            [...form.keys()].some(
              (key) => !["audio", "context", "revision"].includes(key) || form.getAll(key).length !== 1,
            )
          )
            throw new DictationProviderError("invalid-input");
          const audio = form.get("audio"),
            context = form.get("context"),
            revision = form.get("revision");
          if (
            !audio ||
            typeof audio === "string" ||
            !audio.size ||
            audio.size > DICTATION_AUDIO_LIMIT ||
            typeof revision !== "string" ||
            (context !== null && typeof context !== "string") ||
            new TextEncoder().encode(context ?? "").length > DICTATION_CONTEXT_LIMIT
          )
            throw new DictationProviderError("invalid-input");
          const bytes = new Uint8Array(await audio.arrayBuffer());
          const webm =
            bytes.length > 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
          const mp4 = bytes.length > 12 && new TextDecoder().decode(bytes.subarray(4, 8)) === "ftyp";
          if (!webm && !mp4) throw new DictationProviderError("invalid-input");
          result = await registry.transcribe({
            audio: bytes,
            mediaType: webm ? "audio/webm" : "audio/mp4",
            context: context ?? undefined,
            revision,
            signal,
          });
        }
        return Response.json(result, { headers: { "Cache-Control": "no-store" } });
      } catch (error) {
        const code = error instanceof DictationProviderError ? error.code : "provider-unavailable";
        const status =
          code === "invalid-input"
            ? 400
            : code === "timeout"
              ? 504
              : code === "rate-limited"
                ? 429
                : ["unconfigured", "stale-settings", "busy", "cancelled"].includes(code)
                  ? 409
                  : code === "credential-unavailable"
                    ? 503
                    : 502;
        const response = problem(status, `dictation-${code}`, messages[code], undefined, pathname);
        response.headers.set("Cache-Control", "no-store");
        return response;
      }
    },
  };
}

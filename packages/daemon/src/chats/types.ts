// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

export const chatFailureSchema = z
  .object({
    code: z.string().min(1).max(100),
    category: z.enum([
      "authentication",
      "configuration",
      "quota",
      "permission",
      "transport",
      "runtime",
      "protocol",
      "storage",
    ]),
    phase: z.enum(["connecting", "preparing", "dispatching", "running", "waiting", "stopping"]),
    title: z.string().min(1).max(500),
    detail: z.string().max(2000).optional(),
    dispatchCertainty: z.enum(["unsent", "submitted", "confirmed_terminal", "unknown"]),
    recoveryAction: z.enum(["retry", "sign_in", "change_settings", "retry_stop", "none"]),
  })
  .strict();

export type ChatFailure = z.infer<typeof chatFailureSchema>;
export type ChatFailurePhase = ChatFailure["phase"];

/** Keep actionable error text without persisting stacks, login URLs or recognizable credentials. */
function safeText(value: string, limit: number, secrets: readonly string[]): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Removing terminal escapes and controls is this boundary's purpose.
  let text = value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
  for (const secret of secrets) if (secret) text = text.replaceAll(secret, "[redacted]");
  text = text
    .replace(/https?:\/\/[^\s<>"']+/gi, (raw) => {
      try {
        const url = new URL(raw);
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return url.toString();
      } catch {
        return "[redacted URL]";
      }
    })
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, "[redacted]")
    .replace(
      /\b((?:[A-Z_]*API_KEY|[A-Z_]*AUTH_TOKEN|access_token|refresh_token|client_secret|password|authorization)\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi,
      "$1[redacted]",
    );
  return text.trim().slice(0, limit);
}

export function chatFailure(
  error: unknown,
  options: {
    phase: ChatFailurePhase;
    dispatchCertainty: ChatFailure["dispatchCertainty"];
    code?: string;
    fallback?: string;
    secrets?: readonly string[];
  },
): ChatFailure {
  const object = error && typeof error === "object" ? (error as Record<string, unknown>) : undefined;
  const rawCode = options.code ?? (typeof object?.code === "string" ? object.code : "agent-operation-failed");
  const code = /^[a-z0-9_-]{1,100}$/i.test(rawCode) ? rawCode : "agent-operation-failed";
  const secrets = options.secrets ?? [];
  const title =
    safeText(
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : (options.fallback ?? "The agent operation failed."),
      500,
      secrets,
    ) ||
    options.fallback ||
    "The agent operation failed.";
  const details: string[] = [];
  const seen = new Set<object>();
  let cause = object;
  for (let depth = 0; cause && depth < 4 && !seen.has(cause); depth++) {
    seen.add(cause);
    const data = cause.data && typeof cause.data === "object" ? (cause.data as Record<string, unknown>) : undefined;
    if (typeof data?.details === "string") details.push(data.details);
    if (typeof cause.details === "string") details.push(cause.details);
    if (typeof cause.cause === "string") details.push(cause.cause);
    if (cause.cause instanceof Error) {
      details.push(cause.cause.message);
      cause = cause.cause as unknown as Record<string, unknown>;
    } else break;
  }
  const detail = safeText(details.join("\n"), 2000, secrets);
  const category: ChatFailure["category"] = /auth|login|credential|account-mismatch|identity/.test(code)
    ? "authentication"
    : /quota|rate.limit|limit.exceeded/.test(code)
      ? "quota"
      : /storage|journal|event-too-large/.test(code)
        ? "storage"
        : /unsupported|configuration|tools-unavailable|stale-reference/.test(code)
          ? "configuration"
          : /permission|denied/.test(code)
            ? "permission"
            : /disconnect|connection|transport|timeout/.test(code)
              ? "transport"
              : /protocol|invalid.event/.test(code)
                ? "protocol"
                : "runtime";
  return {
    code,
    category,
    phase: options.phase,
    title,
    ...(detail && detail !== title ? { detail } : {}),
    dispatchCertainty: options.dispatchCertainty,
    recoveryAction:
      category === "authentication"
        ? "sign_in"
        : options.phase === "stopping"
          ? "retry_stop"
          : category === "configuration"
            ? "change_settings"
            : category === "storage"
              ? "none"
              : "retry",
  };
}

// SPDX-License-Identifier: Apache-2.0
/** Provider diagnostics are untrusted. Preserve useful structured causes without auth payloads. */
export function providerFailureDetails(error: unknown, secrets: readonly string[] = []): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = error as {
    message?: unknown;
    details?: unknown;
    additionalDetails?: unknown;
    data?: { details?: unknown };
    errors?: unknown;
  };
  const source = value.data?.details ?? value.details ?? value.additionalDetails ?? value.errors ?? value.message;
  if (source == null) return undefined;
  let result: string;
  try {
    result = typeof source === "string" ? source : JSON.stringify(source);
  } catch {
    return undefined;
  }
  if (!result) return undefined;
  for (const secret of secrets) if (secret.length >= 4) result = result.split(secret).join("[redacted]");
  result = Array.from(result)
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code !== 127 && (code >= 32 || code === 9 || code === 10 || code === 13);
    })
    .join("");
  return result
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [redacted]")
    .replace(
      /((?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|password|secret|GLOSA_MANAGED_MCP_GRANT)["']?\s*[:=]\s*["']?)[^\s,"'}]+/giu,
      "$1[redacted]",
    )
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted]")
    .replace(/\u2014/gu, ":")
    .slice(0, 16000);
}

export function providerEnvironmentSecrets(environment: Readonly<Record<string, string>>): string[] {
  return Object.entries(environment)
    .filter(([key]) => /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|GRANT/iu.test(key))
    .map(([, value]) => value);
}

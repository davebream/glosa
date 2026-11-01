// SPDX-License-Identifier: Apache-2.0
import type { ManagedOAuthFailure } from "../../../../daemon/src/agents/oauth-interface.ts";
const MESSAGES: Record<ManagedOAuthFailure, string> = {
  cancelled: "Sign-in was cancelled.",
  expired: "Sign-in expired. Start again.",
  "access-denied": "ChatGPT sign-in was declined.",
  "invalid-response": "ChatGPT returned an invalid sign-in response. Start again.",
  "identity-mismatch": "The signed-in identity differs from the selected account.",
  "secure-storage": "Secure credential storage is unavailable. Check your desktop wallet and retry.",
  network: "ChatGPT could not be reached. Retry when ready.",
  "reauth-required": "Sign in to ChatGPT again before continuing.",
  "invalid-client": "The ChatGPT client registration was rejected.",
  "plan-disabled": "ChatGPT plan usage is not enabled for this account.",
  busy: "An account operation is already in progress. Retry when it finishes.",
  "not-found": "The ChatGPT account or sign-in attempt was not found.",
};
export class OAuthBrokerError extends Error {
  constructor(readonly code: ManagedOAuthFailure) {
    super(MESSAGES[code]);
    this.name = "OAuthBrokerError";
  }
}

export function safeFailure(error: unknown): ManagedOAuthFailure {
  if (error instanceof OAuthBrokerError) return error.code;
  if (error instanceof Error && error.cause instanceof OAuthBrokerError) return error.cause.code;
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    ["OAUTH_TIMEOUT", "OAUTH_ABORT"].includes(String(error.code))
  )
    return "network";
  if (error && typeof error === "object" && "name" in error && error.name === "CredentialStoreError")
    return "secure-storage";
  if (error && typeof error === "object" && "error" in error) {
    const code = error.error;
    if (code === "invalid_client") return "invalid-client";
    if (
      [
        "invalid_grant",
        "invalid_refresh_token",
        "token_expired",
        "refresh_token_expired",
        "refresh_token_invalidated",
        "refresh_token_reused",
      ].includes(String(code))
    )
      return "reauth-required";
    if (code === "access_denied") return "access-denied";
  }
  if (
    error instanceof TypeError ||
    (error &&
      typeof error === "object" &&
      "name" in error &&
      ["TimeoutError", "AbortError"].includes(String(error.name)))
  )
    return "network";
  return "invalid-response";
}

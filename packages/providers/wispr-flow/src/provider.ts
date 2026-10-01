// SPDX-License-Identifier: Apache-2.0

import { fileURLToPath } from "node:url";
import {
  type DictationAvailability,
  type DictationProvider,
  DictationProviderError,
  type DictationSessionGrant,
} from "../../../daemon/src/index.ts";
import { readWisprFlowConfig } from "./config.ts";
import type { WisprFlowCredentialStore } from "./keychain.ts";
import { createCredentialStore } from "./credentials.ts";
import { CredentialStoreError } from "./secret-service.ts";

export const WISPR_FLOW_TOKEN_URL = "https://platform-api.wisprflow.ai/api/v1/dash/generate_access_token";
export const WISPR_FLOW_WEBSOCKET_URL = "wss://platform-api.wisprflow.ai/api/v1/dash/client_ws";
export const WISPR_FLOW_ORIGIN = "wss://platform-api.wisprflow.ai";
export const WISPR_FLOW_TOKEN_TTL_SECONDS = 600;
export const WISPR_FLOW_TOKEN_TIMEOUT_MS = 10_000;

interface TokenResponse {
  access_token: string;
  expires_in?: number;
}

export interface WisprFlowProviderDeps {
  home: string;
  credentialStore?: WisprFlowCredentialStore;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  allowDevelopmentEnv?: boolean;
  env?: Record<string, string | undefined>;
  now?: () => number;
  tokenTimeoutMs?: number;
}

function normalizedCredential(value: string | null): string | null {
  const trimmed = value?.trim().replace(/^Bearer\s+/i, "") ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function expiry(expiresIn: number | undefined, now: number): string {
  const seconds =
    typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0
      ? expiresIn
      : WISPR_FLOW_TOKEN_TTL_SECONDS;
  return new Date(now + seconds * 1000).toISOString();
}

export class WisprFlowProvider implements DictationProvider {
  readonly id = "wispr-flow";
  readonly displayName = "Wispr Flow";
  readonly clientModule = "/app/providers/wispr-flow/browser.js";
  private readonly credentialStore: WisprFlowCredentialStore;
  private readonly fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  private readonly env: Record<string, string | undefined>;
  private readonly now: () => number;

  constructor(private readonly deps: WisprFlowProviderDeps) {
    this.credentialStore = deps.credentialStore ?? createCredentialStore();
    this.fetchImpl = deps.fetch ?? fetch;
    this.env = deps.env ?? Bun.env;
    this.now = deps.now ?? Date.now;
  }

  isEnabled(): boolean {
    const result = readWisprFlowConfig(this.deps.home);
    return result.state === "configured" && result.config.enabled;
  }

  connectOrigins(): readonly string[] {
    return [WISPR_FLOW_ORIGIN];
  }

  browserAssets() {
    return [
      {
        route: this.clientModule,
        filePath: fileURLToPath(new URL("./browser.js", import.meta.url)),
        contentType: "text/javascript; charset=utf-8",
      },
      {
        route: "/app/providers/wispr-flow/wispr-flow-worklet.js",
        filePath: fileURLToPath(new URL("./wispr-flow-worklet.js", import.meta.url)),
        contentType: "text/javascript; charset=utf-8",
      },
    ] as const;
  }

  private configured() {
    const result = readWisprFlowConfig(this.deps.home);
    if (result.state !== "configured" || !result.config.enabled) {
      throw new DictationProviderError(
        result.state === "invalid" ? "provider-unavailable" : "unconfigured",
        result.state === "invalid" ? result.message : "dictation is not configured",
      );
    }
    return result.config;
  }

  private async credential(account: string, signal?: AbortSignal): Promise<string | null> {
    if (this.deps.allowDevelopmentEnv && this.env.GLOSA_WISPR_FLOW_ALLOW_ENV_KEY === "1") {
      const development = normalizedCredential(this.env.WISPR_FLOW_API_KEY ?? null);
      if (development) return development;
    }
    return normalizedCredential(await this.credentialStore.read(account, signal));
  }

  async status(): Promise<DictationAvailability> {
    const result = readWisprFlowConfig(this.deps.home);
    if (result.state === "missing" || (result.state === "configured" && !result.config.enabled)) {
      return { state: "unconfigured" };
    }
    if (result.state === "invalid") {
      return {
        state: "error",
        provider: this.id,
        display_name: this.displayName,
        code: "provider-unavailable",
        message: "dictation configuration is invalid or requires renewed consent",
      };
    }
    const developmentCredential =
      this.deps.allowDevelopmentEnv &&
      this.env.GLOSA_WISPR_FLOW_ALLOW_ENV_KEY === "1" &&
      normalizedCredential(this.env.WISPR_FLOW_API_KEY ?? null);
    let unavailable: string | undefined;
    try {
      if (!developmentCredential && !(await this.credentialStore.has(result.config.keychain_account))) {
        unavailable =
          "the Wispr Flow organization key is unavailable; run glosa dictation configure --provider wispr-flow";
      }
    } catch (error) {
      unavailable = error instanceof CredentialStoreError ? error.message : "the credential store is unavailable";
    }
    if (unavailable) {
      return {
        state: "error",
        provider: this.id,
        display_name: this.displayName,
        code: "credential-unavailable",
        message: unavailable,
      };
    }
    return {
      state: "ready",
      provider: this.id,
      display_name: this.displayName,
      client_module: this.clientModule,
    };
  }

  async createSession(signal?: AbortSignal): Promise<DictationSessionGrant> {
    signal?.throwIfAborted();
    const config = this.configured();
    let credential: string | null;
    try {
      credential = await this.credential(config.keychain_account, signal);
    } catch (error) {
      signal?.throwIfAborted();
      throw new DictationProviderError(
        "credential-unavailable",
        error instanceof CredentialStoreError ? error.message : "the credential store is unavailable",
      );
    }
    signal?.throwIfAborted();
    if (!credential) throw new DictationProviderError("credential-unavailable", "organization key unavailable");

    const timeout = AbortSignal.timeout(this.deps.tokenTimeoutMs ?? WISPR_FLOW_TOKEN_TIMEOUT_MS);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.fetchImpl(WISPR_FLOW_TOKEN_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${credential}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ client_id: config.client_id, duration_secs: WISPR_FLOW_TOKEN_TTL_SECONDS }),
        signal: requestSignal,
      });
    } catch (error) {
      if (timeout.aborted && !signal?.aborted)
        throw new DictationProviderError("timeout", "access-token request timed out");
      if (signal?.aborted) throw error;
      throw new DictationProviderError("provider-unavailable", "access-token request failed");
    }

    if (response.status === 401 || response.status === 403) {
      throw new DictationProviderError("authentication-failed", "organization key was rejected");
    }
    if (response.status === 429)
      throw new DictationProviderError("rate-limited", "access-token request was rate limited");
    if (!response.ok) throw new DictationProviderError("provider-unavailable", "access-token request failed");

    let body: TokenResponse;
    try {
      body = (await response.json()) as TokenResponse;
    } catch {
      throw new DictationProviderError("invalid-response", "access-token response was not JSON");
    }
    if (typeof body.access_token !== "string" || body.access_token.trim().length === 0) {
      throw new DictationProviderError("invalid-response", "access-token response omitted the token");
    }
    return {
      provider: this.id,
      websocket_url: WISPR_FLOW_WEBSOCKET_URL,
      access_token: body.access_token,
      expires_at: expiry(body.expires_in, this.now()),
    };
  }
}

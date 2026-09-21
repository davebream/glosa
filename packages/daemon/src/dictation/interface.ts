// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — provider-neutral dictation boundary. Dictation is an input capability, not an
// agent-delivery provider: the daemon knows availability/session grants, while provider packages
// own credentials, external endpoints, and browser wire protocols.

export type DictationAvailability =
  | { state: "unconfigured" }
  | {
      state: "ready";
      provider: string;
      display_name: string;
      client_module: string;
    }
  | {
      state: "error";
      provider: string;
      display_name: string;
      code: string;
      message: string;
    };

export interface DictationSessionGrant {
  provider: string;
  websocket_url: string;
  access_token: string;
  expires_at: string;
}

export interface DictationBrowserAsset {
  route: string;
  filePath: string;
  contentType: string;
}

export type DictationProviderErrorCode =
  | "unconfigured"
  | "credential-unavailable"
  | "authentication-failed"
  | "rate-limited"
  | "timeout"
  | "provider-unavailable"
  | "invalid-response";

export class DictationProviderError extends Error {
  constructor(
    readonly code: DictationProviderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DictationProviderError";
  }
}

export interface DictationProvider {
  id: string;
  displayName: string;
  clientModule: string;
  /** Pure local configuration check used to construct CSP. It must never contact the provider. */
  isEnabled(): boolean;
  /** Exact external origins the browser adapter may connect to after foreground activation. */
  connectOrigins(): readonly string[];
  /** Local-only availability check. Credential presence is allowed; provider liveness is not. */
  status(): Promise<DictationAvailability>;
  /** The only daemon-side external call: mint a short-lived client credential. */
  createSession(signal?: AbortSignal): Promise<DictationSessionGrant>;
  browserAssets(): readonly DictationBrowserAsset[];
}

/** Generic provider lookup. An empty registry is the supported zero-dictation core. */
export class DictationProviderRegistry {
  private readonly providers = new Map<string, DictationProvider>();

  register(provider: DictationProvider): void {
    if (this.providers.has(provider.id)) throw new Error(`dictation provider already registered: ${provider.id}`);
    this.providers.set(provider.id, provider);
  }

  get(id: string): DictationProvider | undefined {
    return this.providers.get(id);
  }

  list(): readonly DictationProvider[] {
    return [...this.providers.values()];
  }

  private enabled(): DictationProvider | undefined {
    return this.list().find((provider) => provider.isEnabled());
  }

  async status(): Promise<DictationAvailability> {
    for (const provider of this.providers.values()) {
      const status = await provider.status();
      if (status.state !== "unconfigured") return status;
    }
    return { state: "unconfigured" };
  }

  async createSession(signal?: AbortSignal): Promise<DictationSessionGrant> {
    const provider = this.enabled();
    if (!provider) throw new DictationProviderError("unconfigured", "dictation is not configured");
    return provider.createSession(signal);
  }

  enabledConnectOrigins(): readonly string[] {
    return [
      ...new Set(
        this.list()
          .filter((provider) => provider.isEnabled())
          .flatMap((provider) => provider.connectOrigins()),
      ),
    ];
  }

  browserAsset(route: string): DictationBrowserAsset | undefined {
    for (const provider of this.providers.values()) {
      const asset = provider.browserAssets().find((candidate) => candidate.route === route);
      if (asset) return asset;
    }
    return undefined;
  }
}

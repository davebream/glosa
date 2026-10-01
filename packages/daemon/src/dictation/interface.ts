// SPDX-License-Identifier: Apache-2.0
export const DICTATION_CONTEXT_LIMIT = 8192;
export const DICTATION_AUDIO_LIMIT = 12 * 1024 * 1024;
export const DICTATION_CONSENT_VERSION = 1;
export interface DictationSettings {
  enabled: boolean;
  context: boolean;
  cleanup: boolean;
  credential_present: boolean;
  /** Metadata lookup failed; configured toggles/revision remain available for disabling. */
  credential_error?: string;
  revision: string;
  consent_version: number;
}
export interface DictationSettingsUpdate {
  enabled: boolean;
  context: boolean;
  cleanup: boolean;
  revision: string;
  consent_version: number;
  api_key?: string;
}
export type DictationAvailability = DictationSettings & {
  state: "ready" | "unconfigured" | "error";
  message?: string;
};
export interface DictationInput {
  audio: Uint8Array;
  mediaType: "audio/webm" | "audio/mp4";
  context?: string;
  revision: string;
  signal: AbortSignal;
}
export interface DictationResult {
  text: string;
  cleanup: "off" | "applied" | "failed";
}
export type DictationProviderErrorCode =
  | "unconfigured"
  | "credential-unavailable"
  | "authentication-failed"
  | "rate-limited"
  | "quota-exceeded"
  | "model-unavailable"
  | "timeout"
  | "provider-unavailable"
  | "invalid-response"
  | "invalid-input"
  | "stale-settings"
  | "busy"
  | "cancelled";
export class DictationProviderError extends Error {
  constructor(
    readonly code: DictationProviderErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = "DictationProviderError";
  }
}
export interface DictationProvider {
  id: string;
  status(): Promise<DictationAvailability>;
  settings(): Promise<DictationSettings>;
  update(settings: DictationSettingsUpdate, signal?: AbortSignal): Promise<DictationSettings>;
  remove(revision: string, signal?: AbortSignal): Promise<DictationSettings>;
  transcribe(input: DictationInput): Promise<DictationResult>;
  dispose(): void;
}
export const EMPTY_DICTATION_SETTINGS: DictationSettings = {
  enabled: false,
  context: true,
  cleanup: false,
  credential_present: false,
  revision: "unconfigured",
  consent_version: DICTATION_CONSENT_VERSION,
};
export class DictationProviderRegistry {
  private readonly providers = new Map<string, DictationProvider>();
  register(provider: DictationProvider): void {
    if (this.providers.has(provider.id)) throw new Error(`dictation provider already registered: ${provider.id}`);
    this.providers.set(provider.id, provider);
  }
  get(id: string) {
    return this.providers.get(id);
  }
  list() {
    return [...this.providers.values()];
  }
  private configured(): DictationProvider {
    const provider = this.list()[0];
    if (!provider) throw new DictationProviderError("unconfigured");
    return provider;
  }
  async status(): Promise<DictationAvailability> {
    return this.list()[0]?.status() ?? { ...EMPTY_DICTATION_SETTINGS, state: "unconfigured" };
  }
  async settings(): Promise<DictationSettings> {
    return this.list()[0]?.settings() ?? { ...EMPTY_DICTATION_SETTINGS };
  }
  update(settings: DictationSettingsUpdate, signal?: AbortSignal) {
    return this.configured().update(settings, signal);
  }
  remove(revision: string, signal?: AbortSignal) {
    return this.configured().remove(revision, signal);
  }
  transcribe(input: DictationInput) {
    return this.configured().transcribe(input);
  }
  dispose() {
    for (const provider of this.providers.values()) provider.dispose();
  }
}

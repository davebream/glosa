// SPDX-License-Identifier: Apache-2.0
import { MacKeychainCredentialStore, type OpenAIDictationCredentialStore } from "./keychain.ts";
import { LinuxSecretServiceCredentialStore } from "./secret-service.ts";

export function createCredentialStore(platform: NodeJS.Platform = process.platform): OpenAIDictationCredentialStore {
  if (platform === "darwin") return new MacKeychainCredentialStore();
  return new LinuxSecretServiceCredentialStore({ platform });
}

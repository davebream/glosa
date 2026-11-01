// SPDX-License-Identifier: Apache-2.0
import { MacKeychainCredentialStore, type SecureCredentialStore } from "./keychain.ts";
import { LinuxSecretServiceCredentialStore } from "./secret-service.ts";
export { MacKeychainCredentialStore, type SecureCredentialStore } from "./keychain.ts";
export * from "./secret-service.ts";
export function createSecureCredentialStore(options: {
  service: string;
  label: string;
  platform?: NodeJS.Platform;
}): SecureCredentialStore {
  const platform = options.platform ?? process.platform;
  if (platform === "darwin") return new MacKeychainCredentialStore(options);
  return new LinuxSecretServiceCredentialStore({ ...options, platform });
}

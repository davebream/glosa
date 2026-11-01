// SPDX-License-Identifier: Apache-2.0
import { MacKeychainCredentialStore as SecureMacKeychainCredentialStore } from "../../shared-credentials/src/keychain.ts";
export type { SecureCredentialStore as OpenAIDictationCredentialStore } from "../../shared-credentials/src/keychain.ts";
export const OPENAI_DICTATION_KEYCHAIN_SERVICE = "ai.glosa.dictation.openai";
export class MacKeychainCredentialStore extends SecureMacKeychainCredentialStore {
  constructor() {
    super({ service: OPENAI_DICTATION_KEYCHAIN_SERVICE });
  }
}

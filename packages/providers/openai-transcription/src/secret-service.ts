// SPDX-License-Identifier: Apache-2.0
import { LinuxSecretServiceCredentialStore as SecureLinuxCredentialStore } from "../../shared-credentials/src/secret-service.ts";
import { OPENAI_DICTATION_KEYCHAIN_SERVICE } from "./keychain.ts";
export {
  CredentialStoreError,
  credentialHelperEnv,
  runCredentialHelper,
  type CredentialFailure,
  type CredentialHelperRequest,
  type CredentialHelperResult,
} from "../../shared-credentials/src/secret-service.ts";
export class LinuxSecretServiceCredentialStore extends SecureLinuxCredentialStore {
  constructor(
    deps: Omit<
      ConstructorParameters<typeof SecureLinuxCredentialStore>[0],
      "service" | "label" | "maxSecretBytes"
    > = {},
  ) {
    super({
      ...deps,
      service: OPENAI_DICTATION_KEYCHAIN_SERVICE,
      label: "Glosa OpenAI dictation",
      maxSecretBytes: 8192,
    });
  }
}

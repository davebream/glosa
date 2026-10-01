// SPDX-License-Identifier: Apache-2.0
import { credentialHelperEnv, CredentialStoreError, runCredentialHelper } from "./secret-service.ts";
export const OPENAI_DICTATION_KEYCHAIN_SERVICE = "ai.glosa.dictation.openai";
export interface OpenAIDictationCredentialStore {
  has(account: string, signal?: AbortSignal): Promise<boolean>;
  read(account: string, signal?: AbortSignal): Promise<string | null>;
  write(account: string, secret: string, signal?: AbortSignal): Promise<void>;
  remove(account: string, options?: { interactive?: boolean; signal?: AbortSignal }): Promise<boolean>;
}
export class MacKeychainCredentialStore implements OpenAIDictationCredentialStore {
  private command(action: string, account: string, reveal = false) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(account))
      throw new CredentialStoreError("invalid");
    return [
      "/usr/bin/security",
      action,
      "-s",
      OPENAI_DICTATION_KEYCHAIN_SERVICE,
      "-a",
      account,
      ...(reveal ? ["-w"] : []),
    ];
  }
  private run(argv: string[], signal?: AbortSignal, input?: string) {
    return runCredentialHelper({
      argv,
      signal,
      input,
      env: credentialHelperEnv(process.env),
      interactive: false,
      timeoutMs: 15_000,
    });
  }
  async has(account: string, signal?: AbortSignal) {
    const result = await this.run(this.command("find-generic-password", account), signal);
    if (result.code === 44) return false;
    if (result.code !== 0) throw new CredentialStoreError("unavailable");
    return true;
  }
  async read(account: string, signal?: AbortSignal) {
    const result = await this.run(this.command("find-generic-password", account, true), signal);
    if (result.code === 44) return null;
    if (result.code !== 0) throw new CredentialStoreError("denied");
    return result.stdout.trim() || null;
  }
  async write(account: string, secret: string, signal?: AbortSignal) {
    const command = this.command("add-generic-password", account);
    // Hex password bytes go through security's command interpreter on private stdin, never argv.
    const result = await this.run(
      ["/usr/bin/security", "-i"],
      signal,
      `${command.slice(1).join(" ")} -X ${Buffer.from(secret).toString("hex")}\n`,
    );
    if (result.code !== 0 || !(await this.has(account, signal))) throw new CredentialStoreError("denied");
  }
  async remove(account: string, options: { signal?: AbortSignal } = {}) {
    const result = await this.run(this.command("delete-generic-password", account), options.signal);
    return result.code === 0 || result.code === 44;
  }
}

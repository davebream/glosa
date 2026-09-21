// SPDX-License-Identifier: Apache-2.0

export const WISPR_FLOW_KEYCHAIN_SERVICE = "ai.glosa.dictation.wispr-flow";

export interface WisprFlowCredentialStore {
  has(account: string): Promise<boolean>;
  read(account: string): Promise<string | null>;
  addInteractive(account: string): Promise<void>;
  remove(account: string): Promise<boolean>;
}

export function keychainFindCommand(account: string, reveal = false): string[] {
  return [
    "/usr/bin/security",
    "find-generic-password",
    "-s",
    WISPR_FLOW_KEYCHAIN_SERVICE,
    "-a",
    account,
    ...(reveal ? ["-w"] : []),
  ];
}

export function keychainAddCommand(account: string): string[] {
  // `security` prompts only when `-w` is the final option. The secret therefore travels through
  // inherited stdin and never appears in argv or a Glosa-owned buffer.
  return ["/usr/bin/security", "add-generic-password", "-U", "-s", WISPR_FLOW_KEYCHAIN_SERVICE, "-a", account, "-w"];
}

export function keychainRemoveCommand(account: string): string[] {
  return ["/usr/bin/security", "delete-generic-password", "-s", WISPR_FLOW_KEYCHAIN_SERVICE, "-a", account];
}

function childEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  delete env.ANTHROPIC_API_KEY;
  return env;
}

async function exitCode(command: string[], stdio: "ignore" | "inherit" = "ignore"): Promise<number> {
  const process = Bun.spawn(command, {
    env: childEnv(),
    stdin: stdio,
    stdout: stdio,
    stderr: stdio,
  });
  return process.exited;
}

export class MacKeychainCredentialStore implements WisprFlowCredentialStore {
  async has(account: string): Promise<boolean> {
    return (await exitCode(keychainFindCommand(account))) === 0;
  }

  async read(account: string): Promise<string | null> {
    const process = Bun.spawn(keychainFindCommand(account, true), {
      env: childEnv(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const output = await new Response(process.stdout).text();
    if ((await process.exited) !== 0) return null;
    const value = output.trim();
    return value.length > 0 ? value : null;
  }

  async addInteractive(account: string): Promise<void> {
    const status = await exitCode(keychainAddCommand(account), "inherit");
    if (status !== 0) throw new Error("the macOS Keychain credential prompt was cancelled or failed");
  }

  async remove(account: string): Promise<boolean> {
    const status = await exitCode(keychainRemoveCommand(account));
    return status === 0;
  }
}

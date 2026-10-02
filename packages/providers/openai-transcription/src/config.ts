// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export interface OpenAIDictationConfig {
  version: 1;
  enabled: boolean;
  context: boolean;
  cleanup: boolean;
  consent_version: 1;
  revision: string;
  keychain_account: string | null;
}
export function openAIDictationConfigPath(home: string): string {
  return join(home, "dictation-openai.json");
}
export function readOpenAIDictationConfig(home: string): OpenAIDictationConfig | null {
  const path = openAIDictationConfigPath(home);
  if (!existsSync(path)) return null;
  try {
    if ((statSync(path).mode & 0o777) !== 0o600) throw new Error();
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (
      value.version !== 1 ||
      value.consent_version !== 1 ||
      ![value.enabled, value.context, value.cleanup].every((v) => typeof v === "boolean") ||
      typeof value.revision !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.revision) ||
      !(
        value.keychain_account === null ||
        (typeof value.keychain_account === "string" &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.keychain_account))
      )
    )
      throw new Error();
    return value;
  } catch {
    throw new Error("Dictation configuration cannot be read or requires renewed consent.");
  }
}

export interface ConfigMutationDeps {
  rename: typeof renameSync;
  unlink: typeof unlinkSync;
}

const REAL_MUTATION_DEPS: ConfigMutationDeps = { rename: renameSync, unlink: unlinkSync };

export function writeOpenAIDictationConfig(
  home: string,
  config: OpenAIDictationConfig,
  deps: ConfigMutationDeps = REAL_MUTATION_DEPS,
): void {
  mkdirSync(home, { recursive: true });
  const destination = openAIDictationConfigPath(home);
  const temporary = `${destination}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  let fd: number | null = null;
  let committed = false;
  try {
    writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    chmodSync(temporary, 0o600);
    fd = openSync(temporary, "r+");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    deps.rename(temporary, destination);
    committed = true;
  } finally {
    if (fd !== null) closeSync(fd);
    if (!committed) {
      try {
        deps.unlink(temporary);
      } catch {
        // The previous configuration remains the last committed state.
      }
    }
  }
}

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

export const WISPR_FLOW_CONFIG_VERSION = 1;
export const WISPR_FLOW_CONSENT_VERSION = 1;
export const WISPR_FLOW_CONTEXT_LIMIT_BYTES = 262_144;

export interface WisprFlowConfig {
  version: typeof WISPR_FLOW_CONFIG_VERSION;
  provider: "wispr-flow";
  enabled: boolean;
  consent_version: typeof WISPR_FLOW_CONSENT_VERSION;
  consented_at: string;
  context_policy: "visible-prose";
  context_limit_bytes: typeof WISPR_FLOW_CONTEXT_LIMIT_BYTES;
  client_id: string;
  keychain_account: string;
  configured_at: string;
  disabled_at?: string;
}

export type WisprFlowConfigRead =
  | { state: "missing" }
  | { state: "invalid"; message: string }
  | { state: "configured"; config: WisprFlowConfig };

export function wisprFlowConfigPath(home: string): string {
  return join(home, "dictation-wispr-flow.json");
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function parseConfig(value: unknown): WisprFlowConfig | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== WISPR_FLOW_CONFIG_VERSION ||
    candidate.provider !== "wispr-flow" ||
    typeof candidate.enabled !== "boolean" ||
    candidate.consent_version !== WISPR_FLOW_CONSENT_VERSION ||
    typeof candidate.consented_at !== "string" ||
    candidate.context_policy !== "visible-prose" ||
    candidate.context_limit_bytes !== WISPR_FLOW_CONTEXT_LIMIT_BYTES ||
    !isUuid(candidate.client_id) ||
    !isUuid(candidate.keychain_account) ||
    typeof candidate.configured_at !== "string" ||
    (candidate.disabled_at !== undefined && typeof candidate.disabled_at !== "string")
  ) {
    return null;
  }
  return candidate as unknown as WisprFlowConfig;
}

export function readWisprFlowConfig(home: string): WisprFlowConfigRead {
  const path = wisprFlowConfigPath(home);
  if (!existsSync(path)) return { state: "missing" };
  try {
    if ((statSync(path).mode & 0o777) !== 0o600) {
      return { state: "invalid", message: "dictation configuration permissions must be 0600" };
    }
    const parsed = parseConfig(JSON.parse(readFileSync(path, "utf8")));
    return parsed
      ? { state: "configured", config: parsed }
      : { state: "invalid", message: "dictation configuration is invalid or requires renewed consent" };
  } catch {
    return { state: "invalid", message: "dictation configuration cannot be read" };
  }
}

export interface ConfigMutationDeps {
  rename: typeof renameSync;
  unlink: typeof unlinkSync;
}

const REAL_MUTATION_DEPS: ConfigMutationDeps = { rename: renameSync, unlink: unlinkSync };

export function writeWisprFlowConfig(
  home: string,
  config: WisprFlowConfig,
  deps: ConfigMutationDeps = REAL_MUTATION_DEPS,
): void {
  mkdirSync(home, { recursive: true });
  const destination = wisprFlowConfigPath(home);
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

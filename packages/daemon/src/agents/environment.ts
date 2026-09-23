// SPDX-License-Identifier: Apache-2.0
import { join } from "node:path";
import type { ManagedAgentAdapter } from "./interface.ts";
import { privateDirectory } from "../chats/journal.ts";

// Deliberately construct rather than blacklist the parent's environment. Provider auth,
// gateways, cloud credentials, NODE_OPTIONS and shell startup configuration are not inherited.
const PLATFORM_ENV = [
  "HOME",
  "USER",
  "LOGNAME",
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "SHELL",
  "SSH_AUTH_SOCK",
] as const;
export function managedEnvironment(
  source: NodeJS.ProcessEnv,
  providerEnv: Record<string, string> = {},
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of PLATFORM_ENV) if (source[key]) result[key] = source[key]!;
  result.PATH ??= "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  result.LANG ??= "en_US.UTF-8";
  result.TERM = "xterm-256color";
  for (const [key, value] of Object.entries(providerEnv)) result[key] = value;
  delete result.ANTHROPIC_API_KEY;
  return result;
}
export function profileLocations(root: string, profileId: string, adapter: ManagedAgentAdapter) {
  if (!/^[a-f0-9-]{36}$/.test(profileId)) throw new Error("invalid profile identity");
  const base = privateDirectory(join(root, "profiles", profileId));
  const configRoot = privateDirectory(join(base, "native"));
  const neutralCwd = privateDirectory(join(base, "login"));
  return { configRoot, neutralCwd, env: managedEnvironment(process.env, adapter.profileEnvironment(configRoot)) };
}

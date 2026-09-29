// SPDX-License-Identifier: Apache-2.0
import { realpathSync, statSync } from "node:fs";
import { join, isAbsolute, relative } from "node:path";
import { ManagedAgentError, type AgentProfile, type ManagedAgentAdapter } from "./interface.ts";
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
export function linkedConfiguration(root: string, path: string): string {
  if (!isAbsolute(path))
    throw new ManagedAgentError("unsafe-state-path", "Choose an absolute native configuration directory.", 422);
  let canonical: string;
  try {
    canonical = realpathSync(path);
  } catch {
    throw new ManagedAgentError(
      "unsafe-state-path",
      "The native configuration directory could not be opened. Check its path and permissions.",
      422,
    );
  }
  const owned = realpathSync(root);
  const inside = relative(owned, canonical);
  if (!statSync(canonical).isDirectory() || !inside || (!inside.startsWith("../") && !isAbsolute(inside)))
    throw new ManagedAgentError(
      "unsafe-state-path",
      "Choose a native configuration directory outside Glosa storage.",
      422,
    );
  return canonical;
}
export function profileLocations(
  root: string,
  profileId: string,
  adapter: ManagedAgentAdapter,
  configuration?: AgentProfile["configuration"],
) {
  if (!/^[a-f0-9-]{36}$/.test(profileId)) throw new Error("invalid profile identity");
  const base = privateDirectory(join(root, "profiles", profileId));
  const configRoot = configuration
    ? linkedConfiguration(root, configuration.path)
    : privateDirectory(join(base, "native"));
  if (configuration && configRoot !== configuration.path)
    throw new ManagedAgentError(
      "unsafe-state-path",
      "The linked configuration directory moved. Unlink it and select it again.",
    );
  const neutralCwd = privateDirectory(join(base, "login"));
  return { configRoot, neutralCwd, env: managedEnvironment(process.env, adapter.profileEnvironment(configRoot)) };
}

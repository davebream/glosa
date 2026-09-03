// SPDX-License-Identifier: Apache-2.0
// Neutral filesystem and merge primitives for A6 §F26's provider-declarative init transaction.
// Provider-specific paths and desired nodes belong in packages/providers/*; this module only
// applies plans supplied by those descriptors.
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { DesiredInstallHook } from "../../daemon/src/index.ts";

export interface GlosaBinResolution {
  command: string;
  args: string[];
  mode: "path" | "bun-run";
}

export class DurableGlosaInstallRequiredError extends Error {
  constructor(readonly attempted: GlosaBinResolution) {
    super("`glosa init` requires a durable global or project-local installation");
    this.name = "DurableGlosaInstallRequiredError";
  }
}

/** Shared with `glosa update`: widening this matcher also widens init's refusal boundary. */
export function isEphemeralPackageRunnerPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return (
    normalized.includes("/.npm/_npx/") ||
    normalized.includes("/_npx/") ||
    normalized.includes("/install/cache/") ||
    normalized.includes("/.pnpm/dlx/")
  );
}

/** Resolve a durable, PATH-independent command for hooks and MCP configuration. */
export function defaultResolveGlosaBin(glosaRoot: string): GlosaBinResolution {
  const fallback: GlosaBinResolution = {
    command: process.execPath,
    args: ["run", "--silent", join(glosaRoot, "packages/cli/src/main.ts")],
    mode: "bun-run",
  };
  if (isEphemeralPackageRunnerPath(glosaRoot)) throw new DurableGlosaInstallRequiredError(fallback);
  return fallback;
}

// biome-ignore lint: JSON.parse's natural output type
type Json = any;

export function detectIndent(raw: string): string {
  const match = raw.match(/\n( +|\t+)\S/);
  return match ? (match[1] as string) : "  ";
}

export interface ParsedFile {
  obj: Json;
  raw: string | null;
  indent: string;
}

export interface InvalidJsonError extends Error {
  code: "INVALID_JSON";
  path: string;
}

export function parseJsonFile(path: string): ParsedFile {
  if (!existsSync(path)) return { obj: {}, raw: null, indent: "  " };
  const raw = readFileSync(path, "utf8");
  try {
    return { obj: raw.trim().length === 0 ? {} : JSON.parse(raw), raw, indent: detectIndent(raw) };
  } catch (error) {
    const wrapped = new Error(`${path}: invalid JSON — ${(error as Error).message}`) as InvalidJsonError;
    wrapped.code = "INVALID_JSON";
    wrapped.path = path;
    throw wrapped;
  }
}

export function sha256Of(node: Json): string {
  return createHash("sha256").update(JSON.stringify(node)).digest("hex");
}

export type WriteFileAtomic = (path: string, content: string) => void;

export function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = join(dirname(path), `.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  const fd = openSync(tmpPath, "w");
  try {
    const buffer = Buffer.from(content, "utf8");
    let written = 0;
    while (written < buffer.byteLength) written += writeSync(fd, buffer, written, buffer.byteLength - written);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, path);
  const directoryFd = openSync(dirname(path), "r");
  try {
    fsyncSync(directoryFd);
  } finally {
    closeSync(directoryFd);
  }
}

export function writeJsonAtomic(path: string, obj: Json, indent: string, write: WriteFileAtomic = writeAtomic): void {
  write(path, `${JSON.stringify(obj, null, indent)}\n`);
}

function backupsFor(path: string): string[] {
  const directory = dirname(path);
  const base = `${path.split("/").pop()}.glosa-backup-`;
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((file) => file.startsWith(base))
    .map((file) => join(directory, file))
    .sort();
}

/** Back up current bytes once per distinct latest version and retain at most five backups. */
export function takeBackup(
  path: string,
  currentContent: string,
  now: Date,
  write: WriteFileAtomic = writeAtomic,
): string | null {
  const existing = backupsFor(path);
  const newest = existing[existing.length - 1];
  if (newest !== undefined && readFileSync(newest, "utf8") === currentContent) return newest;

  const backupPath = `${path}.glosa-backup-${now.toISOString()}`;
  write(backupPath, currentContent);
  const all = [...existing, backupPath];
  for (const stale of all.slice(0, Math.max(0, all.length - 5))) {
    try {
      unlinkSync(stale);
    } catch {
      // Backup pruning is best effort; the durable target write still proceeds.
    }
  }
  return backupPath;
}

function hookRoleOf(command: unknown): string | null {
  if (typeof command !== "string") return null;
  const match = command.match(
    /^(?:(?:\S*\/)?glosa hook (\S+)|(?:\S*\/)?bun run --silent \S*packages\/cli\/src\/main\.ts hook (\S+))(?: --provider \S+)?$/,
  );
  return match ? ((match[1] ?? match[2]) as string) : null;
}

interface InsertedNode {
  pointer: string;
  sha256: string;
}

interface MergeResult {
  changed: boolean;
  inserted: InsertedNode[];
}

/** Merge descriptor-supplied hook nodes while reconciling glosa roles in place. */
export function mergeSettingsHooks(root: Json, hooks: DesiredInstallHook[]): MergeResult {
  const inserted: InsertedNode[] = [];
  let changed = false;
  root.hooks ??= {};
  const hooksObject = root.hooks as Json;

  for (const hook of hooks) {
    hooksObject[hook.event] ??= [];
    const groups = hooksObject[hook.event] as Json[];
    const desiredEntry: Json = { type: "command", command: hook.command };
    if (hook.timeout !== undefined) desiredEntry.timeout = hook.timeout;
    if (hook.asyncRewake) desiredEntry.asyncRewake = true;

    let existingGroupIndex = -1;
    let existingHookIndex = -1;
    findExisting: for (let pass = 0; pass < 2; pass++) {
      for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
        const groupHooks = groups[groupIndex]?.hooks;
        if (!Array.isArray(groupHooks)) continue;
        for (let hookIndex = 0; hookIndex < groupHooks.length; hookIndex++) {
          const matches =
            pass === 0
              ? hookRoleOf(groupHooks[hookIndex]?.command) === hook.role
              : groupHooks[hookIndex]?.command === hook.command;
          if (matches) {
            existingGroupIndex = groupIndex;
            existingHookIndex = hookIndex;
            break findExisting;
          }
        }
      }
    }

    if (existingGroupIndex !== -1) {
      const groupHooks = groups[existingGroupIndex]?.hooks as Json[];
      const existingEntry = groupHooks[existingHookIndex];
      const pointer = `/hooks/${hook.event}/${existingGroupIndex}/hooks/${existingHookIndex}`;
      if (JSON.stringify(existingEntry) === JSON.stringify(desiredEntry)) {
        inserted.push({ pointer, sha256: sha256Of(existingEntry) });
        continue;
      }
      groupHooks[existingHookIndex] = desiredEntry;
      changed = true;
      inserted.push({ pointer, sha256: sha256Of(desiredEntry) });
      continue;
    }

    let group = groups.find((candidate) => (candidate.matcher ?? undefined) === (hook.matcher ?? undefined));
    if (!group) {
      group = hook.matcher !== undefined ? { matcher: hook.matcher, hooks: [] } : { hooks: [] };
      groups.push(group);
    }
    (group.hooks as Json[]).push(desiredEntry);
    changed = true;
    const groupIndex = groups.indexOf(group);
    const hookIndex = (group.hooks as Json[]).length - 1;
    inserted.push({ pointer: `/hooks/${hook.event}/${groupIndex}/hooks/${hookIndex}`, sha256: sha256Of(desiredEntry) });
  }

  return { changed, inserted };
}

interface McpMergeResult extends MergeResult {
  conflict: boolean;
}

/** Merge the standard glosa MCP node without inspecting or changing foreign siblings. */
export function mergeMcp(
  root: Json,
  bin: GlosaBinResolution,
  opts: { force: boolean; owned: boolean },
): McpMergeResult {
  root.mcpServers ??= {};
  const servers = root.mcpServers as Json;
  const desired = { type: "stdio", command: bin.command, args: [...bin.args, "mcp"] };
  const existing = servers.glosa;

  if (existing !== undefined) {
    if (JSON.stringify(existing) === JSON.stringify(desired)) return { changed: false, inserted: [], conflict: false };
    if (!opts.owned && !opts.force) return { changed: false, inserted: [], conflict: true };
  }

  servers.glosa = desired;
  return {
    changed: true,
    inserted: [{ pointer: "/mcpServers/glosa", sha256: sha256Of(desired) }],
    conflict: false,
  };
}

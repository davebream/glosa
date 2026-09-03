// SPDX-License-Identifier: Apache-2.0
// A6 §F26 scoped, targeted, provider-declarative onboarding.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  InitScope,
  InstallRoots,
  ProviderId,
  ProviderInstallDescriptor,
  ProviderInstallTarget,
} from "../../daemon/src/index.ts";
import { claudeCodeInstallDescriptor } from "../../providers/claude-code/src/index.ts";
import { codexInstallDescriptor } from "../../providers/codex/src/index.ts";
import {
  CHANNEL_COMMAND,
  DurableGlosaInstallRequiredError,
  defaultResolveGlosaBin,
  detectIndent,
  mergeMcp,
  mergeSettingsHooks,
  parseJsonFile,
  sha256Of,
  takeBackup,
  writeAtomic,
  writeJsonAtomic,
  type GlosaBinResolution,
  type WriteFileAtomic,
} from "./init.ts";
import { renderUnifiedDiff } from "./unified-diff.ts";

export type { InitScope, ProviderId } from "../../daemon/src/index.ts";

const PROVIDERS: readonly ProviderInstallDescriptor[] = [claudeCodeInstallDescriptor, codexInstallDescriptor];
const PROVIDER_BY_ID = new Map(PROVIDERS.map((provider) => [provider.id, provider]));
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 10_000;
const LOCK_POLL_MS = 20;

interface InsertedNode {
  pointer: string;
  sha256: string;
}

export interface JsonOwnership {
  kind: "json";
  path: string;
  created: boolean;
  backup: string | null;
  inserted: InsertedNode[];
}

export interface TextOwnership {
  kind: "text";
  path: string;
  created: boolean;
  backup: string | null;
  sha256: string;
  startMarker: string;
  endMarker: string;
}

export type FileOwnership = JsonOwnership | TextOwnership;

export interface ScopedOwnershipManifest {
  version: 2;
  scope: InitScope;
  glosa_bin: GlosaBinResolution;
  providers: Partial<Record<ProviderId, { files: Record<string, FileOwnership> }>>;
}

interface LegacyManifest {
  version: 1;
  glosa_bin: GlosaBinResolution;
  files: {
    settings: Omit<JsonOwnership, "kind">;
    mcp: Omit<JsonOwnership, "kind">;
    codex_hooks?: Omit<JsonOwnership, "kind">;
    codex_config?: Omit<TextOwnership, "kind" | "startMarker" | "endMarker">;
  };
}

export interface ScopedInitOptions {
  dir: string;
  scope?: InitScope;
  agents: ProviderId[];
  print?: boolean;
  force?: boolean;
  homeDir?: string;
  glosaHomeDir?: string;
  glosaRoot?: string;
  now?: () => Date;
  resolveGlosaBin?: (glosaRoot: string) => GlosaBinResolution;
  writeFileAtomic?: WriteFileAtomic;
}

export interface InitFileResult {
  path: string;
  created: boolean;
  changed: boolean;
  backedUp: boolean;
}

export interface InitData {
  scope: InitScope;
  providers: ProviderId[];
  files: Record<string, InitFileResult>;
  activation_help: string[];
  glosa_bin: GlosaBinResolution;
  channel_command?: string;
}

export interface InitResult {
  ok: boolean;
  exitCode: number;
  changed: boolean;
  data: InitData;
  diff?: string;
  warnings: { code: string; message: string }[];
  error?: { code: string; kind: string; message: string; hint?: string };
}

export interface ScopedUninstallOptions {
  dir: string;
  scope?: InitScope;
  agents?: ProviderId[];
  homeDir?: string;
  glosaHomeDir?: string;
  writeFileAtomic?: WriteFileAtomic;
}

export interface UninstallResult {
  ok: boolean;
  exitCode: number;
  removed: string[];
  warnings: { code: string; message: string }[];
  data: { scope: InitScope; providers: ProviderId[] };
  error?: { code: string; kind: string; message: string };
}

interface PlannedTarget {
  provider: ProviderId;
  target: ProviderInstallTarget;
  before: string | null;
  after: string;
  changed: boolean;
  ownership: FileOwnership;
}

function rootsFor(dir: string, home = homedir(), glosaHome = Bun.env.GLOSA_HOME ?? join(home, ".glosa")): InstallRoots {
  return { workspace: dir, home, glosaHome };
}

export function scopedManifestPaths(
  dir: string,
  opts: { homeDir?: string; glosaHomeDir?: string } = {},
): { workspace: string; user: string; legacy: string } {
  const roots = rootsFor(dir, opts.homeDir, opts.glosaHomeDir);
  return {
    workspace: join(roots.workspace, ".glosa", "init-manifest.json"),
    user: join(roots.glosaHome, "init-manifest.json"),
    legacy: join(roots.workspace, ".claude", ".glosa-init.json"),
  };
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function readManifest(path: string): ScopedOwnershipManifest | null {
  const manifest = readJson<ScopedOwnershipManifest>(path);
  return manifest?.version === 2 ? manifest : null;
}

function migrateLegacy(path: string): ScopedOwnershipManifest | null {
  const legacy = readJson<LegacyManifest>(path);
  if (legacy?.version !== 1) return null;
  const providers: ScopedOwnershipManifest["providers"] = {
    "claude-code": {
      files: {
        hooks: { kind: "json", ...legacy.files.settings },
        mcp: { kind: "json", ...legacy.files.mcp },
      },
    },
  };
  if (legacy.files.codex_hooks || legacy.files.codex_config) {
    providers.codex = { files: {} };
    if (legacy.files.codex_hooks) providers.codex.files.hooks = { kind: "json", ...legacy.files.codex_hooks };
    if (legacy.files.codex_config) {
      providers.codex.files.mcp = {
        kind: "text",
        ...legacy.files.codex_config,
        startMarker: "# glosa:begin mcp_servers.glosa",
        endMarker: "# glosa:end mcp_servers.glosa",
      };
    }
  }
  return { version: 2, scope: "workspace", glosa_bin: legacy.glosa_bin, providers };
}

export function detectInstallProviders(
  dir: string,
  opts: { homeDir?: string; glosaHomeDir?: string; which?: (executable: string) => string | null } = {},
): ProviderId[] {
  const roots = rootsFor(dir, opts.homeDir, opts.glosaHomeDir);
  const deps = {
    exists: existsSync,
    which: opts.which ?? ((executable: string) => Bun.which(executable) ?? null),
  };
  return PROVIDERS.filter((provider) => provider.detect(roots, deps)).map((provider) => provider.id);
}

function safeUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {}
}

async function withLock<T>(authorityPath: string, now: () => Date, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${authorityPath}.lock`;
  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = now().getTime() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx");
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, started: now().toISOString() }));
      } finally {
        closeSync(fd);
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const record = readJson<{ started?: string }>(lockPath);
      const started = record?.started ? new Date(record.started).getTime() : Number.NaN;
      const oldMtime = statSync(lockPath).mtimeMs < now().getTime() - LOCK_STALE_MS;
      if (Number.isFinite(started) && now().getTime() - started > LOCK_STALE_MS && oldMtime) {
        safeUnlink(lockPath);
        continue;
      }
      if (now().getTime() >= deadline) throw new Error(`glosa init lock timeout: ${lockPath}`);
      await Bun.sleep(LOCK_POLL_MS);
    }
  }
  try {
    return await fn();
  } finally {
    safeUnlink(lockPath);
  }
}

async function withLocks<T>(paths: string[], now: () => Date, fn: () => Promise<T>): Promise<T> {
  const ordered = [...new Set(paths)].sort();
  const next = (index: number): Promise<T> =>
    index === ordered.length ? fn() : withLock(ordered[index] as string, now, () => next(index + 1));
  return next(0);
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function desiredMcpEntry(bin: GlosaBinResolution): Record<string, unknown> {
  return { type: "stdio", command: bin.command, args: [...bin.args, "mcp"] };
}

function desiredTomlBlock(
  target: Extract<ProviderInstallTarget, { kind: "mcp-toml" }>,
  bin: GlosaBinResolution,
): string {
  const args = [...bin.args, "mcp"].map((arg) => JSON.stringify(arg)).join(", ");
  return [
    target.startMarker,
    "[mcp_servers.glosa]",
    `command = ${JSON.stringify(bin.command)}`,
    `args = [${args}]`,
    target.endMarker,
  ].join("\n");
}

function findManagedBlock(
  raw: string,
  startMarker: string,
  endMarker: string,
): { start: number; end: number; block: string } | null {
  const start = raw.indexOf(startMarker);
  if (start < 0) return null;
  const markerEnd = raw.indexOf(endMarker, start);
  if (markerEnd < 0) return null;
  const end = markerEnd + endMarker.length;
  return { start, end, block: raw.slice(start, end) };
}

function removeForeignTomlTable(raw: string): string {
  const lines = raw.split("\n");
  const start = lines.findIndex((line) => /^\s*\[mcp_servers\.glosa\]\s*(?:#.*)?$/.test(line));
  if (start < 0) return raw;
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end] as string)) end++;
  lines.splice(start, end - start);
  return lines.join("\n");
}

function mergeToml(
  before: string | null,
  target: Extract<ProviderInstallTarget, { kind: "mcp-toml" }>,
  bin: GlosaBinResolution,
  opts: { force: boolean; owned: boolean },
): { changed: boolean; conflict: boolean; content: string; block: string } {
  const raw = before ?? "";
  const desired = desiredTomlBlock(target, bin);
  const managed = findManagedBlock(raw, target.startMarker, target.endMarker);
  if (managed) {
    if (!opts.owned && !opts.force) return { changed: false, conflict: true, content: raw, block: managed.block };
    if (managed.block === desired) return { changed: false, conflict: false, content: raw, block: desired };
    return {
      changed: true,
      conflict: false,
      content: `${raw.slice(0, managed.start)}${desired}${raw.slice(managed.end)}`,
      block: desired,
    };
  }
  if (/^\s*\[mcp_servers\.glosa\]\s*(?:#.*)?$/m.test(raw) && !opts.force) {
    return { changed: false, conflict: true, content: raw, block: desired };
  }
  const base = opts.force ? removeForeignTomlTable(raw).trimEnd() : raw.trimEnd();
  return { changed: true, conflict: false, content: `${base}${base ? "\n\n" : ""}${desired}\n`, block: desired };
}

/** Real hunk-level unified diff (issue #96) — see `renderUnifiedDiff`'s docstring for why the
 * previous whole-file-replacement rendering was a problem and not just an aesthetic one. */
const unifiedDiff = renderUnifiedDiff;

function emptyData(scope: InitScope, providers: ProviderId[], bin: GlosaBinResolution): InitData {
  const activation = providers.flatMap((id) => [...(PROVIDER_BY_ID.get(id)?.activationHelp ?? [])]);
  return {
    scope,
    providers,
    files: {},
    activation_help: activation,
    glosa_bin: bin,
    ...(providers.includes("claude-code") ? { channel_command: CHANNEL_COMMAND } : {}),
  };
}

function overlapError(scope: InitScope, provider: ProviderId, dir: string): InitResult["error"] {
  const other: InitScope = scope === "workspace" ? "user" : "workspace";
  const uninstallDir = other === "workspace" ? ` ${dir}` : "";
  const installDir = scope === "workspace" ? ` ${dir}` : "";
  return {
    code: "cross-scope-duplicate",
    kind: "usage",
    message: `${provider} is already installed at ${other} scope; ${scope} scope would run duplicate hooks`,
    hint: `run \`glosa init${uninstallDir} --scope ${other} --agent ${provider} --uninstall\`, then \`glosa init${installDir} --scope ${scope} --agent ${provider}\``,
  };
}

export async function runScopedInit(opts: ScopedInitOptions): Promise<InitResult> {
  const now = opts.now ?? (() => new Date());
  const roots = rootsFor(opts.dir, opts.homeDir, opts.glosaHomeDir);
  const paths = scopedManifestPaths(opts.dir, opts);
  if (opts.print) return runScopedInitLocked(opts, roots, paths, now);
  return withLocks([paths.workspace, paths.user, paths.legacy], now, () =>
    runScopedInitLocked(opts, roots, paths, now),
  );
}

async function runScopedInitLocked(
  opts: ScopedInitOptions,
  roots: InstallRoots,
  paths: ReturnType<typeof scopedManifestPaths>,
  now: () => Date,
): Promise<InitResult> {
  const scope = opts.scope ?? "workspace";
  const selected = [...new Set(opts.agents)];
  const fallback: GlosaBinResolution = { command: process.execPath, args: [], mode: "path" };
  if (selected.length === 0 || selected.some((id) => !PROVIDER_BY_ID.has(id))) {
    return {
      ok: false,
      exitCode: 2,
      changed: false,
      data: emptyData(scope, [], fallback),
      warnings: [],
      error: { code: "invalid-agent", kind: "usage", message: "select at least one supported provider" },
    };
  }
  let bin: GlosaBinResolution;
  try {
    bin = (opts.resolveGlosaBin ?? defaultResolveGlosaBin)(
      opts.glosaRoot ?? join(dirname(import.meta.dir), "..", ".."),
    );
  } catch (error) {
    if (!(error instanceof DurableGlosaInstallRequiredError)) throw error;
    return {
      ok: false,
      exitCode: 2,
      changed: false,
      data: emptyData(scope, selected, error.attempted),
      warnings: [],
      error: {
        code: "durable-install-required",
        kind: "usage",
        message: error.message,
        hint:
          "install with `bun add --global @davebream/glosa@alpha`, then re-run `glosa init`; " +
          "if your npm config maps the @davebream scope to another registry, install from the published " +
          "tarball URL instead — see the README's Quick start",
      },
    };
  }

  const selectedPath = paths[scope];
  const otherPath = paths[scope === "workspace" ? "user" : "workspace"];
  const migrated = scope === "workspace" ? migrateLegacy(paths.legacy) : null;
  const existing =
    readManifest(selectedPath) ??
    migrated ??
    ({ version: 2, scope, glosa_bin: bin, providers: {} } satisfies ScopedOwnershipManifest);
  const other = readManifest(otherPath) ?? (scope === "user" ? migrateLegacy(paths.legacy) : null);
  for (const provider of selected) {
    if (other?.providers[provider]) {
      return {
        ok: false,
        exitCode: 2,
        changed: false,
        data: emptyData(scope, selected, bin),
        warnings: [],
        error: overlapError(scope, provider, opts.dir),
      };
    }
  }

  const planned: PlannedTarget[] = [];
  try {
    for (const providerId of selected) {
      const descriptor = PROVIDER_BY_ID.get(providerId) as ProviderInstallDescriptor;
      for (const target of descriptor.targets(scope, roots, bin)) {
        const prior = existing.providers[providerId]?.files[target.key];
        if (target.kind === "mcp-toml") {
          const before = existsSync(target.path) ? readFileSync(target.path, "utf8") : null;
          const merge = mergeToml(before, target, bin, {
            force: opts.force ?? false,
            owned: prior?.kind === "text",
          });
          if (merge.conflict)
            throw Object.assign(new Error(`${target.path}: foreign glosa MCP entry`), { kind: "mcp" });
          planned.push({
            provider: providerId,
            target,
            before,
            after: merge.content,
            changed: merge.changed,
            ownership: {
              kind: "text",
              path: target.path,
              created: prior?.created ?? before === null,
              backup: prior?.backup ?? null,
              sha256: hashText(merge.block),
              startMarker: target.startMarker,
              endMarker: target.endMarker,
            },
          });
          continue;
        }
        const parsed = parseJsonFile(target.path);
        const merge =
          target.kind === "hooks-json"
            ? mergeSettingsHooks(parsed.obj, target.hooks)
            : mergeMcp(parsed.obj, bin, { force: opts.force ?? false, owned: prior?.kind === "json" });
        if ("conflict" in merge && merge.conflict) {
          throw Object.assign(new Error(`${target.path}: foreign glosa MCP entry`), { kind: "mcp" });
        }
        const inserted =
          target.kind === "mcp-json" && merge.inserted.length === 0
            ? [{ pointer: "/mcpServers/glosa", sha256: sha256Of(desiredMcpEntry(bin)) }]
            : merge.inserted;
        planned.push({
          provider: providerId,
          target,
          before: parsed.raw,
          after: `${JSON.stringify(parsed.obj, null, parsed.indent)}\n`,
          changed: merge.changed,
          ownership: {
            kind: "json",
            path: target.path,
            created: prior?.created ?? parsed.raw === null,
            backup: prior?.backup ?? null,
            inserted,
          },
        });
      }
    }
  } catch (error) {
    const e = error as Error & { kind?: string };
    return {
      ok: false,
      exitCode: 6,
      changed: false,
      data: emptyData(scope, selected, bin),
      warnings: [],
      error: {
        code: e.kind === "mcp" ? "mcp-key-conflict" : "invalid-json",
        kind: "foreign_config_conflict",
        message: e.message,
        hint: e.kind === "mcp" ? "pass --force to overwrite it" : "fix the JSON syntax error and rerun `glosa init`",
      },
    };
  }

  const adding = selected.some((provider) => existing.providers[provider] === undefined);
  const migrating = migrated !== null && !existsSync(selectedPath);
  const changed = planned.some((item) => item.changed) || adding || migrating;
  const summary = emptyData(scope, selected, bin);
  for (const item of planned) {
    summary.files[`${item.provider}:${item.target.key}`] = {
      path: item.target.path,
      created: item.before === null,
      changed: item.changed,
      backedUp: item.changed && item.before !== null,
    };
  }
  if (opts.print) {
    return {
      ok: true,
      exitCode: 0,
      changed,
      data: summary,
      diff: planned
        .filter((item) => item.changed)
        .map((item) => unifiedDiff(item.target.path, item.before, item.after))
        .join(""),
      warnings: [],
    };
  }
  if (!changed) return { ok: true, exitCode: 0, changed: false, data: summary, warnings: [] };

  const write = opts.writeFileAtomic ?? writeAtomic;
  const undo: (() => void)[] = [];
  const next = structuredClone(existing);
  next.version = 2;
  next.scope = scope;
  next.glosa_bin = bin;
  try {
    for (const item of planned) {
      const provider = (next.providers[item.provider] ??= { files: {} });
      const ownership = structuredClone(item.ownership);
      if (item.changed) {
        if (item.before !== null) ownership.backup = takeBackup(item.target.path, item.before, now(), write);
        undo.push(() =>
          item.before === null ? safeUnlink(item.target.path) : writeAtomic(item.target.path, item.before),
        );
        write(item.target.path, item.after);
      }
      provider.files[item.target.key] = ownership;
    }
    const priorManifest = existsSync(selectedPath) ? readFileSync(selectedPath, "utf8") : null;
    undo.push(() => (priorManifest === null ? safeUnlink(selectedPath) : writeAtomic(selectedPath, priorManifest)));
    writeJsonAtomic(selectedPath, next, "  ", write);
    if (migrated && existsSync(paths.legacy)) {
      const legacyRaw = readFileSync(paths.legacy, "utf8");
      undo.push(() => writeAtomic(paths.legacy, legacyRaw));
      safeUnlink(paths.legacy);
    }
    return { ok: true, exitCode: 0, changed: true, data: summary, warnings: [] };
  } catch (error) {
    for (const rollback of undo.reverse()) {
      try {
        rollback();
      } catch {}
    }
    return {
      ok: false,
      exitCode: 70,
      changed: false,
      data: emptyData(scope, selected, bin),
      warnings: [],
      error: { code: "internal", kind: "internal", message: (error as Error).message },
    };
  }
}

function resolvePointer(root: unknown, pointer: string): { found: boolean; value?: unknown } {
  let current: unknown = root;
  for (const part of pointer.split("/").filter(Boolean)) {
    if (Array.isArray(current)) {
      const index = Number(part);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return { found: false };
      current = current[index];
      continue;
    }
    if (current === null || typeof current !== "object" || !(part in current)) return { found: false };
    current = (current as Record<string, unknown>)[part];
  }
  return { found: true, value: current };
}

function removePointer(root: unknown, pointer: string): void {
  const parts = pointer.split("/").filter(Boolean);
  const last = parts.pop();
  if (last === undefined) return;
  let parent: unknown = root;
  for (const part of parts) {
    if (Array.isArray(parent)) parent = parent[Number(part)];
    else if (parent !== null && typeof parent === "object") parent = (parent as Record<string, unknown>)[part];
    else return;
  }
  if (Array.isArray(parent)) parent.splice(Number(last), 1);
  else if (parent !== null && typeof parent === "object") delete (parent as Record<string, unknown>)[last];
}

/** Order removal pointers against the document they address.
 *
 * Descendants precede ancestors so deleting a parent cannot make a child unreachable. At the first
 * divergent segment beneath an array, higher indices precede lower ones; this also handles a direct
 * removal at `/items/2` alongside a nested removal at `/items/10/value`, not only equal-depth
 * siblings. Numeric-looking object keys retain ordinary deterministic key order because deleting an
 * object property cannot shift another property. */
function compareRemovalPointers(root: unknown, a: string, b: string): number {
  const aParts = a.split("/").filter(Boolean);
  const bParts = b.split("/").filter(Boolean);
  let container = root;
  const sharedLength = Math.min(aParts.length, bParts.length);

  for (let index = 0; index < sharedLength; index++) {
    const aPart = aParts[index] as string;
    const bPart = bParts[index] as string;
    if (aPart !== bPart) {
      if (Array.isArray(container)) {
        const numericOrder = Number(bPart) - Number(aPart);
        if (numericOrder !== 0) return numericOrder;
      }
      return aPart < bPart ? -1 : 1;
    }
    if (Array.isArray(container)) container = container[Number(aPart)];
    else if (container !== null && typeof container === "object")
      container = (container as Record<string, unknown>)[aPart];
    else container = undefined;
  }

  return bParts.length - aParts.length;
}

/** One node of the ancestor trie built from the pointers a single uninstall actually removed. */
interface AncestorTrie {
  children: Map<string, AncestorTrie>;
}

/** The ancestor paths of `pointers`, as a trie. The removed node's own last segment is dropped:
 * it is already gone from the document, and only its PARENTS are prune candidates. */
function ancestorTrie(pointers: string[]): AncestorTrie {
  const root: AncestorTrie = { children: new Map() };
  for (const pointer of pointers) {
    const parts = pointer.split("/").filter(Boolean);
    parts.pop();
    let node = root;
    for (const part of parts) {
      let next = node.children.get(part);
      if (next === undefined) {
        next = { children: new Map() };
        node.children.set(part, next);
      }
      node = next;
    }
  }
  return root;
}

function isScalar(value: unknown): boolean {
  return value === null || typeof value !== "object";
}

/** A6 §F26 uninstall: "match→remove + **prune empty parents**" — parents, not the document.
 *
 * WHY this is pointer-scoped rather than a generic "delete anything that recursively empties"
 * walk: the generic form visited every key in the file, so any foreign key whose value happened
 * to be an empty container was deleted along with glosa's own — a user's `permissions: {}` or
 * `env: {}` in `.claude/settings.json` disappeared on uninstall. That breaks the same clause's
 * "foreign non-glosa siblings untouched" rule, and it is data loss, not untidiness. Ownership in
 * v2 is pointer-based (`inserted:[{pointer, sha256}]`), so the pointers are exactly the authority
 * for which parents glosa is entitled to reconsider — nothing else in the document is even read.
 * That generalises to any provider shape (Codex's `.codex/hooks.json` today) without the core
 * learning a schema, which re-hardcoding v1's `hooks`/`mcpServers` key names would not.
 *
 * Residue rules, applied bottom-up so a child is settled before its parent is judged:
 *  - an array is residue when it is empty;
 *  - an object reached BY NAME is residue only when it has no keys left — its scalars are the
 *    user's own settings and must survive (this is what protects `permissions`/`env`);
 *  - an object that is an ELEMENT OF AN ARRAY is residue when everything left in it is a scalar.
 *    Such an object has no name of its own; it exists only to hold the entries beneath it, and
 *    its scalars select which entries those were. That is the Claude Code hook group
 *    `{matcher, hooks:[…]}`: once glosa's hooks are gone and the group is empty, the matcher
 *    describes an empty set, so the group is glosa's own scaffolding to remove — while a group
 *    still holding a foreign hook keeps a non-empty `hooks` array and is therefore never touched.
 *
 * A non-empty container anywhere blocks its parent, and so does an EMPTY container that is not
 * itself on a removed pointer's path — unlike v1's prune, which dropped a hook group purely
 * because its `hooks` array had emptied, whatever else the group carried.
 *
 * The one deliberate exception to "never touch what glosa did not insert": an empty container
 * that IS on the path goes, even if it happened to pre-exist (a user's literal `"hooks": {}`).
 * "Prune empty parents" is precisely the authority to remove it, it carries no data, and the next
 * `glosa init` recreates it — the same call v1 made. */
function pruneRemovedAncestors(container: unknown, trie: AncestorTrie, containedInArray: boolean): boolean {
  if (container === null || typeof container !== "object") return false;
  const isArray = Array.isArray(container);
  // Descending numeric order for arrays: splicing a low index first would shift every higher
  // sibling down, so a later splice would hit the wrong element.
  const keys = [...trie.children.keys()].sort(isArray ? (a, b) => Number(b) - Number(a) : undefined);
  for (const key of keys) {
    const child = isArray ? (container as unknown[])[Number(key)] : (container as Record<string, unknown>)[key];
    if (child === undefined) continue;
    if (!pruneRemovedAncestors(child, trie.children.get(key) as AncestorTrie, isArray)) continue;
    if (isArray) (container as unknown[]).splice(Number(key), 1);
    else delete (container as Record<string, unknown>)[key];
  }
  if (isArray) return (container as unknown[]).length === 0;
  const values = Object.values(container as Record<string, unknown>);
  if (values.length === 0) return true;
  return containedInArray && values.every(isScalar);
}

function uninstallJson(
  ownership: JsonOwnership,
  removed: string[],
  warn: (message: string) => void,
  write: WriteFileAtomic,
  undo: (() => void)[],
): JsonOwnership {
  if (!existsSync(ownership.path)) return { ...ownership, inserted: [] };
  const before = readFileSync(ownership.path, "utf8");
  let json: unknown;
  try {
    json = JSON.parse(before);
  } catch {
    warn(`${ownership.path}: invalid JSON — left untouched`);
    return ownership;
  }
  const removable: InsertedNode[] = [];
  const surviving: InsertedNode[] = [];
  for (const node of ownership.inserted) {
    const current = resolvePointer(json, node.pointer);
    if (!current.found) continue;
    if (sha256Of(current.value) === node.sha256) removable.push(node);
    else {
      surviving.push(node);
      warn(`${ownership.path}${node.pointer}: modified since glosa installed it — left in place`);
    }
  }
  if (removable.length === 0) return { ...ownership, inserted: surviving };
  for (const node of [...removable].sort((a, b) => compareRemovalPointers(json, a.pointer, b.pointer)))
    removePointer(json, node.pointer);
  // Only the parents of what this run removed are reconsidered; the document root is passed as a
  // named container so its own residue verdict is discarded — an emptied root is not deleted as a
  // key, it is the `created:true` file-deletion clause immediately below (A6 §F26).
  pruneRemovedAncestors(json, ancestorTrie(removable.map((node) => node.pointer)), false);
  undo.push(() => writeAtomic(ownership.path, before));
  if (ownership.created && json !== null && typeof json === "object" && Object.keys(json).length === 0) {
    safeUnlink(ownership.path);
  } else writeJsonAtomic(ownership.path, json, detectIndent(before), write);
  removed.push(...removable.map((node) => `${ownership.path}${node.pointer}`));
  return { ...ownership, inserted: surviving };
}

function uninstallText(
  ownership: TextOwnership,
  removed: string[],
  warn: (message: string) => void,
  write: WriteFileAtomic,
  undo: (() => void)[],
): TextOwnership {
  if (!existsSync(ownership.path)) return { ...ownership, sha256: "" };
  const before = readFileSync(ownership.path, "utf8");
  const managed = findManagedBlock(before, ownership.startMarker, ownership.endMarker);
  if (!managed) return { ...ownership, sha256: "" };
  if (hashText(managed.block) !== ownership.sha256) {
    warn(`${ownership.path}[mcp_servers.glosa]: modified since glosa installed it — left in place`);
    return ownership;
  }
  const after = `${before.slice(0, managed.start)}${before.slice(managed.end)}`.replace(/\n{3,}/g, "\n\n").trim();
  undo.push(() => writeAtomic(ownership.path, before));
  if (ownership.created && after.length === 0) safeUnlink(ownership.path);
  else write(ownership.path, after ? `${after}\n` : "");
  removed.push(`${ownership.path}[mcp_servers.glosa]`);
  return { ...ownership, sha256: "" };
}

export async function runScopedUninstall(opts: ScopedUninstallOptions): Promise<UninstallResult> {
  const now = () => new Date();
  const paths = scopedManifestPaths(opts.dir, opts);
  return withLocks([paths.workspace, paths.user, paths.legacy], now, async () => {
    const scope = opts.scope ?? "workspace";
    const manifestPath = paths[scope];
    const migrated = scope === "workspace" ? migrateLegacy(paths.legacy) : null;
    const manifest = readManifest(manifestPath) ?? migrated;
    if (!manifest) {
      return {
        ok: true,
        exitCode: 0,
        removed: [],
        warnings: [
          { code: "no-manifest", message: `no glosa init manifest found at ${scope} scope — nothing to uninstall` },
        ],
        data: { scope, providers: [] },
      };
    }
    const selected = [...new Set(opts.agents ?? (Object.keys(manifest.providers) as ProviderId[]))].filter(
      (provider) => manifest.providers[provider],
    );
    const next = structuredClone(manifest);
    const write = opts.writeFileAtomic ?? writeAtomic;
    const removed: string[] = [];
    const warnings: { code: string; message: string }[] = [];
    const undo: (() => void)[] = [];
    let mismatch = false;
    const warn = (message: string) => {
      mismatch = true;
      warnings.push({ code: "external-edit", message });
    };
    try {
      for (const providerId of selected) {
        const provider = next.providers[providerId];
        if (!provider) continue;
        const surviving: Record<string, FileOwnership> = {};
        for (const [key, ownership] of Object.entries(provider.files)) {
          const result =
            ownership.kind === "json"
              ? uninstallJson(ownership, removed, warn, write, undo)
              : uninstallText(ownership, removed, warn, write, undo);
          if (result.kind === "json" ? result.inserted.length > 0 : result.sha256.length > 0) surviving[key] = result;
        }
        if (Object.keys(surviving).length > 0) next.providers[providerId] = { files: surviving };
        else delete next.providers[providerId];
      }
      const priorManifest = existsSync(manifestPath) ? readFileSync(manifestPath, "utf8") : null;
      undo.push(() => (priorManifest === null ? safeUnlink(manifestPath) : writeAtomic(manifestPath, priorManifest)));
      if (Object.keys(next.providers).length === 0) safeUnlink(manifestPath);
      else writeJsonAtomic(manifestPath, next, "  ", write);
      if (migrated && existsSync(paths.legacy)) {
        const legacyRaw = readFileSync(paths.legacy, "utf8");
        undo.push(() => writeAtomic(paths.legacy, legacyRaw));
        safeUnlink(paths.legacy);
      }
      return { ok: !mismatch, exitCode: mismatch ? 9 : 0, removed, warnings, data: { scope, providers: selected } };
    } catch (error) {
      for (const rollback of undo.reverse()) {
        try {
          rollback();
        } catch {}
      }
      return {
        ok: false,
        exitCode: 70,
        removed: [],
        warnings: [],
        data: { scope, providers: selected },
        error: { code: "internal", kind: "internal", message: (error as Error).message },
      };
    }
  });
}

export interface ManifestDriftResult {
  manifest: ScopedOwnershipManifest | null;
  manifests: ScopedOwnershipManifest[];
  drifted: string[];
}

export function checkScopedManifestDrift(
  dir: string,
  opts: { homeDir?: string; glosaHomeDir?: string } = {},
): ManifestDriftResult {
  const paths = scopedManifestPaths(dir, opts);
  const manifests = [readManifest(paths.workspace) ?? migrateLegacy(paths.legacy), readManifest(paths.user)].filter(
    (value): value is ScopedOwnershipManifest => value !== null,
  );
  const drifted: string[] = [];
  for (const manifest of manifests) {
    for (const provider of Object.values(manifest.providers)) {
      if (!provider) continue;
      for (const ownership of Object.values(provider.files)) {
        if (!existsSync(ownership.path)) {
          drifted.push(`${ownership.path} (file missing)`);
          continue;
        }
        if (ownership.kind === "text") {
          const block = findManagedBlock(
            readFileSync(ownership.path, "utf8"),
            ownership.startMarker,
            ownership.endMarker,
          );
          if (!block || hashText(block.block) !== ownership.sha256)
            drifted.push(`${ownership.path}[mcp_servers.glosa]`);
          continue;
        }
        let json: unknown;
        try {
          json = JSON.parse(readFileSync(ownership.path, "utf8"));
        } catch {
          drifted.push(`${ownership.path} (invalid JSON)`);
          continue;
        }
        for (const node of ownership.inserted) {
          const current = resolvePointer(json, node.pointer);
          if (!current.found || sha256Of(current.value) !== node.sha256)
            drifted.push(`${ownership.path}${node.pointer}`);
        }
      }
    }
  }
  return { manifest: manifests[0] ?? null, manifests, drifted };
}

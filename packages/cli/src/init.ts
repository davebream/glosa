// @glosa/cli — `glosa init` (A6 §F26): the transactional merge of glosa's Claude Code hooks +
// MCP entry into a workspace's `.claude/settings.json` / `.mcp.json`, with an ownership manifest
// (`.claude/.glosa-init.json`) as the authoritative record of what glosa put there. Three
// invariants drive every decision in this file:
//   1. Never touch a foreign sibling — every insert is identified structurally (a hook by its
//      exact `command` string, the MCP entry by the literal key `glosa`) so glosa's own nodes are
//      always findable without a marker key polluting Claude's own schemas.
//   2. Never half-install — settings.json and .mcp.json are written in order, and if anything
//      after the first write fails, every file this run touched is restored to exactly what it
//      held before `runInit` was called.
//   3. Idempotent by content, not by "did we run before" — a second `init` with nothing to add
//      writes nothing and takes no backup, whether or not it remembers running the first time.
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { CLI_VERSION } from "./version.ts";

export { CLI_VERSION } from "./version.ts";

// ---------------------------------------------------------------------------------------------
// GLOSA_BIN resolution (A6 §F26)
// ---------------------------------------------------------------------------------------------

export interface GlosaBinResolution {
  command: string;
  args: string[];
  mode: "path" | "bun-run";
}

/** Bare `glosa` if it's on PATH AND its `--version` matches this build; otherwise the no-build-
 * step fallback `bun run --silent <glosaRoot>/packages/cli/src/main.ts` (A6 §F26/§F30 — "honors
 * no-build-step"). Injectable via `InitOptions.resolveGlosaBin` so tests never depend on what's
 * actually on the test runner's PATH. */
export function defaultResolveGlosaBin(glosaRoot: string): GlosaBinResolution {
  // `PATH` passed explicitly (not Bun.which's own zero-arg default) — Bun.which otherwise
  // resolves against a PATH snapshot that doesn't track a later `process.env.PATH` mutation,
  // which is exactly how a test (and `doctor`'s own re-check) needs this to behave.
  const onPath = Bun.which("glosa", { PATH: Bun.env.PATH ?? "" });
  if (onPath) {
    try {
      const proc = Bun.spawnSync({ cmd: [onPath, "--version"] });
      const out = proc.stdout.toString("utf8").trim();
      if (proc.success && out === `glosa ${CLI_VERSION}`) {
        return { command: "glosa", args: [], mode: "path" };
      }
    } catch {
      // fall through to the bun-run form
    }
  }
  return { command: "bun", args: ["run", "--silent", join(glosaRoot, "packages/cli/src/main.ts")], mode: "bun-run" };
}

function binCommandString(bin: GlosaBinResolution, ...extraArgs: string[]): string {
  return [bin.command, ...bin.args, ...extraArgs].join(" ");
}

/** F06 LOCKED — never `--channels`. */
export const CHANNEL_COMMAND = "claude --dangerously-load-development-channels server:glosa";

// ---------------------------------------------------------------------------------------------
// JSON helpers — indentation-preserving parse/read, JSON-pointer resolve, stable hashing.
// ---------------------------------------------------------------------------------------------

// biome-ignore lint: JSON.parse's natural output type
type Json = any;

function detectIndent(raw: string): string {
  const m = raw.match(/\n( +|\t+)\S/);
  return m ? (m[1] as string) : "  ";
}

interface ParsedFile {
  obj: Json;
  raw: string | null; // null = file didn't exist
  indent: string;
}

export interface InvalidJsonError extends Error {
  code: "INVALID_JSON";
  path: string;
}

function parseJsonFile(path: string): ParsedFile {
  if (!existsSync(path)) return { obj: {}, raw: null, indent: "  " };
  const raw = readFileSync(path, "utf8");
  try {
    return { obj: raw.trim().length === 0 ? {} : JSON.parse(raw), raw, indent: detectIndent(raw) };
  } catch (err) {
    const wrapped = new Error(`${path}: invalid JSON — ${(err as Error).message}`) as InvalidJsonError;
    wrapped.code = "INVALID_JSON";
    wrapped.path = path;
    throw wrapped;
  }
}

function resolvePointer(root: Json, pointer: string): { found: true; value: Json } | { found: false } {
  const parts = pointer.split("/").filter((p) => p.length > 0);
  let cur = root;
  for (const part of parts) {
    if (cur === undefined || cur === null) return { found: false };
    const key = Array.isArray(cur) && /^\d+$/.test(part) ? Number(part) : part;
    if (Array.isArray(cur) ? (key as number) >= cur.length : !(key in cur)) return { found: false };
    cur = cur[key];
  }
  return { found: true, value: cur };
}

function sha256Of(node: Json): string {
  return createHash("sha256").update(JSON.stringify(node)).digest("hex");
}

// ---------------------------------------------------------------------------------------------
// Atomic write (temp -> fsync -> rename, same directory) — the CLI's own copy of the pattern
// daemon/src/artifact-render.ts's `writeArtifactAtomic` uses, kept local so this package doesn't
// take on a daemon-internal dependency for a three-function primitive.
// ---------------------------------------------------------------------------------------------

/** The real atomic writer — the default for every write in this file. Every call site accepts an
 * OVERRIDE of this exact signature (`InitOptions.writeFileAtomic`) so a test can make a SPECIFIC
 * write in a multi-file sequence throw (proving the mid-run rollback) without relying on OS-level
 * permission tricks, which are unreliable when the test runner itself has root. */
export type WriteFileAtomic = (path: string, content: string) => void;

function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = join(dirname(path), `.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  const fd = openSync(tmpPath, "w");
  try {
    const buf = Buffer.from(content, "utf8");
    let written = 0;
    while (written < buf.byteLength) written += writeSync(fd, buf, written, buf.byteLength - written);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, path);
  const dfd = openSync(dirname(path), "r");
  try {
    fsyncSync(dfd);
  } finally {
    closeSync(dfd);
  }
}

function writeJsonAtomic(path: string, obj: Json, indent: string, write: WriteFileAtomic = writeAtomic): void {
  write(path, `${JSON.stringify(obj, null, indent)}\n`);
}

// ---------------------------------------------------------------------------------------------
// Backups — `<file>.glosa-backup-<UTC-ISO>`, skip if identical to the newest retained one, keep 5.
// ---------------------------------------------------------------------------------------------

function backupsFor(path: string): string[] {
  const dir = dirname(path);
  const base = `${path.split("/").pop()}.glosa-backup-`;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith(base))
    .map((f) => join(dir, f))
    .sort(); // ISO-8601 filenames sort chronologically
}

/** Backs up the CURRENT on-disk content of `path` before it's overwritten — a no-op (returns the
 * newest existing backup's path, no new file written) if that content is byte-identical to the
 * newest backup already on record (A6 §F26: "skip if identical to newest"). Prunes down to the 5
 * most recent afterward. Returns `null` only when there was nothing on disk to back up (a file
 * glosa is about to CREATE for the first time has no "before" state). */
function takeBackup(path: string, currentContent: string, now: Date, write: WriteFileAtomic = writeAtomic): string | null {
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
      // best-effort pruning
    }
  }
  return backupPath;
}

// ---------------------------------------------------------------------------------------------
// The desired hook/MCP shape (A6 §F26's exact hook entries + matchers).
// ---------------------------------------------------------------------------------------------

interface DesiredHook {
  event: string;
  matcher?: string;
  /** The stable identity a hook is recognized/reconciled BY — one of the literal `glosa hook
   * <role>` suffixes (session-start/rewake-watch/session-end/user-prompt-submit/stop/
   * notification). Never derived from `command` at read time (that would defeat the whole point
   * — `command` is exactly what CHANGES across a GLOSA_BIN swap). */
  role: string;
  command: string;
  timeout: number;
  asyncRewake?: boolean;
}

function desiredHooks(bin: GlosaBinResolution): DesiredHook[] {
  const SESSION_START_MATCHER = "startup|resume|clear|compact";
  return [
    {
      event: "SessionStart",
      matcher: SESSION_START_MATCHER,
      role: "session-start",
      command: binCommandString(bin, "hook", "session-start"),
      timeout: 10,
    },
    {
      event: "SessionStart",
      matcher: SESSION_START_MATCHER,
      role: "rewake-watch",
      command: binCommandString(bin, "hook", "rewake-watch"),
      timeout: 0,
      asyncRewake: true,
    },
    { event: "SessionEnd", role: "session-end", command: binCommandString(bin, "hook", "session-end"), timeout: 5 },
    { event: "UserPromptSubmit", role: "user-prompt-submit", command: binCommandString(bin, "hook", "user-prompt-submit"), timeout: 10 },
    { event: "Stop", role: "stop", command: binCommandString(bin, "hook", "stop"), timeout: 10 },
    { event: "Notification", role: "notification", command: binCommandString(bin, "hook", "notification"), timeout: 5 },
  ];
}

/** A6 §F26's in-band ownership signature — EXTENDED (P4.3 review fix) to recognize BOTH GLOSA_BIN
 * forms, not just the bare-`glosa` one: a command literally starting `glosa hook ` (path mode),
 * OR the no-build-step fallback `bun run --silent <anything>/packages/cli/src/main.ts hook
 * <role>` (bun-run mode). Matching the `main.ts` path suffix rather than a specific glosaRoot is
 * deliberate — this is what lets a REINSTALL at a different glosaRoot still recognize its own
 * prior hooks. Returns the recognized `<role>` suffix, or `null` for anything else (a foreign
 * tool's command never matches either form). */
const HOOK_ROLE_RE = /^(?:glosa hook (\S+)|bun run --silent \S*packages\/cli\/src\/main\.ts hook (\S+))$/;

function hookRoleOf(command: unknown): string | null {
  if (typeof command !== "string") return null;
  const m = command.match(HOOK_ROLE_RE);
  if (!m) return null;
  return (m[1] ?? m[2]) as string;
}

function desiredMcpEntry(bin: GlosaBinResolution): Json {
  return { type: "stdio", command: bin.command, args: [...bin.args, "mcp"] };
}

interface InsertedNode {
  pointer: string;
  sha256: string;
}

interface MergeResult {
  changed: boolean;
  inserted: InsertedNode[];
}

/** Idempotent-by-ROLE reconciliation (A6 §F26, P4.3 review fix #1). A hook already present
 * anywhere under its event — found by `hookRoleOf(entry.command)` matching this desired hook's
 * `role`, NOT by matching the CURRENT `command` string — is updated IN PLACE if its content has
 * drifted (a GLOSA_BIN change: version bump, or a global `glosa` install/removal flipping path-
 * mode vs bun-run-mode) rather than appended as a duplicate; identical content is left untouched.
 * A genuinely new role is appended into the matching matcher-group (creating one if none exists
 * yet). Any hook whose command does NOT match glosa's in-band signature is never inspected beyond
 * that one `hookRoleOf` check, so a foreign sibling — even sitting in the same matcher-group — is
 * never at risk of being read as ours or mutated. */
function mergeSettingsHooks(root: Json, hooks: DesiredHook[]): MergeResult {
  const inserted: InsertedNode[] = [];
  let changed = false;
  root.hooks ??= {};
  const hooksObj = root.hooks as Json;

  for (const h of hooks) {
    hooksObj[h.event] ??= [];
    const groups = hooksObj[h.event] as Json[];

    const desiredEntry: Json = { type: "command", command: h.command, timeout: h.timeout };
    if (h.asyncRewake) desiredEntry.asyncRewake = true;

    // Pass 1 — role match (the reconciliation fix): finds an existing hook regardless of what
    // its `command` currently says, as long as it carries OUR signature for this exact role.
    // Pass 2 — exact-command fallback, only consulted when pass 1 finds nothing: covers a
    // command string that doesn't match `HOOK_ROLE_RE` (some future/unanticipated GLOSA_BIN
    // shape) but is nonetheless byte-identical to what we'd write today — still idempotent, just
    // not reconcilable across a bin change the way a recognized signature is.
    let existingGroupIndex = -1;
    let existingHookIndex = -1;
    findExisting: for (let pass = 0; pass < 2; pass++) {
      for (let gi = 0; gi < groups.length; gi++) {
        const groupHooks = groups[gi]?.hooks;
        if (!Array.isArray(groupHooks)) continue;
        for (let hi = 0; hi < groupHooks.length; hi++) {
          const matches = pass === 0 ? hookRoleOf(groupHooks[hi]?.command) === h.role : groupHooks[hi]?.command === h.command;
          if (matches) {
            existingGroupIndex = gi;
            existingHookIndex = hi;
            break findExisting;
          }
        }
      }
    }

    if (existingGroupIndex !== -1) {
      const groupHooks = groups[existingGroupIndex]?.hooks as Json[];
      const existingEntry = groupHooks[existingHookIndex];
      const pointer = `/hooks/${h.event}/${existingGroupIndex}/hooks/${existingHookIndex}`;
      if (JSON.stringify(existingEntry) === JSON.stringify(desiredEntry)) {
        inserted.push({ pointer, sha256: sha256Of(existingEntry) }); // unchanged — still ours, still recorded
        continue;
      }
      groupHooks[existingHookIndex] = desiredEntry; // reconcile in place — same position, new content
      changed = true;
      inserted.push({ pointer, sha256: sha256Of(desiredEntry) });
      continue;
    }

    // Not present anywhere under this event — a fresh insert.
    let group = groups.find((g) => (g.matcher ?? undefined) === (h.matcher ?? undefined));
    if (!group) {
      group = h.matcher !== undefined ? { matcher: h.matcher, hooks: [] } : { hooks: [] };
      groups.push(group);
    }
    (group.hooks as Json[]).push(desiredEntry);
    changed = true;

    const groupIndex = groups.indexOf(group);
    const hookIndex = (group.hooks as Json[]).length - 1;
    inserted.push({ pointer: `/hooks/${h.event}/${groupIndex}/hooks/${hookIndex}`, sha256: sha256Of(desiredEntry) });
  }

  return { changed, inserted };
}

interface McpMergeResult extends MergeResult {
  conflict: boolean;
}

/** Idempotent-by-key insert. `owned` (from the manifest, not the file itself — files carry no
 * marker) is what lets a repeat init recognize "this `glosa` entry is ours, safe to reconcile"
 * versus "someone else's `glosa`-named server, don't touch it without `--force`" (A6 §F26). */
function mergeMcp(root: Json, bin: GlosaBinResolution, opts: { force: boolean; owned: boolean }): McpMergeResult {
  root.mcpServers ??= {};
  const servers = root.mcpServers as Json;
  const desired = desiredMcpEntry(bin);
  const existing = servers.glosa;

  if (existing !== undefined) {
    if (JSON.stringify(existing) === JSON.stringify(desired)) return { changed: false, inserted: [], conflict: false };
    if (!opts.owned && !opts.force) return { changed: false, inserted: [], conflict: true };
  }

  servers.glosa = desired;
  return { changed: true, inserted: [{ pointer: "/mcpServers/glosa", sha256: sha256Of(desired) }], conflict: false };
}

// ---------------------------------------------------------------------------------------------
// The ownership manifest (`.claude/.glosa-init.json`) — glosa's own authoritative record.
// ---------------------------------------------------------------------------------------------

interface FileManifest {
  path: string;
  created: boolean;
  backup: string | null;
  inserted: InsertedNode[];
}

export interface OwnershipManifest {
  version: 1;
  glosa_bin: GlosaBinResolution;
  files: { settings: FileManifest; mcp: FileManifest };
}

function readManifest(path: string): OwnershipManifest | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as OwnershipManifest;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// The whole-transaction lock (P4.3 concurrency review fix #6). `runInit`/`runUninstall` both do
// a read-merge-write over the SAME manifest file with no serialization between them — two
// concurrent `glosa init` (or init+uninstall) calls on one workspace can interleave so that
// PROCESS B reads the manifest before PROCESS A has finished writing it, computes its own merge
// against a now-stale view, and then overwrites A's manifest with one that's missing A's
// insertions entirely — a silent, permanent loss of ownership tracking (A6 §F26: "manifest =
// authoritative ownership"). Wrapping the ENTIRE read-merge-write sequence in one exclusive lock
// (same `openSync(path, 'wx')` primitive as `RewakeLeaseStore.tryAcquire`, A2 §F07) makes the two
// calls serialize instead of interleave — the second one simply sees the first's completed
// result before it starts its own read.
// ---------------------------------------------------------------------------------------------

const INIT_LOCK_STALE_MS = 30_000;
const INIT_LOCK_WAIT_MS = 10_000; // generous — local fs ops are fast; only a hung/crashed concurrent run should ever hit this
const INIT_LOCK_POLL_MS = 20;

interface LockRecord {
  pid: number;
  started: string;
}

async function withWorkspaceLock<T>(manifestPath: string, now: () => Date, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${manifestPath}.lock`;
  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = now().getTime() + INIT_LOCK_WAIT_MS;

  for (;;) {
    try {
      const fd = openSync(lockPath, "wx");
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, started: now().toISOString() } satisfies LockRecord));
      } finally {
        closeSync(fd);
      }
      break; // won it
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;

      let existing: LockRecord | null = null;
      try {
        existing = JSON.parse(readFileSync(lockPath, "utf8")) as LockRecord;
      } catch {
        // corrupt/unreadable lock file — treat exactly like a stale one, below
      }
      const isStale = existing === null || now().getTime() - new Date(existing.started).getTime() > INIT_LOCK_STALE_MS;
      if (isStale) {
        safeUnlink(lockPath);
        continue; // retry the exclusive create immediately
      }
      if (now().getTime() > deadline) {
        throw new Error(`glosa init: another init/uninstall is already running for this workspace (lock: ${lockPath}) — try again shortly`);
      }
      await Bun.sleep(INIT_LOCK_POLL_MS);
    }
  }

  try {
    return await fn();
  } finally {
    safeUnlink(lockPath);
  }
}

// ---------------------------------------------------------------------------------------------
// runInit
// ---------------------------------------------------------------------------------------------

export interface InitOptions {
  dir: string;
  print?: boolean;
  force?: boolean;
  glosaRoot?: string;
  now?: () => Date;
  resolveGlosaBin?: (glosaRoot: string) => GlosaBinResolution;
  /** Test-only seam — see `WriteFileAtomic`'s docstring. Defaults to the real atomic writer. */
  writeFileAtomic?: WriteFileAtomic;
}

export interface InitFileResult {
  path: string;
  created: boolean;
  changed: boolean;
  backedUp: boolean;
}

export interface InitData {
  files: { settings: InitFileResult; mcp: InitFileResult };
  channel_command: string;
  glosa_bin: GlosaBinResolution;
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

function defaultGlosaRoot(): string {
  // packages/cli/src/init.ts -> repo root is three levels up.
  return join(dirname(new URL(import.meta.url).pathname), "..", "..", "..");
}

function paths(dir: string) {
  const claudeDir = join(dir, ".claude");
  return {
    settingsPath: join(claudeDir, "settings.json"),
    mcpPath: join(dir, ".mcp.json"),
    manifestPath: join(claudeDir, ".glosa-init.json"),
  };
}

function unifiedDiff(path: string, before: string | null, after: string): string {
  const beforeLines = before === null ? [] : before.split("\n");
  const afterLines = after.split("\n");
  const header = `--- ${before === null ? "/dev/null" : path}\n+++ ${path}\n`;
  const removed = beforeLines.map((l) => `-${l}`).join("\n");
  const added = afterLines.map((l) => `+${l}`).join("\n");
  return header + (removed.length > 0 ? `${removed}\n` : "") + `${added}\n`;
}

/** The exported entry point — just the whole-transaction lock (P4.3 concurrency review fix #6)
 * wrapped around the real implementation below. Two concurrent `runInit` calls for the SAME
 * workspace now serialize: the second one's read-merge-write only ever starts once the first's
 * has fully landed (including the manifest write), so neither can ever overwrite the other's
 * ownership records with a stale view. */
export async function runInit(opts: InitOptions): Promise<InitResult> {
  const now = opts.now ?? (() => new Date());
  const { manifestPath } = paths(opts.dir);
  return withWorkspaceLock(manifestPath, now, () => runInitLocked(opts, now));
}

async function runInitLocked(opts: InitOptions, now: () => Date): Promise<InitResult> {
  const glosaRoot = opts.glosaRoot ?? defaultGlosaRoot();
  const bin = (opts.resolveGlosaBin ?? defaultResolveGlosaBin)(glosaRoot);
  const write = opts.writeFileAtomic ?? writeAtomic;
  const { settingsPath, mcpPath, manifestPath } = paths(opts.dir);

  const emptyData = (): InitData => ({
    files: {
      settings: { path: settingsPath, created: false, changed: false, backedUp: false },
      mcp: { path: mcpPath, created: false, changed: false, backedUp: false },
    },
    channel_command: CHANNEL_COMMAND,
    glosa_bin: bin,
  });

  let settingsParsed: ParsedFile;
  let mcpParsed: ParsedFile;
  try {
    settingsParsed = parseJsonFile(settingsPath);
    mcpParsed = parseJsonFile(mcpPath);
  } catch (err) {
    const e = err as InvalidJsonError;
    return {
      ok: false,
      exitCode: 6,
      changed: false,
      data: emptyData(),
      warnings: [],
      error: { code: "invalid-json", kind: "foreign_config_conflict", message: e.message, hint: "fix the JSON syntax error, or remove the file, then re-run `glosa init`" },
    };
  }

  const existingManifest = readManifest(manifestPath);
  const mcpOwned = existingManifest?.files.mcp.inserted.some((i) => i.pointer === "/mcpServers/glosa") ?? false;

  const settingsMerge = mergeSettingsHooks(settingsParsed.obj, desiredHooks(bin));
  const mcpMerge = mergeMcp(mcpParsed.obj, bin, { force: opts.force ?? false, owned: mcpOwned });

  if (mcpMerge.conflict) {
    return {
      ok: false,
      exitCode: 6,
      changed: false,
      data: emptyData(),
      warnings: [],
      error: {
        code: "mcp-key-conflict",
        kind: "foreign_config_conflict",
        message: `${mcpPath}: an existing "glosa" MCP server entry was not created by glosa`,
        hint: "pass --force to overwrite it",
      },
    };
  }

  const anyChanged = settingsMerge.changed || mcpMerge.changed;

  if (opts.print) {
    // Each file's diff is gated on ITS OWN `merge.changed` — not `anyChanged` (P4.3 review fix
    // #3: `anyChanged` is `settingsMerge.changed || mcpMerge.changed`, so gating on it alone made
    // an UNCHANGED file's diff a tautology — an mcp-only change used to still print a spurious
    // reformatted before/after diff for settings.json). A file with nothing to change gets no
    // diff section at all.
    let diff = "";
    if (settingsMerge.changed) {
      diff += unifiedDiff(settingsPath, settingsParsed.raw, `${JSON.stringify(settingsParsed.obj, null, settingsParsed.indent)}\n`);
    }
    if (mcpMerge.changed) {
      diff += unifiedDiff(mcpPath, mcpParsed.raw, `${JSON.stringify(mcpParsed.obj, null, mcpParsed.indent)}\n`);
    }
    return { ok: true, exitCode: 0, changed: anyChanged, data: emptyData(), diff, warnings: [] };
  }

  if (!anyChanged) {
    return { ok: true, exitCode: 0, changed: false, data: emptyData(), warnings: [] };
  }

  // --- transactional write: settings -> mcp -> manifest. Every write pushes an undo action BEFORE
  // moving to the next file, so a failure at any point (including the manifest write itself)
  // rolls back everything this run actually touched, in reverse order (A6 §F26: "no half-install").
  const undo: (() => void)[] = [];
  const fileResults: { settings: FileManifest; mcp: FileManifest } = {
    settings: existingManifest?.files.settings ?? { path: settingsPath, created: false, backup: null, inserted: [] },
    mcp: existingManifest?.files.mcp ?? { path: mcpPath, created: false, backup: null, inserted: [] },
  };
  const summary: InitData = emptyData();

  try {
    if (settingsMerge.changed) {
      const created = settingsParsed.raw === null;
      const at = now();
      let backup: string | null = fileResults.settings.backup;
      if (!created) backup = takeBackup(settingsPath, settingsParsed.raw as string, at, write);
      writeJsonAtomic(settingsPath, settingsParsed.obj, settingsParsed.indent, write);
      undo.push(() => (created ? unlinkSync(settingsPath) : writeAtomic(settingsPath, settingsParsed.raw as string)));
      // Dedupe by pointer, new record wins (same fix as mcp's `carried` below): a RECONCILED
      // hook (same pointer, updated content after a GLOSA_BIN change) must replace its old
      // manifest record, never accumulate alongside it — a stale duplicate would make uninstall
      // hash-check the SAME pointer twice against two different recorded hashes.
      const carried = fileResults.settings.inserted.filter((i) => !settingsMerge.inserted.some((n) => n.pointer === i.pointer));
      fileResults.settings = {
        path: settingsPath,
        created: created || fileResults.settings.created,
        backup,
        inserted: [...carried, ...settingsMerge.inserted],
      };
      summary.files.settings = { path: settingsPath, created, changed: true, backedUp: !created };
    }

    if (mcpMerge.changed) {
      const created = mcpParsed.raw === null;
      const at = now();
      let backup: string | null = fileResults.mcp.backup;
      if (!created) backup = takeBackup(mcpPath, mcpParsed.raw as string, at, write);
      writeJsonAtomic(mcpPath, mcpParsed.obj, mcpParsed.indent, write);
      undo.push(() => (created ? unlinkSync(mcpPath) : writeAtomic(mcpPath, mcpParsed.raw as string)));
      // Re-insertion (owned, drifted content) replaces the prior pointer record rather than
      // accumulating duplicates for the same pointer.
      const carried = fileResults.mcp.inserted.filter((i) => !mcpMerge.inserted.some((n) => n.pointer === i.pointer));
      fileResults.mcp = {
        path: mcpPath,
        created: created || fileResults.mcp.created,
        backup,
        inserted: [...carried, ...mcpMerge.inserted],
      };
      summary.files.mcp = { path: mcpPath, created, changed: true, backedUp: !created };
    }

    const manifest: OwnershipManifest = { version: 1, glosa_bin: bin, files: fileResults };
    writeJsonAtomic(manifestPath, manifest, "  ", write);

    return { ok: true, exitCode: 0, changed: true, data: summary, warnings: [] };
  } catch (err) {
    for (const step of undo.reverse()) {
      try {
        step();
      } catch {
        // best-effort — the original error below is what gets reported either way
      }
    }
    return {
      ok: false,
      exitCode: 70,
      changed: false,
      data: emptyData(),
      warnings: [],
      error: { code: "internal", kind: "internal", message: (err as Error).message },
    };
  }
}

// ---------------------------------------------------------------------------------------------
// runUninstall — per recorded node, re-hash current vs recorded: match -> remove + prune empty
// parents; mismatch (externally edited) -> leave + warn + exit 9. A `created:true` file left
// empty is deleted outright. Manifest is deleted only on a fully clean removal.
// ---------------------------------------------------------------------------------------------

export interface UninstallResult {
  ok: boolean;
  exitCode: number;
  removed: string[];
  warnings: { code: string; message: string }[];
  error?: { code: string; kind: string; message: string };
}

export interface UninstallOptions {
  dir: string;
  /** Test-only seam — same contract as `InitOptions.writeFileAtomic`. Defaults to the real
   * atomic writer. */
  writeFileAtomic?: WriteFileAtomic;
}

/** Transactional, same discipline as `runInit` (P4.3 review fix #4 — an earlier revision had no
 * rollback here at all: a write failure on the SECOND file left the first one permanently
 * modified, with no structured error or exit code). Every file this run actually touches (a
 * content rewrite OR a delete) pushes an undo action BEFORE the mutation happens; any exception
 * anywhere in the sequence — including the final manifest write/delete — rolls every one of them
 * back to its exact pre-run bytes, in reverse order, and reports `exitCode: 70` rather than
 * leaving a half-uninstalled workspace. Wrapped in the SAME whole-transaction lock `runInit` uses
 * (P4.3 concurrency review fix #6) — an `init` and an `uninstall` racing on one workspace's
 * manifest is the identical hazard, just with a different pair of callers. */
export async function runUninstall(opts: UninstallOptions): Promise<UninstallResult> {
  const { manifestPath } = paths(opts.dir);
  return withWorkspaceLock(manifestPath, () => new Date(), () => runUninstallLocked(opts));
}

async function runUninstallLocked(opts: UninstallOptions): Promise<UninstallResult> {
  const { settingsPath, mcpPath, manifestPath } = paths(opts.dir);
  const write = opts.writeFileAtomic ?? writeAtomic;
  const manifest = readManifest(manifestPath);
  if (!manifest) {
    return { ok: true, exitCode: 0, removed: [], warnings: [{ code: "no-manifest", message: "no glosa init manifest found — nothing to uninstall" }] };
  }

  const removed: string[] = [];
  const warnings: { code: string; message: string }[] = [];
  const undo: (() => void)[] = [];
  let anyMismatch = false;
  const onMismatch = (msg: string) => {
    anyMismatch = true;
    warnings.push({ code: "external-edit", message: msg });
  };

  try {
    const settingsOutcome = uninstallFile(settingsPath, manifest.files.settings, removed, onMismatch, write, undo);
    const mcpOutcome = uninstallFile(mcpPath, manifest.files.mcp, removed, onMismatch, write, undo);

    if (!anyMismatch) {
      if (existsSync(manifestPath)) {
        const originalManifestRaw = readFileSync(manifestPath, "utf8");
        undo.push(() => writeAtomic(manifestPath, originalManifestRaw));
      }
      safeUnlink(manifestPath);
    } else {
      const originalManifestRaw = existsSync(manifestPath) ? readFileSync(manifestPath, "utf8") : null;
      undo.push(() =>
        originalManifestRaw !== null ? writeAtomic(manifestPath, originalManifestRaw) : safeUnlink(manifestPath),
      );
      const survivingManifest: OwnershipManifest = { version: 1, glosa_bin: manifest.glosa_bin, files: { settings: settingsOutcome, mcp: mcpOutcome } };
      writeJsonAtomic(manifestPath, survivingManifest, "  ", write);
    }

    return { ok: !anyMismatch, exitCode: anyMismatch ? 9 : 0, removed, warnings };
  } catch (err) {
    for (const step of undo.reverse()) {
      try {
        step();
      } catch {
        // best-effort — the original error below is what gets reported either way
      }
    }
    return {
      ok: false,
      exitCode: 70,
      removed: [],
      warnings: [],
      error: { code: "internal", kind: "internal", message: (err as Error).message },
    };
  }
}

// ---------------------------------------------------------------------------------------------
// checkManifestDrift — P5.1's `glosa doctor` "hooks manifest hash match/drift" check (A6 §F30).
// Read-only: reuses the EXACT same hash-compare `runUninstallLocked`/`uninstallFile` already do
// before removing anything, just without ever touching disk — so doctor's drift verdict can never
// silently disagree with what an actual `glosa init --uninstall` would do.
// ---------------------------------------------------------------------------------------------

export interface ManifestDriftResult {
  manifest: OwnershipManifest | null;
  /** Human-readable `<path><pointer>` (or `<path> (reason)`) strings for every recorded node that
   * no longer matches what glosa wrote — empty when the manifest is `null` (nothing to check) or
   * everything still matches. */
  drifted: string[];
}

export function checkManifestDrift(dir: string): ManifestDriftResult {
  const { settingsPath, mcpPath, manifestPath } = paths(dir);
  const manifest = readManifest(manifestPath);
  if (!manifest) return { manifest: null, drifted: [] };

  const drifted: string[] = [];
  for (const [path, fileManifest] of [
    [settingsPath, manifest.files.settings],
    [mcpPath, manifest.files.mcp],
  ] as const) {
    if (!existsSync(path)) {
      if (fileManifest.inserted.length > 0) drifted.push(...fileManifest.inserted.map((n) => `${path}${n.pointer} (file missing)`));
      continue;
    }
    let obj: Json;
    try {
      obj = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      drifted.push(`${path} (invalid JSON)`);
      continue;
    }
    for (const node of fileManifest.inserted) {
      const resolved = resolvePointer(obj, node.pointer);
      if (!resolved.found || sha256Of(resolved.value) !== node.sha256) {
        drifted.push(`${path}${node.pointer}`);
      }
    }
  }
  return { manifest, drifted };
}

function safeUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
}

function uninstallFile(
  path: string,
  fileManifest: FileManifest,
  removed: string[],
  onMismatch: (msg: string) => void,
  write: WriteFileAtomic,
  undo: (() => void)[],
): FileManifest {
  if (!existsSync(path)) return { ...fileManifest, inserted: [] };

  const originalRaw = readFileSync(path, "utf8");
  let obj: Json;
  try {
    obj = JSON.parse(originalRaw);
  } catch {
    onMismatch(`${path}: not valid JSON — leaving untouched`);
    return fileManifest;
  }

  const toRemove: InsertedNode[] = [];
  const surviving: InsertedNode[] = [];
  for (const node of fileManifest.inserted) {
    const resolved = resolvePointer(obj, node.pointer);
    if (!resolved.found) continue; // already gone — nothing to do, not a mismatch
    if (sha256Of(resolved.value) === node.sha256) {
      toRemove.push(node);
    } else {
      surviving.push(node);
      onMismatch(`${path}${node.pointer}: modified since glosa installed it — left in place`);
    }
  }

  if (toRemove.length === 0) return { ...fileManifest, inserted: surviving };

  // Highest array-index-first (NOT string length — two single-digit indices produce
  // equal-length pointers, e.g. SessionStart's `.../hooks/0` and `.../hooks/1`): splicing index 0
  // out of a 2-element array shifts what WAS index 1 down to index 0, so a later splice(1, 1)
  // against a stale index would silently no-op and leave that sibling behind. Sorting by the
  // pointer's own trailing numeric segment, descending, removes every array's highest index
  // first — safe regardless of how many siblings share one array or how many distinct arrays are
  // involved (a splice in one array never touches another's indices).
  const byIndexDesc = [...toRemove].sort((a, b) => trailingIndexOf(b.pointer) - trailingIndexOf(a.pointer));
  for (const node of byIndexDesc) removeAtPointer(obj, node.pointer);
  pruneEmpty(obj);

  const nowEmpty = Object.keys(obj).length === 0;
  // Undo pushed BEFORE the mutation happens — the exact "restore this file's pre-run bytes"
  // action `runInit`'s own rollback uses, whether this run ends up deleting the file (created +
  // now empty) or rewriting it in place.
  undo.push(() => writeAtomic(path, originalRaw));
  if (fileManifest.created && nowEmpty) {
    unlinkSync(path);
  } else {
    writeJsonAtomic(path, obj, detectIndent(originalRaw), write);
  }
  removed.push(...toRemove.map((n) => `${path}${n.pointer}`));
  return { ...fileManifest, inserted: surviving };
}

function trailingIndexOf(pointer: string): number {
  const last = pointer.split("/").pop() as string;
  return /^\d+$/.test(last) ? Number(last) : -1;
}

function removeAtPointer(root: Json, pointer: string): void {
  const parts = pointer.split("/").filter((p) => p.length > 0);
  const last = parts.pop() as string;
  let cur = root;
  for (const part of parts) {
    cur = Array.isArray(cur) && /^\d+$/.test(part) ? cur[Number(part)] : cur[part];
    if (cur === undefined) return;
  }
  if (Array.isArray(cur)) cur.splice(Number(last), 1);
  else delete cur[last];
}

/** Structural cleanup after a removal: an empty hook-group `{hooks:[]}` is dropped from its
 * event's array; an event whose array is now empty is dropped from `hooks`; an empty `hooks`
 * object is dropped from the root; an empty `mcpServers` is dropped from the root. */
function pruneEmpty(root: Json): void {
  if (root.hooks && typeof root.hooks === "object") {
    for (const event of Object.keys(root.hooks)) {
      const groups = root.hooks[event];
      if (!Array.isArray(groups)) continue;
      root.hooks[event] = groups.filter((g: Json) => Array.isArray(g.hooks) && g.hooks.length > 0);
      if (root.hooks[event].length === 0) delete root.hooks[event];
    }
    if (Object.keys(root.hooks).length === 0) delete root.hooks;
  }
  if (root.mcpServers && typeof root.mcpServers === "object" && Object.keys(root.mcpServers).length === 0) {
    delete root.mcpServers;
  }
}

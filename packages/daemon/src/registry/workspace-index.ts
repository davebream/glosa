// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — the global workspace index (A5 §F19): `<GLOSA_HOME>/workspaces.json`. Tracks
// every workspace glosa has ever seen (across every provider session, `glosa open`, or a
// discovered `.glosa/` dir), keyed by canonical path. Daemon is the SOLE writer, serialized by
// ONE in-process async mutex, atomic temp -> fsync -> rename — no consumer (CLI/hooks/MCP) ever
// writes this file directly; they mutate through the daemon (F19). This is also the fix for the
// F08 session-registration race: slug assignment happens under the SAME mutex critical section
// as the upsert that records it, so two concurrent registrations for different workspaces can
// never observe (or assign) a torn/duplicate slug.
import { createHash } from "node:crypto";
import {
  accessSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeSync,
} from "node:fs";
import { constants as fsConstants } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fsyncContainingDir } from "../bus/io.ts";
import { AsyncMutex } from "../bus/mutex.ts";
import { glosaHome } from "../home.ts";
import { resolveTrackedFiles } from "../matcher.ts";
import type { WorkspaceKind, WorkspaceLocation, WorkspaceTracking } from "../workspace.ts";
import { assignSlug, type SlugDeps } from "./slug.ts";

export type WorkspaceSource = "session" | "glosa-open" | "discovered";

export interface WorkspaceEntry extends WorkspaceLocation {
  canonical_path: string;
  registration_id: string;
  kind: WorkspaceKind;
  worktree_path: string;
  bus_path: string;
  tracking: WorkspaceTracking;
  file_identity?: { dev: string; ino: string };
  slug: string;
  slug_len: number;
  source: WorkspaceSource;
  first_seen: string;
  last_seen: string;
  present: boolean;
  /** Set the moment `present` flips false — the GC grace-period clock starts here, not at
   * "whenever GC happens to notice." Cleared if the workspace comes back present. */
  absent_since?: string;
}

export interface WorkspaceIndexFile {
  version: 2;
  updated_at: string;
  workspaces: Record<string, WorkspaceEntry>;
}

interface LegacyWorkspaceEntry {
  canonical_path: string;
  slug: string;
  slug_len: number;
  source: WorkspaceSource;
  first_seen: string;
  last_seen: string;
  present: boolean;
  absent_since?: string;
}

interface LegacyWorkspaceIndexFile {
  version: 1;
  updated_at: string;
  workspaces: Record<string, LegacyWorkspaceEntry>;
}

export interface WorkspaceOpenResult {
  entry: WorkspaceEntry;
  focus?: string;
}

export class WorkspaceOpenError extends Error {
  constructor(
    readonly code: "invalid-path" | "artifact-not-tracked" | "unsupported-file",
    message: string,
  ) {
    super(message);
  }
}

export function workspaceIndexPath(home: string): string {
  return join(home, "workspaces.json");
}

/** Path for the pre-daemon O_EXCL fallback lease (A4 "Registry-write serialization") that guards
 * this same file when a hook must write it directly because the daemon is unreachable. */
export function fallbackWorkspacesLockPath(home: string): string {
  return join(home, ".workspaces.lock");
}

function isLegacyWorkspaceEntryShape(v: unknown): v is LegacyWorkspaceEntry {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.canonical_path === "string" &&
    typeof e.slug === "string" &&
    typeof e.slug_len === "number" &&
    typeof e.source === "string" &&
    typeof e.first_seen === "string" &&
    typeof e.last_seen === "string" &&
    typeof e.present === "boolean"
  );
}

function isTrackingShape(v: unknown): v is WorkspaceTracking {
  if (typeof v !== "object" || v === null) return false;
  const tracking = v as Record<string, unknown>;
  return (
    tracking.mode === "matcher" ||
    (tracking.mode === "bounded" &&
      Array.isArray(tracking.paths) &&
      tracking.paths.every((path) => typeof path === "string"))
  );
}

function isWorkspaceEntryShape(v: unknown): v is WorkspaceEntry {
  if (!isLegacyWorkspaceEntryShape(v)) return false;
  const e = v as unknown as Record<string, unknown>;
  return (
    typeof e.registration_id === "string" &&
    (e.kind === "directory" || e.kind === "loose-file") &&
    typeof e.worktree_path === "string" &&
    isAbsolute(e.worktree_path) &&
    typeof e.bus_path === "string" &&
    isAbsolute(e.bus_path) &&
    isTrackingShape(e.tracking)
  );
}

function isWorkspaceIndexShape(v: unknown): v is WorkspaceIndexFile {
  if (typeof v !== "object" || v === null) return false;
  const f = v as Record<string, unknown>;
  if (
    f.version !== 2 ||
    typeof f.updated_at !== "string" ||
    typeof f.workspaces !== "object" ||
    f.workspaces === null
  ) {
    return false;
  }
  return Object.values(f.workspaces as Record<string, unknown>).every(isWorkspaceEntryShape);
}

function isLegacyWorkspaceIndexShape(v: unknown): v is LegacyWorkspaceIndexFile {
  if (typeof v !== "object" || v === null) return false;
  const f = v as Record<string, unknown>;
  return (
    f.version === 1 &&
    typeof f.updated_at === "string" &&
    typeof f.workspaces === "object" &&
    f.workspaces !== null &&
    Object.values(f.workspaces as Record<string, unknown>).every(isLegacyWorkspaceEntryShape)
  );
}

function registrationId(kind: WorkspaceKind, canonicalPath: string): string {
  return createHash("sha256").update(`${kind}\0${canonicalPath}`).digest("hex");
}

function redirectedBusPath(home: string, id: string): string {
  return join(home, "state", id);
}

function canonicalPath(path: string): string {
  const real = realpathSync(path).normalize("NFC");
  return real.length > 1 && real.endsWith("/") ? real.slice(0, -1) : real;
}

function relativeNfc(root: string, path: string): string {
  return relative(root, path)
    .split(sep)
    .map((part) => part.normalize("NFC"))
    .join("/");
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function bigintIdentity(path: string): { dev: string; ino: string } {
  const stat = statSync(path, { bigint: true });
  return { dev: stat.dev.toString(), ino: stat.ino.toString() };
}

function sameIdentity(a: { dev: string; ino: string }, b: { dev: string; ino: string }): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

// A5 §F19: "GC (on start + throttled ≥60s)"; "hard-remove only ... present:false ≥ grace period."
// Neither number is pinned by the spec — both are conservative defaults, overridable via deps
// (tests inject small values so the grace/throttle windows don't require real wall-clock waits).
const DEFAULT_GC_GRACE_MS = 24 * 60 * 60 * 1000; // 24h
const DEFAULT_GC_THROTTLE_MS = 60_000; // 60s

export interface WorkspaceIndexDeps {
  home?: string;
  now?: () => Date;
  mutex?: AsyncMutex;
  gcGraceMs?: number;
  gcThrottleMs?: number;
  /** Does `canonicalPath` currently have a live session bound to it? Consulted only by GC's
   * hard-remove check — a live session is proof the workspace still matters no matter how long
   * its path has been missing. Defaults to "no live session" so a standalone `WorkspaceIndex`
   * (as used in most of this file's own tests) works without a `SessionRegistry`; production
   * wiring calls `setLiveSessionPredicate` once both are constructed (see session-registry.ts's
   * module docstring for the wiring snippet). */
  hasLiveSession?: (canonicalPath: string) => boolean;
  /** Does `canonicalPath` currently exist on disk? Defaults to `existsSync`; injectable so GC
   * tests don't need real directories on disk. */
  pathExists?: (canonicalPath: string) => boolean;
  /** Can a fresh local bus be created beneath this directory? Defaults to an access(2)
   * write/search check; injectable for deterministic permission tests. Existing local buses are
   * authoritative and never consult this predicate. */
  canCreateLocalBus?: (canonicalPath: string) => boolean;
  /** Fired once for each canonical path GC actually hard-removes (never for a soft `present:false`
   * — only real removal from the index). Defaults to a no-op. Production wiring calls
   * `setOnHardRemove` once a `WorkspaceBusRegistry` exists — see `setOnHardRemove`'s own docstring
   * for the snippet — so a hard-removed workspace's open `WorkspaceBus` (journal fd, mutex slot,
   * in-memory state) is evicted in step, not leaked. */
  onHardRemove?: (canonicalPath: string) => void | Promise<void>;
  slug?: SlugDeps;
}

export interface GcResult {
  softened: string[];
  removed: string[];
}

export class WorkspaceIndex {
  private readonly path: string;
  private readonly home: string;
  private readonly mutex: AsyncMutex;
  private readonly now: () => Date;
  private readonly gcGraceMs: number;
  private readonly gcThrottleMs: number;
  private readonly pathExists: (canonicalPath: string) => boolean;
  private readonly canCreateLocalBus: (canonicalPath: string) => boolean;
  private readonly slugDeps: SlugDeps;
  private hasLiveSession: (canonicalPath: string) => boolean;
  // Whether SOMEONE (constructor deps or a later `setLiveSessionPredicate` call) ever actually
  // told this index whether live sessions exist. Distinct from `hasLiveSession` itself — a
  // default `() => false` predicate is indistinguishable from "genuinely wired to say never" once
  // it's just a function, so GC needs this separate flag to tell "wired, and the answer is no"
  // apart from "nobody wired anything yet."
  private liveSessionPredicateWired: boolean;
  private onHardRemove: (canonicalPath: string) => void | Promise<void>;
  private cache: WorkspaceIndexFile | null = null;
  private lastGcAt = -Infinity;

  constructor(deps: WorkspaceIndexDeps = {}) {
    this.home = deps.home ?? glosaHome();
    this.path = workspaceIndexPath(this.home);
    this.mutex = deps.mutex ?? new AsyncMutex();
    this.now = deps.now ?? (() => new Date());
    this.gcGraceMs = deps.gcGraceMs ?? DEFAULT_GC_GRACE_MS;
    this.gcThrottleMs = deps.gcThrottleMs ?? DEFAULT_GC_THROTTLE_MS;
    this.hasLiveSession = deps.hasLiveSession ?? (() => false);
    this.liveSessionPredicateWired = deps.hasLiveSession !== undefined;
    this.pathExists = deps.pathExists ?? existsSync;
    this.canCreateLocalBus =
      deps.canCreateLocalBus ??
      ((canonicalPath) => {
        try {
          accessSync(canonicalPath, fsConstants.W_OK | fsConstants.X_OK);
          return true;
        } catch {
          return false;
        }
      });
    this.onHardRemove = deps.onHardRemove ?? (() => {});
    this.slugDeps = deps.slug ?? {};
  }

  /** Wires in the predicate GC uses to never hard-remove a workspace under a live session.
   * Production callers set this once, right after constructing both this index and the
   * `SessionRegistry` that shares it — see session-registry.ts. Also flips `gc()` from its
   * unwired conservative mode (soft-delete only, see the constructor comment on
   * `liveSessionPredicateWired`) into real hard-remove-eligible mode. */
  setLiveSessionPredicate(fn: (canonicalPath: string) => boolean): void {
    this.hasLiveSession = fn;
    this.liveSessionPredicateWired = true;
  }

  /** Wires in the callback GC fires for each path it actually hard-removes. Production callers
   * set this once, right after constructing both this index and a `WorkspaceBusRegistry`:
   *   const busRegistry = new WorkspaceBusRegistry();
   *   index.setOnHardRemove((p) => busRegistry.evict(p));
   * Without this wired, a hard-removed workspace's `WorkspaceBus` (open journal fd, `KeyedMutex`
   * slot, in-memory state) would otherwise leak forever, and a later reuse of the same canonical
   * path would return that stale instance instead of a fresh one. */
  setOnHardRemove(fn: (canonicalPath: string) => void | Promise<void>): void {
    this.onHardRemove = fn;
  }

  private load(): WorkspaceIndexFile {
    if (this.cache) return this.cache;
    if (existsSync(this.path)) {
      let parsed: unknown;
      let valid = false;
      try {
        parsed = JSON.parse(readFileSync(this.path, "utf8"));
        valid = isWorkspaceIndexShape(parsed);
      } catch {
        valid = false;
      }
      if (valid) {
        this.cache = parsed as WorkspaceIndexFile;
        return this.cache;
      }
      if (isLegacyWorkspaceIndexShape(parsed)) {
        const migrated: WorkspaceIndexFile = {
          version: 2,
          updated_at: this.now().toISOString(),
          workspaces: {},
        };
        for (const legacy of Object.values(parsed.workspaces)) {
          const id = registrationId("directory", legacy.canonical_path);
          migrated.workspaces[id] = {
            ...legacy,
            registration_id: id,
            kind: "directory",
            worktree_path: legacy.canonical_path,
            bus_path: join(legacy.canonical_path, ".glosa"),
            tracking: { mode: "matcher" },
          };
        }
        this.persist(migrated);
        return migrated;
      }
      // Corrupt OR invalid-shape on-disk content is never silently discarded — mirrors A4 §F04's
      // journal.quarantine convention (a bad record is preserved for inspection, not erased). The
      // next persist() would otherwise overwrite it with no trace at all of what was lost
      // (glosa-open/discovered sources, softened-but-not-yet-GC'd history, ...).
      this.quarantineCorruptFile();
    }
    this.cache = { version: 2, updated_at: this.now().toISOString(), workspaces: {} };
    return this.cache;
  }

  /** Renames the corrupt/invalid-shape `workspaces.json` aside to `<path>.corrupt.<ISO-ts>`
   * before `load()` falls back to a fresh empty index. Uses the real wall clock (`new
   * Date().toISOString()`), deliberately NOT the injected `now` — this is a diagnostic artifact's
   * filename, not domain data, so it should record when the daemon actually noticed the
   * corruption. Best-effort: if the rename itself fails (e.g. a permissions issue), this logs and
   * moves on rather than blocking boot over a diagnostic nicety — losing the quarantine copy is
   * strictly worse than refusing to start, so it never throws. */
  private quarantineCorruptFile(): void {
    const quarantinePath = `${this.path}.corrupt.${new Date().toISOString()}`;
    try {
      renameSync(this.path, quarantinePath);
      console.warn(
        `glosa: ${this.path} was corrupt/unparseable — preserved at ${quarantinePath}; starting a fresh workspace index`,
      );
    } catch (err) {
      console.warn(
        `glosa: ${this.path} was corrupt/unparseable, and quarantining it also failed: ${(err as Error).message}`,
      );
    }
  }

  // P4.3: this daemon-side writer and the pre-daemon O_EXCL fallback (lockfile-fallback.ts's
  // `withFileLease`, guarding `fallbackWorkspacesLockPath`) do NOT currently coordinate — a hook
  // falling back to a direct write while the daemon is unreachable takes the fallback lease, but
  // `persist()` below never acquires it. That's fine today (zero production callers of the
  // fallback yet), but the task that wires the hook-side fallback caller MUST make both writers
  // share the SAME lease: either have `persist()` also wrap its temp->fsync->rename in
  // `withFileLease(fallbackWorkspacesLockPath(home), ...)`, or otherwise prove the two paths can
  // never run concurrently. Skipping this once the fallback has a real caller reopens exactly the
  // torn-write risk the O_EXCL lease exists to close. See the matching note in
  // lockfile-fallback.ts.

  /** Atomic temp -> fsync -> rename. Caller MUST already hold `this.mutex` — this only performs
   * the I/O, it doesn't serialize on its own (mirrors bus/inbox.ts's division of labor). */
  private persist(index: WorkspaceIndexFile): void {
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true });
    const tmpPath = join(dir, `.workspaces.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
    const bytes = Buffer.from(JSON.stringify(index, null, 2), "utf8");
    const fd = openSync(tmpPath, "wx");
    try {
      writeSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmpPath, this.path); // atomic on POSIX — replaces any previous file in one step
    fsyncContainingDir(this.path);
    this.cache = index;
  }

  /** Upserts a workspace entry. First sight of a canonical path assigns a slug (F25
   * collision-lengthening runs inside this same mutex critical section — "assign under
   * global-index lock"); an already-known path just refreshes `last_seen`/`present` and reuses
   * its existing slug unchanged (idempotent). This is the single place every session
   * registration, `glosa open`, and discovery sweep funnels through. */
  upsertWorkspace(canonicalPath: string, source: WorkspaceSource): Promise<WorkspaceEntry> {
    return this.mutex.runExclusive(() => {
      const index = this.load();
      const now = this.now().toISOString();
      const existing = Object.values(index.workspaces).find(
        (entry) => entry.kind === "directory" && entry.canonical_path === canonicalPath,
      );

      if (existing) {
        existing.last_seen = now;
        existing.present = true;
        delete existing.absent_since;
        index.updated_at = now;
        this.persist(index);
        return existing;
      }

      const id = registrationId("directory", canonicalPath);
      const existingSlugEntries = Object.values(index.workspaces).map((e) => ({
        canonicalPath: e.canonical_path,
        slug: e.slug,
        slugLen: e.slug_len,
      }));
      const { slug, slugLen } = assignSlug(canonicalPath, existingSlugEntries, this.slugDeps);
      const localBus = join(canonicalPath, ".glosa");
      let busPath = localBus;
      if (!existsSync(localBus) && !this.canCreateLocalBus(canonicalPath)) {
        busPath = redirectedBusPath(this.home, id);
      }

      const entry: WorkspaceEntry = {
        registration_id: id,
        kind: "directory",
        canonical_path: canonicalPath,
        worktree_path: canonicalPath,
        bus_path: busPath,
        tracking: { mode: "matcher" },
        slug,
        slug_len: slugLen,
        source,
        first_seen: now,
        last_seen: now,
        present: true,
      };
      index.workspaces[id] = entry;
      index.updated_at = now;
      this.persist(index);
      return entry;
    });
  }

  /** Resolves a raw `glosa open` target under the same global-index mutex that persists any new
   * registration. This closes the alias race: two concurrent hardlink opens cannot both observe
   * "no owner" and create divergent buses. `opts.focus` is an absolute or worktree-relative
   * artifact path for two-arg `glosa open <dir> <file>` — validated via confinement + tracked
   * membership after the directory registration is established. */
  resolveOpenTarget(
    rawPath: string,
    opts: { externalState?: boolean; focus?: string } = {},
  ): Promise<WorkspaceOpenResult> {
    return this.mutex.runExclusive(() => {
      let leafStat: ReturnType<typeof lstatSync>;
      try {
        leafStat = lstatSync(rawPath);
      } catch {
        throw new WorkspaceOpenError("invalid-path", "path does not exist");
      }
      if (leafStat.isSymbolicLink()) {
        throw new WorkspaceOpenError("unsupported-file", "symlinks cannot be opened as artifacts");
      }

      let canonical: string;
      try {
        canonical = canonicalPath(rawPath);
      } catch {
        throw new WorkspaceOpenError("invalid-path", "path could not be canonicalized");
      }

      const index = this.load();
      const now = this.now().toISOString();

      if (leafStat.isDirectory()) {
        const existing = Object.values(index.workspaces).find(
          (entry) => entry.kind === "directory" && entry.canonical_path === canonical,
        );
        let entry: WorkspaceEntry;
        if (existing) {
          existing.last_seen = now;
          existing.present = true;
          delete existing.absent_since;
          index.updated_at = now;
          this.persist(index);
          entry = existing;
        } else {
          const id = registrationId("directory", canonical);
          const localBus = join(canonical, ".glosa");
          let busPath = localBus;
          if (opts.externalState && !existsSync(localBus)) {
            busPath = redirectedBusPath(this.home, id);
          } else if (!existsSync(localBus) && !this.canCreateLocalBus(canonical)) {
            busPath = redirectedBusPath(this.home, id);
          }
          entry = this.createEntry(index, {
            registration_id: id,
            kind: "directory",
            canonical_path: canonical,
            worktree_path: canonical,
            bus_path: busPath,
            tracking: { mode: "matcher" },
            source: "glosa-open",
          });
        }

        if (opts.focus) {
          return { entry, focus: this.resolveFocusInEntry(entry, opts.focus) };
        }
        return { entry };
      }

      if (opts.focus) {
        throw new WorkspaceOpenError(
          "invalid-path",
          "focus is only valid when the open target is a directory",
        );
      }

      if (!leafStat.isFile()) {
        throw new WorkspaceOpenError("unsupported-file", "only regular files and directories can be opened");
      }

      const owning = Object.values(index.workspaces)
        .filter((entry) => entry.present && entry.kind === "directory" && isInside(entry.worktree_path, canonical))
        .sort((a, b) => b.worktree_path.length - a.worktree_path.length)[0];
      if (owning) {
        const matched = resolveTrackedFiles(owning).tracked.find(
          (file) => file.path === relativeNfc(owning.worktree_path, canonical),
        );
        if (!matched) {
          throw new WorkspaceOpenError(
            "artifact-not-tracked",
            "file is inside a registered workspace but excluded from its tracked artifact list",
          );
        }
        owning.last_seen = now;
        owning.present = true;
        delete owning.absent_since;
        index.updated_at = now;
        this.persist(index);
        return { entry: owning, focus: matched.path };
      }

      const identity = bigintIdentity(canonical);
      for (const entry of Object.values(index.workspaces)) {
        if (!entry.present) continue;
        for (const file of resolveTrackedFiles(entry).tracked) {
          try {
            if (sameIdentity(identity, bigintIdentity(file.rawPath))) {
              entry.last_seen = now;
              entry.present = true;
              delete entry.absent_since;
              index.updated_at = now;
              this.persist(index);
              return { entry, focus: file.path };
            }
          } catch {
            // A raced-away registered file cannot prove inode ownership; continue searching.
          }
        }
      }

      const worktree = canonicalPath(dirname(canonical));
      const focus = relativeNfc(worktree, canonical);
      const id = registrationId("loose-file", canonical);
      const entry = this.createEntry(index, {
        registration_id: id,
        kind: "loose-file",
        canonical_path: canonical,
        worktree_path: worktree,
        bus_path: redirectedBusPath(this.home, id),
        tracking: { mode: "bounded", paths: [focus] },
        file_identity: identity,
        source: "glosa-open",
      });
      return { entry, focus };
    });
  }

  /** Resolve an absolute or worktree-relative focus path against a directory registration:
   * must be an existing regular non-symlink file, confined under the worktree, and present in
   * the tracked-artifact list. */
  private resolveFocusInEntry(entry: WorkspaceEntry, rawFocus: string): string {
    const candidate = isAbsolute(rawFocus) ? rawFocus : join(entry.worktree_path, rawFocus);
    let focusStat: ReturnType<typeof lstatSync>;
    try {
      focusStat = lstatSync(candidate);
    } catch {
      throw new WorkspaceOpenError("invalid-path", "focus path does not exist");
    }
    if (focusStat.isSymbolicLink()) {
      throw new WorkspaceOpenError("unsupported-file", "symlinks cannot be opened as artifacts");
    }
    if (!focusStat.isFile()) {
      throw new WorkspaceOpenError("unsupported-file", "focus must be a regular file");
    }

    let focusCanonical: string;
    try {
      focusCanonical = canonicalPath(candidate);
    } catch {
      throw new WorkspaceOpenError("invalid-path", "focus path could not be canonicalized");
    }
    if (!isInside(entry.worktree_path, focusCanonical) && entry.worktree_path !== focusCanonical) {
      throw new WorkspaceOpenError("invalid-path", "focus path escapes the workspace");
    }

    const rel = relativeNfc(entry.worktree_path, focusCanonical);
    const matched = resolveTrackedFiles(entry).tracked.find((file) => file.path === rel);
    if (!matched) {
      throw new WorkspaceOpenError(
        "artifact-not-tracked",
        "focus file is not in the workspace tracked artifact list",
      );
    }
    return matched.path;
  }

  private createEntry(
    index: WorkspaceIndexFile,
    input: Pick<
      WorkspaceEntry,
      | "registration_id"
      | "kind"
      | "canonical_path"
      | "worktree_path"
      | "bus_path"
      | "tracking"
      | "file_identity"
      | "source"
    >,
  ): WorkspaceEntry {
    const now = this.now().toISOString();
    const existingSlugEntries = Object.values(index.workspaces).map((entry) => ({
      canonicalPath: entry.canonical_path,
      slug: entry.slug,
      slugLen: entry.slug_len,
    }));
    const { slug, slugLen } = assignSlug(input.canonical_path, existingSlugEntries, this.slugDeps);
    const entry: WorkspaceEntry = {
      ...input,
      slug,
      slug_len: slugLen,
      first_seen: now,
      last_seen: now,
      present: true,
    };
    index.workspaces[entry.registration_id] = entry;
    index.updated_at = now;
    this.persist(index);
    return entry;
  }

  getBySlug(slug: string): WorkspaceEntry | null {
    for (const entry of Object.values(this.load().workspaces)) {
      if (entry.slug === slug) return entry;
    }
    return null;
  }

  get(canonicalPath: string): WorkspaceEntry | null {
    const entries = Object.values(this.load().workspaces);
    return (
      entries.find((entry) => entry.canonical_path === canonicalPath) ??
      entries.find((entry) => entry.kind === "directory" && entry.worktree_path === canonicalPath) ??
      null
    );
  }

  list(opts: { presentOnly?: boolean } = {}): WorkspaceEntry[] {
    const entries = Object.values(this.load().workspaces);
    return opts.presentOnly ? entries.filter((e) => e.present) : entries;
  }

  /** Explicit `glosa forget <slug>` — hard-removes regardless of grace period or live-session
   * state, unlike GC's own conservative hard-remove below. Also fires `onHardRemove` (same as a
   * GC hard-remove — an explicitly forgotten workspace's `WorkspaceBus` must be evicted too, not
   * just a GC-driven one). Returns false if the slug is unknown. */
  forget(slug: string): Promise<boolean> {
    return this.mutex.runExclusive(async () => {
      const index = this.load();
      const match = Object.values(index.workspaces).find((e) => e.slug === slug);
      if (!match) return false;
      delete index.workspaces[match.registration_id];
      index.updated_at = this.now().toISOString();
      this.persist(index);
      await this.onHardRemove(match.canonical_path);
      return true;
    });
  }

  /** GC (A5 §F19). Runs at most once per `gcThrottleMs` unless `force` (daemon boot always
   * forces one immediate pass). For each entry:
   *   - path exists on disk -> ensure `present:true` (heals a path that came back).
   *   - path missing, currently `present:true` -> soften to `present:false` + stamp
   *     `absent_since` now. The grace clock starts THIS pass, never hard-removed in the same
   *     pass it went absent.
   *   - path missing, already `present:false` -> hard-remove only if there is no live session
   *     AND it's been absent for at least `gcGraceMs`. Conservative: a live session blocks
   *     removal indefinitely, no matter how long the path itself has been gone.
   * Every hard-removed path fires `onHardRemove` (awaited before this call resolves) — the
   * index write is already durable by the time it fires, so an eviction failure never leaves the
   * on-disk index and the in-memory bus registry disagreeing about whether the workspace exists.
   *
   * Safety when NOBODY has wired a live-session predicate yet (`liveSessionPredicateWired` is
   * still false — neither the constructor nor `setLiveSessionPredicate` ever supplied one): GC
   * never hard-removes anything, full stop, soft `present:false` only. The unwired default
   * predicate (`() => false`) would otherwise read as "definitely no live session," which is an
   * affirmative, wrong answer for an index that was simply never told — an unwired GC must stay
   * conservative rather than guess "no" by omission. */
  gc(opts: { force?: boolean } = {}): Promise<GcResult> {
    return this.mutex.runExclusive(async () => {
      const now = this.now();
      if (!opts.force && now.getTime() - this.lastGcAt < this.gcThrottleMs) {
        return { softened: [], removed: [] };
      }
      this.lastGcAt = now.getTime();

      const index = this.load();
      const softened: string[] = [];
      const removed: string[] = [];
      let changed = false;

      for (const [registrationId, entry] of Object.entries(index.workspaces)) {
        const canonicalPath = entry.canonical_path;
        if (this.pathExists(canonicalPath)) {
          if (!entry.present) {
            entry.present = true;
            delete entry.absent_since;
            changed = true;
          }
          continue;
        }

        if (entry.present) {
          entry.present = false;
          entry.absent_since = now.toISOString();
          softened.push(canonicalPath);
          changed = true;
          continue;
        }

        if (!this.liveSessionPredicateWired) continue; // unwired -> conservative, soft-delete only (see gc()'s docstring)
        if (this.hasLiveSession(canonicalPath)) continue; // conservative: never remove under a live session
        const absentSince = entry.absent_since ? new Date(entry.absent_since).getTime() : now.getTime();
        if (now.getTime() - absentSince >= this.gcGraceMs) {
          delete index.workspaces[registrationId];
          removed.push(canonicalPath);
          changed = true;
        }
      }

      if (changed) {
        index.updated_at = now.toISOString();
        this.persist(index);
      }
      for (const canonicalPath of removed) await this.onHardRemove(canonicalPath);
      return { softened, removed };
    });
  }
}

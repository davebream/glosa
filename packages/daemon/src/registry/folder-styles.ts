// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — each folder's default style (#407): `<GLOSA_HOME>/folder-styles.json`.
//
// A style is a document's typographic dress (Editorial, Spec or Mono). A document's own choice
// stays in the browser, per device; a folder's default lives here so it follows the folder into
// the desktop app and every browser on the machine. The SPA applies it to every document in the
// folder that has no style of its own.
//
// Like a star (workspace-stars.ts), a default is keyed by the folder's canonical path, not by the
// workspace index: the index's GC removes a registration whose folder went away, and `glosa forget`
// removes one on purpose, but the folder's default has to outlive both and apply again when the
// folder is opened next. And like a star, no request ever carries that path: the routes name a
// present directory registration by slug, and the path written down is the one the index holds
// (A3 §4 "Folder default style").
//
// It is deliberately not part of the workspace metadata descriptor (A1 §5.14): that descriptor
// belongs to an external integration, and a reading preference is the person's.
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fsyncContainingDir, writeAllSync } from "../bus/io.ts";
import { AsyncMutex } from "../bus/mutex.ts";
import { glosaHome } from "../lifecycle/home.ts";

export const FOLDER_STYLES = ["editorial", "spec", "mono"] as const;
export type FolderStyle = (typeof FOLDER_STYLES)[number];

export function isFolderStyle(value: unknown): value is FolderStyle {
  return typeof value === "string" && (FOLDER_STYLES as readonly string[]).includes(value);
}

interface FolderStyleRow {
  /** Canonical (realpath, NFC, no trailing slash): the identity the index uses. */
  path: string;
  style: FolderStyle;
  set_at: string;
}

interface FolderStylesFile {
  version: 1;
  folders: FolderStyleRow[];
}

/** A `folder-styles.json` this daemon cannot read without losing what a newer glosa wrote into it
 * (a version it does not know). Writing is refused rather than overwriting it; reading answers no
 * defaults. */
export class FolderStylesNewerError extends Error {
  constructor(path: string, version: unknown) {
    super(`${path} was written by a newer glosa (version ${String(version)}); update glosa to change folder defaults`);
    this.name = "FolderStylesNewerError";
  }
}

export function folderStylesPath(home: string): string {
  return join(home, "folder-styles.json");
}

function isRow(value: unknown): value is FolderStyleRow {
  const row = value as Partial<FolderStyleRow> | null;
  return (
    typeof row?.path === "string" &&
    row.path.startsWith("/") &&
    isFolderStyle(row.style) &&
    typeof row.set_at === "string"
  );
}

export class FolderStyles {
  readonly path: string;
  private readonly mutex = new AsyncMutex();
  private cache: FolderStylesFile | null = null;
  /** Set when the file's version is newer than this daemon's: it is served as empty and kept. */
  private newer: FolderStylesNewerError | null = null;
  private readonly listeners = new Map<string, Set<() => void>>();

  constructor({ home = glosaHome() }: { home?: string } = {}) {
    this.path = folderStylesPath(home);
  }

  /** The folder's default, or null when none is set. */
  get(canonicalPath: string): FolderStyle | null {
    return this.load().folders.find((row) => row.path === canonicalPath)?.style ?? null;
  }

  /** Sets the folder's default. Idempotent: setting the style it already has writes nothing. */
  set(canonicalPath: string, style: FolderStyle, now: Date = new Date()): Promise<FolderStyle> {
    return this.mutex.runExclusive(() => {
      const file = this.load();
      if (this.newer) throw this.newer;
      if (file.folders.some((row) => row.path === canonicalPath && row.style === style)) return style;
      const folders = file.folders.filter((row) => row.path !== canonicalPath);
      folders.push({ path: canonicalPath, style, set_at: now.toISOString() });
      this.persist({ version: 1, folders });
      this.emit(canonicalPath);
      return style;
    });
  }

  /** Clears the folder's default. Returns false when it had none. */
  clear(canonicalPath: string): Promise<boolean> {
    return this.mutex.runExclusive(() => {
      const file = this.load();
      if (this.newer) throw this.newer;
      const folders = file.folders.filter((row) => row.path !== canonicalPath);
      if (folders.length === file.folders.length) return false;
      this.persist({ version: 1, folders });
      this.emit(canonicalPath);
      return true;
    });
  }

  /** Calls `listener` after every change to this folder's default, so each window's stream can
   * tell its page to read it again. */
  subscribe(canonicalPath: string, listener: () => void): () => void {
    const listeners = this.listeners.get(canonicalPath) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(canonicalPath, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(canonicalPath);
    };
  }

  private emit(canonicalPath: string): void {
    for (const listener of [...(this.listeners.get(canonicalPath) ?? [])]) {
      try {
        listener();
      } catch {
        // A stream that went away mid-notify must not stop the others hearing about it.
      }
    }
  }

  private load(): FolderStylesFile {
    if (this.cache) return this.cache;
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.cache = { version: 1, folders: [] };
      return this.cache;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<FolderStylesFile> | null;
      // A version this daemon does not know came from a newer glosa, after a rollback. It is not
      // damage: keep the file as it is for that glosa to find again, serve no defaults and refuse
      // to write, rather than move it aside or overwrite it.
      if (typeof parsed?.version === "number" && parsed.version > 1) {
        this.newer = new FolderStylesNewerError(this.path, parsed.version);
        this.cache = { version: 1, folders: [] };
        return this.cache;
      }
      if (parsed?.version !== 1 || !Array.isArray(parsed.folders)) throw new Error("unexpected shape");
      // One malformed row costs that row, not every folder's default.
      this.cache = { version: 1, folders: parsed.folders.filter(isRow) };
    } catch (error) {
      // A reading preference is not worth refusing to serve over, but it is worth keeping: set the
      // damaged file aside for a human instead of overwriting it on the next change.
      const aside = `${this.path}.corrupt.${new Date().toISOString().replace(/[:.]/g, "-")}`;
      try {
        renameSync(this.path, aside);
        console.warn(`glosa: ${this.path} was unreadable (${(error as Error).message}); moved to ${aside}`);
      } catch (renameError) {
        console.warn(
          `glosa: ${this.path} was unreadable and could not be moved aside: ${(renameError as Error).message}`,
        );
      }
      this.cache = { version: 1, folders: [] };
    }
    return this.cache;
  }

  /** Atomic temp -> fsync -> rename at 0600, the discipline of the workspace index and stars.
   * Caller holds the mutex. */
  private persist(file: FolderStylesFile): void {
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true });
    const tmpPath = join(dir, `.folder-styles.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
    const fd = openSync(tmpPath, "wx", 0o600);
    try {
      writeAllSync(fd, Buffer.from(JSON.stringify(file, null, 2), "utf8"));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmpPath, this.path);
    fsyncContainingDir(this.path);
    this.cache = file;
  }
}

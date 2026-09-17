// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — starred workspaces: `<GLOSA_HOME>/stars.json`, the writer's own short list of
// directories they come back to.
//
// A star is deliberately NOT a field on the workspace index. The index describes what glosa is
// serving now, and its GC removes a registration whose folder has gone away (A5 §F19); a bookmark
// has to outlive exactly that. So a star keeps only the canonical path it was taken from, and the
// SPA reopens it by the star's id.
//
// That id-only reopen is the security property this file exists to hold (A3 §4 "Starred
// workspaces"): the browser can ask the daemon to open a directory, but only one the daemon wrote
// down here itself, from a registration it already had. No request ever carries a path to star or
// to open, so a page holding the Bearer token gains no new way to name a directory.
import { createHash } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fsyncContainingDir, writeAllSync } from "../bus/io.ts";
import { AsyncMutex } from "../bus/mutex.ts";
import { glosaHome } from "../lifecycle/home.ts";

export interface WorkspaceStar {
  /** Derived from the canonical path, so starring the same directory twice is one star. */
  id: string;
  /** Canonical (realpath, NFC, no trailing slash): the identity the index uses. */
  path: string;
  starred_at: string;
}

interface StarsFile {
  version: 1;
  stars: WorkspaceStar[];
}

export function starsPath(home: string): string {
  return join(home, "stars.json");
}

export function starIdFor(canonicalPath: string): string {
  return createHash("sha256").update(`star\0${canonicalPath}`).digest("hex").slice(0, 16);
}

/** The display name of a star: its folder's name, which is what the writer calls it. */
export function starName(star: Pick<WorkspaceStar, "path">): string {
  return basename(star.path) || star.path;
}

function isStar(value: unknown): value is WorkspaceStar {
  const s = value as Partial<WorkspaceStar> | null;
  return (
    typeof s?.id === "string" &&
    typeof s.path === "string" &&
    s.path.startsWith("/") &&
    typeof s.starred_at === "string" &&
    s.id === starIdFor(s.path)
  );
}

export class WorkspaceStars {
  readonly path: string;
  private readonly mutex = new AsyncMutex();
  private cache: StarsFile | null = null;

  constructor({ home = glosaHome() }: { home?: string } = {}) {
    this.path = starsPath(home);
  }

  /** Stars in a stable order: alphabetical by folder name, then by path. */
  list(): WorkspaceStar[] {
    return [...this.load().stars].sort(
      (a, b) => starName(a).localeCompare(starName(b)) || a.path.localeCompare(b.path),
    );
  }

  get(id: string): WorkspaceStar | null {
    return this.load().stars.find((star) => star.id === id) ?? null;
  }

  /** Idempotent: starring a directory that is already starred returns the existing star. */
  add(canonicalPath: string, now: Date = new Date()): Promise<WorkspaceStar> {
    return this.mutex.runExclusive(() => {
      const file = this.load();
      const id = starIdFor(canonicalPath);
      const existing = file.stars.find((star) => star.id === id);
      if (existing) return existing;
      const star: WorkspaceStar = { id, path: canonicalPath, starred_at: now.toISOString() };
      this.persist({ version: 1, stars: [...file.stars, star] });
      return star;
    });
  }

  /** Returns false when no star has this id. */
  remove(id: string): Promise<boolean> {
    return this.mutex.runExclusive(() => {
      const file = this.load();
      const stars = file.stars.filter((star) => star.id !== id);
      if (stars.length === file.stars.length) return false;
      this.persist({ version: 1, stars });
      return true;
    });
  }

  private load(): StarsFile {
    if (this.cache) return this.cache;
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.cache = { version: 1, stars: [] };
      return this.cache;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<StarsFile> | null;
      if (parsed?.version !== 1 || !Array.isArray(parsed.stars)) throw new Error("unexpected shape");
      // One malformed row costs that row, not the whole list.
      this.cache = { version: 1, stars: parsed.stars.filter(isStar) };
    } catch (error) {
      // A bookmark list is not worth refusing to serve over, but it is worth keeping: set the
      // damaged file aside for a human instead of overwriting it on the next star.
      const aside = `${this.path}.corrupt.${new Date().toISOString().replace(/[:.]/g, "-")}`;
      try {
        renameSync(this.path, aside);
        console.warn(`glosa: ${this.path} was unreadable (${(error as Error).message}); moved to ${aside}`);
      } catch (renameError) {
        console.warn(
          `glosa: ${this.path} was unreadable and could not be moved aside: ${(renameError as Error).message}`,
        );
      }
      this.cache = { version: 1, stars: [] };
    }
    return this.cache;
  }

  /** Atomic temp -> fsync -> rename, the same discipline as the workspace index. Caller holds the
   * mutex. */
  private persist(file: StarsFile): void {
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true });
    const tmpPath = join(dir, `.stars.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
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

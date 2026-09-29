// SPDX-License-Identifier: Apache-2.0
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { AsyncMutex } from "../bus/mutex.ts";
import { fsyncContainingDir, writeAllSync } from "../bus/io.ts";
export interface FileView {
  mode: "all" | "documents";
  show_ignored: boolean;
}
export const DEFAULT_FILE_VIEW: FileView = { mode: "all", show_ignored: false };
export function isFileView(value: unknown): value is FileView {
  const row = value as FileView | null;
  return !!row && (row.mode === "all" || row.mode === "documents") && typeof row.show_ignored === "boolean";
}
export class FileViews {
  private rows: Record<string, FileView> | null = null;
  private newer = false;
  private readonly mutex = new AsyncMutex();
  private readonly listeners = new Map<string, Set<() => void>>();
  readonly path: string;
  constructor(private readonly home: string) {
    this.path = join(home, "folder-file-views.json");
  }
  private load() {
    if (this.rows) return this.rows;
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return (this.rows = Object.create(null));
    }
    try {
      const data = JSON.parse(raw);
      if (data?.version > 1) {
        this.newer = true;
        return (this.rows = Object.create(null));
      }
      if (data?.version !== 1 || !data.folders || typeof data.folders !== "object" || Array.isArray(data.folders))
        throw new Error("Invalid preference store");
      return (this.rows = Object.fromEntries(
        Object.entries(data.folders).filter(([path, view]) => path.startsWith("/") && isFileView(view)),
      ) as Record<string, FileView>);
    } catch {
      // Never overwrite damaged preferences if moving them aside fails.
      renameSync(this.path, `${this.path}.corrupt.${Date.now()}`);
      return (this.rows = Object.create(null));
    }
  }
  get(path: string): FileView {
    return { ...(this.load()[path] ?? DEFAULT_FILE_VIEW) };
  }
  set(path: string, view: FileView) {
    return this.mutex.runExclusive(() => {
      const rows = this.load();
      if (this.newer) throw new Error("These folder preferences need a newer glosa. Update glosa to change them.");
      if (rows[path]?.mode === view.mode && rows[path]?.show_ignored === view.show_ignored) return this.get(path);
      const next = { ...rows, [path]: { ...view } };
      mkdirSync(this.home, { recursive: true });
      const temp = `${this.path}.${crypto.randomUUID()}.tmp`;
      const fd = openSync(temp, "wx", 0o600);
      try {
        writeAllSync(fd, Buffer.from(JSON.stringify({ version: 1, folders: next })));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temp, this.path);
      fsyncContainingDir(this.path);
      this.rows = next;
      for (const listener of this.listeners.get(path) ?? []) {
        try {
          listener();
        } catch {
          /* a disconnected observer cannot undo persisted preferences */
        }
      }
      return this.get(path);
    });
  }
  subscribe(path: string, listener: () => void) {
    const listeners = this.listeners.get(path) ?? new Set();
    listeners.add(listener);
    this.listeners.set(path, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(path);
    };
  }
}

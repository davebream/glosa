// SPDX-License-Identifier: Apache-2.0
import type { DerivedState } from "./replay.ts";
const originals = new WeakMap<object, unknown>();
export interface PathRename {
  from: string;
  to: string;
  scope: "file" | "folder";
  checkpoint_after: string;
  entry: string;
}
export function renamedPath(path: string, rename: Pick<PathRename, "from" | "to" | "scope">): string {
  return path === rename.from || (rename.scope === "folder" && path.startsWith(`${rename.from}/`))
    ? rename.to + path.slice(rename.from.length)
    : path;
}
export function currentPath(state: DerivedState, entry: string, path: string): string {
  const since = state.entries[entry]?.renames_seen_at_creation ?? 0;
  return state.renames.slice(since).reduce((value, rename) => renamedPath(value, rename), path);
}
/** Return a projected copy, never mutate an immutable inbox payload. */
export function currentPayload(state: DerivedState, entry: string, payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  payload = originals.get(payload) ?? payload;
  const result = { ...(payload as Record<string, unknown>) };
  originals.set(result, payload);
  for (const key of ["artifact_path", "target_path", "path"]) {
    if (typeof result[key] !== "string") continue;
    const stored = result[key];
    result[key] = currentPath(state, entry, stored);
    if (key === "artifact_path" && stored !== result[key]) result.previous_artifact_path = stored;
  }
  if (Array.isArray(result.files)) result.files = result.files.map((file) => currentPayload(state, entry, file));
  return result;
}

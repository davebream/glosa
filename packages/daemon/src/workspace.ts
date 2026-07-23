// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — shared workspace registration context. A workspace's logical identity,
// work-tree, daemon-owned state, and tracked-file policy are deliberately independent.

export type WorkspaceKind = "directory" | "loose-file";

export type WorkspaceTracking =
  | { mode: "matcher" }
  | {
      mode: "bounded";
      /** NFC-normalized POSIX paths relative to `worktree_path`. */
      paths: string[];
    };

export interface WorkspaceLocation {
  registration_id: string;
  kind: WorkspaceKind;
  canonical_path: string;
  worktree_path: string;
  bus_path: string;
  tracking: WorkspaceTracking;
}

export type WorkspaceTarget = string | WorkspaceLocation;

export function workspaceWorktree(target: WorkspaceTarget): string {
  return typeof target === "string" ? target : target.worktree_path;
}

export function workspaceBusPath(target: WorkspaceTarget): string {
  return typeof target === "string" ? `${target}/.glosa` : target.bus_path;
}

export function workspaceRegistrationId(target: WorkspaceTarget): string {
  return typeof target === "string" ? `directory:${target}` : target.registration_id;
}

export function workspaceTracking(target: WorkspaceTarget): WorkspaceTracking {
  return typeof target === "string" ? { mode: "matcher" } : target.tracking;
}

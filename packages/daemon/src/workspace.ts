// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — shared workspace registration context. A workspace's logical identity,
// work-tree, daemon-owned state, and tracked-file policy are deliberately independent.
import { createHash } from "node:crypto";

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

/** The ONE derivation of a registration id, for both the persisted `WorkspaceLocation` the index
 * writes and the bare-string target below. It lives here rather than in `registry/workspace-index.ts`
 * because two copies of this formula must agree byte for byte forever: A4's cross-cutting invariant
 * serializes daemon mutation "under an in-process async mutex keyed by immutable registration ID",
 * and F21 allows "ONE git mutex/workspace" — so a second, drifting derivation puts one `shadow.git`
 * behind two mutex slots and two `JournalWriter` fds.
 *
 * `canonicalPath` must ALREADY be canonical (A4 "Workspace ownership and aliases": realpath -> NFC
 * -> strip trailing slash). This function deliberately does not canonicalize: it is called on every
 * mutex acquisition and must stay pure, total, and free of filesystem I/O that could throw once the
 * directory is gone. Canonicalization is the index's job, at registration time. */
export function registrationIdFor(kind: WorkspaceKind, canonicalPath: string): string {
  return createHash("sha256").update(`${kind}\0${canonicalPath}`).digest("hex");
}

/** A bare string target is a `directory` registration by construction — `workspaceBusPath` gives it
 * `<path>/.glosa` and `workspaceTracking` gives it `{mode:"matcher"}`, which is precisely how the
 * index builds a directory entry (a `loose-file` entry always redirects its bus to
 * `~/.glosa/state/<id>` and is always `{mode:"bounded"}`). So it hashes exactly as the index would,
 * and the two shapes of the same workspace are indistinguishable as a key. */
export function workspaceRegistrationId(target: WorkspaceTarget): string {
  return typeof target === "string" ? registrationIdFor("directory", target) : target.registration_id;
}

export function workspaceTracking(target: WorkspaceTarget): WorkspaceTracking {
  return typeof target === "string" ? { mode: "matcher" } : target.tracking;
}

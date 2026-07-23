// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — per-workspace `.glosa/` path resolution for the file bus (journal, inbox,
// quarantine). Mirrors home.ts's GLOSA_HOME pattern, but rooted at a WORKSPACE directory, not
// the daemon's own home (A4 §F04). A workspace is any directory the caller designates; callers
// are expected to pass its canonical (realpath'd) path so it also doubles as a stable mutex key.
import { join } from "node:path";
import { workspaceBusPath, type WorkspaceTarget } from "../workspace.ts";

export function workspaceBusDir(workspace: WorkspaceTarget): string {
  return workspaceBusPath(workspace);
}

export function journalPath(workspace: WorkspaceTarget): string {
  return join(workspaceBusDir(workspace), "journal.ndjson");
}

export function quarantinePath(workspace: WorkspaceTarget): string {
  return join(workspaceBusDir(workspace), "journal.quarantine.ndjson");
}

export function inboxDir(workspace: WorkspaceTarget): string {
  return join(workspaceBusDir(workspace), "inbox");
}

export function inboxEntryPath(workspace: WorkspaceTarget, id: string): string {
  return join(inboxDir(workspace), `${id}.json`);
}

/** The shadow-git repo's `--git-dir` (A4 §F21) — separate from the worktree it shadows
 * (`workspaceRoot` itself is `--work-tree`). Lives under `.glosa/`, which the matcher's default
 * `.glosa/**` exclude already prunes from every walk, so shadow-git's own objects/refs are never
 * mistaken for tracked artifacts. */
export function shadowGitDir(workspace: WorkspaceTarget): string {
  return join(workspaceBusDir(workspace), "shadow.git");
}

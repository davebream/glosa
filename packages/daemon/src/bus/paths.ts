// @glosa/daemon — per-workspace `.glosa/` path resolution for the file bus (journal, inbox,
// quarantine). Mirrors home.ts's GLOSA_HOME pattern, but rooted at a WORKSPACE directory, not
// the daemon's own home (A4 §F04). A workspace is any directory the caller designates; callers
// are expected to pass its canonical (realpath'd) path so it also doubles as a stable mutex key.
import { join } from "node:path";

export function workspaceBusDir(workspaceRoot: string): string {
  return join(workspaceRoot, ".glosa");
}

export function journalPath(workspaceRoot: string): string {
  return join(workspaceBusDir(workspaceRoot), "journal.ndjson");
}

export function quarantinePath(workspaceRoot: string): string {
  return join(workspaceBusDir(workspaceRoot), "journal.quarantine.ndjson");
}

export function inboxDir(workspaceRoot: string): string {
  return join(workspaceBusDir(workspaceRoot), "inbox");
}

export function inboxEntryPath(workspaceRoot: string, id: string): string {
  return join(inboxDir(workspaceRoot), `${id}.json`);
}

/** The shadow-git repo's `--git-dir` (A4 §F21) — separate from the worktree it shadows
 * (`workspaceRoot` itself is `--work-tree`). Lives under `.glosa/`, which the matcher's default
 * `.glosa/**` exclude already prunes from every walk, so shadow-git's own objects/refs are never
 * mistaken for tracked artifacts. */
export function shadowGitDir(workspaceRoot: string): string {
  return join(workspaceBusDir(workspaceRoot), "shadow.git");
}

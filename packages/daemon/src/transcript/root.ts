// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — P4.2: confinement for a session's `transcript_path` (A2 §F16, A6 §F30's doctor
// check "transcript-root(under allowed CLAUDE_CONFIG_DIR)"). A `transcript_path` arrives from the
// SessionRegistry — ultimately sourced from a Claude Code hook's stdin JSON (A2 §F08) — and a hook
// payload is not something glosa should trust blindly before opening a file handle to it: this is
// the same realpath-confine discipline confine-path.ts applies to workspace-relative artifact
// paths (A1 §6/F24), adapted for an already-absolute path checked against a different root.
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";

// ASCII control chars (incl. NUL and \n) — same guard as confine-path.ts's A3 §5 attack #5.
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

/** `$CLAUDE_CONFIG_DIR` (A2 §F16 "Fallback root"), falling back to the documented default
 * `~/.claude`. NEVER hardcode `~/.claude` at any other call site — this is the one place that
 * resolves it, same discipline as home.ts's `glosaHome()` for glosa's own dir. */
export function claudeConfigDir(): string {
  return Bun.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

export type ConfineTranscriptResult = { ok: true; realPath: string } | { ok: false };

/** Confirms `transcriptPath` (an absolute path) resolves, via realpath, to somewhere under
 * `claudeConfigDir()`'s own realpath — catching a symlink escape the same way confine-path.ts's
 * F24 fix does. The leaf file may not exist yet (a session can register before its first
 * transcript byte is written) — falls back to realpath-ing the nearest existing ancestor
 * directory, exactly like confine-path.ts's `realpathNearestAncestor`, so confinement is still
 * enforced even when there's nothing to tail yet. */
export function confineTranscriptPath(transcriptPath: string, root: string = claudeConfigDir()): ConfineTranscriptResult {
  if (transcriptPath.length === 0) return { ok: false };
  if (!transcriptPath.startsWith("/")) return { ok: false }; // hook input is documented as always absolute
  if (CONTROL_CHAR_RE.test(transcriptPath)) return { ok: false };

  let rootReal: string;
  try {
    rootReal = realpathSync(root);
  } catch {
    return { ok: false }; // no CLAUDE_CONFIG_DIR at all — nothing can ever confine under it
  }

  let real: string;
  try {
    real = realpathSync(transcriptPath);
  } catch {
    const ancestorReal = realpathNearestAncestor(transcriptPath);
    if (ancestorReal === null) return { ok: false };
    real = ancestorReal;
  }

  if (real !== rootReal && !real.startsWith(rootReal + sep)) return { ok: false };
  return { ok: true, realPath: transcriptPath };
}

/** Walks up from `path` collecting segments that don't exist yet, realpath()s the first ancestor
 * that does, then re-appends the collected (unresolved) segments on top — same algorithm as
 * confine-path.ts's private helper of the same name, duplicated rather than imported since that
 * one operates relative to a workspace root and this one operates on an already-absolute path with
 * no `relPath` of its own to resolve first. */
function realpathNearestAncestor(path: string): string | null {
  const trailing: string[] = [];
  let current = path;
  for (;;) {
    try {
      const real = realpathSync(current);
      return trailing.length === 0 ? real : real + sep + trailing.reverse().join(sep);
    } catch {
      const parent = dirname(current);
      if (parent === current) return null; // reached the filesystem root, nothing real found
      trailing.push(current.slice(parent.length + 1));
      current = parent;
    }
  }
}

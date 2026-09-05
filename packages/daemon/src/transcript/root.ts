// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — P4.2: confinement for a session's `transcript_path` (A2 §F16, A6 §F30's doctor
// check "transcript-root(under allowed CLAUDE_CONFIG_DIR)"). A `transcript_path` arrives from the
// SessionRegistry — ultimately sourced from a Claude Code hook's stdin JSON (A2 §F08) — and a hook
// payload is not something glosa should trust blindly before opening a file handle to it: this is
// the same realpath-confine discipline confine-path.ts applies to workspace-relative artifact
// paths (A1 §6/F24), adapted for an already-absolute path checked against a different root.
import { type Dirent, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";

// ASCII control chars (incl. NUL and \n) — same guard as confine-path.ts's A3 §5 attack #5.
function hasAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** `$CLAUDE_CONFIG_DIR` (A2 §F16 "Fallback root"), falling back to the documented default
 * `~/.claude`. NEVER hardcode `~/.claude` at any other call site — this is the one place that
 * resolves it, same discipline as home.ts's `glosaHome()` for glosa's own dir. */
export function claudeConfigDir(): string {
  return Bun.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

/** Where account switchers keep their per-account Claude config directories. A switcher runs Claude
 * with `CLAUDE_CONFIG_DIR` pointed at one of these, so its sessions write transcripts here and
 * nowhere near `~/.claude`. */
const SWITCHER_ROOT_PARENTS = [join(".ccs", "instances")];

/**
 * EVERY directory a Claude Code session on this machine might root its transcripts in.
 *
 * One root is not enough. The daemon is a singleton started by whichever process happened to spawn
 * it, so it inherits exactly one `CLAUDE_CONFIG_DIR` — but it serves sessions from all of them. A
 * session launched by an account switcher reports a `transcript_path` under its own instance
 * directory, which is outside `~/.claude`, and confinement against a single root refuses it: the
 * conversation view is simply dead for those sessions, with a 400 that looks like a path attack.
 *
 * Discovery is filesystem-only and read-only — no network, no process inspection, no launching
 * anything (invariant 5). A missing switcher directory is the ordinary case, not an error.
 */
export function claudeConfigRoots(): string[] {
  const roots = new Set<string>([claudeConfigDir(), join(homedir(), ".claude")]);
  for (const parent of SWITCHER_ROOT_PARENTS) {
    const base = join(homedir(), parent);
    let entries: Dirent[];
    try {
      entries = readdirSync(base, { withFileTypes: true });
    } catch {
      continue; // no switcher installed — much the commonest case
    }
    for (const entry of entries) {
      // `isDirectory()` follows symlinks, which is what we want: an instance directory may be one.
      // Confinement still realpaths both sides, so a symlinked root confines to its real location.
      if (entry.isDirectory() && !entry.name.startsWith(".")) roots.add(join(base, entry.name));
    }
  }
  return [...roots];
}

export type ConfineTranscriptResult = { ok: true; realPath: string } | { ok: false };

/** Confirms `transcriptPath` (an absolute path) resolves, via realpath, to somewhere under
 * `claudeConfigDir()`'s own realpath — catching a symlink escape the same way confine-path.ts's
 * F24 fix does. The leaf file may not exist yet (a session can register before its first
 * transcript byte is written) — falls back to realpath-ing the nearest existing ancestor
 * directory, exactly like confine-path.ts's `realpathNearestAncestor`, so confinement is still
 * enforced even when there's nothing to tail yet. */
export function confineTranscriptPath(
  transcriptPath: string,
  roots: string | readonly string[] = claudeConfigRoots(),
): ConfineTranscriptResult {
  if (transcriptPath.length === 0) return { ok: false };
  if (!transcriptPath.startsWith("/")) return { ok: false }; // hook input is documented as always absolute
  if (hasAsciiControlCharacter(transcriptPath)) return { ok: false };

  // Each root is realpath'd independently and an unresolvable one is simply not a root — it never
  // widens the check. A path is admitted only by being genuinely inside one of them, so several
  // roots is several chances to be confined, never a weaker confinement.
  const rootReals: string[] = [];
  for (const root of typeof roots === "string" ? [roots] : roots) {
    try {
      rootReals.push(realpathSync(root));
    } catch {
      // This root does not exist on this machine; nothing can ever confine under it.
    }
  }
  if (rootReals.length === 0) return { ok: false };

  let real: string;
  try {
    real = realpathSync(transcriptPath);
  } catch {
    const ancestorReal = realpathNearestAncestor(transcriptPath);
    if (ancestorReal === null) return { ok: false };
    real = ancestorReal;
  }

  if (!rootReals.some((rootReal) => real === rootReal || real.startsWith(rootReal + sep))) return { ok: false };
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

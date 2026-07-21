// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — confinePath: the ONE shared path-confinement utility (A1 §6, A3 §3/§5 #4-5,
// F24). Every workspace-relative path arriving through the HTTP layer must funnel through this
// before it ever touches the filesystem. Reused as-is by the class-F mint/serve path (A1 §7),
// the git pathspec layer, and the adapter manifest resolver as those land in later tasks.
//
// P2.2: the tracked-artifact glob/size membership check (R1 include/exclude + ≤2MB) is a
// separate, later gate — a path that passes confinePath but isn't a tracked artifact is 404, not
// 400 (A1 §6 step 4). Not implemented here.
import { realpathSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

export type ConfineResult = { ok: true; realPath: string } | { ok: false };

// ASCII control chars (incl. NUL and \n) — A3 §5 attack #5.
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

// P6.1 review fix: cheap ceilings rejected BEFORE any filesystem work. Without these, a
// pathological (but traversal-clean — no ".." components, so the check above doesn't catch it)
// value like "a/a/a/.../a" with hundreds of thousands of segments drives that many synchronous
// realpathSync/dirname calls in `realpathNearestAncestor` below, blocking the whole single-
// threaded daemon for the duration of one request. Both limits are generous for any real
// workspace-relative artifact path; a legitimate path will never come close.
const MAX_SEGMENTS = 64;
const MAX_PATH_LENGTH = 4096;

export function confinePath(workspaceRoot: string, relPath: string): ConfineResult {
  if (relPath.length === 0) return { ok: false };
  if (relPath.length > MAX_PATH_LENGTH) return { ok: false };
  if (relPath.startsWith("/")) return { ok: false }; // must be workspace-relative
  if (CONTROL_CHAR_RE.test(relPath)) return { ok: false };
  const segments = relPath.split("/");
  if (segments.length > MAX_SEGMENTS) return { ok: false };
  if (segments.some((segment) => segment === "..")) return { ok: false };

  const resolved = resolve(workspaceRoot, relPath);

  let rootReal: string;
  try {
    rootReal = realpathSync(workspaceRoot);
  } catch {
    return { ok: false };
  }

  // The leaf may not exist yet (e.g. a not-yet-created artifact) — realpath the nearest
  // existing ancestor instead, so a symlink anywhere on the path is still caught even when the
  // final component doesn't exist (F24).
  let real: string;
  try {
    real = realpathSync(resolved);
  } catch {
    const ancestorReal = realpathNearestAncestor(resolved);
    if (ancestorReal === null) return { ok: false };
    real = ancestorReal;
  }

  if (real !== rootReal && !real.startsWith(rootReal + sep)) return { ok: false };
  return { ok: true, realPath: resolved };
}

/** Walks up from `path` collecting the segments that don't exist yet, realpath()s the first
 * ancestor that does, then re-appends the collected (unresolved — they don't exist, so there's
 * no further symlink to chase) segments on top of that real path. */
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

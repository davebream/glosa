// @glosa/daemon — canonical workspace identity + slug assignment (A4 §F25). The canonical path
// (realpath -> NFC -> strip trailing slash) is the IDENTITY; a slug is just a route label
// derived from it. Two different canonical paths never share a slug — collision-lengthening
// (below) guarantees that, deterministically, without ever stealing an incumbent's slug.
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";

/** realpath -> NFC -> strip trailing slash. This is the identity every other module in
 * registry/ assumes callers have already applied — `WorkspaceIndex`/`SessionRegistry` accept a
 * canonical path directly (same convention `WorkspaceBus` uses for its `workspaceRoot`), they
 * don't re-derive it themselves. */
export function canonicalize(path: string): string {
  const real = realpathSync(path).normalize("NFC");
  return real.length > 1 && real.endsWith("/") ? real.slice(0, -1) : real;
}

function sanitizeBasename(canonicalPath: string): string {
  const segments = canonicalPath.split("/").filter((s) => s.length > 0);
  const base = segments.length > 0 ? (segments[segments.length - 1] as string) : "workspace";
  const cleaned = base
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned : "workspace";
}

const MIN_HEX_LEN = 6; // 24 bits — F25: "NOT collision-free, detection mandatory"
const HEX_LEN_STEP = 2;
const MAX_HEX_LEN = 64; // full sha256 hex digest — the hard cap collision-lengthening can reach

export interface ExistingSlugEntry {
  canonicalPath: string;
  slug: string;
  slugLen: number;
}

export interface SlugAssignment {
  slug: string;
  slugLen: number;
}

export interface SlugDeps {
  /** Hex-digest function, defaults to sha256. Overridable so tests can force a slug collision
   * deterministically instead of hunting for a real (astronomically rare) sha256 collision. */
  hash?: (canonicalPath: string) => string;
}

/** Assigns a slug for `canonicalPath` against the set of already-assigned entries. MUST be
 * called under the global index's mutex (F25: "assign under global-index lock") — this function
 * itself is pure and does no I/O, the caller (`WorkspaceIndex.upsertWorkspace`) provides the
 * synchronization.
 *
 * Rules (F25):
 *   - No entry for this path yet, and the natural (6-hex) slug is free -> use it.
 *   - An entry for this EXACT canonical path already exists -> idempotent reuse of its slug,
 *     unchanged, regardless of what `existing` otherwise contains.
 *   - Natural slug collides with a DIFFERENT canonical path's slug -> the incumbent keeps its
 *     slug; this (newcomer) path lengthens its own hex prefix by 2 hex chars at a time until it
 *     no longer collides with any different-path entry, capped at the full 64-hex digest.
 * Deterministic and terminating for any input. */
export function assignSlug(canonicalPath: string, existing: ExistingSlugEntry[], deps: SlugDeps = {}): SlugAssignment {
  const already = existing.find((e) => e.canonicalPath === canonicalPath);
  if (already) return { slug: already.slug, slugLen: already.slugLen };

  const hashFn = deps.hash ?? ((p: string) => createHash("sha256").update(p, "utf8").digest("hex"));
  const base = sanitizeBasename(canonicalPath);
  const hashHex = hashFn(canonicalPath);

  // Every remaining `existing` entry belongs to a DIFFERENT canonical path (the same-path case
  // returned above already) — so any slug string collision here is exactly the "different path,
  // same slug" case F25 defines, never a false positive against ourselves.
  const takenByOthers = new Set(existing.map((e) => e.slug));

  let len = MIN_HEX_LEN;
  let slug = `${base}-${hashHex.slice(0, len)}`;
  while (takenByOthers.has(slug) && len < MAX_HEX_LEN) {
    len += HEX_LEN_STEP;
    slug = `${base}-${hashHex.slice(0, len)}`;
  }
  return { slug, slugLen: len };
}

// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — minimal read-only probe for "has `glosa init` ever run in this worktree?"
// (issue #80). The daemon cannot import the CLI's checkManifestDrift (dependency direction is
// cli→daemon), and the SPA wiring badge only needs presence, not drift — drift stays `glosa
// doctor`'s job. The ONE duplicated fact is the manifest path convention:
// `<worktree>/.claude/.glosa-init.json` — cross-commented with `paths()` in
// packages/cli/src/init.ts and pinned by a literal-path test in BOTH packages so the two can
// never silently diverge.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface InitProbe {
  /** The ownership manifest exists (init ran here at some point). */
  manifest_present: boolean;
  /** It exists but failed to parse / has the wrong shape — init ran, the record is damaged;
   * `glosa doctor` owns the diagnosis. */
  manifest_invalid: boolean;
}

/** Never throws: ENOENT (or any read error) → `{manifest_present: false, …}`. */
export function probeInitManifest(worktreePath: string): InitProbe {
  const manifestPath = join(worktreePath, ".claude", ".glosa-init.json");
  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch {
    return { manifest_present: false, manifest_invalid: false };
  }
  try {
    const parsed = JSON.parse(raw);
    const valid = typeof parsed === "object" && parsed !== null && typeof parsed.files === "object" && parsed.files !== null;
    return { manifest_present: true, manifest_invalid: !valid };
  } catch {
    return { manifest_present: true, manifest_invalid: true };
  }
}

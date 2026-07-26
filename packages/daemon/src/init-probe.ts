// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — minimal read-only probe for "has workspace-scoped `glosa init` run here?"
// (issue #80). The daemon cannot import the CLI's scoped manifest inspector (dependency direction
// is cli→daemon), and the SPA wiring badge only needs presence, not drift — drift stays `glosa
// doctor`'s job. The duplicated fact is the workspace-manifest convention:
// `<worktree>/.glosa/init-manifest.json`, with the legacy `.claude/.glosa-init.json` recognized
// during migration so an existing integration never appears unwired.
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
  const paths = [join(worktreePath, ".glosa", "init-manifest.json"), join(worktreePath, ".claude", ".glosa-init.json")];
  for (const manifestPath of paths) {
    let raw: string;
    try {
      raw = readFileSync(manifestPath, "utf8");
    } catch {
      continue;
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const v2 = parsed.version === 2 && parsed.scope === "workspace" && typeof parsed.providers === "object";
      const legacy = parsed.version === 1 && typeof parsed.files === "object";
      return { manifest_present: true, manifest_invalid: !(v2 || legacy) };
    } catch {
      return { manifest_present: true, manifest_invalid: true };
    }
  }
  return { manifest_present: false, manifest_invalid: false };
}

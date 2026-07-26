// SPDX-License-Identifier: Apache-2.0
// issue #80 — the daemon's minimal read-only init-manifest probe. The literal path
// `.claude/.glosa-init.json` is the ONE fact duplicated from the CLI's `paths()`
// (packages/cli/src/init.ts) — pinned here and by init.test.ts's own manifestPath helper so the
// two packages can never silently diverge.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeInitManifest } from "../src/init-probe.ts";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "glosa-init-probe-"));
}

describe("probeInitManifest", () => {
  test("absent manifest → present:false, invalid:false (never throws on ENOENT)", () => {
    const dir = freshDir();
    expect(probeInitManifest(dir)).toEqual({ manifest_present: false, manifest_invalid: false });
    expect(probeInitManifest(join(dir, "no", "such", "dir"))).toEqual({
      manifest_present: false,
      manifest_invalid: false,
    });
    rmSync(dir, { recursive: true, force: true });
  });

  test("valid manifest at the pinned literal path → present:true, invalid:false", () => {
    const dir = freshDir();
    // The literal path IS the cross-package contract — keep it inline, not behind a helper.
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", ".glosa-init.json"), JSON.stringify({ v: 1, files: { settings: {} } }));
    expect(probeInitManifest(dir)).toEqual({ manifest_present: true, manifest_invalid: false });
    rmSync(dir, { recursive: true, force: true });
  });

  test("invalid JSON and wrong-shape manifests → present:true, invalid:true", () => {
    const dir = freshDir();
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", ".glosa-init.json"), "{not json");
    expect(probeInitManifest(dir)).toEqual({ manifest_present: true, manifest_invalid: true });
    writeFileSync(join(dir, ".claude", ".glosa-init.json"), JSON.stringify({ v: 1 })); // no files map
    expect(probeInitManifest(dir)).toEqual({ manifest_present: true, manifest_invalid: true });
    rmSync(dir, { recursive: true, force: true });
  });
});

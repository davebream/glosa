// SPDX-License-Identifier: Apache-2.0
// Issue #281 — `matchTrackedFile` is the point-membership counterpart to `resolveMatchedFiles`/
// `resolveTrackedFiles`'s complete LIST. Every case here asserts the two agree: a point answer
// must never diverge from what the complete walk would have decided for that exact path (criterion
// 2's falsification condition). Ablating `matchTrackedFile`'s shared `buildMatcherPredicates` call
// (making it build its own independent picomatch instances) or its confinement/prune walk would
// make these tests fail without touching `resolveMatchedFiles` at all — the point this suite exists
// to pin.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type MatcherConfig, matchTrackedFile, resolveMatchedFiles, resolveTrackedFiles } from "../../src/matcher.ts";
import { cleanupWorkspace, freshWorkspace, makeDir, makeSymlink, writeFile } from "./helpers.ts";

function config(overrides: Partial<MatcherConfig["artifacts"]> = {}): MatcherConfig {
  return {
    artifacts: {
      include: ["**/*.md"],
      exclude: [".glosa/**", "**/node_modules/**", ".*/**"],
      maxFileBytes: 64,
      followSymlinks: false,
      ...overrides,
    },
  };
}

/** Asserts `matchTrackedFile` agrees with the complete `resolveMatchedFiles` walk for every
 * candidate path supplied — both the ones expected to be tracked and the ones expected not to be. */
function expectPointAgreesWithList(
  root: string,
  cfg: MatcherConfig,
  trackedRel: string[],
  untrackedAbs: string[],
): void {
  const list = resolveMatchedFiles(root, cfg);
  expect(list.tracked.map((f) => f.path).sort()).toEqual([...trackedRel].sort());

  for (const file of list.tracked) {
    const point = matchTrackedFile(root, file.rawPath, cfg);
    expect(point).not.toBeNull();
    expect(point!.path).toBe(file.path);
    expect(point!.sizeBytes).toBe(file.sizeBytes);
  }
  for (const abs of untrackedAbs) {
    expect(matchTrackedFile(root, abs, cfg)).toBeNull();
  }
}

describe("matchTrackedFile — point/list differential", () => {
  let root: string;

  beforeEach(() => {
    root = freshWorkspace();
  });

  afterEach(() => {
    cleanupWorkspace(root);
  });

  test("include/exclude: a matched extension is tracked, an excluded subtree and an unmatched extension are not", () => {
    const included = writeFile(root, "notes.md", "hello");
    const wrongExt = writeFile(root, "notes.json", "{}");
    makeDir(root, "drafts");
    const excludedByConfig = writeFile(root, "drafts/secret.md", "hidden");
    const cfg = config({ exclude: [".glosa/**", "**/node_modules/**", ".*/**", "drafts/**"] });

    expectPointAgreesWithList(root, cfg, ["notes.md"], [wrongExt, excludedByConfig]);
    // Confirms this is genuinely the exclude glob, not merely "extension mismatch".
    expect(matchTrackedFile(root, excludedByConfig, cfg)).toBeNull();
    expect(matchTrackedFile(root, included, cfg)).not.toBeNull();
  });

  test("redirected bus config: point membership honors the SAME `.glosa/config.json` the list resolver loads from the registration's own bus path, not the worktree", () => {
    const worktree = freshWorkspace();
    const busPath = freshWorkspace();
    mkdirSync(busPath, { recursive: true });
    // include/exclude are UNIONED onto the defaults (loadMatcherConfig's own contract), so this
    // override both adds a new tracked extension AND removes the default `.md` one — either half
    // alone would prove the busPath config loaded; both together rule out "defaults happened to
    // already track one of these".
    writeFileSync(
      join(busPath, "config.json"),
      JSON.stringify({ artifacts: { include: ["**/*.csv"], exclude: ["**/*.md"] } }),
    );
    const csv = writeFile(worktree, "data.csv", "a,b");
    const md = writeFile(worktree, "notes.md", "hello");
    // A `.glosa/config.json` sitting in the WORKTREE (never consulted for a redirected bus) tracks
    // `.md` normally — if point membership ever fell back to it, this test would pass wrongly.
    mkdirSync(join(worktree, ".glosa"), { recursive: true });
    writeFileSync(join(worktree, ".glosa", "config.json"), JSON.stringify({ artifacts: {} }));

    const workspace = {
      registration_id: "r1",
      kind: "directory" as const,
      canonical_path: worktree,
      worktree_path: worktree,
      bus_path: busPath,
      tracking: { mode: "matcher" as const },
    };
    const list = resolveTrackedFiles(workspace);
    expect(list.tracked.map((f) => f.path)).toEqual(["data.csv"]);
    expect(matchTrackedFile(workspace, csv)).not.toBeNull();
    expect(matchTrackedFile(workspace, md)).toBeNull(); // .md is excluded by the redirected config

    cleanupWorkspace(worktree);
    cleanupWorkspace(busPath);
  });

  test("exact size threshold: at the limit is tracked, one byte over is not — for both point and list", () => {
    const atLimit = writeFile(root, "exact.md", 64);
    const overLimit = writeFile(root, "over.md", 65);
    const cfg = config({ maxFileBytes: 64 });

    expectPointAgreesWithList(root, cfg, ["exact.md"], [overLimit]);
    expect(matchTrackedFile(root, atLimit, cfg)!.sizeBytes).toBe(64);
  });

  test("a leaf symlink is never tracked, even when it targets a real included file", () => {
    const real = writeFile(root, "real.md", "hi");
    const link = join(root, "alias.md");
    makeSymlink(real, link);
    const cfg = config();

    expectPointAgreesWithList(root, cfg, ["real.md"], [link]);
  });

  test("an intermediate symlinked directory is never descended into by the point check, matching the walker", () => {
    const outside = freshWorkspace();
    const outsideFile = writeFile(outside, "outside.md", "hi");
    const linkedDir = join(root, "linked");
    makeSymlink(outside, linkedDir);
    const cfg = config();

    const list = resolveMatchedFiles(root, cfg);
    expect(list.tracked).toEqual([]); // the walker never follows `linked/`, so nothing is found there
    // A naive point implementation that just `lstat`s the final path would find this file (the OS
    // resolves the intermediate symlink); the canonical point check must not.
    expect(matchTrackedFile(root, join(linkedDir, "outside.md"), cfg)).toBeNull();

    cleanupWorkspace(outside);
    expect(outsideFile).toBeTruthy();
  });

  test("NFC/NFD: an NFD-spelled on-disk file is found via both its raw path and its NFC-reconstructed path", () => {
    const oAcute = String.fromCodePoint(0x00f3);
    const oPlain = String.fromCodePoint(0x006f);
    const combining = String.fromCodePoint(0x0301);
    const nfcName = `c${oAcute}rka.md`;
    const nfdName = `c${oPlain}${combining}rka.md`;
    const rawPath = writeFile(root, nfdName, "content");
    const cfg = config();

    const list = resolveMatchedFiles(root, cfg);
    expect(list.tracked.map((f) => f.path)).toEqual([nfcName]);

    const viaRaw = matchTrackedFile(root, rawPath, cfg);
    expect(viaRaw).not.toBeNull();
    expect(viaRaw!.path).toBe(nfcName);

    // APFS is normalization-insensitive: an NFC-reconstructed absolute path resolves to the same
    // file, and a point check against it must agree with the list too.
    const nfcReconstructed = join(root, nfcName);
    const viaNfc = matchTrackedFile(root, nfcReconstructed, cfg);
    expect(viaNfc).not.toBeNull();
    expect(viaNfc!.path).toBe(nfcName);
  });

  test("escape/prefix sibling: a directory whose name merely starts with the root's name is not treated as inside it", () => {
    const base = freshWorkspace();
    const workspaceRoot = join(base, "foo");
    const sibling = join(base, "foobar");
    mkdirSync(workspaceRoot, { recursive: true });
    mkdirSync(sibling, { recursive: true });
    const siblingFile = writeFile(base, "foobar/note.md", "hi");
    const cfg = config();

    expect(matchTrackedFile(workspaceRoot, siblingFile, cfg)).toBeNull();
    // The root itself is not a trackable "file".
    expect(matchTrackedFile(workspaceRoot, workspaceRoot, cfg)).toBeNull();
    // A genuine ancestor is outside too.
    expect(matchTrackedFile(workspaceRoot, base, cfg)).toBeNull();

    cleanupWorkspace(base);
  });

  test("missing and non-regular targets are never tracked", () => {
    const missing = join(root, "never-existed.md");
    const dir = makeDir(root, "a-directory.md"); // a directory that happens to match the include glob by name
    const cfg = config();

    expect(matchTrackedFile(root, missing, cfg)).toBeNull();
    expect(matchTrackedFile(root, dir, cfg)).toBeNull();
    expect(resolveMatchedFiles(root, cfg).tracked).toEqual([]);
  });

  test("bounded (loose-file) registrations bypass extension/exclusion/size policy but require an exact path match", () => {
    const oversizedJson = writeFile(root, "artifact.json", 1000); // wrong extension AND over any small threshold
    const other = writeFile(root, "other.json", 1000);
    const focus = "artifact.json";
    const workspace = {
      registration_id: "loose-1",
      kind: "loose-file" as const,
      canonical_path: oversizedJson,
      worktree_path: root,
      bus_path: join(root, ".glosa-state"),
      tracking: { mode: "bounded" as const, paths: [focus] },
    };
    const cfg = config({ maxFileBytes: 10 }); // would reject this file's size under matcher policy

    const list = resolveTrackedFiles(workspace);
    expect(list.tracked.map((f) => f.path)).toEqual([focus]);

    const matched = matchTrackedFile(workspace, oversizedJson, cfg);
    expect(matched).not.toBeNull();
    expect(matched!.path).toBe(focus);
    expect(matched!.sizeBytes).toBe(1000);

    // A DIFFERENT file, even one that would pass ordinary matcher policy just as poorly, is not
    // this registration's bounded path and must not match.
    expect(matchTrackedFile(workspace, other, cfg)).toBeNull();
  });

  test("bounded registration: a symlink at the exact bounded path is still refused", () => {
    const real = writeFile(root, "real.md", "hi");
    const linkPath = join(root, "link.md");
    makeSymlink(real, linkPath);
    const workspace = {
      registration_id: "loose-2",
      kind: "loose-file" as const,
      canonical_path: linkPath,
      worktree_path: root,
      bus_path: join(root, ".glosa-state"),
      tracking: { mode: "bounded" as const, paths: ["link.md"] },
    };
    expect(matchTrackedFile(workspace, linkPath)).toBeNull();
  });
});

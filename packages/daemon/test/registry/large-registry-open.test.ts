// SPDX-License-Identifier: Apache-2.0
// Issue #281 — named regressions proving the real HTTP-shaped open transaction never falls back
// to the complete tracked-file resolver for an unrelated (or the target's own large owning)
// registration. Each test spies on `matcher.resolveMatchedFiles` — the ONE function underneath
// every complete recursive walk (`resolveMatchedFiles` itself and, through it, `resolveTrackedFiles`
// for any matcher-mode registration) — and makes it throw for a specific "poisoned" root. A
// regression here is deterministic: either the poisoned root is never walked (test stays green), or
// it is (test fails with the poison error), never a timing race.
//
// This is also the ablation target for contract criterion 5 (#281): temporarily reverting any of
// the point-membership call sites back to `resolveTrackedFiles(...).tracked.find(...)` /
// `resolveMatchedFiles(...).tracked.some(...)` must turn the matching test here red.
import { linkSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";
import * as matcher from "../../src/matcher.ts";
import { WorkspaceIndex, type WorkspaceIndexDeps } from "../../src/registry/workspace-index.ts";
import { workspaceWorktree } from "../../src/workspace.ts";
import { cleanup, deterministicClock, freshHome, freshWorkspaceDir } from "./helpers.ts";

let poisonedRoots: Set<string>;

beforeEach(() => {
  poisonedRoots = new Set();
});

function indexWithTraversalPoison(deps: WorkspaceIndexDeps): WorkspaceIndex {
  return new WorkspaceIndex({
    ...deps,
    resolveTrackedFiles: (workspace, options) => {
      const root = workspaceWorktree(workspace);
      if (poisonedRoots.has(root)) {
        throw new Error(`POISON: complete tracked-file resolver invoked for unrelated root ${root}`);
      }
      return matcher.resolveTrackedFiles(workspace, options);
    },
  });
}

function poison(root: string): void {
  poisonedRoots.add(realpathSync.native(root).normalize("NFC"));
}

describe("issue #281 — ordinary direct-file open never enumerates an unrelated registered tree", () => {
  test("an nlink=1 file with no owning directory does not walk an unrelated large registration", async () => {
    const home = freshHome();
    const poisoned = freshWorkspaceDir();
    writeFileSync(join(poisoned, "note.md"), "hi");
    const targetDir = freshWorkspaceDir();
    const target = join(targetDir, "doc.md");
    writeFileSync(target, "hello");

    const index = indexWithTraversalPoison({ home, now: deterministicClock() });
    await index.resolveOpenTarget(poisoned); // registers the poisoned directory
    poison(poisoned);

    const result = await index.resolveOpenTarget(target);
    expect(result.entry.kind).toBe("loose-file");
    expect(result.focus).toBe("doc.md");

    cleanup(home);
    cleanup(poisoned);
    cleanup(targetDir);
  });

  test("a file owned by a large directory registration is resolved by point membership, not a full walk of that SAME tree", async () => {
    const home = freshHome();
    const owner = freshWorkspaceDir();
    for (let i = 0; i < 50; i++) writeFileSync(join(owner, `f${i}.md`), "x");
    const target = join(owner, "target.md");
    writeFileSync(target, "hello");

    const index = indexWithTraversalPoison({ home, now: deterministicClock() });
    await index.resolveOpenTarget(owner); // registers the directory (upsertDirectoryForOpen itself does not walk)
    poison(owner); // now poison it — any subsequent point-membership call must not walk it

    const result = await index.resolveOpenTarget(target);
    expect(result.entry.kind).toBe("directory");
    expect(result.focus).toBe("target.md");

    cleanup(home);
    cleanup(owner);
  });

  test("ablation control: poisoning the target root itself DOES fail (proves the spy is load-bearing)", async () => {
    const home = freshHome();
    const owner = freshWorkspaceDir();
    const target = join(owner, "target.md");
    writeFileSync(target, "hello");
    const index = indexWithTraversalPoison({ home, now: deterministicClock() });
    await index.resolveOpenTarget(owner);
    poison(owner);

    // `focusFirst` is intentionally a complete-list consumer. Its failure proves the injected
    // resolver seam observes the production binding that the point-path tests must avoid.
    await expect(index.resolveOpenTarget(owner, { focusFirst: true })).rejects.toThrow(/POISON/);

    cleanup(home);
    cleanup(owner);
  });
});

describe("issue #281 — adoption never walks a target with no eligible loose-file source", () => {
  test("beginAdoption returns null without ever resolving the target's complete tracked list", async () => {
    const home = freshHome();
    const target = freshWorkspaceDir();
    for (let i = 0; i < 50; i++) writeFileSync(join(target, `f${i}.md`), "x");

    const index = indexWithTraversalPoison({ home, now: deterministicClock() });
    const opened = await index.resolveOpenTarget(target); // directory registration, zero loose-file sources
    poison(target);

    const record = await index.beginAdoption(opened.entry);
    expect(record).toBeNull();

    cleanup(home);
    cleanup(target);
  });

  test("beginAdoption point-tests only the already-filtered candidates, not the target's whole tree", async () => {
    const home = freshHome();
    const target = freshWorkspaceDir();
    for (let i = 0; i < 50; i++) writeFileSync(join(target, `f${i}.md`), "x");
    const loose = join(target, "loose.md");
    writeFileSync(loose, "hi");

    const index = indexWithTraversalPoison({ home, now: deterministicClock() });
    const looseOpened = await index.resolveOpenTarget(loose); // creates a loose-file registration
    expect(looseOpened.entry.kind).toBe("loose-file");
    mkdirSync(looseOpened.entry.bus_path, { recursive: true }); // beginAdoption requires an existing source bus
    const dirOpened = await index.resolveOpenTarget(target); // directory registration containing `loose.md`
    poison(target);

    const record = await index.beginAdoption(dirOpened.entry);
    expect(record).not.toBeNull();
    expect(record!.sources.map((s) => s.target_path)).toEqual(["loose.md"]);

    cleanup(home);
    cleanup(target);
  });
});

describe("issue #281 — explicit focus is a point question, not a complete-list walk", () => {
  test("`glosa open <dir> <focus>` resolves without enumerating the rest of the directory's tree", async () => {
    const home = freshHome();
    const dir = freshWorkspaceDir();
    for (let i = 0; i < 50; i++) writeFileSync(join(dir, `f${i}.md`), "x");
    const focusFile = join(dir, "focus.md");
    writeFileSync(focusFile, "hello");

    const index = indexWithTraversalPoison({ home, now: deterministicClock() });
    await index.resolveOpenTarget(dir);
    poison(dir);

    const result = await index.resolveOpenTarget(dir, { focus: focusFile });
    expect(result.focus).toBe("focus.md");

    cleanup(home);
    cleanup(dir);
  });

  test("focusFirst remains a genuine list consumer — poisoning the same root fails it (control)", async () => {
    const home = freshHome();
    const dir = freshWorkspaceDir();
    writeFileSync(join(dir, "a.md"), "hi");

    const index = indexWithTraversalPoison({ home, now: deterministicClock() });
    await index.resolveOpenTarget(dir);
    poison(dir);

    await expect(index.resolveOpenTarget(dir, { focusFirst: true })).rejects.toThrow(/POISON/);

    cleanup(home);
    cleanup(dir);
  });
});

describe("issue #281 — enclosing-repository promotion is a point question", () => {
  test("promoting a file's enclosing git repo does not walk the repo's whole tree to decide", async () => {
    const home = freshHome();
    const repo = freshWorkspaceDir();
    mkdirSync(join(repo, ".git"), { recursive: true }); // enclosingGitRootWithin only needs `.git` to exist
    for (let i = 0; i < 50; i++) writeFileSync(join(repo, `f${i}.md`), "x");
    const target = join(repo, "target.md");
    writeFileSync(target, "hello");
    poison(repo);

    const index = indexWithTraversalPoison({ home, now: deterministicClock() });
    const result = await index.resolveOpenTarget(target);
    expect(result.entry.kind).toBe("directory");
    expect(result.entry.canonical_path.endsWith(repo.split("/").pop()!)).toBe(true);
    expect(result.focus).toBe("target.md");

    cleanup(home);
    cleanup(repo);
  });
});

describe("issue #281 — exact-path reopen preserves durable metadata, not only id/path", () => {
  test("reopening the same loose file refreshes last_seen but keeps first_seen/registration_id/bus_path stable", async () => {
    const home = freshHome();
    const dir = freshWorkspaceDir();
    const file = join(dir, "doc.md");
    writeFileSync(file, "hello");
    const clock = deterministicClock();
    const index = indexWithTraversalPoison({ home, now: clock });

    const first = await index.resolveOpenTarget(file);
    expect(first.entry.kind).toBe("loose-file");
    const firstSeen = first.entry.first_seen;
    const registrationId = first.entry.registration_id;
    const busPath = first.entry.bus_path;
    const slug = first.entry.slug;

    const second = await index.resolveOpenTarget(file);
    expect(second.entry.registration_id).toBe(registrationId);
    expect(second.entry.bus_path).toBe(busPath);
    expect(second.entry.slug).toBe(slug);
    expect(second.entry.first_seen).toBe(firstSeen); // NOT recreated
    expect(second.entry.last_seen).not.toBe(first.entry.last_seen); // but refreshed
    expect(index.list()).toHaveLength(1); // no duplicate registration

    cleanup(home);
    cleanup(dir);
  });

  test("reopening after the file went absent and came back restores present:true without a new registration", async () => {
    const home = freshHome();
    const dir = freshWorkspaceDir();
    const file = join(dir, "doc.md");
    writeFileSync(file, "hello");
    const index = indexWithTraversalPoison({ home, now: deterministicClock() });

    const first = await index.resolveOpenTarget(file);
    const registrationId = first.entry.registration_id;

    const second = await index.resolveOpenTarget(file);
    expect(second.entry.registration_id).toBe(registrationId);
    expect(second.entry.present).toBe(true);
    expect(second.entry.absent_since).toBeUndefined();

    cleanup(home);
    cleanup(dir);
  });
});

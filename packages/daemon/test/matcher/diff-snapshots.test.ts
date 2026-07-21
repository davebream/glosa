// SPDX-License-Identifier: Apache-2.0
// P2.2 — diffSnapshots: pure threshold-crossing diff between two resolveMatchedFiles() results
// (A4 §F20). Grow-past-threshold and shrink-under are the two crossing events the matcher itself
// is responsible for surfacing; new/deleted are included for completeness of the file-tracking
// lifecycle. Journal wiring is a later task — this only asserts the event descriptors.
import { describe, expect, test } from "bun:test";
import { diffSnapshots, type ResolveMatchedFilesResult } from "../../src/matcher.ts";

function snapshot(tracked: string[], oversize: string[]): ResolveMatchedFilesResult {
  return {
    tracked: tracked.map((path) => ({ path, rawPath: `/ws/${path}`, sizeBytes: 10 })),
    oversize: oversize.map((path) => ({ path, rawPath: `/ws/${path}`, sizeBytes: 999_999_999 })),
    skippedSymlinks: [],
  };
}

describe("diffSnapshots", () => {
  test("a file that grows past the threshold (tracked -> oversize) emits file_untracked{oversize}", () => {
    const prev = snapshot(["a.md"], []);
    const next = snapshot([], ["a.md"]);
    expect(diffSnapshots(prev, next)).toEqual([{ type: "file_untracked", path: "a.md", reason: "oversize" }]);
  });

  test("a file that shrinks under the threshold (oversize -> tracked) emits file_tracked", () => {
    const prev = snapshot([], ["a.md"]);
    const next = snapshot(["a.md"], []);
    expect(diffSnapshots(prev, next)).toEqual([{ type: "file_tracked", path: "a.md" }]);
  });

  test("a brand-new file emits file_tracked", () => {
    const prev = snapshot([], []);
    const next = snapshot(["new.md"], []);
    expect(diffSnapshots(prev, next)).toEqual([{ type: "file_tracked", path: "new.md" }]);
  });

  test("a deleted tracked file emits file_untracked{deleted}", () => {
    const prev = snapshot(["gone.md"], []);
    const next = snapshot([], []);
    expect(diffSnapshots(prev, next)).toEqual([{ type: "file_untracked", path: "gone.md", reason: "deleted" }]);
  });

  test("a deleted oversize file emits nothing (it was never tracked, so there's nothing to untrack)", () => {
    const prev = snapshot([], ["heavy.md"]);
    const next = snapshot([], []);
    expect(diffSnapshots(prev, next)).toEqual([]);
  });

  test("an unchanged tracked file emits nothing", () => {
    const prev = snapshot(["stable.md"], []);
    const next = snapshot(["stable.md"], []);
    expect(diffSnapshots(prev, next)).toEqual([]);
  });

  test("an unchanged oversize file emits nothing", () => {
    const prev = snapshot([], ["stable-heavy.md"]);
    const next = snapshot([], ["stable-heavy.md"]);
    expect(diffSnapshots(prev, next)).toEqual([]);
  });

  test("multiple simultaneous crossings are all reported, sorted by byte order on path", () => {
    // a-grows.md crosses tracked->oversize, z-shrinks.md crosses oversize->tracked, gone.md is
    // deleted, new.md is new — all four in one diff.
    const prev = snapshot(["a-grows.md", "gone.md"], ["z-shrinks.md"]);
    const next = snapshot(["z-shrinks.md", "new.md"], ["a-grows.md"]);
    expect(diffSnapshots(prev, next)).toEqual([
      { type: "file_untracked", path: "a-grows.md", reason: "oversize" },
      { type: "file_untracked", path: "gone.md", reason: "deleted" },
      { type: "file_tracked", path: "new.md" },
      { type: "file_tracked", path: "z-shrinks.md" },
    ]);
  });
});

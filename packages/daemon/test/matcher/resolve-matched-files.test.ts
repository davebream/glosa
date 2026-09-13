// SPDX-License-Identifier: Apache-2.0
// The canonical matcher walk, bounded (#216). `resolveMatchedFiles` is one synchronous call, and
// on a large workspace it holds the daemon's only thread long enough for the stall watchdog to end
// the process. A caller that only needs to know whether a tree exceeds a budget can stop at the
// budget; these pin that the bound takes effect and that an unbounded call is unchanged.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveMatchedFiles } from "../../src/matcher.ts";

describe("a bounded walk stops at the budget instead of walking the whole tree", () => {
  // Why this exists. The walk is one synchronous call. A workspace of 100k files takes tens of
  // seconds, on the daemon's only thread, to answer a question already decided thousands of files
  // earlier: "is this bigger than the watch budget?". A daemon doing that for several registered
  // workspaces stops answering its own handshake and the watchdog ends it.
  test("a tree past the limit returns a truncated prefix; the same tree unbounded returns all of it", () => {
    const root = mkdtempSync(join(tmpdir(), "glosa-bounded-walk-"));
    try {
      for (let i = 0; i < 60; i++) writeFileSync(join(root, `note-${i}.md`), `note ${i}\n`);

      const whole = resolveMatchedFiles(root);
      const bounded = resolveMatchedFiles(root, undefined, { limit: 10 });

      // The unbounded walk is unchanged — every existing caller still gets the complete tree.
      expect(whole.truncated).toBe(false);
      expect(whole.tracked.length).toBe(60);

      // The bounded walk stopped, said so, and returned strictly less than the tree.
      expect(bounded.truncated).toBe(true);
      expect(bounded.tracked.length).toBeLessThan(whole.tracked.length);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a tree inside the limit is complete and is NOT marked truncated", () => {
    const root = mkdtempSync(join(tmpdir(), "glosa-bounded-walk-small-"));
    try {
      for (let i = 0; i < 5; i++) writeFileSync(join(root, `note-${i}.md`), `note ${i}\n`);
      const bounded = resolveMatchedFiles(root, undefined, { limit: 1_000 });
      expect(bounded.truncated).toBe(false);
      expect(bounded.tracked.length).toBe(5);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

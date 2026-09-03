// SPDX-License-Identifier: Apache-2.0
// Direct A2/A3 coverage for the absolute transcript-root trust boundary. The HTTP stream suite
// covers two end-to-end cases; these tests pin every rejection branch and nearest-ancestor logic.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeConfigDir, confineTranscriptPath } from "../../src/transcript/root.ts";

describe("transcript root confinement", () => {
  let root: string;
  let outside: string;
  let previousClaudeConfigDir: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "glosa-transcript-root-"));
    outside = mkdtempSync(join(tmpdir(), "glosa-transcript-outside-"));
    previousClaudeConfigDir = Bun.env.CLAUDE_CONFIG_DIR;
  });

  afterEach(() => {
    if (previousClaudeConfigDir === undefined) delete Bun.env.CLAUDE_CONFIG_DIR;
    else Bun.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  test("claudeConfigDir reads the configured root at call time", () => {
    Bun.env.CLAUDE_CONFIG_DIR = root;
    expect(claudeConfigDir()).toBe(root);
  });

  test("accepts existing and not-yet-created transcripts beneath the real root", () => {
    const existing = join(root, "projects", "p1", "session.jsonl");
    mkdirSync(join(root, "projects", "p1"), { recursive: true });
    writeFileSync(existing, "");

    expect(confineTranscriptPath(existing, root)).toEqual({ ok: true, realPath: existing });
    const future = join(root, "projects", "p1", "future", "session.jsonl");
    expect(confineTranscriptPath(future, root)).toEqual({ ok: true, realPath: future });
  });

  test("rejects a sibling-prefix path, relative input, empty input, and control characters", () => {
    const sibling = `${root}-attacker`;
    mkdirSync(sibling);
    try {
      expect(confineTranscriptPath(join(sibling, "session.jsonl"), root).ok).toBe(false);
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
    expect(confineTranscriptPath("projects/session.jsonl", root).ok).toBe(false);
    expect(confineTranscriptPath("", root).ok).toBe(false);
    expect(confineTranscriptPath(join(root, "bad\nname.jsonl"), root).ok).toBe(false);
  });

  test("rejects existing and future leaves through a symlink that escapes the root", () => {
    const outsideFile = join(outside, "session.jsonl");
    writeFileSync(outsideFile, "");
    symlinkSync(outside, join(root, "escape"));

    expect(confineTranscriptPath(join(root, "escape", "session.jsonl"), root).ok).toBe(false);
    expect(confineTranscriptPath(join(root, "escape", "future.jsonl"), root).ok).toBe(false);
  });

  test("fails closed when the configured root does not exist", () => {
    expect(confineTranscriptPath(join(root, "session.jsonl"), join(outside, "missing-root")).ok).toBe(false);
  });
});

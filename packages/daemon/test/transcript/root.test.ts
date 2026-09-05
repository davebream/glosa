// SPDX-License-Identifier: Apache-2.0
// Direct A2/A3 coverage for the absolute transcript-root trust boundary. The HTTP stream suite
// covers two end-to-end cases; these tests pin every rejection branch and nearest-ancestor logic.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { claudeConfigDir, claudeConfigRoots, confineTranscriptPath } from "../../src/transcript/root.ts";

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

// The daemon is a singleton: it inherits ONE CLAUDE_CONFIG_DIR from whichever process spawned it,
// but serves sessions from every Claude config root on the machine. An account switcher's sessions
// report a transcript_path under their own instance directory, so confinement against a single
// root refuses them and the conversation view is dead for those sessions.
describe("transcript confinement across several Claude config roots", () => {
  let first: string;
  let second: string;
  let outside: string;

  beforeEach(() => {
    first = mkdtempSync(join(tmpdir(), "glosa-root-a-"));
    second = mkdtempSync(join(tmpdir(), "glosa-root-b-"));
    outside = mkdtempSync(join(tmpdir(), "glosa-root-out-"));
  });

  afterEach(() => {
    for (const dir of [first, second, outside]) rmSync(dir, { recursive: true, force: true });
  });

  test("a transcript under ANY supplied root is admitted", () => {
    const inSecond = join(second, "projects", "p", "session.jsonl");
    mkdirSync(join(second, "projects", "p"), { recursive: true });
    writeFileSync(inSecond, "");
    expect(confineTranscriptPath(inSecond, [first, second])).toEqual({ ok: true, realPath: inSecond });
  });

  test("more roots never weaken confinement — outside every one of them is still refused", () => {
    const beyond = join(outside, "session.jsonl");
    writeFileSync(beyond, "");
    expect(confineTranscriptPath(beyond, [first, second]).ok).toBe(false);
  });

  test("a symlink escape out of one root is refused even though another root exists", () => {
    // Realpath confinement is per root and applied to the RESOLVED path, so adding roots cannot
    // turn a symlink escape into an accepted path.
    writeFileSync(join(outside, "secret.jsonl"), "");
    symlinkSync(join(outside, "secret.jsonl"), join(first, "evil.jsonl"));
    expect(confineTranscriptPath(join(first, "evil.jsonl"), [first, second]).ok).toBe(false);
  });

  test("a root that does not exist is skipped, not treated as a wildcard", () => {
    const inFirst = join(first, "session.jsonl");
    writeFileSync(inFirst, "");
    expect(confineTranscriptPath(inFirst, [join(first, "gone"), first]).ok).toBe(true);
    expect(confineTranscriptPath(join(outside, "x.jsonl"), [join(first, "gone")]).ok).toBe(false);
  });

  test("no resolvable root at all refuses everything", () => {
    expect(confineTranscriptPath(join(first, "session.jsonl"), [join(first, "gone")]).ok).toBe(false);
    expect(confineTranscriptPath(join(first, "session.jsonl"), []).ok).toBe(false);
  });

  test("a single root string is still accepted, so every existing caller keeps working", () => {
    const inFirst = join(first, "session.jsonl");
    writeFileSync(inFirst, "");
    expect(confineTranscriptPath(inFirst, first)).toEqual({ ok: true, realPath: inFirst });
  });

  test("claudeConfigRoots always includes the active root and the documented default", () => {
    const previous = Bun.env.CLAUDE_CONFIG_DIR;
    Bun.env.CLAUDE_CONFIG_DIR = first;
    try {
      const roots = claudeConfigRoots();
      expect(roots).toContain(first);
      expect(roots).toContain(join(homedir(), ".claude"));
      // Deduplicated: an active root equal to the default must not appear twice.
      Bun.env.CLAUDE_CONFIG_DIR = join(homedir(), ".claude");
      const deduped = claudeConfigRoots();
      expect(deduped.filter((root) => root === join(homedir(), ".claude"))).toHaveLength(1);
    } finally {
      if (previous === undefined) delete Bun.env.CLAUDE_CONFIG_DIR;
      else Bun.env.CLAUDE_CONFIG_DIR = previous;
    }
  });
});

// SPDX-License-Identifier: Apache-2.0
// issue #96 — the single workspace-root rule shared by `glosa open`'s enclosing-repo resolution
// and `glosa init`/`glosa doctor`'s cwd default + risky-target guard.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyInitTarget,
  enclosingGitRoot,
  isGitRepoRoot,
  workspaceRootFor,
} from "../../src/registry/workspace-root.ts";
import { cleanup, freshWorkspaceDir } from "./helpers.ts";

/** `enclosingGitRoot`/`canonicalPath` realpath everything they return — on macOS, `$TMPDIR`
 * itself is a symlink (`/var/folders/...` -> `/private/var/folders/...`), so a raw
 * `freshWorkspaceDir()` path must be realpath'd before comparing it against a resolved root. */
function real(path: string): string {
  return realpathSync(path);
}

describe("isGitRepoRoot", () => {
  test("true for a directory-style .git", () => {
    const repo = freshWorkspaceDir();
    mkdirSync(join(repo, ".git"));
    expect(isGitRepoRoot(repo)).toBe(true);
    cleanup(repo);
  });

  test("true for a file-style .git (linked worktree / submodule)", () => {
    const repo = freshWorkspaceDir();
    writeFileSync(join(repo, ".git"), "gitdir: /somewhere/else\n");
    expect(isGitRepoRoot(repo)).toBe(true);
    cleanup(repo);
  });

  test("false for a plain directory", () => {
    const dir = freshWorkspaceDir();
    expect(isGitRepoRoot(dir)).toBe(false);
    cleanup(dir);
  });
});

describe("enclosingGitRoot", () => {
  test("finds the root from a deeply nested start directory", () => {
    const repo = freshWorkspaceDir();
    mkdirSync(join(repo, ".git"));
    const nested = join(repo, "a", "b", "c");
    mkdirSync(nested, { recursive: true });
    expect(enclosingGitRoot(nested)).toBe(real(repo));
    cleanup(repo);
  });

  test("returns null when no ancestor is a repo", () => {
    const dir = freshWorkspaceDir();
    expect(enclosingGitRoot(dir)).toBeNull();
    cleanup(dir);
  });

  test("the nearest repo wins over an outer one", () => {
    const outer = freshWorkspaceDir();
    mkdirSync(join(outer, ".git"));
    const inner = join(outer, "vendor", "lib");
    mkdirSync(join(inner, ".git"), { recursive: true });
    expect(enclosingGitRoot(inner)).toBe(real(inner));
    expect(enclosingGitRoot(join(outer, "other"))).toBe(real(outer));
    cleanup(outer);
  });

  test("a repo root itself is its own enclosing root", () => {
    const repo = freshWorkspaceDir();
    mkdirSync(join(repo, ".git"));
    expect(enclosingGitRoot(repo)).toBe(real(repo));
    cleanup(repo);
  });
});

describe("workspaceRootFor", () => {
  test("resolves to the enclosing repo when inside one", () => {
    const repo = freshWorkspaceDir();
    mkdirSync(join(repo, ".git"));
    const nested = join(repo, "docs");
    mkdirSync(nested);
    expect(workspaceRootFor(nested)).toEqual({ root: real(repo), kind: "git-repo" });
    cleanup(repo);
  });

  test("falls back to the literal (realpath'd) directory when not inside a repo", () => {
    const dir = freshWorkspaceDir();
    const result = workspaceRootFor(dir);
    expect(result.kind).toBe("literal");
    // freshWorkspaceDir() itself may already be a realpath, but the contract is realpath
    // equivalence, not literal string equality against a possibly-symlinked tmpdir.
    expect(enclosingGitRoot(result.root)).toBeNull();
    cleanup(dir);
  });
});

describe("classifyInitTarget", () => {
  test("a directory that is itself a git repo is always risk:none, even under a temp root", () => {
    const repo = mkdtempSync(join(tmpdir(), "glosa-root-test-"));
    mkdirSync(join(repo, ".git"));
    expect(classifyInitTarget(repo).risk).toBe("none");
    cleanup(repo);
  });

  test("a bare directory under $TMPDIR is risk:temp-dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "glosa-root-test-"));
    const verdict = classifyInitTarget(dir);
    expect(verdict.risk).toBe("temp-dir");
    expect(verdict.detail).toContain("temporary directory");
    cleanup(dir);
  });

  test("a bare directory under an injected custom temp root is risk:temp-dir", () => {
    const scratchRoot = freshWorkspaceDir();
    const dir = join(scratchRoot, "child");
    mkdirSync(dir);
    const verdict = classifyInitTarget(dir, { tempRoots: [scratchRoot] });
    expect(verdict.risk).toBe("temp-dir");
    cleanup(scratchRoot);
  });

  test("a directory that is not a repo but contains 2+ immediate git-repo subdirectories is risk:multi-repo", () => {
    // tempRoots: [] isolates this from the temp-dir branch so the multi-repo branch is exercised
    // in isolation — every real fixture in this suite otherwise lives under the system tmp root,
    // which would win the ladder first (see workspace-root.ts's ordering).
    const parent = freshWorkspaceDir();
    mkdirSync(join(parent, "repo-a", ".git"), { recursive: true });
    mkdirSync(join(parent, "repo-b", ".git"), { recursive: true });
    const verdict = classifyInitTarget(parent, { tempRoots: [] });
    expect(verdict.risk).toBe("multi-repo");
    expect(verdict.detail).toContain("repo-a");
    expect(verdict.detail).toContain("repo-b");
    cleanup(parent);
  });

  test("a directory with only ONE git-repo subdirectory is risk:none — the ladder needs 2+", () => {
    const parent = freshWorkspaceDir();
    mkdirSync(join(parent, "repo-a", ".git"), { recursive: true });
    mkdirSync(join(parent, "not-a-repo"));
    const verdict = classifyInitTarget(parent, { tempRoots: [] });
    expect(verdict.risk).toBe("none");
    cleanup(parent);
  });

  test("an ordinary project directory (not temp, not a multi-repo parent) is risk:none", () => {
    const dir = freshWorkspaceDir();
    const verdict = classifyInitTarget(dir, { tempRoots: [] });
    expect(verdict.risk).toBe("none");
    cleanup(dir);
  });

  test("temp-dir takes precedence over multi-repo when a target is both", () => {
    const tempParent = mkdtempSync(join(tmpdir(), "glosa-root-test-"));
    mkdirSync(join(tempParent, "repo-a", ".git"), { recursive: true });
    mkdirSync(join(tempParent, "repo-b", ".git"), { recursive: true });
    const verdict = classifyInitTarget(tempParent);
    expect(verdict.risk).toBe("temp-dir");
    cleanup(tempParent);
  });
});

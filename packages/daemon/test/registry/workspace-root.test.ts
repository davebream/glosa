// SPDX-License-Identifier: Apache-2.0
// issue #96 — the single workspace-root rule shared by `glosa open`'s enclosing-repo resolution
// and `glosa init`/`glosa doctor`'s cwd default + risky-target guard.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyInitTarget,
  enclosingGitRootWithin,
  isGitRepoRoot,
  isHomeOrAncestor,
  workspaceRootFor,
} from "../../src/registry/workspace-root.ts";
import { cleanup, freshWorkspaceDir } from "./helpers.ts";

/** `enclosingGitRootWithin`/`canonicalPath` realpath everything they return — on macOS, `$TMPDIR`
 * itself is a symlink (`/var/folders/...` -> `/private/var/folders/...`), so a raw
 * `freshWorkspaceDir()` path must be realpath'd before comparing it against a resolved root. */
function real(path: string): string {
  return realpathSync(path);
}

/** A `home` argument the fixtures below are never near, so `enclosingGitRootWithin`/
 * `workspaceRootFor`/`classifyInitTarget` behave exactly like their pre-#146 unbounded selves in
 * every test that isn't specifically about the home boundary. */
function unrelatedHome(): string {
  return freshWorkspaceDir();
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

describe("enclosingGitRootWithin", () => {
  test("finds the root from a deeply nested start directory", () => {
    const repo = freshWorkspaceDir();
    mkdirSync(join(repo, ".git"));
    const nested = join(repo, "a", "b", "c");
    mkdirSync(nested, { recursive: true });
    expect(enclosingGitRootWithin(nested, unrelatedHome())).toBe(real(repo));
    cleanup(repo);
  });

  test("returns null when no ancestor is a repo", () => {
    const dir = freshWorkspaceDir();
    expect(enclosingGitRootWithin(dir, unrelatedHome())).toBeNull();
    cleanup(dir);
  });

  test("the nearest repo wins over an outer one", () => {
    const outer = freshWorkspaceDir();
    mkdirSync(join(outer, ".git"));
    const inner = join(outer, "vendor", "lib");
    mkdirSync(join(inner, ".git"), { recursive: true });
    const home = unrelatedHome();
    expect(enclosingGitRootWithin(inner, home)).toBe(real(inner));
    expect(enclosingGitRootWithin(join(outer, "other"), home)).toBe(real(outer));
    cleanup(outer);
  });

  test("a repo root itself is its own enclosing root", () => {
    const repo = freshWorkspaceDir();
    mkdirSync(join(repo, ".git"));
    expect(enclosingGitRootWithin(repo, unrelatedHome())).toBe(real(repo));
    cleanup(repo);
  });

  // issue #146 — the boundary itself.
  test("a dotfiles-style repo AT the home directory is refused: null, not the repo", () => {
    const homeLike = freshWorkspaceDir();
    mkdirSync(join(homeLike, ".git"));
    const nested = join(homeLike, "Documents", "notes");
    mkdirSync(nested, { recursive: true });
    expect(enclosingGitRootWithin(nested, homeLike)).toBeNull();
    cleanup(homeLike);
  });

  test("a repo at an ANCESTOR of home is refused the same way", () => {
    const outer = freshWorkspaceDir();
    mkdirSync(join(outer, ".git"));
    const home = join(outer, "home");
    mkdirSync(home);
    const nested = join(home, "notes");
    mkdirSync(nested);
    expect(enclosingGitRootWithin(nested, home)).toBeNull();
    cleanup(outer);
  });

  test("a repo that is merely a SUBdirectory of home is unaffected", () => {
    const home = freshWorkspaceDir();
    const repo = join(home, "projects", "book");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const nested = join(repo, "chapters");
    mkdirSync(nested);
    expect(enclosingGitRootWithin(nested, home)).toBe(real(repo));
    cleanup(home);
  });
});

describe("isHomeOrAncestor", () => {
  test("true for home itself and every ancestor of it", () => {
    const outer = freshWorkspaceDir();
    const home = join(outer, "home");
    mkdirSync(home);
    expect(isHomeOrAncestor(real(home), real(home))).toBe(true);
    expect(isHomeOrAncestor(real(outer), real(home))).toBe(true);
    cleanup(outer);
  });

  test("false for a subdirectory of home", () => {
    const home = freshWorkspaceDir();
    const sub = join(home, "projects");
    mkdirSync(sub);
    expect(isHomeOrAncestor(real(sub), real(home))).toBe(false);
    cleanup(home);
  });

  test("false for an unrelated directory", () => {
    const home = freshWorkspaceDir();
    const other = freshWorkspaceDir();
    expect(isHomeOrAncestor(real(other), real(home))).toBe(false);
    cleanup(home);
    cleanup(other);
  });
});

describe("workspaceRootFor", () => {
  test("resolves to the enclosing repo when inside one", () => {
    const repo = freshWorkspaceDir();
    mkdirSync(join(repo, ".git"));
    const nested = join(repo, "docs");
    mkdirSync(nested);
    expect(workspaceRootFor(nested, unrelatedHome())).toEqual({ root: real(repo), kind: "git-repo" });
    cleanup(repo);
  });

  test("falls back to the literal (realpath'd) directory when not inside a repo", () => {
    const dir = freshWorkspaceDir();
    const home = unrelatedHome();
    const result = workspaceRootFor(dir, home);
    expect(result.kind).toBe("literal");
    // freshWorkspaceDir() itself may already be a realpath, but the contract is realpath
    // equivalence, not literal string equality against a possibly-symlinked tmpdir.
    expect(enclosingGitRootWithin(result.root, home)).toBeNull();
    cleanup(dir);
  });

  test("falls back to the literal directory when the enclosing repo is home (issue #146)", () => {
    const homeLike = freshWorkspaceDir();
    mkdirSync(join(homeLike, ".git"));
    const nested = join(homeLike, "notes");
    mkdirSync(nested);
    const result = workspaceRootFor(nested, homeLike);
    expect(result).toEqual({ root: real(nested), kind: "literal" });
    cleanup(homeLike);
  });
});

describe("classifyInitTarget", () => {
  test("a directory that is itself a git repo is always risk:none, even under a temp root", () => {
    const repo = mkdtempSync(join(tmpdir(), "glosa-root-test-"));
    mkdirSync(join(repo, ".git"));
    expect(classifyInitTarget(repo, { home: unrelatedHome() }).risk).toBe("none");
    cleanup(repo);
  });

  test("a bare directory under $TMPDIR is risk:temp-dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "glosa-root-test-"));
    const verdict = classifyInitTarget(dir, { home: unrelatedHome() });
    expect(verdict.risk).toBe("temp-dir");
    expect(verdict.detail).toContain("temporary directory");
    cleanup(dir);
  });

  test("a bare directory under an injected custom temp root is risk:temp-dir", () => {
    const scratchRoot = freshWorkspaceDir();
    const dir = join(scratchRoot, "child");
    mkdirSync(dir);
    const verdict = classifyInitTarget(dir, { tempRoots: [scratchRoot], home: unrelatedHome() });
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
    const verdict = classifyInitTarget(parent, { tempRoots: [], home: unrelatedHome() });
    expect(verdict.risk).toBe("multi-repo");
    expect(verdict.detail).toContain("repo-a");
    expect(verdict.detail).toContain("repo-b");
    cleanup(parent);
  });

  test("a directory with only ONE git-repo subdirectory is risk:none — the ladder needs 2+", () => {
    const parent = freshWorkspaceDir();
    mkdirSync(join(parent, "repo-a", ".git"), { recursive: true });
    mkdirSync(join(parent, "not-a-repo"));
    const verdict = classifyInitTarget(parent, { tempRoots: [], home: unrelatedHome() });
    expect(verdict.risk).toBe("none");
    cleanup(parent);
  });

  test("an ordinary project directory (not temp, not a multi-repo parent) is risk:none", () => {
    const dir = freshWorkspaceDir();
    const verdict = classifyInitTarget(dir, { tempRoots: [], home: unrelatedHome() });
    expect(verdict.risk).toBe("none");
    cleanup(dir);
  });

  test("temp-dir takes precedence over multi-repo when a target is both", () => {
    const tempParent = mkdtempSync(join(tmpdir(), "glosa-root-test-"));
    mkdirSync(join(tempParent, "repo-a", ".git"), { recursive: true });
    mkdirSync(join(tempParent, "repo-b", ".git"), { recursive: true });
    const verdict = classifyInitTarget(tempParent, { home: unrelatedHome() });
    expect(verdict.risk).toBe("temp-dir");
    cleanup(tempParent);
  });

  // issue #146 — the `home-dir` rung, placed ABOVE the repo-root rung.
  test("a dotfiles-style repo AT the home directory is risk:home-dir, not risk:none", () => {
    const homeLike = freshWorkspaceDir();
    mkdirSync(join(homeLike, ".git"));
    const verdict = classifyInitTarget(homeLike, { home: homeLike });
    expect(verdict.risk).toBe("home-dir");
    expect(verdict.detail).toContain(homeLike);
    cleanup(homeLike);
  });

  test("an ANCESTOR of home is risk:home-dir even when it is not itself a repo", () => {
    const outer = freshWorkspaceDir();
    const home = join(outer, "home");
    mkdirSync(home);
    const verdict = classifyInitTarget(outer, { home, tempRoots: [] });
    expect(verdict.risk).toBe("home-dir");
    cleanup(outer);
  });

  test("a directory that is merely a SUBdirectory of home is unaffected", () => {
    const home = freshWorkspaceDir();
    const project = join(home, "projects", "book");
    mkdirSync(join(project, ".git"), { recursive: true });
    const verdict = classifyInitTarget(project, { home });
    expect(verdict.risk).toBe("none");
    cleanup(home);
  });
});

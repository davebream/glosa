// SPDX-License-Identifier: Apache-2.0
// issue #96 — the single workspace-root rule shared by `glosa open`'s enclosing-repo resolution
// and `glosa doctor`'s cwd default.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
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
 * `workspaceRootFor` behaves exactly like its pre-#146 unbounded self in
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

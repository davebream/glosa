// SPDX-License-Identifier: Apache-2.0
// issue #146 — a boundary on workspace resolution. On a machine whose home directory is itself a
// git repository (a dotfiles checkout, common), the walk that picks a workspace root had no
// boundary and climbed to `$HOME` whenever no nearer repository existed, adopting the user's whole
// home directory as a workspace — bus at `~/.glosa`, shadow store at `~/.glosa/shadow.git`, and
// the matcher pointed at every `.md`/`.html`/`.txt` underneath. Four cases, each through the real
// entry point rather than a stand-in (contract.md's acceptance list, verbatim):
//
//   1. the nearest enclosing repository is home, resolved through the real no-`--dir` CLI path;
//   2. the same through the explicit-`--dir` CLI path;
//   3. `glosa open <file>` whose enclosing repository is home does not register `$HOME`, through
//      the real `WorkspaceIndex.resolveOpenTarget`;
//   4. a run seeded with an EXISTING `$HOME` directory registration does not silently reuse it,
//      and nothing durable is destroyed.
//
// Plus: `doctor` names the resolved workspace root, in both the human and `--json` shapes.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../packages/cli/src/index.ts";
import { FakeGlosaApiClient } from "../../packages/cli/test/fake-api-client.ts";
import { WorkspaceIndex, WorkspaceOpenError } from "../../packages/daemon/src/registry/workspace-index.ts";

let cleanupDirs: string[] = [];
/** Realpath'd at creation, not at comparison. On macOS `$TMPDIR` is itself a symlink
 * (`/var/folders/...` -> `/private/var/folders/...`), and every resolver under test canonicalizes
 * what it returns — so a raw `mkdtempSync` path makes each assertion depend on which spelling the
 * environment happened to hand back, and the same test then passes or fails on TMPDIR alone rather
 * than on the boundary it exists to check. `packages/daemon/test/registry/workspace-root.test.ts`
 * carries the same warning; this is that warning applied at the source instead of per assertion. */
function freshDir(prefix = "glosa-146-"): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanupDirs.push(d);
  return d;
}

/** A dotfiles-shaped home: a git repository at its root, with an unrelated nested document
 * underneath — the exact shape `understand.md`'s probe demonstrated the defect with. */
function freshDotfilesHome(): { home: string; nested: string; artifact: string } {
  const home = freshDir("glosa-146-home-");
  mkdirSync(join(home, ".git"));
  writeFileSync(join(home, ".zshrc"), "# dotfiles\n");
  const nested = join(home, "Documents", "notes");
  mkdirSync(nested, { recursive: true });
  const artifact = join(nested, "chapter.md");
  writeFileSync(artifact, "# Chapter\n\nProse.\n");
  return { home, nested, artifact };
}

afterEach(() => {
  for (const d of cleanupDirs) rmSync(d, { recursive: true, force: true });
  cleanupDirs = [];
});

function captureStdout(fn: () => Promise<number>): Promise<{ exitCode: number; out: string }> {
  const orig = process.stdout.write.bind(process.stdout);
  let out = "";
  // biome-ignore lint: test-only stdout capture
  (process.stdout.write as any) = (chunk: string) => {
    out += chunk;
    return true;
  };
  return fn()
    .then((exitCode) => ({ exitCode, out }))
    .finally(() => {
      process.stdout.write = orig;
    });
}

describe("workspace resolution never adopts the home directory (issue #146)", () => {
  test("1. no --dir: the real CLI path resolves cwd's enclosing home-repo to the literal cwd, not $HOME", async () => {
    const { home, nested } = freshDotfilesHome();
    const glosaHomeDir = freshDir("glosa-146-state-");
    const client = new FakeGlosaApiClient();

    const prevCwd = process.cwd();
    process.chdir(nested);
    let result: { exitCode: number; out: string };
    try {
      result = await captureStdout(() =>
        run(["doctor", "--json"], {
          init: { homeDir: home, glosaHomeDir },
          doctor: { createClient: async () => client, glosaHome: () => glosaHomeDir },
        }),
      );
    } finally {
      process.chdir(prevCwd);
    }

    const parsed = JSON.parse(result.out);
    const workspaceRootCheck = parsed.data.checks.find((c: { name: string }) => c.name === "workspace-root");
    expect(workspaceRootCheck).toBeDefined();
    expect(workspaceRootCheck.detail).toBe(`resolved workspace root: ${nested}`);
    expect(workspaceRootCheck.detail).not.toBe(`resolved workspace root: ${home}`);
  });

  test("doctor also names the resolved workspace root in the human (non-JSON) shape", async () => {
    const { home, nested } = freshDotfilesHome();
    const glosaHomeDir = freshDir("glosa-146-state-");
    const client = new FakeGlosaApiClient();

    const prevCwd = process.cwd();
    process.chdir(nested);
    let result: { exitCode: number; out: string };
    try {
      result = await captureStdout(() =>
        run(["doctor"], {
          init: { homeDir: home, glosaHomeDir },
          doctor: { createClient: async () => client, glosaHome: () => glosaHomeDir },
        }),
      );
    } finally {
      process.chdir(prevCwd);
    }

    const line = result.out.split("\n").find((l) => l.includes("workspace-root:"));
    expect(line).toBeDefined();
    expect(line).toBe(`[PASS] workspace-root: resolved workspace root: ${nested}`);
    expect(line).not.toBe(`[PASS] workspace-root: resolved workspace root: ${home}`);
  });

  test("2. explicit --dir: `glosa init` on the home directory itself is refused (home-dir risk), not silently adopted", async () => {
    const { home } = freshDotfilesHome();
    const glosaHomeDir = freshDir("glosa-146-state-");

    const refused = await captureStdout(() =>
      run(["init", home, "--agent", "claude-code", "--json"], {
        init: { homeDir: home, glosaHomeDir },
      }),
    );
    const refusedBody = JSON.parse(refused.out);
    expect(refusedBody.ok).toBe(false);
    expect(refusedBody.error.code).toBe("unsafe-init-target");
    expect(refusedBody.error.message).toContain(home);
    expect(refusedBody.exit_code).toBe(2);
    // Nothing durable was written — the refusal actually stopped the write, not merely warned.
    expect(existsSync(join(home, ".claude"))).toBe(false);

    // The refusal is clearable, per the design requirement: --force proceeds exactly like the
    // existing temp-dir/multi-repo risk classes.
    const forced = await captureStdout(() =>
      run(["init", home, "--agent", "claude-code", "--force", "--json"], {
        init: { homeDir: home, glosaHomeDir },
      }),
    );
    const forcedBody = JSON.parse(forced.out);
    expect(forcedBody.ok).toBe(true);
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(true);
  });

  test("2b. an explicit directory is never told its project root is $HOME", async () => {
    // The case above observes `classifyInitTarget`, which is a different mechanism: an independent
    // review proved it by pointing at ablation A, which removes `enclosingGitRootWithin`'s boundary
    // and leaves that case green. Writing the obvious replacement — assert the resolved dir is not
    // $HOME — turned out to assert nothing either: `resolveCommandDir`'s explicit-directory branch
    // ALWAYS returns the directory the user typed, so the boundary cannot change it.
    //
    // What the boundary does change on this path is the advice. Unbounded, the enclosing repository
    // of a directory under a dotfiles home is $HOME, so the command emits `not-repository-root`
    // telling the user their real project root is their home directory and inviting them to run
    // `glosa init` there. That is issue #96's accident pointed at home, and it is the observable
    // this entry point actually owns.
    const { home, nested } = freshDotfilesHome();
    const glosaHomeDir = freshDir("glosa-146-state-");
    const client = new FakeGlosaApiClient();
    // No `process.chdir`, deliberately: cwd is irrelevant here, so a green result cannot be coming
    // from the cwd branch case 1 already covers. `doctor` takes its target positionally.
    const result = await captureStdout(() =>
      run(["doctor", nested, "--json"], {
        init: { homeDir: home, glosaHomeDir },
        doctor: { createClient: async () => client, glosaHome: () => glosaHomeDir },
      }),
    );
    const parsed = JSON.parse(result.out);
    const suggestsHome = (parsed.warnings ?? []).filter(
      (w: { code: string; message: string }) => w.code === "not-repository-root" && w.message.includes(home),
    );
    expect(suggestsHome).toEqual([]);
    // And the directory it works in is still the one that was named.
    const check = parsed.data.checks.find((c: { name: string }) => c.name === "workspace-root");
    expect(check.detail).toBe(`resolved workspace root: ${nested}`);
  });

  test("3. glosa open <file>: the real WorkspaceIndex.resolveOpenTarget never registers $HOME for an unowned nested file", async () => {
    const { home, artifact } = freshDotfilesHome();
    const glosaHome = freshDir("glosa-146-state-");
    const index = new WorkspaceIndex({ home: glosaHome, userHomeDir: home });

    const opened = await index.resolveOpenTarget(artifact);
    expect(opened.entry.kind).toBe("loose-file");
    expect(opened.entry.worktree_path).not.toBe(home);

    const registeredDirectories = index.list().filter((e) => e.kind === "directory");
    expect(registeredDirectories.find((e) => e.worktree_path === home)).toBeUndefined();
  });

  test("4. an EXISTING $HOME directory registration is never silently reused, and nothing durable is destroyed", async () => {
    const { home, artifact } = freshDotfilesHome();
    const glosaHome = freshDir("glosa-146-state-");
    const index = new WorkspaceIndex({ home: glosaHome, userHomeDir: home });

    // Simulate a registration that predates this fix: the user explicitly opened $HOME itself
    // (the one code path this fix deliberately leaves alone — an explicit directory target, never
    // an automatic promotion) before the boundary existed.
    const seeded = await index.resolveOpenTarget(home);
    expect(seeded.entry.kind).toBe("directory");
    expect(seeded.entry.worktree_path).toBe(home);
    const seededSlug = seeded.entry.slug;

    // Opening an unrelated nested file must not silently reuse that hazardous registration.
    let thrown: unknown;
    try {
      await index.resolveOpenTarget(artifact);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(WorkspaceOpenError);
    expect((thrown as WorkspaceOpenError).code).toBe("home-workspace-registered");
    expect((thrown as Error).message).toContain(seededSlug);
    expect((thrown as Error).message).toContain(home);

    // Durable state is preserved: the original registration still exists, unchanged and present.
    const stillThere = index.get(home);
    expect(stillThere).not.toBeNull();
    expect(stillThere?.slug).toBe(seededSlug);
    expect(stillThere?.present).toBe(true);
  });
});

// P2.3 — shadow-git mechanics (A4 §F21): deterministic init, argv-safety (A3 §5 attack #5 at the
// git layer), config isolation, checkpoint idempotency, index.lock reclaim, delete/rename
// staging. Every test drives real system `git` against a hermetic tmp workspace — nothing here is
// mocked.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import {
  checkpoint,
  headSha,
  indexLockPath,
  initShadowRepo,
  reclaimIndexLock,
  runGit,
} from "../../src/git/shadow.ts";
import { journalPath, shadowGitDir } from "../../src/bus/paths.ts";
import { cleanupWorkspace, deterministicClock, deterministicUlid, freshWorkspace, testWriter, writeFile } from "./helpers.ts";

describe("initShadowRepo — deterministic init (A4 §F21)", () => {
  let root: string;
  beforeEach(() => {
    root = freshWorkspace();
  });
  afterEach(() => {
    cleanupWorkspace(root);
  });

  test("creates the shadow repo at .glosa/shadow.git with HEAD pinned to refs/heads/glosa", async () => {
    const writer = testWriter(root);
    await initShadowRepo(root, { writer, ulid: deterministicUlid(), now: deterministicClock() });
    writer.close();

    expect(existsSync(shadowGitDir(root))).toBe(true);
    const symref = await runGit(root, ["symbolic-ref", "HEAD"]);
    expect(symref.stdout.trim()).toBe("refs/heads/glosa");
  });

  test("applies the isolated repo-local config", async () => {
    const writer = testWriter(root);
    await initShadowRepo(root, { writer, ulid: deterministicUlid(), now: deterministicClock() });
    writer.close();

    const get = async (key: string) => (await runGit(root, ["config", "--local", key])).stdout.trim();
    expect(await get("core.autocrlf")).toBe("false");
    expect(await get("core.safecrlf")).toBe("false");
    expect(await get("commit.gpgsign")).toBe("false");
    expect(await get("core.fileMode")).toBe("false");
    expect(await get("core.quotepath")).toBe("false");
  });

  test("baseline commit has Glosa-Kind: baseline / Glosa-Attribution: unknown trailers and author glosa <glosa@localhost>", async () => {
    const writer = testWriter(root);
    await initShadowRepo(root, { writer, ulid: deterministicUlid(), now: deterministicClock() });
    writer.close();

    const show = await runGit(root, ["show", "-s", "--format=%an <%ae>%n%cn <%ce>%n%B", "HEAD"]);
    const [authorLine, committerLine, ...bodyLines] = show.stdout.split("\n");
    expect(authorLine).toBe("glosa <glosa@localhost>");
    expect(committerLine).toBe("glosa <glosa@localhost>");
    const body = bodyLines.join("\n");
    expect(body).toContain("Glosa-Kind: baseline");
    expect(body).toContain("Glosa-Attribution: unknown");
  });

  test("appends a baseline_checkpoint journal event", async () => {
    const writer = testWriter(root);
    await initShadowRepo(root, { writer, ulid: deterministicUlid(), now: deterministicClock() });
    writer.close();

    const journalText = readFileSync(journalPath(root), "utf8");
    expect(journalText).toContain('"baseline_checkpoint"');
  });

  test("re-init on an already-initialized repo is a no-op: still exactly one commit", async () => {
    const writer = testWriter(root);
    await initShadowRepo(root, { writer, ulid: deterministicUlid(), now: deterministicClock() });
    await initShadowRepo(root, { writer, ulid: deterministicUlid(500_000), now: deterministicClock(500_000) });
    writer.close();

    const count = await runGit(root, ["rev-list", "--count", "HEAD"]);
    expect(count.stdout.trim()).toBe("1");
  });
});

describe("argv-safety — A3 §5 attack #5 at the git layer", () => {
  let root: string;
  beforeEach(() => {
    root = freshWorkspace();
  });
  afterEach(() => {
    cleanupWorkspace(root);
  });

  test("a tracked file with a leading dash in its name is staged and committed, not read as a flag", async () => {
    writeFile(root, "-weird.md", "dangerous-looking name");
    const writer = testWriter(root);
    await initShadowRepo(root, { writer, ulid: deterministicUlid(), now: deterministicClock() });
    writer.close();

    const ls = await runGit(root, ["ls-files"]);
    expect(ls.stdout.split("\n")).toContain("-weird.md");
    const show = await runGit(root, ["show", "HEAD:-weird.md"]);
    expect(show.stdout).toBe("dangerous-looking name");
  });

  test("a tracked file with an embedded space and unicode is staged and committed correctly", async () => {
    writeFile(root, "a café note.md", "hi");
    const writer = testWriter(root);
    await initShadowRepo(root, { writer, ulid: deterministicUlid(), now: deterministicClock() });
    writer.close();

    // Plain (non-`-z`) output — this only stays unquoted because initShadowRepo sets
    // `core.quotepath=false`; that config is exactly what keeps `trackedUnion`'s own
    // `ls-tree`/plain-output parsing from mangling unicode filenames (see shadow.ts).
    const ls = await runGit(root, ["ls-files"]);
    expect(ls.stdout.split("\n")).toContain("a café note.md");
  });

  test("a unicode filename survives a second checkpoint (union staging via ls-tree parses the real name, not a quoted one)", async () => {
    writeFile(root, "a café note.md", "v1");
    const writer = testWriter(root);
    await initShadowRepo(root, { writer, ulid: deterministicUlid(), now: deterministicClock() });
    writer.close();

    writeFile(root, "a café note.md", "v2");
    const sha = await checkpoint(root, { attribution: "unknown", kind: "auto_checkpoint" });

    expect(sha).toBeTruthy();
    const content = (await runGit(root, ["show", "HEAD:a café note.md"])).stdout;
    expect(content).toBe("v2");
  });

  test("both a leading-dash file and a normal file can be staged together via a later checkpoint", async () => {
    writeFile(root, "-flag-like.md", "one");
    const writer = testWriter(root);
    await initShadowRepo(root, { writer, ulid: deterministicUlid(), now: deterministicClock() });
    writeFile(root, "normal.md", "two");
    const sha = await checkpoint(root, { attribution: "unknown", kind: "auto_checkpoint" });
    writer.close();

    expect(sha).not.toBe("");
    const ls = await runGit(root, ["ls-files"]);
    const files = ls.stdout.split("\n");
    expect(files).toContain("-flag-like.md");
    expect(files).toContain("normal.md");
  });
});

describe("isolated config — a bogus ambient gitconfig never leaks in", () => {
  let root: string;
  let bogusGlobalConfig: string;
  let savedGitConfigGlobal: string | undefined;

  beforeEach(() => {
    root = freshWorkspace();
    bogusGlobalConfig = `${root}.bogus-gitconfig`;
    writeFileSync(
      bogusGlobalConfig,
      "[user]\n\tname = evil\n\temail = evil@example.com\n[commit]\n\tgpgsign = true\n",
    );
    savedGitConfigGlobal = Bun.env.GIT_CONFIG_GLOBAL;
    Bun.env.GIT_CONFIG_GLOBAL = bogusGlobalConfig;
  });
  afterEach(() => {
    if (savedGitConfigGlobal === undefined) delete Bun.env.GIT_CONFIG_GLOBAL;
    else Bun.env.GIT_CONFIG_GLOBAL = savedGitConfigGlobal;
    cleanupWorkspace(root);
    try {
      unlinkSync(bogusGlobalConfig);
    } catch {
      // best-effort
    }
  });

  test("identity stays glosa <glosa@localhost> and gpgsign stays false despite the bogus ambient global config", async () => {
    const writer = testWriter(root);
    await initShadowRepo(root, { writer, ulid: deterministicUlid(), now: deterministicClock() });
    writer.close();

    const show = await runGit(root, ["show", "-s", "--format=%an <%ae>", "HEAD"]);
    expect(show.stdout.trim()).toBe("glosa <glosa@localhost>");
    const gpgsign = await runGit(root, ["config", "--local", "commit.gpgsign"]);
    expect(gpgsign.stdout.trim()).toBe("false");
  });
});

describe("checkpoint — idempotency (A4 §F21)", () => {
  let root: string;
  beforeEach(() => {
    root = freshWorkspace();
  });
  afterEach(() => {
    cleanupWorkspace(root);
  });

  test("no worktree change since the baseline -> returns HEAD, creates no new commit", async () => {
    writeFile(root, "notes.md", "hello");
    const writer = testWriter(root);
    await initShadowRepo(root, { writer, ulid: deterministicUlid(), now: deterministicClock() });
    writer.close();

    const before = await headSha(root);
    const countBefore = (await runGit(root, ["rev-list", "--count", "HEAD"])).stdout.trim();

    const sha = await checkpoint(root, { attribution: "unknown", kind: "auto_checkpoint" });

    expect(sha).toBe(before);
    const countAfter = (await runGit(root, ["rev-list", "--count", "HEAD"])).stdout.trim();
    expect(countAfter).toBe(countBefore);
  });

  test("a real change produces exactly one new commit with the right trailers", async () => {
    writeFile(root, "notes.md", "hello");
    const writer = testWriter(root);
    await initShadowRepo(root, { writer, ulid: deterministicUlid(), now: deterministicClock() });
    writer.close();

    const before = await headSha(root);
    writeFile(root, "notes.md", "hello, edited");

    const sha = await checkpoint(root, { attribution: "session:s1", kind: "post_apply", entry: "e1", lease: "l1" });

    expect(sha).not.toBe(before);
    const count = (await runGit(root, ["rev-list", "--count", "HEAD"])).stdout.trim();
    expect(count).toBe("2");
    const body = (await runGit(root, ["show", "-s", "--format=%B", "HEAD"])).stdout;
    expect(body).toContain("Glosa-Attribution: session:s1");
    expect(body).toContain("Glosa-Kind: post_apply");
    expect(body).toContain("Glosa-Entry: e1");
    expect(body).toContain("Glosa-Lease: l1");
  });
});

describe("index.lock reclaim", () => {
  let root: string;
  beforeEach(() => {
    root = freshWorkspace();
  });
  afterEach(() => {
    cleanupWorkspace(root);
  });

  test("a pre-existing index.lock is unlinked and a git_index_lock_reclaimed event is appended, then the op succeeds", async () => {
    const writer = testWriter(root);
    await initShadowRepo(root, { writer, ulid: deterministicUlid(), now: deterministicClock() });

    mkdirSync(shadowGitDir(root), { recursive: true });
    writeFileSync(indexLockPath(root), "");
    expect(existsSync(indexLockPath(root))).toBe(true);

    const reclaimed = reclaimIndexLock(root, { writer, ulid: deterministicUlid(999_000), now: deterministicClock(999_000) });
    expect(reclaimed).toBe(true);
    expect(existsSync(indexLockPath(root))).toBe(false);

    // The op that follows must succeed — the lock is really gone, not just relocated.
    const sha = await checkpoint(root, { attribution: "unknown", kind: "auto_checkpoint" });
    expect(sha).toBeTruthy();
    writer.close();

    const journalText = readFileSync(journalPath(root), "utf8");
    expect(journalText).toContain('"git_index_lock_reclaimed"');
  });

  test("no index.lock present -> no-op, returns false", () => {
    const writer = testWriter(root);
    const reclaimed = reclaimIndexLock(root, { writer, ulid: deterministicUlid(), now: deterministicClock() });
    writer.close();
    expect(reclaimed).toBe(false);
  });
});

describe("delete/rename staging (A4 §F21 union staging)", () => {
  let root: string;
  beforeEach(() => {
    root = freshWorkspace();
  });
  afterEach(() => {
    cleanupWorkspace(root);
  });

  test("deleting a tracked file: the next checkpoint stages the deletion", async () => {
    writeFile(root, "gone.md", "will be deleted");
    const writer = testWriter(root);
    await initShadowRepo(root, { writer, ulid: deterministicUlid(), now: deterministicClock() });
    writer.close();
    expect((await runGit(root, ["ls-files"])).stdout.split("\n")).toContain("gone.md");

    rmSync(`${root}/gone.md`);
    const sha = await checkpoint(root, { attribution: "unknown", kind: "auto_checkpoint" });

    expect(sha).toBeTruthy();
    const filesAfter = (await runGit(root, ["ls-files"])).stdout.split("\n").filter((l) => l.length > 0);
    expect(filesAfter).not.toContain("gone.md");
  });

  test("a rename is detectable via git diff -M", async () => {
    writeFile(root, "old-name.md", "same content, long enough for git's rename heuristic to notice ".repeat(5));
    const writer = testWriter(root);
    await initShadowRepo(root, { writer, ulid: deterministicUlid(), now: deterministicClock() });
    writer.close();
    const before = await headSha(root);

    rmSync(`${root}/old-name.md`);
    writeFile(
      root,
      "new-name.md",
      "same content, long enough for git's rename heuristic to notice ".repeat(5),
    );
    const after = await checkpoint(root, { attribution: "unknown", kind: "auto_checkpoint" });

    const diff = await runGit(root, ["diff", "-M", "--summary", before, after]);
    expect(diff.stdout).toContain("rename");
    expect(diff.stdout).toContain("old-name.md");
    expect(diff.stdout).toContain("new-name.md");
  });
});

describe("checkpoint — empty union never self-stages the shadow repo", () => {
  let root: string;
  beforeEach(() => {
    root = freshWorkspace();
  });
  afterEach(() => {
    cleanupWorkspace(root);
  });

  test("a workspace with nothing ever tracked: checkpoint is a true no-op, not a bare `git add -A`", async () => {
    // No tracked files at all -> the baseline is an empty-tree commit, and trackedUnion (current
    // ∪ HEAD-tracked) stays empty on every later checkpoint too.
    const writer = testWriter(root);
    await initShadowRepo(root, { writer, ulid: deterministicUlid(), now: deterministicClock() });
    writer.close();

    const before = await headSha(root);
    const countBefore = (await runGit(root, ["rev-list", "--count", "HEAD"])).stdout.trim();

    // Before the fix, an empty union fell through to a bare `git add -A`, which would stage the
    // ENTIRE work-tree — including `.glosa/shadow.git/` itself (its own objects/refs/journal) —
    // and this call would commit that. Assert it does neither.
    const sha = await checkpoint(root, { attribution: "unknown", kind: "auto_checkpoint" });

    expect(sha).toBe(before);
    const countAfter = (await runGit(root, ["rev-list", "--count", "HEAD"])).stdout.trim();
    expect(countAfter).toBe(countBefore);
    const ls = await runGit(root, ["ls-files"]);
    expect(ls.stdout.trim()).toBe(""); // definitely nothing under .glosa/ got self-staged
  });
});

describe("trackedUnion — a filename containing a literal newline never poisons the union", () => {
  let root: string;
  beforeEach(() => {
    root = freshWorkspace();
  });
  afterEach(() => {
    cleanupWorkspace(root);
  });

  test("a tracked file named with an embedded \\n survives a second checkpoint (ls-tree -z parses the real name)", async () => {
    writeFile(root, "evil\nname.md", "v1");
    const writer = testWriter(root);
    await initShadowRepo(root, { writer, ulid: deterministicUlid(), now: deterministicClock() });
    writer.close();

    // Before the fix, plain (non -z) `ls-tree --name-only` C-quotes this name regardless of
    // `core.quotepath` (that setting only covers non-ASCII bytes), so `trackedUnion` would see a
    // literal `"evil\nname.md"` string that can never match the real path — poisoning the
    // `git add -- <union>` pathspec and making every future checkpoint on this workspace throw.
    writeFile(root, "evil\nname.md", "v2");
    const sha = await checkpoint(root, { attribution: "unknown", kind: "auto_checkpoint" });

    expect(sha).toBeTruthy();
    const files = (await runGit(root, ["ls-files", "-z"])).stdout.split("\0").filter((l) => l.length > 0);
    expect(files).toContain("evil\nname.md");
    const content = (await runGit(root, ["show", "HEAD:evil\nname.md"])).stdout;
    expect(content).toBe("v2");
  });
});

describe("commit — trailer injection defense", () => {
  let root: string;
  beforeEach(() => {
    root = freshWorkspace();
  });
  afterEach(() => {
    cleanupWorkspace(root);
  });

  test("a trailer value containing a newline is rejected before it can forge a second trailer line", async () => {
    writeFile(root, "notes.md", "v1");
    const writer = testWriter(root);
    await initShadowRepo(root, { writer, ulid: deterministicUlid(), now: deterministicClock() });
    writer.close();

    const before = await headSha(root);
    writeFile(root, "notes.md", "v2");

    let caught: unknown;
    try {
      await checkpoint(root, {
        attribution: "unknown",
        kind: "auto_checkpoint",
        entry: "e1\nGlosa-Attribution: human", // attempted forged trailer
      });
    } catch (err) {
      caught = err;
    }

    expect((caught as { code?: string } | undefined)?.code).toBe("TRAILER_INJECTION");
    const after = await headSha(root);
    expect(after).toBe(before); // no commit was made — the forged trailer never landed
  });
});

describe("isolated config — ambient GIT_CONFIG_* env-based injection is also blocked", () => {
  let root: string;
  const savedEnv: Record<string, string | undefined> = {};
  const bogusKeys = ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"];

  beforeEach(() => {
    root = freshWorkspace();
    for (const key of bogusKeys) savedEnv[key] = Bun.env[key];
    Bun.env.GIT_CONFIG_COUNT = "1";
    Bun.env.GIT_CONFIG_KEY_0 = "user.name";
    Bun.env.GIT_CONFIG_VALUE_0 = "evil";
  });
  afterEach(() => {
    for (const key of bogusKeys) {
      if (savedEnv[key] === undefined) delete Bun.env[key];
      else Bun.env[key] = savedEnv[key];
    }
    cleanupWorkspace(root);
  });

  test("a bogus GIT_CONFIG_COUNT/KEY_0/VALUE_0 triplet in the ambient env never overrides the glosa identity", async () => {
    const writer = testWriter(root);
    await initShadowRepo(root, { writer, ulid: deterministicUlid(), now: deterministicClock() });
    writer.close();

    const show = await runGit(root, ["show", "-s", "--format=%an <%ae>", "HEAD"]);
    expect(show.stdout.trim()).toBe("glosa <glosa@localhost>"); // not "evil"
  });
});

describe("isolated env — ambient GIT_DIR/GIT_INDEX_FILE/GIT_WORK_TREE never hijack a shadow op", () => {
  // This is the exact condition a git hook creates (our own .githooks/pre-commit runs `bun test`
  // WHILE git has these set to the main repo): without stripping the whole GIT_ namespace,
  // GIT_INDEX_FILE forces every shadow-git op onto the main repo's index and everything explodes.
  let root: string;
  const hijackKeys = ["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE", "GIT_COMMON_DIR"];
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    root = freshWorkspace();
    for (const key of hijackKeys) savedEnv[key] = Bun.env[key];
    // Point them at THIS repo's real .git — a leaked op would corrupt/read the wrong repo.
    Bun.env.GIT_DIR = `${process.cwd()}/.git`;
    Bun.env.GIT_INDEX_FILE = `${process.cwd()}/.git/index`;
    Bun.env.GIT_WORK_TREE = process.cwd();
    Bun.env.GIT_COMMON_DIR = `${process.cwd()}/.git`;
  });
  afterEach(() => {
    for (const key of hijackKeys) {
      if (savedEnv[key] === undefined) delete Bun.env[key];
      else Bun.env[key] = savedEnv[key];
    }
    cleanupWorkspace(root);
  });

  test("init + checkpoint operate on the shadow repo, not the ambient GIT_DIR/index", async () => {
    const writer = testWriter(root);
    await initShadowRepo(root, { writer, ulid: deterministicUlid(), now: deterministicClock() });
    writeFile(root, "note.md", "hello");
    const sha = await checkpoint(root, { attribution: "unknown", kind: "auto_checkpoint" });
    writer.close();

    // The commit landed in the SHADOW repo (its own object store), and note.md is tracked there —
    // proving the op used --git-dir/--work-tree, not the leaked ambient main-repo index.
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    const files = await runGit(root, ["ls-files"]);
    expect(files.stdout.split("\n")).toContain("note.md");
  });
});

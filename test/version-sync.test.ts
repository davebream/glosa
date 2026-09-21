// SPDX-License-Identifier: Apache-2.0
//
// Guards the version-site table itself. The load-bearing cases are `absent` and `ambiguous`: a
// pattern that stops matching is the way a regex-driven gate turns into decoration while staying
// green, so "matched nothing" must be a named failure and never an empty failure list.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gitEnvironment } from "../scripts/git-env.ts";
import { ROOT } from "../scripts/test-plan.ts";
import {
  describeFailures,
  FORBIDDEN_VERSION_SITES,
  indexReader,
  inspect,
  readSite,
  type Reader,
  SOURCE_SITE,
  sourceVersion,
  VERSION_SITES,
  worktreeReader,
  writeSite,
} from "../scripts/version-sync.ts";

const PLUGIN = "glosa-plugin/.claude-plugin/plugin.json";
const MARKETPLACE = ".claude-plugin/marketplace.json";

function clean(): Record<string, string> {
  return {
    "package.json": `{\n  "name": "@davebream/glosa",\n  "version": "1.2.3"\n}\n`,
    [PLUGIN]: `{\n  "name": "glosa",\n  "version": "1.2.3",\n  "license": "Apache-2.0"\n}\n`,
    "README.md": "bun add --global https://registry.npmjs.org/@davebream/glosa/-/glosa-1.2.3.tgz\n",
    "test/oss-release.test.ts": `    expect(rootPackage.version).toBe("1.2.3");\n`,
    [MARKETPLACE]: `{\n  "plugins": [{ "name": "glosa", "source": "./glosa-plugin" }]\n}\n`,
  };
}

const reader =
  (files: Record<string, string>): Reader =>
  (path) =>
    files[path] ?? null;

describe("version site table", () => {
  test("a synced tree reports no failures", () => {
    expect(describeFailures(inspect(reader(clean()), "1.2.3"))).toEqual([]);
    expect(sourceVersion(reader(clean()))).toBe("1.2.3");
  });

  test("a drifted site is named with both versions", () => {
    const files = clean();
    files[PLUGIN] = files[PLUGIN]!.replace("1.2.3", "1.2.2");
    expect(describeFailures(inspect(reader(files), "1.2.3"))).toEqual([`${PLUGIN}: expected 1.2.3, found 1.2.2`]);
  });

  test("a site whose pattern matches nothing fails instead of passing vacuously", () => {
    const files = clean();
    files[PLUGIN] = files[PLUGIN]!.replace('"version"', '"pluginVersion"');
    const described = describeFailures(inspect(reader(files), "1.2.3"));
    expect(described).toHaveLength(1);
    expect(described[0]).toContain("matched nothing");
  });

  test("a site whose pattern matches twice fails instead of trusting the first hit", () => {
    const files = clean();
    files[PLUGIN] = `{\n  "version": "1.2.3",\n  "version": "1.2.3"\n}\n`;
    const described = describeFailures(inspect(reader(files), "1.2.3"));
    expect(described).toHaveLength(1);
    expect(described[0]).toContain("matched 2 times");
  });

  test("an unreadable site fails rather than being skipped", () => {
    const files = clean();
    delete files[PLUGIN];
    const described = describeFailures(inspect(reader(files), "1.2.3"));
    expect(described).toHaveLength(1);
    expect(described[0]).toContain("not readable");
  });

  test("a forbidden site is rejected even when it pins the CORRECT version", () => {
    // The correct version is the point: an equality check would pass here, so this proves the
    // guard forbids a third drift site rather than merely comparing it.
    const files = clean();
    files[MARKETPLACE] = `{\n  "plugins": [{ "name": "glosa", "version": "1.2.3" }]\n}\n`;
    const described = describeFailures(inspect(reader(files), "1.2.3"));
    expect(described).toHaveLength(1);
    expect(described[0]).toContain("must not pin a version");
  });

  test("a reworded README URL is absent, not silently accepted", () => {
    const files = clean();
    files["README.md"] = "bun add --global @davebream/glosa@1.2.3\n";
    const described = describeFailures(inspect(reader(files), "1.2.3"));
    expect(described).toHaveLength(1);
    expect(described[0]).toContain("matched nothing");
  });

  test("every site round-trips through write and read, and writing is a fixed point", () => {
    const files = clean();
    for (const site of VERSION_SITES) {
      const original = files[site.path]!;
      const once = writeSite(original, site, "9.9.9");
      expect(readSite(once, site), site.path).toEqual(["9.9.9"]);
      expect(writeSite(once, site, "9.9.9"), site.path).toBe(once);
      // Only the version changed: everything else is byte-identical.
      expect(once.replace("9.9.9", "1.2.3"), site.path).toBe(original);
    }
  });

  test("the table stays well formed as sites are added", () => {
    const paths = VERSION_SITES.map((site) => site.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(SOURCE_SITE.path).toBe("package.json");
    for (const site of [...VERSION_SITES, ...FORBIDDEN_VERSION_SITES])
      expect(site.pattern.global, site.path).toBe(true);
  });
});

describe("readers", () => {
  test("the index reader sees the staged blob where the worktree reader sees the edit", () => {
    const temp = mkdtempSync(join(tmpdir(), "glosa-version-sync-"));
    try {
      const git = (...args: string[]) =>
        Bun.spawnSync({
          cmd: ["git", ...args],
          cwd: temp,
          // #316: `cwd` alone does not pick the repository. Under a git hook — which exports
          // GIT_DIR — inheriting the ambient environment sent this `git init` at the REAL
          // repository and flipped its `core.bare` to true, breaking every worktree.
          env: gitEnvironment(),
          stdout: "pipe",
          stderr: "pipe",
        });
      git("init", "-q");
      const file = join(temp, PLUGIN);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `{\n  "version": "1.2.3"\n}\n`);
      git("add", "-A");
      // Staged: 1.2.3. Worktree: 9.9.9, never added.
      writeFileSync(file, `{\n  "version": "9.9.9"\n}\n`);

      expect(readSite(indexReader(temp)(PLUGIN)!, VERSION_SITES[1]!)).toEqual(["1.2.3"]);
      expect(readSite(worktreeReader(temp)(PLUGIN)!, VERSION_SITES[1]!)).toEqual(["9.9.9"]);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  test("#316 an ambient GIT_DIR cannot redirect a reader away from the root it was given", () => {
    // Git EXPORTS GIT_DIR into every hook's environment, so under `lefthook`'s pre-push the whole
    // test suite ran with it set to this repository. A reader that inherited it answered about
    // this repository no matter which root it was handed — the test above passed only because
    // nothing had set GIT_DIR when it ran directly. This one sets it on purpose.
    //
    // Only a READ happens while the hostile value is set. That is deliberate: the same hijack on a
    // `git init` is what reinitialized the real repository and flipped its `core.bare` to true.
    const temp = mkdtempSync(join(tmpdir(), "glosa-version-sync-hijack-"));
    const saved = process.env.GIT_DIR;
    try {
      const git = (...args: string[]) =>
        Bun.spawnSync({ cmd: ["git", ...args], cwd: temp, env: gitEnvironment(), stdout: "pipe", stderr: "pipe" });
      git("init", "-q");
      const file = join(temp, PLUGIN);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `{\n  "version": "1.2.3"\n}\n`);
      git("add", "-A");

      // Exactly what a hook hands its children, resolved the way git itself reports it.
      const realGitDir = Bun.spawnSync({
        cmd: ["git", "rev-parse", "--absolute-git-dir"],
        cwd: ROOT,
        env: gitEnvironment(),
        stdout: "pipe",
      });
      expect(realGitDir.exitCode, "the fixture needs this repository's real git dir").toBe(0);
      process.env.GIT_DIR = realGitDir.stdout.toString().trim();

      // Without the fix this reads THIS repository's staged package version instead.
      expect(readSite(indexReader(temp)(PLUGIN)!, VERSION_SITES[1]!)).toEqual(["1.2.3"]);
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved;
      rmSync(temp, { recursive: true, force: true });
    }
  });
});

// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MIN_JUNIT_BUN } from "../scripts/test-runner.ts";
import rootPackage from "../package.json";

const root = resolve(import.meta.dir, "..");
const workflows = ["ci.yml", "release.yml"].map((name) => readFileSync(join(root, ".github/workflows", name), "utf8"));
function job(yaml: string, name: string): string {
  const start = yaml.indexOf(`\n  ${name}:\n`);
  expect(start, name).toBeGreaterThan(-1);
  const next = yaml.slice(start + 1).search(/\n  [a-z]+:\n/);
  return next < 0 ? yaml.slice(start) : yaml.slice(start, start + 1 + next);
}

describe("repository quality gates", () => {
  test("lint rejects focused and skipped tests while allowing negative fixture source strings", () => {
    const directory = mkdtempSync(join(tmpdir(), "glosa-lint-policy-"));
    const file = join(directory, "fixture.test.ts");
    const lint = (source: string) => {
      writeFileSync(file, source);
      return Bun.spawnSync(
        [join(root, "node_modules/.bin/biome"), "lint", `--config-path=${root}`, "--vcs-enabled=false", file],
        {
          cwd: root,
          stdout: "pipe",
          stderr: "pipe",
        },
      );
    };
    try {
      for (const modifier of ["only", "skip"]) {
        const result = lint(`import { test } from "bun:test"; test.${modifier}("required scenario", () => {});`);
        expect(result.exitCode, result.stderr.toString()).not.toBe(0);
        expect(result.stderr.toString() + result.stdout.toString()).toContain(
          modifier === "only" ? "noFocusedTests" : "noSkippedTests",
        );
      }
      const control = lint('const source = "test.skip(negative fixture)"; console.log(source);');
      expect(control.exitCode, control.stderr.toString()).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  test("CI and release pin the packageManager runtime with the verified JUnit floor (#230)", () => {
    const pinned = rootPackage.packageManager.replace(/^bun@/, "");
    expect(Bun.semver.satisfies(pinned, `>=${MIN_JUNIT_BUN}`)).toBe(true);
    for (const yaml of workflows) {
      const pins = [...yaml.matchAll(/bun-version: ([^\s]+)/g)].map((match) => match[1]);
      expect(pins.length).toBeGreaterThan(0);
      expect([...new Set(pins)]).toEqual([pinned]);
    }
  });
  test("local check remains non-writing and includes whole-repository lint and formatting", () => {
    expect(rootPackage.scripts.lint).toBe("biome lint . --no-errors-on-unmatched");
    expect(rootPackage.scripts["format:check"]).toBe("biome format .");
    expect(rootPackage.scripts.check.split(" && ").at(-1)).toBe("bun run format:check");
  });
  test("CI and release execute complete partitions, independent stability, and the same reporting runner", () => {
    for (const yaml of workflows) {
      const tests = job(yaml, "tests");
      expect(tests).toContain("profile: [ci-1, ci-2, ci-3]");
      expect(tests).toContain("fail-fast: false");
      expect(tests).toContain('bun run scripts/test-runner.ts "$TEST_PARTITION"');
      expect(job(yaml, "stability")).toContain('bun run test:stability --repetitions "$TEST_REPETITIONS"');
      expect(job(yaml, "full")).toContain("if: needs.prepare.outputs.whole == 'true'");
      expect(job(yaml, "full")).toContain("bun run test:full");
      expect(job(yaml, "docs")).toContain("if: needs.prepare.outputs.profile == 'docs'");
      expect(job(yaml, "docs")).toContain("bun run test:docs");
      for (const name of ["tests", "stability", "full", "docs"]) {
        expect(job(yaml, name)).toContain("if: always()");
        expect(job(yaml, name)).toContain("retention-days: 14");
        expect(job(yaml, name)).toContain("if-no-files-found: error");
      }
    }
  });
  test("required aggregate always validates all selected dependencies using actual results", () => {
    for (const yaml of workflows) {
      const aggregate = job(yaml, "ci");
      expect(aggregate).toContain("if: always()");
      expect(aggregate).toContain("needs: [prepare, quality, docs, tests, stability, shell, full]");
      expect(aggregate).toContain("TEST_PROFILE: ${{ needs.prepare.outputs.profile }}");
      expect(aggregate).toContain("TEST_WHOLE: ${{ needs.prepare.outputs.whole }}");
      expect(aggregate).toContain("TEST_RESULTS: ${{ toJSON(needs) }}");
      expect(aggregate).toContain("bun run scripts/test-plan.ts aggregate");
      expect(yaml).not.toMatch(/^\s*paths(-ignore)?:/m);
      expect(yaml).not.toContain("continue-on-error");
    }
    expect(job(workflows[0]!, "ci")).toContain("name: ci");
    expect(job(workflows[0]!, "security")).toContain("name: security");
  });
  test("docs retain format and package checks; full profiles additionally lint, typecheck and audit licenses", () => {
    for (const yaml of workflows) {
      const quality = job(yaml, "quality");
      for (const script of ["lint", "typecheck", "audit:licenses"])
        expect(quality).toContain(`if: needs.prepare.outputs.profile == 'full'\n        run: bun run ${script}`);
      for (const script of ["format:check", "package:check"])
        expect(quality).toMatch(new RegExp(`- name: [^\\n]+\\n        run: bun run ${script}`));
    }
  });
  test("the release tag verification also checks every version site", () => {
    expect(job(workflows[1]!, "release")).toContain('bun run scripts/version-sync.ts --check --expect "${version}"');
  });
  test("pre-commit syncs the version sites into the commit rather than only checking the worktree", () => {
    const hooks = readFileSync(join(root, "lefthook.yml"), "utf8");
    expect(hooks).toContain("bun run scripts/version-sync.ts --write --stage");
    // --stage is the whole point: a write that is not staged leaves the commit drifted.
    expect(hooks).not.toMatch(/version-sync\.ts --write(?! --stage)/);
  });
  test("security never depends on the change filter, and publishing requires both validation and security", () => {
    for (const yaml of workflows) {
      const security = job(yaml, "security");
      expect(security).toContain("gitleaks");
      expect(security).toContain("osv-scanner");
      expect(security).not.toContain("needs:");
      expect(security).not.toMatch(/^\s+if:/m);
    }
    expect(job(workflows[1]!, "release")).toContain("needs: [ci, security]");
    expect(job(workflows[1]!, "release")).toContain("npm publish");
  });

  test("pull requests that shape the desktop app build it unsigned and smoke it, and nothing in CI signs (#371)", () => {
    const ci = workflows[0]!;
    expect(job(ci, "prepare")).toContain("app: ${{ steps.plan.outputs.app }}");
    const shell = job(ci, "shell");
    expect(shell).toContain(
      "- name: Build the unsigned app and smoke it\n        if: needs.prepare.outputs.app == 'true'\n        run: bun run --cwd packages/shell package -- --arch all --unsigned --smoke",
    );
    expect(shell).toContain("uses: actions/cache@0057852bfaa89a56745cba8c7296529d2fc39830");
    // The build runs BEFORE the real-Electron suite: that suite's first launch downloads Electron's
    // binary, and a build placed after it passed in CI while the release job, which builds first,
    // failed on node_modules/electron/dist (v0.1.0-alpha.32).
    const build = shell.indexOf("- name: Build the unsigned app and smoke it");
    const suite = shell.indexOf("- name: Run the shell's renderer security suite in real Electron");
    expect(build, "the app build step exists").toBeGreaterThan(-1);
    expect(suite, "the real-Electron suite step exists").toBeGreaterThan(-1);
    expect(build, "the app build runs before the real-Electron suite").toBeLessThan(suite);
    for (const secret of ["CSC_LINK", "CSC_KEY_PASSWORD", "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"])
      expect(ci).not.toContain(`secrets.${secret}`);
  });

  // #371: the desktop app is built on every tag, but only a signed and notarized app may reach a
  // release (Homebrew 5.0 deprecated unsigned casks; macOS 15.1+ refuses unsigned downloads). A
  // job-level `if:` cannot read secrets, so one step decides and every publishing step is gated on
  // its output. The signing secrets reach exactly one step.
  test("every tag publishes the desktop app, signed when the secrets exist and ad hoc otherwise, and a release without it is red", () => {
    const yaml = workflows[1]!;
    const app = job(yaml, "app");
    expect(app).toContain("needs: [release]");
    expect(app).toContain("if: always() && needs.release.result == 'success'");
    expect(app).toContain("contents: write");
    expect(app).toContain('APP_SIGNING_REQUIRED: "false"');
    expect(app).toContain("bun run --cwd packages/shell package -- --arch all --smoke");
    expect(app).toContain("bun run --cwd packages/shell package -- --arch all --unsigned --smoke");
    // The two builds branch on the signing decision; exactly one of them runs.
    expect(app).toContain(
      "- name: Build, sign, notarize and smoke both architectures\n        if: steps.signing.outputs.enabled == 'true'",
    );
    expect(app).toContain(
      "- name: Build and smoke an ad-hoc signed app\n        if: steps.signing.outputs.enabled != 'true'",
    );
    // Publishing does not: without a Developer ID the ad-hoc build is what people install (#371).
    for (const step of ["Write SHA256SUMS", "Upload the app to the release", "Update the Homebrew tap"]) {
      expect(app, step).toContain(`- name: ${step}\n`);
      expect(app, step).not.toContain(`- name: ${step}\n        if:`);
    }
    expect(app).toContain('gh release upload "$GITHUB_REF_NAME"');
    expect(app).toContain("packages/shell/dist/SHA256SUMS --clobber");
    expect(app).toContain("bun run scripts/cask-bump.ts");
    // The tap is written with a deploy key scoped to it, never a broad token.
    expect(app).toContain("HOMEBREW_TAP_DEPLOY_KEY: ${{ secrets.HOMEBREW_TAP_DEPLOY_KEY }}");
    expect(app).not.toContain("HOMEBREW_TAP_TOKEN");
    // The cask drops its quarantine instructions only for a build the signing step actually signed.
    expect(app).toContain("SIGNED: ${{ steps.signing.outputs.enabled }}");
    expect(app).toContain('if [ "${SIGNED}" = "true" ]; then notarized="--notarized"; fi');
    for (const secret of ["CSC_LINK", "CSC_KEY_PASSWORD", "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"]) {
      expect(app.split(`\${{ secrets.${secret} }}`).length - 1, secret).toBe(1);
    }
    const released = job(yaml, "released");
    expect(released).toContain("needs: [release, app]");
    expect(released).toContain("needs.app.result");
    // Both lockfiles are scanned: the shell's carries electron-builder and its dependencies.
    for (const workflow of workflows) expect(job(workflow, "security")).toContain("--lockfile=packages/shell/bun.lock");
  });

  // #316: git exports GIT_DIR into every hook's environment, so a spawned `git` that inherits the
  // ambient environment talks to whatever repository invoked the hook rather than the one `cwd`
  // names. That is how a test's throwaway `git init` reinitialized this repository and flipped its
  // `core.bare`, breaking every worktree. `gitEnvironment()` exists to prevent it; this pins that
  // the callers actually use it, because the failure is silent — the wrong repository answers
  // successfully.
  test("no git subprocess in scripts/ or test/ inherits the ambient repository selectors", () => {
    const sources: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith(".ts")) sources.push(path);
      }
    };
    walk(join(root, "scripts"));
    walk(join(root, "test"));
    expect(sources.length, "the scan found no sources, so it could not have failed").toBeGreaterThan(10);

    const offenders: string[] = [];
    for (const path of sources) {
      const lines = readFileSync(path, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (!/\["']git["']\s*,|cmd:\s*\[\s*["']git["']/.test(line)) return;
        // The env for a spawn sits within a few lines of its command.
        const window = lines.slice(Math.max(0, index - 4), index + 8).join("\n");
        if (/env:\s*\{[^}]*\.\.\.(process|Bun)\.env/.test(window)) {
          offenders.push(`${path.slice(root.length + 1)}:${index + 1}`);
        }
      });
    }
    expect(offenders, "spawn git with gitEnvironment(), never a spread of the ambient env").toEqual([]);
  });
});

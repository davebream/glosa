// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
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
  test("local check remains non-writing and includes whole-repository lint and formatting", () => {
    expect(rootPackage.scripts.lint).toBe("biome lint . --no-errors-on-unmatched");
    expect(rootPackage.scripts["format:check"]).toBe("biome format .");
    expect(rootPackage.scripts.check.split(" && ").at(-1)).toBe("bun run format:check");
  });
  test("CI and release execute complete partitions, independent stability, and the same reporting runner", () => {
    for (const yaml of workflows) {
      const tests = job(yaml, "tests");
      expect(tests).toContain("profile: [acceptance, remaining-1, remaining-2]");
      expect(tests).toContain("fail-fast: false");
      expect(tests).toContain("bun run test:acceptance");
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
      expect(aggregate).toContain("needs: [prepare, quality, docs, tests, stability, full]");
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
});

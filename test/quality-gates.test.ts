// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import rootPackage from "../package.json" with { type: "json" };

const root = resolve(import.meta.dir, "..");

describe("repository quality gates", () => {
  test("lint checks the full repository in local and CI runs", () => {
    expect(rootPackage.scripts.lint).toBe("biome lint . --no-errors-on-unmatched");

    const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
    expect(ci).toContain("- name: Lint full repository\n        run: bun run lint");
  });

  test("the non-writing format check runs last in the main check workflow", () => {
    expect(rootPackage.scripts["format:check"]).toBe("biome format .");
    expect(rootPackage.scripts.check.split(" && ").at(-1)).toBe("bun run format:check");
  });
});

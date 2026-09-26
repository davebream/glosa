// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import rootPackage from "../package.json" with { type: "json" };
import { CLI_VERSION } from "../packages/cli/src/version.ts";
import {
  describeFailures,
  FORBIDDEN_VERSION_SITES,
  inspect,
  sourceVersion,
  VERSION_SITES,
  worktreeReader,
} from "../scripts/version-sync.ts";

const root = resolve(import.meta.dir, "..");
const workspaceManifests = [
  "packages/cli/package.json",
  "packages/daemon/package.json",
  "packages/spa/package.json",
  "packages/providers/claude-code/package.json",
  "packages/providers/codex/package.json",
];

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    // A package that installs on its own (packages/shell) has its own node_modules; nothing under
    // any node_modules is first-party.
    if (entry.isDirectory() && entry.name === "node_modules") return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

describe("OSS release metadata", () => {
  test("the root package is the sole public macOS artifact", () => {
    expect(rootPackage.name).toBe("@davebream/glosa");
    // Machine-maintained by `bun run version:sync`; it records the release, it does not gate it.
    // The gate that a bump cannot bypass is the CHANGELOG heading asserted further down.
    expect(rootPackage.version).toBe("0.1.0-alpha.33");
    expect(rootPackage.private).toBe(false);
    expect(rootPackage.license).toBe("Apache-2.0");
    expect(rootPackage.bin).toEqual({ glosa: "packages/cli/src/main.ts" });
    expect(rootPackage.os).toEqual(["darwin"]);
    expect(rootPackage.cpu).toEqual(["arm64", "x64"]);
    expect(CLI_VERSION).toBe(rootPackage.version);

    for (const manifest of workspaceManifests) {
      const value = JSON.parse(readFileSync(join(root, manifest), "utf8")) as Record<string, unknown>;
      expect(value.private, manifest).toBe(true);
      expect(value.license, manifest).toBe("Apache-2.0");
    }
  });

  test("every shipped version site carries exactly the root package version", () => {
    // Pinned by path so DELETING a site is a red, not a silent narrowing of the gate.
    expect(VERSION_SITES.map((site) => site.path)).toEqual([
      "package.json",
      "glosa-plugin/.claude-plugin/plugin.json",
      "README.md",
      "test/oss-release.test.ts",
      "packages/shell/package.json",
      "packages/shell/package.json",
    ]);
    expect(FORBIDDEN_VERSION_SITES.map((site) => site.path)).toEqual([".claude-plugin/marketplace.json"]);

    const read = worktreeReader(root);
    expect(sourceVersion(read)).toBe(rootPackage.version);
    expect(describeFailures(inspect(read, rootPackage.version))).toEqual([]);
  });

  test("the released version is written up in the changelog", () => {
    // Replaces the literal above as the deliberate-bump tripwire: version:sync can satisfy a
    // literal, but it cannot write release notes, so a silent bump still fails here.
    expect(readFileSync(join(root, "CHANGELOG.md"), "utf8")).toContain(`## [${rootPackage.version}]`);
  });

  test("required public release documents exist", () => {
    for (const path of [
      "LICENSE",
      "NOTICE",
      "THIRD_PARTY_NOTICES.md",
      "README.md",
      "CONTRIBUTING.md",
      "CODE_OF_CONDUCT.md",
      "SECURITY.md",
      "CHANGELOG.md",
      ".github/CODEOWNERS",
      ".github/pull_request_template.md",
    ]) {
      expect(existsSync(join(root, path)), path).toBe(true);
    }
  });

  test("first-party source and tests carry Apache SPDX headers", () => {
    const candidates = [
      ...walk(join(root, "packages")),
      ...walk(join(root, "test")),
      join(root, "lefthook.yml"),
      ...walk(join(root, "scripts")),
    ].filter((path) => {
      const rel = relative(root, path);
      if (rel.includes("/vendor/")) return false;
      if (!/(^packages\/.*\/(src|test)\/|^test\/|^scripts\/|^lefthook\.yml$)/.test(rel)) return false;
      return /\.(ts|js|css|html)$/.test(path) || rel === "lefthook.yml";
    });

    for (const path of candidates) {
      expect(readFileSync(path, "utf8").slice(0, 160), relative(root, path)).toContain(
        "SPDX-License-Identifier: Apache-2.0",
      );
    }
  });

  test("vendored browser assets retain their upstream identifiers", () => {
    const expected: Record<string, string> = {
      "packages/spa/src/vendor/diff2html.js": "MIT",
      "packages/spa/src/vendor/diff2html.min.css": "MIT",
      "packages/spa/src/vendor/prosemirror.js": "MIT",
      "packages/spa/src/vendor/idiomorph.js": "0BSD",
    };
    for (const [path, license] of Object.entries(expected)) {
      expect(readFileSync(join(root, path), "utf8").slice(0, 100), path).toContain(
        `SPDX-License-Identifier: ${license}`,
      );
    }
  });

  test("packaged runtime source has no unpublished workspace imports", () => {
    const sourceFiles = walk(join(root, "packages")).filter(
      (path) => path.includes("/src/") && /\.(ts|js)$/.test(path),
    );
    for (const path of sourceFiles) {
      expect(readFileSync(path, "utf8"), relative(root, path)).not.toMatch(/(?:from\s+|import\()["']@glosa\//);
    }
  });
});

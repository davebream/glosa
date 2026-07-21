// P2.2 — loadMatcherConfig: missing file → defaults; override deep-merges (arrays union, scalars
// replace); invalid JSON → throws (A4 §F20 explicitly: "invalid JSON → fail loud, don't silently
// use defaults").
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_MATCHER_CONFIG, loadMatcherConfig, resolveMatchedFiles } from "../../src/matcher.ts";
import { cleanupWorkspace, freshWorkspace, writeFile } from "./helpers.ts";

function writeGlosaConfig(root: string, config: unknown): void {
  mkdirSync(join(root, ".glosa"), { recursive: true });
  writeFileSync(join(root, ".glosa", "config.json"), typeof config === "string" ? config : JSON.stringify(config));
}

describe("loadMatcherConfig", () => {
  let root: string;

  beforeEach(() => {
    root = freshWorkspace();
  });

  afterEach(() => {
    cleanupWorkspace(root);
  });

  test("no .glosa/config.json → returns the defaults", () => {
    expect(loadMatcherConfig(root)).toEqual(DEFAULT_MATCHER_CONFIG);
  });

  test("an override that adds an include glob is unioned onto the defaults, not a replacement", () => {
    writeGlosaConfig(root, { artifacts: { include: ["**/*.csv"] } });
    const config = loadMatcherConfig(root);
    expect(config.artifacts.include).toEqual([...DEFAULT_MATCHER_CONFIG.artifacts.include, "**/*.csv"]);
    expect(config.artifacts.exclude).toEqual(DEFAULT_MATCHER_CONFIG.artifacts.exclude);
  });

  test("an override that adds an exclude glob is unioned onto the defaults", () => {
    writeGlosaConfig(root, { artifacts: { exclude: ["drafts/**"] } });
    const config = loadMatcherConfig(root);
    expect(config.artifacts.exclude).toEqual([...DEFAULT_MATCHER_CONFIG.artifacts.exclude, "drafts/**"]);
  });

  test("an override that lowers maxFileBytes replaces the scalar default", () => {
    writeGlosaConfig(root, { artifacts: { maxFileBytes: 1024 } });
    const config = loadMatcherConfig(root);
    expect(config.artifacts.maxFileBytes).toBe(1024);
    expect(config.artifacts.include).toEqual(DEFAULT_MATCHER_CONFIG.artifacts.include); // unrelated field untouched
  });

  test("invalid JSON in .glosa/config.json throws — never silently falls back to defaults", () => {
    writeGlosaConfig(root, "{ not valid json ");
    expect(() => loadMatcherConfig(root)).toThrow();
  });

  test("a non-object JSON value (e.g. an array) throws", () => {
    writeGlosaConfig(root, [1, 2, 3]);
    expect(() => loadMatcherConfig(root)).toThrow();
  });

  test("end-to-end: an honored override actually changes what resolveMatchedFiles tracks", () => {
    writeGlosaConfig(root, { artifacts: { include: ["**/*.csv"], maxFileBytes: 4 } });
    writeFile(root, "data.csv", "a,b,c"); // 5 bytes, over the lowered 4-byte threshold
    writeFile(root, "small.csv", "ab"); // 2 bytes, under it

    const config = loadMatcherConfig(root);
    const result = resolveMatchedFiles(root, config);
    expect(result.tracked.map((f) => f.path)).toEqual(["small.csv"]);
    expect(result.oversize.map((f) => f.path)).toEqual(["data.csv"]);
  });
});

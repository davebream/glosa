// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "../src");

function source(name: string): string {
  return readFileSync(join(SRC, name), "utf8");
}

function imports(name: string): string[] {
  return new Bun.Transpiler({ loader: "js" }).scan(source(name)).imports.map((entry) => entry.path);
}

describe("viewer application seams", () => {
  test("mountApp composes dedicated shell and contextual-surface modules", () => {
    expect(imports("viewer.js")).toEqual(
      expect.arrayContaining(["./viewer-shell.js", "./viewer-context-surfaces.js", "./viewer-feedback.js"]),
    );
  });

  test("extracted UI modules are transport-free and receive dependencies from their caller", () => {
    for (const name of ["viewer-shell.js", "viewer-context-surfaces.js", "viewer-feedback.js"]) {
      const moduleSource = source(name);
      expect(imports(name)).not.toContain("./data-access.js");
      expect(moduleSource).not.toMatch(/\bfetch\s*\(/);
      expect(moduleSource).not.toContain("createDataAccess");
    }
  });
});

// SPDX-License-Identifier: Apache-2.0
// W37 regression: scoped uninstall must preserve a pre-existing JSON file's indentation style.
// Both setup and removal exercise the public scoped-init API; no uninstall internals are exposed.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GlosaBinResolution } from "../src/init.ts";
import { runScopedInit, runScopedUninstall } from "../src/scoped-init.ts";
import { useTempHome } from "./home.ts";

useTempHome();

const BIN: GlosaBinResolution = { command: "glosa", args: [], mode: "path" };
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

for (const [label, indent] of [
  ["tabs", "\t"],
  ["four spaces", "    "],
] as const) {
  test(`scoped uninstall preserves ${label} in a pre-existing settings file`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "glosa-uninstall-indent-"));
    dirs.push(dir);
    const settingsPath = join(dir, ".claude", "settings.json");
    const foreign = {
      permissions: { allow: ["Read", "Write"] },
      env: { KEEP: "yes" },
    };

    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(settingsPath, `${JSON.stringify(foreign, null, indent)}\n`);

    const installed = await runScopedInit({ dir, agents: ["claude-code"], resolveGlosaBin: () => BIN });
    expect(installed.ok).toBe(true);
    expect(readFileSync(settingsPath, "utf8")).toContain(`${indent}"hooks"`);

    const removed = await runScopedUninstall({ dir, agents: ["claude-code"] });

    expect(removed.ok).toBe(true);
    const after = readFileSync(settingsPath, "utf8");
    expect(JSON.parse(after)).toEqual(foreign);
    expect(after).toBe(`${JSON.stringify(foreign, null, indent)}\n`);
  });
}

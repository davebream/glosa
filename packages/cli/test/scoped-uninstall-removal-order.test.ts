// SPDX-License-Identifier: Apache-2.0
// W36 regression: scoped uninstall must remove stale JSON-pointer array indices from highest to
// lowest. The public runScopedUninstall path is exercised against its durable manifest contract.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Of, type GlosaBinResolution } from "../src/init.ts";
import {
  runScopedUninstall,
  scopedManifestPaths,
  type ScopedOwnershipManifest,
} from "../src/scoped-init.ts";
import { useTempHome } from "./home.ts";

useTempHome();

const BIN: GlosaBinResolution = { command: "glosa", args: [], mode: "path" };
let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

test("scoped uninstall removes owned hook siblings at indices 2 and 10 without shifting either target", async () => {
  const dir = mkdtempSync(join(tmpdir(), "glosa-uninstall-order-"));
  dirs.push(dir);
  const settingsPath = join(dir, ".claude", "settings.json");
  const manifestPath = scopedManifestPaths(dir).workspace;
  const ownedAt2 = { type: "command", command: "glosa hook owned-at-2" };
  const ownedAt10 = { type: "command", command: "glosa hook owned-at-10" };
  const foreignHooks = Array.from({ length: 9 }, (_, index) => ({
    type: "command",
    command: `foreign hook ${index}`,
    marker: { index },
  }));
  const hooks = [
    foreignHooks[0],
    foreignHooks[1],
    ownedAt2,
    ...foreignHooks.slice(2),
    ownedAt10,
  ];
  expect(hooks).toHaveLength(11);

  mkdirSync(join(dir, ".claude"), { recursive: true });
  mkdirSync(join(dir, ".glosa"), { recursive: true });
  writeFileSync(
    settingsPath,
    `${JSON.stringify({ hooks: { SessionStart: [{ matcher: "foreign", hooks }] } }, null, 2)}\n`,
  );
  const manifest: ScopedOwnershipManifest = {
    version: 2,
    scope: "workspace",
    glosa_bin: BIN,
    providers: {
      "claude-code": {
        files: {
          hooks: {
            kind: "json",
            path: settingsPath,
            created: false,
            backup: null,
            inserted: [
              { pointer: "/hooks/SessionStart/0/hooks/2", sha256: sha256Of(ownedAt2) },
              { pointer: "/hooks/SessionStart/0/hooks/10", sha256: sha256Of(ownedAt10) },
            ],
          },
        },
      },
    },
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const result = await runScopedUninstall({ dir, agents: ["claude-code"] });

  expect(result.ok).toBe(true);
  expect(result.exitCode).toBe(0);
  expect(result.warnings).toEqual([]);
  expect(result.removed).toEqual([
    `${settingsPath}/hooks/SessionStart/0/hooks/2`,
    `${settingsPath}/hooks/SessionStart/0/hooks/10`,
  ]);
  expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
    hooks: { SessionStart: [{ matcher: "foreign", hooks: foreignHooks }] },
  });
  expect(existsSync(manifestPath)).toBe(false);
});

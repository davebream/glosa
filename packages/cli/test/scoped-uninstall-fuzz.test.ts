// SPDX-License-Identifier: Apache-2.0
// Seeded differential guard for W35: public runScopedInit -> runScopedUninstall must return every
// foreign JSON subtree to its exact pre-init value. This intentionally uses only public APIs; no
// uninstall internals are exported for the test.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GlosaBinResolution } from "../src/init.ts";
import { runScopedInit, runScopedUninstall } from "../src/scoped-init.ts";
import { useTempHome } from "./home.ts";

useTempHome();

const BIN: GlosaBinResolution = { command: "glosa", args: [], mode: "path" };

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function foreignJson(random: () => number, depth = 0): unknown {
  const kind = Math.floor(random() * (depth >= 3 ? 4 : 6));
  if (kind === 0) return {};
  if (kind === 1) return [];
  if (kind === 2) return random() < 0.5;
  if (kind === 3) return `foreign-${Math.floor(random() * 10_000)}`;
  if (kind === 4) {
    return Array.from({ length: Math.floor(random() * 4) }, () => foreignJson(random, depth + 1));
  }
  return Object.fromEntries(
    Array.from({ length: Math.floor(random() * 4) }, (_, index) => [
      `key_${depth}_${index}`,
      foreignJson(random, depth + 1),
    ]),
  );
}

test("500 seeded foreign settings survive scoped init/uninstall unchanged", async () => {
  const random = mulberry32(0x35f04a6);

  for (let caseIndex = 0; caseIndex < 500; caseIndex++) {
    const dir = mkdtempSync(join(tmpdir(), "glosa-uninstall-fuzz-"));
    const settingsPath = join(dir, ".claude", "settings.json");
    const original = {
      permissions: foreignJson(random),
      env: foreignJson(random),
      disabledTools: foreignJson(random),
      statusLine: foreignJson(random),
      [`foreign_${caseIndex}`]: foreignJson(random),
      // These live inside a container glosa shares. The empty array is deliberate: W35's old
      // whole-document prune deleted it on the first generated case.
      hooks: { PreToolUse: [], $comment: `owned-by-user-${caseIndex}` },
    };

    try {
      mkdirSync(join(dir, ".claude"), { recursive: true });
      writeFileSync(settingsPath, `${JSON.stringify(original, null, 2)}\n`);

      const installed = await runScopedInit({ dir, agents: ["claude-code"], resolveGlosaBin: () => BIN });
      expect(installed.ok, `seed case ${caseIndex}: init failed`).toBe(true);
      expect(installed.exitCode, `seed case ${caseIndex}: init exit`).toBe(0);

      const removed = await runScopedUninstall({ dir, agents: ["claude-code"] });
      expect(removed.ok, `seed case ${caseIndex}: uninstall failed`).toBe(true);
      expect(removed.exitCode, `seed case ${caseIndex}: uninstall exit`).toBe(0);
      expect(JSON.parse(readFileSync(settingsPath, "utf8")), `seed case ${caseIndex}`).toEqual(original);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

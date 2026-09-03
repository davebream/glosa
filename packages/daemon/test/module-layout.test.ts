// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "../src");

const MODULE_LAYOUT = {
  transport: ["classf-serve", "contract", "http", "problem", "sse", "stream"],
  security: ["auth", "capability", "classf-bridge", "confine-path", "csp", "presentation-token", "token"],
  lifecycle: ["build-id", "daemon", "daemon-identity", "handshake", "home", "lock", "protocol"],
} as const;

describe("daemon module layout", () => {
  test("transport, security, and process lifecycle modules have explicit homes", () => {
    for (const [area, modules] of Object.entries(MODULE_LAYOUT)) {
      for (const name of modules) {
        expect(existsSync(join(SRC, area, `${name}.ts`)), `${area}/${name}.ts`).toBe(true);
      }
    }
  });

  test("regrouped modules do not retain flat compatibility copies", () => {
    const oldFlatNames: string[] = [
      ...MODULE_LAYOUT.transport,
      ...MODULE_LAYOUT.security,
      ...MODULE_LAYOUT.lifecycle,
    ].filter((name) => name !== "daemon");
    oldFlatNames.push("lifecycle");
    for (const name of oldFlatNames) {
      expect(existsSync(join(SRC, `${name}.ts`)), `${name}.ts remains flat`).toBe(false);
    }
  });
});

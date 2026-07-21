// SPDX-License-Identifier: Apache-2.0
import { test, expect } from "bun:test";

// Baseline smoke test so `bun test` is green from the first build task.
// The build loop replaces/extends this with real per-package suites.
test("scaffold is green", () => {
  expect(1 + 1).toBe(2);
});

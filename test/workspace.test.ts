// SPDX-License-Identifier: Apache-2.0
import { test, expect } from "bun:test";

// P1.1 — proves the monorepo is wired: every workspace package resolves by its published name
// and its entrypoint imports cleanly. Guards against a broken workspace symlink / bad exports map.
// P6.1: `@glosa/adapters-jethro` (the stub this task supersedes) is gone — content adapters are
// registered at runtime through `packages/daemon/src/adapters/interface.ts`'s public protocol,
// never shipped as an in-repo package (invariant #1: the core runs with zero adapters).
test("every workspace package resolves by name", async () => {
  const names = ["@glosa/daemon", "@glosa/spa", "@glosa/cli", "@glosa/providers-claude-code", "@glosa/providers-codex"];
  for (const name of names) {
    const mod = await import(name);
    expect(mod).toBeDefined();
  }
});

test("cli exposes run() and reports version via exit 0", async () => {
  const { run } = await import("@glosa/cli");
  expect(typeof run).toBe("function");
  expect(await run(["--version"])).toBe(0);
  expect(await run(["bogus-cmd"])).toBe(2);
});

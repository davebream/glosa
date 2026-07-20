// ANTHROPIC_API_KEY scrub coverage (docs/CLAUDE.md invariant 5 — "never let a spawned child
// inherit it"). Two layers: buildChildEnv is a pure function (unit test), and a real
// Bun.spawn round-trip proves the scrub survives actually handing the env to the OS — Bun.spawn
// *replaces* the child's env with whatever object you pass, it doesn't merge, so the pure test
// alone wouldn't catch a caller accidentally passing the wrong object through.
import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { buildChildEnv } from "../src/lifecycle.ts";
import { cleanupHome, freshHome } from "./helpers.ts";

describe("buildChildEnv", () => {
  test("scrubs ANTHROPIC_API_KEY and pins GLOSA_HOME/GLOSA_PORT", () => {
    const base = { ANTHROPIC_API_KEY: "sk-super-secret", PATH: "/usr/bin", OTHER: "kept" };
    const env = buildChildEnv(base, { home: "/tmp/glosa-home", port: 4646 });

    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.GLOSA_HOME).toBe("/tmp/glosa-home");
    expect(env.GLOSA_PORT).toBe("4646");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.OTHER).toBe("kept");
  });

  test("does not mutate the base object", () => {
    const base = { ANTHROPIC_API_KEY: "sk-super-secret" };
    buildChildEnv(base, { home: "/tmp/x", port: 1 });
    expect(base.ANTHROPIC_API_KEY).toBe("sk-super-secret");
  });
});

describe("ANTHROPIC_API_KEY scrub — real OS env round-trip", () => {
  test("a child spawned with buildChildEnv's output never sees the key", async () => {
    const home = freshHome();
    const outFile = join(home, "observed-key.txt");
    try {
      const base: Record<string, string | undefined> = {
        ...Bun.env,
        ANTHROPIC_API_KEY: "sk-should-never-reach-the-child",
      };
      const env = buildChildEnv(base, { home, port: 4646 });

      const child = Bun.spawn({
        cmd: [
          process.execPath,
          "-e",
          `require("fs").writeFileSync(process.argv[1], process.env.ANTHROPIC_API_KEY ?? "<<ABSENT>>")`,
          outFile,
        ],
        env,
        stdout: "ignore",
        stderr: "ignore",
      });
      await child.exited;

      expect(readFileSync(outFile, "utf8")).toBe("<<ABSENT>>");
    } finally {
      try {
        unlinkSync(outFile);
      } catch {
        // fine
      }
      cleanupHome(home);
    }
  });
});

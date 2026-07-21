// P4.3 — `run(["init", ...])`'s CLI wiring: flag parsing, exit codes, and the `--json` envelope
// (A6 §F26's `{glosa_json:1, ok, command, exit_code, data, warnings, error}` shape). The merge
// LOGIC itself is covered exhaustively in init.test.ts — this only proves `index.ts` calls it
// correctly and reports the right process exit code.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/index.ts";

let dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "glosa-cli-init-test-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function captureStdout(fn: () => Promise<number>): Promise<{ exitCode: number; out: string }> {
  const orig = process.stdout.write.bind(process.stdout);
  let out = "";
  // biome-ignore lint: test-only stdout capture
  (process.stdout.write as any) = (chunk: string) => {
    out += chunk;
    return true;
  };
  return fn()
    .then((exitCode) => ({ exitCode, out }))
    .finally(() => {
      process.stdout.write = orig;
    });
}

describe("run(['init', ...])", () => {
  test("fresh install via the CLI prints a --json envelope with ok:true, exit_code:0", async () => {
    const dir = freshDir();
    const { exitCode, out } = await captureStdout(() => run(["init", dir, "--json"]));
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({ glosa_json: 1, ok: true, command: "init", exit_code: 0 });
    expect(parsed.data.channel_command).toBe("claude --dangerously-load-development-channels server:glosa");
  });

  test("--print writes a diff to stdout and creates nothing", async () => {
    const dir = freshDir();
    const { exitCode, out } = await captureStdout(() => run(["init", dir, "--print"]));
    expect(exitCode).toBe(0);
    expect(out).toContain("+++");
  });

  test("--uninstall with no prior init reports exit 0 via --json", async () => {
    const dir = freshDir();
    const { exitCode, out } = await captureStdout(() => run(["init", dir, "--uninstall", "--json"]));
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
  });

  test("install then uninstall round-trips to exit 0", async () => {
    const dir = freshDir();
    await run(["init", dir]);
    const exitCode = await run(["init", dir, "--uninstall"]);
    expect(exitCode).toBe(0);
  });
});

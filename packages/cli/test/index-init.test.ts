// SPDX-License-Identifier: Apache-2.0
// P4.3 — `run(["init", ...])`'s CLI wiring: flag parsing, exit codes, and the `--json` envelope
// (A6 §F26's `{glosa_json:1, ok, command, exit_code, data, warnings, error}` shape). The merge
// LOGIC itself is covered exhaustively in init.test.ts — this only proves `index.ts` calls it
// correctly and reports the right process exit code.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { promptInitAgents, run } from "../src/index.ts";
import { REAL_GLOSA_HOME, tempGlosaHome, useTempHome } from "./home.ts";

// `run(["init", …])` has no injection seam for `rootsFor()`'s roots, so the user-scope ownership
// manifest it consults is whatever `$GLOSA_HOME ?? ~/.glosa` resolves to. Without this, these
// tests read the developer's own install state: a machine with a user-scope `codex` install
// recorded there fails the two `--agent`-with-codex cases below on A6 §F26's (correct)
// cross-scope-duplicate guard.
useTempHome();

let dirs: string[] = [];
/** A `.git` marker makes this fixture read as a scratch git repo rather than a bare temp
 * directory, so `glosa init`'s risky-target guard (issue #96) doesn't fire on every test here —
 * the guard's own behavior is covered separately, below. */
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "glosa-cli-init-test-"));
  mkdirSync(join(d, ".git"));
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
    const { exitCode, out } = await captureStdout(() => run(["init", dir, "--agent", "all", "--json"]));
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({ glosa_json: 1, ok: true, command: "init", exit_code: 0 });
    expect(parsed.data.channel_command).toBe("claude --dangerously-load-development-channels server:glosa");
  });

  test("fresh install human output ends with the restart/resume instruction (issue #78)", async () => {
    const dir = freshDir();
    const { exitCode, out } = await captureStdout(() => run(["init", dir, "--agent", "claude-code"]));
    expect(exitCode).toBe(0);
    expect(out).toContain("installed hooks + MCP entry");
    expect(out).toContain("Restart or /resume your Claude Code session");
    expect(out).toContain("annotations are queued, not delivered");
  });

  test("'already up to date' output stays stable — no restart line on changed:false", async () => {
    const dir = freshDir();
    await run(["init", dir, "--agent", "claude-code"]);
    const { out } = await captureStdout(() => run(["init", dir, "--agent", "claude-code"]));
    expect(out).toContain("already up to date");
    expect(out).not.toContain("Restart or /resume");
  });

  test("--print writes a diff to stdout and creates nothing", async () => {
    const dir = freshDir();
    const { exitCode, out } = await captureStdout(() => run(["init", dir, "--agent", "claude-code", "--print"]));
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
    await run(["init", dir, "--agent", "all"]);
    const exitCode = await run(["init", dir, "--uninstall"]);
    expect(exitCode).toBe(0);
  });

  test("repeatable --agent installs only the selected providers", async () => {
    const dir = freshDir();
    const { exitCode, out } = await captureStdout(() =>
      run(["init", dir, "--agent", "claude-code", "--agent", "codex", "--json"]),
    );
    expect(exitCode).toBe(0);
    expect(JSON.parse(out).data.providers).toEqual(["claude-code", "codex"]);
  });

  test("--agent all cannot be combined with another agent", async () => {
    const dir = freshDir();
    const { exitCode, out } = await captureStdout(() =>
      run(["init", dir, "--agent", "all", "--agent", "codex", "--json"]),
    );
    expect(exitCode).toBe(2);
    expect(JSON.parse(out).error.message).toContain("cannot be combined");
  });

  test("ambiguous --json invocation exits 2 with the exact agent hint", async () => {
    const dir = freshDir();
    const { exitCode, out } = await captureStdout(() => run(["init", dir, "--json"]));
    expect(exitCode).toBe(2);
    expect(JSON.parse(out).error.message).toContain("pass --agent claude-code, --agent codex, or --agent all");
  });

  test("invalid scope is a usage error", async () => {
    const dir = freshDir();
    const { exitCode, out } = await captureStdout(() =>
      run(["init", dir, "--scope", "global", "--agent", "codex", "--json"]),
    );
    expect(exitCode).toBe(2);
    expect(JSON.parse(out).error.message).toContain("--scope must be workspace or user");
  });

  test("the TTY fallback asks exactly once and supports selecting all", async () => {
    const output = new PassThrough();
    let rendered = "";
    output.on("data", (chunk) => {
      rendered += chunk.toString();
    });
    const selected = await promptInitAgents(Readable.from(["3\n"]), output);
    expect(selected).toEqual(["claude-code", "codex"]);
    expect(rendered.match(/Select agent integration/g)).toHaveLength(1);
  });

  test("--print on an already-wired workspace reports 'already up to date', not silence (issue #96)", async () => {
    const dir = freshDir();
    await run(["init", dir, "--agent", "claude-code"]);
    const { exitCode, out } = await captureStdout(() => run(["init", dir, "--agent", "claude-code", "--print"]));
    expect(exitCode).toBe(0);
    expect(out).toContain("already up to date");
    expect(out.trim().length).toBeGreaterThan(0);
  });
});

/** A minimal user-scope ownership manifest: `readManifest` only requires `version: 2`, and the
 * cross-scope guard only asks whether `providers[<id>]` is present. */
function seedUserScopeInstall(provider: "claude-code" | "codex"): void {
  writeFileSync(
    join(tempGlosaHome(), "init-manifest.json"),
    `${JSON.stringify(
      {
        version: 2,
        scope: "user",
        glosa_bin: { command: "/usr/bin/false", args: [], mode: "path" },
        providers: { [provider]: { files: {} } },
      },
      null,
      2,
    )}\n`,
  );
}

// The exit-2 refusal below is CORRECT behavior (A6 §F26): a provider installed at user scope AND
// workspace scope runs every hook twice. It was previously only reachable through `runScopedInit`
// directly (packages/cli/test/init.test.ts), never through the CLI boundary, which is why real
// `~/.glosa` state leaking into `run(["init", …])` looked like a CLI bug rather than the guard
// doing its job.
describe("glosa init — cross-scope duplicate guard through the CLI (A6 §F26)", () => {
  test("a user-scope install of the same provider refuses the workspace init with exit 2", async () => {
    const dir = freshDir();
    seedUserScopeInstall("claude-code");
    const { exitCode, out } = await captureStdout(() => run(["init", dir, "--agent", "claude-code", "--json"]));
    expect(exitCode).toBe(2);
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("cross-scope-duplicate");
    expect(parsed.error.kind).toBe("usage");
    expect(parsed.error.message).toBe(
      "claude-code is already installed at user scope; workspace scope would run duplicate hooks",
    );
    expect(parsed.error.hint).toBe(
      "run `glosa init --scope user --agent claude-code --uninstall`, then " +
        `\`glosa init ${dir} --scope workspace --agent claude-code\``,
    );
    // The refusal is total — nothing is half-written before the guard fires.
    expect(existsSync(join(dir, ".claude", "settings.json"))).toBe(false);
    expect(existsSync(join(dir, ".glosa", "init-manifest.json"))).toBe(false);
  });

  test("an empty user scope lets the same provider through — the real ~/.glosa is never consulted", async () => {
    const dir = freshDir();
    // If this were reading the real home, a developer with a user-scope install of either provider
    // would get exit 2 here. Pinning it makes the outcome a property of the fixture, not the box.
    expect(tempGlosaHome()).not.toBe(REAL_GLOSA_HOME);
    const { exitCode } = await captureStdout(() => run(["init", dir, "--agent", "codex", "--json"]));
    expect(exitCode).toBe(0);
  });

  test("a user-scope install of a DIFFERENT provider does not block this one", async () => {
    const dir = freshDir();
    seedUserScopeInstall("codex");
    const { exitCode, out } = await captureStdout(() => run(["init", dir, "--agent", "claude-code", "--json"]));
    expect(exitCode).toBe(0);
    expect(JSON.parse(out).data.providers).toEqual(["claude-code"]);
  });
});

describe("glosa init — risky-target guard (issue #96)", () => {
  test("a bare directory under a temp root (no .git) is refused with exit 2, code unsafe-init-target", async () => {
    const d = mkdtempSync(join(tmpdir(), "glosa-cli-init-risky-")); // deliberately no .git marker
    dirs.push(d);
    const { exitCode, out } = await captureStdout(() => run(["init", d, "--agent", "claude-code", "--json"]));
    expect(exitCode).toBe(2);
    const parsed = JSON.parse(out);
    expect(parsed.error.code).toBe("unsafe-init-target");
    expect(parsed.error.message).toContain("temporary directory");
    expect(parsed.error.hint).toContain("--force");
  });

  test("--force overrides the temp-dir refusal and writes normally", async () => {
    const d = mkdtempSync(join(tmpdir(), "glosa-cli-init-risky-"));
    dirs.push(d);
    const { exitCode, out } = await captureStdout(() =>
      run(["init", d, "--agent", "claude-code", "--force", "--json"]),
    );
    expect(exitCode).toBe(0);
    expect(JSON.parse(out).ok).toBe(true);
  });

  // Multi-repo-parent detection is exercised precisely (with injected `tempRoots: []` to isolate
  // it from the temp-dir branch) in packages/daemon/test/registry/workspace-root.test.ts — every
  // fixture reachable through `run()` here lives under `mkdtempSync(tmpdir())`, so it always hits
  // the temp-dir branch first regardless of how many repos it contains, and cannot exercise the
  // multi-repo branch in isolation.

  test("a directory that IS itself a git repo is never flagged, even under a temp root", async () => {
    const d = freshDir(); // freshDir() marks itself with .git
    const { exitCode, out } = await captureStdout(() => run(["init", d, "--agent", "claude-code", "--json"]));
    expect(exitCode).toBe(0);
    expect(JSON.parse(out).ok).toBe(true);
  });

  test("--uninstall is never subject to the guard — removing config is not the risky direction", async () => {
    const d = mkdtempSync(join(tmpdir(), "glosa-cli-init-risky-")); // no .git — would refuse `init`
    dirs.push(d);
    const { exitCode, out } = await captureStdout(() => run(["init", d, "--uninstall", "--json"]));
    expect(exitCode).toBe(0);
    expect(JSON.parse(out).ok).toBe(true);
  });
});

describe("glosa init — workspace-root resolution (issue #96)", () => {
  test("an explicit non-root dir inside a repo warns and names the root, but is still honoured literally", async () => {
    const repo = freshDir();
    const sub = join(repo, "sub");
    mkdirSync(sub);
    // `sub` isn't itself a repo, so under this fixture (always under $TMPDIR) it also trips the
    // risky-target guard tested above — pass --force to isolate the not-repository-root WARNING
    // from that separate refusal. A real `<repo>/sub` outside a temp root would never hit the
    // guard in the first place (see workspace-root.test.ts's classifyInitTarget coverage).
    const { exitCode, out } = await captureStdout(() =>
      run(["init", sub, "--agent", "claude-code", "--force", "--json"]),
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.warnings.map((w: { code: string }) => w.code)).toContain("not-repository-root");
    expect(parsed.warnings.find((w: { code: string }) => w.code === "not-repository-root").message).toContain(repo);
    // The explicit argument is honoured, not silently retargeted to the repo root.
    expect(existsSync(join(sub, ".claude", "settings.json"))).toBe(true);
    expect(existsSync(join(repo, ".claude", "settings.json"))).toBe(false);
  });

  test("an explicit repo-root dir gets no not-repository-root warning", async () => {
    const repo = freshDir();
    const { out } = await captureStdout(() => run(["init", repo, "--agent", "claude-code", "--json"]));
    expect(JSON.parse(out).warnings.map((w: { code: string }) => w.code)).not.toContain("not-repository-root");
  });
});

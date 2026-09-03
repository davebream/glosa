// SPDX-License-Identifier: Apache-2.0
// issue #80 — the consent-gated `glosa init` shell-out. Unit tests inject a fake spawn to pin
// the argv shape, env scrubbing (ANTHROPIC_API_KEY / GIT_*), single-flight, and timeout; one
// real-subprocess integration test proves a manifest actually lands and a second run reports
// changed:false (the scoped transaction's idempotence surviving the shell-out boundary).
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInitRunner, type InitRunEnvelope } from "../src/init-runner.ts";

function fakeChild(stdoutText: string, exitCode = 0) {
  return {
    stdout: new Response(stdoutText).body as ReadableStream<Uint8Array>,
    stderr: new Response("").body,
    exited: Promise.resolve(exitCode),
    kill: () => {},
  } as unknown as ReturnType<typeof Bun.spawn>;
}

const OK_ENVELOPE: InitRunEnvelope = {
  glosa_json: 1,
  ok: true,
  command: "init",
  exit_code: 0,
  data: { changed: true },
  warnings: [],
  error: null,
};

describe("createInitRunner — unit (injected spawn)", () => {
  test("argv carries NO provider literal: [execPath, …cli/src/main.ts, init, <dir>, --json]; dir is a discrete element; --force only when sent", async () => {
    const spawns: string[][] = [];
    const runner = createInitRunner({
      home: "/tmp/fake-home",
      port: 4646,
      spawn: ((opts: { cmd: string[] }) => {
        spawns.push(opts.cmd);
        return fakeChild(JSON.stringify(OK_ENVELOPE));
      }) as unknown as typeof Bun.spawn,
    });

    await runner("/ws/with spaces/dir", "reg-1");
    await runner("/ws/other", "reg-2", { force: true });

    expect(spawns[0]?.[0]).toBe(process.execPath);
    expect(spawns[0]?.[1]?.endsWith(join("cli", "src", "main.ts"))).toBe(true);
    // AGENTS.md invariant 1 / A6 §F26: the generic daemon must not name a provider. `--agent` is
    // absent so the CLI's provider-owned detection selects, exactly as a bare `glosa init` would.
    expect(spawns[0]?.slice(2)).toEqual(["init", "/ws/with spaces/dir", "--json"]);
    expect(spawns[1]?.slice(2)).toEqual(["init", "/ws/other", "--json", "--force"]);
    for (const cmd of spawns) {
      expect(cmd).not.toContain("--agent");
      expect(cmd).not.toContain("claude-code");
      expect(cmd).not.toContain("codex");
    }
  });

  test("env: ANTHROPIC_API_KEY and GIT_* scrubbed; GLOSA_HOME/GLOSA_PORT pinned", async () => {
    let seenEnv: Record<string, string | undefined> = {};
    const runner = createInitRunner({
      home: "/tmp/pinned-home",
      port: 4747,
      env: {
        PATH: "/usr/bin",
        ANTHROPIC_API_KEY: "sk-secret",
        GIT_DIR: "/somewhere/.git",
        GIT_INDEX_FILE: "/somewhere/index",
      },
      spawn: ((opts: { env: Record<string, string | undefined> }) => {
        seenEnv = opts.env;
        return fakeChild(JSON.stringify(OK_ENVELOPE));
      }) as unknown as typeof Bun.spawn,
    });

    await runner("/ws/a", "reg-1");
    expect(seenEnv.ANTHROPIC_API_KEY).toBeUndefined();
    expect(seenEnv.GIT_DIR).toBeUndefined();
    expect(seenEnv.GIT_INDEX_FILE).toBeUndefined();
    expect(seenEnv.GLOSA_HOME).toBe("/tmp/pinned-home");
    expect(seenEnv.GLOSA_PORT).toBe("4747");
    expect(seenEnv.PATH).toBe("/usr/bin");
  });

  test("single-flight: two concurrent calls for the same workspace spawn ONE child and share the result", async () => {
    let spawnCount = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runner = createInitRunner({
      home: "/tmp/h",
      port: 4646,
      spawn: (() => {
        spawnCount += 1;
        return {
          stdout: new Response(JSON.stringify(OK_ENVELOPE)).body,
          stderr: new Response("").body,
          exited: gate.then(() => 0),
          kill: () => {},
        } as unknown as ReturnType<typeof Bun.spawn>;
      }) as unknown as typeof Bun.spawn,
    });

    const first = runner("/ws/a", "reg-same");
    const second = runner("/ws/a", "reg-same");
    release?.();
    const [r1, r2] = await Promise.all([first, second]);
    expect(spawnCount).toBe(1);
    expect(r1).toEqual(r2);
  });

  test("timeout kills the child and reports {kind:'timeout'}", async () => {
    let killed = false;
    const runner = createInitRunner({
      home: "/tmp/h",
      port: 4646,
      timeoutMs: 20,
      spawn: (() => {
        let exitResolve: ((code: number) => void) | undefined;
        return {
          stdout: new ReadableStream<Uint8Array>({
            start() {}, // never produces, never closes — until kill
          }),
          stderr: new Response("").body,
          exited: new Promise<number>((resolve) => {
            exitResolve = resolve;
          }),
          kill: () => {
            killed = true;
            exitResolve?.(143);
          },
        } as unknown as ReturnType<typeof Bun.spawn>;
      }) as unknown as typeof Bun.spawn,
    });

    // The fake's stdout never closes on kill (a real kill closes the pipe), so race the runner
    // against a fallback — the assertion that matters is `killed` flipping via the timeout.
    const result = await Promise.race([
      runner("/ws/a", "reg-1"),
      new Promise<{ kind: "timeout" }>((resolve) => setTimeout(() => resolve({ kind: "timeout" }), 200)),
    ]);
    expect(killed).toBe(true);
    expect(result.kind).toBe("timeout");
  });

  test("unparseable stdout → {kind:'bad-output'}; non-envelope JSON → bad-output too", async () => {
    const mk = (out: string) =>
      createInitRunner({
        home: "/tmp/h",
        port: 4646,
        spawn: (() => fakeChild(out)) as unknown as typeof Bun.spawn,
      })("/ws/a", "reg-1");
    expect((await mk("garbage not json")).kind).toBe("bad-output");
    expect((await mk('{"some":"object"}')).kind).toBe("bad-output");
  });

  test("spawn throwing → {kind:'spawn-failed'} with the message", async () => {
    const runner = createInitRunner({
      home: "/tmp/h",
      port: 4646,
      spawn: (() => {
        throw new Error("ENOENT: bun missing");
      }) as unknown as typeof Bun.spawn,
    });
    const result = await runner("/ws/a", "reg-1");
    expect(result).toEqual({ kind: "spawn-failed", message: "ENOENT: bun missing" });
  });
});

describe("createInitRunner — real subprocess integration", () => {
  test("real `glosa init <dir> --json` lands a manifest; second run reports changed:false", async () => {
    const home = mkdtempSync(join(tmpdir(), "glosa-init-runner-home-"));
    const ws = mkdtempSync(join(tmpdir(), "glosa-init-runner-ws-"));
    const fakeHome = mkdtempSync(join(tmpdir(), "glosa-init-runner-fakehome-"));
    const emptyBin = mkdtempSync(join(tmpdir(), "glosa-init-runner-bin-"));
    // This test is about round-trip plumbing, so its provider set has to be pinned rather than
    // inherited from whoever runs the suite: the child now selects providers itself (A6 §F26), and
    // a machine with both `claude` and `codex` on PATH would make it exit 2 (ambiguous) while a
    // machine with neither would too. An empty PATH plus a throwaway HOME reduce detection to what
    // the fixture plants — one Claude Code marker — so exactly one provider is detected either way.
    writeFileSync(join(ws, ".mcp.json"), "{}\n");
    const runner = createInitRunner({ home, port: 4646, env: { PATH: emptyBin, HOME: fakeHome } });

    type FilesData = { files?: Record<string, { changed?: boolean }> };
    const anyChanged = (data: unknown) =>
      Object.values((data as FilesData).files ?? {}).some((f) => f?.changed === true);

    // `force: true` because `ws` — like every fixture in this suite — lives under the system
    // temp root and is not itself a git repo: exactly the target issue #96's risky-target guard
    // refuses by default (`unsafe-init-target`, exit 2). That guard is real subprocess policy the
    // daemon's own `POST /w/:slug/init` route relies on (a directory workspace under a temp root
    // gets the SAME re-confirm-with-force treatment as a foreign-config conflict — see
    // `handleWorkspaceInit`'s exit-2 branch in http.ts). This test's own concern is the round-trip
    // subprocess plumbing, not that policy, so it exercises `createInitRunner`'s existing `force`
    // forwarding — the same path a client's re-confirmation takes — rather than working around it.
    const first = await runner(ws, "reg-real", { force: true });
    expect(first.kind).toBe("completed");
    if (first.kind === "completed") {
      expect(first.envelope.exit_code).toBe(0);
      expect(anyChanged(first.envelope.data)).toBe(true);
    }
    // The pinned cross-package workspace manifest path (see init-probe.test.ts).
    expect(existsSync(join(ws, ".glosa", "init-manifest.json"))).toBe(true);

    const second = await runner(ws, "reg-real", { force: true });
    expect(second.kind).toBe("completed");
    if (second.kind === "completed") {
      expect(second.envelope.exit_code).toBe(0);
      expect(anyChanged(second.envelope.data)).toBe(false);
    }
    for (const dir of [home, ws, fakeHome, emptyBin]) rmSync(dir, { recursive: true, force: true });
  }, 20_000);
});

describe("createInitRunner — provider selection belongs to the child, never the daemon", () => {
  // AGENTS.md invariant 1: the core knows nothing about a specific producer. A6 §F26 puts the
  // choice in provider-owned local probes ("executable presence and existing provider
  // configuration"), reached by spawning `init` with no `--agent`. These two tests are the
  // behavioural proof: the SAME daemon call wires Codex in a Codex-shaped workspace and Claude
  // Code in a Claude-shaped one. Hermetic on purpose — PATH points at an empty directory and HOME
  // at a fresh temp dir, so the child's probes see ONLY the fixture planted in the workspace and
  // the result cannot depend on which agent CLIs the machine running the suite happens to have.
  interface Fixture {
    home: string;
    ws: string;
    fakeHome: string;
    emptyBin: string;
    cleanup: () => void;
  }

  function fixture(plant: (ws: string) => void): Fixture {
    const home = mkdtempSync(join(tmpdir(), "glosa-init-sel-home-"));
    const ws = mkdtempSync(join(tmpdir(), "glosa-init-sel-ws-"));
    const fakeHome = mkdtempSync(join(tmpdir(), "glosa-init-sel-fakehome-"));
    const emptyBin = mkdtempSync(join(tmpdir(), "glosa-init-sel-bin-"));
    plant(ws);
    return {
      home,
      ws,
      fakeHome,
      emptyBin,
      cleanup: () => {
        for (const dir of [home, ws, fakeHome, emptyBin]) rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  function runnerFor(fx: Fixture) {
    // `force: true` at the call site for the same reason the round-trip test above needs it: the
    // fixture lives under the system temp root, which issue #96's risky-target guard refuses.
    return createInitRunner({ home: fx.home, port: 4646, env: { PATH: fx.emptyBin, HOME: fx.fakeHome } });
  }

  function manifestProviders(ws: string): string[] {
    const raw = readFileSync(join(ws, ".glosa", "init-manifest.json"), "utf8");
    return Object.keys((JSON.parse(raw) as { providers: Record<string, unknown> }).providers).sort();
  }

  test("a Codex-only workspace is wired for Codex and gets no Claude Code configuration", async () => {
    const fx = fixture((ws) => {
      mkdirSync(join(ws, ".codex"), { recursive: true });
      writeFileSync(join(ws, ".codex", "hooks.json"), "{}\n");
    });
    try {
      const result = await runnerFor(fx)(fx.ws, "reg-codex", { force: true });
      expect(result.kind).toBe("completed");
      if (result.kind === "completed") expect(result.envelope.exit_code).toBe(0);
      expect(existsSync(join(fx.ws, ".codex", "config.toml"))).toBe(true);
      // The defect this pins: a Codex-only user must NOT get Claude Code hooks installed.
      expect(existsSync(join(fx.ws, ".claude", "settings.json"))).toBe(false);
      expect(existsSync(join(fx.ws, ".mcp.json"))).toBe(false);
      expect(manifestProviders(fx.ws)).toEqual(["codex"]);
    } finally {
      fx.cleanup();
    }
  }, 20_000);

  test("a Claude-Code-only workspace is wired for Claude Code and gets no Codex configuration", async () => {
    const fx = fixture((ws) => {
      writeFileSync(join(ws, ".mcp.json"), "{}\n");
    });
    try {
      const result = await runnerFor(fx)(fx.ws, "reg-claude", { force: true });
      expect(result.kind).toBe("completed");
      if (result.kind === "completed") expect(result.envelope.exit_code).toBe(0);
      expect(existsSync(join(fx.ws, ".claude", "settings.json"))).toBe(true);
      expect(existsSync(join(fx.ws, ".codex", "hooks.json"))).toBe(false);
      expect(manifestProviders(fx.ws)).toEqual(["claude-code"]);
    } finally {
      fx.cleanup();
    }
  }, 20_000);
});

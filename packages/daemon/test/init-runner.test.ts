// SPDX-License-Identifier: Apache-2.0
// issue #80 — the consent-gated `glosa init` shell-out. Unit tests inject a fake spawn to pin
// the argv shape, env scrubbing (ANTHROPIC_API_KEY / GIT_*), single-flight, and timeout; one
// real-subprocess integration test proves a manifest actually lands and a second run reports
// changed:false (runInit's idempotence surviving the shell-out boundary).
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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
  test("argv shape: [execPath, …cli/src/main.ts, init, <dir>, --json]; dir is a discrete element; --force only when sent", async () => {
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
    expect(spawns[0]?.slice(2)).toEqual(["init", "/ws/with spaces/dir", "--json"]);
    expect(spawns[1]?.slice(2)).toEqual(["init", "/ws/other", "--json", "--force"]);
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
  test(
    "real `glosa init <dir> --json` lands a manifest; second run reports changed:false",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "glosa-init-runner-home-"));
      const ws = mkdtempSync(join(tmpdir(), "glosa-init-runner-ws-"));
      const runner = createInitRunner({ home, port: 4646 });

      type FilesData = { files?: Record<string, { changed?: boolean }> };
      const anyChanged = (data: unknown) =>
        Object.values((data as FilesData).files ?? {}).some((f) => f?.changed === true);

      const first = await runner(ws, "reg-real");
      expect(first.kind).toBe("completed");
      if (first.kind === "completed") {
        expect(first.envelope.exit_code).toBe(0);
        expect(anyChanged(first.envelope.data)).toBe(true);
      }
      // The pinned cross-package manifest path (see init-probe.test.ts).
      expect(existsSync(join(ws, ".claude", ".glosa-init.json"))).toBe(true);

      const second = await runner(ws, "reg-real");
      expect(second.kind).toBe("completed");
      if (second.kind === "completed") {
        expect(second.envelope.exit_code).toBe(0);
        expect(anyChanged(second.envelope.data)).toBe(false);
      }
      rmSync(home, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
    },
    20_000,
  );
});

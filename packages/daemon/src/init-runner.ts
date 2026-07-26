// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — the consent-gated `glosa init` shell-out behind `POST /w/:slug/init`
// (issue #80). The daemon cannot import the CLI's runInit (dependency direction is cli→daemon),
// so it spawns the CLI the same way `spawnAndWait` in lifecycle.ts spawns `__daemon`:
// `[process.execPath, …/cli/src/main.ts, "init", <dir>, "--json"]` and parses the F26
// single-JSON-object envelope from stdout. The workspace dir always comes from the registry
// entry — never from the client — and rides as a discrete argv element (no shell string).
// Consent lives with the CLIENT (the SPA's explicit dialog click); this module's job is to make
// the execution safe: scrubbed env, timeout, bounded capture, one child per workspace at a time.
import { fileURLToPath } from "node:url";
import { buildChildEnv } from "./lifecycle.ts";

/** The F26 envelope `glosa init --json` prints — exactly one JSON object on stdout. */
export interface InitRunEnvelope {
  glosa_json: 1;
  ok: boolean;
  command: string;
  exit_code: number;
  data: unknown;
  warnings: { code: string; message: string }[];
  error: { code: string; kind: string; message: string; hint?: string } | null;
}

export type InitRunnerResult =
  | { kind: "completed"; envelope: InitRunEnvelope }
  | { kind: "timeout" }
  | { kind: "spawn-failed"; message: string }
  | { kind: "bad-output"; message: string };

export type InitRunner = (dir: string, registrationId: string, opts?: { force?: boolean }) => Promise<InitRunnerResult>;

export interface InitRunnerDeps {
  home: string;
  port: number;
  timeoutMs?: number;
  /** Injectable for tests; defaults to Bun.spawn. */
  spawn?: typeof Bun.spawn;
  env?: Record<string, string | undefined>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_CAPTURE_BYTES = 256 * 1024; // the F26 envelope is small; anything past this is noise

export function createInitRunner(deps: InitRunnerDeps): InitRunner {
  const spawn = deps.spawn ?? Bun.spawn;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Single-flight per workspace: a second POST while one init child runs awaits the SAME
  // promise (runInit is idempotent-by-content, so both callers get the same truthful result).
  const inFlight = new Map<string, Promise<InitRunnerResult>>();

  return (dir, registrationId, opts = {}) => {
    const existing = inFlight.get(registrationId);
    if (existing) return existing;
    const run = runOnce(dir, opts).finally(() => inFlight.delete(registrationId));
    inFlight.set(registrationId, run);
    return run;
  };

  async function runOnce(dir: string, opts: { force?: boolean }): Promise<InitRunnerResult> {
    const mainPath = fileURLToPath(new URL("../../cli/src/main.ts", import.meta.url));
    // buildChildEnv scrubs ANTHROPIC_API_KEY (AGENTS.md invariant 5) and pins GLOSA_HOME/PORT so
    // a checkout-run daemon and its child agree. GIT_* is stripped for hygiene: init runs no git,
    // but ambient GIT_DIR/GIT_INDEX_FILE in a hook-spawned daemon must never leak downward.
    const env = buildChildEnv(deps.env ?? Bun.env, { home: deps.home, port: deps.port });
    for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];

    let child: ReturnType<typeof Bun.spawn>;
    try {
      child = spawn({
        cmd: [process.execPath, mainPath, "init", dir, "--json", ...(opts.force === true ? ["--force"] : [])],
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (err) {
      return { kind: "spawn-failed", message: err instanceof Error ? err.message : String(err) };
    }

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    try {
      const stdout = await readCapped(child.stdout as ReadableStream<Uint8Array>);
      await child.exited;
      if (timedOut) return { kind: "timeout" };
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout.trim());
      } catch {
        return { kind: "bad-output", message: "init child produced no parseable JSON envelope" };
      }
      const envelope = parsed as InitRunEnvelope;
      if (typeof envelope !== "object" || envelope === null || envelope.glosa_json !== 1) {
        return { kind: "bad-output", message: "init child output is not an F26 envelope" };
      }
      return { kind: "completed", envelope };
    } catch (err) {
      return timedOut ? { kind: "timeout" } : { kind: "spawn-failed", message: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  }

  async function readCapped(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && total < MAX_CAPTURE_BYTES) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
    return Buffer.concat(chunks).toString("utf8");
  }
}

// SPDX-License-Identifier: Apache-2.0
// P5.1 / issue #96 — `run(["doctor", ...])`'s CLI wiring for the shared workspace-root rule: the
// cwd default resolves to the enclosing git repository (the same root `glosa init`/`glosa open`
// use), and an explicit non-root `dir` inside a repo gets a `not-repository-root` warning rather
// than silently checking the wrong directory. `runDoctor`'s own 15 checks are covered exhaustively
// in doctor.test.ts — this only proves index.ts resolves and reports the directory correctly.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/index.ts";
import { FakeGlosaApiClient } from "./fake-api-client.ts";

let dirs: string[] = [];
let doctorClients: FakeGlosaApiClient[] = [];
function freshRepo(): string {
  const d = mkdtempSync(join(tmpdir(), "glosa-cli-doctor-test-"));
  mkdirSync(join(d, ".git"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
  doctorClients = [];
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

function runDoctorCommand(dir: string): Promise<number> {
  const client = new FakeGlosaApiClient();
  doctorClients.push(client);
  return run(["doctor", dir, "--json"], {
    doctor: {
      createClient: async () => client,
      glosaHome: freshRepo,
    },
  });
}

describe("run(['doctor', ...]) — workspace-root resolution (issue #96)", () => {
  test("an explicit repo-root dir gets no not-repository-root warning", async () => {
    const repo = freshRepo();
    const { out } = await captureStdout(() => runDoctorCommand(repo));
    const parsed = JSON.parse(out);
    expect(parsed.warnings.map((w: { code: string }) => w.code)).not.toContain("not-repository-root");
    expect(doctorClients[0]?.calls.some((call) => call.method === "getStatus")).toBe(true);
  });

  test("an explicit NON-root dir inside a repo warns and names the root", async () => {
    const repo = freshRepo();
    const sub = join(repo, "sub");
    mkdirSync(sub);
    const { out } = await captureStdout(() => runDoctorCommand(sub));
    const parsed = JSON.parse(out);
    const warning = parsed.warnings.find((w: { code: string }) => w.code === "not-repository-root");
    expect(warning).toBeDefined();
    expect(warning.message).toContain(repo);
  });

  test("a dir outside any repo is honoured literally, no warning (nothing to reconcile against)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "glosa-cli-doctor-test-"));
    dirs.push(dir);
    const { out } = await captureStdout(() => runDoctorCommand(dir));
    const parsed = JSON.parse(out);
    expect(parsed.warnings.map((w: { code: string }) => w.code)).not.toContain("not-repository-root");
  });
});

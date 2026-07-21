// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FALLBACK_LEASE_TTL_MS, withFileLease } from "../../src/registry/lockfile-fallback.ts";
import { cleanup, freshHome } from "./helpers.ts";

const FIXTURE_PATH = fileURLToPath(new URL("./fixtures/fallback-writer.ts", import.meta.url));

describe("withFileLease — single process", () => {
  test("runs fn and releases the lease (lock file is gone afterward)", () => {
    const home = freshHome();
    const lockPath = join(home, ".workspaces.lock");
    const result = withFileLease(lockPath, () => 42);
    expect(result).toBe(42);
    expect(existsSync(lockPath)).toBe(false);
    cleanup(home);
  });

  test("re-entrant: a nested call for the same lockPath runs directly, no deadlock", () => {
    const home = freshHome();
    const lockPath = join(home, ".workspaces.lock");
    const result = withFileLease(lockPath, () => withFileLease(lockPath, () => "inner"));
    expect(result).toBe("inner");
    cleanup(home);
  });

  test("releases even when fn throws, and the throw still propagates", () => {
    const home = freshHome();
    const lockPath = join(home, ".workspaces.lock");
    expect(() =>
      withFileLease(lockPath, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(existsSync(lockPath)).toBe(false);
    cleanup(home);
  });

  test("a stale (TTL-expired) lease is reclaimed rather than blocking forever", () => {
    const home = freshHome();
    const lockPath = join(home, ".workspaces.lock");
    writeFileSync(
      lockPath,
      JSON.stringify({
        token: "stale",
        pid: 999_999,
        hostname: "some-other-host", // different host — PID liveness can't even be checked, TTL alone must be enough
        acquiredAt: new Date(0).toISOString(),
        expiresAt: Date.now() - 1000, // already expired
      }),
    );
    const result = withFileLease(lockPath, () => "reclaimed");
    expect(result).toBe("reclaimed");
    expect(existsSync(lockPath)).toBe(false);
    cleanup(home);
  });

  test("a dead same-host pid is reclaimed even before its TTL expires", async () => {
    const home = freshHome();
    const lockPath = join(home, ".workspaces.lock");
    const proc = Bun.spawn({ cmd: [process.execPath, "-e", "0"], stdout: "ignore", stderr: "ignore" });
    const deadPid = proc.pid;
    await proc.exited;

    writeFileSync(
      lockPath,
      JSON.stringify({
        token: "dead",
        pid: deadPid,
        hostname: osHostname(),
        acquiredAt: new Date().toISOString(),
        expiresAt: Date.now() + FALLBACK_LEASE_TTL_MS, // NOT expired by TTL — only the dead pid should trigger reclaim
      }),
    );
    const result = withFileLease(lockPath, () => "reclaimed-dead-pid");
    expect(result).toBe("reclaimed-dead-pid");
    cleanup(home);
  });

  test("an unparseable lease record is treated as live/unknown, never silently stolen", () => {
    const home = freshHome();
    const lockPath = join(home, ".workspaces.lock");
    writeFileSync(lockPath, "not json at all");
    // Acquiring against an unparseable-but-present record retries and eventually gives up rather
    // than pretending it was free — assert it throws LEASE_CONTENDED, not that it silently wins.
    expect(() => withFileLease(lockPath, () => "should not get here")).toThrow(/held by another writer/);
    cleanup(home);
  });
});

describe("withFileLease — real cross-process concurrency", () => {
  test("N concurrent OS processes each doing M leased read-modify-write increments lose none", async () => {
    const home = freshHome();
    const lockPath = join(home, ".workspaces.lock");
    const counterPath = join(home, "counter.json");
    const PROCS = 5;
    const TIMES = 8;

    const children = Array.from({ length: PROCS }, () =>
      Bun.spawn({
        cmd: [process.execPath, FIXTURE_PATH, lockPath, counterPath, String(TIMES)],
        stdout: "ignore",
        stderr: "pipe",
      }),
    );
    const exitCodes = await Promise.all(children.map((c) => c.exited));
    for (const code of exitCodes) expect(code).toBe(0);

    const final = JSON.parse(readFileSync(counterPath, "utf8")) as { count: number };
    expect(final.count).toBe(PROCS * TIMES); // no lost update across real OS-process concurrency
    cleanup(home);
  }, 20_000);
});

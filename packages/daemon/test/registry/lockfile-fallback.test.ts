// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WriteSync } from "../../src/bus/io.ts";
import {
  FALLBACK_ABANDON_GRACE_MS,
  FALLBACK_LEASE_TTL_MS,
  withFileLease,
} from "../../src/registry/lockfile-fallback.ts";
import { cleanup, freshHome } from "./helpers.ts";

const FIXTURE_PATH = fileURLToPath(new URL("./fixtures/fallback-writer.ts", import.meta.url));
const SLOW_HOLDER_PATH = fileURLToPath(new URL("./fixtures/slow-holder.ts", import.meta.url));

/** An on-disk lock record for a holder that is a REAL, RUNNING process — this test process — so
 * `kill(pid, 0)` proves it alive. `expiresAt` is a parameter because the whole question these
 * tests ask is what a TTL that has already passed is allowed to authorize. */
function liveHolderRecord(token: string, expiresAt: number): string {
  return JSON.stringify({
    token,
    pid: process.pid,
    hostname: osHostname(),
    acquiredAt: new Date(expiresAt - FALLBACK_LEASE_TTL_MS).toISOString(),
    expiresAt,
  });
}

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

  test("a short write can never truncate the lock record (A4 §F04 — writeSync may write fewer bytes)", () => {
    const home = freshHome();
    const lockPath = join(home, ".workspaces.lock");
    let calls = 0;
    // Every write(2) stops after 8 bytes, the way a real one is allowed to on a full pipe/disk.
    const shortWrite: WriteSync = (fd, buf, offset, length) => {
      calls++;
      return writeSync(fd, buf, offset, Math.min(length, 8));
    };

    let observed: unknown;
    const result = withFileLease(
      lockPath,
      () => {
        observed = JSON.parse(readFileSync(lockPath, "utf8"));
        return "ok";
      },
      { write: shortWrite },
    );

    expect(result).toBe("ok");
    // A single unlooped write leaves an 8-byte fragment on disk, which readRecord classifies as
    // "unknown holder" — every contender then burns its whole retry budget and fails loudly over a
    // record we truncated ourselves. Looping means >1 call for a record this size.
    expect(calls).toBeGreaterThan(1);
    expect(observed).toMatchObject({ pid: process.pid, hostname: osHostname() });
    cleanup(home);
  });

  test("a TTL-expired lease whose same-host holder is provably alive is NOT stolen", () => {
    const home = freshHome();
    const lockPath = join(home, ".workspaces.lock");
    // The state a real holder is in when a slow load->modify->temp->fsync->rename outruns the TTL:
    // expiry passed, holder still running, nothing renewed it. Reclaiming here puts two writers
    // inside the same read-modify-write and the loser's registration disappears with no error.
    writeFileSync(lockPath, liveHolderRecord("held-and-still-running", Date.now() - 5_000));

    expect(() => withFileLease(lockPath, () => "stolen")).toThrow(/held by another writer/);
    const stillThere = JSON.parse(readFileSync(lockPath, "utf8")) as { token: string };
    expect(stillThere.token).toBe("held-and-still-running"); // left strictly alone
    cleanup(home);
  });

  test("a lease abandoned by a still-live pid is reclaimed once the abandon grace has passed", () => {
    const home = freshHome();
    const lockPath = join(home, ".workspaces.lock");
    // Liveness proves something about the PROCESS, not about the lease. A holder whose best-effort
    // release failed, or a pid recycled onto an unrelated process, looks alive indefinitely — so
    // "never steal from a live pid" needs a finite ceiling or the registry wedges for that
    // process's whole lifetime. Paired with the test above, which pins the other side of the
    // boundary: 5s past expiry, well inside the grace, is still held.
    writeFileSync(lockPath, liveHolderRecord("abandoned-but-live", Date.now() - FALLBACK_ABANDON_GRACE_MS - 1_000));

    expect(withFileLease(lockPath, () => "reclaimed-abandoned")).toBe("reclaimed-abandoned");
    expect(existsSync(lockPath)).toBe(false);
    cleanup(home);
  });

  test("a lease stolen mid-critical-section is reported, never returned as success", () => {
    const home = freshHome();
    const lockPath = join(home, ".workspaces.lock");
    // The residual steal this module cannot prevent (a recycled pid, a foreign host, a holder past
    // the abandon grace): someone else's record replaces ours while fn runs. fn's read-modify-write
    // may have raced theirs, so returning its value would claim a durability we cannot prove —
    // A4 §F05's "never falsely attribute what you cannot prove" applied to the lease itself.
    let caught: { code?: string } | undefined;
    try {
      withFileLease(lockPath, () => {
        writeFileSync(lockPath, liveHolderRecord("thief", Date.now() + FALLBACK_LEASE_TTL_MS));
        return "unprovable";
      });
    } catch (err) {
      caught = err as { code?: string };
    }

    expect(caught?.code).toBe("LEASE_STOLEN");
    const thiefRecord = JSON.parse(readFileSync(lockPath, "utf8")) as { token: string };
    expect(thiefRecord.token).toBe("thief"); // never unlink a lease we cannot prove is ours
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

describe("withFileLease — a critical section that outruns its own TTL", () => {
  test("a live holder still inside fn keeps the lease after expiresAt has passed", async () => {
    const home = freshHome();
    const lockPath = join(home, ".workspaces.lock");
    const markerPath = join(home, "marker");
    const HOLD_MS = 3_000;

    const holder = Bun.spawn({
      cmd: [process.execPath, SLOW_HOLDER_PATH, lockPath, markerPath, String(HOLD_MS)],
      stdout: "ignore",
      stderr: "pipe",
    });

    // Bounded poll (<= 1s) for the holder to be provably INSIDE its critical section. Bounded so a
    // holder that never gets there fails the assertion below instead of hanging the suite.
    let held: { token: string; pid: number; hostname: string; acquiredAt: string } | undefined;
    for (let i = 0; i < 200 && !held; i++) {
      if (existsSync(markerPath) && readFileSync(markerPath, "utf8") === "holding" && existsSync(lockPath)) {
        try {
          held = JSON.parse(readFileSync(lockPath, "utf8"));
        } catch {
          // caught the record mid-write — poll again
        }
      }
      if (!held) await Bun.sleep(5);
    }
    expect(held?.pid).toBe(holder.pid);

    // Drive the clock instead of waiting out a real 30s TTL: rewind ONLY expiresAt, leaving the
    // holder's token/pid/hostname untouched. The bytes on disk are now byte-identical to what a
    // genuine 30s overrun would have left, while the holder is demonstrably still running.
    writeFileSync(lockPath, JSON.stringify({ ...held, expiresAt: Date.now() - 1 }));
    expect(readFileSync(markerPath, "utf8")).toBe("holding");

    expect(() => withFileLease(lockPath, () => "stolen from a live holder")).toThrow(/held by another writer/);

    expect(await holder.exited).toBe(0);
    expect(readFileSync(markerPath, "utf8")).toBe("done"); // holder finished its own RMW intact
    cleanup(home);
  }, 20_000);
});

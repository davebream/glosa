import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION } from "../src/protocol.ts";
import { BUILD_ID } from "../src/build-id.ts";
import { ensureHomeDir, lockPath } from "../src/home.ts";
import {
  isPidAlive,
  parseLock,
  readLock,
  reclaimStaleLock,
  removeLockIfOwned,
  writeLockExclusive,
  type DaemonLock,
} from "../src/lock.ts";
import { cleanupHome, deadPid, freshHome, writeUnparseableLock } from "./helpers.ts";

function sampleLock(overrides: Partial<DaemonLock> = {}): DaemonLock {
  return {
    instance_id: "gl-sample",
    pid: process.pid,
    port: 4646,
    protocol_version: PROTOCOL_VERSION,
    build_id: BUILD_ID,
    started_at: new Date().toISOString(),
    host: "127.0.0.1",
    bun: Bun.version,
    ...overrides,
  };
}

describe("lock.ts (pure, hermetic — no subprocesses)", () => {
  let home: string;

  beforeEach(() => {
    home = ensureHomeDir(freshHome());
  });

  afterEach(() => {
    cleanupHome(home);
  });

  test("parseLock rejects malformed JSON and wrong shapes", () => {
    expect(parseLock("{ not json")).toBeNull();
    expect(parseLock("null")).toBeNull();
    expect(parseLock("42")).toBeNull();
    expect(parseLock(JSON.stringify({ pid: 1 }))).toBeNull(); // missing fields
    expect(parseLock(JSON.stringify(sampleLock()))).not.toBeNull();
    const legacy = parseLock(JSON.stringify(sampleLock({ build_id: undefined })));
    expect(legacy).not.toBeNull();
    expect(legacy?.build_id).toBeUndefined();
    expect(parseLock(JSON.stringify({ ...sampleLock(), build_id: 42 }))).toBeNull();
  });

  test("readLock returns null for a missing file", () => {
    expect(readLock(lockPath(home))).toBeNull();
  });

  test("readLock returns null for an unparseable file, not a throw", () => {
    writeUnparseableLock(home);
    expect(readLock(lockPath(home))).toBeNull();
  });

  test("writeLockExclusive round-trips and throws EEXIST on a second write", () => {
    const lock = sampleLock();
    writeLockExclusive(lockPath(home), lock);
    expect(readLock(lockPath(home))).toEqual(lock);

    expect(() => writeLockExclusive(lockPath(home), sampleLock({ instance_id: "gl-other" }))).toThrow();
    try {
      writeLockExclusive(lockPath(home), sampleLock({ instance_id: "gl-other" }));
    } catch (err) {
      expect((err as NodeJS.ErrnoException).code).toBe("EEXIST");
    }
  });

  test("reclaimStaleLock replaces an existing lock", () => {
    writeLockExclusive(lockPath(home), sampleLock({ instance_id: "gl-old" }));
    reclaimStaleLock(lockPath(home), sampleLock({ instance_id: "gl-new" }));
    expect(readLock(lockPath(home))?.instance_id).toBe("gl-new");
  });

  test("reclaimStaleLock also works when no lock exists yet", () => {
    reclaimStaleLock(lockPath(home), sampleLock({ instance_id: "gl-fresh" }));
    expect(readLock(lockPath(home))?.instance_id).toBe("gl-fresh");
  });

  test("removeLockIfOwned unlinks only when instance_id matches", () => {
    writeLockExclusive(lockPath(home), sampleLock({ instance_id: "gl-mine" }));

    removeLockIfOwned(lockPath(home), "gl-someone-else");
    expect(readLock(lockPath(home))).not.toBeNull(); // untouched

    removeLockIfOwned(lockPath(home), "gl-mine");
    expect(readLock(lockPath(home))).toBeNull(); // removed
  });

  test("removeLockIfOwned is a safe no-op when there's no lock file", () => {
    expect(() => removeLockIfOwned(lockPath(home), "gl-anything")).not.toThrow();
  });

  test("isPidAlive: true for the current process, false for a reaped one", async () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(await deadPid())).toBe(false);
  });
});

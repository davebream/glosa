// SPDX-License-Identifier: Apache-2.0
// Direct coverage for A4 §F04's synchronous durability primitives. Higher-level journal/inbox
// suites exercise these helpers only through the default filesystem implementation, which cannot
// force the short writes this loop exists to survive.
import { afterEach, describe, expect, test } from "bun:test";
import { closeSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fsyncContainingDir, writeAllSync } from "../../src/bus/io.ts";

const dirs: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "glosa-bus-io-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

describe("bus/io durability helpers", () => {
  test("writeAllSync advances offset and remaining length across forced short writes", () => {
    const path = join(freshDir(), "journal.ndjson");
    const fd = openSync(path, "w");
    const calls: Array<{ offset: number; length: number }> = [];
    const bytes = Buffer.from("abcdefghij", "utf8");

    try {
      writeAllSync(fd, bytes, (targetFd, buffer, offset, length) => {
        calls.push({ offset, length });
        const shortLength = Math.min(3, length);
        return writeSync(targetFd, buffer, offset, shortLength);
      });
    } finally {
      closeSync(fd);
    }

    expect(readFileSync(path, "utf8")).toBe("abcdefghij");
    expect(calls).toEqual([
      { offset: 0, length: 10 },
      { offset: 3, length: 7 },
      { offset: 6, length: 4 },
      { offset: 9, length: 1 },
    ]);
  });

  test("writeAllSync propagates a filesystem failure after a partial write", () => {
    const path = join(freshDir(), "inbox.tmp");
    const fd = openSync(path, "w");
    let calls = 0;

    try {
      expect(() =>
        writeAllSync(fd, Buffer.from("immutable", "utf8"), (targetFd, buffer, offset, length) => {
          calls++;
          if (calls === 2) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
          return writeSync(targetFd, buffer, offset, Math.min(2, length));
        }),
      ).toThrow("disk full");
    } finally {
      closeSync(fd);
    }

    expect(calls).toBe(2);
    expect(readFileSync(path, "utf8")).toBe("im");
  });

  test("fsyncContainingDir accepts a newly created child path and closes its directory fd", () => {
    const dir = freshDir();
    const path = join(dir, "new-entry.json");
    const descriptorsBefore = readdirSync("/dev/fd").length;

    for (let call = 0; call < 16; call++) fsyncContainingDir(path);

    // `/dev/fd` makes the close observable: omitting closeSync leaks one descriptor per call.
    // The actual durability guarantee still belongs to fsync(2); this test does not pretend to
    // simulate a power loss.
    expect(readdirSync("/dev/fd")).toHaveLength(descriptorsBefore);
  });
});

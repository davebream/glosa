// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import { createUlidGenerator, ulid } from "../../src/bus/ulid.ts";

const CROCKFORD_26 = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;

describe("ulid.ts", () => {
  test("produces 26-char Crockford base32 strings", () => {
    expect(CROCKFORD_26.test(ulid())).toBe(true);
  });

  test("is lexicographically increasing across increasing timestamps", () => {
    let t = 1_700_000_000_000;
    const gen = createUlidGenerator({ now: () => t, randomBytes: (n) => new Uint8Array(n) });
    const a = gen();
    t += 1;
    const b = gen();
    expect(a < b).toBe(true);
  });

  test("increments the random component (monotonic) when two calls land in the same millisecond", () => {
    const gen = createUlidGenerator({ now: () => 1_700_000_000_000, randomBytes: (n) => new Uint8Array(n) });
    const a = gen();
    const b = gen();
    expect(a.slice(0, 10)).toBe(b.slice(0, 10)); // identical time component
    expect(a < b).toBe(true); // random component incremented
  });

  test("deterministic deps produce a repeatable sequence", () => {
    const deps = { now: () => 1_700_000_000_000, randomBytes: (n: number) => new Uint8Array(n).fill(3) };
    expect(createUlidGenerator(deps)()).toBe(createUlidGenerator(deps)());
  });

  test("wraps all-1s randomness to zero when incrementing within the same millisecond (rare edge case)", () => {
    // 0xff-filled bytes decode to the max base32 digit (31 -> 'Z') in every position, so the very
    // next increment in the same ms has nowhere to carry to and wraps around to all zeros.
    const gen = createUlidGenerator({ now: () => 1_700_000_000_000, randomBytes: (n) => new Uint8Array(n).fill(0xff) });
    const a = gen();
    const b = gen();
    expect(a.slice(10)).toBe("Z".repeat(16));
    expect(b.slice(10)).toBe("0".repeat(16));
    expect(a.slice(0, 10)).toBe(b.slice(0, 10)); // same millisecond
  });
});

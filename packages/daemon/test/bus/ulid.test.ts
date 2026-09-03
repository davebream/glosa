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

  test("stays monotonic when the clock steps backwards (NTP step, manual change, VM resume)", () => {
    // A backwards `Date.now()` must not be able to mint an id that sorts BEFORE one already written
    // to the journal — lexicographic order == chronological order is the property A4 §F04 rests on.
    let t = 1_700_000_000_000;
    const gen = createUlidGenerator({ now: () => t, randomBytes: (n) => new Uint8Array(n) });
    const a = gen();
    t -= 5_000; // clock jumps 5s into the past
    const b = gen();
    expect(a < b).toBe(true);
    expect(b.slice(0, 10)).toBe(a.slice(0, 10)); // time clamped to the high-water mark, not rewound
    expect(b.slice(10)).toBe(`${"0".repeat(15)}1`); // clamp engaged -> increment-with-carry ran
  });

  test("holds the high-water mark across repeated calls while the clock is still behind it", () => {
    // The trap in a partial fix: clamp the emitted time but still assign `lastTime = now()`. The
    // first id would look right and the NEXT one would rewind again, so drive three calls through a
    // clock that regresses and then only partially recovers.
    let t = 1_700_000_000_000;
    const gen = createUlidGenerator({ now: () => t, randomBytes: (n) => new Uint8Array(n) });
    const a = gen();
    t -= 5_000;
    const b = gen();
    t += 1_000; // recovers a little, still 4s behind the high-water mark
    const c = gen();
    expect(a < b).toBe(true);
    expect(b < c).toBe(true);
    expect(c.slice(0, 10)).toBe(a.slice(0, 10));
    expect(c.slice(10)).toBe(`${"0".repeat(15)}2`); // carry chain continued across both clamped calls
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

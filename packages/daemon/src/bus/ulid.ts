// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — a small, dependency-free ULID generator (Crockford base32, 48-bit ms
// timestamp + 80-bit randomness, monotonic within the same millisecond by incrementing the
// random component — see https://github.com/ulid/spec). Used as the journal `event_id` (A4
// §F04): lexicographic sort order == chronological order, which is what makes "pure left-fold
// in file order" and "dedup by event_id" meaningful.
//
// `now`/`randomBytes` are injectable so tests can produce exact, repeatable ids (e.g. to force
// two events into the same millisecond and exercise the monotonic-increment path).
import { randomBytes as nodeRandomBytes } from "node:crypto";

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32 — no I, L, O, U
const TIME_LEN = 10; // 10 chars * 5 bits = 50 bits, holds the 48-bit ms timestamp
const RANDOM_LEN = 16; // 16 chars * 5 bits = 80 bits
const RANDOM_BYTES = 10; // 80 bits

export type NowFn = () => number;
export type RandomBytesFn = (n: number) => Uint8Array;
export type UlidGenerator = () => string;

export interface UlidDeps {
  now?: NowFn;
  randomBytes?: RandomBytesFn;
}

export function createUlidGenerator(deps: UlidDeps = {}): UlidGenerator {
  const now = deps.now ?? Date.now;
  const randomBytes = deps.randomBytes ?? ((n: number) => new Uint8Array(nodeRandomBytes(n)));

  let lastTime = -1;
  let lastRandomDigits: number[] | null = null;

  return function ulid(): string {
    const time = now();
    const randomDigits =
      time === lastTime && lastRandomDigits !== null
        ? incrementDigits(lastRandomDigits)
        : bytesToDigits(randomBytes(RANDOM_BYTES));

    lastTime = time;
    lastRandomDigits = randomDigits;

    return encodeTime(time) + digitsToString(randomDigits);
  };
}

/** Default, non-deterministic generator for production use. Tests use `createUlidGenerator`
 * with injected `now`/`randomBytes` instead. */
export const ulid: UlidGenerator = createUlidGenerator();

function encodeTime(time: number): string {
  let t = time;
  const chars: string[] = new Array(TIME_LEN);
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    chars[i] = ENCODING[t % 32] as string;
    t = Math.floor(t / 32);
  }
  return chars.join("");
}

/** 10 bytes (80 bits) -> 16 base32 digit values (0-31 each), MSB first — exact, no padding or
 * truncation since 10*8 == 16*5. Uses BigInt purely to avoid 32-bit shift overflow. */
function bytesToDigits(bytes: Uint8Array): number[] {
  let value = 0n;
  for (const b of bytes) value = (value << 8n) | BigInt(b);
  const digits: number[] = new Array(RANDOM_LEN);
  for (let i = RANDOM_LEN - 1; i >= 0; i--) {
    digits[i] = Number(value & 0x1fn);
    value >>= 5n;
  }
  return digits;
}

/** +1 with carry, treating `digits` as a base-32 number. On the (astronomically rare) case of
 * all 80 random bits already being 1s, wraps to zero — monotonicity within this exact
 * millisecond is lost only in that one-in-2^80 case, never correctness (ids stay well-formed). */
function incrementDigits(digits: number[]): number[] {
  const next = digits.slice();
  for (let i = next.length - 1; i >= 0; i--) {
    const d = next[i] as number;
    if (d < 31) {
      next[i] = d + 1;
      return next;
    }
    next[i] = 0;
  }
  return next;
}

function digitsToString(digits: number[]): string {
  let out = "";
  for (const d of digits) out += ENCODING[d];
  return out;
}

// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import { AsyncMutex, KeyedMutex } from "../../src/bus/mutex.ts";

describe("AsyncMutex", () => {
  test("serializes concurrent runExclusive calls FIFO — no two critical sections overlap", async () => {
    const mutex = new AsyncMutex();
    const order: number[] = [];
    const tasks = [1, 2, 3, 4, 5].map((n) =>
      mutex.runExclusive(async () => {
        order.push(n);
        await Bun.sleep(Math.random() * 5);
        order.push(-n);
      }),
    );
    await Promise.all(tasks);
    for (let i = 0; i < order.length; i += 2) {
      expect(order[i]).toBe(-(order[i + 1] as number));
    }
  });

  test("a throwing holder still releases the lock for the next waiter", async () => {
    const mutex = new AsyncMutex();
    await expect(
      mutex.runExclusive(() => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await mutex.runExclusive(() => "ok")).toBe("ok");
  });
});

describe("KeyedMutex", () => {
  test("serializes same-key calls but lets different keys run independently", async () => {
    const mutex = new KeyedMutex<string>();
    let activeA = 0;
    let maxActiveA = 0;
    let bSawAHeld = false;

    const a1 = mutex.runExclusive("a", async () => {
      activeA++;
      maxActiveA = Math.max(maxActiveA, activeA);
      await Bun.sleep(20);
      activeA--;
    });
    const a2 = mutex.runExclusive("a", () => {
      activeA++;
      maxActiveA = Math.max(maxActiveA, activeA);
      activeA--;
    });
    const b1 = mutex.runExclusive("b", () => {
      bSawAHeld = activeA > 0;
    });

    await Promise.all([a1, a2, b1]);
    expect(maxActiveA).toBe(1); // same key's critical sections never overlap
    expect(bSawAHeld).toBe(true); // a different key ran while "a" was still busy
  });
});

// A4 "Loose-file adoption — seal and link" requires the daemon to hold "every source registration
// mutex in stable lexical order". `runExclusiveMany` acquires by nesting `runExclusive`, i.e.
// hold-and-wait, so that stable order is the ONLY thing keeping it deadlock-free — and it holds
// only if the sort is a total order over the key set. These fixtures are the counterexample to
// `localeCompare`: ICU collates canonically-equivalent strings as equal, `Array.prototype.sort` is
// stable, so tied keys keep *insertion* order, which differs between callers. This was not a
// contrived pair: A4 F20 notes "APFS returns NFD", and `workspaceRegistrationId` used to embed the
// raw path as `directory:<path>`, so two adoptions naming the same accented directory really did
// arrive with one NFC key and one NFD key. That id is now a sha256 hex digest, which puts the
// workspace caller out of reach of the hazard — but `KeyedMutex` is generic over its key type, so
// its total-order guarantee has to hold for any string a caller passes, not just today's.
const NFC_KEY = "directory:/tmp/glosa-café"; // "café" with precomposed U+00E9
const NFD_KEY = "directory:/tmp/glosa-café"; // "café" as "e" + U+0301 COMBINING ACUTE ACCENT

describe("KeyedMutex.runExclusiveMany", () => {
  test("the NFC/NFD fixture keys tie under ICU collation but are ordered under code-unit comparison", () => {
    expect(NFC_KEY).not.toBe(NFD_KEY);
    // Ties in BOTH directions — this is what makes the comparator non-total, not merely asymmetric.
    expect(NFC_KEY.localeCompare(NFD_KEY)).toBe(0);
    expect(NFD_KEY.localeCompare(NFC_KEY)).toBe(0);
    // A code-unit-exact comparator separates them deterministically ("e" U+0065 sorts before U+00E9).
    expect(NFD_KEY < NFC_KEY).toBe(true);
  });

  test("uses the code-unit total order even where the matcher's UTF-8 output order differs", async () => {
    // U+10000 starts with the UTF-16 high surrogate 0xD800, which sorts before U+E000. In UTF-8,
    // U+E000 starts with 0xEE and sorts before U+10000's 0xF0. The matcher must use the latter
    // order (A4 F20); a mutex may use either total order, and deliberately uses the allocation-free
    // ECMAScript relation because lock acquisition order is not persisted or exposed.
    const codeUnitFirst = `key-${String.fromCodePoint(0x10000)}`;
    const utf8First = `key-${String.fromCodePoint(0xe000)}`;
    expect(codeUnitFirst < utf8First).toBe(true);
    expect(Buffer.compare(Buffer.from(utf8First, "utf8"), Buffer.from(codeUnitFirst, "utf8"))).toBeLessThan(0);

    const mutex = new KeyedMutex<string>();
    let releaseCodeUnitFirst!: () => void;
    let holderStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      holderStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseCodeUnitFirst = resolve;
    });
    const holder = mutex.runExclusive(codeUnitFirst, async () => {
      holderStarted();
      await release;
    });
    await started;

    const many = mutex.runExclusiveMany([utf8First, codeUnitFirst], () => undefined);
    const utf8FirstProbe = mutex.runExclusive(utf8First, () => "probe-completed" as const);
    const probeOutcome = await Promise.race([utf8FirstProbe, Bun.sleep(100).then(() => "probe-blocked" as const)]);

    releaseCodeUnitFirst();
    await Promise.all([holder, many, utf8FirstProbe]);
    expect(probeOutcome).toBe("probe-completed");
  });

  test("two callers acquiring canonically-equivalent keys in opposite order both complete", async () => {
    const mutex = new KeyedMutex<string>();
    const completed: string[] = [];

    // Both calls are issued synchronously and `runExclusive` claims its key's queue slot
    // synchronously, so caller "a" owns whichever key sorts first for it and caller "b" owns
    // whichever key sorts first for it before either body runs. If the sort preserved insertion
    // order for the tied pair, those are two DIFFERENT keys and each caller then waits on the key
    // the other already holds — a permanent wedge, since AsyncMutex has no timeout.
    const a = mutex.runExclusiveMany([NFC_KEY, NFD_KEY], () => {
      completed.push("a");
    });
    const b = mutex.runExclusiveMany([NFD_KEY, NFC_KEY], () => {
      completed.push("b");
    });

    // Race against a bounded timer: a deadlock must surface as a FAILING assertion, never as a
    // suite that hangs forever.
    const outcome = await Promise.race([
      Promise.all([a, b]).then(() => "both-completed" as const),
      Bun.sleep(250).then(() => "deadlocked" as const),
    ]);

    expect(outcome).toBe("both-completed");
    expect(completed.toSorted()).toEqual(["a", "b"]);
  });

  test("rejects a key set the comparator cannot order, instead of deadlocking on it", async () => {
    const mutex = new KeyedMutex<unknown>();
    // `1` and `"1"` both survive `new Set` dedup (SameValueZero says they differ) and so get
    // SEPARATE mutex slots, yet `String()` renders both as "1". The byte-exact comparator ties
    // them, the stable sort falls back to insertion order, and two callers passing them in
    // opposite orders would wedge exactly as the NFC/NFD pair used to. No workspace caller can
    // reach this — `workspaceRegistrationId` always returns a string — so it is a bug in the
    // caller, and a loud rejection beats a silent permanent wedge.
    const attempts = [
      [1, "1"],
      ["1", 1],
    ].map((keys) =>
      mutex
        .runExclusiveMany(keys, () => "unreachable")
        .then(
          () => "resolved",
          (error: unknown) => `rejected: ${String(error)}`,
        ),
    );
    const [first, second] = await Promise.race([Promise.all(attempts), Bun.sleep(250).then(() => ["hung", "hung"])]);

    expect(first).toMatch(/^rejected: .*indistinguishable keys/);
    expect(second).toMatch(/^rejected: .*indistinguishable keys/);
    // Rejection must happen before ANY key is acquired, so nothing is left locked behind it.
    expect(await mutex.runExclusive(1, () => "released")).toBe("released");
    expect(await mutex.runExclusive("1", () => "released")).toBe("released");
  });
});

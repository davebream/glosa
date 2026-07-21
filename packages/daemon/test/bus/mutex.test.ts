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

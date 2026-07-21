// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import { drainDaemonServers, SHUTDOWN_DRAIN_MS } from "../src/lifecycle.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("daemon shutdown drain", () => {
  test("uses the specified three-second production deadline", () => {
    expect(SHUTDOWN_DRAIN_MS).toBe(3000);
  });

  test("stops accepting, closes SSE, waits for active handlers, then closes workspace buses", async () => {
    const handler = deferred();
    const order: string[] = [];
    const server = {
      stop(force = false) {
        order.push(`stop:${force}`);
        return force ? Promise.resolve() : handler.promise;
      },
    };
    const draining = drainDaemonServers(
      [server],
      () => order.push("bye"),
      async () => void order.push("buses"),
      1000,
    );

    await Bun.sleep(0);
    expect(order).toEqual(["stop:false", "bye"]);
    handler.resolve();
    expect(await draining).toBe(true);
    expect(order).toEqual(["stop:false", "bye", "buses"]);
  });

  test("force-closes every listener when the drain deadline expires", async () => {
    const never = new Promise<void>(() => {});
    const calls: Array<{ server: number; force: boolean }> = [];
    const servers = [0, 1].map((server) => ({
      stop(force = false) {
        calls.push({ server, force });
        return force ? Promise.resolve() : never;
      },
    }));

    expect(await drainDaemonServers(servers, () => {}, async () => {}, 10)).toBe(false);
    expect(calls).toEqual([
      { server: 0, force: false },
      { server: 1, force: false },
      { server: 0, force: true },
      { server: 1, force: true },
    ]);
  });
});

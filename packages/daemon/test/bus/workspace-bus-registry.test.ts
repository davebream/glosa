// P2.4: closes the "single-writer is convention-only" gap flagged on WorkspaceBus (see the
// P2.4 comment block in ../../src/bus/bus.ts) — this suite proves the registry's own contract
// ("same root -> same instance, same shared mutex") rather than re-testing WorkspaceBus's
// internal single-writer behavior, which concurrency.test.ts already covers.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { getWorkspaceBus, WorkspaceBusRegistry } from "../../src/bus/workspace-bus-registry.ts";
import { journalPath } from "../../src/bus/paths.ts";
import { cleanupWorkspace, deterministicClock, deterministicUlid, freshWorkspace } from "./helpers.ts";

describe("WorkspaceBusRegistry", () => {
  test("get(root) twice returns the SAME instance", () => {
    const registry = new WorkspaceBusRegistry();
    const root = freshWorkspace();
    const a = registry.get(root, { ulid: deterministicUlid(), now: deterministicClock() });
    const b = registry.get(root);
    expect(b).toBe(a);
    cleanupWorkspace(root);
  });

  test("two different canonical roots get different instances", () => {
    const registry = new WorkspaceBusRegistry();
    const rootA = freshWorkspace();
    const rootB = freshWorkspace();
    const a = registry.get(rootA);
    const b = registry.get(rootB);
    expect(a).not.toBe(b);
    cleanupWorkspace(rootA);
    cleanupWorkspace(rootB);
  });

  test("deps (ulid/now) passed on first get() are the ones actually used — a second get() call's deps are ignored", async () => {
    const registry = new WorkspaceBusRegistry();
    const root = freshWorkspace();
    const clock = deterministicClock(1_700_000_000_000);
    const bus = registry.get(root, { ulid: deterministicUlid(), now: clock });

    // A second get() with DIFFERENT (real, non-deterministic) deps must not reconfigure the
    // already-open bus — it just returns the same instance, deterministic clock and all.
    const same = registry.get(root, {});
    await same.createEntry("e1", {});
    const line = JSON.parse(readFileSync(journalPath(root), "utf8").trim());
    expect(line.at).toBe(new Date(1_700_000_000_000).toISOString());
    expect(same).toBe(bus);

    await bus.close();
    cleanupWorkspace(root);
  });

  test("concurrent createEntry calls made through the SAME instance stay serialized (shared mutex)", async () => {
    const registry = new WorkspaceBusRegistry();
    const root = freshWorkspace();
    const bus = registry.get(root, { ulid: deterministicUlid(), now: deterministicClock() });
    const N = 30;

    await Promise.all(Array.from({ length: N }, (_, i) => bus.createEntry(`e${i}`, { seq: i })));
    await bus.close();

    const lines = readFileSync(journalPath(root), "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(N);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    cleanupWorkspace(root);
  });

  test("has() reflects whether a root has been opened; close() forgets it so a later get() opens fresh", async () => {
    const registry = new WorkspaceBusRegistry();
    const root = freshWorkspace();
    expect(registry.has(root)).toBe(false);

    const first = registry.get(root);
    expect(registry.has(root)).toBe(true);

    await registry.close(root);
    expect(registry.has(root)).toBe(false);

    const second = registry.get(root);
    expect(second).not.toBe(first);
    await second.close();
    cleanupWorkspace(root);
  });

  test("closeAll waits for and terminally closes every open workspace bus", async () => {
    const registry = new WorkspaceBusRegistry();
    const rootA = freshWorkspace();
    const rootB = freshWorkspace();
    const busA = registry.get(rootA);
    const busB = registry.get(rootB);
    await Promise.all([busA.createEntry("a", {}), busB.createEntry("b", {})]);

    await registry.closeAll();

    expect(registry.has(rootA)).toBe(false);
    expect(registry.has(rootB)).toBe(false);
    await expect(busA.createEntry("after-close", {})).rejects.toThrow("closed");
    await expect(busB.createEntry("after-close", {})).rejects.toThrow("closed");
    cleanupWorkspace(rootA);
    cleanupWorkspace(rootB);
  });
});

describe("getWorkspaceBus — process-wide default registry", () => {
  test("same root -> same instance via the module-level convenience function", () => {
    const root = freshWorkspace();
    const a = getWorkspaceBus(root);
    const b = getWorkspaceBus(root);
    expect(b).toBe(a);
    cleanupWorkspace(root);
  });
});

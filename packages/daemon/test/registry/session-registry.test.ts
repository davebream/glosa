// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { isCwdAncestorOf, SessionRegistry } from "../../src/registry/session-registry.ts";
import { WorkspaceIndex, workspaceIndexPath } from "../../src/registry/workspace-index.ts";
import { cleanup, deterministicClock, freshHome, manualClock } from "./helpers.ts";

describe("SessionRegistry — concurrent registration (F08 race)", () => {
  test("N concurrent register() calls, distinct sessions across several workspaces, all land", async () => {
    const home = freshHome();
    const index = new WorkspaceIndex({ home, now: deterministicClock() });
    const registry = new SessionRegistry({ now: deterministicClock(), index });
    const N = 50;

    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        registry.register({
          session_id: `s${i}`,
          provider: "claude-code",
          cwd: `/ws/${i % 5}`, // 5 distinct workspaces, 10 sessions each
          source: "startup",
        }),
      ),
    );

    for (let i = 0; i < N; i++) expect(registry.get(`s${i}`)).not.toBeNull();

    const entries = index.list();
    expect(entries).toHaveLength(5);
    const onDisk = JSON.parse(readFileSync(workspaceIndexPath(home), "utf8"));
    expect(Object.keys(onDisk.workspaces)).toHaveLength(5);
    cleanup(home);
  });

  test("re-registering the same session_id concurrently with distinct ones never corrupts the map", async () => {
    const registry = new SessionRegistry({ now: deterministicClock() });
    const calls = [
      registry.register({ session_id: "s1", provider: "claude-code", cwd: "/ws/a", source: "startup" }),
      registry.register({ session_id: "s1", provider: "claude-code", cwd: "/ws/a", source: "resume" }),
      registry.register({ session_id: "s2", provider: "claude-code", cwd: "/ws/b", source: "startup" }),
    ];
    await Promise.all(calls);
    expect(registry.get("s1")).not.toBeNull();
    expect(registry.get("s2")).not.toBeNull();
  });
});

describe("SessionRegistry — liveness without PID", () => {
  test("a session past its lease_expiry with no heartbeat is stale; a heartbeat before expiry keeps it alive", async () => {
    const clock = manualClock();
    const registry = new SessionRegistry({ now: clock, leaseTtlMs: 1000 });
    await registry.register({ session_id: "s1", provider: "claude-code", cwd: "/ws/a", source: "startup" });

    expect(registry.liveness("s1")).toBe("alive");
    clock.advance(500);
    await registry.heartbeat("s1"); // refreshes the lease from THIS point
    clock.advance(900); // 1400ms since register, but only 900ms since the heartbeat
    expect(registry.liveness("s1")).toBe("alive");

    clock.advance(200); // 1100ms since the heartbeat — past its 1000ms TTL
    expect(registry.liveness("s1")).toBe("stale");
  });

  test("an unknown session_id is stale, not a throw", () => {
    const registry = new SessionRegistry();
    expect(registry.liveness("nope")).toBe("stale");
  });

  test("heartbeat on an unknown session_id is a silent no-op", async () => {
    const registry = new SessionRegistry();
    await expect(registry.heartbeat("nope")).resolves.toBeUndefined();
  });

  test("never checks PID liveness (grep guard: no process.kill / kill( call sites)", () => {
    const sessionRegistrySrc = readFileSync(new URL("../../src/registry/session-registry.ts", import.meta.url), "utf8");
    const routingSrc = readFileSync(new URL("../../src/registry/routing.ts", import.meta.url), "utf8");
    // Strip `//` line comments before scanning — the module docstrings deliberately MENTION
    // process.kill (explaining why it's banned here, unlike lockfile-fallback.ts), and those
    // mentions must not trip this guard.
    const stripComments = (src: string): string =>
      src
        .split("\n")
        .map((line) => line.replace(/\/\/.*/, ""))
        .join("\n");
    const codeOnly = stripComments(sessionRegistrySrc) + stripComments(routingSrc);
    expect(codeOnly).not.toMatch(/process\.kill/);
    expect(codeOnly).not.toMatch(/\bkill\(/);
  });
});

describe("SessionRegistry — park / drain", () => {
  test("markParked + register() for that same workspace drains it", async () => {
    const registry = new SessionRegistry({ now: deterministicClock() });
    expect(registry.isParked("/ws/a")).toBe(false);
    registry.markParked("/ws/a");
    expect(registry.isParked("/ws/a")).toBe(true);

    const result = await registry.register({ session_id: "s1", provider: "claude-code", cwd: "/ws/a", source: "startup" });
    expect(result.drainedWorkspaces).toEqual(["/ws/a"]);
    expect(registry.isParked("/ws/a")).toBe(false);
  });

  test("registering a DIFFERENT workspace does not drain an unrelated park", async () => {
    const registry = new SessionRegistry({ now: deterministicClock() });
    registry.markParked("/ws/a");
    const result = await registry.register({ session_id: "s1", provider: "claude-code", cwd: "/ws/b", source: "startup" });
    expect(result.drainedWorkspaces).toEqual([]);
    expect(registry.isParked("/ws/a")).toBe(true);
  });

  test("a workspace with no pending park drains nothing on register", async () => {
    const registry = new SessionRegistry({ now: deterministicClock() });
    const result = await registry.register({ session_id: "s1", provider: "claude-code", cwd: "/ws/a", source: "startup" });
    expect(result.drainedWorkspaces).toEqual([]);
  });
});

describe("isCwdAncestorOf", () => {
  test("equal paths match", () => expect(isCwdAncestorOf("/a/b", "/a/b")).toBe(true));
  test("a real ancestor matches", () => expect(isCwdAncestorOf("/a", "/a/b/c")).toBe(true));
  test("a sibling with a shared string prefix does not match", () => expect(isCwdAncestorOf("/a/b", "/a/bc")).toBe(false));
  test("a descendant is not an ancestor of its parent", () => expect(isCwdAncestorOf("/a/b/c", "/a/b")).toBe(false));
});

describe("SessionRegistry.forWorkspace — routing precedence", () => {
  test("explicit workspace_binding wins over a cwd-ancestor match", async () => {
    const registry = new SessionRegistry({ now: deterministicClock() });
    // s1's cwd would match /repo/sub via the ancestor fallback...
    await registry.register({ session_id: "s1", provider: "claude-code", cwd: "/repo", source: "startup" });
    // ...but s2 explicitly binds to the exact target workspace, which is authoritative.
    await registry.register({
      session_id: "s2",
      provider: "claude-code",
      cwd: "/somewhere/else",
      workspace_binding: "/repo/sub",
      source: "startup",
    });

    expect(registry.forWorkspace("/repo/sub").map((r) => r.session_id)).toEqual(["s2"]);
  });

  test("cwd-ancestor fallback applies when no session explicitly binds to the workspace", async () => {
    const registry = new SessionRegistry({ now: deterministicClock() });
    await registry.register({ session_id: "s1", provider: "claude-code", cwd: "/repo", source: "startup" });
    expect(registry.forWorkspace("/repo/sub/dir").map((r) => r.session_id)).toEqual(["s1"]);
  });

  test("a session whose cwd is NOT an ancestor does not match", async () => {
    const registry = new SessionRegistry({ now: deterministicClock() });
    await registry.register({ session_id: "s1", provider: "claude-code", cwd: "/unrelated", source: "startup" });
    expect(registry.forWorkspace("/repo/sub")).toEqual([]);
  });

  test("a session explicitly bound elsewhere never leaks into another workspace's cwd fallback", async () => {
    const registry = new SessionRegistry({ now: deterministicClock() });
    await registry.register({
      session_id: "s1",
      provider: "claude-code",
      cwd: "/repo", // ancestor of /repo/sub
      workspace_binding: "/somewhere/else", // but explicitly belongs elsewhere
      source: "startup",
    });
    expect(registry.forWorkspace("/repo/sub")).toEqual([]);
  });

  test("only alive sessions are returned", async () => {
    const clock = manualClock();
    const registry = new SessionRegistry({ now: clock, leaseTtlMs: 100 });
    await registry.register({ session_id: "s1", provider: "claude-code", cwd: "/repo", source: "startup" });
    clock.advance(200);
    expect(registry.forWorkspace("/repo")).toEqual([]);
  });

  test("nearest-ancestor scoping: a deeper cwd match wins over a shallower one, no picker needed", async () => {
    const registry = new SessionRegistry({ now: deterministicClock() });
    // A at the repo root, B directly in the relevant subdirectory — both are valid ancestors of
    // the target workspace, but B is the obvious match (A2 §F08 step 2's "nearest ancestor").
    await registry.register({ session_id: "A", provider: "claude-code", cwd: "/repo", source: "startup" });
    await registry.register({ session_id: "B", provider: "claude-code", cwd: "/repo/sub", source: "startup" });

    expect(registry.forWorkspace("/repo/sub/deep").map((r) => r.session_id)).toEqual(["B"]);
  });

  test("nearest-ancestor scoping: A explicitly bound elsewhere still doesn't leak in as a shallower cwd match", async () => {
    const registry = new SessionRegistry({ now: deterministicClock() });
    await registry.register({
      session_id: "A",
      provider: "claude-code",
      cwd: "/repo",
      workspace_binding: "/somewhere/else",
      source: "startup",
    });
    await registry.register({ session_id: "B", provider: "claude-code", cwd: "/repo/sub", source: "startup" });

    expect(registry.forWorkspace("/repo/sub/deep").map((r) => r.session_id)).toEqual(["B"]);
  });

  test("nearest-ancestor scoping: two sessions sharing the exact same deepest cwd still both surface (picker territory)", async () => {
    const registry = new SessionRegistry({ now: deterministicClock() });
    await registry.register({ session_id: "A", provider: "claude-code", cwd: "/repo", source: "startup" });
    await registry.register({ session_id: "B", provider: "claude-code", cwd: "/repo/sub", source: "startup" });
    await registry.register({ session_id: "C", provider: "claude-code", cwd: "/repo/sub", source: "startup" });

    expect(registry.forWorkspace("/repo/sub/deep").map((r) => r.session_id).sort()).toEqual(["B", "C"]);
  });

  test("a cwd of '/' is never treated as an ancestor of everything (degenerate root guard)", async () => {
    const registry = new SessionRegistry({ now: deterministicClock() });
    await registry.register({ session_id: "root-session", provider: "claude-code", cwd: "/", source: "startup" });
    expect(registry.forWorkspace("/repo/sub")).toEqual([]);
  });
});

describe("SessionRegistry.register — rollback on index failure", () => {
  test("a first-time registration whose index upsert throws is NOT left registered", async () => {
    // A duck-typed stand-in for WorkspaceIndex — only the one method register() actually calls is
    // exercised, so a full real index (with its own tmp home, fs writes, etc.) would only add
    // noise to a test that's purely about SessionRegistry's own rollback behavior.
    const failingIndex = {
      upsertWorkspace: async () => {
        throw new Error("simulated persist failure (e.g. ENOSPC/EACCES)");
      },
    } as unknown as WorkspaceIndex;
    const registry = new SessionRegistry({ now: deterministicClock(), index: failingIndex });

    await expect(
      registry.register({ session_id: "s1", provider: "claude-code", cwd: "/ws/a", source: "startup" }),
    ).rejects.toThrow("simulated persist failure");

    expect(registry.get("s1")).toBeNull(); // never routable for a workspace the index never recorded
  });

  test("a re-registration whose index upsert throws rolls back to the PRIOR record, not to unregistered", async () => {
    let shouldFail = false;
    const flakyIndex = {
      upsertWorkspace: async () => {
        if (shouldFail) throw new Error("simulated failure");
      },
    } as unknown as WorkspaceIndex;
    const registry = new SessionRegistry({ now: deterministicClock(), index: flakyIndex });

    const first = await registry.register({ session_id: "s1", provider: "claude-code", cwd: "/ws/a", source: "startup" });

    shouldFail = true;
    await expect(
      registry.register({ session_id: "s1", provider: "claude-code", cwd: "/ws/b", source: "resume" }),
    ).rejects.toThrow();

    // Rolled back to exactly the record from the first successful register — not deleted, and
    // not left holding the failed attempt's (cwd: "/ws/b") half-applied state.
    expect(registry.get("s1")).toEqual(first.record);
  });
});

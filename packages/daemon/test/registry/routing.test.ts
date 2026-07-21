// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import { route } from "../../src/registry/routing.ts";
import { SessionRegistry } from "../../src/registry/session-registry.ts";
import { deterministicClock } from "./helpers.ts";

describe("route", () => {
  test("no live session -> parked, and marks the workspace parked on the registry", () => {
    const registry = new SessionRegistry({ now: deterministicClock() });
    expect(route(registry, "/ws/a")).toEqual({ parked: true });
    expect(registry.isParked("/ws/a")).toBe(true);
  });

  test("exactly one live session -> routes to it directly", async () => {
    const registry = new SessionRegistry({ now: deterministicClock() });
    await registry.register({ session_id: "s1", provider: "claude-code", cwd: "/ws/a", source: "startup" });
    expect(route(registry, "/ws/a")).toEqual({ target: "s1" });
  });

  test("two sessions bound to one workspace, no hint -> needsPicker (never guesses)", async () => {
    const registry = new SessionRegistry({ now: deterministicClock() });
    await registry.register({ session_id: "s1", provider: "claude-code", cwd: "/ws/a", source: "startup" });
    await registry.register({ session_id: "s2", provider: "claude-code", cwd: "/ws/a", source: "startup" });
    const result = route(registry, "/ws/a");
    if (!("needsPicker" in result)) throw new Error("expected needsPicker");
    expect(result.needsPicker.sort()).toEqual(["s1", "s2"]);
  });

  test("two sessions bound to one workspace, sessionHint names one -> routes to it", async () => {
    const registry = new SessionRegistry({ now: deterministicClock() });
    await registry.register({ session_id: "s1", provider: "claude-code", cwd: "/ws/a", source: "startup" });
    await registry.register({ session_id: "s2", provider: "claude-code", cwd: "/ws/a", source: "startup" });
    expect(route(registry, "/ws/a", { sessionHint: "s2" })).toEqual({ target: "s2" });
  });

  test("a sessionHint naming neither live session still surfaces a picker, never guesses", async () => {
    const registry = new SessionRegistry({ now: deterministicClock() });
    await registry.register({ session_id: "s1", provider: "claude-code", cwd: "/ws/a", source: "startup" });
    await registry.register({ session_id: "s2", provider: "claude-code", cwd: "/ws/a", source: "startup" });
    const result = route(registry, "/ws/a", { sessionHint: "s99" });
    expect("needsPicker" in result).toBe(true);
  });

  test("explicit workspace_binding wins over a cwd-ancestor match, at the routing layer too", async () => {
    const registry = new SessionRegistry({ now: deterministicClock() });
    await registry.register({ session_id: "s1", provider: "claude-code", cwd: "/repo", source: "startup" });
    await registry.register({
      session_id: "s2",
      provider: "claude-code",
      cwd: "/elsewhere",
      workspace_binding: "/repo/sub",
      source: "startup",
    });
    expect(route(registry, "/repo/sub")).toEqual({ target: "s2" });
  });

  test("park -> drain: a parked workspace's next register() drains it, and routing then resolves normally", async () => {
    const registry = new SessionRegistry({ now: deterministicClock() });
    expect(route(registry, "/ws/a")).toEqual({ parked: true });

    const result = await registry.register({ session_id: "s1", provider: "claude-code", cwd: "/ws/a", source: "startup" });
    expect(result.drainedWorkspaces).toEqual(["/ws/a"]);

    expect(route(registry, "/ws/a")).toEqual({ target: "s1" });
  });

  test("routing to a workspace with no matching session again re-parks it (each miss is its own park)", () => {
    const registry = new SessionRegistry({ now: deterministicClock() });
    expect(route(registry, "/ws/a")).toEqual({ parked: true });
    expect(route(registry, "/ws/a")).toEqual({ parked: true }); // still parked, idempotent Set add
    expect(registry.isParked("/ws/a")).toBe(true);
  });

  test("nearest-ancestor scoping resolves a single target instead of forcing a picker", async () => {
    const registry = new SessionRegistry({ now: deterministicClock() });
    await registry.register({ session_id: "A", provider: "claude-code", cwd: "/repo", source: "startup" });
    await registry.register({ session_id: "B", provider: "claude-code", cwd: "/repo/sub", source: "startup" });

    expect(route(registry, "/repo/sub/deep")).toEqual({ target: "B" });
  });
});

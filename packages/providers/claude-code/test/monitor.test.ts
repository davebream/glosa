// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MONITOR_MAX_DELAY_MS,
  MONITOR_MIN_DELAY_MS,
  monitorRetryDelay,
  registeredWorkspaceForProject,
  runClaudeMonitor,
} from "../src/monitor.ts";

describe("Claude plugin monitor", () => {
  test("retry delay keeps the five-second floor and finite cap", () => {
    expect(MONITOR_MIN_DELAY_MS).toBe(5_000);
    expect(MONITOR_MAX_DELAY_MS).toBe(60_000);
    expect(monitorRetryDelay(0, () => 0)).toBe(MONITOR_MIN_DELAY_MS);
    expect(monitorRetryDelay(0, () => 1)).toBe(6_000);
    expect(monitorRetryDelay(99, () => 1)).toBe(MONITOR_MAX_DELAY_MS);
  });

  test("workspace discovery is read-only and chooses the most specific active ancestor", () => {
    const home = mkdtempSync(join(tmpdir(), "glosa-monitor-index-"));
    const outerPath = join(home, "outer");
    const innerPath = join(outerPath, "inner");
    mkdirSync(innerPath, { recursive: true });
    const outer = realpathSync(outerPath);
    const inner = realpathSync(innerPath);
    const path = join(home, "workspaces.json");
    writeFileSync(
      path,
      JSON.stringify({
        version: 4,
        updated_at: new Date().toISOString(),
        workspaces: {
          outer: { canonical_path: outer, present: true, lifecycle: { state: "active" } },
          inner: { canonical_path: inner, present: true, lifecycle: { state: "active" } },
          inactive: { canonical_path: home, present: true, lifecycle: { state: "forgetting" } },
        },
        adoptions: {},
        forget_operations: {},
      }),
    );
    expect(registeredWorkspaceForProject(path, inner)).toBe(inner);
    rmSync(home, { recursive: true, force: true });
  });

  test("outside a registered workspace it waits without touching the daemon", async () => {
    const home = mkdtempSync(join(tmpdir(), "glosa-monitor-idle-"));
    const project = join(home, "project");
    mkdirSync(project);
    const abort = new AbortController();
    let fetches = 0;
    let waits = 0;
    await runClaudeMonitor(
      { sessionId: "session-1", projectDir: project, pluginRoot: join(home, "plugin") },
      {
        home: () => home,
        fetch: (async () => {
          fetches += 1;
          throw new Error("unexpected daemon call");
        }) as unknown as typeof fetch,
        stdout: { write: () => true },
        random: () => 0,
        sleep: async () => {},
        waitForWorkspaceChange: async () => {
          waits += 1;
          abort.abort();
        },
      },
      abort.signal,
    );
    expect(waits).toBe(1);
    expect(fetches).toBe(0);
    expect(existsSync(join(home, "daemon.lock"))).toBe(false);
    rmSync(home, { recursive: true, force: true });
  });
});

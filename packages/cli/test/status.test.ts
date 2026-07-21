// SPDX-License-Identifier: Apache-2.0
// P5.1 — `glosa status [dir] --json` (A6 §F26): must NEVER fail just because the daemon is down.
import { describe, expect, test } from "bun:test";
import type { GlosaApiClient } from "../src/api-client.ts";
import { printStatusResult, runStatus, type StatusDeps } from "../src/status.ts";
import { daemonUnreachable, FakeGlosaApiClient } from "./fake-api-client.ts";
import { captureStdout } from "./test-utils.ts";

describe("glosa status", () => {
  test("daemon unreachable -> STILL exit 0, reachability reported in data, not thrown", async () => {
    const deps: StatusDeps = { createClient: async () => { throw daemonUnreachable("no daemon running"); } };
    const result = await runStatus("/repo", deps);
    expect(result.exitCode).toBe(0);
    expect(result.ok).toBe(true);
    expect(result.data.daemon_reachable).toBe(false);
    expect(result.data.reason).toContain("no daemon running");
  });

  test("daemon reachable but the status call itself fails -> still exit 0, reachability false, a warning recorded", async () => {
    const client = new FakeGlosaApiClient();
    client.getStatus = async () => {
      throw new Error("unexpected 500");
    };
    const deps: StatusDeps = { createClient: async () => client as unknown as GlosaApiClient };
    const result = await runStatus("/repo", deps);
    expect(result.exitCode).toBe(0);
    expect(result.data.daemon_reachable).toBe(false);
    expect(result.warnings).toHaveLength(1);
  });

  test("daemon reachable: reports workspaces/sessions/pending from the aggregate", async () => {
    const client = new FakeGlosaApiClient();
    client.statusResult = {
      daemon: {
        instance_id: "gl-1",
        pid: 42,
        started_at: "2020-01-01T00:00:00.000Z",
        protocol_version: "1.0",
        contract_version: "1.0",
        build_id: "0.1.0-alpha.0-0123456789abcdef",
      },
      workspaces: [{ slug: "abc", path: "/repo", last_seen: "2020-01-01T00:00:00.000Z", pending_count: 2, has_attention: true }],
      sessions: [{ session_id: "sess-1", provider: "claude-code", cwd: "/repo", workspace_binding: null, last_active_at: "2020-01-01T00:00:00.000Z", liveness: "alive" }],
    };
    const deps: StatusDeps = { createClient: async () => client as unknown as GlosaApiClient };
    const result = await runStatus("/repo", deps);
    expect(result.exitCode).toBe(0);
    expect(result.data.daemon_reachable).toBe(true);
    expect(result.data.workspaces).toHaveLength(1);
    expect(result.data.sessions).toHaveLength(1);
  });

  test("--json envelope has exactly the documented top-level keys", async () => {
    const deps: StatusDeps = { createClient: async () => { throw daemonUnreachable(); } };
    const result = await runStatus("/repo", deps);
    const out = captureStdout(() => printStatusResult(result, true));
    const parsed = JSON.parse(out);
    expect(Object.keys(parsed).sort()).toEqual(["command", "data", "error", "exit_code", "glosa_json", "ok", "warnings"].sort());
    expect(parsed).toMatchObject({ glosa_json: 1, ok: true, command: "status", exit_code: 0 });
  });
});

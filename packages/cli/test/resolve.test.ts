// P5.1 — `glosa resolve <id> <applied|rejected|deferred|stale> --session <sid> [--note]` and
// `glosa apply-begin <id> --session <sid>` (A4 §F05 / A6 §F26).
import { describe, expect, test } from "bun:test";
import {
  printApplyBeginResult,
  printResolveResult,
  runApplyBegin,
  runResolve,
  type ResolveDeps,
} from "../src/resolve.ts";
import type { GlosaApiClient } from "../src/api-client.ts";
import { apiError, daemonUnreachable, FakeGlosaApiClient } from "./fake-api-client.ts";
import { captureStdout } from "./test-utils.ts";

function makeClientDeps(client: FakeGlosaApiClient = new FakeGlosaApiClient()) {
  return { deps: { createClient: async () => client as unknown as GlosaApiClient }, client };
}

describe("glosa resolve", () => {
  test("missing <id> -> exit 2 (usage), never touches the daemon", async () => {
    const client = new FakeGlosaApiClient();
    const { deps } = makeClientDeps(client);
    const result = await runResolve({ dir: "/repo", outcome: "applied", session: "sess-1" }, deps);
    expect(result.exitCode).toBe(2);
    expect(client.calls).toHaveLength(0);
  });

  test("missing --session -> exit 2 (usage)", async () => {
    const { deps } = makeClientDeps();
    const result = await runResolve({ dir: "/repo", id: "inb-1", outcome: "applied" }, deps);
    expect(result.exitCode).toBe(2);
  });

  test("bad <status> value -> exit 2 (usage)", async () => {
    const { deps } = makeClientDeps();
    const result = await runResolve({ dir: "/repo", id: "inb-1", outcome: "maybe-later", session: "sess-1" }, deps);
    expect(result.exitCode).toBe(2);
  });

  test("daemon unreachable -> exit 3", async () => {
    const deps = { createClient: async () => { throw daemonUnreachable(); } };
    const result = await runResolve({ dir: "/repo", id: "inb-1", outcome: "applied", session: "sess-1" }, deps);
    expect(result.exitCode).toBe(3);
    expect(result.error?.kind).toBe("daemon_unreachable");
  });

  test("unknown id (no matching apply-begin lease) -> exit 8 (entry_error)", async () => {
    const client = new FakeGlosaApiClient();
    client.resolveEntryImpl = async () => {
      throw apiError(409, { type: "https://glosa.local/errors/conflict", title: "no matching apply-begin lease for this entry/session" });
    };
    const { deps } = makeClientDeps(client);
    const result = await runResolve({ dir: "/repo", id: "inb-unknown", outcome: "applied", session: "sess-1" }, deps);
    expect(result.exitCode).toBe(8);
    expect(result.error?.kind).toBe("entry_error");
  });

  test("applied: calls resolveEntry with the note threaded through, returns exit 0", async () => {
    const client = new FakeGlosaApiClient();
    const { deps } = makeClientDeps(client);
    const result = await runResolve({ dir: "/repo", id: "inb-1", outcome: "applied", session: "sess-1", note: "looks good" }, deps);
    expect(result.exitCode).toBe(0);
    expect(client.calls[0]).toMatchObject({ method: "resolveEntry", args: ["/repo", "inb-1", "applied", "sess-1", "looks good"] });
  });

  test("deferred: still calls resolveEntry (the daemon route decides not to touch the lease) and succeeds", async () => {
    const client = new FakeGlosaApiClient();
    client.resolveEntryImpl = async (path, entry) => ({ entry, status: "delivered", to: "deferred" });
    const { deps } = makeClientDeps(client);
    const result = await runResolve({ dir: "/repo", id: "inb-1", outcome: "deferred", session: "sess-1" }, deps);
    expect(result.exitCode).toBe(0);
    expect(result.data.to).toBe("deferred");
    expect(result.data.status).toBe("delivered"); // status did NOT move to a terminal value
  });

  test("--json envelope has exactly the documented top-level keys", async () => {
    const { deps } = makeClientDeps();
    const result = await runResolve({ dir: "/repo", id: "inb-1", outcome: "applied", session: "sess-1" }, deps);
    const out = captureStdout(() => printResolveResult(result, true));
    const parsed = JSON.parse(out);
    expect(Object.keys(parsed).sort()).toEqual(["command", "data", "error", "exit_code", "glosa_json", "ok", "warnings"].sort());
    expect(parsed).toMatchObject({ glosa_json: 1, ok: true, command: "resolve", exit_code: 0 });
  });
});

describe("glosa apply-begin", () => {
  test("missing <id> -> exit 2 (usage)", async () => {
    const { deps } = makeClientDeps();
    const result = await runApplyBegin({ dir: "/repo", session: "sess-1" }, deps);
    expect(result.exitCode).toBe(2);
  });

  test("missing --session -> exit 2 (usage)", async () => {
    const { deps } = makeClientDeps();
    const result = await runApplyBegin({ dir: "/repo", id: "inb-1" }, deps);
    expect(result.exitCode).toBe(2);
  });

  test("daemon unreachable -> exit 3", async () => {
    const deps: ResolveDeps = { createClient: async () => { throw daemonUnreachable(); } };
    const result = await runApplyBegin({ dir: "/repo", id: "inb-1", session: "sess-1" }, deps);
    expect(result.exitCode).toBe(3);
  });

  test("already-leased entry -> exit 12 (lease_conflict)", async () => {
    const client = new FakeGlosaApiClient();
    client.applyBeginImpl = async () => {
      throw apiError(409, { type: "https://glosa.local/errors/lease-conflict", title: "an apply-lease is already active for this workspace" });
    };
    const { deps } = makeClientDeps(client);
    const result = await runApplyBegin({ dir: "/repo", id: "inb-1", session: "sess-1" }, deps);
    expect(result.exitCode).toBe(12);
    expect(result.error?.kind).toBe("lease_conflict");
  });

  test("success: prints the bare lease token in human mode", async () => {
    const client = new FakeGlosaApiClient();
    const { deps } = makeClientDeps(client);
    const result = await runApplyBegin({ dir: "/repo", id: "inb-1", session: "sess-1" }, deps);
    expect(result.exitCode).toBe(0);
    const out = captureStdout(() => printApplyBeginResult(result, false));
    expect(result.data.lease_id).toBeTruthy();
    expect(out.trim()).toBe(result.data.lease_id as string);
  });

  test("--json envelope has exactly the documented top-level keys", async () => {
    const { deps } = makeClientDeps();
    const result = await runApplyBegin({ dir: "/repo", id: "inb-1", session: "sess-1" }, deps);
    const out = captureStdout(() => printApplyBeginResult(result, true));
    const parsed = JSON.parse(out);
    expect(Object.keys(parsed).sort()).toEqual(["command", "data", "error", "exit_code", "glosa_json", "ok", "warnings"].sort());
    expect(parsed).toMatchObject({ glosa_json: 1, ok: true, command: "apply-begin", exit_code: 0 });
  });
});

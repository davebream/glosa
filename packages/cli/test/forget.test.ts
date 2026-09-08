// SPDX-License-Identifier: Apache-2.0
// glosa forget <workspace> [--yes] [--json] (issue #156) — CLI-boundary consent/exit-code/JSON
// contract tests, mirroring resolve.test.ts's in-process pattern: a `FakeGlosaApiClient` records
// every call so a test can assert exactly what the daemon was asked, with no real daemon anywhere
// in the loop.
import { describe, expect, test } from "bun:test";
import type { GlosaApiClient } from "../src/api-client.ts";
import { type ForgetDeps, printForgetResult, runForget } from "../src/forget.ts";
import { apiError, daemonUnreachable, FakeGlosaApiClient } from "./fake-api-client.ts";
import { captureStdout } from "./test-utils.ts";

function makeClientDeps(client: FakeGlosaApiClient = new FakeGlosaApiClient()) {
  return { client, createClient: async () => client as unknown as GlosaApiClient };
}

describe("glosa forget CLI", () => {
  test("missing <workspace> -> exit 2 (usage), never touches the daemon", async () => {
    const { client, createClient } = makeClientDeps();
    const result = await runForget({ yes: true }, { createClient });
    expect(result.exitCode).toBe(2);
    expect(client.calls).toHaveLength(0);
  });

  test("non-interactive without --yes -> exit 2 (usage), never touches the daemon", async () => {
    const { client, createClient } = makeClientDeps();
    const deps: ForgetDeps = { createClient, isTTY: () => false };
    const result = await runForget({ slug: "ws-1" }, deps);
    expect(result.exitCode).toBe(2);
    expect(client.calls).toHaveLength(0);
  });

  test("--json without --yes -> exit 2 even on a TTY (JSON output must never block on a prompt)", async () => {
    const { client, createClient } = makeClientDeps();
    const deps: ForgetDeps = { createClient, isTTY: () => true };
    const result = await runForget({ slug: "ws-1", json: true }, deps);
    expect(result.exitCode).toBe(2);
    expect(client.calls).toHaveLength(0);
  });

  test("daemon unreachable -> exit 3", async () => {
    const deps: ForgetDeps = {
      createClient: async () => {
        throw daemonUnreachable();
      },
    };
    const result = await runForget({ slug: "ws-1", yes: true }, deps);
    expect(result.exitCode).toBe(3);
    expect(result.error?.kind).toBe("daemon_unreachable");
  });

  test("unknown workspace -> exit 4 (not_a_workspace)", async () => {
    const client = new FakeGlosaApiClient();
    client.forgetWorkspaceImpl = async () => {
      throw apiError(404, { type: "https://glosa.local/errors/not-found", title: "unknown workspace" });
    };
    const { createClient } = makeClientDeps(client);
    const result = await runForget({ slug: "ws-1", yes: true }, { createClient });
    expect(result.exitCode).toBe(4);
  });

  test("a live session or apply-lease blocker -> exit 12 (lease_conflict), naming each blocker", async () => {
    const client = new FakeGlosaApiClient();
    const blockers = [
      { kind: "live-session" as const, session_id: "s1" },
      { kind: "apply-lease" as const, lease_id: "lease-1", expires_at: "2026-01-01T00:00:00.000Z" },
    ];
    client.forgetWorkspaceImpl = async () => {
      throw apiError(409, {
        type: "https://glosa.local/errors/forget-blocked",
        title: "workspace has a live bound session or an unexpired apply lease",
        blockers,
      });
    };
    const { createClient } = makeClientDeps(client);
    const result = await runForget({ slug: "ws-1", yes: true }, { createClient });
    expect(result.exitCode).toBe(12);
    expect(result.error?.kind).toBe("lease_conflict");
    expect(result.data.blockers).toEqual(blockers);
  });

  test("a stale member-set fingerprint on confirm -> exit 12 (lease_conflict), naming the reason (issue #156 held-review finding)", async () => {
    const client = new FakeGlosaApiClient();
    client.forgetWorkspaceImpl = async () => {
      throw apiError(409, {
        type: "https://glosa.local/errors/forget-stale-preview",
        title: "the previewed member set has changed — re-preview before confirming",
      });
    };
    const { createClient } = makeClientDeps(client);
    const result = await runForget({ slug: "ws-1", yes: true }, { createClient });
    expect(result.exitCode).toBe(12);
    expect(result.error?.kind).toBe("lease_conflict");
    expect(result.error?.code).toBe("forget-stale-preview");
  });

  test("--yes skips the preview/confirm round trip entirely and goes straight to confirm:true", async () => {
    const client = new FakeGlosaApiClient();
    client.forgetWorkspaceResult = {
      slug: "ws-1",
      confirmed: true,
      removed: [
        {
          registration_id: "abc123",
          slug: "ws-1",
          canonical_path: "/tmp/ws-1",
          kind: "directory",
          bus_path: "/tmp/ws-1/.glosa",
        },
      ],
    };
    const { createClient } = makeClientDeps(client);
    let confirmCalled = false;
    const result = await runForget(
      { slug: "ws-1", yes: true },
      {
        createClient,
        confirm: async () => {
          confirmCalled = true;
          return true;
        },
      },
    );
    expect(result.exitCode).toBe(0);
    expect(confirmCalled).toBe(false);
    expect(client.calls).toHaveLength(1); // exactly one call — no preview round trip
    expect(client.calls[0]).toMatchObject({ method: "forgetWorkspace", args: ["ws-1", { confirm: true }] });
  });

  test("declining the interactive confirmation cancels without deleting anything", async () => {
    const client = new FakeGlosaApiClient();
    client.forgetWorkspaceResult = {
      slug: "ws-1",
      confirmed: false,
      would_remove: [
        {
          registration_id: "abc123",
          slug: "ws-1",
          canonical_path: "/tmp/ws-1",
          kind: "directory",
          bus_path: "/tmp/ws-1/.glosa",
        },
      ],
      member_fingerprint: "fingerprint-1",
    };
    const { createClient } = makeClientDeps(client);
    const result = await runForget({ slug: "ws-1" }, { createClient, isTTY: () => true, confirm: async () => false });
    expect(result.exitCode).toBe(0);
    expect(result.data.cancelled).toBe(true);
    // Only the preview call happened — never a confirm:true execute.
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toMatchObject({ method: "forgetWorkspace", args: ["ws-1", { confirm: false }] });
  });

  test("requires consent and returns stable JSON removed paths", async () => {
    const client = new FakeGlosaApiClient();
    const removed = [
      {
        registration_id: "abc123",
        slug: "ws-1",
        canonical_path: "/tmp/ws-1",
        kind: "directory" as const,
        bus_path: "/tmp/ws-1/.glosa",
      },
      {
        registration_id: "def456",
        slug: "ws-1-loose",
        canonical_path: "/tmp/ws-1/loose.pdf",
        kind: "loose-file" as const,
        bus_path: "/home/.glosa/state/def456",
      },
    ];
    client.forgetWorkspaceImpl = async (slug, opts) => {
      if (opts?.confirm) return { slug, confirmed: true, removed };
      return { slug, confirmed: false, would_remove: removed, member_fingerprint: "fingerprint-removed" };
    };
    const { createClient } = makeClientDeps(client);

    let question = "";
    let confirmCalls = 0;
    const deps: ForgetDeps = {
      createClient,
      isTTY: () => true,
      confirm: async (q) => {
        question = q;
        confirmCalls += 1;
        return true;
      },
    };

    const result = await runForget({ slug: "ws-1" }, deps);

    // --- consent was actually required: exactly one confirmation, and it happened AFTER a
    // side-effect-free preview call named the exact paths ------------------------------------
    expect(confirmCalls).toBe(1);
    expect(question).toContain("/tmp/ws-1/.glosa");
    expect(question).toContain("/home/.glosa/state/def456");
    expect(client.calls.map((c) => c.method)).toEqual(["forgetWorkspace", "forgetWorkspace"]);
    expect(client.calls[0]).toMatchObject({ method: "forgetWorkspace", args: ["ws-1", { confirm: false }] });
    // Held-review addition: the interactive confirm:true call must echo back the EXACT preview's
    // fingerprint — this is the binding that lets the daemon refuse a stale confirmation.
    expect(client.calls[1]).toMatchObject({
      method: "forgetWorkspace",
      args: ["ws-1", { confirm: true, memberFingerprint: "fingerprint-removed" }],
    });

    // --- the stable JSON envelope (A6 §F26) carries every removed path -----------------------
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.data.removed).toEqual(removed);

    const printed = captureStdout(() => printForgetResult(result, true));
    const envelope = JSON.parse(printed);
    expect(envelope).toMatchObject({
      glosa_json: 1,
      ok: true,
      command: "forget",
      exit_code: 0,
      warnings: [],
      error: null,
    });
    expect(envelope.data.removed).toEqual(removed);
  });
});

// SPDX-License-Identifier: Apache-2.0
// P5.1 — `glosa request-review <path> [--message] [--action] [--wait <duration>]` (A5 §F23, A6 §F26).
import { describe, expect, test } from "bun:test";
import type { GlosaApiClient } from "../src/api-client.ts";
import { printRequestReviewResult, type RequestReviewDeps, runRequestReview } from "../src/request-review.ts";
import { apiError, daemonUnreachable, FakeGlosaApiClient } from "./fake-api-client.ts";
import { captureStderr, captureStdout } from "./test-utils.ts";

function makeDeps(client: FakeGlosaApiClient = new FakeGlosaApiClient()): {
  deps: RequestReviewDeps;
  client: FakeGlosaApiClient;
} {
  const deps: RequestReviewDeps = {
    createClient: async () => client as unknown as GlosaApiClient,
    now: () => 0,
    sleep: async () => {},
    pollIntervalMs: 1,
  };
  return { deps, client };
}

describe("glosa request-review", () => {
  test("missing <path> -> exit 2 (usage), never touches the daemon", async () => {
    const client = new FakeGlosaApiClient();
    const { deps } = makeDeps(client);
    const result = await runRequestReview({ dir: "/repo" }, deps);
    expect(result.exitCode).toBe(2);
    expect(client.calls).toHaveLength(0);
  });

  test("daemon unreachable -> exit 3", async () => {
    const deps: RequestReviewDeps = {
      createClient: async () => {
        throw daemonUnreachable();
      },
      now: () => 0,
      sleep: async () => {},
      pollIntervalMs: 1,
    };
    const result = await runRequestReview({ dir: "/repo", path: "notes.md" }, deps);
    expect(result.exitCode).toBe(3);
  });

  test("without --wait: returns immediately after creating the entry, exit 0", async () => {
    const client = new FakeGlosaApiClient();
    client.attentionRequestResult = { id: "inb-77", slug: "ws-1", status: "open" };
    const { deps } = makeDeps(client);
    const result = await runRequestReview({ dir: "/repo", path: "notes.md", message: "look at this" }, deps);
    expect(result.exitCode).toBe(0);
    expect(result.data).toEqual({ id: "inb-77", slug: "ws-1", status: "open" });
    expect(client.calls[0]).toMatchObject({
      method: "createAttentionRequest",
      args: ["/repo", { message: "look at this", action: "review", targetPath: "notes.md" }],
    });
  });

  test("--require-approval sends the opt-in flag while preserving custom task context", async () => {
    const client = new FakeGlosaApiClient();
    const { deps } = makeDeps(client);
    const result = await runRequestReview(
      {
        dir: "/repo",
        path: "notes.md",
        message: "Check the citations",
        action: "proofread",
        requireApproval: true,
      },
      deps,
    );
    expect(result.exitCode).toBe(0);
    expect(client.calls[0]).toEqual({
      method: "createAttentionRequest",
      args: [
        "/repo",
        {
          message: "Check the citations",
          action: "proofread",
          targetPath: "notes.md",
          approvalMode: true,
        },
      ],
    });
  });

  test("--wait: polls until a terminal attention status lands, then reports the verdict", async () => {
    const client = new FakeGlosaApiClient();
    client.attentionRequestResult = { id: "inb-1", slug: "ws-1", status: "open" };
    let pollCount = 0;
    client.getEntryStatus = async (_path, entry) => {
      pollCount++;
      if (pollCount < 3) return { id: entry, kind: "attention", status: "delivered", detail: null };
      return { id: entry, kind: "attention", status: "done", detail: { outcome: "approved", response: "Looks good" } };
    };
    let now = 0;
    const deps: RequestReviewDeps = {
      createClient: async () => client as unknown as GlosaApiClient,
      now: () => now,
      sleep: async () => {
        now += 1000;
      },
      pollIntervalMs: 1000,
    };
    const result = await runRequestReview({ dir: "/repo", path: "notes.md", waitMs: 60_000 }, deps);
    expect(result.exitCode).toBe(0);
    expect(result.data.status).toBe("done");
    expect(result.data.detail).toEqual({ outcome: "approved", response: "Looks good" });
    expect(pollCount).toBe(3);
    const output = captureStdout(() => printRequestReviewResult(result, false));
    expect(output).toContain("done: approved");
    expect(output).toContain("Looks good");
  });

  test("--wait: never resolves before the deadline -> exit 7 (review_timeout)", async () => {
    const client = new FakeGlosaApiClient();
    client.attentionRequestResult = { id: "inb-2", slug: "ws-1", status: "open" };
    client.getEntryStatus = async (_path, entry) => ({ id: entry, kind: "attention", status: "open", detail: null });
    let now = 0;
    const deps: RequestReviewDeps = {
      createClient: async () => client as unknown as GlosaApiClient,
      now: () => now,
      sleep: async () => {
        now += 5000;
      },
      pollIntervalMs: 5000,
    };
    const result = await runRequestReview({ dir: "/repo", path: "notes.md", waitMs: 10_000 }, deps);
    expect(result.exitCode).toBe(7);
    expect(result.error?.kind).toBe("review_timeout");
  });

  test("workspace lookup returns 404 -> exit 4 (not_a_workspace)", async () => {
    const client = new FakeGlosaApiClient();
    client.createAttentionRequest = async () => {
      throw apiError(404, {
        type: "https://glosa.local/errors/not-found",
        title: "unknown workspace",
      });
    };
    const { deps } = makeDeps(client);
    const result = await runRequestReview({ dir: "/nowhere", path: "notes.md" }, deps);
    expect(result.exitCode).toBe(4);
    expect(result.error).toMatchObject({ code: "not-a-workspace", kind: "not_a_workspace" });
  });

  test("invalid request returns 400 -> exit 70 (internal) with the safe problem title", async () => {
    const client = new FakeGlosaApiClient();
    client.createAttentionRequest = async () => {
      throw apiError(400, {
        type: "https://glosa.local/errors/invalid-path",
        title: "target_path must be workspace-relative and confined",
      });
    };
    const { deps } = makeDeps(client);
    const result = await runRequestReview({ dir: "/repo", path: "../notes.md" }, deps);

    expect(result.exitCode).toBe(70);
    expect(result.error).toEqual({
      code: "request-review-failed",
      kind: "internal",
      message: "target_path must be workspace-relative and confined",
    });

    const human = captureStderr(() => printRequestReviewResult(result, false));
    expect(human).toBe("glosa request-review: target_path must be workspace-relative and confined\n");
  });

  test("duplicate active approval -> exit 8 (approval-conflict)", async () => {
    const client = new FakeGlosaApiClient();
    client.createAttentionRequest = async () => {
      throw apiError(409, {
        type: "https://glosa.local/errors/approval-conflict",
        title: "an approval request is already active for this artifact",
      });
    };
    const { deps } = makeDeps(client);
    const result = await runRequestReview({ dir: "/repo", path: "notes.md", requireApproval: true }, deps);
    expect(result.exitCode).toBe(8);
    expect(result.error).toMatchObject({ code: "approval-conflict", kind: "conflict" });
  });

  test("unprovable approval uniqueness returns 500 -> exit 70 (internal) without leaking problem detail", async () => {
    const client = new FakeGlosaApiClient();
    client.createAttentionRequest = async () => {
      throw apiError(500, {
        type: "https://glosa.local/errors/approval-uniqueness-unprovable",
        title: "cannot prove this artifact has no open approval request",
        status: 500,
        detail: "inbox entry inb-sensitive could not be read; restore it, then retry",
        instance: "/api/workspaces/attention-request",
      });
    };
    const { deps } = makeDeps(client);
    const result = await runRequestReview({ dir: "/repo", path: "notes.md", requireApproval: true }, deps);

    expect(result.exitCode).toBe(70);
    expect(result.error).toEqual({
      code: "request-review-failed",
      kind: "internal",
      message: "cannot prove this artifact has no open approval request",
    });

    const json = JSON.parse(captureStdout(() => printRequestReviewResult(result, true)));
    expect(json).toMatchObject({
      glosa_json: 1,
      ok: false,
      command: "request-review",
      exit_code: 70,
      data: {},
      warnings: [],
      error: {
        code: "request-review-failed",
        kind: "internal",
        message: "cannot prove this artifact has no open approval request",
      },
    });
    expect(JSON.stringify(json)).not.toContain("inb-sensitive");
    expect(JSON.stringify(json)).not.toContain("/api/workspaces/attention-request");
  });

  test("--json envelope has exactly the documented top-level keys", async () => {
    const { deps } = makeDeps();
    const result = await runRequestReview({ dir: "/repo", path: "notes.md" }, deps);
    const out = captureStdout(() => printRequestReviewResult(result, true));
    const parsed = JSON.parse(out);
    expect(Object.keys(parsed).sort()).toEqual(
      ["command", "data", "error", "exit_code", "glosa_json", "ok", "warnings"].sort(),
    );
    expect(parsed).toMatchObject({ glosa_json: 1, ok: true, command: "request-review", exit_code: 0 });
  });
});

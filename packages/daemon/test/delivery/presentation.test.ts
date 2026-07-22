// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import {
  buildDeliveryPresentation,
  MAX_ENTRY_PRESENTATION_BYTES,
  utf8Bytes,
} from "../../src/delivery/presentation.ts";

function annotation(body: string) {
  return {
    kind: "annotation",
    artifact_path: "drafts/week.md",
    body,
    intent: "content",
    target: {
      chunk_id: "chunk-4",
      quote: { exact: "grace upon grace", prefix: "received ", suffix: " from him" },
      position: { start: 140, end: 156 },
    },
  };
}

describe("actionable inbox presentations", () => {
  test("annotation includes identity, path, comment, intent, selectors, and source-range resolution", () => {
    const result = buildDeliveryPresentation("inb-a", annotation("Make the connection explicit."), {
      status: "pending",
      resolution: {
        kind: "source_range",
        path: "drafts/week.md",
        start_line: 4,
        end_line: 4,
        start_col: 12,
        end_col: 28,
        matched_quote: "grace upon grace",
        confidence: "exact",
      },
    });
    expect(result).not.toBeNull();
    expect(result?.text).toContain("glosa annotation inb-a");
    expect(result?.text).toContain("artifact: drafts/week.md");
    expect(result?.text).toContain("Make the connection explicit.");
    expect(result?.text).toContain('intent: content');
    expect(result?.text).toContain('"exact":"grace upon grace"');
    expect(result?.text).toContain('"start":140');
    expect(result?.text).toContain('"kind":"source_range"');
  });

  test("annotation preserves pipeline-feedback and orphaned resolution detail", () => {
    const pipeline = buildDeliveryPresentation("inb-p", annotation("Check this output."), {
      status: "pending",
      resolution: {
        kind: "pipeline_feedback",
        target: { adapter: "pipeline", component: "chunk", chunk_id: "chunk-4", source_line_range: [4, 4] },
        intent: "content",
        body: "Check this output.",
      },
    });
    const orphaned = buildDeliveryPresentation("inb-o", annotation("The source moved."), {
      status: "pending",
      resolution: { kind: "orphaned", reason: "hash_mismatch_no_match" },
    });
    expect(pipeline?.text).toContain('"kind":"pipeline_feedback"');
    expect(orphaned?.text).toContain('"reason":"hash_mismatch_no_match"');
  });

  test("UTF-8 truncation is byte-exact and gives stable CLI/MCP continuation instructions", () => {
    const result = buildDeliveryPresentation("inb-u", annotation("żółć🙂".repeat(10_000)), { status: "pending" });
    expect(result).not.toBeNull();
    expect(utf8Bytes(result?.text ?? "")).toBeLessThanOrEqual(MAX_ENTRY_PRESENTATION_BYTES);
    expect(result?.truncation?.truncated).toBe(true);
    expect(result?.retrieval?.cursor).toBeString();
    expect(result?.text).toContain("glosa inbox get inb-u --cursor");
    expect(result?.text).toContain("MCP glosa_inbox_get");

    const next = buildDeliveryPresentation("inb-u", annotation("żółć🙂".repeat(10_000)), {
      status: "pending",
      cursor: result?.retrieval?.cursor,
    });
    expect(next?.detail?.body).not.toBe(result?.detail?.body);
  });

  test("human edit includes checkpoints and only complete bounded hunks, never artifact bodies", () => {
    const secretFullBody = "FULL_ARTIFACT_BODY_MUST_NOT_APPEAR";
    const hunks = Array.from(
      { length: 80 },
      (_, i) => `@@ -${i + 1},1 +${i + 1},1 @@\n-old ${i}\n+new ${i} ${"ą".repeat(400)}\n`,
    ).join("");
    const result = buildDeliveryPresentation(
      "inb-edit",
      {
        kind: "human_edit",
        checkpoint_before: "abc123",
        checkpoint_after: "def456",
        artifact_body: secretFullBody,
        files: [{ path: "notes.md", diff: `diff --git a/notes.md b/notes.md\n--- a/notes.md\n+++ b/notes.md\n${hunks}` }],
      },
      { status: "pending" },
    );
    expect(result?.text).toContain("checkpoints: abc123..def456");
    expect(result?.text).toContain("file: notes.md");
    expect(result?.text).not.toContain(secretFullBody);
    expect(utf8Bytes(result?.text ?? "")).toBeLessThanOrEqual(MAX_ENTRY_PRESENTATION_BYTES);
    expect(result?.truncation?.omitted_hunks).toBeGreaterThan(0);
    expect(((result?.text ?? "").match(/^@@ /gm) ?? []).length).toBe((result?.detail?.files as unknown[]).length);
  });
});

// SPDX-License-Identifier: Apache-2.0
// R9's approval-mode uniqueness rule ("at most one non-terminal approval request may exist for
// that workspace/path") is enforced inside the same mutex critical section as creation. New
// entries mirror the minimum immutable approval facts into journal-derived state; legacy journal
// events without that additive detail still fall back to their immutable inbox payloads.
import { describe, expect, test } from "bun:test";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { ApprovalConflictError, WorkspaceBus } from "../../src/bus/bus.ts";
import { writeInboxEntryOnce } from "../../src/bus/inbox.ts";
import { appendEvent, JournalWriter } from "../../src/bus/journal.ts";
import { inboxEntryPath, journalPath } from "../../src/bus/paths.ts";
import { cleanupWorkspace, deterministicClock, deterministicUlid, freshWorkspace } from "./helpers.ts";

function openBus(root: string, seed = 0): WorkspaceBus {
  return new WorkspaceBus(root, { ulid: deterministicUlid(seed), now: deterministicClock(seed) });
}

function approval(targetPath: string) {
  return {
    kind: "attention_request" as const,
    action: "review",
    target_path: targetPath,
    approval_mode: true as const,
  };
}

function seedLegacyEntry(root: string, id: string, payload: unknown): void {
  writeInboxEntryOnce(root, id, payload);
  const writer = new JournalWriter(journalPath(root));
  appendEvent(writer, {
    v: 1,
    event_id: `legacy-${id}`,
    at: new Date(0).toISOString(),
    entry: id,
    event: "entry_created",
    by: "daemon",
    detail: { kind: (payload as { kind?: unknown }).kind },
  });
  writer.close();
}

async function capture(promise: Promise<unknown>): Promise<{ code?: string; name?: string } | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err) {
    return err as { code?: string; name?: string };
  }
}

describe("approval-mode uniqueness — unreadable entries fail closed (R9, A4 §F04)", () => {
  test("a new approval is proven from journal truth and remains a real conflict when its inbox is unreadable", async () => {
    const root = freshWorkspace();
    const bus = openBus(root);
    await bus.createAttentionRequest("a1", approval("notes.md"));
    writeFileSync(inboxEntryPath(root, "a1"), '{"kind":"attention_requ');

    const err = await capture(bus.createAttentionRequest("a2", approval("notes.md")));
    expect(err).toBeInstanceOf(ApprovalConflictError);
    expect(bus.state.entries.a2).toBeUndefined();
    const created = JSON.parse(readFileSync(journalPath(root), "utf8").trim().split("\n")[0]!);
    expect(created.detail).toMatchObject({
      kind: "attention_request",
      target_path: "notes.md",
      approval_mode: true,
    });
    await bus.close();
    cleanupWorkspace(root);
  });

  test("journal-derived approval facts survive restart and rule out non-approvals and other targets", async () => {
    const root = freshWorkspace();
    const bus = openBus(root);
    await bus.createAttentionRequest("plain", { kind: "attention_request", action: "review" });
    await bus.createAttentionRequest("other", approval("other.md"));
    writeFileSync(inboxEntryPath(root, "plain"), "{");
    writeFileSync(inboxEntryPath(root, "other"), "{");
    await bus.close();

    const restarted = openBus(root, 1_000_000);
    await restarted.reconcile();
    expect(restarted.state.entries.plain).toMatchObject({ approval_mode: false });
    expect(restarted.state.entries.other).toMatchObject({ approval_mode: true, target_path: "other.md" });

    await restarted.createAttentionRequest("wanted", approval("notes.md"));
    expect(restarted.state.entries.wanted?.status).toBe("open");
    await restarted.close();
    cleanupWorkspace(root);
  });

  test("a legacy approval without mirrored metadata still falls back to its readable inbox", async () => {
    const root = freshWorkspace();
    seedLegacyEntry(root, "a1", approval("notes.md"));
    const bus = openBus(root);
    await bus.reconcile();

    const err = await capture(bus.createAttentionRequest("a2", approval("notes.md")));
    expect(err).toBeInstanceOf(ApprovalConflictError);
    await bus.close();
    cleanupWorkspace(root);
  });

  test("a legacy approval without mirrored metadata fails closed when its inbox is truncated", async () => {
    const root = freshWorkspace();
    seedLegacyEntry(root, "a1", approval("notes.md"));
    writeFileSync(inboxEntryPath(root, "a1"), '{"kind":"attention_requ');
    const bus = openBus(root);
    await bus.reconcile();

    const err = await capture(bus.createAttentionRequest("a2", approval("notes.md")));
    expect(err?.code).toBe("APPROVAL_UNIQUENESS_UNPROVABLE");
    expect(bus.state.entries.a2).toBeUndefined();
    await bus.close();
    cleanupWorkspace(root);
  });

  test("a missing legacy inbox file blocks a second approval", async () => {
    const root = freshWorkspace();
    seedLegacyEntry(root, "a1", approval("notes.md"));
    unlinkSync(inboxEntryPath(root, "a1"));
    const bus = openBus(root);
    await bus.reconcile();

    const err = await capture(bus.createAttentionRequest("a2", approval("notes.md")));
    expect(err?.code).toBe("APPROVAL_UNIQUENESS_UNPROVABLE");
    expect(bus.state.entries.a2).toBeUndefined();
    await bus.close();
    cleanupWorkspace(root);
  });

  test("a legacy body that parses but is not an inbox payload object blocks a second approval", async () => {
    const root = freshWorkspace();
    seedLegacyEntry(root, "a1", approval("notes.md"));
    writeFileSync(inboxEntryPath(root, "a1"), '"attention_request"');
    const bus = openBus(root);
    await bus.reconcile();

    const err = await capture(bus.createAttentionRequest("a2", approval("notes.md")));
    expect(err?.code).toBe("APPROVAL_UNIQUENESS_UNPROVABLE");
    await bus.close();
    cleanupWorkspace(root);
  });

  test("the unprovable error names the entry that could not be read and the contested target", async () => {
    const root = freshWorkspace();
    seedLegacyEntry(root, "a1", approval("notes.md"));
    writeFileSync(inboxEntryPath(root, "a1"), "not json at all");
    const bus = openBus(root);
    await bus.reconcile();

    const err = (await capture(bus.createAttentionRequest("a2", approval("notes.md")))) as
      | { targetPath?: string; entries?: string[]; message?: string }
      | undefined;
    expect(err?.targetPath).toBe("notes.md");
    expect(err?.entries).toEqual(["a1"]);
    expect(err?.message).toContain("a1");
    await bus.close();
    cleanupWorkspace(root);
  });

  test("every unreadable candidate is reported at once, not one restart at a time", async () => {
    const root = freshWorkspace();
    seedLegacyEntry(root, "a1", approval("notes.md"));
    seedLegacyEntry(root, "a2", { kind: "attention_request", action: "review" });
    writeFileSync(inboxEntryPath(root, "a1"), "{");
    writeFileSync(inboxEntryPath(root, "a2"), "{");
    const bus = openBus(root);
    await bus.reconcile();

    const err = (await capture(bus.createAttentionRequest("a3", approval("notes.md")))) as
      | { entries?: string[] }
      | undefined;
    expect(err?.entries).toEqual(["a1", "a2"]);
    await bus.close();
    cleanupWorkspace(root);
  });

  test("a PROVEN conflict outranks an unreadable sibling — never downgrade a fact to a maybe", async () => {
    const root = freshWorkspace();
    seedLegacyEntry(root, "unreadable", approval("other.md"));
    seedLegacyEntry(root, "zz-live", approval("notes.md"));
    writeFileSync(inboxEntryPath(root, "unreadable"), "{");
    const bus = openBus(root);
    await bus.reconcile();

    const err = await capture(bus.createAttentionRequest("a3", approval("notes.md")));
    expect(err).toBeInstanceOf(ApprovalConflictError);
    await bus.close();
    cleanupWorkspace(root);
  });

  test("an unreadable TERMINAL attention entry is not a candidate and blocks nothing", async () => {
    const root = freshWorkspace();
    const bus = openBus(root);
    await bus.createAttentionRequest("a1", approval("notes.md"));
    await bus.commitTransition("a1", "expired");
    writeFileSync(inboxEntryPath(root, "a1"), "{");

    await bus.createAttentionRequest("a2", approval("notes.md"));
    expect(bus.state.entries.a2?.status).toBe("open");
    await bus.close();
    cleanupWorkspace(root);
  });

  test("an unreadable NON-attention entry is not a candidate and blocks nothing", async () => {
    const root = freshWorkspace();
    const bus = openBus(root);
    await bus.createEntry("h1", { kind: "human_edit" });
    writeFileSync(inboxEntryPath(root, "h1"), "{");

    await bus.createAttentionRequest("a1", approval("notes.md"));
    expect(bus.state.entries.a1?.status).toBe("open");
    await bus.close();
    cleanupWorkspace(root);
  });

  test("a plain (non-approval) attention request never scans, so corruption cannot block it", async () => {
    const root = freshWorkspace();
    const bus = openBus(root);
    await bus.createAttentionRequest("a1", approval("notes.md"));
    writeFileSync(inboxEntryPath(root, "a1"), "{");

    await bus.createAttentionRequest("a2", { kind: "attention_request", action: "review" });
    expect(bus.state.entries.a2?.status).toBe("open");
    await bus.close();
    cleanupWorkspace(root);
  });

  test("a readable non-approval sibling is positively ruled out, not treated as unprovable", async () => {
    const root = freshWorkspace();
    const bus = openBus(root);
    await bus.createAttentionRequest("a1", { kind: "attention_request", action: "review", path: "notes.md" });

    await bus.createAttentionRequest("a2", approval("notes.md"));
    expect(bus.state.entries.a2?.status).toBe("open");
    await bus.close();
    cleanupWorkspace(root);
  });
});

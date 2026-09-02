// SPDX-License-Identifier: Apache-2.0
// R9's approval-mode uniqueness rule ("at most one non-terminal approval request may exist for
// that workspace/path") is enforced by a scan over the non-terminal attention entries inside the
// same mutex critical section as the write. The scan reads each candidate's IMMUTABLE inbox file
// (A4 §F04) because `target_path`/`approval_mode` live in the payload, not in the journal event.
//
// These tests pin the FAILURE MODE of that read. A read that cannot be completed proves nothing,
// and "proves nothing" must not be spelled "not a match" — that would let a single corrupt,
// truncated or unreadable entry file silently defeat the very invariant the block exists to keep.
// They also pin the converse: a scan that cannot prove a conflict must not claim one, and must
// not fail closed on entries it can positively rule out.
import { describe, expect, test } from "bun:test";
import { unlinkSync, writeFileSync } from "node:fs";
import { ApprovalConflictError, WorkspaceBus } from "../../src/bus/bus.ts";
import { inboxEntryPath } from "../../src/bus/paths.ts";
import { cleanupWorkspace, deterministicClock, deterministicUlid, freshWorkspace } from "./helpers.ts";

function openBus(root: string): WorkspaceBus {
  return new WorkspaceBus(root, { ulid: deterministicUlid(), now: deterministicClock() });
}

function approval(targetPath: string) {
  return { kind: "attention_request" as const, action: "review", target_path: targetPath, approval_mode: true as const };
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
  test("a truncated inbox body blocks a second approval instead of being read as 'not a match'", async () => {
    const root = freshWorkspace();
    const bus = openBus(root);
    await bus.createAttentionRequest("a1", approval("notes.md"));

    // A crash mid-write, a partial page, a torn body: the journal still says a1 is a live
    // attention entry, but its payload can no longer be parsed.
    writeFileSync(inboxEntryPath(root, "a1"), '{"kind":"attention_requ');

    const err = await capture(bus.createAttentionRequest("a2", approval("notes.md")));
    expect(err?.code).toBe("APPROVAL_UNIQUENESS_UNPROVABLE");
    expect(bus.state.entries.a2).toBeUndefined();
    await bus.close();
    cleanupWorkspace(root);
  });

  test("a missing inbox file blocks a second approval", async () => {
    const root = freshWorkspace();
    const bus = openBus(root);
    await bus.createAttentionRequest("a1", approval("notes.md"));
    unlinkSync(inboxEntryPath(root, "a1"));

    const err = await capture(bus.createAttentionRequest("a2", approval("notes.md")));
    expect(err?.code).toBe("APPROVAL_UNIQUENESS_UNPROVABLE");
    expect(bus.state.entries.a2).toBeUndefined();
    await bus.close();
    cleanupWorkspace(root);
  });

  test("a body that parses but is not an inbox payload object blocks a second approval", async () => {
    const root = freshWorkspace();
    const bus = openBus(root);
    await bus.createAttentionRequest("a1", approval("notes.md"));
    writeFileSync(inboxEntryPath(root, "a1"), '"attention_request"');

    const err = await capture(bus.createAttentionRequest("a2", approval("notes.md")));
    expect(err?.code).toBe("APPROVAL_UNIQUENESS_UNPROVABLE");
    await bus.close();
    cleanupWorkspace(root);
  });

  test("the unprovable error names the entry that could not be read and the contested target", async () => {
    const root = freshWorkspace();
    const bus = openBus(root);
    await bus.createAttentionRequest("a1", approval("notes.md"));
    writeFileSync(inboxEntryPath(root, "a1"), "not json at all");

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
    const bus = openBus(root);
    await bus.createAttentionRequest("a1", approval("notes.md"));
    await bus.createAttentionRequest("a2", { kind: "attention_request", action: "review" });
    writeFileSync(inboxEntryPath(root, "a1"), "{");
    writeFileSync(inboxEntryPath(root, "a2"), "{");

    const err = (await capture(bus.createAttentionRequest("a3", approval("notes.md")))) as
      | { entries?: string[] }
      | undefined;
    expect(err?.entries).toEqual(["a1", "a2"]);
    await bus.close();
    cleanupWorkspace(root);
  });

  test("a PROVEN conflict outranks an unreadable sibling — never downgrade a fact to a maybe", async () => {
    const root = freshWorkspace();
    const bus = openBus(root);
    // `unreadable` sorts before `zz-live` in the scan, so the proven match is found second: the
    // scan must finish before it decides, or the weaker verdict would win by accident of order.
    await bus.createAttentionRequest("unreadable", approval("other.md"));
    await bus.createAttentionRequest("zz-live", approval("notes.md"));
    writeFileSync(inboxEntryPath(root, "unreadable"), "{");

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

// SPDX-License-Identifier: Apache-2.0
// `external_edit` — the honest kind for a change glosa cannot attribute (#144, #153 Part 1).
//
// The defect these cover: offline catch-up always committed drift honestly (`auto_checkpoint`,
// `Glosa-Attribution: unknown`) and then handed the hunks to delivery, which stamps
// `kind:"human_edit"` on whatever it is given. A4 §F05 is explicit — everything outside a lease or
// the glosa editor API is `unknown`, "never falsely human".
//
// Contract criteria exercised here: A1 (the kind and its trailer), A2 (#144's reproduction),
// A3's delivery-eligibility fold, A3b's GC half, A5 (glosa's own writes), and the structural fact
// standing in for an attention ablation.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorkspaceBus } from "../../src/bus/bus.ts";
import { EXTERNAL_EDIT_KIND, isExternalEditEntry } from "../../src/bus/external-edit.ts";
import { readInboxEntry } from "../../src/bus/inbox.ts";
import { type DeliveryAttemptRecord, isTerminal } from "../../src/bus/lifecycle.ts";
import { badgePendingCount, peekJournal, retentionPendingCount } from "../../src/bus/peek.ts";
import { journalPath } from "../../src/bus/paths.ts";
import { reconcileWorkspace } from "../../src/bus/reconcile.ts";
import { workspaceRegistrationId } from "../../src/workspace.ts";
import { buildDeliveryPresentation, MAX_DELIVERY_ENTRIES } from "../../src/delivery/presentation.ts";
import { runGit } from "../../src/git/shadow.ts";
import { WorkspaceIndex } from "../../src/registry/workspace-index.ts";
import { waitForWatch } from "../../src/services/watch.ts";
import {
  claimTestDaemonIdentity,
  cleanupWorkspace,
  deterministicClock,
  deterministicUlid,
  dropDaemonIdentity,
  freshWorkspace,
  writeFile,
} from "../git/helpers.ts";
import { cleanup, freshHome, freshWorkspaceDir, manualClock } from "../registry/helpers.ts";

const roots: string[] = [];

function workspace(): string {
  const root = freshWorkspace();
  roots.push(root);
  claimTestDaemonIdentity(root);
  return root;
}

/** A deterministic id/clock pair that is distinct for every simulated process. `deterministicUlid`
 * restarts from the same seed on every call, so reusing it across a "restart" mints event ids the
 * journal already contains — and `applyEvent`'s duplicate-`event_id` dedup then silently drops the
 * replacement, which looks exactly like the behaviour under test failing or passing for the wrong
 * reason. Production ULIDs are monotonic across restarts; these must be too. */
let epoch = 1_700_000_000_000;
function freshProcess(): { ulid: ReturnType<typeof deterministicUlid>; now: () => Date } {
  epoch += 1_000_000;
  return { ulid: deterministicUlid(epoch), now: deterministicClock(epoch) };
}

function openBus(root: string): WorkspaceBus {
  return new WorkspaceBus(root, freshProcess());
}

/** One reconcile pass, standing in for one daemon start. */
function restart(root: string) {
  return reconcileWorkspace(root, freshProcess());
}

/** Every non-terminal entry with its immutable payload, so a test can count kinds rather than
 * trusting one lookup. Reads the journal fold, which is the authority (A4 §F04). */
function entriesOf(bus: WorkspaceBus): Array<{ id: string; payload: Record<string, unknown> }> {
  return Object.entries(bus.state.entries).map(([id]) => ({
    id,
    payload: (readInboxEntry(bus.workspace, id) ?? {}) as Record<string, unknown>,
  }));
}

function kindsOf(bus: WorkspaceBus): string[] {
  return entriesOf(bus)
    .map((entry) => entry.payload.kind)
    .filter((kind): kind is string => typeof kind === "string")
    .sort();
}

async function trailer(root: string, sha: string, key: string): Promise<string> {
  const result = await runGit(root, ["show", "-s", `--format=%(trailers:key=${key},valueonly)`, sha]);
  return result.stdout.trim();
}

afterEach(() => {
  dropDaemonIdentity();
  for (const root of roots.splice(0)) cleanupWorkspace(root);
});

describe("A1 — the kind exists and is honest", () => {
  test("a live capture writes kind/path/since/until/observed_at/source and commits an `unknown` trailer", async () => {
    const root = workspace();
    writeFile(root, "notes.md", "one\n");
    const bus = openBus(root);
    await bus.reconcile(); // establishes the baseline checkpoint, as daemon startup does

    writeFileSync(join(root, "notes.md"), "one\ntwo\n");
    const captured = await bus.captureExternalEdit();

    expect(captured.committed).toBe(true);
    expect(captured.suppressed).toBeNull();
    expect(captured.entries).toHaveLength(1);

    const payload = readInboxEntry(root, captured.entries[0]!) as Record<string, unknown>;
    expect(payload.kind).toBe(EXTERNAL_EDIT_KIND);
    expect(payload.path).toBe("notes.md");
    expect(payload.source).toBe("live");
    expect(typeof payload.since_checkpoint).toBe("string");
    expect(typeof payload.until_checkpoint).toBe("string");
    expect(typeof payload.observed_at).toBe("string");
    expect(payload.since_checkpoint).not.toBe(payload.until_checkpoint);
    expect(String(payload.diff)).toContain("+two");
    // Decision 2: one entry per artifact, singular `path`. A `files[]` array would falsify A1.
    expect("files" in payload).toBe(false);

    // A4 §F05's storage half, which was never the broken part and must stay unbroken.
    expect(await trailer(root, String(payload.until_checkpoint), "Glosa-Attribution")).toBe("unknown");
    await bus.close();
  });

  test("its derived kind is `common`, never `attention` — which is why no attention fold needs an exclusion", async () => {
    const root = workspace();
    writeFile(root, "notes.md", "one\n");
    const bus = openBus(root);
    await bus.reconcile();
    writeFileSync(join(root, "notes.md"), "one\ntwo\n");
    const captured = await bus.captureExternalEdit();

    // Every attention fold in the daemon filters `entry.kind === "attention"`
    // (bus.ts:768, peek.ts:79-81, http.ts:1514/1597/1992). This is the fact that makes all of them
    // exclude an `external_edit` with no exclusion code and nothing to ablate — asserted once,
    // here, rather than with an assertion that could not fail.
    const entry = bus.state.entries[captured.entries[0]!]!;
    expect(entry.kind).toBe("common");
    expect(entry.kind).not.toBe("attention");
    // ...and `dismissed` really does terminate it, so the promise that a person can close one is
    // not decorative.
    expect(isTerminal("common", "dismissed")).toBe(true);
    await bus.commitTransition(captured.entries[0]!, "dismissed", { by: "human" });
    expect(bus.state.entries[captured.entries[0]!]?.status).toBe("dismissed");
    await bus.close();
  });
});

describe("A2 — offline catch-up stops lying (#144's reproduction)", () => {
  test("a restart over drift yields one external_edit per artifact, source offline_catchup, and zero human_edit", async () => {
    const root = workspace();
    writeFile(root, "a.md", "a1\n");
    writeFile(root, "b.md", "b1\n");
    const before = openBus(root);
    await before.reconcile(); // baseline while the daemon is up
    await before.close();

    // The daemon is down. A person edits both artifacts in their own editor.
    writeFileSync(join(root, "a.md"), "a1\na2\n");
    writeFileSync(join(root, "b.md"), "b1\nb2\n");

    const result = await restart(root);
    expect(result.offlineCatchup.occurred).toBe(true);
    expect(result.externalEditIds).toHaveLength(2);

    const after = openBus(root);
    await after.reconcile();
    const entries = entriesOf(after);
    expect(kindsOf(after)).toEqual([EXTERNAL_EDIT_KIND, EXTERNAL_EDIT_KIND]);
    expect(entries.map((e) => e.payload.path).sort()).toEqual(["a.md", "b.md"]);
    expect(entries.every((e) => e.payload.source === "offline_catchup")).toBe(true);

    // The presentation an agent would see: it names the kind honestly. This is the exact surface
    // that used to say `human_edit` — `presentation.ts` branches on the payload's kind, and drift
    // had no kind of its own until now.
    const presentations = entries.map((e) => buildDeliveryPresentation(e.id, e.payload, { status: "pending" }));
    expect(presentations.map((p) => p?.kind)).toEqual([EXTERNAL_EDIT_KIND, EXTERNAL_EDIT_KIND]);
    expect(presentations.every((p) => !p?.text.includes("human_edit"))).toBe(true);
    await after.close();
  });

  test("a second reconcile over the same drift adds nothing — the scan is idempotent", async () => {
    const root = workspace();
    writeFile(root, "a.md", "a1\n");
    const first = openBus(root);
    await first.reconcile();
    await first.close();

    writeFileSync(join(root, "a.md"), "a1\na2\n");
    const one = await restart(root);
    expect(one.externalEditIds).toHaveLength(1);

    const two = await restart(root);
    expect(two.externalEditIds).toEqual([]);
    expect(Object.keys(two.state.entries)).toHaveLength(1);
  });
});

describe("A3 — delivery eligibility excludes it (its own fold, its own assertion)", () => {
  test("no ORDINARY delivery path offers an external_edit (a watch is the one opt-in exception, #153 Part 2), while a sibling annotation is still offered", async () => {
    const root = workspace();
    writeFile(root, "notes.md", "one\n");
    const bus = openBus(root);
    await bus.reconcile();
    await bus.createEntry("ann-1", {
      kind: "annotation",
      artifact_path: "notes.md",
      body: "please rephrase",
      intent: "content",
      target: { quote: { exact: "one" } },
    });

    writeFileSync(join(root, "notes.md"), "one\ntwo\n");
    const captured = await bus.captureExternalEdit();
    expect(captured.entries).toHaveLength(1);
    const externalId = captured.entries[0]!;

    const build = (id: string, payload: unknown, status: string) => buildDeliveryPresentation(id, payload, { status });

    // `eligibleDeliveryEntriesLocked` is the single gate feeding BOTH of these (A5 §F23), so both
    // are checked rather than one standing in for the other.
    const planned = await bus.previewDelivery(8, { session: "s1" }, build);
    const prepared = await bus.prepareDelivery(8, { via: "mcp_pull", session: "s1" }, build);

    expect(planned.entries.map((e) => e.id)).toEqual(["ann-1"]);
    expect(prepared.drained.map((e) => e.id)).toEqual(["ann-1"]);
    expect(planned.entries.some((e) => e.id === externalId)).toBe(false);
    expect(prepared.drained.some((e) => e.id === externalId)).toBe(false);

    // Excluded BEFORE presentation, not failed during it: a `delivery_attempt` here would mean the
    // drain tried and failed on every pass for an entry never meant to be offered.
    expect(bus.state.entries[externalId]?.deliveryAttempts).toEqual([]);
    await bus.close();
  });
});

describe("A3b — retention-facing counting survives the exclusion", () => {
  test("the two counts disagree by exactly the external_edit: invisible to the badge, visible to retention", async () => {
    const root = workspace();
    writeFile(root, "notes.md", "one\n");
    const bus = openBus(root);
    await bus.reconcile();
    writeFileSync(join(root, "notes.md"), "one\ntwo\n");
    const captured = await bus.captureExternalEdit();
    expect(captured.entries).toHaveLength(1);
    await bus.close();

    const state = peekJournal(root).state;
    expect(badgePendingCount(state)).toBe(0);
    expect(retentionPendingCount(state)).toBe(1);
  });

  test("GC's hard-remove guard still reads it as parked work (pins the guard; gc() has no production caller today)", async () => {
    // NOT a live path: `WorkspaceIndex.gc()` is called by no shipping code right now, so this pins
    // the guard's behaviour rather than observing a running system. Said here, in the test name,
    // instead of letting a green tick imply more than it proves.
    const home = freshHome();
    const dir = freshWorkspaceDir();
    const clock = manualClock();
    const existing = new Set([dir]);
    const index = new WorkspaceIndex({
      home,
      now: clock,
      gcGraceMs: 100,
      gcThrottleMs: 0,
      pathExists: (p) => existing.has(p),
      hasLiveSession: () => false,
    });
    const entry = await index.upsertWorkspace(dir, "glosa-open");

    // The workspace's only outstanding item is an undismissed `external_edit`.
    mkdirSync(entry.bus_path, { recursive: true });
    const created = JSON.stringify({
      v: 1,
      event_id: "01TESTEVENT0000000000000010",
      at: "2026-09-11T00:00:00.000Z",
      entry: "inb-external-1",
      event: "entry_created",
      by: "watcher",
      detail: { kind: EXTERNAL_EDIT_KIND, payload_kind: EXTERNAL_EDIT_KIND },
    });
    writeFileSync(join(entry.bus_path, "journal.ndjson"), `${created}\n`);

    existing.delete(entry.canonical_path);
    await index.gc({ force: true }); // softens
    clock.advance(10_000); // well past grace
    const result = await index.gc({ force: true });

    expect(result.removed).toEqual([]);
    expect(index.get(entry.canonical_path)).not.toBeNull();

    // The same entry dismissed stops blocking, which proves the guard is reading THIS entry's
    // status rather than refusing to remove anything at all.
    const dismissed = JSON.stringify({
      v: 1,
      event_id: "01TESTEVENT0000000000000011",
      at: "2026-09-11T00:01:00.000Z",
      entry: "inb-external-1",
      event: "transition_committed",
      by: "human",
      detail: { to: "dismissed" },
    });
    writeFileSync(join(entry.bus_path, "journal.ndjson"), `${created}\n${dismissed}\n`);
    const afterDismiss = await index.gc({ force: true });
    expect(afterDismiss.removed).toEqual([entry.canonical_path]);

    cleanup(home);
    cleanup(dir);
  });
});

describe("A5 — glosa's own writes never come back as external", () => {
  test("under a held apply lease the capture defers entirely, and the lease still proves session attribution", async () => {
    const root = workspace();
    writeFile(root, "notes.md", "one\n");
    const bus = openBus(root);
    await bus.reconcile();
    await bus.createEntry("ann-1", { kind: "annotation", artifact_path: "notes.md", body: "b", intent: "content" });
    const lease = await bus.applyBegin("ann-1", "sess-1");

    // A save-burst lands while the session is mid-apply.
    writeFileSync(join(root, "notes.md"), "one\nsession wrote this\n");
    const captured = await bus.captureExternalEdit();

    expect(captured.suppressed).toBe("apply_lease");
    expect(captured.entries).toEqual([]);
    expect(kindsOf(bus)).toEqual(["annotation"]);

    // NO commit either. This is the half that has to be observed rather than reasoned about: an
    // earlier revision did commit here (following A4 §F05's "save-burst checkpoints during a lease
    // still commit"), and because `checkpoint()` is idempotent that commit BECAME `resolveEntry`'s
    // `post_sha` — leaving the journal claiming `session:sess-1` for a commit whose trailer read
    // `unknown`. The assertion below is what caught it, and is why this producer defers completely.
    expect(captured.committed).toBe(false);

    const resolved = await bus.resolveEntry("ann-1", "applied", "sess-1");
    expect(await trailer(root, resolved.postSha, "Glosa-Attribution")).toBe("session:sess-1");
    expect(lease.preSha).not.toBe(resolved.postSha);

    // Nor may the lease's own commits come back through the recovery scan on the next start:
    // `pre_apply`/`post_apply` are not `auto_checkpoint`, so the scan does not collect them.
    await bus.close();
    const restarted = await restart(root);
    expect(restarted.externalEditIds).toEqual([]);
  });

  test("a glosa editor save produces human_edit and no external_edit", async () => {
    const root = workspace();
    writeFile(root, "notes.md", "one\n");
    const bus = openBus(root);
    await bus.reconcile();

    await bus.captureHumanEdit("edit-1", "notes.md", () => {
      writeFileSync(join(root, "notes.md"), "one\nreviewer typed this\n");
    });
    // The watcher's window fires right after, as it would in production: the editor save already
    // committed under the same mutex, so there is nothing left to stage.
    const captured = await bus.captureExternalEdit();

    expect(captured.committed).toBe(false);
    expect(captured.entries).toEqual([]);
    expect(kindsOf(bus)).toEqual(["human_edit"]);
    await bus.close();
  });
});

describe("#182 R5 — captureHumanEdit's own honest pre-save boundary", () => {
  test("ONE artifact, two blocks: disk changes block B, then a Keep-mine-style save carries B through while only editing block A — the external entry names B, the human entry names A and not B", async () => {
    // R5's whole reason to exist is a SAME-FILE contamination: a Keep-mine save's own WRITE
    // legitimately carries disk's block B bytes into its content (that is what the merge does),
    // so a naive `before`/`after` diff over that one file would show BOTH blocks as "what the
    // human changed" unless the drift is checkpointed first. Two separate files could never show
    // this — `captureHumanEdit`'s checkpoint is already scoped to `paths:[path]`, so a change to
    // a DIFFERENT file could never reach THIS file's diff regardless of pre-capture, which is
    // exactly why an earlier version of this test (two files, a.md/b.md) could not observe the
    // defect it claimed to guard: its ablation went red because the external_edit entry vanished,
    // not because disk bytes actually leaked into the human diff.
    const root = workspace();
    writeFile(root, "doc.md", "Block A original.\n\nBlock B original.\n");
    const bus = openBus(root);
    await bus.reconcile();

    // B changes on disk — nothing glosa did, and the watcher's quiet window hasn't fired yet.
    writeFileSync(join(root, "doc.md"), "Block A original.\n\nBlock B changed on disk.\n");

    // The Keep-mine-style save: its OWN write already carries B's disk bytes through (exactly
    // what a real three-way merge produces), while only A is the writer's own edit. Without R5's
    // pre-capture, `before` predates B's drift, so the diff this commits would show BOTH blocks
    // as human-attributed. With it, B's drift is checkpointed `unknown` first, and the diff this
    // commits shows only A.
    await bus.captureHumanEdit("edit-a", "doc.md", () => {
      writeFileSync(join(root, "doc.md"), "Block A EDITED BY WRITER.\n\nBlock B changed on disk.\n");
    });

    // Checked FIRST, and independent of whether the external entry exists at all: the ablation
    // this test guards against (no pre-capture) still produces a `human_edit` — it is what THAT
    // entry's own diff contains which must go red, not merely whether a sibling entry was made.
    const entries = entriesOf(bus);
    const humanEdit = entries.find((entry) => entry.payload.kind === "human_edit")!;
    const files = humanEdit.payload.files as Array<{ path: string; diff: string }>;
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe("doc.md");
    expect(files[0]!.diff).toContain("+Block A EDITED BY WRITER.");
    // THE ASSERTION THE WHOLE MECHANISM EXISTS FOR: B's disk-only bytes appear in this diff only
    // as bare, unmarked CONTEXT (proving `before` already had them, checkpointed ahead of the
    // human write) — never with a `+`/`-` change marker, which is what the ablation flips.
    expect(files[0]!.diff).not.toMatch(/^[+-]Block B changed on disk\.$/m);
    expect(files[0]!.diff).toContain("\n Block B changed on disk.\n");
    expect(await trailer(root, humanEdit.payload.checkpoint_after as string, "Glosa-Attribution")).toBe("human");

    // Only now the sibling entry: the drift got its own honest, separately-attributed record.
    expect(kindsOf(bus)).toEqual([EXTERNAL_EDIT_KIND, "human_edit"].sort());
    const externalEdit = entries.find((entry) => entry.payload.kind === EXTERNAL_EDIT_KIND)!;
    expect(externalEdit.payload.path).toBe("doc.md");
    expect(String(externalEdit.payload.diff)).toContain("+Block B changed on disk.");
    expect(String(externalEdit.payload.diff)).not.toContain("EDITED BY WRITER");
    expect(externalEdit.payload.source).toBe("live");

    // The watcher's own quiet window, right after, finds nothing left uncaptured.
    const watcher = await bus.captureExternalEdit();
    expect(watcher.committed).toBe(false);
    await bus.close();
  });

  test("no drift under an active apply lease — unchanged behaviour, still human, still no refusal", async () => {
    const root = workspace();
    writeFile(root, "notes.md", "one\n");
    const bus = openBus(root);
    await bus.reconcile();
    await bus.createEntry("ann-1", { kind: "annotation", artifact_path: "notes.md", body: "b", intent: "content" });
    await bus.applyBegin("ann-1", "sess-1");

    await bus.captureHumanEdit("edit-1", "notes.md", () => {
      writeFileSync(join(root, "notes.md"), "one\nreviewer typed this\n");
    });

    expect(kindsOf(bus)).toEqual(["annotation", "human_edit"]);
    await bus.close();
  });

  test("drift on the exact path under an active apply lease is refused, not attributed to the human", async () => {
    const root = workspace();
    writeFile(root, "notes.md", "one\n");
    const bus = openBus(root);
    await bus.reconcile();
    await bus.createEntry("ann-1", { kind: "annotation", artifact_path: "notes.md", body: "b", intent: "content" });
    await bus.applyBegin("ann-1", "sess-1");

    // Drift on THIS path while the lease is held — that interval belongs to the lease's own
    // resolveEntry, not to a save that happens to arrive while it is open.
    writeFileSync(join(root, "notes.md"), "one\nsomething changed under the lease\n");

    await expect(
      bus.captureHumanEdit("edit-1", "notes.md", () => {
        writeFileSync(join(root, "notes.md"), "one\nreviewer typed this\n");
      }),
    ).rejects.toMatchObject({ code: "DRIFT_UNDER_LEASE" });

    // Refused, not written: the file still carries the drift, no human_edit exists, and the
    // drift itself was never folded into a false `human` attribution.
    expect(readFileSync(join(root, "notes.md"), "utf8")).toBe("one\nsomething changed under the lease\n");
    expect(kindsOf(bus)).toEqual(["annotation"]);
    await bus.close();
  });
});

describe("A7 — the checkpoint -> entry gap is recoverable", () => {
  test("the scan reads real Glosa-Kind trailers: a human_edit commit in the same unreported range is not swept up", async () => {
    // The recovery walks a commit RANGE, so everything glosa itself committed in that range is in
    // front of it and only the trailer tells them apart. This puts both kinds in one range on
    // purpose — a parse that mis-framed the trailer field, or a filter that matched loosely, would
    // report the reviewer's own edit back to them as an external one.
    const root = workspace();
    writeFile(root, "notes.md", "one\n");
    const bus = openBus(root);
    await bus.reconcile();

    await bus.captureHumanEdit("edit-1", "notes.md", () => {
      writeFileSync(join(root, "notes.md"), "one\nreviewer typed this\n");
    });
    writeFileSync(join(root, "notes.md"), "one\nreviewer typed this\nsomething else did this\n");
    const { checkpoint } = await import("../../src/git/shadow.ts");
    const drift = await checkpoint(root, { attribution: "unknown", kind: "auto_checkpoint" });
    await bus.close();

    const restarted = await restart(root);
    expect(restarted.externalEditIds).toHaveLength(1);
    const recovered = readInboxEntry(root, restarted.externalEditIds[0]!) as Record<string, unknown>;
    expect(recovered.until_checkpoint).toBe(drift);
    // The human edit's own commit produced no external entry, and its entry is untouched.
    expect(String(recovered.diff)).toContain("+something else did this");
    expect(String(recovered.diff)).not.toContain("+reviewer typed this");
    const payloadKinds = Object.keys(restarted.state.entries)
      .map((id) => (readInboxEntry(root, id) as Record<string, unknown> | null)?.kind)
      .sort();
    expect(payloadKinds).toEqual([EXTERNAL_EDIT_KIND, "human_edit"]);
  });

  test("a drift commit that no entry names is recovered exactly once on the next reconcile", async () => {
    const root = workspace();
    writeFile(root, "notes.md", "one\n");
    const bus = openBus(root);
    await bus.reconcile();

    // Reproduce the gap the way a crash leaves it: the checkpoint lands, the entry does not. Using
    // the production checkpoint call means the commit carries exactly the trailers a real capture
    // would leave behind, which is the evidence the recovery reads.
    writeFileSync(join(root, "notes.md"), "one\ntwo\n");
    const { checkpoint } = await import("../../src/git/shadow.ts");
    const orphaned = await checkpoint(root, { attribution: "unknown", kind: "auto_checkpoint" });
    expect(Object.keys(bus.state.entries)).toHaveLength(0);
    await bus.close();

    const first = await restart(root);
    expect(first.externalEditIds).toHaveLength(1);
    const recovered = readInboxEntry(root, first.externalEditIds[0]!) as Record<string, unknown>;
    expect(recovered.kind).toBe(EXTERNAL_EDIT_KIND);
    expect(recovered.path).toBe("notes.md");
    expect(recovered.until_checkpoint).toBe(orphaned);

    // Exactly once: not zero on the first restart, not two after a second.
    const second = await restart(root);
    expect(second.externalEditIds).toEqual([]);
    expect(Object.keys(second.state.entries)).toHaveLength(1);
  });

  test("an entry whose journal line was lost but whose inbox file landed is healed with its kind intact", async () => {
    // The neighbouring crash window (A4 §F04 step 3). It matters here because a self-healed entry
    // used to carry no payload kind at all, which would have made a recovered `external_edit`
    // invisible to every exclusion and re-reportable by the scan above.
    const root = workspace();
    writeFile(root, "notes.md", "one\n");
    const bus = openBus(root);
    await bus.reconcile();
    writeFileSync(join(root, "notes.md"), "one\ntwo\n");
    const captured = await bus.captureExternalEdit();
    const id = captured.entries[0]!;
    const payload = readInboxEntry(root, id) as Record<string, unknown>;
    await bus.close();

    // Drop the journal back to before the entry_created, leaving the inbox file in place.
    const journal = join(root, ".glosa", "journal.ndjson");
    const kept = readFileSync(journal, "utf8")
      .split("\n")
      .filter((line) => line.length > 0 && !line.includes('"entry_created"'));
    writeFileSync(journal, `${kept.join("\n")}\n`);

    const healed = await restart(root);
    expect(healed.healedEntryIds).toEqual([id]);
    expect(isExternalEditEntry(healed.state.entries[id]!)).toBe(true);
    expect(healed.state.entries[id]?.until_checkpoint).toBe(String(payload.until_checkpoint));
    // ...and the scan does not then report the same commit a second time.
    expect(healed.externalEditIds).toEqual([]);
    expect(Object.keys(healed.state.entries)).toHaveLength(1);
  });
});

describe("glosa_watch (#153 Part 2) — the per-session cursor over external_edit", () => {
  const watchBuild = (id: string, payload: unknown, status: string) =>
    buildDeliveryPresentation(id, payload, { status, watched: true });

  test("criterion 3 — per-session only: A's watch+ack marks nothing for B, both counts and eligibility are unchanged, and a second watch by A returns nothing new while B still gets it", async () => {
    const root = workspace();
    writeFile(root, "notes.md", "one\n");
    const bus = openBus(root);
    await bus.reconcile();
    writeFileSync(join(root, "notes.md"), "one\ntwo\n");
    const captured = await bus.captureExternalEdit();
    expect(captured.entries).toHaveLength(1);
    const id = captured.entries[0]!;

    const before = peekJournal(root).state;
    const beforeBadge = badgePendingCount(before);
    const beforeRetention = retentionPendingCount(before);

    const firstWatch = await bus.previewWatch({ session: "sess-a" }, watchBuild);
    expect(firstWatch.entries.map((e) => e.id)).toEqual([id]);
    const { accepted: transportAccepted } = await bus.recordWatchTransportAccepted("sess-a", [id]);
    expect(transportAccepted).toEqual([id]);
    const { accepted: presented } = await bus.recordWatchPresented("sess-a", [id], "presented");
    expect(presented).toEqual([id]);

    const rawAttempts = bus.state.entries[id]?.deliveryAttempts;
    const attempts = Array.isArray(rawAttempts) ? (rawAttempts as DeliveryAttemptRecord[]) : [];
    expect(attempts.filter((a) => a.session === "sess-a").map((a) => a.outcome)).toEqual([
      "transport_accepted",
      "presented",
    ]);
    expect(attempts.some((a) => a.session === "sess-b")).toBe(false);

    // Status is unchanged (a mark is an attempt, never a transition) and every OTHER surface still
    // agrees with pre-watch: no delivery path offers it, the badge still excludes it, retention
    // still counts it.
    expect(bus.state.entries[id]?.status).toBe("pending");
    const build = (entryId: string, payload: unknown, status: string) =>
      buildDeliveryPresentation(entryId, payload, { status });
    const monitorPreview = await bus.previewDelivery(8, { session: "sess-a" }, build);
    const pullPrepared = await bus.prepareDelivery(8, { via: "mcp_pull", session: "sess-a" }, build);
    expect(monitorPreview.entries.some((e) => e.id === id)).toBe(false);
    expect(pullPrepared.drained.some((e) => e.id === id)).toBe(false);
    const after = peekJournal(root).state;
    expect(badgePendingCount(after)).toBe(beforeBadge);
    expect(retentionPendingCount(after)).toBe(beforeRetention);

    // A's own second watch (no `since`) sees nothing new — it was presented to A already.
    const secondWatchByA = await bus.previewWatch({ session: "sess-a" }, watchBuild);
    expect(secondWatchByA.entries).toEqual([]);
    expect(secondWatchByA.has_more).toBe(false);

    // B, bound to the same workspace but never watching, still gets it on ITS first watch — a
    // per-session mark, not a global one.
    const watchByB = await bus.previewWatch({ session: "sess-b" }, watchBuild);
    expect(watchByB.entries.map((e) => e.id)).toEqual([id]);
    await bus.close();
  });

  test("W2 — a dismissal that wins the mutex is never returned by a watch; a pending sibling still is", async () => {
    const root = workspace();
    writeFile(root, "a.md", "a1\n");
    writeFile(root, "b.md", "b1\n");
    const bus = openBus(root);
    await bus.reconcile();
    writeFileSync(join(root, "a.md"), "a1\na2\n");
    writeFileSync(join(root, "b.md"), "b1\nb2\n");
    const captured = await bus.captureExternalEdit();
    expect(captured.entries).toHaveLength(2);
    const [first, second] = captured.entries as [string, string];
    const firstPath = (readInboxEntry(root, first) as Record<string, unknown>).path;
    const dismissedId = firstPath === "a.md" ? first : second;
    const pendingId = dismissedId === first ? second : first;

    await bus.commitTransition(dismissedId, "dismissed", { by: "human" });
    const watched = await bus.previewWatch({ session: "sess-a" }, watchBuild);
    expect(watched.entries.map((e) => e.id)).toEqual([pendingId]);
    await bus.close();
  });

  test("criterion 7 — an offline_catchup entry created before the watch started is returned by an initial watch without since", async () => {
    const root = workspace();
    writeFile(root, "notes.md", "one\n");
    const before = openBus(root);
    await before.reconcile();
    await before.close();

    writeFileSync(join(root, "notes.md"), "one\ntwo\n"); // the daemon is down for this edit
    const result = await restart(root);
    expect(result.externalEditIds).toHaveLength(1);

    const after = openBus(root);
    await after.reconcile();
    const watched = await after.previewWatch({ session: "sess-a" }, watchBuild);
    expect(watched.entries.map((e) => e.id)).toEqual(result.externalEditIds);
    expect(watched.entries[0]?.detail?.source).toBe("offline_catchup");
    await after.close();
  });

  test("D11 — an edit made during an apply lease never becomes external_edit and stays invisible to a watch", async () => {
    const root = workspace();
    writeFile(root, "notes.md", "one\n");
    const bus = openBus(root);
    await bus.reconcile();
    await bus.createEntry("ann-1", { kind: "annotation", artifact_path: "notes.md", body: "b", intent: "content" });
    await bus.applyBegin("ann-1", "sess-1");
    writeFileSync(join(root, "notes.md"), "one\nsession wrote this\n");
    await bus.captureExternalEdit();

    const watched = await bus.previewWatch({ session: "sess-a" }, watchBuild);
    expect(watched.entries).toEqual([]);
    await bus.close();
  });

  test("W1 — a checkpoint that produces more entries than the per-response cap never advances the watermark past the split, and draining loses none", async () => {
    const root = workspace();
    const total = MAX_DELIVERY_ENTRIES + 2;
    for (let i = 0; i < total; i++) writeFile(root, `f${i}.md`, "v1\n");
    const bus = openBus(root);
    await bus.reconcile();
    for (let i = 0; i < total; i++) writeFileSync(join(root, `f${i}.md`), "v1\nv2\n");
    const captured = await bus.captureExternalEdit();
    expect(captured.entries).toHaveLength(total);
    const allIds = new Set(captured.entries);

    const firstPage = await bus.previewWatch({ session: "sess-a" }, watchBuild);
    expect(firstPage.entries).toHaveLength(MAX_DELIVERY_ENTRIES);
    expect(firstPage.has_more).toBe(true);
    // The regression this pins: a checkpoint split across the cap must NEVER yield a `since` a
    // caller could use to skip the remainder — the watermark stays behind the whole split group.
    expect(firstPage.latest_checkpoint).toBeNull();

    // Draining through since=latest_checkpoint (null → no filter at all) re-offers the same
    // unpresented page rather than silently skipping anything — proof that this cursor can never
    // lose entries even if a caller drives it that way instead of acking.
    const sincePage = await bus.previewWatch(
      { session: "sess-a", since: firstPage.latest_checkpoint ?? undefined },
      watchBuild,
    );
    expect(sincePage.entries.map((e) => e.id).sort()).toEqual(firstPage.entries.map((e) => e.id).sort());

    // The REAL drain contract: ack what you were given, then re-watch for the rest (W1's "a
    // consumer drains by re-watching while has_more").
    const firstIds = firstPage.entries.map((e) => e.id);
    await bus.recordWatchTransportAccepted("sess-a", firstIds);
    await bus.recordWatchPresented("sess-a", firstIds, "presented");

    const secondPage = await bus.previewWatch({ session: "sess-a" }, watchBuild);
    expect(secondPage.has_more).toBe(false);
    expect(secondPage.entries).toHaveLength(total - MAX_DELIVERY_ENTRIES);
    // Now that every entry sharing the checkpoint is accounted for (all presented), the watermark
    // finally advances to it.
    expect(secondPage.latest_checkpoint).not.toBeNull();

    const seen = new Set([...firstIds, ...secondPage.entries.map((e) => e.id)]);
    expect(seen).toEqual(allIds);
    await bus.close();
  });

  test("criterion 1 — a held watch wakes on a real capture and returns the coalesced entry, ordered after the write", async () => {
    const root = workspace();
    writeFile(root, "draft.md", "line one\n");
    const bus = openBus(root);
    await bus.reconcile();

    const held = waitForWatch(bus, { session: "sess-a", path: "draft.md", waitMs: 10_000 }, watchBuild);
    // Give the held wait a real chance to reach its subscribed state before the write lands —
    // otherwise a fast write could race the subscription and this would only prove the initial
    // read caught it, not that a live capture wakes an already-waiting caller (L-issue-164-2: wait
    // for the watcher's own readiness before the first write).
    await Bun.sleep(20);
    writeFileSync(join(root, "draft.md"), "line one\nline two\n");
    const captured = await bus.captureExternalEdit();
    expect(captured.entries).toHaveLength(1);

    const result = await held;
    expect(result.waited).toBe(true);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.id).toBe(captured.entries[0]);
    expect(result.entries[0]?.kind).toBe(EXTERNAL_EDIT_KIND);
    expect(String(result.entries[0]?.text)).toContain('attribution is "unknown"');
    expect(String(result.entries[0]?.text)).toContain("+line two");
    await bus.close();
  });

  test("criterion 2 — an entry created between the initial read and the subscription is returned, not stranded until wait_ms", async () => {
    const root = workspace();
    writeFile(root, "draft.md", "one\n");
    const bus = openBus(root);
    await bus.reconcile();

    const started = Date.now();
    const result = await waitForWatch(bus, { session: "sess-a", waitMs: 10_000 }, watchBuild, undefined, {
      // Deliberately widens the sub-microtask read→subscribe gap (`waitForWatch`'s own
      // `afterInitialRead` test seam) rather than racing it with sleeps: the write and its capture
      // land AFTER the initial read already observed nothing, and COMPLETE before `bus.subscribe`
      // registers — so a live notification could never see this entry, only the post-subscribe
      // re-read can. A regression here would strand this call for the full 10 s wait_ms.
      afterInitialRead: async () => {
        writeFileSync(join(root, "draft.md"), "one\ntwo\n");
        await bus.captureExternalEdit();
      },
    });
    const elapsed = Date.now() - started;

    expect(result.waited).toBe(true);
    expect(result.entries).toHaveLength(1);
    // Nowhere near the 10 s `waitMs` — proof it was caught by the post-subscribe re-read, not by
    // eventually timing out with an honest empty answer.
    expect(elapsed).toBeLessThan(2_000);
    await bus.close();
  });

  test("F-7 — an abort landing between the initial read and the subscription still ends the hold", async () => {
    const root = workspace();
    writeFile(root, "draft.md", "one\n");
    const bus = openBus(root);
    await bus.reconcile();

    // An AbortSignal that has ALREADY fired does not call a listener registered afterwards. Abort
    // inside the same widened gap the test above uses, so the signal is spent before `waitForWatch`
    // can register for it: without the post-registration check the hold would run the full wait_ms
    // with the client already gone, or the session already rebound elsewhere.
    const controller = new AbortController();
    const started = Date.now();
    const result = await waitForWatch(
      bus,
      { session: "sess-a", waitMs: 10_000, signal: controller.signal },
      watchBuild,
      undefined,
      { afterInitialRead: async () => controller.abort() },
    );
    const elapsed = Date.now() - started;

    expect({ waited: result.waited, entries: result.entries.length, quick: elapsed < 2_000 }).toEqual({
      waited: true,
      entries: 0,
      quick: true,
    });
    await bus.close();
  });
});

describe("A8 — watch acknowledgement authority is read at the append, not before the queue wait", () => {
  test("a session that loses its binding WHILE queued on the workspace mutex appends nothing", async () => {
    // Review round 4 named the class: check a binding, await something asynchronous, then act on
    // the stale check. `runExclusive` is a queue, so a route that validated its binding and then
    // awaited the record method can lose it while waiting and still write the attempt. Holding the
    // mutex here is what makes that window real and deterministic rather than a timing hope.
    const root = workspace();
    const bus = openBus(root);
    await bus.reconcile();
    await bus.createEntry("inb-queued-external", {
      kind: "common",
      payload_kind: EXTERNAL_EDIT_KIND,
      path: "notes.md",
      source: "live",
    });

    const before = readFileSync(journalPath(root));
    let bound = true;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Occupy the mutex so the acknowledgement below has to queue behind it.
    const blocker = bus.mutexForTest().runExclusive(workspaceRegistrationId(root), () => held);

    const acking = bus.recordWatchTransportAccepted("sess-queued", ["inb-queued-external"], () => bound);
    await Bun.sleep(20);
    bound = false; // the rebind lands while the acknowledgement is still queued
    release();
    await blocker;

    const result = await acking;
    expect(result).toEqual({ accepted: [], authorityLost: true });
    expect(readFileSync(journalPath(root)).equals(before)).toBe(true);
    await bus.close();
  });
});

describe("A9 — read-only hydration folds the journal without writing", () => {
  test("a fresh bus over an existing journal returns the entry, and the journal bytes do not change", async () => {
    // The mechanism that stops a watch answering "nothing to report" off a bus nobody reconciled.
    // It was unfalsifiable through HTTP because both attach routes hydrate first (review round 5
    // asked for it here instead, where a fresh bus over an existing journal is one line).
    const root = workspace();
    const writer = openBus(root);
    await writer.reconcile();
    await writer.createEntry("inb-cold-fold", {
      kind: "common",
      payload_kind: EXTERNAL_EDIT_KIND,
      path: "notes.md",
      source: "live",
    });
    await writer.close();

    const cold = openBus(root); // nothing has reconciled THIS instance
    expect(Object.keys(cold.state.entries)).toEqual([]);

    const before = readFileSync(journalPath(root));
    await cold.hydrateForRead();
    const after = readFileSync(journalPath(root));

    expect(Object.keys(cold.state.entries)).toEqual(["inb-cold-fold"]);
    expect(after.equals(before)).toBe(true);
    await cold.close();
  });

  test("hydration waits for a FAILING in-flight reconcile and then folds, rather than serving empty state", async () => {
    // The third path from round 3: attach hydration is best-effort, so a watch can meet a bus whose
    // reconcile is in flight and about to fail. Reading the "a reconcile started" flag as "hydrated"
    // is what made this answer empty; the fix waits, sees the failure, and folds anyway.
    const root = workspace();
    const writer = openBus(root);
    await writer.reconcile();
    await writer.createEntry("inb-failed-attach", {
      kind: "common",
      payload_kind: EXTERNAL_EDIT_KIND,
      path: "notes.md",
      source: "live",
    });
    await writer.close();

    const cold = openBus(root);
    let failReconcile!: (err: Error) => void;
    const pending = new Promise<never>((_resolve, reject) => {
      failReconcile = reject;
    });
    // Stand in for an attach-time reconcile that is still running and will throw.
    (cold as unknown as { reconcile: () => Promise<unknown> }).reconcile = () => pending;
    const attach = cold.reconcileOnce().catch(() => {});

    const reading = cold.hydrateForRead();
    await Bun.sleep(20);
    expect(Object.keys(cold.state.entries)).toEqual([]); // genuinely still waiting

    failReconcile(new Error("attach reconcile failed"));
    await attach;
    await reading;

    expect(Object.keys(cold.state.entries)).toEqual(["inb-failed-attach"]);
    await cold.close();
  });
});

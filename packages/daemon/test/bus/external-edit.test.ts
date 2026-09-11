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
import { isTerminal } from "../../src/bus/lifecycle.ts";
import { badgePendingCount, peekJournal, retentionPendingCount } from "../../src/bus/peek.ts";
import { reconcileWorkspace } from "../../src/bus/reconcile.ts";
import { buildDeliveryPresentation } from "../../src/delivery/presentation.ts";
import { runGit } from "../../src/git/shadow.ts";
import { WorkspaceIndex } from "../../src/registry/workspace-index.ts";
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
  test("no delivery path offers an external_edit, while a sibling annotation is still offered", async () => {
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

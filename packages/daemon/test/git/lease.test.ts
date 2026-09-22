// SPDX-License-Identifier: Apache-2.0
// P2.3 — apply-lease orchestration (A4 §F05): the honest-provenance crux. A `pre_sha..post_sha`
// interval bracketed by a real apply-lease is the ONLY thing ever attributed to a session;
// anything else (pre-existing drift, an expired lease, a change made with no lease at all) is
// `unknown`, never guessed at. Also: exactly one active lease per workspace (LEASE_HELD), and
// concurrent operations serialize through the same workspace mutex shadow-git shares with the
// journal.
import { describe, expect, test } from "bun:test";
import { timedHooks } from "../../../../test/phase-timing.ts";
const { beforeEach, afterEach } = timedHooks("packages/daemon/test/git/lease.test.ts");
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorkspaceBus } from "../../src/bus/bus.ts";
import type { JournalEvent } from "../../src/bus/journal.ts";
import { lifecycleReducer } from "../../src/bus/lifecycle.ts";
import { KeyedMutex } from "../../src/bus/mutex.ts";
import { EXCLUSIVE_CLAIM_TTL_MS, CLAIM_RENEW_GRACE_MS } from "../../src/bus/lease.ts";
import { journalPath } from "../../src/bus/paths.ts";
import { foldEvents } from "../../src/bus/replay.ts";
import { shadowGitDir } from "../../src/bus/paths.ts";
import { checkpoint, diffShas, headSha, indexLockPath, initShadowRepo, runGit } from "../../src/git/shadow.ts";
import {
  claimTestDaemonIdentity,
  cleanupWorkspace,
  deterministicUlid,
  dropDaemonIdentity,
  freshWorkspace,
  heldClaims,
  testWriter,
  writeFile,
} from "./helpers.ts";

/** A settable clock (unlike `deterministicClock`'s auto-increment) so tests can fast-forward past
 * the 15-minute lease TTL without waiting on wall-clock time. */
function settableClock(startMs: number): { now: () => Date; advance: (ms: number) => void } {
  let t = startMs;
  return { now: () => new Date(t), advance: (ms: number) => (t += ms) };
}

/** The journal read back off disk — the only source of truth for "what actually happened" (A4
 * §F04). Asserting on `bus.state` alone would only prove the in-memory fold agrees with itself. */
function journalOf(root: string): JournalEvent[] {
  return readFileSync(journalPath(root), "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as JournalEvent);
}

async function commitTrailers(root: string, sha: string): Promise<string> {
  return (await runGit(root, ["show", "-s", "--format=%B", sha])).stdout;
}

describe("attribution correctness — the crux (A4 §F05)", () => {
  let root: string;
  beforeEach(() => {
    root = freshWorkspace();
  });
  afterEach(() => {
    cleanupWorkspace(root);
  });

  test("a matched path the PROJECT gitignores never kills the checkpoint (and with it the whole lease)", async () => {
    // Observed in two real workspaces. `git add` exits 1 on an ignored pathspec unless forced, so
    // one matched-but-ignored file (`graphify-out/`, a `tmp/` file) made every checkpoint throw —
    // and apply-begin/resolve/offline-catch-up are all built on checkpoints, so proven attribution
    // stopped working entirely for that workspace. It surfaced to the caller as "internal error",
    // which is the correct 500 body (A3 forbids leaking internals) and told the operator nothing.
    writeFile(root, "notes.md", "original");
    writeFile(root, ".gitignore", "ignored-by-project/\n");
    mkdirSync(join(root, "ignored-by-project"), { recursive: true });
    writeFile(root, "ignored-by-project/report.md", "matched by glosa, ignored by the project");

    const clock = settableClock(1_700_000_000_000);
    const bus = new WorkspaceBus(root, { ulid: deterministicUlid(), now: clock.now });
    await bus.reconcile();

    // The lease cycle completes rather than throwing out of the staging step.
    await bus.createEntry("e1", { kind: "annotation" });
    const { preSha } = await bus.applyBegin("e1", "sess-1");
    writeFile(root, "ignored-by-project/report.md", "edited by sess-1");
    const { postSha } = await bus.resolveEntry("e1", "applied", "sess-1");
    expect(postSha).not.toBe(preSha);

    // And the edit really is inside the proven interval, not silently dropped from history.
    expect(await diffShas(root, preSha, postSha)).toContain("edited by sess-1");
  });

  test("an entry this workspace does not own is refused, without taking the lease slot", async () => {
    // A lease is the only thing that attributes a change to a session, so leasing an entry this
    // workspace has never seen produces a proof of nothing — while still consuming the single slot
    // F05 allows. Before `--workspace` existed, `apply-begin` run from the wrong directory did
    // exactly that: it opened a real lease in a real workspace for an entry living somewhere else,
    // locking that workspace out of its own applies for the full TTL.
    writeFile(root, "notes.md", "original");
    const clock = settableClock(1_700_000_000_000);
    const bus = new WorkspaceBus(root, { ulid: deterministicUlid(), now: clock.now });
    await bus.reconcile();

    await expect(bus.applyBegin("inb-from-another-workspace", "sess-1")).rejects.toThrow(/no such inbox entry/);

    // The slot is still free, so the workspace's own entry leases normally straight after.
    const journal = readFileSync(journalPath(root), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as JournalEvent);
    expect(heldClaims(foldEvents(journal))).toEqual([]);
    await bus.createEntry("e1", { kind: "annotation" });
    expect((await bus.applyBegin("e1", "sess-1")).leaseId).toBeTruthy();
  });

  test("apply_end states BOTH ends of the proven interval, including when the lease left no pre_apply commit", async () => {
    // The rollback target a reader is offered after a session applies an annotation is `pre_sha`,
    // and this event is the only place it is ever stated. It used to record `post_sha` alone, and
    // a consumer that went looking for the missing half in the checkpoint graph found nothing:
    // `checkpoint()` is idempotent, so a lease taken against a CLEAN worktree writes no commit at
    // all. That is the ordinary case — an agent takes the lease before it edits — so it is the
    // case pinned here.
    writeFile(root, "notes.md", "original");
    const clock = settableClock(1_700_000_000_000);
    const bus = new WorkspaceBus(root, { ulid: deterministicUlid(), now: clock.now });
    await bus.reconcile();

    const headBefore = await headSha(root);
    await bus.createEntry("e1", { kind: "annotation" });
    const { preSha } = await bus.applyBegin("e1", "sess-1"); // worktree clean: no new commit
    expect(preSha).toBe(headBefore);
    expect(await commitTrailers(root, preSha)).not.toContain("Glosa-Kind: pre_apply");

    writeFile(root, "notes.md", "edited by sess-1");
    const { postSha } = await bus.resolveEntry("e1", "applied", "sess-1");

    const events = readFileSync(journalPath(root), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as JournalEvent);
    const applyEnd = events.find((e) => e.event === "apply_end");
    expect(applyEnd).toBeDefined();
    const detail = applyEnd?.detail as Record<string, unknown>;
    expect(detail.pre_sha).toBe(preSha);
    expect(detail.post_sha).toBe(postSha);
    // Both halves present means the interval this event describes is computable from it alone.
    expect(await diffShas(root, detail.pre_sha as string, detail.post_sha as string)).toContain("edited by sess-1");
  });

  test("applyBegin -> edit -> resolveEntry('applied') attributes exactly the pre..post interval to session:<id>", async () => {
    writeFile(root, "notes.md", "original");
    const clock = settableClock(1_700_000_000_000);
    const bus = new WorkspaceBus(root, { ulid: deterministicUlid(), now: clock.now });
    await bus.reconcile(); // establishes the baseline via offline catch-up
    await bus.createEntry("e1", { kind: "annotation" });
    const { leaseId, preSha } = await bus.applyBegin("e1", "sess-1");
    writeFile(root, "notes.md", "edited by sess-1");
    const { postSha } = await bus.resolveEntry("e1", "applied", "sess-1");

    expect(postSha).not.toBe(preSha);
    const diff = await diffShas(root, preSha, postSha);
    expect(diff).toContain("edited by sess-1");

    const body = await commitTrailers(root, postSha);
    expect(body).toContain("Glosa-Attribution: session:sess-1");
    expect(body).toContain(`Glosa-Lease: ${leaseId}`);
    expect(body).toContain("Glosa-Entry: e1");

    // Journal side of the same proof: apply_begin{pre_sha} .. apply_end{post_sha}, both under
    // `session:sess-1`, plus the resulting status transition.
    expect(bus.state.entries.e1?.status).toBe("applied");
    expect(heldClaims(bus.state)).toEqual([]); // lease closed out
  });

  test("drift present BEFORE a lease starts is captured by applyBegin's own checkpoint as unknown, never session", async () => {
    writeFile(root, "notes.md", "v1");
    const clock = settableClock(1_700_000_000_000);
    const bus = new WorkspaceBus(root, { ulid: deterministicUlid(), now: clock.now });
    await bus.reconcile();

    // Drift with nobody watching — no lease active, this is exactly the "everything else"
    // case A4 §F05 says must never be attributed to a session.
    writeFile(root, "notes.md", "v2, edited with no lease active");
    const before = await headSha(root);
    await bus.createEntry("e1", { kind: "annotation" });
    const { preSha } = await bus.applyBegin("e1", "sess-1");

    expect(preSha).not.toBe(before); // applyBegin's own checkpoint captured the pre-existing drift
    const body = await commitTrailers(root, preSha);
    expect(body).toContain("Glosa-Attribution: unknown");
    expect(body).not.toContain("session:sess-1");

    await bus.resolveEntry("e1", "applied", "sess-1"); // tidy up the open lease
  });

  test("a change made with no active lease at all -> checkpoint is attributed unknown", async () => {
    writeFile(root, "notes.md", "v1");
    const writer = testWriter(root);
    await initShadowRepo(root, { writer, ulid: deterministicUlid(), now: () => new Date() });
    writer.close();

    writeFile(root, "notes.md", "v2, autonomous save burst, no lease");
    const sha = await checkpoint(root, { attribution: "unknown", kind: "auto_checkpoint" });

    const body = await commitTrailers(root, sha);
    expect(body).toContain("Glosa-Attribution: unknown");
  });

  test("reconcile's offline catch-up NEVER checkpoints while a lease is active — it would durably overwrite the eventual session attribution with unknown", async () => {
    writeFile(root, "notes.md", "v1");
    const bus = new WorkspaceBus(root, { ulid: deterministicUlid(), now: () => new Date() });
    await bus.reconcile();
    await bus.createEntry("e1", { kind: "annotation" });
    const { preSha } = await bus.applyBegin("e1", "sess-1");
    writeFile(root, "notes.md", "edited under the lease, mid-flight");

    // Before the fix: reconcile's offline-catch-up step would see this drift (no proof it's
    // "covered" by the lease from its own point of view) and commit it as `unknown` right here —
    // then resolveEntry's own checkpoint would find nothing left to stage (already committed) and
    // just return that same `unknown`-attributed sha, silently losing the session attribution.
    const reconcileResult = await bus.reconcile();
    expect(reconcileResult.offlineCatchup.occurred).toBe(false);
    const shaAfterReconcile = await headSha(root);
    expect(shaAfterReconcile).toBe(preSha); // untouched — still the pre-lease checkpoint

    const { postSha } = await bus.resolveEntry("e1", "applied", "sess-1");
    expect(postSha).not.toBe(preSha);
    const body = await commitTrailers(root, postSha);
    expect(body).toContain("Glosa-Attribution: session:sess-1");
    expect(body).not.toContain("Glosa-Attribution: unknown");
  });
});

describe("offline catch-up steps around claimed paths, never the whole workspace (issue #155)", () => {
  let root: string;
  beforeEach(() => {
    root = freshWorkspace();
  });
  afterEach(() => {
    cleanupWorkspace(root);
  });

  test("with a live claim on notes.md, a reconcile captures drift on other.md as unknown and leaves notes.md to the claim", async () => {
    // Before claims, any lease made this step skip everything. Ablating the path exclusion commits
    // the claimed edit as unknown (red: the resolve can no longer credit it); restoring the
    // whole-workspace skip leaves other.md uncaptured (red: occurred is false).
    writeFile(root, "notes.md", "notes v1");
    writeFile(root, "other.md", "other v1");
    const bus = new WorkspaceBus(root, { ulid: deterministicUlid(), now: () => new Date() });
    await bus.reconcile();
    await bus.createEntry("e1", { kind: "annotation", artifact_path: "notes.md" });
    const { preSha } = await bus.applyBegin("e1", "sess-1");
    writeFile(root, "notes.md", "notes edited under the claim");
    writeFile(root, "other.md", "other edited by nobody glosa knows");

    const result = await bus.reconcile();
    expect(result.offlineCatchup.occurred).toBe(true);
    const caught = result.offlineCatchup.postSha as string;
    expect(await commitTrailers(root, caught)).toContain("Glosa-Attribution: unknown");
    const caughtDiff = await diffShas(root, preSha, caught);
    expect(caughtDiff).toContain("+other edited by nobody glosa knows");
    expect(caughtDiff).not.toContain("notes edited under the claim");
    expect(result.externalEditIds).toHaveLength(1); // step 5b reports it, with the claim still live

    const { postSha } = await bus.resolveEntry("e1", "applied", "sess-1");
    expect(await commitTrailers(root, postSha)).toContain("Glosa-Attribution: session:sess-1");
    expect(await diffShas(root, caught, postSha)).toContain("+notes edited under the claim");
  });
});

describe("CLAIM_HELD on resolve — resolve requires the claim's own session, never trusts the caller", () => {
  let root: string;
  beforeEach(() => {
    root = freshWorkspace();
  });
  afterEach(() => {
    cleanupWorkspace(root);
  });

  test("resolveEntry called with a session that doesn't hold the claim is rejected with the holder — no commit, no append, no attribution", async () => {
    writeFile(root, "notes.md", "v1");
    const bus = new WorkspaceBus(root, { ulid: deterministicUlid(), now: () => new Date() });
    await bus.reconcile();
    await bus.createEntry("e1", { kind: "annotation" });
    const { preSha, leaseId } = await bus.applyBegin("e1", "sess-A");
    writeFile(root, "notes.md", "edited by sess-A, but sess-EVIL tries to claim the resolve");
    const linesBefore = journalOf(root).length;

    let caught: unknown;
    try {
      await bus.resolveEntry("e1", "applied", "sess-EVIL");
    } catch (err) {
      caught = err;
    }

    // Issue #155 REQ-5: the refusal names WHO holds it, inline, instead of an opaque mismatch.
    expect(caught).toMatchObject({
      code: "CLAIM_HELD",
      claim: { claim_id: leaseId, holder_session: "sess-A", mode: "exclusive", fence: 1 },
    });
    // A refusal appends nothing — not a transition, not an apply_end, not an expiry.
    expect(journalOf(root).length).toBe(linesBefore);
    // Nothing committed, nothing attributed to sess-EVIL, and the claim is still open for its
    // real holder.
    const shaAfterAttempt = await headSha(root);
    expect(shaAfterAttempt).toBe(preSha);
    expect(heldClaims(bus.state)[0]?.holder_session).toBe("sess-A");

    // The real holder can still resolve it correctly afterward.
    const { postSha } = await bus.resolveEntry("e1", "applied", "sess-A");
    const body = await commitTrailers(root, postSha);
    expect(body).toContain("Glosa-Attribution: session:sess-A");
    expect(body).not.toContain("sess-EVIL");
  });
});

describe("CLAIM_HELD — exclusive claims are disjoint over paths", () => {
  let root: string;
  beforeEach(() => {
    root = freshWorkspace();
  });
  afterEach(() => {
    cleanupWorkspace(root);
  });

  test("a 2nd apply-begin over overlapping paths rejects CLAIM_HELD with the holder inline, not queue", async () => {
    writeFile(root, "notes.md", "v1");
    const bus = new WorkspaceBus(root, { ulid: deterministicUlid(), now: () => new Date() });
    await bus.reconcile();
    await bus.createEntry("e1", { kind: "annotation" });
    const first = bus.applyBegin("e1", "sess-1");
    await bus.createEntry("e2", { kind: "annotation" });
    const second = bus.applyBegin("e2", "sess-2");

    const firstResult = await first;
    expect(firstResult.leaseId).toBeTruthy();

    let caught: unknown;
    try {
      await second;
    } catch (err) {
      caught = err;
    }
    // Both entries name no artifact, so both claims cover the whole workspace — they overlap.
    expect(caught).toMatchObject({
      code: "CLAIM_HELD",
      claim: { claim_id: firstResult.leaseId, holder_session: "sess-1", mode: "exclusive", fence: 1 },
    });

    // The first claim is still the one on record — the rejected 2nd attempt didn't clobber it.
    expect(heldClaims(bus.state)[0]?.resources).toEqual(["entry:" + "e1"]);
    await bus.resolveEntry("e1", "applied", "sess-1");
  });

  test("two sessions claiming DISJOINT artifacts both succeed, and each resolve is scoped to its own file", async () => {
    // The ordinary case the one-lease-per-workspace rule got wrong: two agents on two different
    // files. Ablating the path scoping on either checkpoint reds the interval assertions below,
    // because each post_apply would sweep the other session's file into its own commit.
    writeFile(root, "notes.md", "notes v1");
    writeFile(root, "essay.md", "essay v1");
    const bus = new WorkspaceBus(root, { ulid: deterministicUlid(), now: () => new Date() });
    await bus.reconcile();
    await bus.createEntry("e1", { kind: "annotation", artifact_path: "notes.md" });
    await bus.createEntry("e2", { kind: "annotation", artifact_path: "essay.md" });

    const a = await bus.applyBegin("e1", "sess-A");
    const b = await bus.applyBegin("e2", "sess-B");
    expect(a.fence).toBe(1);
    expect(b.fence).toBe(1); // fences are per resource, and these are different resources

    writeFile(root, "notes.md", "notes edited by A");
    writeFile(root, "essay.md", "essay edited by B");
    const aEnd = await bus.resolveEntry("e1", "applied", "sess-A");
    const bEnd = await bus.resolveEntry("e2", "applied", "sess-B");

    // A's commit carries only A's file, attributed to A — B's in-flight edit stayed out of it.
    const aDiff = await diffShas(root, a.preSha, aEnd.postSha);
    expect(aDiff).toContain("notes edited by A");
    expect(aDiff).not.toContain("essay edited by B");
    expect(await commitTrailers(root, aEnd.postSha)).toContain("Glosa-Attribution: session:sess-A");
    // B's interval, read back scoped to B's paths, is exactly B's edit.
    const bDiff = await diffShas(root, b.preSha, bEnd.postSha, ["essay.md"]);
    expect(bDiff).toContain("essay edited by B");
    expect(bDiff).not.toContain("notes edited by A");
    expect(await commitTrailers(root, bEnd.postSha)).toContain("Glosa-Attribution: session:sess-B");

    const ends = journalOf(root).filter((e) => e.event === "apply_end");
    expect(ends.map((e) => e.detail?.paths)).toEqual([["notes.md"], ["essay.md"]]);
    expect(ends.every((e) => e.detail?.interval_attribution === "session")).toBe(true);
  });

  test("the same session re-claiming its own entry renews and keeps the fence — never CLAIM_HELD", async () => {
    writeFile(root, "notes.md", "v1");
    const clock = settableClock(1_700_000_000_000);
    const bus = new WorkspaceBus(root, { ulid: deterministicUlid(), now: clock.now });
    await bus.reconcile();
    await bus.createEntry("e1", { kind: "annotation", artifact_path: "notes.md" });
    const first = await bus.applyBegin("e1", "sess-A");
    clock.advance(60_000);
    const again = await bus.applyBegin("e1", "sess-A");
    expect(again.renewed).toBe(true);
    expect(again.leaseId).toBe(first.leaseId);
    expect(again.fence).toBe(first.fence);
    expect(new Date(again.expiresAt).getTime()).toBe(new Date(first.expiresAt).getTime() + 60_000);
    const events = journalOf(root);
    expect(events.filter((e) => e.event === "claim_taken")).toHaveLength(1);
    expect(events.filter((e) => e.event === "claim_renewed")).toHaveLength(1);
    await bus.resolveEntry("e1", "applied", "sess-A");
  });

  test("after resolving, a new apply-begin is accepted again", async () => {
    writeFile(root, "notes.md", "v1");
    const bus = new WorkspaceBus(root, { ulid: deterministicUlid(), now: () => new Date() });
    await bus.reconcile();
    await bus.createEntry("e1", { kind: "annotation" });
    const { leaseId: firstLease } = await bus.applyBegin("e1", "sess-1");
    await bus.resolveEntry("e1", "applied", "sess-1");
    await bus.createEntry("e2", { kind: "annotation" });
    const { leaseId: secondLease } = await bus.applyBegin("e2", "sess-2");
    expect(secondLease).not.toBe(firstLease);
    await bus.resolveEntry("e2", "applied", "sess-2");
  });
});

describe("expired lease reconcile — the interval stays unknown, never session", () => {
  let root: string;
  beforeEach(() => {
    root = freshWorkspace();
  });
  afterEach(() => {
    cleanupWorkspace(root);
  });

  test("a claim past expires_at with no apply_end -> reconcile emits claim_expired naming the holder, drift folds in as unknown", async () => {
    writeFile(root, "notes.md", "v1");
    const clock = settableClock(1_700_000_000_000);
    const bus = new WorkspaceBus(root, { ulid: deterministicUlid(), now: clock.now });
    await bus.reconcile();
    await bus.createEntry("e1", { kind: "annotation" });
    const { leaseId } = await bus.applyBegin("e1", "sess-1");
    writeFile(root, "notes.md", "edited under the lease, but never resolved before it expired");

    clock.advance(EXCLUSIVE_CLAIM_TTL_MS + 1_000); // past expiry, still no resolveEntry call
    const result = await bus.reconcile();

    expect(result.expiredLeaseIds).toEqual([leaseId]);
    expect(heldClaims(bus.state)).toEqual([]);
    // Issue #155 REQ-7: the expiry names who abandoned it — `apply_expired` recorded nobody, and is
    // no longer written at all.
    const events = journalOf(root);
    expect(events.filter((e) => e.event === "claim_expired").map((e) => e.detail)).toEqual([
      { claim_id: leaseId, holder_session: "sess-1", reason: "ttl" },
    ]);
    expect(events.some((e) => e.event === "apply_expired")).toBe(false);
    // Step 5 (offline catch-up), same reconcile pass, picks up the orphaned edit as drift.
    expect(result.offlineCatchup.occurred).toBe(true);
    const body = await commitTrailers(root, result.offlineCatchup.postSha as string);
    expect(body).toContain("Glosa-Attribution: unknown");
    expect(body).not.toContain("session:sess-1");
  });

  test("a lease not yet past expires_at is left alone by reconcile (still legitimately active)", async () => {
    writeFile(root, "notes.md", "v1");
    const clock = settableClock(1_700_000_000_000);
    const bus = new WorkspaceBus(root, { ulid: deterministicUlid(), now: clock.now });
    await bus.reconcile();
    await bus.createEntry("e1", { kind: "annotation" });
    const { leaseId } = await bus.applyBegin("e1", "sess-1");
    clock.advance(1_000); // well under the 15-minute TTL
    const result = await bus.reconcile();

    expect(result.expiredLeaseIds).toEqual([]);
    expect(heldClaims(bus.state)[0]?.claim_id).toBe(leaseId);
    await bus.resolveEntry("e1", "applied", "sess-1");
  });
});

describe("concurrency — checkpoint/applyBegin serialize through the shared workspace mutex", () => {
  let root: string;
  beforeEach(() => {
    root = freshWorkspace();
  });
  afterEach(() => {
    cleanupWorkspace(root);
  });

  test("N concurrent checkpoint calls through the same mutex key never race index.lock and leave a fully consistent history", async () => {
    writeFile(root, "notes.md", "v0");
    const writer = testWriter(root);
    await initShadowRepo(root, { writer, ulid: deterministicUlid(), now: () => new Date() });
    writer.close();

    const mutex = new KeyedMutex<string>();
    const N = 20;
    const shas = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        mutex.runExclusive(root, async () => {
          writeFile(root, "notes.md", `v${i + 1}`);
          return checkpoint(root, { attribution: "unknown", kind: "auto_checkpoint" });
        }),
      ),
    );

    expect(shas.every((sha) => typeof sha === "string" && sha.length > 0)).toBe(true);
    // FIFO through the mutex means the writes landed in submission order — the final content is
    // deterministically the last one queued, not whichever process happened to win a race.
    const finalContent = (await runGit(root, ["show", "HEAD:notes.md"])).stdout;
    expect(finalContent).toBe(`v${N}`);
    const commitCount = Number((await runGit(root, ["rev-list", "--count", "HEAD"])).stdout.trim());
    expect(commitCount).toBe(1 + N); // baseline + one commit per distinct content change
  });

  test("2nd apply-begin queued behind the mutex still resolves to CLAIM_HELD promptly, not stuck behind the resolve", async () => {
    writeFile(root, "notes.md", "v1");
    const bus = new WorkspaceBus(root, { ulid: deterministicUlid(), now: () => new Date() });
    await bus.reconcile();

    const started = Date.now();
    await bus.createEntry("e1", { kind: "annotation" });
    const first = bus.applyBegin("e1", "sess-1");
    await bus.createEntry("e2", { kind: "annotation" });
    const second = bus.applyBegin("e2", "sess-2").catch((err) => err);

    await first;
    const secondResult = await second;
    const elapsedMs = Date.now() - started;

    expect(secondResult).toMatchObject({ code: "CLAIM_HELD", claim: { holder_session: "sess-1" } });
    // Rejected once it got its turn at the mutex (milliseconds), not after waiting for a lease
    // that was never going to be resolved in this test.
    expect(elapsedMs).toBeLessThan(2_000);
    await bus.resolveEntry("e1", "applied", "sess-1");
  });
});

describe("CLAIM_EXPIRED — a claim past its TTL proves nothing, on either path (A4 §F05)", () => {
  let root: string;
  beforeEach(() => {
    root = freshWorkspace();
  });
  afterEach(() => {
    cleanupWorkspace(root);
  });

  function journalEvents(): JournalEvent[] {
    return journalOf(root);
  }

  test("resolveEntry on a claim lapsed beyond the renew grace refuses to attribute: claim_expired + an unknown checkpoint, then CLAIM_EXPIRED", async () => {
    writeFile(root, "notes.md", "v1");
    const clock = settableClock(1_700_000_000_000);
    const bus = new WorkspaceBus(root, { ulid: deterministicUlid(), now: clock.now });
    await bus.reconcile();
    await bus.createEntry("e1", { kind: "human_edit" });

    const { leaseId, preSha } = await bus.applyBegin("e1", "sess-1");

    // The session stalls for hours. No sweeper runs in this test, so nothing closes the claim on
    // schedule. Meanwhile the artifact changes by some other route entirely (a watcher, a direct
    // edit): no live claim covers this interval, so A4 §F05 says it is `unknown`.
    clock.advance(EXCLUSIVE_CLAIM_TTL_MS + 3 * 60 * 60 * 1_000);
    writeFile(root, "notes.md", "three hours of drift that no lease ever covered");

    let caught: unknown;
    try {
      await bus.resolveEntry("e1", "applied", "sess-1");
    } catch (err) {
      caught = err;
    }

    // 1. The caller is told its claim expired — never silently attributed, never silently OK.
    expect(caught).toMatchObject({
      code: "CLAIM_EXPIRED",
      tombstone: { claim_id: leaseId, holder_session: "sess-1", reason: "expired_ttl" },
    });

    // 2. The unproven interval IS captured (nothing is lost) — but as `unknown`, never as the
    // session that happened to still be holding the dead lease.
    const head = await headSha(root);
    expect(head).not.toBe(preSha);
    const body = await commitTrailers(root, head);
    expect(body).toContain("Glosa-Attribution: unknown");
    expect(body).not.toContain("session:sess-1");

    // 3. The claim is closed out honestly in the journal: `claim_expired` naming the holder
    // (REQ-7 — `apply_expired` recorded nobody), never `apply_end` (which is the event that means
    // "a session proved this interval"), and the legacy `apply_expired` is no longer written.
    const events = journalEvents();
    expect(
      events.some(
        (e) =>
          e.event === "claim_expired" &&
          e.detail?.claim_id === leaseId &&
          e.detail?.holder_session === "sess-1" &&
          e.detail?.reason === "ttl",
      ),
    ).toBe(true);
    expect(events.some((e) => e.event === "apply_expired")).toBe(false);
    expect(events.some((e) => e.event === "apply_end")).toBe(false);
    expect(heldClaims(bus.state)).toEqual([]);

    // 4. No status was fabricated — the entry never reached a terminal it can't prove.
    expect(bus.state.entries.e1?.status).toBe("pending");
    expect(events.some((e) => e.event === "transition_committed")).toBe(false);

    // 5. The journal really is the truth: a cold replay of the bytes agrees with live state.
    const replayed = foldEvents(events, lifecycleReducer);
    expect(heldClaims(replayed)).toEqual([]);
    expect(replayed.entries.e1?.status).toBe("pending");
  });

  test("a resolve reaching the mutex just after its claim lapsed renews it and proceeds (rung 3′)", async () => {
    // Issue #155 Q2's queued-resolve rule: the resolve was waiting behind the mutex while the
    // clock ran out. Within one sweeper interval nothing has closed the claim yet, so the holder
    // still holds it — the claim is renewed, the fence is unchanged, and the entry closes.
    writeFile(root, "notes.md", "v1");
    const clock = settableClock(1_700_000_000_000);
    const bus = new WorkspaceBus(root, { ulid: deterministicUlid(), now: clock.now });
    await bus.reconcile();
    await bus.createEntry("e1", { kind: "annotation", artifact_path: "notes.md" });
    const { leaseId, fence } = await bus.applyBegin("e1", "sess-1");
    writeFile(root, "notes.md", "edited under the claim");
    clock.advance(EXCLUSIVE_CLAIM_TTL_MS + CLAIM_RENEW_GRACE_MS - 1_000);

    const result = await bus.resolveEntry("e1", "applied", "sess-1");
    expect(result.leaseId).toBe(leaseId);
    expect(result.fence).toBe(fence);
    expect(bus.state.entries.e1?.status).toBe("applied");
    const events = journalEvents();
    expect(events.some((e) => e.event === "claim_renewed" && e.detail?.claim_id === leaseId)).toBe(true);
    expect(events.some((e) => e.event === "claim_expired")).toBe(false);
    expect(await commitTrailers(root, result.postSha)).toContain("Glosa-Attribution: session:sess-1");
  });

  test("after an expiry has been recorded, the holder's resolve answers CLAIM_EXPIRED even with no fence", async () => {
    // The other half of the rung-3′ split: once something CLOSED the claim, there is nothing left
    // to renew. The tombstone is what tells the caller why.
    writeFile(root, "notes.md", "v1");
    const clock = settableClock(1_700_000_000_000);
    const bus = new WorkspaceBus(root, { ulid: deterministicUlid(), now: clock.now });
    await bus.reconcile();
    await bus.createEntry("e1", { kind: "annotation", artifact_path: "notes.md" });
    const { leaseId } = await bus.applyBegin("e1", "sess-1");
    clock.advance(EXCLUSIVE_CLAIM_TTL_MS + 1_000);
    await bus.reconcile(); // startup-style expiry closes it
    const linesBefore = journalEvents().length;

    await expect(bus.resolveEntry("e1", "applied", "sess-1")).rejects.toMatchObject({
      code: "CLAIM_EXPIRED",
      tombstone: { claim_id: leaseId, holder_session: "sess-1" },
    });
    await expect(bus.resolveEntry("e1", "applied", "sess-1", { fence: 1 })).rejects.toMatchObject({
      code: "CLAIM_EXPIRED",
    });
    expect(journalEvents().length).toBe(linesBefore); // a refusal appends nothing
    expect(bus.state.entries.e1?.status).toBe("pending");
  });

  test("after CLAIM_EXPIRED, a fresh apply-begin/resolve cycle works and attributes only its own proven interval", async () => {
    writeFile(root, "notes.md", "v1");
    const clock = settableClock(1_700_000_000_000);
    const bus = new WorkspaceBus(root, { ulid: deterministicUlid(), now: clock.now });
    await bus.reconcile();
    await bus.createEntry("e1", { kind: "human_edit" });

    await bus.applyBegin("e1", "sess-1");
    clock.advance(EXCLUSIVE_CLAIM_TTL_MS + CLAIM_RENEW_GRACE_MS + 1_000);
    writeFile(root, "notes.md", "drift under the dead lease");
    await expect(bus.resolveEntry("e1", "applied", "sess-1")).rejects.toMatchObject({ code: "CLAIM_EXPIRED" });

    // The retry the error exists to demand.
    const { preSha } = await bus.applyBegin("e1", "sess-1");
    writeFile(root, "notes.md", "edited under the SECOND, live lease");
    const { postSha } = await bus.resolveEntry("e1", "applied", "sess-1");

    expect(bus.state.entries.e1?.status).toBe("applied");
    const proven = await diffShas(root, preSha, postSha);
    expect(proven).toContain("+edited under the SECOND, live lease");
    // The dead lease's orphaned drift is the BASELINE of the proven interval, not part of it —
    // it appears only as the line this session replaced, never as something this session added.
    expect(proven).not.toContain("+drift under the dead lease");
    // ...because the commit that actually introduced that drift is the expiry's own unknown
    // checkpoint, which the second claim then idempotently adopts as its `pre_sha`.
    const preBody = await commitTrailers(root, preSha);
    expect(preBody).toContain("Glosa-Attribution: unknown");
    expect(preBody).toContain("Glosa-Kind: claim_expired");
    expect(await commitTrailers(root, postSha)).toContain("Glosa-Attribution: session:sess-1");
  });

  test("resolveEntry by a caller that does not hold the lapsed claim answers CLAIM_HELD — a non-holder never drives another session's claim to expiry", async () => {
    writeFile(root, "notes.md", "v1");
    const clock = settableClock(1_700_000_000_000);
    const bus = new WorkspaceBus(root, { ulid: deterministicUlid(), now: clock.now });
    await bus.reconcile();
    await bus.createEntry("e1", { kind: "annotation" });
    const { leaseId } = await bus.applyBegin("e1", "sess-A");
    clock.advance(EXCLUSIVE_CLAIM_TTL_MS + 1_000);

    await expect(bus.resolveEntry("e1", "applied", "sess-EVIL")).rejects.toMatchObject({
      code: "CLAIM_HELD",
      claim: { claim_id: leaseId, holder_session: "sess-A" },
    });
    expect(journalEvents().some((e) => e.event === "claim_expired" || e.event === "apply_expired")).toBe(false);
    expect(heldClaims(bus.state)[0]?.claim_id).toBe(leaseId);
  });

  test("applyBegin superseding an expired claim closes it out with claim_expired + an unknown checkpoint BEFORE granting the new one", async () => {
    writeFile(root, "notes.md", "v1");
    const clock = settableClock(1_700_000_000_000);
    const bus = new WorkspaceBus(root, { ulid: deterministicUlid(), now: clock.now });
    await bus.reconcile();
    await bus.createEntry("e1", { kind: "annotation" });
    const { leaseId: firstLease } = await bus.applyBegin("e1", "sess-1");
    clock.advance(EXCLUSIVE_CLAIM_TTL_MS + 1_000);
    writeFile(root, "notes.md", "drift while the first lease was already dead");
    await bus.createEntry("e2", { kind: "annotation" });
    const { leaseId: secondLease } = await bus.applyBegin("e2", "sess-2");
    expect(secondLease).not.toBe(firstLease);

    const events = journalEvents();
    // Exactly one claim_expired, for the superseded claim, naming its holder, and it lands BEFORE
    // the new claim_taken — journal order is what makes "the old claim was closed first"
    // replayable. The legacy `apply_expired` is never written.
    const expired = events.filter((e) => e.event === "claim_expired");
    expect(expired.map((e) => [e.detail?.claim_id, e.detail?.holder_session, e.detail?.reason])).toEqual([
      [firstLease, "sess-1", "ttl"],
    ]);
    expect(events.some((e) => e.event === "apply_expired")).toBe(false);
    const expiredIndex = events.findIndex((e) => e.event === "claim_expired");
    const secondTakenIndex = events.findIndex((e) => e.event === "claim_taken" && e.detail?.claim_id === secondLease);
    expect(expiredIndex).toBeLessThan(secondTakenIndex);

    // Every claim_taken on record is closed by exactly one apply_end/claim_expired except the one
    // still open — no claim is left dangling forever on a long-lived daemon.
    const opened = events.filter((e) => e.event === "claim_taken").map((e) => e.detail?.claim_id);
    const closed = events
      .filter((e) => e.event === "apply_end" || e.event === "claim_expired")
      .map((e) => e.detail?.claim_id);
    expect(opened.filter((id) => !closed.includes(id))).toEqual([secondLease]);

    // The interval the dead lease never proved is on record as unknown.
    const expiredEvent = events[expiredIndex] as JournalEvent;
    expect(expiredEvent.by).toBe("daemon");
    expect(expiredEvent.entry).toBe("e1");
    const body = await commitTrailers(root, await headSha(root));
    expect(body).toContain("Glosa-Attribution: unknown");
    expect(body).not.toContain("session:sess-1");

    await bus.resolveEntry("e2", "applied", "sess-2");
  });

  test("applyBegin still rejects CLAIM_HELD for a claim that has NOT expired — expiry is the only thing that supersedes", async () => {
    writeFile(root, "notes.md", "v1");
    const clock = settableClock(1_700_000_000_000);
    const bus = new WorkspaceBus(root, { ulid: deterministicUlid(), now: clock.now });
    await bus.reconcile();
    await bus.createEntry("e1", { kind: "annotation" });
    const { leaseId } = await bus.applyBegin("e1", "sess-1");
    clock.advance(EXCLUSIVE_CLAIM_TTL_MS - 1_000); // one second short of the TTL
    await bus.createEntry("e2", { kind: "annotation" });
    await expect(bus.applyBegin("e2", "sess-2")).rejects.toMatchObject({
      code: "CLAIM_HELD",
      claim: { claim_id: leaseId, holder_session: "sess-1" },
    });
    expect(journalEvents().some((e) => e.event === "claim_expired" || e.event === "apply_expired")).toBe(false);
    expect(heldClaims(bus.state)[0]?.claim_id).toBe(leaseId);
  });
});

// The reachability half of A4 §F21's ownership rule. `reclaimIndexLock` is not called from a
// context that holds the daemon lock — `WorkspaceBus` reaches it on every apply-lease and
// human-edit path, and nothing about constructing a bus proves this process is the singleton
// daemon. A test harness, a CLI path, or a second daemon that lost the CAS all land here, so
// these two tests pin the behavior at the call site rather than only at the primitive.
describe("WorkspaceBus never reclaims an index.lock it cannot prove it owns (A4 §F21)", () => {
  let root: string;
  beforeEach(() => {
    root = freshWorkspace();
  });
  afterEach(() => {
    dropDaemonIdentity();
    cleanupWorkspace(root);
  });

  test("applyBegin fails loudly and leaves index.lock in place when no daemon lock proves ownership", async () => {
    writeFile(root, "notes.md", "v1");
    const bus = new WorkspaceBus(root, { ulid: deterministicUlid(), now: () => new Date() });
    await bus.reconcile();

    mkdirSync(shadowGitDir(root), { recursive: true });
    writeFileSync(indexLockPath(root), "");
    await bus.createEntry("e1", { kind: "annotation" });
    const err = await bus.applyBegin("e1", "sess-1").catch((e: Error) => e);
    expect((err as { code?: string }).code).toBe("INDEX_LOCK_NOT_OWNED");
    // The whole point: a lock a live `git` might own is still there for that `git` to release.
    expect(existsSync(indexLockPath(root))).toBe(true);
    await bus.close();
  });

  test("applyBegin reclaims normally once the singleton daemon lock proves ownership", async () => {
    writeFile(root, "notes.md", "v1");
    const bus = new WorkspaceBus(root, { ulid: deterministicUlid(), now: () => new Date() });
    await bus.reconcile();

    claimTestDaemonIdentity(root);
    mkdirSync(shadowGitDir(root), { recursive: true });
    writeFileSync(indexLockPath(root), "");
    await bus.createEntry("e1", { kind: "annotation" });
    const { leaseId } = await bus.applyBegin("e1", "sess-1");
    expect(leaseId).toBeTruthy();
    expect(existsSync(indexLockPath(root))).toBe(false);
    await bus.close();
  });
});

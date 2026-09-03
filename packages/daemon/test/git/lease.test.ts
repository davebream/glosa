// SPDX-License-Identifier: Apache-2.0
// P2.3 — apply-lease orchestration (A4 §F05): the honest-provenance crux. A `pre_sha..post_sha`
// interval bracketed by a real apply-lease is the ONLY thing ever attributed to a session;
// anything else (pre-existing drift, an expired lease, a change made with no lease at all) is
// `unknown`, never guessed at. Also: exactly one active lease per workspace (LEASE_HELD), and
// concurrent operations serialize through the same workspace mutex shadow-git shares with the
// journal.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { WorkspaceBus } from "../../src/bus/bus.ts";
import type { JournalEvent } from "../../src/bus/journal.ts";
import { lifecycleReducer } from "../../src/bus/lifecycle.ts";
import { KeyedMutex } from "../../src/bus/mutex.ts";
import { APPLY_LEASE_TTL_MS } from "../../src/bus/lease.ts";
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
  testWriter,
  writeFile,
} from "./helpers.ts";

/** A settable clock (unlike `deterministicClock`'s auto-increment) so tests can fast-forward past
 * the 15-minute lease TTL without waiting on wall-clock time. */
function settableClock(startMs: number): { now: () => Date; advance: (ms: number) => void } {
  let t = startMs;
  return { now: () => new Date(t), advance: (ms: number) => (t += ms) };
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

  test("applyBegin -> edit -> resolveEntry('applied') attributes exactly the pre..post interval to session:<id>", async () => {
    writeFile(root, "notes.md", "original");
    const clock = settableClock(1_700_000_000_000);
    const bus = new WorkspaceBus(root, { ulid: deterministicUlid(), now: clock.now });
    await bus.reconcile(); // establishes the baseline via offline catch-up

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
    expect(bus.state.applyLease).toBeNull(); // lease closed out
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

describe("LEASE_SESSION_MISMATCH — resolve requires the lease's own session, never trusts the caller", () => {
  let root: string;
  beforeEach(() => {
    root = freshWorkspace();
  });
  afterEach(() => {
    cleanupWorkspace(root);
  });

  test("resolveEntry called with a session that doesn't hold the lease is rejected — no commit, no attribution", async () => {
    writeFile(root, "notes.md", "v1");
    const bus = new WorkspaceBus(root, { ulid: deterministicUlid(), now: () => new Date() });
    await bus.reconcile();

    const { preSha } = await bus.applyBegin("e1", "sess-A");
    writeFile(root, "notes.md", "edited by sess-A, but sess-EVIL tries to claim the resolve");

    let caught: unknown;
    try {
      await bus.resolveEntry("e1", "applied", "sess-EVIL");
    } catch (err) {
      caught = err;
    }

    expect((caught as { code?: string } | undefined)?.code).toBe("LEASE_SESSION_MISMATCH");
    // Nothing committed, nothing attributed to sess-EVIL, and the lease is still open for its
    // real holder.
    const shaAfterAttempt = await headSha(root);
    expect(shaAfterAttempt).toBe(preSha);
    expect(bus.state.applyLease?.session).toBe("sess-A");

    // The real holder can still resolve it correctly afterward.
    const { postSha } = await bus.resolveEntry("e1", "applied", "sess-A");
    const body = await commitTrailers(root, postSha);
    expect(body).toContain("Glosa-Attribution: session:sess-A");
    expect(body).not.toContain("sess-EVIL");
  });
});

describe("LEASE_HELD — exactly one active apply-lease per workspace", () => {
  let root: string;
  beforeEach(() => {
    root = freshWorkspace();
  });
  afterEach(() => {
    cleanupWorkspace(root);
  });

  test("a 2nd apply-begin while one is active rejects LEASE_HELD, not queue", async () => {
    writeFile(root, "notes.md", "v1");
    const bus = new WorkspaceBus(root, { ulid: deterministicUlid(), now: () => new Date() });
    await bus.reconcile();

    const first = bus.applyBegin("e1", "sess-1");
    const second = bus.applyBegin("e2", "sess-2");

    const firstResult = await first;
    expect(firstResult.leaseId).toBeTruthy();

    let caught: unknown;
    try {
      await second;
    } catch (err) {
      caught = err;
    }
    expect((caught as { code?: string } | undefined)?.code).toBe("LEASE_HELD");

    // The first lease is still the one on record — the rejected 2nd attempt didn't clobber it.
    expect(bus.state.applyLease?.entry).toBe("e1");
    await bus.resolveEntry("e1", "applied", "sess-1");
  });

  test("after resolving, a new apply-begin is accepted again", async () => {
    writeFile(root, "notes.md", "v1");
    const bus = new WorkspaceBus(root, { ulid: deterministicUlid(), now: () => new Date() });
    await bus.reconcile();

    const { leaseId: firstLease } = await bus.applyBegin("e1", "sess-1");
    await bus.resolveEntry("e1", "applied", "sess-1");

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

  test("a lease past expires_at with no apply_end -> reconcile emits apply_expired, drift folds in as unknown", async () => {
    writeFile(root, "notes.md", "v1");
    const clock = settableClock(1_700_000_000_000);
    const bus = new WorkspaceBus(root, { ulid: deterministicUlid(), now: clock.now });
    await bus.reconcile();

    const { leaseId } = await bus.applyBegin("e1", "sess-1");
    writeFile(root, "notes.md", "edited under the lease, but never resolved before it expired");

    clock.advance(APPLY_LEASE_TTL_MS + 1_000); // past expiry, still no resolveEntry call
    const result = await bus.reconcile();

    expect(result.expiredLeaseIds).toEqual([leaseId]);
    expect(bus.state.applyLease).toBeNull();
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

    const { leaseId } = await bus.applyBegin("e1", "sess-1");
    clock.advance(1_000); // well under the 15-minute TTL
    const result = await bus.reconcile();

    expect(result.expiredLeaseIds).toEqual([]);
    expect(bus.state.applyLease?.leaseId).toBe(leaseId);
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

  test("2nd apply-begin queued behind the mutex still resolves to LEASE_HELD promptly, not stuck behind lease resolution", async () => {
    writeFile(root, "notes.md", "v1");
    const bus = new WorkspaceBus(root, { ulid: deterministicUlid(), now: () => new Date() });
    await bus.reconcile();

    const started = Date.now();
    const first = bus.applyBegin("e1", "sess-1");
    const second = bus.applyBegin("e2", "sess-2").catch((err) => err);

    await first;
    const secondResult = await second;
    const elapsedMs = Date.now() - started;

    expect((secondResult as { code?: string }).code).toBe("LEASE_HELD");
    // Rejected once it got its turn at the mutex (milliseconds), not after waiting for a lease
    // that was never going to be resolved in this test.
    expect(elapsedMs).toBeLessThan(2_000);
    await bus.resolveEntry("e1", "applied", "sess-1");
  });
});

describe("LEASE_EXPIRED — a lease past its TTL proves nothing, on either path (A4 §F05)", () => {
  let root: string;
  beforeEach(() => {
    root = freshWorkspace();
  });
  afterEach(() => {
    cleanupWorkspace(root);
  });

  /** Reads the journal back off disk — the only source of truth for "what actually happened"
   * (A4 §F04); asserting on `bus.state` alone would only prove the in-memory fold agrees with
   * itself. */
  function journalEvents(): JournalEvent[] {
    return readFileSync(journalPath(root), "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as JournalEvent);
  }

  test("resolveEntry on a lease past expires_at refuses to attribute: apply_expired + an unknown checkpoint, then LEASE_EXPIRED", async () => {
    writeFile(root, "notes.md", "v1");
    const clock = settableClock(1_700_000_000_000);
    const bus = new WorkspaceBus(root, { ulid: deterministicUlid(), now: clock.now });
    await bus.reconcile();
    await bus.createEntry("e1", { kind: "human_edit" });

    const { leaseId, preSha } = await bus.applyBegin("e1", "sess-1");

    // The session stalls for hours. The daemon never restarts, so reconcile step 4 — the ONLY
    // code that writes `apply_expired` — never fires. Meanwhile the artifact changes by some
    // other route entirely (a watcher, a direct edit): no lease covers this interval, so A4 §F05
    // says it is `unknown`.
    clock.advance(APPLY_LEASE_TTL_MS + 3 * 60 * 60 * 1_000);
    writeFile(root, "notes.md", "three hours of drift that no lease ever covered");

    let caught: unknown;
    try {
      await bus.resolveEntry("e1", "applied", "sess-1");
    } catch (err) {
      caught = err;
    }

    // 1. The caller is told to re-run apply-begin — never silently attributed, never silently OK.
    expect((caught as { code?: string } | undefined)?.code).toBe("LEASE_EXPIRED");

    // 2. The unproven interval IS captured (nothing is lost) — but as `unknown`, never as the
    // session that happened to still be holding the dead lease.
    const head = await headSha(root);
    expect(head).not.toBe(preSha);
    const body = await commitTrailers(root, head);
    expect(body).toContain("Glosa-Attribution: unknown");
    expect(body).not.toContain("session:sess-1");

    // 3. The lease is closed out honestly in the journal: `apply_expired`, never `apply_end`
    // (which is the event that means "a session proved this interval").
    const events = journalEvents();
    expect(events.some((e) => e.event === "apply_expired" && e.detail?.lease_id === leaseId)).toBe(true);
    expect(events.some((e) => e.event === "apply_end")).toBe(false);
    expect(bus.state.applyLease).toBeNull();

    // 4. No status was fabricated — the entry never reached a terminal it can't prove.
    expect(bus.state.entries.e1?.status).toBe("pending");
    expect(events.some((e) => e.event === "transition_committed")).toBe(false);

    // 5. The journal really is the truth: a cold replay of the bytes agrees with live state.
    const replayed = foldEvents(events, lifecycleReducer);
    expect(replayed.applyLease).toBeNull();
    expect(replayed.entries.e1?.status).toBe("pending");
  });

  test("after LEASE_EXPIRED, a fresh apply-begin/resolve cycle works and attributes only its own proven interval", async () => {
    writeFile(root, "notes.md", "v1");
    const clock = settableClock(1_700_000_000_000);
    const bus = new WorkspaceBus(root, { ulid: deterministicUlid(), now: clock.now });
    await bus.reconcile();
    await bus.createEntry("e1", { kind: "human_edit" });

    await bus.applyBegin("e1", "sess-1");
    clock.advance(APPLY_LEASE_TTL_MS + 1_000);
    writeFile(root, "notes.md", "drift under the dead lease");
    await expect(bus.resolveEntry("e1", "applied", "sess-1")).rejects.toMatchObject({ code: "LEASE_EXPIRED" });

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
    // checkpoint, which the second lease then idempotently adopts as its `pre_sha`.
    const preBody = await commitTrailers(root, preSha);
    expect(preBody).toContain("Glosa-Attribution: unknown");
    expect(preBody).toContain("Glosa-Kind: apply_expired");
    expect(await commitTrailers(root, postSha)).toContain("Glosa-Attribution: session:sess-1");
  });

  test("resolveEntry by a caller that does not hold the expired lease is still LEASE_SESSION_MISMATCH — a non-holder never drives another session's lease to expiry", async () => {
    writeFile(root, "notes.md", "v1");
    const clock = settableClock(1_700_000_000_000);
    const bus = new WorkspaceBus(root, { ulid: deterministicUlid(), now: clock.now });
    await bus.reconcile();

    const { leaseId } = await bus.applyBegin("e1", "sess-A");
    clock.advance(APPLY_LEASE_TTL_MS + 1_000);

    await expect(bus.resolveEntry("e1", "applied", "sess-EVIL")).rejects.toMatchObject({
      code: "LEASE_SESSION_MISMATCH",
    });
    expect(journalEvents().some((e) => e.event === "apply_expired")).toBe(false);
    expect(bus.state.applyLease?.leaseId).toBe(leaseId);
  });

  test("applyBegin superseding an expired lease closes it out with apply_expired + an unknown checkpoint BEFORE granting the new one", async () => {
    writeFile(root, "notes.md", "v1");
    const clock = settableClock(1_700_000_000_000);
    const bus = new WorkspaceBus(root, { ulid: deterministicUlid(), now: clock.now });
    await bus.reconcile();

    const { leaseId: firstLease } = await bus.applyBegin("e1", "sess-1");
    clock.advance(APPLY_LEASE_TTL_MS + 1_000);
    writeFile(root, "notes.md", "drift while the first lease was already dead");

    const { leaseId: secondLease } = await bus.applyBegin("e2", "sess-2");
    expect(secondLease).not.toBe(firstLease);

    const events = journalEvents();
    // Exactly one apply_expired, for the superseded lease, and it lands BEFORE the new
    // apply_begin — journal order is what makes "the old lease was closed first" replayable.
    const expired = events.filter((e) => e.event === "apply_expired");
    expect(expired.map((e) => e.detail?.lease_id)).toEqual([firstLease]);
    const expiredIndex = events.findIndex((e) => e.event === "apply_expired");
    const secondBeginIndex = events.findIndex((e) => e.event === "apply_begin" && e.detail?.lease_id === secondLease);
    expect(expiredIndex).toBeLessThan(secondBeginIndex);

    // Every apply_begin on record is closed by exactly one apply_end/apply_expired except the
    // one still open — no `apply_begin` is left dangling forever on a long-lived daemon.
    const opened = events.filter((e) => e.event === "apply_begin").map((e) => e.detail?.lease_id);
    const closed = events
      .filter((e) => e.event === "apply_end" || e.event === "apply_expired")
      .map((e) => e.detail?.lease_id);
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

  test("applyBegin still rejects LEASE_HELD for a lease that has NOT expired — expiry is the only thing that supersedes", async () => {
    writeFile(root, "notes.md", "v1");
    const clock = settableClock(1_700_000_000_000);
    const bus = new WorkspaceBus(root, { ulid: deterministicUlid(), now: clock.now });
    await bus.reconcile();

    const { leaseId } = await bus.applyBegin("e1", "sess-1");
    clock.advance(APPLY_LEASE_TTL_MS - 1_000); // one second short of the TTL

    await expect(bus.applyBegin("e2", "sess-2")).rejects.toMatchObject({ code: "LEASE_HELD" });
    expect(journalEvents().some((e) => e.event === "apply_expired")).toBe(false);
    expect(bus.state.applyLease?.leaseId).toBe(leaseId);
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

    const { leaseId } = await bus.applyBegin("e1", "sess-1");
    expect(leaseId).toBeTruthy();
    expect(existsSync(indexLockPath(root))).toBe(false);
    await bus.close();
  });
});

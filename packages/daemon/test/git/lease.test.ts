// P2.3 — apply-lease orchestration (A4 §F05): the honest-provenance crux. A `pre_sha..post_sha`
// interval bracketed by a real apply-lease is the ONLY thing ever attributed to a session;
// anything else (pre-existing drift, an expired lease, a change made with no lease at all) is
// `unknown`, never guessed at. Also: exactly one active lease per workspace (LEASE_HELD), and
// concurrent operations serialize through the same workspace mutex shadow-git shares with the
// journal.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { WorkspaceBus } from "../../src/bus/bus.ts";
import { KeyedMutex } from "../../src/bus/mutex.ts";
import { APPLY_LEASE_TTL_MS } from "../../src/bus/lease.ts";
import { checkpoint, diffShas, headSha, initShadowRepo, runGit } from "../../src/git/shadow.ts";
import { cleanupWorkspace, deterministicUlid, freshWorkspace, testWriter, writeFile } from "./helpers.ts";

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

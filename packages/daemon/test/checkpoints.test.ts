// P3.5 — checkpoints.ts: since-token resolution (A6 §F31's `yesterday|today|ISO|<checkpoint-id>`)
// and the full-history listing. The DST day-boundary case is the acceptance-named test here — it
// proves `resolveDayBoundary` builds the boundary from LOCAL CALENDAR components (so a
// spring-forward/fall-back day is correctly 23/25 real hours, not a naive 24h subtraction) against
// a real DST transition date, not a mocked one.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { checkpoint, headSha, initShadowRepo } from "../src/git/shadow.ts";
import { listCheckpoints, resolveDayBoundary, resolveSince } from "../src/checkpoints.ts";
import { cleanupWorkspace, deterministicUlid, freshWorkspace, testWriter, writeFile } from "./git/helpers.ts";

describe("resolveDayBoundary — DST day-boundary (A6 §F31 acceptance case)", () => {
  let originalTz: string | undefined;
  beforeEach(() => {
    originalTz = process.env.TZ;
  });
  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  test("spring-forward (Europe/Warsaw, 2026-03-29 loses an hour): yesterday..today spans 23h, not 24h", () => {
    process.env.TZ = "Europe/Warsaw";
    const now = new Date(2026, 2, 30, 12, 0, 0); // March 30 2026, local noon — the day AFTER the transition
    const today = resolveDayBoundary("today", now);
    const yesterday = resolveDayBoundary("yesterday", now);
    const spanHours = (new Date(today).getTime() - new Date(yesterday).getTime()) / 3_600_000;
    expect(spanHours).toBe(23); // a naive `now - 24h` implementation would get this wrong
  });

  test("fall-back (Europe/Warsaw, 2026-10-25 gains an hour): yesterday..today spans 25h, not 24h", () => {
    process.env.TZ = "Europe/Warsaw";
    const now = new Date(2026, 9, 26, 12, 0, 0); // Oct 26 2026, local noon — the day AFTER the transition
    const today = resolveDayBoundary("today", now);
    const yesterday = resolveDayBoundary("yesterday", now);
    const spanHours = (new Date(today).getTime() - new Date(yesterday).getTime()) / 3_600_000;
    expect(spanHours).toBe(25);
  });

  test("an ordinary day (no DST transition in range) still spans exactly 24h", () => {
    process.env.TZ = "Europe/Warsaw";
    const now = new Date(2026, 5, 15, 12, 0, 0); // June 15 2026 — deep in DST, no transition nearby
    const today = resolveDayBoundary("today", now);
    const yesterday = resolveDayBoundary("yesterday", now);
    const spanHours = (new Date(today).getTime() - new Date(yesterday).getTime()) / 3_600_000;
    expect(spanHours).toBe(24);
  });

});

describe("resolveSince — token classification (A6 §F31)", () => {
  let root: string;
  beforeEach(async () => {
    root = freshWorkspace();
    writeFile(root, "a.md", "content\n");
    const writer = testWriter(root);
    await initShadowRepo(root, { writer, ulid: deterministicUlid() });
    writer.close();
  });
  afterEach(() => {
    cleanupWorkspace(root);
  });

  test("'yesterday' and 'today' resolve to a boundary instant", async () => {
    const now = new Date(2026, 5, 15, 12, 0, 0);
    const today = await resolveSince(root, "today", now);
    const yesterday = await resolveSince(root, "yesterday", now);
    expect(today).toEqual({ ok: true, mode: "boundary", iso: resolveDayBoundary("today", now) });
    expect(yesterday).toEqual({ ok: true, mode: "boundary", iso: resolveDayBoundary("yesterday", now) });
  });

  test("an ISO string resolves to a boundary instant honoring its OWN offset", async () => {
    const result = await resolveSince(root, "2026-01-01T00:00:00+02:00", new Date());
    expect(result).toEqual({ ok: true, mode: "boundary", iso: new Date("2026-01-01T00:00:00+02:00").toISOString() });
  });

  test("a real checkpoint id resolves to checkpoint mode", async () => {
    const sha = await headSha(root);
    const result = await resolveSince(root, sha, new Date());
    expect(result).toEqual({ ok: true, mode: "checkpoint", checkpointId: sha });
  });

  test("an unrecognized token (neither a day-word, ISO date, nor a real checkpoint) is rejected", async () => {
    const result = await resolveSince(root, "not-a-real-anything", new Date());
    expect(result).toEqual({ ok: false });
  });
});

describe("listCheckpoints — full history (A6 §F31)", () => {
  let root: string;
  beforeEach(() => {
    root = freshWorkspace();
  });
  afterEach(() => {
    cleanupWorkspace(root);
  });

  test("an empty/never-checkpointed workspace lists no rows, not an error", async () => {
    const result = await listCheckpoints(root, {}, new Date());
    expect(result).toEqual({ ok: true, rows: [] });
  });

  test("lists checkpoints newest-first, with by/summary from the Glosa-Attribution/Glosa-Kind trailers and non-zero bytes_changed", async () => {
    writeFile(root, "notes.md", "v1\n");
    const writer = testWriter(root);
    await initShadowRepo(root, { writer, ulid: deterministicUlid() }); // baseline: unknown/baseline
    writer.close();

    writeFileSync(`${root}/notes.md`, "v2 — a human edit\n");
    await checkpoint(root, { attribution: "human", kind: "human_edit" });

    writeFileSync(`${root}/notes.md`, "v3 — a leased agent edit\n");
    await checkpoint(root, { attribution: "session:sess-a", kind: "post_apply" });

    const result = await listCheckpoints(root, {}, new Date());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.rows).toHaveLength(3);
    // newest first
    expect(result.rows[0]).toMatchObject({ by: "session:sess-a", summary: "post_apply" });
    expect(result.rows[1]).toMatchObject({ by: "human", summary: "human_edit" });
    expect(result.rows[2]).toMatchObject({ by: "unknown", summary: "baseline" });
    for (const row of result.rows) {
      expect(typeof row.checkpoint_id).toBe("string");
      expect(typeof row.at).toBe("string");
      expect(row.bytes_changed).toBeGreaterThan(0);
    }
  });

  test("since=<checkpoint-id> returns only checkpoints strictly AFTER it", async () => {
    writeFile(root, "notes.md", "v1\n");
    const writer = testWriter(root);
    await initShadowRepo(root, { writer, ulid: deterministicUlid() });
    writer.close();
    const baseline = await headSha(root);

    writeFileSync(`${root}/notes.md`, "v2\n");
    const second = await checkpoint(root, { attribution: "human", kind: "human_edit" });

    const result = await listCheckpoints(root, { since: baseline }, new Date());
    expect(result).toEqual({ ok: true, rows: [expect.objectContaining({ checkpoint_id: expect.any(String) })] });
    if (result.ok) expect(result.rows[0]!.by).toBe("human");
    // sanity: the range genuinely excludes the baseline itself
    if (result.ok) expect(result.rows.map((r) => r.summary)).toEqual(["human_edit"]);
    expect(second).not.toBe(baseline);
  });

  test("since=<ISO> filters by committer date, using controlled `at` timestamps to prove exactness", async () => {
    writeFile(root, "notes.md", "v1\n");
    const writer = testWriter(root);
    await initShadowRepo(root, { writer, ulid: deterministicUlid() });
    writer.close();

    writeFileSync(`${root}/notes.md`, "v2 — before the boundary\n");
    await checkpoint(root, { attribution: "human", kind: "human_edit", at: new Date("2026-01-01T00:00:00Z") });

    writeFileSync(`${root}/notes.md`, "v3 — after the boundary\n");
    await checkpoint(root, { attribution: "human", kind: "auto_checkpoint", at: new Date("2026-06-01T00:00:00Z") });

    const result = await listCheckpoints(root, { since: "2026-03-01T00:00:00Z" }, new Date());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    // The January-dated `human_edit` is excluded; the June-dated `auto_checkpoint` is included.
    // The baseline itself has no `at` override — `initShadowRepo` stamps it with the REAL commit
    // time (i.e. whenever this test actually runs), which is always after the fixed 2026-03-01
    // boundary, so it's included too — proving the filter reads the true committer date rather
    // than e.g. always excluding the very first commit.
    const summaries = result.rows.map((r) => r.summary);
    expect(summaries).toContain("auto_checkpoint");
    expect(summaries).toContain("baseline");
    expect(summaries).not.toContain("human_edit");
  });

  test("an unrecognized since token → ok:false", async () => {
    writeFile(root, "a.md", "x\n");
    const writer = testWriter(root);
    await initShadowRepo(root, { writer, ulid: deterministicUlid() });
    writer.close();

    const result = await listCheckpoints(root, { since: "definitely-not-a-checkpoint" }, new Date());
    expect(result).toEqual({ ok: false });
  });

  test("limit caps the row count after filtering, keeping the newest rows", async () => {
    writeFile(root, "notes.md", "v1\n");
    const writer = testWriter(root);
    await initShadowRepo(root, { writer, ulid: deterministicUlid() });
    writer.close();
    for (let i = 2; i <= 4; i++) {
      writeFileSync(`${root}/notes.md`, `v${i}\n`);
      await checkpoint(root, { attribution: "human", kind: `edit-${i}` });
    }

    const result = await listCheckpoints(root, { limit: 2 }, new Date());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.rows).toHaveLength(2);
    expect(result.rows.map((r) => r.summary)).toEqual(["edit-4", "edit-3"]);
  });
});

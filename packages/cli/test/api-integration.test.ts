// SPDX-License-Identifier: Apache-2.0
// P5.1 — ONE real end-to-end pass against a genuinely spawned daemon (not a fake), proving
// http.ts's new `/api/workspaces/*` + `/api/status` routes actually work over real HTTP, and that
// `createHttpGlosaClient()`'s `ensureDaemon`-backed lazy spawn (the exact mechanism `glosa open`
// relies on) produces a working client. Every other P5.1 test file fakes `GlosaApiClient`; this
// one deliberately does not — it's the "at least one integration-style test against something
// real" the task brief asks for, covering open/apply-begin/lease-conflict/resolve/status/
// attention-request/entry-status/deferred in two scenarios against one shared real daemon
// (separate workspace dirs keep the scenarios independent).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureToken, lockPath, readLock } from "@glosa/daemon";
import { createHttpGlosaClient, type GlosaApiClient } from "../src/api-client.ts";
import { runRequestReview } from "../src/request-review.ts";
// Share the daemon-test port allocator so this long-lived ensureDaemon child cannot collide with
// hermetic `spawnDaemon` suites that also pick from [20000, 40000) during the same `bun test` run.
import { randomPort } from "../../daemon/test/helpers.ts";

let home: string;
let client: GlosaApiClient;
let token: string;
const dirsToClean: string[] = [];

function freshWorkspaceDir(): string {
  const d = mkdtempSync(join(tmpdir(), "glosa-cli-api-ws-"));
  dirsToClean.push(d);
  return d;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "glosa-cli-api-home-"));
  dirsToClean.push(home);
  Bun.env.GLOSA_HOME = home;
  Bun.env.GLOSA_PORT = String(randomPort());
  // Same ordering `open.ts`'s `runOpen` uses, and for the same reason: `bootDaemon` reads
  // `<home>/token` exactly once, at its own boot — the token must exist on disk BEFORE the
  // daemon's first-ever spawn (which `createHttpGlosaClient()` below triggers via `ensureDaemon`),
  // or every authed call in this file would 401 for this daemon's entire process lifetime.
  token = ensureToken(home);
  // Lazily spawns a real `glosa __daemon` subprocess via `ensureDaemon` — the SAME mechanism
  // `glosa open` uses in production; nothing here pre-spawns a daemon by hand.
  client = await createHttpGlosaClient();
}, 15000);

afterAll(async () => {
  const lock = readLock(lockPath(home));
  if (lock) {
    try {
      process.kill(lock.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  await Bun.sleep(300);
  for (const d of dirsToClean) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

describe("GlosaApiClient — real daemon end-to-end", () => {
  test("open -> apply-begin -> 2nd apply-begin conflicts (409) -> resolve(applied) proves a real pre..post diff -> status reflects it", async () => {
    const workspaceDir = freshWorkspaceDir();

    const opened = await client.openWorkspace(workspaceDir);
    expect(opened.slug).toBeTruthy();
    expect(opened.path).toBe(realpathSync(workspaceDir));

    const begin = await client.applyBegin(workspaceDir, "entry-1", "sess-real-1");
    expect(begin.lease_id).toBeTruthy();
    expect(begin.pre_sha).toBeTruthy();

    // A second apply-begin while one is already active for this workspace -> LEASE_HELD -> 409.
    await expect(client.applyBegin(workspaceDir, "entry-2", "sess-real-1")).rejects.toMatchObject({ status: 409 });

    // A real change between apply-begin and resolve — proves resolveEntry's post_sha checkpoint
    // actually captures something (an untouched workspace would idempotently return the SAME sha
    // as pre_sha, which would prove nothing about the pre..post mechanism).
    writeFileSync(join(workspaceDir, "change.md"), "a real change\n");

    const resolved = await client.resolveEntry(workspaceDir, "entry-1", "applied", "sess-real-1", "looks good");
    expect(resolved.status).toBe("applied");
    expect(resolved.post_sha).toBeTruthy();
    expect(resolved.post_sha).not.toBe(begin.pre_sha);

    // entry-1 is now terminal ("applied"). A `deferred` fired on it must NOT come back as a bare
    // 200 `{to: "deferred"}` that a client reading only `to` could misread as a real re-defer —
    // it must 409, the same honest-conflict signal LEASE_HELD/NO_ACTIVE_LEASE already use above.
    await expect(
      client.resolveEntry(workspaceDir, "entry-1", "deferred", "sess-real-1", "too late"),
    ).rejects.toMatchObject({
      status: 409,
    });

    const status = await client.getStatus();
    expect(status.workspaces.some((w) => w.slug === opened.slug)).toBe(true);
  }, 20000);

  test("attention-request -> entry-status reflects it -> resolve(deferred) leaves status non-terminal, unknown entry -> null", async () => {
    const workspaceDir = freshWorkspaceDir();
    await client.openWorkspace(workspaceDir);

    const review = await client.createAttentionRequest(workspaceDir, {
      message: "please look",
      targetPath: "notes.md",
    });
    expect(review.status).toBe("open");

    const status1 = await client.getEntryStatus(workspaceDir, review.id);
    expect(status1?.status).toBe("open");
    expect(status1?.kind).toBe("attention");

    const deferred = await client.resolveEntry(workspaceDir, review.id, "deferred", "sess-real-2", "not now");
    expect(deferred.to).toBe("deferred");
    expect(deferred.status).toBe("open"); // unchanged — "deferred" is a legal no-op transition, not a terminal one

    const unknown = await client.getEntryStatus(workspaceDir, "nope-does-not-exist");
    expect(unknown).toBeNull();
  }, 20000);

  test("request-review approval mode creates, approves, and returns the typed verdict through --wait", async () => {
    const workspaceDir = freshWorkspaceDir();
    const content = "# Ready for approval\n";
    writeFileSync(join(workspaceDir, "draft.md"), content);
    const opened = await client.openWorkspace(workspaceDir);

    let createdId: string | undefined;
    const observingClient: GlosaApiClient = {
      ...client,
      createAttentionRequest: async (path, opts) => {
        const created = await client.createAttentionRequest(path, opts);
        createdId = created.id;
        return created;
      },
    };
    const waiting = runRequestReview(
      {
        dir: workspaceDir,
        path: "draft.md",
        action: "proofread",
        requireApproval: true,
        waitMs: 5000,
      },
      {
        createClient: async () => observingClient,
        now: () => Date.now(),
        sleep: (ms) => Bun.sleep(Math.min(ms, 10)),
        pollIntervalMs: 10,
      },
    );

    for (let attempt = 0; attempt < 100 && !createdId; attempt += 1) {
      await Bun.sleep(5);
    }
    expect(createdId).toBeTruthy();

    const revisionId = createHash("sha256").update(content).digest("hex");
    const response = await fetch(
      `http://127.0.0.1:${client.port}/w/${encodeURIComponent(opened.slug)}/inbox/${encodeURIComponent(createdId!)}/response`,
      {
        method: "POST",
        headers: {
          Host: `127.0.0.1:${client.port}`,
          Origin: `http://127.0.0.1:${client.port}`,
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ outcome: "approved", revision_id: revisionId }),
      },
    );
    expect(response.status).toBe(200);

    const result = await waiting;
    expect(result).toMatchObject({
      ok: true,
      exitCode: 0,
      data: {
        id: createdId,
        slug: opened.slug,
        status: "done",
        detail: {
          outcome: "approved",
          target_path: "draft.md",
          revision_id: revisionId,
        },
      },
    });
    const detail = result.data.detail;
    expect(detail && "completed_at" in detail ? Date.parse(detail.completed_at) : Number.NaN).not.toBeNaN();
  }, 20000);
});

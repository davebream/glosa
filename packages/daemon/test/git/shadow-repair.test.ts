// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  checkpoint,
  headSha,
  initShadowRepo,
  inspectShadowRepo,
  repairShadowBaseline,
  runGit,
  shadowJournalEvents,
} from "../../src/git/shadow.ts";
import { journalPath, shadowGitDir } from "../../src/bus/paths.ts";
import {
  claimTestDaemonIdentity,
  cleanupWorkspace,
  deterministicUlid,
  dropDaemonIdentity,
  freshWorkspace,
  testWriter,
  writeFile,
} from "./helpers.ts";

describe("explicit shadow baseline repair (#226)", () => {
  let root: string;
  let writer: ReturnType<typeof testWriter>;
  let ulid: ReturnType<typeof deterministicUlid>;
  let oldHead: string;
  beforeEach(async () => {
    root = freshWorkspace();
    writeFile(root, "draft.md", "Before.\n");
    writer = testWriter(root);
    ulid = deterministicUlid();
    await initShadowRepo(root, { writer, ulid });
    oldHead = await headSha(root);
    claimTestDaemonIdentity(root);
  });
  afterEach(() => {
    writer.close();
    dropDaemonIdentity();
    cleanupWorkspace(root);
  });
  function loseHead() {
    unlinkSync(join(shadowGitDir(root), "objects", oldHead.slice(0, 2), oldHead.slice(2)));
  }
  function repairs() {
    return shadowJournalEvents(root).filter(
      (event) => event.event === "baseline_checkpoint" && event.detail?.repair_id,
    );
  }

  test("diagnosis writes nothing and repair preserves surviving objects and records an unknown root", async () => {
    const tree = (await runGit(root, ["rev-parse", "HEAD^{tree}"])).stdout.trim();
    loseHead();
    writeFile(root, "draft.md", "Current bytes.\n");
    const before = readFileSync(journalPath(root));
    expect(await inspectShadowRepo(root)).toMatchObject({
      state: "lost-history",
      reason: "missing-head-object",
      head: oldHead,
    });
    expect(readFileSync(journalPath(root))).toEqual(before);
    expect(await headSha(root)).toBe(oldHead);
    const health = await repairShadowBaseline(root, { writer, ulid });
    expect(health.state).toBe("healthy");
    expect((await runGit(root, ["show", "HEAD:draft.md"])).stdout).toBe("Current bytes.\n");
    expect(readFileSync(join(root, "draft.md"), "utf8")).toBe("Current bytes.\n");
    expect((await runGit(root, ["cat-file", "-t", tree])).stdout.trim()).toBe("tree");
    expect((await runGit(root, ["rev-list", "--parents", "-n", "1", "HEAD"])).stdout.trim()).toBe(health.head!);
    expect((await runGit(root, ["show", "-s", "--format=%B", "HEAD"])).stdout).toContain("Glosa-Attribution: unknown");
    expect(repairs()).toHaveLength(1);
    expect(repairs()[0]?.detail).toMatchObject({ reason: "lost_history", checkpoint: health.head });
    expect(readFileSync(journalPath(root)).subarray(0, before.length)).toEqual(before);
  });

  test("repair refuses healthy history without changing its ref or journal", async () => {
    const before = readFileSync(journalPath(root));
    await expect(repairShadowBaseline(root, { writer, ulid })).rejects.toMatchObject({
      code: "SHADOW_ALREADY_HEALTHY",
    });
    expect(await headSha(root)).toBe(oldHead);
    expect(readFileSync(journalPath(root))).toEqual(before);
  });

  test("repair requires live singleton ownership before mutating Git", async () => {
    loseHead();
    dropDaemonIdentity();
    const before = readFileSync(journalPath(root));
    await expect(repairShadowBaseline(root, { writer, ulid })).rejects.toMatchObject({ code: "SHADOW_NOT_OWNER" });
    expect(await headSha(root)).toBe(oldHead);
    expect(readFileSync(journalPath(root))).toEqual(before);
  });

  test("a published repair without its reason blocks checkpoints and finalizes exactly once", async () => {
    loseHead();
    await expect(
      repairShadowBaseline(root, {
        writer,
        ulid,
        afterStep(step) {
          if (step === "ref-published") throw new Error("interrupted after ref");
        },
      }),
    ).rejects.toThrow("interrupted after ref");
    const published = await headSha(root);
    expect((await inspectShadowRepo(root)).state).toBe("repair-pending");
    expect(repairs()).toHaveLength(0);
    await expect(checkpoint(root, { attribution: "unknown", kind: "auto_checkpoint" })).rejects.toMatchObject({
      code: "SHADOW_REPAIR_PENDING",
    });
    await initShadowRepo(root, { writer, ulid });
    await initShadowRepo(root, { writer, ulid });
    expect(await headSha(root)).toBe(published);
    expect(repairs()).toHaveLength(1);
    expect(repairs()[0]?.detail?.repair_id).toEqual(repairs()[0]?.event_id);
    expect((await inspectShadowRepo(root)).state).toBe("healthy");
  });

  test("an interruption before ref publication leaves the old ref and is safely retryable", async () => {
    loseHead();
    await expect(
      repairShadowBaseline(root, {
        writer,
        ulid,
        afterStep(step) {
          if (step === "commit-created") throw new Error("interrupted before ref");
        },
      }),
    ).rejects.toThrow("interrupted before ref");
    expect(await headSha(root)).toBe(oldHead);
    expect(repairs()).toHaveLength(0);
    expect((await repairShadowBaseline(root, { writer, ulid })).state).toBe("healthy");
    expect(repairs()).toHaveLength(1);
  });

  test("repair commits the staged snapshot and a later checkpoint captures a racing external save", async () => {
    loseHead();
    await repairShadowBaseline(root, {
      writer,
      ulid,
      afterStep(step) {
        if (step === "index-staged") writeFile(root, "draft.md", "Racing final bytes.\n");
      },
    });
    expect((await runGit(root, ["show", "HEAD:draft.md"])).stdout).toBe("Before.\n");
    const repaired = await headSha(root);
    const after = await checkpoint(root, { attribution: "unknown", kind: "auto_checkpoint" });
    expect(after).not.toBe(repaired);
    expect((await runGit(root, ["show", "HEAD:draft.md"])).stdout).toBe("Racing final bytes.\n");
  });
  test("removing the entire objects directory retains the old ref as the repair CAS expectation", async () => {
    rmSync(join(shadowGitDir(root), "objects"), { recursive: true });
    expect(await inspectShadowRepo(root)).toMatchObject({ state: "lost-history", head: oldHead });
    expect((await repairShadowBaseline(root, { writer, ulid })).state).toBe("healthy");
    expect((await runGit(root, ["show", "HEAD:draft.md"])).stdout).toBe("Before.\n");
  });

  test("repair CAS refuses to overwrite a ref changed after staging", async () => {
    const survivor = (
      await runGit(root, [
        "-c",
        "user.name=fixture",
        "-c",
        "user.email=fixture@localhost",
        "commit-tree",
        "HEAD^{tree}",
        "-m",
        "surviving fixture commit",
      ])
    ).stdout.trim();
    loseHead();
    await expect(
      repairShadowBaseline(root, {
        writer,
        ulid,
        async afterStep(step) {
          if (step === "commit-created") await runGit(root, ["update-ref", "refs/heads/glosa", survivor, oldHead]);
        },
      }),
    ).rejects.toMatchObject({ code: "GIT_FAILED" });
    expect(await headSha(root)).toBe(survivor);
    expect(repairs()).toHaveLength(0);
  });
});

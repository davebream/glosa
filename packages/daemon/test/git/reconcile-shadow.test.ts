// SPDX-License-Identifier: Apache-2.0
// P2.3 — reconcile steps 4-5 wired to real shadow-git (A4 §F04 startup sequence, §F21 mechanics),
// exercised through the actual `reconcileWorkspace` entry point (not WorkspaceBus) — this is what
// runs at daemon startup. Covers the offline-catch-up story end to end, and proves steps 4-5 stay
// true no-ops (no git spawned at all) when there's nothing for them to do — the exact property
// P2.1's fault-injection sweep (reconcile-fault.test.ts) now leans on to stay fast.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { reconcileWorkspace } from "../../src/bus/reconcile.ts";
import { shadowGitDir, workspaceBusDir } from "../../src/bus/paths.ts";
import { runGit } from "../../src/git/shadow.ts";
import { cleanupWorkspace, deterministicUlid, freshWorkspace, writeFile } from "./helpers.ts";

describe("reconcile step 5 — offline catch-up", () => {
  let root: string;
  beforeEach(() => {
    root = freshWorkspace();
  });
  afterEach(() => {
    cleanupWorkspace(root);
  });

  test("a workspace with no tracked files and no shadow repo -> true no-op, no git spawned", async () => {
    const result = await reconcileWorkspace(root, { ulid: deterministicUlid(), now: () => new Date() });

    expect(result.offlineCatchup.occurred).toBe(false);
    expect(result.expiredLeaseIds).toEqual([]);
    expect(existsSync(shadowGitDir(root))).toBe(false); // never even initialized
  });

  test("first-ever reconcile with a tracked file: the baseline commit covers it, no separate offline_catchup", async () => {
    writeFile(root, "notes.md", "hello");
    const result = await reconcileWorkspace(root, { ulid: deterministicUlid(), now: () => new Date() });

    expect(existsSync(shadowGitDir(root))).toBe(true);
    expect(result.offlineCatchup.occurred).toBe(false); // baseline already captured "hello"
    const body = (await runGit(root, ["show", "-s", "--format=%B", "HEAD"])).stdout;
    expect(body).toContain("Glosa-Kind: baseline");
  });

  test("a file edited while the daemon was down (no lease) is captured as an unknown-attributed auto_checkpoint + offline_catchup event", async () => {
    writeFile(root, "notes.md", "v1");
    await reconcileWorkspace(root, { ulid: deterministicUlid(), now: () => new Date() }); // baseline

    writeFile(root, "notes.md", "v2, edited with the daemon down");
    const result = await reconcileWorkspace(root, { ulid: deterministicUlid(500_000), now: () => new Date() });

    expect(result.offlineCatchup.occurred).toBe(true);
    expect(result.offlineCatchup.preSha).toBeTruthy();
    expect(result.offlineCatchup.postSha).toBeTruthy();
    expect(result.offlineCatchup.postSha).not.toBe(result.offlineCatchup.preSha);

    const body = (await runGit(root, ["show", "-s", "--format=%B", result.offlineCatchup.postSha as string])).stdout;
    expect(body).toContain("Glosa-Attribution: unknown");
    expect(body).toContain("Glosa-Kind: auto_checkpoint");

    const content = (await runGit(root, ["show", "HEAD:notes.md"])).stdout;
    expect(content).toBe("v2, edited with the daemon down");
  });

  test("running reconcile again with no further drift is idempotent — no new commit, no repeated offline_catchup", async () => {
    writeFile(root, "notes.md", "v1");
    await reconcileWorkspace(root, { ulid: deterministicUlid(), now: () => new Date() });
    writeFile(root, "notes.md", "v2");
    const first = await reconcileWorkspace(root, { ulid: deterministicUlid(500_000), now: () => new Date() });
    expect(first.offlineCatchup.occurred).toBe(true);

    const countAfterFirst = (await runGit(root, ["rev-list", "--count", "HEAD"])).stdout.trim();
    const second = await reconcileWorkspace(root, { ulid: deterministicUlid(900_000), now: () => new Date() });
    expect(second.offlineCatchup.occurred).toBe(false);
    const countAfterSecond = (await runGit(root, ["rev-list", "--count", "HEAD"])).stdout.trim();
    expect(countAfterSecond).toBe(countAfterFirst);
  });

  // #38 (github): a real drain in production came back as an unhandled 500 for a session the
  // daemon HAD registered — traced to this step: offline catch-up is best-effort drift provenance
  // (attributed "unknown"), not a delivery dependency, but a failure here (broken git toolchain,
  // permission issue, corrupted shadow repo) was propagating all the way up through
  // resolveBus()/handleSessionDrain and taking the whole workspace bus down with it.
  test("a broken shadow-git bootstrap does not fail reconcile — journal-backed state stays usable", async () => {
    writeFile(root, "notes.md", "hello");
    // Force initShadowRepo's mkdirSync(shadowGitDir(root)) to fail deterministically, without
    // relying on permission bits (which behave inconsistently for a root-run CI container): put a
    // plain file where step 5 expects to create the shadow-git directory.
    mkdirSync(workspaceBusDir(root), { recursive: true });
    writeFileSync(shadowGitDir(root), "not a directory");

    const result = await reconcileWorkspace(root, { ulid: deterministicUlid(), now: () => new Date() });

    expect(result.offlineCatchup.occurred).toBe(false);
    expect(result.offlineCatchup.error).toBeTruthy();
    expect(result.state).toBeDefined(); // reconcile completed — did not throw
  });
});

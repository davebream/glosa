// SPDX-License-Identifier: Apache-2.0
// Issue #281 criterion 3 — the rare `nlink > 1` hardlink-alias scan runs off the main thread inside
// the existing global index mutex, with a bounded deadline, guaranteed Worker cleanup, and live
// revalidation before any reuse. Every test here drives the REAL `WorkspaceIndex` and (except the
// two deterministic failure-reply cases) the REAL production `hardlink-alias-worker.ts` — no scan
// logic is faked, only its outcome is forced via a tiny deadline or a canned-reply fixture.
import { existsSync, linkSync, mkdirSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { WorkspaceIndex } from "../../src/registry/workspace-index.ts";
import { cleanup, freshHome, freshWorkspaceDir } from "./helpers.ts";

function bigDirWithFiles(n: number): string {
  const root = freshWorkspaceDir();
  for (let i = 0; i < n; i++) writeFileSync(join(root, `f${i}.md`), "x");
  return root;
}

describe("issue #281 — nlink === 1 skips hardlink discovery entirely", () => {
  test("an ordinary single-link file never invokes the alias-scan Worker at all", async () => {
    const home = freshHome();
    const dir = freshWorkspaceDir();
    const other = freshWorkspaceDir();
    writeFileSync(join(other, "note.md"), "hi"); // a non-empty prior registration, so `tasks` would
    // be non-empty (and a Worker WOULD be constructed) if the nlink shortcut were ever skipped.
    const file = join(dir, "doc.md");
    writeFileSync(file, "hello"); // nlink === 1, no owning directory

    // If the nlink shortcut were skipped, the scan would try to reach this deliberately-broken
    // Worker URL and fail the open closed. Success here proves the Worker was never constructed.
    const index = new WorkspaceIndex({ home, aliasScanWorkerUrl: "this-worker-does-not-exist" });
    await index.resolveOpenTarget(join(other, "note.md"));
    const result = await index.resolveOpenTarget(file);
    expect(result.entry.kind).toBe("loose-file");
    expect(result.focus).toBe("doc.md");

    cleanup(home);
    cleanup(dir);
    cleanup(other);
  });
});

describe("issue #281 — hardlink-alias scan: responsiveness and convergence", () => {
  test("the main thread's event loop keeps running while a large real scan is in flight", async () => {
    const home = freshHome();
    const bigRoot = bigDirWithFiles(16_000);
    const aliasDir = freshWorkspaceDir();
    const target = join(bigRoot, "target.md");
    writeFileSync(target, "hi");
    const alias = join(aliasDir, "alias.md");
    linkSync(target, alias);

    const index = new WorkspaceIndex({ home });
    await index.resolveOpenTarget(bigRoot); // the only prior registration

    let heartbeats = 0;
    const timer = setInterval(() => heartbeats++, 5);
    const result = await index.resolveOpenTarget(alias);
    clearInterval(timer);

    expect(result.entry.kind).toBe("directory");
    expect(result.focus).toBe("target.md");
    // A blocked event loop would starve this counter; a genuinely async scan lets many ticks land.
    expect(heartbeats).toBeGreaterThan(3);

    cleanup(home);
    cleanup(bigRoot);
    cleanup(aliasDir);
  }, 20_000);

  test("concurrent opens of two different hardlink aliases converge on one registration and representative focus", async () => {
    const home = freshHome();
    const root = freshWorkspaceDir();
    const representative = join(root, "representative.md");
    const aliasA = join(root, "alias-a.md");
    const aliasB = join(root, "alias-b.md");
    writeFileSync(representative, "shared");
    linkSync(representative, aliasA);
    linkSync(representative, aliasB);

    const index = new WorkspaceIndex({ home });
    const [first, second, third] = await Promise.all([
      index.resolveOpenTarget(representative),
      index.resolveOpenTarget(aliasA),
      index.resolveOpenTarget(aliasB),
    ]);

    expect(second.entry.registration_id).toBe(first.entry.registration_id);
    expect(third.entry.registration_id).toBe(first.entry.registration_id);
    expect(second.entry.bus_path).toBe(first.entry.bus_path);
    expect(third.entry.bus_path).toBe(first.entry.bus_path);
    expect(second.focus).toBe("representative.md");
    expect(third.focus).toBe("representative.md");
    expect(index.list()).toHaveLength(1);

    cleanup(home);
    cleanup(root);
  });
});

describe("issue #281 — hardlink-alias scan: timeout and Worker failure fail closed", () => {
  test("an initial target snapshot that races away returns a stable open error without constructing a Worker", async () => {
    const home = freshHome();
    const dir = freshWorkspaceDir();
    const target = join(dir, "target.md");
    const alias = join(dir, "alias.md");
    writeFileSync(target, "shared");
    linkSync(target, alias);
    let workers = 0;
    const index = new WorkspaceIndex({
      home,
      regularFileSnapshot: () => null,
      aliasScanWorkerFactory: () => {
        workers += 1;
        throw new Error("must not construct");
      },
    });

    await expect(index.resolveOpenTarget(alias)).rejects.toMatchObject({ code: "alias-discovery-unavailable" });
    expect(workers).toBe(0);
    expect(index.list()).toEqual([]);

    cleanup(home);
    cleanup(dir);
  });

  test("a scan that cannot finish within its deadline fails the open closed, persists nothing, and releases the mutex", async () => {
    const home = freshHome();
    const dir = freshWorkspaceDir();
    const target = join(dir, "target.md");
    writeFileSync(target, "hi");
    const alias = join(dir, "alias.md");
    linkSync(target, alias);
    const other = freshWorkspaceDir();
    writeFileSync(join(other, "note.md"), "hi");

    const silentWorker = {
      onmessage: null,
      onerror: null,
      postMessage: () => {},
      terminate: () => {},
    } as unknown as Worker;
    const index = new WorkspaceIndex({
      home,
      aliasScanDeadlineMs: 1,
      aliasScanWorkerFactory: () => silentWorker,
    });
    await index.resolveOpenTarget(target); // the only prior registration

    let caught: unknown = null;
    try {
      await index.resolveOpenTarget(alias);
    } catch (err) {
      caught = err;
    }
    expect((caught as { code?: string } | null)?.code).toBe("alias-discovery-unavailable");
    expect(index.list().some((e) => e.canonical_path === alias)).toBe(false);

    // The mutex was released, not left held by the failed attempt — an unrelated call after it
    // still completes normally.
    const after = await index.resolveOpenTarget(join(other, "note.md"));
    expect(after.entry.kind).toBe("loose-file");

    cleanup(home);
    cleanup(dir);
    cleanup(other);
  }, 20_000);

  test("repeated stale replies share one end-to-end deadline instead of resetting it per retry", async () => {
    const home = freshHome();
    const dir = freshWorkspaceDir();
    const target = join(dir, "target.md");
    const alias = join(dir, "alias.md");
    writeFileSync(target, "shared");
    linkSync(target, alias);
    const other = freshWorkspaceDir();
    writeFileSync(join(other, "other.md"), "other");
    let workers = 0;

    const index = new WorkspaceIndex({
      home,
      aliasScanDeadlineMs: 25,
      aliasScanWorkerFactory: () => {
        workers += 1;
        const fake: {
          onmessage: ((event: MessageEvent) => void) | null;
          onerror: null;
          postMessage: () => void;
          terminate: () => void;
        } = {
          onmessage: null,
          onerror: null,
          postMessage: () => {
            setTimeout(
              () =>
                fake.onmessage?.({
                  data: { status: "found", registrationId: "stale", focus: "none.md" },
                } as MessageEvent),
              15,
            );
          },
          terminate: () => {},
        };
        return fake as unknown as Worker;
      },
    });
    await index.resolveOpenTarget(target);

    const started = performance.now();
    await expect(index.resolveOpenTarget(alias)).rejects.toMatchObject({ code: "alias-discovery-unavailable" });
    const elapsed = performance.now() - started;
    expect(workers).toBe(2); // second attempt gets only the first attempt's remaining budget
    expect(elapsed).toBeLessThan(100);
    expect(index.list().some((entry) => entry.canonical_path === alias)).toBe(false);
    expect((await index.resolveOpenTarget(join(other, "other.md"))).entry.kind).toBe("loose-file");

    cleanup(home);
    cleanup(dir);
    cleanup(other);
  });

  test("a found reply that crosses the absolute deadline during revalidation is not persisted", async () => {
    const home = freshHome();
    const dir = freshWorkspaceDir();
    const other = freshWorkspaceDir();
    const target = join(dir, "target.md");
    const alias = join(dir, "alias.md");
    writeFileSync(target, "shared");
    writeFileSync(join(other, "other.md"), "other");
    let clockValues = [0];
    let registrationId = "";
    let terminations = 0;
    const fake: {
      onmessage: ((event: MessageEvent) => void) | null;
      onerror: null;
      postMessage: () => void;
      terminate: () => void;
    } = {
      onmessage: null,
      onerror: null,
      postMessage: () => {
        setImmediate(() =>
          fake.onmessage?.({
            data: { status: "found", registrationId, focus: "target.md" },
          } as MessageEvent),
        );
      },
      terminate: () => {
        terminations += 1;
      },
    };
    const index = new WorkspaceIndex({
      home,
      aliasScanDeadlineMs: 25,
      aliasScanClock: () => clockValues.shift() ?? 30,
      aliasScanWorkerFactory: () => fake as unknown as Worker,
    });
    registrationId = (await index.resolveOpenTarget(target)).entry.registration_id;
    linkSync(target, alias);
    // deadline origin, pre-Worker remaining budget, post-Worker check, then post-revalidation
    // persistence check. The final check crosses the one absolute deadline.
    clockValues = [0, 1, 2, 30];

    await expect(index.resolveOpenTarget(alias)).rejects.toMatchObject({ code: "alias-discovery-unavailable" });
    expect(terminations).toBe(1);
    expect(index.list().some((entry) => entry.canonical_path === alias)).toBe(false);
    expect((await index.resolveOpenTarget(join(other, "other.md"))).entry.kind).toBe("loose-file");

    cleanup(home);
    cleanup(dir);
    cleanup(other);
  });

  test("a not-found reply that crosses the absolute deadline during revalidation cannot create a registration", async () => {
    const home = freshHome();
    const dir = freshWorkspaceDir();
    const other = freshWorkspaceDir();
    const target = join(dir, "target.md");
    const alias = join(dir, "alias.md");
    writeFileSync(target, "shared");
    writeFileSync(join(other, "other.md"), "other");
    let clockValues = [0];
    let terminations = 0;
    const fake: {
      onmessage: ((event: MessageEvent) => void) | null;
      onerror: null;
      postMessage: () => void;
      terminate: () => void;
    } = {
      onmessage: null,
      onerror: null,
      postMessage: () => {
        setImmediate(() => fake.onmessage?.({ data: { status: "not_found" } } as MessageEvent));
      },
      terminate: () => {
        terminations += 1;
      },
    };
    const index = new WorkspaceIndex({
      home,
      aliasScanDeadlineMs: 25,
      aliasScanClock: () => clockValues.shift() ?? 30,
      aliasScanWorkerFactory: () => fake as unknown as Worker,
    });
    await index.resolveOpenTarget(target);
    linkSync(target, alias);
    clockValues = [0, 1, 2, 30];

    await expect(index.resolveOpenTarget(alias)).rejects.toMatchObject({ code: "alias-discovery-unavailable" });
    expect(terminations).toBe(1);
    expect(index.list().some((entry) => entry.canonical_path === alias)).toBe(false);
    expect((await index.resolveOpenTarget(join(other, "other.md"))).entry.kind).toBe("loose-file");

    cleanup(home);
    cleanup(dir);
    cleanup(other);
  });

  test("a Worker that reports a clean error fails the open closed with that reason", async () => {
    const home = freshHome();
    const dir = freshWorkspaceDir();
    const aliasDir = freshWorkspaceDir();
    const target = join(dir, "target.md");
    writeFileSync(target, "hi");
    const alias = join(aliasDir, "alias.md");
    linkSync(target, alias);

    const errorWorker: {
      onmessage: ((event: MessageEvent) => void) | null;
      onerror: null;
      postMessage: () => void;
      terminate: () => void;
    } = {
      onmessage: null,
      onerror: null,
      postMessage: () => {
        setImmediate(() =>
          errorWorker.onmessage?.({
            data: { status: "error", message: "simulated hardlink-alias worker failure" },
          } as MessageEvent),
        );
      },
      terminate: () => {},
    };
    const index = new WorkspaceIndex({
      home,
      aliasScanWorkerFactory: () => errorWorker as unknown as Worker,
    });
    await index.resolveOpenTarget(dir); // deterministic matcher-mode candidate for the Worker

    let caught: unknown = null;
    try {
      await index.resolveOpenTarget(alias);
    } catch (err) {
      caught = err;
    }
    const err = caught as { code?: string; message?: string } | null;
    expect(err?.code).toBe("alias-discovery-unavailable");
    expect(err?.message).toContain("simulated hardlink-alias worker failure");
    expect(index.list().some((e) => e.canonical_path === alias)).toBe(false);

    cleanup(home);
    cleanup(dir);
    cleanup(aliasDir);
  });

  test("a synchronous Worker construction failure is caught on the main thread and fails closed", async () => {
    const home = freshHome();
    const dir = freshWorkspaceDir();
    const target = join(dir, "target.md");
    writeFileSync(target, "hi");

    const index = new WorkspaceIndex({
      home,
      aliasScanWorkerFactory: () => {
        throw new Error("worker construction failed");
      },
    });
    await index.resolveOpenTarget(dir);
    const internals = index as unknown as {
      load(): unknown;
      scanForHardlinkAlias(
        stored: unknown,
        identity: { dev: string; ino: string },
        owning: undefined,
        deadlineMs: number,
      ): Promise<{ status: string; message?: string }>;
    };
    const result = await internals.scanForHardlinkAlias(
      internals.load(),
      { dev: "fixture-dev", ino: "fixture-ino" },
      undefined,
      100,
    );
    expect(result).toEqual({ status: "error", message: "worker construction failed" });

    cleanup(home);
    cleanup(dir);
  });

  test("a synchronous Worker post failure is normalized at the scan boundary", async () => {
    const home = freshHome();
    const dir = freshWorkspaceDir();
    const target = join(dir, "target.md");
    writeFileSync(target, "hi");

    const fake = {
      onmessage: null,
      onerror: null,
      postMessage: () => {
        throw new Error("synchronous post failure");
      },
      terminate: () => {},
    } as unknown as Worker;
    const index = new WorkspaceIndex({ home, aliasScanWorkerFactory: () => fake });
    await index.resolveOpenTarget(dir);
    const internals = index as unknown as {
      load(): unknown;
      scanForHardlinkAlias(
        stored: unknown,
        identity: { dev: string; ino: string },
        owning: undefined,
        deadlineMs: number,
      ): Promise<{ status: string; message?: string }>;
    };
    const result = await internals.scanForHardlinkAlias(
      internals.load(),
      { dev: "fixture-dev", ino: "fixture-ino" },
      undefined,
      100,
    );
    expect(result).toEqual({ status: "error", message: "synchronous post failure" });

    cleanup(home);
    cleanup(dir);
  });
});

describe("issue #281 — hardlink-alias scan: staleness during scanning", () => {
  for (const reply of ["found", "not_found"] as const) {
    test(`a ${reply} reply cannot accept a target replaced by a symlink during the Worker wait`, async () => {
      const home = freshHome();
      const dir = freshWorkspaceDir();
      const other = freshWorkspaceDir();
      const target = join(dir, "target.md");
      const alias = join(dir, "alias.md");
      writeFileSync(target, "shared");
      writeFileSync(join(other, "other.md"), "other");
      let registrationId = "";
      let terminations = 0;
      const fake: {
        onmessage: ((event: MessageEvent) => void) | null;
        onerror: null;
        postMessage: () => void;
        terminate: () => void;
      } = {
        onmessage: null,
        onerror: null,
        postMessage: () => {
          setImmediate(() => {
            unlinkSync(alias);
            symlinkSync(target, alias);
            fake.onmessage?.({
              data:
                reply === "found" ? { status: "found", registrationId, focus: "target.md" } : { status: "not_found" },
            } as MessageEvent);
          });
        },
        terminate: () => {
          terminations += 1;
        },
      };
      const index = new WorkspaceIndex({ home, aliasScanWorkerFactory: () => fake as unknown as Worker });
      registrationId = (await index.resolveOpenTarget(target)).entry.registration_id;
      linkSync(target, alias);

      await expect(index.resolveOpenTarget(alias)).rejects.toMatchObject({ code: "alias-discovery-unavailable" });
      expect(terminations).toBe(1);
      expect(index.list().some((entry) => entry.canonical_path === alias)).toBe(false);
      expect((await index.resolveOpenTarget(join(other, "other.md"))).entry.kind).toBe("loose-file");

      cleanup(home);
      cleanup(dir);
      cleanup(other);
    });
  }

  test("a not-found answer is retried when the target changes before the reply is consumed", async () => {
    const home = freshHome();
    const dir = freshWorkspaceDir();
    const target = join(dir, "target.md");
    const alias = join(dir, "alias.md");
    writeFileSync(target, "shared");
    linkSync(target, alias);
    let replaced = false;
    const fake: {
      onmessage: ((event: MessageEvent) => void) | null;
      onerror: null;
      postMessage: () => void;
      terminate: () => void;
    } = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      onerror: null,
      postMessage: () => {
        setImmediate(() => {
          if (!replaced) {
            replaced = true;
            unlinkSync(alias);
            writeFileSync(alias, "new inode");
          }
          fake.onmessage?.({ data: { status: "not_found" } } as MessageEvent);
        });
      },
      terminate: () => {},
    };
    const index = new WorkspaceIndex({ home, aliasScanWorkerFactory: () => fake as unknown as Worker });
    const original = await index.resolveOpenTarget(target);

    const result = await index.resolveOpenTarget(alias);
    expect(result.entry.kind).toBe("loose-file");
    expect(result.entry.registration_id).not.toBe(original.entry.registration_id);
    expect(index.list()).toHaveLength(2);

    cleanup(home);
    cleanup(dir);
  });

  test("the open target itself is replaced mid-scan: the stale alias answer is rejected and a fresh loose-file registration is created instead", async () => {
    const home = freshHome();
    const bigRoot = bigDirWithFiles(16_000);
    const aliasDir = freshWorkspaceDir();
    const target = join(bigRoot, "target.md");
    writeFileSync(target, "hi");
    const alias = join(aliasDir, "alias.md");
    linkSync(target, alias);

    const index = new WorkspaceIndex({ home });
    await index.resolveOpenTarget(bigRoot);

    setTimeout(() => {
      // Mid-scan: alias's inode is replaced by an unrelated fresh file at the same path.
      unlinkSync(alias);
      writeFileSync(alias, "replaced-content");
    }, 15);

    const result = await index.resolveOpenTarget(alias);
    // The pre-replacement identity (shared with bigRoot/target.md) must NOT be reused — the
    // revalidation catches the change and the retry sees a fresh nlink === 1 file.
    expect(result.entry.kind).toBe("loose-file");
    expect(result.entry.canonical_path).toBe(join(realpathSync.native(aliasDir), "alias.md"));
    expect(index.list()).toHaveLength(2); // bigRoot's directory entry + alias's own fresh loose-file entry

    cleanup(home);
    cleanup(bigRoot);
    cleanup(aliasDir);
  }, 20_000);

  test("the winning candidate file is replaced mid-scan: the stale match is rejected and retried safely", async () => {
    const home = freshHome();
    const root = freshWorkspaceDir();
    const aliasDir = freshWorkspaceDir();
    const target = join(root, "target.md");
    writeFileSync(target, "hi");
    const alias = join(aliasDir, "alias.md");
    linkSync(target, alias);
    let registrationId = "";
    const fake: {
      onmessage: ((event: MessageEvent) => void) | null;
      onerror: null;
      postMessage: () => void;
      terminate: () => void;
    } = {
      onmessage: null,
      onerror: null,
      postMessage: () => {
        setImmediate(() => {
          // Mid-scan: the CANDIDATE is replaced. `alias`'s own inode then has nlink === 1.
          unlinkSync(target);
          writeFileSync(target, "replaced-content");
          fake.onmessage?.({
            data: { status: "found", registrationId, focus: "target.md" },
          } as MessageEvent);
        });
      },
      terminate: () => {},
    };
    const index = new WorkspaceIndex({ home, aliasScanWorkerFactory: () => fake as unknown as Worker });
    registrationId = (await index.resolveOpenTarget(root)).entry.registration_id;

    const result = await index.resolveOpenTarget(alias);
    expect(result.entry.kind).toBe("loose-file");
    expect(result.entry.canonical_path).toBe(join(realpathSync.native(aliasDir), "alias.md"));

    cleanup(home);
    cleanup(root);
    cleanup(aliasDir);
  });
});

describe("a hard-linked file keeps the name it was opened by", () => {
  // macOS realpath(3) names a multiply-linked file by whichever link the kernel has cached for the
  // inode, so realpath(alias) can answer with a sibling link in another directory. The real kernel
  // does that only occasionally, so this seam answers the way it does when it happens. Directories
  // are realpath'd up front: the daemon asks about the canonical path, never the `/var` spelling.
  function misnamingRealpath(from: string, to: string): (path: string) => string {
    return (path) => (path === from ? realpathSync.native(to) : realpathSync.native(path));
  }

  test("opening an alias whose realpath names another link registers the alias's own path", async () => {
    const home = freshHome();
    const targetDir = realpathSync.native(freshWorkspaceDir());
    const aliasDir = realpathSync.native(freshWorkspaceDir());
    const target = join(targetDir, "target.md");
    const alias = join(aliasDir, "alias.md");
    writeFileSync(target, "shared");
    linkSync(target, alias);
    const index = new WorkspaceIndex({ home, realpath: misnamingRealpath(alias, target) });

    const result = await index.resolveOpenTarget(alias);
    expect(result.entry.kind).toBe("loose-file");
    expect(result.entry.canonical_path).toBe(join(aliasDir, "alias.md"));
    expect(result.entry.worktree_path).toBe(aliasDir);
    expect(result.focus).toBe("alias.md");

    cleanup(home);
    cleanup(targetDir);
    cleanup(aliasDir);
  });

  test("a hard-linked focus file whose realpath names a link outside the workspace still opens inside it", async () => {
    const home = freshHome();
    const outside = realpathSync.native(freshWorkspaceDir());
    const workspace = realpathSync.native(freshWorkspaceDir());
    const target = join(outside, "target.md");
    const alias = join(workspace, "alias.md");
    writeFileSync(target, "shared");
    linkSync(target, alias);
    const index = new WorkspaceIndex({ home, realpath: misnamingRealpath(alias, target) });

    const result = await index.resolveOpenTarget(workspace, { focus: "alias.md" });
    expect(result.entry.kind).toBe("directory");
    expect(result.focus).toBe("alias.md");

    cleanup(home);
    cleanup(outside);
    cleanup(workspace);
  });

  test("a misnamed alias opened with the wrong letter case resolves to its on-disk name", async () => {
    const home = freshHome();
    const targetDir = realpathSync.native(freshWorkspaceDir());
    const aliasDir = realpathSync.native(freshWorkspaceDir());
    const target = join(targetDir, "target.md");
    const alias = join(aliasDir, "alias.md");
    writeFileSync(target, "shared");
    linkSync(target, alias);
    const typed = join(aliasDir, "ALIAS.md");
    // Glosa v1 is macOS-only, whose default APFS volume is case-insensitive.
    expect(existsSync(typed)).toBe(true);
    const index = new WorkspaceIndex({ home, realpath: misnamingRealpath(typed, target) });

    const result = await index.resolveOpenTarget(typed);
    expect(result.entry.canonical_path).toBe(join(aliasDir, "alias.md"));
    expect(result.focus).toBe("alias.md");

    cleanup(home);
    cleanup(targetDir);
    cleanup(aliasDir);
  });
});

describe("issue #281 — hardlink-alias scan ignores non-active registrations", () => {
  async function exerciseCandidateLifecycle(commit: boolean): Promise<void> {
    const home = freshHome();
    const sourceDir = freshWorkspaceDir();
    const aliasDir = freshWorkspaceDir();
    const source = join(sourceDir, "source.md");
    const alias = join(aliasDir, "alias.md");
    writeFileSync(source, "shared");
    const index = new WorkspaceIndex({ home });

    // Register the source while it is still an ordinary single-link file. The behavior under test
    // starts only after that registration becomes inactive and a new hardlink needs discovery.
    const loose = await index.resolveOpenTarget(source);
    mkdirSync(loose.entry.bus_path, { recursive: true });
    const target = await index.resolveOpenTarget(sourceDir);
    const adoption = await index.beginAdoption(target.entry);
    expect(adoption?.sources.map((candidate) => candidate.registration_id)).toContain(loose.entry.registration_id);
    // Keep the active target registration from legitimately claiming source.md. The inactive
    // loose registration is then the only possible stale alias candidate.
    mkdirSync(join(sourceDir, ".glosa"), { recursive: true });
    writeFileSync(join(sourceDir, ".glosa", "config.json"), JSON.stringify({ artifacts: { exclude: ["source.md"] } }));
    if (commit) await index.commitAdoption(adoption!.adoption_id);

    linkSync(source, alias);
    const opened = await index.resolveOpenTarget(alias);
    expect(opened.entry.kind).toBe("loose-file");
    expect(opened.entry.registration_id).not.toBe(loose.entry.registration_id);

    cleanup(home);
    cleanup(sourceDir);
    cleanup(aliasDir);
  }

  test("an adopting alias candidate is not revived", () => exerciseCandidateLifecycle(false));
  test("an adopted alias candidate is not revived", () => exerciseCandidateLifecycle(true));
});

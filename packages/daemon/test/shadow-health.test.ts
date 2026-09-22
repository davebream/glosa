// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AdoptionCoordinator } from "../src/adoption.ts";
import { WorkspaceBus } from "../src/bus/bus.ts";
import { readInboxEntry, writeInboxEntryOnce } from "../src/bus/inbox.ts";
import { appendEvent, JournalWriter } from "../src/bus/journal.ts";
import { KeyedMutex } from "../src/bus/mutex.ts";
import { inboxEntryPath, journalPath, shadowGitDir } from "../src/bus/paths.ts";
import { peekJournal } from "../src/bus/peek.ts";
import { WorkspaceBusRegistry } from "../src/bus/workspace-bus-registry.ts";
import { checkpoint, headSha, runGit, shadowJournalEvents } from "../src/git/shadow.ts";
import { WorkspaceIndex, type WorkspaceEntry } from "../src/registry/workspace-index.ts";
import { SessionRegistry } from "../src/registry/session-registry.ts";
import { canonicalize } from "../src/registry/slug.ts";
import { CapabilityStore } from "../src/security/capability.ts";
import { repairBaseline, shadowHealth, type ShadowAccess } from "../src/services/shadow.ts";
import { createApiFetch } from "../src/transport/http.ts";
import {
  claimTestDaemonIdentity,
  cleanupWorkspace,
  deterministicUlid,
  dropDaemonIdentity,
  freshWorkspace,
  writeFile,
} from "./git/helpers.ts";

describe("shadow health and repair boundary (#226)", () => {
  let root: string;
  let home: string;
  let index: WorkspaceIndex;
  let registry: WorkspaceBusRegistry;
  let entry: WorkspaceEntry;
  let deps: ShadowAccess;
  const ids = deterministicUlid();
  beforeEach(async () => {
    root = canonicalize(freshWorkspace());
    home = canonicalize(freshWorkspace());
    writeFile(root, "draft.md", "One.\n");
    index = new WorkspaceIndex({ home, userHomeDir: home });
    registry = new WorkspaceBusRegistry();
    entry = await index.upsertWorkspace(root, "glosa-open");
    deps = {
      home,
      workspaceIndex: index,
      getWorkspaceBus: (target) => registry.get(target),
      adoptionCoordinator: new AdoptionCoordinator(),
    };
    claimTestDaemonIdentity(home);
  });
  afterEach(async () => {
    await registry.closeAll();
    dropDaemonIdentity();
    cleanupWorkspace(root);
    cleanupWorkspace(home);
  });
  async function loseHead(target = entry) {
    await registry.get(target).reconcile();
    const sha = await headSha(target);
    unlinkSync(join(shadowGitDir(target), "objects", sha.slice(0, 2), sha.slice(2)));
    return sha;
  }

  test("HTTP diagnosis creates no bus and authenticated explicit repair restores later external capture", async () => {
    const fetch = createApiFetch({
      ...deps,
      workspaceIndex: index,
      port: 4646,
      classFPort: 4647,
      token: "fixture-token",
      instanceId: "fixture",
      startedAt: new Date().toISOString(),
      sessionRegistry: new SessionRegistry({ index }),
      capabilityStore: new CapabilityStore(),
    });
    const request = (method: string, action: string, body?: string, auth = true, origin = true) =>
      new Request(`http://127.0.0.1:4646/w/${entry.slug}/shadow/${action}`, {
        method,
        headers: {
          Host: "127.0.0.1:4646",
          ...(auth ? { Authorization: "Bearer fixture-token" } : {}),
          ...(origin ? { Origin: "http://127.0.0.1:4646" } : {}),
        },
        body,
      });
    expect((await fetch(request("GET", "health", undefined, false))).status).toBe(401);
    expect((await fetch(request("GET", "health"))).status).toBe(200);
    expect(registry.has(entry)).toBe(false);
    expect(existsSync(entry.bus_path)).toBe(false);
    await loseHead();
    const before = readFileSync(journalPath(entry));
    const diagnosis = await (await fetch(request("GET", "health"))).json();
    expect(diagnosis.state).toBe("lost-history");
    expect(readFileSync(journalPath(entry))).toEqual(before);
    expect((await fetch(request("POST", "repair-baseline", "{}", true, false))).status).toBe(403);
    expect((await fetch(request("POST", "repair-baseline", '{"force":true}'))).status).toBe(400);
    expect((await fetch(request("POST", "repair-baseline", "{}"))).status).toBe(200);
    writeFile(root, "draft.md", "Two.\n");
    expect((await registry.get(entry).captureExternalEdit()).committed).toBe(true);
    const payloads = Object.keys(peekJournal(entry).state.entries).map(
      (id) => readInboxEntry(entry, id) as { kind: string },
    );
    expect(payloads.map((p) => p.kind)).toEqual(["external_edit"]);
    expect((await runGit(entry, ["show", "HEAD:draft.md"])).stdout).toBe("Two.\n");
  });

  test("corrupt history refuses a human save before document bytes are changed", async () => {
    await loseHead();
    const before = readFileSync(journalPath(entry));
    await expect(
      registry.get(entry).captureHumanEdit(ids(), "draft.md", () => writeFile(root, "draft.md", "Wrong.\n")),
    ).rejects.toMatchObject({ code: "SHADOW_HISTORY_LOST" });
    expect(readFileSync(join(root, "draft.md"), "utf8")).toBe("One.\n");
    expect(readFileSync(journalPath(entry))).toEqual(before);
  });

  test("census counts entries once, keeps disconnected objects readable, and qualifies missing payloads", async () => {
    await registry.get(entry).reconcile();
    const old = await headSha(entry);
    writeFile(root, "draft.md", "Two.\n");
    const lost = await checkpoint(entry, { kind: "auto_checkpoint", attribution: "unknown" });
    const writer = new JournalWriter(journalPath(entry));
    const missingId = ids();
    const intactId = ids();
    const unknownId = ids();
    for (const [id, before, after] of [
      [missingId, lost, lost],
      [intactId, old, old],
    ]) {
      writeInboxEntryOnce(entry, id!, { kind: "human_edit", checkpoint_before: before, checkpoint_after: after });
      appendEvent(writer, {
        v: 1,
        event_id: ids(),
        at: new Date().toISOString(),
        event: "entry_created",
        by: "daemon",
        entry: id,
        detail: { payload_kind: "human_edit" },
      });
    }
    appendEvent(writer, {
      v: 1,
      event_id: ids(),
      at: new Date().toISOString(),
      event: "entry_created",
      by: "daemon",
      entry: unknownId,
    });
    writer.close();
    unlinkSync(join(shadowGitDir(entry), "objects", lost.slice(0, 2), lost.slice(2)));
    const journal = readFileSync(journalPath(entry));
    const inbox = readFileSync(inboxEntryPath(entry, missingId));
    expect((await shadowHealth(deps, entry.slug)).census).toEqual({
      entries: 3,
      missing_checkpoint_entries: 1,
      unassessable_entries: 1,
      complete: false,
    });
    await repairBaseline(deps, entry.slug);
    expect((await shadowHealth(deps, entry.slug)).census.missing_checkpoint_entries).toBe(1);
    expect(readFileSync(journalPath(entry)).subarray(0, journal.length)).toEqual(journal);
    expect(readFileSync(inboxEntryPath(entry, missingId))).toEqual(inbox);
    expect((await runGit(entry, ["cat-file", "-t", old])).stdout.trim()).toBe("commit");
  });

  test("restart recovers a post-repair checkpoint before inbox publication despite a lost old frontier", async () => {
    const bus = registry.get(entry);
    await bus.reconcile();
    writeFile(root, "draft.md", "Two.\n");
    await bus.captureExternalEdit();
    const oldIds = Object.keys(bus.state.entries);
    await loseHead();
    await repairBaseline(deps, entry.slug);
    writeFile(root, "draft.md", "Three.\n");
    const captured = await checkpoint(entry, { attribution: "unknown", kind: "auto_checkpoint" });
    await registry.close(entry);
    await registry.get(entry).reconcile();
    const newIds = Object.keys(registry.get(entry).state.entries).filter((id) => !oldIds.includes(id));
    expect(newIds).toHaveLength(1);
    expect(readInboxEntry(entry, newIds[0]!)).toMatchObject({ kind: "external_edit", until_checkpoint: captured });
    await registry.get(entry).reconcile();
    expect(Object.keys(registry.get(entry).state.entries)).toHaveLength(oldIds.length + 1);
  });

  test("a loose-file repair uses its redirected bus and captures only its bounded file", async () => {
    const other = canonicalize(freshWorkspace());
    try {
      writeFile(other, "only.md", "Only.\n");
      writeFile(other, "sibling.md", "Private sibling.\n");
      const loose = (await index.resolveOpenTarget(join(other, "only.md"))).entry;
      expect(loose.kind).toBe("loose-file");
      await loseHead(loose);
      await repairBaseline(deps, loose.slug);
      expect((await runGit(loose, ["ls-tree", "--name-only", "HEAD"])).stdout.trim()).toBe("only.md");
      expect(existsSync(join(other, ".glosa"))).toBe(false);
    } finally {
      cleanupWorkspace(other);
    }
  });

  test("a deletion marker written while repair waits for the bus lock wins before any repair writes", async () => {
    await loseHead();
    await registry.close(entry);
    const mutex = new KeyedMutex<string>();
    const bus = new WorkspaceBus(entry, { mutex });
    deps.getWorkspaceBus = () => bus;
    const ready = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const blocker = mutex.runExclusive(entry.registration_id, async () => {
      ready.resolve();
      await release.promise;
    });
    await ready.promise;
    const repair = repairBaseline(deps, entry.slug);
    // Queue behind the lock, then persist the actual lifecycle marker while it waits.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await index.markForgetting([entry.registration_id], entry.registration_id);
    const before = readFileSync(journalPath(entry));
    release.resolve();
    await blocker;
    await expect(repair).rejects.toMatchObject({ code: "workspace-forgetting" });
    expect(readFileSync(journalPath(entry))).toEqual(before);
    expect(shadowJournalEvents(entry).filter((event) => event.detail?.repair_id)).toHaveLength(0);
    await bus.close();
  });

  test("a dangling shadow directory symlink is refused instead of creating a foreign repository", async () => {
    await loseHead();
    await registry.close(entry);
    rmSync(shadowGitDir(entry), { recursive: true });
    const foreign = join(home, "must-not-create");
    symlinkSync(foreign, shadowGitDir(entry));
    await expect(repairBaseline(deps, entry.slug)).rejects.toMatchObject({ code: "SHADOW_INVALID_HEAD" });
    expect(existsSync(foreign)).toBe(false);
  });
  test("repair refuses a live claim without changing its history or journal", async () => {
    const bus = registry.get(entry);
    await bus.reconcile();
    const id = ids();
    await bus.createEntry(id, { kind: "annotation" });
    await bus.applyBegin(id, "fixture-session");
    const sha = await headSha(entry);
    unlinkSync(join(shadowGitDir(entry), "objects", sha.slice(0, 2), sha.slice(2)));
    const journal = readFileSync(journalPath(entry));
    await expect(repairBaseline(deps, entry.slug)).rejects.toMatchObject({
      code: "CLAIM_HELD",
      claim: { holder_session: "fixture-session" },
    });
    expect(readFileSync(journalPath(entry))).toEqual(journal);
    expect(await headSha(entry)).toBe(sha);
  });

  test("a torn repair-reason append recovers once through the actual bus restart", async () => {
    await loseHead();
    await expect(
      registry.get(entry).repairBaseline(
        () => {},
        (step) => {
          if (step === "ref-published") throw new Error("simulated termination");
        },
      ),
    ).rejects.toThrow("simulated termination");
    const head = await headSha(entry);
    appendFileSync(journalPath(entry), '{"v":1,"event_id":');
    await registry.close(entry);
    await registry.get(entry).reconcile();
    await registry.get(entry).reconcile();
    expect(await headSha(entry)).toBe(head);
    expect(shadowJournalEvents(entry).filter((event) => event.detail?.repair_id)).toHaveLength(1);
    expect((await shadowHealth(deps, entry.slug)).state).toBe("healthy");
  });

  test("a parent adoption marker written while a loose-source repair waits wins before ref publication", async () => {
    // Register the source before its directory; this is the real adoption topology.
    const other = canonicalize(freshWorkspace());
    let bus: WorkspaceBus | undefined;
    try {
      writeFile(other, "only.md", "Only.\n");
      const loose = (await index.resolveOpenTarget(join(other, "only.md"))).entry;
      await loseHead(loose);
      await registry.close(loose);
      const parent = await index.upsertWorkspace(other, "glosa-open");
      const mutex = new KeyedMutex<string>();
      bus = new WorkspaceBus(loose, { mutex });
      deps.getWorkspaceBus = () => bus!;
      const ready = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const blocker = mutex.runExclusive(loose.registration_id, async () => {
        ready.resolve();
        await release.promise;
      });
      await ready.promise;
      const repair = repairBaseline(deps, loose.slug);
      await new Promise((resolve) => setTimeout(resolve, 10));
      const adoption = await index.beginAdoption(parent);
      expect(adoption?.sources.map((source) => source.registration_id)).toContain(loose.registration_id);
      const before = readFileSync(journalPath(loose));
      release.resolve();
      await blocker;
      await expect(repair).rejects.toMatchObject({ code: "shadow-workspace-inactive" });
      expect(readFileSync(journalPath(loose))).toEqual(before);
    } finally {
      await bus?.close();
      cleanupWorkspace(other);
    }
  });
  test("repair holds the shared bus mutex until the baseline reason is durable", async () => {
    await loseHead();
    const bus = registry.get(entry);
    const staged = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const repair = bus.repairBaseline(
      () => {},
      async (step) => {
        if (step === "index-staged") {
          staged.resolve();
          await release.promise;
        }
      },
    );
    await staged.promise;
    let mutated = false;
    const save = bus.captureHumanEdit(ids(), "draft.md", () => {
      mutated = true;
      writeFile(root, "draft.md", "Human after repair.\n");
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const premature = mutated;
    release.resolve();
    await repair;
    await save;
    expect(premature).toBe(false);
    expect(mutated).toBe(true);
    expect(shadowJournalEvents(entry).filter((event) => event.detail?.repair_id)).toHaveLength(1);
    expect((await runGit(entry, ["show", "HEAD:draft.md"])).stdout).toBe("Human after repair.\n");
  });
  test("adoption marked after repair acquires the bus seals the completed repair without changing its response", async () => {
    const other = canonicalize(freshWorkspace());
    try {
      writeFile(other, "only.md", "Only.\n");
      const loose = (await index.resolveOpenTarget(join(other, "only.md"))).entry;
      await loseHead(loose);
      const parent = await index.upsertWorkspace(other, "glosa-open");
      const bus = registry.get(loose);
      const original = bus.repairBaseline.bind(bus);
      let seal: Promise<void> | undefined;
      bus.repairBaseline = (validate) =>
        original(validate, async (step) => {
          if (step === "index-staged") {
            const adoption = await index.beginAdoption(parent);
            expect(adoption).not.toBeNull();
            seal = registry.sealForAdoption([loose], adoption!.adoption_id, parent.registration_id);
          }
        });
      expect((await repairBaseline(deps, loose.slug)).state).toBe("healthy");
      await seal;
      const events = shadowJournalEvents(loose);
      const repaired = events.findIndex((event) => Boolean(event.detail?.repair_id));
      const sealed = events.findIndex((event) => event.event === "adoption_sealed");
      expect(repaired).toBeGreaterThan(-1);
      expect(sealed).toBeGreaterThan(repaired);
      expect((await runGit(loose, ["show", "HEAD:only.md"])).stdout).toBe("Only.\n");
    } finally {
      cleanupWorkspace(other);
    }
  });
});

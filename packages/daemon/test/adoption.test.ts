// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { adoptLooseLineages } from "../src/adoption.ts";
import { WorkspaceAdoptedError } from "../src/bus/bus.ts";
import { readInboxEntry } from "../src/bus/inbox.ts";
import { WorkspaceBusRegistry } from "../src/bus/workspace-bus-registry.ts";
import { checkpointArtifactPath, listCheckpoints } from "../src/checkpoints.ts";
import { readFileAtCheckpoint } from "../src/git/shadow.ts";
import { WorkspaceIndex } from "../src/registry/workspace-index.ts";
import { cleanup, deterministicClock, freshHome, freshWorkspaceDir } from "./registry/helpers.ts";

describe("seal-and-link loose-file adoption", () => {
  test("seals the source, publishes one active directory writer, preserves Git lineage, and carries pending inbox payloads", async () => {
    const home = freshHome();
    const root = freshWorkspaceDir();
    const artifact = join(root, "notes.md");
    writeFileSync(artifact, "first\n");
    const index = new WorkspaceIndex({ home, now: deterministicClock() });
    const registry = new WorkspaceBusRegistry();

    const loose = await index.resolveOpenTarget(artifact);
    const sourceBus = registry.get(loose.entry);
    await sourceBus.reconcileOnce();
    const baseline = await sourceBus.humanEditCheckpoint("source-edit");
    await sourceBus.createEntry("source-pending", {
      kind: "annotation",
      artifact_path: loose.focus,
      body: "keep this review",
      intent: "review",
      target: { kind: "document" },
    });

    writeFileSync(artifact, "second\n");
    const sourceHead = await sourceBus.humanEditCheckpoint("source-edit");
    const directory = await index.resolveOpenTarget(root);
    await adoptLooseLineages(
      index,
      directory.entry,
      (workspace) => registry.get(workspace),
      (sources, adoptionId, targetRegistrationId) =>
        registry.sealForAdoption(sources, adoptionId, targetRegistrationId),
    );

    expect(existsSync(join(root, ".glosa"))).toBe(true);
    expect(index.getWorkspaceByRegistration(loose.entry.registration_id)?.lifecycle?.state).toBe("adopted");
    await expect(sourceBus.createEntry("late", { kind: "annotation" })).rejects.toBeInstanceOf(WorkspaceAdoptedError);

    const targetBus = registry.get(directory.entry);
    await targetBus.reconcileOnce();
    const adopted = Object.entries(targetBus.state.entries).find(([, state]) => state.origin !== undefined);
    expect(adopted?.[1].status).toBe("pending");
    expect(adopted?.[0]).toContain("source-pending");
    expect(readInboxEntry(directory.entry, adopted?.[0] ?? "")).toMatchObject({ body: "keep this review" });

    const history = await listCheckpoints(directory.entry, {}, new Date());
    expect(history.ok).toBe(true);
    if (!history.ok) throw new Error("unreachable");
    const imported = history.rows.find((row) => row.origin === "lineage");
    expect(imported).toBeDefined();
    expect(history.rows.some((row) => row.origin === "workspace")).toBe(true);

    const path = await checkpointArtifactPath(directory.entry, sourceHead, "notes.md");
    expect(path).toBe("notes.md");
    expect(await readFileAtCheckpoint(directory.entry, sourceHead, path)).toBe("second\n");
    expect(baseline).not.toBe(sourceHead);

    const sourceJournal = readFileSync(join(loose.entry.bus_path, "journal.ndjson"), "utf8");
    expect(sourceJournal).toContain('"adoption_sealed"');
    await sourceBus.reconcile();
    expect(readFileSync(join(loose.entry.bus_path, "journal.ndjson"), "utf8")).toBe(sourceJournal);
    cleanup(home);
    cleanup(root);
  });

  test("fails closed when the directory already contains state and leaves the loose source writable", async () => {
    const home = freshHome();
    const root = freshWorkspaceDir();
    const artifact = join(root, "notes.md");
    writeFileSync(artifact, "note\n");
    mkdirSync(join(root, ".glosa"));
    const index = new WorkspaceIndex({ home, now: deterministicClock() });
    const registry = new WorkspaceBusRegistry();

    const loose = await index.resolveOpenTarget(artifact);
    const sourceBus = registry.get(loose.entry);
    await sourceBus.reconcileOnce();
    const directory = await index.resolveOpenTarget(root);

    await expect(
      adoptLooseLineages(index, directory.entry, (workspace) => registry.get(workspace)),
    ).rejects.toMatchObject({ code: "adoption-conflict" });
    await sourceBus.createEntry("still-writable", { kind: "annotation" });
    expect(sourceBus.state.entries["still-writable"]?.status).toBe("pending");
    cleanup(home);
    cleanup(root);
  });

  test("preflights every source lease before sealing any source", async () => {
    const home = freshHome();
    const root = freshWorkspaceDir();
    const artifact = join(root, "notes.md");
    writeFileSync(artifact, "note\n");
    const index = new WorkspaceIndex({ home, now: deterministicClock() });
    const registry = new WorkspaceBusRegistry();

    const loose = await index.resolveOpenTarget(artifact);
    const sourceBus = registry.get(loose.entry);
    await sourceBus.reconcileOnce();
    await sourceBus.createEntry("leased", { kind: "annotation" });
    await sourceBus.applyBegin("leased", "session-a");
    const directory = await index.resolveOpenTarget(root);

    await expect(
      adoptLooseLineages(
        index,
        directory.entry,
        (workspace) => registry.get(workspace),
        (sources, adoptionId, targetRegistrationId) =>
          registry.sealForAdoption(sources, adoptionId, targetRegistrationId),
      ),
    ).rejects.toMatchObject({ code: "adoption-blocked" });

    expect(sourceBus.state.adoptionSeal).toBeNull();
    expect(existsSync(join(root, ".glosa"))).toBe(false);
    cleanup(home);
    cleanup(root);
  });
});

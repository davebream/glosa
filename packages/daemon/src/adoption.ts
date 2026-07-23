// SPDX-License-Identifier: Apache-2.0
// Logical loose-file adoption. The source bus is sealed and retained as immutable lineage; only
// Git objects and still-actionable inbox payloads are copied into the new directory workspace.
// This deliberately avoids a cross-filesystem destructive move on the workspace-open path.
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { WorkspaceBus, WorkspaceAdoptedError } from "./bus/bus.ts";
import { fsyncContainingDir } from "./bus/io.ts";
import { readInboxEntry } from "./bus/inbox.ts";
import { isTerminal, type EntryKind } from "./bus/lifecycle.ts";
import { importLineage } from "./git/shadow.ts";
import {
  AdoptionError,
  type AdoptionRecord,
  type WorkspaceEntry,
  type WorkspaceIndex,
} from "./registry/workspace-index.ts";
import type { WorkspaceTarget } from "./workspace.ts";

type GetBus = (workspace: WorkspaceTarget) => WorkspaceBus;
type SealSources = (
  sources: readonly WorkspaceTarget[],
  adoptionId: string,
  targetRegistrationId: string,
) => Promise<void>;

function stagedEntry(target: WorkspaceEntry, adoptionId: string): WorkspaceEntry {
  return {
    ...target,
    bus_path: join(target.worktree_path, `.glosa.adopt-${adoptionId}`),
  };
}

function adoptedEntryId(sourceRegistrationId: string, sourceEntryId: string): string {
  return `adopted-${sourceRegistrationId.slice(0, 20)}-${sourceEntryId}`;
}

function sourceEntries(record: AdoptionRecord, index: WorkspaceIndex): WorkspaceEntry[] {
  return record.sources.map((source) => {
    const entry = index.getWorkspaceByRegistration(source.registration_id);
    if (!entry) throw new AdoptionError("adoption-blocked", `source registration ${source.registration_id} is missing`);
    return entry;
  });
}

/** Completes any planned hand-off for `target`. Calls are idempotent: parallel opens share the
 * index claim, sealed sources are safe to re-seal with the same adoption id, and a published
 * target can be committed after a daemon restart without replaying payload copies. */
export async function adoptLooseLineages(
  index: WorkspaceIndex,
  target: WorkspaceEntry,
  getBus: GetBus,
  sealSources?: SealSources,
): Promise<void> {
  const record = await index.beginAdoption(target);
  if (!record || record.phase === "committed") return;

  const targetBusPath = target.bus_path;
  if (record.phase === "target_published" && existsSync(targetBusPath)) {
    await index.commitAdoption(record.adoption_id);
    return;
  }

  const sources = sourceEntries(record, index);
  const sourceBuses = await Promise.all(
    sources.map(async (source) => {
      const bus = getBus(source);
      await bus.reconcileOnce();
      return bus;
    }),
  );

  // Production passes the registry's sorted multi-key seal, so every source lease is inspected
  // before *any* immutable seal is appended. The fallback keeps this coordinator usable in
  // focused unit tests that deliberately construct buses without a registry.
  if (record.phase === "planned") {
    try {
      if (sealSources) {
        await sealSources(sources, record.adoption_id, target.registration_id);
      } else {
        for (const bus of sourceBuses) {
          try {
            await bus.sealForAdoption(record.adoption_id, target.registration_id);
          } catch (error) {
            if (error instanceof WorkspaceAdoptedError && error.targetRegistrationId === target.registration_id)
              continue;
            throw error;
          }
        }
      }
    } catch (error) {
      if (typeof error === "object" && error !== null && (error as { code?: string }).code === "LEASE_HELD") {
        throw new AdoptionError("adoption-blocked", "an active apply lease must resolve or expire before adoption");
      }
      throw error;
    }
    await index.markAdoptionSourcesSealed(record.adoption_id);
  }

  if (existsSync(targetBusPath)) {
    // A target published by the immediately preceding crash is safe only if its own immutable
    // journal proves this exact adoption. Never overwrite a user-created `.glosa` directory.
    const published = getBus(target);
    await published.reconcileOnce();
    if (published.state.lineages[record.adoption_id]) {
      await index.markAdoptionTargetPublished(record.adoption_id);
      await index.commitAdoption(record.adoption_id);
      return;
    }
    throw new AdoptionError("adoption-blocked", "adoption is sealed but the target state is not recognizable");
  }

  const stage = stagedEntry(target, record.adoption_id);
  if (existsSync(stage.bus_path)) rmSync(stage.bus_path, { recursive: true, force: true });
  mkdirSync(stage.bus_path, { recursive: true });

  try {
    // A staging bus has no live public registration and can safely use a private mutex. Publishing
    // is one same-filesystem rename, so an orphaned inbox payload is never visible to normal
    // reconcile/self-heal.
    const stageBus = new WorkspaceBus(stage);
    await stageBus.reconcileOnce();

    const lineageSources: Record<string, unknown>[] = [];
    for (let i = 0; i < sources.length; i += 1) {
      const source = sources[i]!;
      const mapping = record.sources[i]!;
      const head = await importLineage(stage, source, source.registration_id);
      lineageSources.push({ ...mapping, head_sha: head });
    }
    await stageBus.attachLineage(
      { adoption_id: record.adoption_id, sources: lineageSources },
      `lineage-attached:${record.adoption_id}`,
    );

    for (let i = 0; i < sourceBuses.length; i += 1) {
      const sourceBus = sourceBuses[i]!;
      const source = sources[i]!;
      const mapping = record.sources[i]!;
      for (const [entryId, state] of Object.entries(sourceBus.state.entries)) {
        const kind = typeof state.kind === "string" ? (state.kind as EntryKind) : "common";
        if (isTerminal(kind, state.status)) continue;
        const payload = readInboxEntry(source, entryId);
        const targetEntryId = adoptedEntryId(source.registration_id, entryId);
        await stageBus.adoptEntry(
          targetEntryId,
          payload,
          {
            kind,
            status: state.status,
            delivery_attempts: state.deliveryAttempts ?? [],
            source_registration_id: source.registration_id,
            source_entry_id: entryId,
            source_path: mapping.source_path,
            target_path: mapping.target_path,
          },
          `entry-adopted:${record.adoption_id}:${source.registration_id}:${entryId}`,
        );
      }
    }
    await stageBus.close();
    renameSync(stage.bus_path, targetBusPath);
    fsyncContainingDir(targetBusPath);
    await index.markAdoptionTargetPublished(record.adoption_id);
    await index.commitAdoption(record.adoption_id);
  } catch (error) {
    // The sealed sources are intentionally retained. An incomplete stage is derived state and is
    // rebuilt from those immutable sources on the next open/startup attempt.
    if (existsSync(stage.bus_path)) rmSync(stage.bus_path, { recursive: true, force: true });
    throw error;
  }
}

/** Daemon boot uses the same idempotent path as an explicit open. A failed adoption stays sealed
 * and is reported only for its affected workspace; unrelated local workspaces remain available. */
export async function resumePendingAdoptions(
  index: WorkspaceIndex,
  getBus: GetBus,
  sealSources?: SealSources,
): Promise<void> {
  for (const record of index.pendingAdoptions()) {
    const target = index.getWorkspaceByRegistration(record.target_registration_id);
    if (!target) continue;
    await adoptLooseLineages(index, target, getBus, sealSources);
  }
}

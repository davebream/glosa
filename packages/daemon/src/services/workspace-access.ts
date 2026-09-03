// SPDX-License-Identifier: Apache-2.0

import type { WorkspaceBus } from "../bus/bus.ts";
import { AdoptionError, type WorkspaceEntry, type WorkspaceIndex } from "../registry/workspace-index.ts";
import { type WorkspaceTarget, workspaceRegistrationId } from "../workspace.ts";

export interface WorkspaceAccess {
  workspaceIndex: Pick<WorkspaceIndex, "getBySlug" | "getWorkspaceByRegistration">;
  getWorkspaceBus: (workspace: WorkspaceTarget) => WorkspaceBus;
}

export class WorkspaceLookupError extends Error {
  constructor(readonly code: "not-found" | "workspace-adopting") {
    super(code);
  }
}

function isAdoptingTarget(entry: WorkspaceEntry | null): boolean {
  return entry?.lifecycle?.state === "adopting" && entry.lifecycle.target_registration_id === entry.registration_id;
}

export function findWorkspace(deps: WorkspaceAccess, slug: string): WorkspaceEntry {
  const entry = deps.workspaceIndex.getBySlug(slug);
  if (!entry) throw new WorkspaceLookupError("not-found");
  if (isAdoptingTarget(entry)) throw new WorkspaceLookupError("workspace-adopting");
  return entry;
}

export async function workspaceBus(deps: WorkspaceAccess, workspace: WorkspaceTarget): Promise<WorkspaceBus> {
  const indexed = deps.workspaceIndex.getWorkspaceByRegistration(workspaceRegistrationId(workspace));
  if (isAdoptingTarget(indexed)) {
    throw new AdoptionError("workspace-adopting", "workspace adoption is in progress");
  }
  const bus = deps.getWorkspaceBus(workspace);
  await bus.reconcileOnce();
  return bus;
}

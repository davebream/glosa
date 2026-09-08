// SPDX-License-Identifier: Apache-2.0

import type { WorkspaceBus } from "../bus/bus.ts";
import {
  AdoptionError,
  type WorkspaceEntry,
  type WorkspaceIndex,
  type WorkspaceSource,
} from "../registry/workspace-index.ts";
import { type WorkspaceTarget, workspaceRegistrationId } from "../workspace.ts";

export interface WorkspaceAccess {
  workspaceIndex: Pick<
    WorkspaceIndex,
    "getBySlug" | "getWorkspaceByRegistration" | "forgetOperationForSlug" | "activeForgetOperationForCanonicalPath"
  >;
  getWorkspaceBus: (workspace: WorkspaceTarget) => WorkspaceBus;
}

export class WorkspaceLookupError extends Error {
  constructor(readonly code: "not-found" | "workspace-adopting" | "workspace-forgetting") {
    super(code);
  }
}

function isAdoptingTarget(entry: WorkspaceEntry | null): boolean {
  return entry?.lifecycle?.state === "adopting" && entry.lifecycle.target_registration_id === entry.registration_id;
}

/** issue #156: an entry (target OR sealed source — deliberately NOT self-reference-scoped like
 * `isAdoptingTarget`) whose `glosa forget` deletion is durably committed, possibly mid-resume
 * after a crash. Mirrors http.ts's own `isBeingForgotten` — this file is a SEPARATE workspace
 * lookup path (`artifactRoutes` and everything built on `findWorkspace`/`workspaceBus`), so the
 * gate has to be duplicated here rather than shared, and both must stay in sync. */
function isBeingForgotten(entry: WorkspaceEntry | null): boolean {
  return entry?.lifecycle?.state === "forgetting";
}

/** issue #156, held-review finding (third pass): a slug whose LIVE registration is already gone —
 * the exact window a `glosa forget` deletion passes through between removing this slug's own
 * registration and stamping its completion receipt — must still refuse as `"workspace-forgetting"`,
 * not silently fall through to `"not-found"`, so this lookup can never be mistaken by a caller for
 * "never registered" during an in-flight deletion. `forgetOperationForSlug` already resolves by
 * either the target's own slug or any original member's slug, so this covers a source slug too. */
function isRegistrationlessForgetting(deps: WorkspaceAccess, slug: string): boolean {
  const op = deps.workspaceIndex.forgetOperationForSlug(slug);
  return op !== null && !op.completed_at;
}

export function findWorkspace(deps: WorkspaceAccess, slug: string): WorkspaceEntry {
  const entry = deps.workspaceIndex.getBySlug(slug);
  if (!entry) {
    if (isRegistrationlessForgetting(deps, slug)) throw new WorkspaceLookupError("workspace-forgetting");
    throw new WorkspaceLookupError("not-found");
  }
  if (isAdoptingTarget(entry)) throw new WorkspaceLookupError("workspace-adopting");
  if (isBeingForgotten(entry)) throw new WorkspaceLookupError("workspace-forgetting");
  return entry;
}

/** The ONE boundary every direct "get-or-register" fallback must go through instead of writing the
 * raw `index.get(path) ?? index.upsertWorkspace(path, source)` pattern inline (held-review finding,
 * fourth pass): that pattern recreates an ACTIVE row the instant it runs — even during the exact
 * registration-less window a `glosa forget` deletion passes through between removing this path's
 * own registration and stamping its completion receipt — and a SUBSEQUENT `resolveBus`/`workspaceBus`
 * call then finds a live, non-forgetting row and never even reaches ITS OWN registration-less check
 * (`activeForgetOperationForCanonicalPath` only fires when `indexed` is still null). Checked BEFORE
 * the upsert ever runs, not layered on after, so the recreation itself never happens. Throws the
 * SAME `AdoptionError("workspace-forgetting", ...)` `workspaceBus` above throws for a live
 * forgetting row, so every existing pipeline/route catch site already maps it to
 * `409 workspace-forgetting` for free — no new error type, no new plumbing. */
export async function getOrRegisterWorkspace(
  index: Pick<WorkspaceIndex, "get" | "upsertWorkspace" | "activeForgetOperationForCanonicalPath">,
  canonicalPath: string,
  source: WorkspaceSource,
): Promise<WorkspaceEntry> {
  const existing = index.get(canonicalPath);
  if (existing) return existing;
  if (index.activeForgetOperationForCanonicalPath(canonicalPath)) {
    throw new AdoptionError("workspace-forgetting", "workspace is being forgotten");
  }
  return index.upsertWorkspace(canonicalPath, source);
}

export async function workspaceBus(deps: WorkspaceAccess, workspace: WorkspaceTarget): Promise<WorkspaceBus> {
  const indexed = deps.workspaceIndex.getWorkspaceByRegistration(workspaceRegistrationId(workspace));
  if (isAdoptingTarget(indexed)) {
    throw new AdoptionError("workspace-adopting", "workspace adoption is in progress");
  }
  if (isBeingForgotten(indexed)) {
    throw new AdoptionError("workspace-forgetting", "workspace is being forgotten");
  }
  // Mirrors http.ts's own `resolveBus` fix (same held-review finding): a registration-less active
  // operation must refuse here too, before `getWorkspaceBus` ever constructs or reconciles a bus
  // that a not-yet-completed deletion is still committed to removing.
  if (!indexed) {
    const canonicalPath = typeof workspace === "string" ? workspace : workspace.canonical_path;
    if (deps.workspaceIndex.activeForgetOperationForCanonicalPath(canonicalPath)) {
      throw new AdoptionError("workspace-forgetting", "workspace is being forgotten");
    }
  }
  const bus = deps.getWorkspaceBus(workspace);
  await bus.reconcileOnce();
  return bus;
}

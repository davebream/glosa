// SPDX-License-Identifier: Apache-2.0
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { AdoptionCoordinator } from "../adoption.ts";
import { holderSnapshot, liveExclusiveClaims } from "../bus/claims.ts";
import { claimHeldError } from "../bus/lease.ts";
import { peekJournal } from "../bus/peek.ts";
import { diagnoseShadow } from "../git/shadow-health.ts";
import { assertShadowOwner } from "../git/shadow.ts";
import type { WorkspaceEntry } from "../registry/workspace-index.ts";
import { registrationIdFor } from "../workspace.ts";
import { findWorkspace, type WorkspaceAccess } from "./workspace-access.ts";

export interface ShadowAccess extends WorkspaceAccess {
  home: string;
  adoptionCoordinator: AdoptionCoordinator;
}
export class ShadowAccessError extends Error {
  constructor(readonly code: "shadow-unsafe-path" | "shadow-workspace-inactive") {
    super(code);
  }
}

/** Unlike deletion's absent-path no-op, repair can CREATE state, so absent paths must also
 * match the registry's two allowed shapes. Check before constructing a bus (which opens a writer). */
function validateTarget(entry: WorkspaceEntry, home: string): void {
  const unsafe = () => {
    throw new ShadowAccessError("shadow-unsafe-path");
  };
  if (
    registrationIdFor(entry.kind, entry.canonical_path) !== entry.registration_id ||
    entry.worktree_path !== (entry.kind === "directory" ? entry.canonical_path : dirname(entry.canonical_path))
  )
    unsafe();
  if (realpathSync(entry.canonical_path).normalize("NFC") !== entry.canonical_path) unsafe();
  if (
    entry.kind === "loose-file"
      ? entry.tracking.mode !== "bounded" ||
        entry.tracking.paths.length !== 1 ||
        entry.tracking.paths[0] !== basename(entry.canonical_path)
      : entry.tracking.mode !== "matcher"
  )
    unsafe();
  const local = join(entry.worktree_path, ".glosa");
  const redirected = join(home, "state", entry.registration_id);
  if (entry.bus_path !== redirected && (entry.kind !== "directory" || entry.bus_path !== local)) unsafe();
  const dirs = entry.bus_path === redirected ? [join(home, "state"), entry.bus_path] : [entry.bus_path];
  for (const path of [...dirs, join(entry.bus_path, "inbox")]) {
    try {
      if (!lstatSync(path).isDirectory()) unsafe();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  for (const name of ["journal.ndjson", "journal.quarantine.ndjson"]) {
    try {
      if (!lstatSync(join(entry.bus_path, name)).isFile()) unsafe();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function target(deps: ShadowAccess, slug: string): WorkspaceEntry {
  const entry = findWorkspace(deps, slug);
  if ((entry.lifecycle?.state ?? "active") !== "active") throw new ShadowAccessError("shadow-workspace-inactive");
  validateTarget(entry, deps.home);
  return entry;
}

export async function shadowHealth(deps: ShadowAccess, slug: string) {
  const entry = target(deps, slug);
  return { slug: entry.slug, registration_id: entry.registration_id, ...(await diagnoseShadow(entry)) };
}

export async function repairBaseline(deps: ShadowAccess, slug: string) {
  const selected = target(deps, slug);
  return deps.adoptionCoordinator.run(selected.registration_id, async () => {
    const validate = () => {
      const current = target(deps, slug);
      if (current.registration_id !== selected.registration_id || current.bus_path !== selected.bus_path) {
        throw new ShadowAccessError("shadow-workspace-inactive");
      }
      assertShadowOwner();
      const blocking = liveExclusiveClaims(peekJournal(current).state.claims, new Date())[0];
      if (blocking) throw claimHeldError(holderSnapshot(blocking));
    };
    validate();
    const bus = deps.getWorkspaceBus(selected);
    await bus.repairBaseline(validate);
    // Success belongs to the selected registration whose mutation just completed. A parent
    // adoption may already have marked it while waiting for that bus mutex; do not turn the
    // completed repair into a misleading refusal during a second routing lookup.
    return { slug: selected.slug, registration_id: selected.registration_id, ...(await diagnoseShadow(selected)) };
  });
}

// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — read-only scan for orphaned home-state buses (issue #79). Loose files and
// redirected directories keep their bus under `~/.glosa/state/<registration_id>/`
// (`redirectedBusPath`, workspace-index.ts); when such a registration is removed (forget, index
// quarantine, migration) while its journal still derives pending entries, real user work —
// e.g. annotations awaiting delivery — is stranded with nothing pointing at it. This scanner
// REPORTS those buses; it never deletes, quarantines, or adopts anything. Recovery is re-opening
// the original path: registration ids are deterministic per canonical path, so the fresh
// registration points back at the surviving state dir.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { peekJournalAt, pendingCount } from "../bus/peek.ts";
import type { WorkspaceIndex } from "./workspace-index.ts";

export interface OrphanedState {
  registration_id: string;
  pending_count: number;
}

/** List `~/.glosa/state/` dirs with no live registration whose journal still derives pending
 * entries. Sealed adopted lineages are excluded automatically: their source registrations stay
 * in the index (lifecycle `adopted`), so they never look orphaned. A state dir whose journal
 * cannot be folded is skipped (reporting must never throw) — the GC guard's fail-safe already
 * protects registered buses; an unreadable orphan has nothing actionable to report. */
export function scanOrphanedHomeState(home: string, index: WorkspaceIndex): OrphanedState[] {
  const stateRoot = join(home, "state");
  if (!existsSync(stateRoot)) return [];

  const known = new Set(index.list().map((e) => e.registration_id));
  const orphans: OrphanedState[] = [];
  let names: string[];
  try {
    names = readdirSync(stateRoot);
  } catch {
    return [];
  }
  for (const name of names) {
    if (known.has(name)) continue;
    const busDir = join(stateRoot, name);
    try {
      if (!statSync(busDir).isDirectory()) continue;
      const pending = pendingCount(peekJournalAt(busDir).state);
      if (pending > 0) orphans.push({ registration_id: name, pending_count: pending });
    } catch {
      // unreadable state dir — nothing actionable to report, never throw from a status path
    }
  }
  return orphans;
}

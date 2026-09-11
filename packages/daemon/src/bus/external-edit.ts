// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — `external_edit`: the honest name for a tracked artifact that changed on disk
// with nothing to attribute it to (#144, #153 Part 1).
//
// Before this existed, such a change reached the agent stamped `human_edit`
// (`delivery/presentation.ts` branches on the payload kind, and offline catch-up's hunks had no
// kind of their own), which is the one thing A4 §F05 forbids: "EVERYTHING ELSE -> unknown, never
// human". The storage side was always honest — the checkpoint commits
// `Glosa-Attribution: unknown` — so this closes a PRESENTATION lie, and keeps the storage rule
// unchanged.
//
// It rides on the existing `common` EntryKind: `dismissed` already terminates a common entry
// (`lifecycle.ts`'s `COMMON_TERMINALS`), so a person can close one and no new terminal table is
// needed. It is deliberately NOT actionable — an agent cannot "apply" the fact that a file
// changed — so it is excluded from delivery eligibility and from the badge-facing pending count,
// while remaining visible to the retention-facing count (see `peek.ts`).
//
// ONE ENTRY PER ARTIFACT (decisions.md): singular `path`, no `files[]`. The grouping question
// ("these files were edited together") is deliberately out of scope.
import type { DerivedEntryState } from "./replay.ts";

export const EXTERNAL_EDIT_KIND = "external_edit";

/** The `Glosa-Kind` trailer carried by the checkpoints that capture unattributed drift — offline
 * catch-up's (A4 §F04 step 5) and the watcher quiet window's alike. It is the marker
 * `unreportedDriftCommits` below scans for, which is why the two producers must agree on it. */
export const EXTERNAL_EDIT_CHECKPOINT_KIND = "auto_checkpoint";

/** Where the observation came from. `live` = the daemon-lifetime watcher's quiet window saw it
 * happen. `offline_catchup` = a reconcile found the drift after the fact, either because the
 * daemon was down when it landed (A4 §F04 step 5) or because it died between committing the
 * checkpoint and creating this entry (contract A7) — at restart those two are indistinguishable
 * from durable state, so both get the label that claims less. */
export type ExternalEditSource = "live" | "offline_catchup";

export interface ExternalEditPayload {
  kind: typeof EXTERNAL_EDIT_KIND;
  /** ONE artifact, workspace-relative. Singular by decision, never a `files[]` array. */
  path: string;
  /** Unified diff for this path alone across `since_checkpoint..until_checkpoint`. */
  diff: string;
  diff_bytes: number;
  since_checkpoint: string;
  until_checkpoint: string;
  observed_at: string;
  source: ExternalEditSource;
}

/** The additive `entry_created.detail` facts the journal fold needs to recognize one of these
 * WITHOUT reopening the immutable inbox payload. Both matter to a read-only fold: `payload_kind`
 * is what every exclusion reads, and `until_checkpoint` is what stops the crash-gap recovery from
 * re-reporting a commit an entry already names. */
export function externalEditDetail(payload: ExternalEditPayload): Record<string, unknown> {
  return {
    since_checkpoint: payload.since_checkpoint,
    until_checkpoint: payload.until_checkpoint,
    source: payload.source,
  };
}

export function isExternalEditPayload(payload: unknown): payload is ExternalEditPayload {
  return (
    payload !== null &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    (payload as Record<string, unknown>).kind === EXTERNAL_EDIT_KIND
  );
}

/** The single predicate every fold that excludes an `external_edit` calls. Reads the journal-
 * derived `payload_kind` (recorded by `createEntryLocked`, `adoptEntry`, and `selfHealInbox` — the
 * three ways an entry can come to exist), never the inbox file: `peek.ts`'s folds run on a bare
 * bus directory with no `WorkspaceTarget` to read a payload with, and a fold that needed one would
 * report differently depending on whether a file happened to still be there. */
export function isExternalEditEntry(entry: DerivedEntryState): boolean {
  return entry.payload_kind === EXTERNAL_EDIT_KIND;
}

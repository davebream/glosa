// SPDX-License-Identifier: Apache-2.0
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { parseJournalEventLine } from "../bus/journal.ts";
import { inboxDir, inboxEntryPath, journalPath } from "../bus/paths.ts";
import type { WorkspaceTarget } from "../workspace.ts";
import { inspectShadowRepo, runGit, type ShadowHealth } from "./shadow.ts";

export interface ShadowDiagnosis extends ShadowHealth {
  census: { entries: number; missing_checkpoint_entries: number; unassessable_entries: number; complete: boolean };
}

/** Physical inbox/journal census, with no writer, reconciliation, or reachability requirement.
 * A surviving commit remains readable even after repair disconnects it from the active branch. */
export async function diagnoseShadow(workspace: WorkspaceTarget): Promise<ShadowDiagnosis> {
  const health = await inspectShadowRepo(workspace);
  const kinds = new Map<string, string | undefined>();
  let complete = true;
  try {
    const raw = readFileSync(journalPath(workspace), "utf8");
    if (raw && !raw.endsWith("\n")) complete = false;
    for (const line of raw.split("\n").slice(0, -1)) {
      const event = parseJournalEventLine(line);
      if (!event) {
        if (line) complete = false;
        continue;
      }
      if ((event.event === "entry_created" || event.event === "entry_adopted") && event.entry) {
        const kind = event.detail?.payload_kind ?? event.detail?.kind;
        kinds.set(event.entry, typeof kind === "string" ? kind : undefined);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") complete = false;
  }
  try {
    for (const name of readdirSync(inboxDir(workspace))) {
      if (!name.startsWith(".") && name.endsWith(".json") && !kinds.has(name.slice(0, -5)))
        kinds.set(name.slice(0, -5), undefined);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") complete = false;
  }
  const present = new Map<string, boolean>();
  let missing = 0;
  let unknown = 0;
  for (const [id, recordedKind] of kinds) {
    let payload: Record<string, unknown> | undefined;
    try {
      if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) throw new Error("invalid inbox id");
      const path = inboxEntryPath(workspace, id);
      if (!lstatSync(path).isFile()) throw new Error("not a regular inbox file");
      const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (raw && typeof raw === "object" && !Array.isArray(raw)) payload = raw as Record<string, unknown>;
    } catch {
      /* Qualification below distinguishes irrelevant known kinds from unknown payloads. */
    }
    const kind = typeof payload?.kind === "string" ? payload.kind : recordedKind;
    if (kind !== "human_edit" && kind !== "external_edit") {
      if (!kind || !["annotation", "attention_request"].includes(kind)) unknown++;
      continue;
    }
    const fields =
      kind === "human_edit" ? ["checkpoint_before", "checkpoint_after"] : ["since_checkpoint", "until_checkpoint"];
    let hasMissing = false;
    let unassessable = false;
    for (const field of fields) {
      const sha = payload?.[field];
      if (typeof sha !== "string" || !/^[a-f0-9]{40,64}$/.test(sha)) {
        unassessable = true;
        continue;
      }
      if (!present.has(sha)) {
        const object = await runGit(workspace, ["cat-file", "-t", sha], { allowExitCodes: [0, 128] });
        present.set(sha, object.exitCode === 0 && object.stdout.trim() === "commit");
      }
      if (!present.get(sha)) hasMissing = true;
    }
    if (hasMissing) missing++;
    if (unassessable) unknown++;
  }
  return {
    ...health,
    census: {
      entries: kinds.size,
      missing_checkpoint_entries: missing,
      unassessable_entries: unknown,
      complete: complete && unknown === 0,
    },
  };
}

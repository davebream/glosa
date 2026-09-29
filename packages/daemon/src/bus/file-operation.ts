// SPDX-License-Identifier: Apache-2.0
import type { WorkspaceTarget } from "../workspace.ts";
import { runGit } from "../git/shadow.ts";
import { writeInboxEntryOnce } from "./inbox.ts";
import { appendEvent, type JournalEvent, type JournalWriter } from "./journal.ts";
import { applyEvent, type DerivedState, type Reducer } from "./replay.ts";
import { directoryFromHistoryKey, directoryHistoryKey, historyPath, pathWithin } from "../versioned-files.ts";

export interface FileOperation {
  op: "create" | "mkdir" | "rename" | "trash" | "undo" | "restore" | "import";
  path: string;
  to?: string;
  scope: "file" | "folder";
  rename?: { from: string; to: string };
  holders?: string[];
  restore_checkpoint?: string;
}
export function operationPayload(operation: FileOperation, before: string, after: string) {
  return {
    kind: "human_edit",
    edit_kind: operation.op,
    operation,
    checkpoint_before: before,
    checkpoint_after: after,
    files: [
      { path: operation.to ?? operation.path, change: operation.op, ...(operation.to ? { from: operation.path } : {}) },
    ],
  };
}
/** Move committed identities, not live bytes. Bytes changed by another process while a move
 * awaits the OS are captured by the next unknown checkpoint, never credited to the mover. */
export async function operationTree(workspace: WorkspaceTarget, operation: FileOperation, before: string) {
  const changes = new Map<string, string | null>();
  const from = operation.rename?.from ?? operation.path;
  const tree = await runGit(workspace, ["ls-tree", "-r", "-z", operation.restore_checkpoint ?? before]);
  for (const row of tree.stdout.split("\0").filter(Boolean)) {
    const tab = row.indexOf("\t"),
      key = row.slice(tab + 1),
      blob = row.slice(0, tab).split(" ")[2]!;
    const path = historyPath(key);
    if (!pathWithin(path, from)) continue;
    if (operation.rename) {
      const target = operation.rename.to + path.slice(from.length);
      changes.set(key, null);
      changes.set(directoryFromHistoryKey(key) ? directoryHistoryKey(target) : target, blob);
    } else if (operation.op === "trash" || (operation.op === "undo" && !operation.restore_checkpoint))
      changes.set(key, null);
    else if (operation.restore_checkpoint) changes.set(key, blob);
  }
  if (operation.op === "create" || operation.op === "mkdir") {
    const empty = (
      await runGit(workspace, ["hash-object", "-w", "--stdin"], { input: new Uint8Array() })
    ).stdout.trim();
    changes.set(operation.op === "mkdir" ? directoryHistoryKey(operation.path) : operation.path, empty);
  }
  return changes;
}
export async function repairFileOperations(deps: {
  workspaceRoot: WorkspaceTarget;
  state: DerivedState;
  writer: JournalWriter;
  ulid: () => string;
  reducer: Reducer;
  now?: () => Date;
}) {
  const log = await runGit(
    deps.workspaceRoot,
    ["log", "--reverse", "--format=%H%x09%P%x09%(trailers:key=Glosa-File-Operation,valueonly,separator=)"],
    { allowExitCodes: [0, 128] },
  );
  for (const line of log.stdout.split("\n")) {
    const [after, before, encoded] = line.split("\t");
    if (!after || !before || !encoded) continue;
    let data: { entry: string; operation: FileOperation };
    try {
      data = JSON.parse(Buffer.from(encoded.trim(), "base64url").toString());
    } catch {
      continue;
    }
    if (typeof data.entry !== "string" || typeof data.operation?.path !== "string") continue;
    const emit = (event: JournalEvent) => {
      appendEvent(deps.writer, event, { fsync: true });
      applyEvent(deps.state, event, deps.reducer);
    };
    const common = {
      v: 1 as const,
      at: (deps.now?.() ?? new Date()).toISOString(),
      by: "human" as const,
      entry: data.entry,
    };
    if (!deps.state.entries[data.entry]) {
      try {
        writeInboxEntryOnce(deps.workspaceRoot, data.entry, operationPayload(data.operation, before, after));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      emit({
        ...common,
        event_id: deps.ulid(),
        event: "entry_created",
        detail: { kind: "human_edit", payload_kind: "human_edit", file_operation: data.operation },
      });
    }
    if (data.operation.rename && !deps.state.renames.some((rename) => rename.checkpoint_after === after)) {
      emit({
        ...common,
        event_id: deps.ulid(),
        event: "paths_renamed",
        detail: {
          ...data.operation.rename,
          scope: data.operation.scope,
          checkpoint_after: after,
          holders: data.operation.holders ?? [],
        },
      });
    }
  }
}

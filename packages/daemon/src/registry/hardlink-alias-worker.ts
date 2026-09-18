// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — the off-main-thread half of the rare nlink>1 hardlink-alias scan (issue #281).
// `WorkspaceIndex.resolveOpenTarget` awaits this Worker's answer from inside the global index
// mutex critical section (`bus/mutex.ts`'s `runExclusive` keeps a callback's ownership across an
// awaited promise), so registry mutation stays serialized exactly as A4 "Workspace ownership and
// aliases" requires, while the (potentially large) synchronous tree walk `resolveTrackedFiles`
// performs for a matcher-mode registration never blocks the daemon's own event loop or its stall
// watchdog's heartbeat.
//
// Read-only and side-effect-free by construction: this thread never creates, persists, mutates, or
// deletes anything. It reports the FIRST registration/file whose live `dev`/`ino` matches the
// target, in the exact order the main thread would have iterated (insertion order, deepest-owner
// exclusion already applied by the caller's task filter) — the main thread alone revalidates and
// commits that answer before ever reusing or creating a registration.
import { statSync } from "node:fs";
import { resolveTrackedFiles } from "../matcher.ts";
import type { WorkspaceKind, WorkspaceTracking } from "../workspace.ts";

export interface AliasScanTask {
  registration_id: string;
  kind: WorkspaceKind;
  canonical_path: string;
  worktree_path: string;
  bus_path: string;
  tracking: WorkspaceTracking;
}

export interface AliasScanRequest {
  tasks: AliasScanTask[];
  identity: { dev: string; ino: string };
}

export type AliasScanResponse =
  | { status: "found"; registrationId: string; focus: string }
  | { status: "not_found" }
  | { status: "error"; message: string };

self.onmessage = (event: MessageEvent<AliasScanRequest>) => {
  const { tasks, identity } = event.data;
  try {
    for (const task of tasks) {
      const { tracked } = resolveTrackedFiles(task);
      for (const file of tracked) {
        let stat: ReturnType<typeof statSync>;
        try {
          stat = statSync(file.rawPath, { bigint: true });
        } catch {
          continue; // raced away between the walk and this stat — cannot prove ownership
        }
        if (stat.dev.toString() === identity.dev && stat.ino.toString() === identity.ino) {
          const response: AliasScanResponse = {
            status: "found",
            registrationId: task.registration_id,
            focus: file.path,
          };
          postMessage(response);
          return;
        }
      }
    }
    const response: AliasScanResponse = { status: "not_found" };
    postMessage(response);
  } catch (err) {
    const response: AliasScanResponse = { status: "error", message: (err as Error).message };
    postMessage(response);
  }
};

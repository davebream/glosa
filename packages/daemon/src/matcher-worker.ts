// SPDX-License-Identifier: Apache-2.0
// Complete matcher walks are intentionally isolated from the daemon event loop. A large registry
// can make this CPU/filesystem-bound operation take seconds; doing it in the HTTP transaction on
// the main thread wedges every unrelated request while it runs.
import { resolveTrackedFiles } from "./matcher.ts";
import type { WorkspaceTarget } from "./workspace.ts";

export interface MatcherWorkerRequest {
  workspace: WorkspaceTarget;
  limit?: number;
}

export type MatcherWorkerResponse =
  | { status: "ok"; result: ReturnType<typeof resolveTrackedFiles> }
  | { status: "error"; error: string };

self.onmessage = (event: MessageEvent<MatcherWorkerRequest>) => {
  try {
    const result = resolveTrackedFiles(event.data.workspace, { limit: event.data.limit });
    self.postMessage({ status: "ok", result } satisfies MatcherWorkerResponse);
  } catch (error) {
    self.postMessage({
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    } satisfies MatcherWorkerResponse);
  }
};

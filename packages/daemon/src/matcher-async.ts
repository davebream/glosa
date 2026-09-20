// SPDX-License-Identifier: Apache-2.0
import type { ResolveMatchedFilesResult } from "./matcher.ts";
import type { MatcherWorkerRequest, MatcherWorkerResponse } from "./matcher-worker.ts";
import type { WorkspaceTarget } from "./workspace.ts";

export interface ResolveTrackedFilesAsyncOptions {
  limit?: number;
}

export type ResolveTrackedFilesAsync = (
  workspace: WorkspaceTarget,
  options?: ResolveTrackedFilesAsyncOptions,
) => Promise<ResolveMatchedFilesResult>;

/** Runs a complete matcher walk outside the daemon's event loop. */
export const resolveTrackedFilesAsync: ResolveTrackedFilesAsync = (workspace, options = {}) =>
  new Promise((resolve, reject) => {
    let worker: Worker | null = null;
    let settled = false;
    const finish = (result: MatcherWorkerResponse | Error) => {
      if (settled) return;
      settled = true;
      try {
        worker?.terminate();
      } catch {
        // The result is already known; cleanup failure must not replace it.
      }
      if (result instanceof Error) reject(result);
      else if (result.status === "ok") resolve(result.result);
      else reject(new Error(result.error));
    };

    try {
      worker = new Worker(new URL("./matcher-worker.ts", import.meta.url).href);
      worker.onmessage = (event: MessageEvent<MatcherWorkerResponse>) => finish(event.data);
      worker.onerror = (event) => finish(new Error(event.message || "matcher worker failed"));
      worker.postMessage({ workspace, limit: options.limit } satisfies MatcherWorkerRequest);
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });

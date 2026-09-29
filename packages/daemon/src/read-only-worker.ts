// SPDX-License-Identifier: Apache-2.0
import { scanReadOnlyFiles } from "./read-only-files.ts";
import type { WorkspaceTarget } from "./workspace.ts";
self.onmessage = (event: MessageEvent<{ workspace: WorkspaceTarget; showIgnored: boolean }>) => {
  try {
    self.postMessage({ result: scanReadOnlyFiles(event.data.workspace, event.data.showIgnored) });
  } catch (error) {
    self.postMessage({ error: (error as Error).message });
  }
};

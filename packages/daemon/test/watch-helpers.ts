// SPDX-License-Identifier: Apache-2.0
// The production watch plus a promise that settles once it is ARMED. A native watch's kernel stream
// (FSEvents on macOS) comes up asynchronously after `fs.watch` returns and does not replay earlier
// events, so a write made in that gap produces no event at all. That write is reconcile's offline
// catch-up's to report, never the watcher's. A case that writes and then waits for the watcher
// awaits `armed()`: it saves a probe file beside what is watched until the watch reports it.
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  nativeWorkspaceWatch,
  type WorkspaceWatchFactory,
  type WorkspaceWatchRequest,
} from "../src/artifact-watcher.ts";

const PROBE = ".glosa-watch-probe";

export function armedWatchFactory(): {
  watchFactory: WorkspaceWatchFactory;
  armed: () => Promise<void>;
  requests: WorkspaceWatchRequest[];
} {
  const requests: WorkspaceWatchRequest[] = [];
  let ready: Promise<void> = Promise.resolve();
  return {
    requests,
    watchFactory: (request) => {
      requests.push(request);
      const probe = join(request.mode === "tree" ? request.root : dirname(request.files[0] ?? request.root), PROBE);
      let seen = false;
      const watch = nativeWorkspaceWatch({
        ...request,
        files: request.mode === "files" ? [...request.files, probe] : request.files,
        onChange: (path) => {
          if (path === probe) {
            seen = true;
            return;
          }
          request.onChange(path);
        },
      });
      ready = (async () => {
        const deadline = Date.now() + 10_000;
        while (!seen && Date.now() < deadline) {
          writeFileSync(probe, String(Date.now()));
          await Bun.sleep(50);
        }
        rmSync(probe, { force: true });
        if (!seen) throw new Error(`the watch on ${request.root} never reported its probe`);
      })();
      return watch;
    },
    armed: () => ready,
  };
}

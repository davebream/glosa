// SPDX-License-Identifier: Apache-2.0
// Test-only daemon entrypoint. Unlike the packaged CLI's `__daemon` command, this fixture injects
// one explicit write checkpoint into the production daemon composition root. The parent test
// selects the checkpoint by argv and observes a real SIGKILL/OS-process restart; no runtime env
// flag, HTTP route, user configuration, or installed glosa process can enable this behavior.
import type { WorkspaceBusWriteCheckpoint } from "../../src/bus/write-checkpoint.ts";
import { bootDaemon } from "../../src/index.ts";

const selected = process.argv[2];
if (!selected) throw new Error("fault checkpoint argv is required");

await bootDaemon({
  writeCheckpoint: (checkpoint: WorkspaceBusWriteCheckpoint) => {
    if (checkpoint.name !== selected) return;
    if (checkpoint.event?.event !== "entry_created" && checkpoint.name.startsWith("journal:")) return;
    process.kill(process.pid, "SIGKILL");
  },
});

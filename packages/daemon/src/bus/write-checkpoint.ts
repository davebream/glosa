// SPDX-License-Identifier: Apache-2.0
// Explicit fault-observation seam for durability acceptance tests. Production constructs no
// callback, so these optional calls are inert; the packaged CLI exposes no flag, env switch, or
// route that can install one. Keeping the seam at the composition boundary lets a test daemon die
// at a named syscall boundary without putting test-triggered behavior into the runtime protocol.
import type { JournalEvent } from "./journal.ts";

export type WorkspaceBusWriteCheckpointName =
  | "inbox:temp-fsynced"
  | "inbox:linked"
  | "inbox:published"
  | "journal:written"
  | "journal:fsynced";

export interface WorkspaceBusWriteCheckpoint {
  name: WorkspaceBusWriteCheckpointName;
  event?: JournalEvent;
}

export type WorkspaceBusWriteCheckpointObserver = (checkpoint: WorkspaceBusWriteCheckpoint) => void;

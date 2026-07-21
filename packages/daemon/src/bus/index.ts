// @glosa/daemon — file bus barrel (A4 §F04: journal-as-truth). See docs/appendices/A4-filebus-concurrency.md.
export { AsyncMutex, KeyedMutex } from "./mutex.ts";
export { createUlidGenerator, ulid } from "./ulid.ts";
export type { NowFn, RandomBytesFn, UlidDeps, UlidGenerator } from "./ulid.ts";
export { workspaceBusDir, journalPath, quarantinePath, inboxDir, inboxEntryPath } from "./paths.ts";
export { appendEvent, isLifecycleCritical, JournalWriter, MAX_EVENT_BYTES } from "./journal.ts";
export type { AppendOptions, EventBy, EventTooLargeError, EventType, JournalEvent } from "./journal.ts";
export {
  cleanupOrphanInboxTempFiles,
  listInboxEntryIds,
  readInboxEntry,
  writeInboxEntryOnce,
} from "./inbox.ts";
export type { InboxEntryExistsError } from "./inbox.ts";
export { quarantineLine, quarantineRawBytes } from "./quarantine.ts";
export {
  applyEvent,
  createEmptyState,
  defaultReducer,
  foldEvents,
  replayJournal,
} from "./replay.ts";
export type { DerivedEntryState, DerivedState, Reducer, ReplayDeps, ReplayResult } from "./replay.ts";
export {
  offlineCatchUp,
  reconcileApplyLeases,
  reconcileWorkspace,
  selfHealInbox,
  truncateTornTail,
} from "./reconcile.ts";
export type {
  ApplyLeaseReconcileDeps,
  OfflineCatchUpDeps,
  ReconcileOptions,
  ReconcileResult,
  TailTruncateResult,
} from "./reconcile.ts";
export { WorkspaceBus } from "./bus.ts";
export type { WorkspaceBusDeps } from "./bus.ts";

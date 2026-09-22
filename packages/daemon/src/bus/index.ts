// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — file bus barrel (A4 §F04: journal-as-truth). See docs/appendices/A4-filebus-concurrency.md.
export { AsyncMutex, KeyedMutex } from "./mutex.ts";
export { createUlidGenerator, ulid } from "./ulid.ts";
export type { NowFn, RandomBytesFn, UlidDeps, UlidGenerator } from "./ulid.ts";
export { workspaceBusDir, journalPath, quarantinePath, inboxDir, inboxEntryPath, shadowGitDir } from "./paths.ts";
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
export type {
  AppliedInterval,
  DerivedEntryState,
  DerivedState,
  Reducer,
  ReplayDeps,
  ReplayResult,
} from "./replay.ts";
export { isTerminal, lifecycleReducer } from "./lifecycle.ts";
export type { DeliveryAttemptRecord, DeliveryOutcome, DeliveryReason, DeliveryVia, EntryKind } from "./lifecycle.ts";
export {
  offlineCatchUp,
  reconcileClaims,
  reconcileWorkspace,
  selfHealInbox,
  truncateTornTail,
} from "./reconcile.ts";
export type {
  ApplyLeaseReconcileDeps,
  OfflineCatchUpDeps,
  OfflineCatchUpResult,
  ReconcileOptions,
  ReconcileResult,
  TailTruncateResult,
} from "./reconcile.ts";
export {
  artifactResource,
  claimForEntry,
  claimsOnPaths,
  entryResource,
  isClaimExpired,
  liveExclusiveClaims,
  reduceClaimEvent,
  tombstoneFor,
} from "./claims.ts";
export type {
  Claim,
  ClaimHolderSnapshot,
  ClaimMode,
  ClaimsState,
  ResourceClaims,
  Tombstone,
  TombstoneReason,
} from "./claims.ts";
export {
  CLAIM_RENEW_GRACE_MS,
  claimHeldError,
  claimLimitError,
  claimTombstoneError,
  EXCLUSIVE_CLAIM_TTL_MS,
  entryResolvedError,
  HOLDER_STALE_GRACE_MS,
  MAX_CLAIMS_PER_SESSION,
  MAX_CLAIMS_PER_WORKSPACE,
  noClaimError,
  PRESENCE_CLAIM_TTL_MS,
  sourceChangedError,
  unknownEntryError,
} from "./lease.ts";
export type {
  ClaimGoneError,
  ClaimHeldError,
  ClaimLimitError,
  EntryResolvedError,
  NoClaimError,
  SourceChangedError,
  UnknownEntryError,
} from "./lease.ts";
export { WorkspaceBus } from "./bus.ts";
export type { WorkspaceBusDeps } from "./bus.ts";

// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — the global workspace index (A5 §F19): `<GLOSA_HOME>/workspaces.json`. Tracks
// every workspace glosa has ever seen (across every provider session, `glosa open`, or a
// discovered `.glosa/` dir), keyed by canonical path. Daemon is the SOLE writer, serialized by
// ONE in-process async mutex, atomic temp -> fsync -> rename — no consumer (CLI/hooks/MCP) ever
// writes this file directly; they mutate through the daemon (F19). This is also the fix for the
// F08 session-registration race: slug assignment happens under the SAME mutex critical section
// as the upsert that records it, so two concurrent registrations for different workspaces can
// never observe (or assign) a torn/duplicate slug.
import { randomUUID } from "node:crypto";
import {
  accessSync,
  closeSync,
  existsSync,
  constants as fsConstants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fsyncContainingDir, type WriteSync, writeAllSync } from "../bus/io.ts";
import { AsyncMutex } from "../bus/mutex.ts";
import { peekJournalAt, pendingCount } from "../bus/peek.ts";
import { glosaHome } from "../lifecycle/home.ts";
import { resolveMatchedFiles, resolveTrackedFiles } from "../matcher.ts";
// Aliased so every call site below reads unchanged: this file is the reference caller of the
// registration-id derivation, but it no longer OWNS it. `workspace.ts` holds the single copy so
// the bare-string target form (`workspaceRegistrationId`) cannot drift away from the sha256 that
// reaches `~/.glosa/workspaces.json` — A4 keys the per-workspace mutex on that id.
import {
  registrationIdFor as registrationId,
  type WorkspaceKind,
  type WorkspaceLocation,
  type WorkspaceTracking,
} from "../workspace.ts";
import { assignSlug, type SlugDeps } from "./slug.ts";
import { enclosingGitRoot } from "./workspace-root.ts";

export type WorkspaceSource = "session" | "glosa-open" | "discovered";

/** A registration is never silently re-used once its writer has been handed to an adopted
 * directory workspace. `adopting` is the durable claim that makes a crashed hand-off resumable;
 * `adopted` keeps the source locator available for historical lineage reads. */
export type WorkspaceLifecycle =
  | { state: "active" }
  | { state: "adopting"; adoption_id: string; target_registration_id: string }
  | { state: "adopted"; adoption_id: string; target_registration_id: string; sealed_at: string }
  /** `glosa forget <slug>` (issue #156): the durable marker its deletion flow (see
   * `registry/forget-workspace.ts`) writes BEFORE touching a single bus file. GC already treats
   * any non-`active` lifecycle as "leave it alone" (this file's `gc()`), and the HTTP layer
   * refuses new routing to a workspace in this state the same way it refuses one mid-adoption —
   * so once this is durable, nothing can race the deletion it is about to perform. A crash after
   * this write still resolves by slug with this exact state, which is what makes re-running
   * `forget` a resume instead of a re-ask: the live-session/apply-lease preflight already passed
   * once and is never re-consulted for an entry already in this state.
   *
   * `target_registration_id` is this entry's OWN id when the entry IS the forget target (mirrors
   * `"adopting"`'s self-reference convention above), or the target's id when this entry is one of
   * its sealed sources. This is what lets a resumed call reconstruct the FULL original set with
   * `forgettingMembersFor` — a source already flipped from `"adopted"` to `"forgetting"` by the
   * interrupted attempt no longer matches `sealedSourcesFor`'s `"adopted"` filter, so a resume
   * that re-derived the set the same way the first call did would silently drop it. */
  | { state: "forgetting"; started_at: string; target_registration_id: string };

export type AdoptionPhase = "planned" | "sources_sealed" | "target_published" | "committed";

export interface AdoptionSource {
  registration_id: string;
  /** Path in the loose file's one-file worktree. */
  source_path: string;
  /** Corresponding tracked path in the directory worktree. */
  target_path: string;
}

export interface AdoptionRecord {
  adoption_id: string;
  target_registration_id: string;
  phase: AdoptionPhase;
  sources: AdoptionSource[];
  created_at: string;
  updated_at: string;
}

export class AdoptionError extends Error {
  constructor(
    // `"workspace-forgetting"` (issue #156) shares this carrier rather than getting its own error
    // class: it is the same shape of thing — a workspace mid a durable multi-step lifecycle
    // transaction refusing ordinary routing until that transaction finishes — and http.ts's two
    // generic `instanceof AdoptionError` catches (the pipeline's own, and `resolveBus`'s callers')
    // already map any code here straight through `problem(409, error.code, error.message, ...)`.
    readonly code: "adoption-conflict" | "adoption-blocked" | "workspace-adopting" | "workspace-forgetting",
    message: string,
  ) {
    super(message);
  }
}

export interface WorkspaceEntry extends WorkspaceLocation {
  canonical_path: string;
  registration_id: string;
  kind: WorkspaceKind;
  worktree_path: string;
  bus_path: string;
  tracking: WorkspaceTracking;
  file_identity?: { dev: string; ino: string };
  slug: string;
  slug_len: number;
  source: WorkspaceSource;
  first_seen: string;
  last_seen: string;
  present: boolean;
  lifecycle?: WorkspaceLifecycle;
  /** Set the moment `present` flips false — the GC grace-period clock starts here, not at
   * "whenever GC happens to notice." Cleared if the workspace comes back present. */
  absent_since?: string;
}

/** A minimal, immutable snapshot of one `glosa forget` member — captured once, at the moment the
 * durable operation begins, so it survives that same member's OWN registration being removed
 * partway through a crash-interrupted deletion (issue #156 review finding: a resumed deletion
 * must report the COMPLETE original set, not just whatever is still registered). */
export interface ForgetMember {
  registration_id: string;
  slug: string;
  canonical_path: string;
  /** Held-review finding (fourth held pass): "registration-less loose-file status synthesizes the
   * file path instead of the durable worktree path" — for a `loose-file` member `canonical_path` is
   * the FILE itself, never what `doctor <dir>`/every other status row's own `path` field (always
   * `WorkspaceEntry.worktree_path`) is addressed by. Captured alongside `canonical_path` so a
   * registration-less synthesized status row (target fully deregistered, operation not yet
   * completed) can report the SAME `path` shape as every live row, not the member's raw file path. */
  worktree_path: string;
  kind: WorkspaceKind;
  bus_path: string;
  /** This member's OWN lifecycle at the exact moment `beginForgetOperation` captured it — for a
   * sealed adopted source that is `{state:"adopted", adoption_id, target_registration_id,
   * sealed_at}`, never `{state:"active"}` (held-review finding: `abortForgetOperation`
   * unconditionally reset every member to `"active"`, which for a sealed source is a LIE — it
   * silently destroyed the adoption metadata `sealedSourcesFor` depends on, so a fresh `forget`
   * attempt after a lost lease race would never rediscover that source again, orphaning its bus
   * forever). `abortForgetOperation` restores exactly this value, never a hardcoded `"active"`. */
  prior_lifecycle: WorkspaceLifecycle;
}

/** The durable `glosa forget <slug>` transaction record (issue #156 revised approach). Written
 * BEFORE a single bus is sealed or deleted — see `beginForgetOperation`'s own docstring — and
 * never removed once `completed_at` is stamped, so a retried call against a slug whose ENTIRE
 * member set has since been deregistered still resolves to an idempotent completion receipt
 * (`forgetOperationForSlug`) instead of a false `not-found`. `target_slug` is the target's slug
 * AT THE MOMENT the operation began — the one identifier guaranteed to keep resolving the
 * operation by `getBySlug` until the target's own registration is the last one removed. */
export interface ForgetOperationRecord {
  operation_id: string;
  target_registration_id: string;
  target_slug: string;
  members: ForgetMember[];
  started_at: string;
  completed_at?: string;
}

export interface WorkspaceIndexFile {
  version: 4;
  updated_at: string;
  workspaces: Record<string, WorkspaceEntry>;
  adoptions: Record<string, AdoptionRecord>;
  forget_operations: Record<string, ForgetOperationRecord>;
}

interface V3WorkspaceIndexFile {
  version: 3;
  updated_at: string;
  workspaces: Record<string, WorkspaceEntry>;
  adoptions: Record<string, AdoptionRecord>;
}

interface V2WorkspaceIndexFile {
  version: 2;
  updated_at: string;
  workspaces: Record<string, WorkspaceEntry>;
}

interface LegacyWorkspaceEntry {
  canonical_path: string;
  slug: string;
  slug_len: number;
  source: WorkspaceSource;
  first_seen: string;
  last_seen: string;
  present: boolean;
  absent_since?: string;
}

interface LegacyWorkspaceIndexFile {
  version: 1;
  updated_at: string;
  workspaces: Record<string, LegacyWorkspaceEntry>;
}

export interface WorkspaceOpenResult {
  entry: WorkspaceEntry;
  focus?: string;
}

export class WorkspaceOpenError extends Error {
  constructor(
    readonly code: "invalid-path" | "artifact-not-tracked" | "no-tracked-artifact" | "unsupported-file",
    message: string,
  ) {
    super(message);
  }
}

export function workspaceIndexPath(home: string): string {
  return join(home, "workspaces.json");
}

/** Path for the pre-daemon O_EXCL fallback lease (A4 "Registry-write serialization") that guards
 * this same file when a hook must write it directly because the daemon is unreachable. */
export function fallbackWorkspacesLockPath(home: string): string {
  return join(home, ".workspaces.lock");
}

function isLegacyWorkspaceEntryShape(v: unknown): v is LegacyWorkspaceEntry {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.canonical_path === "string" &&
    typeof e.slug === "string" &&
    typeof e.slug_len === "number" &&
    typeof e.source === "string" &&
    typeof e.first_seen === "string" &&
    typeof e.last_seen === "string" &&
    typeof e.present === "boolean"
  );
}

function isTrackingShape(v: unknown): v is WorkspaceTracking {
  if (typeof v !== "object" || v === null) return false;
  const tracking = v as Record<string, unknown>;
  return (
    tracking.mode === "matcher" ||
    (tracking.mode === "bounded" &&
      Array.isArray(tracking.paths) &&
      tracking.paths.every((path) => typeof path === "string"))
  );
}

function isWorkspaceEntryShape(v: unknown): v is WorkspaceEntry {
  if (!isLegacyWorkspaceEntryShape(v)) return false;
  const e = v as unknown as Record<string, unknown>;
  return (
    typeof e.registration_id === "string" &&
    (e.kind === "directory" || e.kind === "loose-file") &&
    typeof e.worktree_path === "string" &&
    isAbsolute(e.worktree_path) &&
    typeof e.bus_path === "string" &&
    isAbsolute(e.bus_path) &&
    isTrackingShape(e.tracking) &&
    // Held-review finding (fourth pass): "isWorkspaceEntryShape never calls
    // isWorkspaceLifecycleShape" — `lifecycle` is optional, but a PRESENT value must still be one
    // of the real union variants; a malformed one (unknown `state`, or a "forgetting"/"adopting"/
    // "adopted" variant missing its own required fields) previously passed straight through,
    // untyped, into every later `entry.lifecycle?.state === "..."` read in this file and http.ts.
    (e.lifecycle === undefined || isWorkspaceLifecycleShape(e.lifecycle))
  );
}

/** Every non-`"active"` `WorkspaceLifecycle` variant names an id/timestamp string field — this is
 * the one shared "is it a genuinely non-empty string" check every per-state validator below reuses,
 * so a variant can never pass on an empty-string placeholder any more than `isForgetMemberShape`'s
 * own non-empty-string fields can. */
function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** `"adopting"` shape alone — shared with `"adopted"` below, which is the SAME shape plus its own
 * additionally-required `sealed_at`. Kept as its own function (held-review finding, final pass:
 * "split lifecycle validators by state") rather than one combined `case "adopting": case "adopted":`
 * branch, so `"adopted"`'s extra field can never be accidentally dropped by a future edit that only
 * looks at the shared branch. */
function isAdoptingLifecycleShape(l: Record<string, unknown>): boolean {
  return isNonEmptyString(l.adoption_id) && isNonEmptyString(l.target_registration_id);
}

/** Held-review finding (final pass): "`adopted` lifecycle validation accepts a missing `sealed_at`,
 * including inside `prior_lifecycle`" — the combined `"adopting"`/`"adopted"` branch this replaces
 * checked only the fields the two states share, so an `"adopted"` value missing its own `sealed_at`
 * (the field that actually MAKES it sealed rather than merely in-flight) passed validation exactly
 * like a genuine `"adopting"` value would. Reached both from `isWorkspaceEntryShape` (a live entry's
 * own `lifecycle`) and `isForgetMemberShape` (a snapshot member's `prior_lifecycle`) — a sealed
 * source's `prior_lifecycle` missing `sealed_at` is exactly as untrustworthy as a live entry's. */
function isAdoptedLifecycleShape(l: Record<string, unknown>): boolean {
  return isAdoptingLifecycleShape(l) && isNonEmptyString(l.sealed_at);
}

function isForgettingLifecycleShape(l: Record<string, unknown>): boolean {
  return isNonEmptyString(l.started_at) && isNonEmptyString(l.target_registration_id);
}

/** Minimal structural check for the `WorkspaceLifecycle` union — used to validate both a live
 * entry's own `lifecycle` (`isWorkspaceEntryShape`) and a forget member's `prior_lifecycle`
 * (`isForgetMemberShape`; held-review finding, second pass: schema-v4 validation "accepts
 * semantically corrupt operations"). Extra unrecognized fields on an otherwise-valid variant are
 * tolerated (forward-compatible), matching every other shape check in this file. Dispatches to one
 * validator PER state rather than a single combined check (held-review finding, final pass) — see
 * `isAdoptedLifecycleShape`'s own docstring for the exact gap that combining `"adopting"`/`"adopted"`
 * left open. */
function isWorkspaceLifecycleShape(v: unknown): v is WorkspaceLifecycle {
  if (typeof v !== "object" || v === null) return false;
  const l = v as Record<string, unknown>;
  switch (l.state) {
    case "active":
      return true;
    case "adopting":
      return isAdoptingLifecycleShape(l);
    case "adopted":
      return isAdoptedLifecycleShape(l);
    case "forgetting":
      return isForgettingLifecycleShape(l);
    default:
      return false;
  }
}

/** Held-review finding: "the v4 index validator does not validate forget-operation records and
 * members before later dereference" — an on-disk `forget_operations` blob with a missing/malformed
 * member (no `bus_path`, wrong `kind`, ...) previously passed `isWorkspaceIndexShape` untouched,
 * so a later read (`beginForgetOperation`'s snapshot merge, `completeForgetOperation`, the HTTP
 * status route's own member walk) could dereference a field that was never actually there.
 *
 * Second pass (held-review, further finding): field-type checks alone still accepted a
 * semantically corrupt record — `members: []`, a target absent from its own member list, a
 * duplicate registration id, or a relative path. Every non-empty-string check below additionally
 * requires a genuinely non-empty string (an empty string is not a usable id/path either), and
 * both path fields must be absolute — exactly the invariant `WorkspaceEntry`'s own
 * `worktree_path`/`bus_path` already hold (`isWorkspaceEntryShape`, above). */
function isForgetMemberShape(v: unknown): v is ForgetMember {
  if (typeof v !== "object" || v === null) return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m.registration_id === "string" &&
    m.registration_id.length > 0 &&
    typeof m.slug === "string" &&
    m.slug.length > 0 &&
    typeof m.canonical_path === "string" &&
    isAbsolute(m.canonical_path) &&
    typeof m.worktree_path === "string" &&
    isAbsolute(m.worktree_path) &&
    (m.kind === "directory" || m.kind === "loose-file") &&
    typeof m.bus_path === "string" &&
    isAbsolute(m.bus_path) &&
    isWorkspaceLifecycleShape(m.prior_lifecycle)
  );
}

function isForgetOperationRecordShape(v: unknown): v is ForgetOperationRecord {
  if (typeof v !== "object" || v === null) return false;
  const op = v as Record<string, unknown>;
  if (
    typeof op.operation_id !== "string" ||
    op.operation_id.length === 0 ||
    typeof op.target_registration_id !== "string" ||
    op.target_registration_id.length === 0 ||
    typeof op.target_slug !== "string" ||
    op.target_slug.length === 0 ||
    !Array.isArray(op.members) ||
    op.members.length === 0 || // "members: []" — a forget operation always has at least its target
    !op.members.every(isForgetMemberShape) ||
    typeof op.started_at !== "string" ||
    (op.completed_at !== undefined && typeof op.completed_at !== "string")
  ) {
    return false;
  }
  const members = op.members as ForgetMember[];
  // Every member registration id is unique — a duplicate is unrepresentable in the real index
  // (`Record<registration_id, WorkspaceEntry>`) and would silently double-count on any later walk.
  if (new Set(members.map((m) => m.registration_id)).size !== members.length) return false;
  // Exactly one member IS the target, and its own slug agrees with `target_slug` — a target
  // "operation" with no matching member (or a stale/mismatched slug) has nothing coherent to act on.
  const targetMembers = members.filter((m) => m.registration_id === op.target_registration_id);
  return targetMembers.length === 1 && targetMembers[0]!.slug === op.target_slug;
}

/** Map-key/record consistency for `forget_operations` (held-review finding): the persisted map key
 * MUST equal the record's own `operation_id` — a mismatch is unrepresentable by any code path in
 * this file (every write keys by the id it just minted) and is evidence the whole map cannot be
 * trusted, so it quarantines the same as a per-record shape failure. */
function isForgetOperationsMapShape(v: unknown): v is Record<string, ForgetOperationRecord> {
  if (typeof v !== "object" || v === null) return false;
  return Object.entries(v as Record<string, unknown>).every(
    ([key, value]) => isForgetOperationRecordShape(value) && (value as ForgetOperationRecord).operation_id === key,
  );
}

/** Map-key/record consistency for `workspaces` (held-review finding, fourth pass — "map keys/
 * registration identities"): the persisted map key MUST equal the entry's own `registration_id`,
 * mirroring `isForgetOperationsMapShape`'s existing convention for `forget_operations`. Every write
 * path in this file keys by the id the entry itself carries (`upsertWorkspace`, `createEntry`), so
 * a mismatch is unrepresentable by real code and is evidence the whole map cannot be trusted. */
function isWorkspaceMapShape(v: unknown): v is Record<string, WorkspaceEntry> {
  if (typeof v !== "object" || v === null) return false;
  return Object.entries(v as Record<string, unknown>).every(
    ([key, value]) => isWorkspaceEntryShape(value) && (value as WorkspaceEntry).registration_id === key,
  );
}

/** Held-review finding (fourth pass, extended in the final held pass): "schema-v4 loading still
 * does not validate... operation/member/target cross-record consistency", and (final pass) "schema-
 * v4 graph validation does not compare every live member identity field with its immutable
 * operation snapshot" — checking `lifecycle.state`/`target_registration_id` alone let a live row
 * whose `canonical_path`/`kind`/`bus_path`/`worktree_path`/`slug` had drifted from what the durable
 * operation actually captured pass loading unnoticed, exactly the same drift
 * `forget-workspace.ts`'s `resolveResumeMembers` already refuses at USE time. Two directions, both
 * required, checked only against ACTIVE (uncompleted) operations — a completed one no longer
 * governs any live lifecycle:
 *   1. Every member an active operation names, IF it still has a live workspace row (a member whose
 *      registration was already removed by an earlier interrupted attempt is a normal, expected
 *      registration-less state — never a contradiction), must carry a `"forgetting"` lifecycle
 *      pointing at EXACTLY that operation's own target, AND every other identity field the snapshot
 *      captured (`slug`, `canonical_path`, `kind`, `bus_path`, `worktree_path`) must still agree
 *      with the live row byte-for-byte — a live row that has drifted from its own immutable
 *      snapshot is exactly as untrustworthy as one with the wrong lifecycle state.
 *   2. Every live workspace row that IS marked `"forgetting"` must be named by SOME active
 *      operation's own member snapshot for that exact target ("unaccounted forgetting rows") —
 *      never a lifecycle marker with no operation record behind it at all.
 *   3. Target-last (held-review finding, fifth pass): `forget-workspace.ts`'s `commitForgetLocked`
 *      always removes every source registration BEFORE the target's own — the target's row is by
 *      construction the LAST one to disappear. So an active operation whose target row is already
 *      absent may NEVER still have a live row for any other snapshotted member; that combination
 *      ("target row is absent but whose source row remains live passes schema-v4 validation, then
 *      the missing-target branch stamps completion without deleting that source bus" — the exact
 *      held-review finding) is unreachable under normal operation and untrustworthy input
 *      otherwise. `completeForgetOperation` independently refuses the same state at USE time (see
 *      its own docstring) — this is the LOAD-time half of that same invariant, so a resume can
 *      never even observe it long enough to reach that runtime check.
 * This is the SAME invariant `forget-workspace.ts`'s `resolveResumeMembers` already enforces at
 * USE time (its own "extras" check); this closes the gap at LOAD time, before any runtime lookup
 * or deletion ever runs — fail-closed/quarantine, never a silent accept. */
function isLifecycleOperationGraphConsistent(
  workspaces: Record<string, WorkspaceEntry>,
  forgetOperations: Record<string, ForgetOperationRecord>,
): boolean {
  const activeOps = Object.values(forgetOperations).filter((op) => !op.completed_at);

  for (const op of activeOps) {
    const targetLive = op.target_registration_id in workspaces;
    for (const member of op.members) {
      const live = workspaces[member.registration_id];
      if (!live) continue; // already deregistered by an earlier interrupted attempt — expected
      // Target-last invariant (point 3 above): a live source row can never outlive the target's
      // own row under an active operation — checked before the identity/lifecycle check below so
      // this exact impossible combination is named on its own terms, not folded into a generic
      // "lifecycle disagrees" failure.
      if (!targetLive && member.registration_id !== op.target_registration_id) return false;
      if (
        live.lifecycle?.state !== "forgetting" ||
        live.lifecycle.target_registration_id !== op.target_registration_id ||
        live.slug !== member.slug ||
        live.canonical_path !== member.canonical_path ||
        live.kind !== member.kind ||
        live.bus_path !== member.bus_path ||
        live.worktree_path !== member.worktree_path
      ) {
        return false;
      }
    }
  }

  for (const entry of Object.values(workspaces)) {
    if (entry.lifecycle?.state !== "forgetting") continue;
    const targetId = entry.lifecycle.target_registration_id;
    const covered = activeOps.some(
      (op) =>
        op.target_registration_id === targetId && op.members.some((m) => m.registration_id === entry.registration_id),
    );
    if (!covered) return false;
  }

  return true;
}

function isWorkspaceIndexShape(v: unknown): v is WorkspaceIndexFile {
  if (typeof v !== "object" || v === null) return false;
  const f = v as Record<string, unknown>;
  if (
    f.version !== 4 ||
    typeof f.updated_at !== "string" ||
    typeof f.workspaces !== "object" ||
    f.workspaces === null ||
    typeof f.adoptions !== "object" ||
    f.adoptions === null ||
    typeof f.forget_operations !== "object" ||
    f.forget_operations === null
  ) {
    return false;
  }
  if (!isWorkspaceMapShape(f.workspaces) || !isForgetOperationsMapShape(f.forget_operations)) return false;
  return isLifecycleOperationGraphConsistent(
    f.workspaces as Record<string, WorkspaceEntry>,
    f.forget_operations as Record<string, ForgetOperationRecord>,
  );
}

function isV3WorkspaceIndexShape(v: unknown): v is V3WorkspaceIndexFile {
  if (typeof v !== "object" || v === null) return false;
  const f = v as Record<string, unknown>;
  return (
    f.version === 3 &&
    typeof f.updated_at === "string" &&
    typeof f.workspaces === "object" &&
    f.workspaces !== null &&
    typeof f.adoptions === "object" &&
    f.adoptions !== null &&
    Object.values(f.workspaces as Record<string, unknown>).every(isWorkspaceEntryShape)
  );
}

function isV2WorkspaceIndexShape(v: unknown): v is V2WorkspaceIndexFile {
  if (typeof v !== "object" || v === null) return false;
  const f = v as Record<string, unknown>;
  return (
    f.version === 2 &&
    typeof f.updated_at === "string" &&
    typeof f.workspaces === "object" &&
    f.workspaces !== null &&
    Object.values(f.workspaces as Record<string, unknown>).every(isWorkspaceEntryShape)
  );
}

function isLegacyWorkspaceIndexShape(v: unknown): v is LegacyWorkspaceIndexFile {
  if (typeof v !== "object" || v === null) return false;
  const f = v as Record<string, unknown>;
  return (
    f.version === 1 &&
    typeof f.updated_at === "string" &&
    typeof f.workspaces === "object" &&
    f.workspaces !== null &&
    Object.values(f.workspaces as Record<string, unknown>).every(isLegacyWorkspaceEntryShape)
  );
}

function redirectedBusPath(home: string, id: string): string {
  return join(home, "state", id);
}

function canonicalPath(path: string): string {
  const real = realpathSync(path).normalize("NFC");
  return real.length > 1 && real.endsWith("/") ? real.slice(0, -1) : real;
}

function relativeNfc(root: string, path: string): string {
  return relative(root, path)
    .split(sep)
    .map((part) => part.normalize("NFC"))
    .join("/");
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function bigintIdentity(path: string): { dev: string; ino: string } {
  const stat = statSync(path, { bigint: true });
  return { dev: stat.dev.toString(), ino: stat.ino.toString() };
}

function sameIdentity(a: { dev: string; ino: string }, b: { dev: string; ino: string }): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

// A5 §F19: "GC (on start + throttled ≥60s)"; "hard-remove only ... present:false ≥ grace period."
// Neither number is pinned by the spec — both are conservative defaults, overridable via deps
// (tests inject small values so the grace/throttle windows don't require real wall-clock waits).
const DEFAULT_GC_GRACE_MS = 24 * 60 * 60 * 1000; // 24h
const DEFAULT_GC_THROTTLE_MS = 60_000; // 60s

export interface WorkspaceIndexDeps {
  home?: string;
  now?: () => Date;
  mutex?: AsyncMutex;
  gcGraceMs?: number;
  gcThrottleMs?: number;
  /** Does `canonicalPath` currently have a live session bound to it? Consulted only by GC's
   * hard-remove check — a live session is proof the workspace still matters no matter how long
   * its path has been missing. Defaults to "no live session" so a standalone `WorkspaceIndex`
   * (as used in most of this file's own tests) works without a `SessionRegistry`; production
   * wiring calls `setLiveSessionPredicate` once both are constructed (see session-registry.ts's
   * module docstring for the wiring snippet). */
  hasLiveSession?: (canonicalPath: string) => boolean;
  /** Does `canonicalPath` currently exist on disk? Defaults to `existsSync`; injectable so GC
   * tests don't need real directories on disk. */
  pathExists?: (canonicalPath: string) => boolean;
  /** Can a fresh local bus be created beneath this directory? Defaults to an access(2)
   * write/search check; injectable for deterministic permission tests. Existing local buses are
   * authoritative and never consult this predicate. */
  canCreateLocalBus?: (canonicalPath: string) => boolean;
  /** Fired once for each registration GC actually hard-removes (never for a soft `present:false`
   * — only real removal from the index). Defaults to a no-op. Production wiring calls
   * `setOnHardRemove` once a `WorkspaceBusRegistry` exists — see `setOnHardRemove`'s own docstring
   * for the snippet — so a hard-removed workspace's open `WorkspaceBus` (journal fd, mutex slot,
   * in-memory state) is evicted in step, not leaked. */
  onHardRemove?: (entry: WorkspaceEntry) => void | Promise<void>;
  /** Does this registration's bus still hold journal-derived pending (non-terminal) entries?
   * Consulted only by GC's hard-remove check (issue #79): parked user work — e.g. annotations
   * created in a workspace that was never `glosa init`'d, waiting for delivery — must never be
   * erased just because the workspace path went missing. This matters most for home-redirected
   * buses (`~/.glosa/state/<id>`), where removing the registration orphans the bus with the work
   * still inside. Defaults to a read-only journal fold (`bus/peek.ts`) against the entry's own
   * `bus_path`; ANY fold failure counts as "has pending" — fail-safe, never remove on
   * uncertainty. `forget()` deliberately bypasses this (explicit user command stays forceful). */
  hasPendingWork?: (entry: WorkspaceEntry) => boolean;
  /** The raw `write(2)` behind `persist()`'s temp-file write. Defaults to node:fs `writeSync`.
   * Test-only, and deliberately NOT reachable from any config/env surface — production wiring
   * (`lifecycle.ts`'s `buildBackend`) constructs this index with a fixed dep literal. The fault
   * suite injects one that throws ENOSPC or returns a short count, which is the only way to
   * exercise "a durable write failed" without a real full or read-only `~/.glosa`. */
  write?: WriteSync;
  slug?: SlugDeps;
}

export interface GcResult {
  softened: string[];
  removed: string[];
}

export class WorkspaceIndex {
  private readonly path: string;
  private readonly home: string;
  private readonly mutex: AsyncMutex;
  private readonly now: () => Date;
  private readonly gcGraceMs: number;
  private readonly gcThrottleMs: number;
  private readonly pathExists: (canonicalPath: string) => boolean;
  private readonly canCreateLocalBus: (canonicalPath: string) => boolean;
  private readonly slugDeps: SlugDeps;
  private hasLiveSession: (canonicalPath: string) => boolean;
  private readonly hasPendingWork: (entry: WorkspaceEntry) => boolean;
  private readonly write: WriteSync;
  // Whether SOMEONE (constructor deps or a later `setLiveSessionPredicate` call) ever actually
  // told this index whether live sessions exist. Distinct from `hasLiveSession` itself — a
  // default `() => false` predicate is indistinguishable from "genuinely wired to say never" once
  // it's just a function, so GC needs this separate flag to tell "wired, and the answer is no"
  // apart from "nobody wired anything yet."
  private liveSessionPredicateWired: boolean;
  private onHardRemove: (entry: WorkspaceEntry) => void | Promise<void>;
  private cache: WorkspaceIndexFile | null = null;
  private lastGcAt = -Infinity;

  constructor(deps: WorkspaceIndexDeps = {}) {
    this.home = deps.home ?? glosaHome();
    this.path = workspaceIndexPath(this.home);
    this.mutex = deps.mutex ?? new AsyncMutex();
    this.now = deps.now ?? (() => new Date());
    this.gcGraceMs = deps.gcGraceMs ?? DEFAULT_GC_GRACE_MS;
    this.gcThrottleMs = deps.gcThrottleMs ?? DEFAULT_GC_THROTTLE_MS;
    this.hasLiveSession = deps.hasLiveSession ?? (() => false);
    this.liveSessionPredicateWired = deps.hasLiveSession !== undefined;
    this.pathExists = deps.pathExists ?? existsSync;
    this.canCreateLocalBus =
      deps.canCreateLocalBus ??
      ((canonicalPath) => {
        try {
          accessSync(canonicalPath, fsConstants.W_OK | fsConstants.X_OK);
          return true;
        } catch {
          return false;
        }
      });
    this.onHardRemove = deps.onHardRemove ?? (() => {});
    this.hasPendingWork =
      deps.hasPendingWork ??
      ((entry) => {
        try {
          return pendingCount(peekJournalAt(entry.bus_path).state) > 0;
        } catch {
          return true; // fail-safe: an unreadable journal is treated as "work still parked here"
        }
      });
    this.write = deps.write ?? writeSync;
    this.slugDeps = deps.slug ?? {};
  }

  /** Wires in the predicate GC uses to never hard-remove a workspace under a live session.
   * Production callers set this once, right after constructing both this index and the
   * `SessionRegistry` that shares it — see session-registry.ts. Also flips `gc()` from its
   * unwired conservative mode (soft-delete only, see the constructor comment on
   * `liveSessionPredicateWired`) into real hard-remove-eligible mode. */
  setLiveSessionPredicate(fn: (canonicalPath: string) => boolean): void {
    this.hasLiveSession = fn;
    this.liveSessionPredicateWired = true;
  }

  /** Wires in the callback GC fires for each registration it actually hard-removes. Production callers
   * set this once, right after constructing both this index and a `WorkspaceBusRegistry`:
   *   const busRegistry = new WorkspaceBusRegistry();
   *   index.setOnHardRemove((entry) => busRegistry.evict(entry));
   * Without this wired, a hard-removed workspace's `WorkspaceBus` (open journal fd, `KeyedMutex`
   * slot, in-memory state) would otherwise leak forever, and a later reuse of the same canonical
   * path would return that stale instance instead of a fresh one. */
  setOnHardRemove(fn: (entry: WorkspaceEntry) => void | Promise<void>): void {
    this.onHardRemove = fn;
  }

  private load(): WorkspaceIndexFile {
    if (this.cache) return this.cache;
    if (existsSync(this.path)) {
      let parsed: unknown;
      let valid = false;
      try {
        parsed = JSON.parse(readFileSync(this.path, "utf8"));
        valid = isWorkspaceIndexShape(parsed);
      } catch {
        valid = false;
      }
      if (valid) {
        this.cache = parsed as WorkspaceIndexFile;
        return this.cache;
      }
      if (isV3WorkspaceIndexShape(parsed)) {
        const migrated: WorkspaceIndexFile = {
          version: 4,
          updated_at: this.now().toISOString(),
          workspaces: parsed.workspaces,
          adoptions: parsed.adoptions,
          forget_operations: {},
        };
        this.persist(migrated);
        return migrated;
      }
      if (isV2WorkspaceIndexShape(parsed)) {
        const migrated: WorkspaceIndexFile = {
          version: 4,
          updated_at: this.now().toISOString(),
          workspaces: Object.fromEntries(
            Object.entries(parsed.workspaces).map(([id, entry]) => [
              id,
              { ...entry, lifecycle: entry.lifecycle ?? { state: "active" } },
            ]),
          ),
          adoptions: {},
          forget_operations: {},
        };
        this.persist(migrated);
        return migrated;
      }
      if (isLegacyWorkspaceIndexShape(parsed)) {
        const migrated: WorkspaceIndexFile = {
          version: 4,
          updated_at: this.now().toISOString(),
          workspaces: {},
          adoptions: {},
          forget_operations: {},
        };
        for (const legacy of Object.values(parsed.workspaces)) {
          const id = registrationId("directory", legacy.canonical_path);
          migrated.workspaces[id] = {
            ...legacy,
            registration_id: id,
            kind: "directory",
            worktree_path: legacy.canonical_path,
            bus_path: join(legacy.canonical_path, ".glosa"),
            tracking: { mode: "matcher" },
            lifecycle: { state: "active" },
          };
        }
        this.persist(migrated);
        return migrated;
      }
      // Corrupt OR invalid-shape on-disk content is never silently discarded — mirrors A4 §F04's
      // journal.quarantine convention (a bad record is preserved for inspection, not erased). The
      // next persist() would otherwise overwrite it with no trace at all of what was lost
      // (glosa-open/discovered sources, softened-but-not-yet-GC'd history, ...).
      this.quarantineCorruptFile();
    }
    this.cache = {
      version: 4,
      updated_at: this.now().toISOString(),
      workspaces: {},
      adoptions: {},
      forget_operations: {},
    };
    return this.cache;
  }

  /** The snapshot every MUTATOR works on: a detached deep copy of the last durable state.
   *
   * `load()` hands back `this.cache` by reference, so mutating it in place publishes the change to
   * every reader (`get`/`getBySlug`/`list`/`pendingAdoptions`, and therefore every route and GC
   * pass) BEFORE `persist()` has made it durable — and `persist()` genuinely can throw, on ENOSPC,
   * EROFS, EMFILE, or a read-only `<GLOSA_HOME>`. Nothing then restored the cache, so a `forget()`
   * whose write failed returned a 500 while memory had already lost the workspace, and the next
   * successful `persist()` — handed that same still-mutated object — committed the deletion the
   * user was told had failed. The same shape silently advanced GC hard-removes and the adoption
   * phase machine (A5 §F19's `active -> adopting -> adopted`), whose whole point is that a crashed
   * hand-off resumes from the phase that is actually ON DISK.
   *
   * Working on a copy makes `this.cache = index` at the end of `persist()` the single point where
   * a mutation becomes visible, on disk and in memory at once: readers see the last durable state
   * throughout, and a throw leaves both untouched. That is A4's "the daemon is the SOLE writer"
   * rule applied to its own in-memory view — an uncommitted write is not state.
   *
   * Cost is a non-issue: `persist()` already `JSON.stringify`s this exact object on every single
   * mutation, which is strictly more work than cloning it. */
  private loadForMutation(): WorkspaceIndexFile {
    return structuredClone(this.load());
  }

  /** Renames the corrupt/invalid-shape `workspaces.json` aside to `<path>.corrupt.<ISO-ts>`
   * before `load()` falls back to a fresh empty index. Uses the real wall clock (`new
   * Date().toISOString()`), deliberately NOT the injected `now` — this is a diagnostic artifact's
   * filename, not domain data, so it should record when the daemon actually noticed the
   * corruption. Best-effort: if the rename itself fails (e.g. a permissions issue), this logs and
   * moves on rather than blocking boot over a diagnostic nicety — losing the quarantine copy is
   * strictly worse than refusing to start, so it never throws. */
  private quarantineCorruptFile(): void {
    const quarantinePath = `${this.path}.corrupt.${new Date().toISOString()}`;
    try {
      renameSync(this.path, quarantinePath);
      console.warn(
        `glosa: ${this.path} was corrupt/unparseable — preserved at ${quarantinePath}; starting a fresh workspace index`,
      );
    } catch (err) {
      console.warn(
        `glosa: ${this.path} was corrupt/unparseable, and quarantining it also failed: ${(err as Error).message}`,
      );
    }
  }

  // P4.3: this daemon-side writer and the pre-daemon O_EXCL fallback (lockfile-fallback.ts's
  // `withFileLease`, guarding `fallbackWorkspacesLockPath`) do NOT currently coordinate — a hook
  // falling back to a direct write while the daemon is unreachable takes the fallback lease, but
  // `persist()` below never acquires it. That's fine today (zero production callers of the
  // fallback yet), but the task that wires the hook-side fallback caller MUST make both writers
  // share the SAME lease: either have `persist()` also wrap its temp->fsync->rename in
  // `withFileLease(fallbackWorkspacesLockPath(home), ...)`, or otherwise prove the two paths can
  // never run concurrently. Skipping this once the fallback has a real caller reopens exactly the
  // torn-write risk the O_EXCL lease exists to close. See the matching note in
  // lockfile-fallback.ts.

  /** Atomic temp -> fsync -> rename. Caller MUST already hold `this.mutex` — this only performs
   * the I/O, it doesn't serialize on its own (mirrors bus/inbox.ts's division of labor). */
  private persist(index: WorkspaceIndexFile): void {
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true });
    const tmpPath = join(dir, `.workspaces.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
    const bytes = Buffer.from(JSON.stringify(index, null, 2), "utf8");
    const fd = openSync(tmpPath, "wx");
    try {
      // A4 §F04 — "writeSync may write fewer bytes": a bare single write would silently
      // truncate the index into unparseable JSON, which the next load() would quarantine and
      // replace with an empty index. Same offset-advancing loop journal.ts/inbox.ts already use.
      writeAllSync(fd, bytes, this.write);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmpPath, this.path); // atomic on POSIX — replaces any previous file in one step
    fsyncContainingDir(this.path);
    this.cache = index;
  }

  /** Upserts a workspace entry. First sight of a canonical path assigns a slug (F25
   * collision-lengthening runs inside this same mutex critical section — "assign under
   * global-index lock"); an already-known path just refreshes `last_seen`/`present` and reuses
   * its existing slug unchanged (idempotent). This is the single place every session
   * registration, `glosa open`, and discovery sweep funnels through. */
  upsertWorkspace(canonicalPath: string, source: WorkspaceSource): Promise<WorkspaceEntry> {
    return this.mutex.runExclusive(() => {
      const index = this.loadForMutation();
      const now = this.now().toISOString();
      const existing = Object.values(index.workspaces).find(
        (entry) => entry.kind === "directory" && entry.canonical_path === canonicalPath,
      );

      if (existing) {
        existing.last_seen = now;
        existing.present = true;
        delete existing.absent_since;
        index.updated_at = now;
        this.persist(index);
        return existing;
      }

      const id = registrationId("directory", canonicalPath);
      const existingSlugEntries = Object.values(index.workspaces).map((e) => ({
        canonicalPath: e.canonical_path,
        slug: e.slug,
        slugLen: e.slug_len,
      }));
      const { slug, slugLen } = assignSlug(canonicalPath, existingSlugEntries, this.slugDeps);
      const localBus = join(canonicalPath, ".glosa");
      let busPath = localBus;
      if (!existsSync(localBus) && !this.canCreateLocalBus(canonicalPath)) {
        busPath = redirectedBusPath(this.home, id);
      }

      const entry: WorkspaceEntry = {
        registration_id: id,
        kind: "directory",
        canonical_path: canonicalPath,
        worktree_path: canonicalPath,
        bus_path: busPath,
        tracking: { mode: "matcher" },
        slug,
        slug_len: slugLen,
        source,
        first_seen: now,
        last_seen: now,
        present: true,
        lifecycle: { state: "active" },
      };
      index.workspaces[id] = entry;
      index.updated_at = now;
      this.persist(index);
      return entry;
    });
  }

  /** Resolves a raw `glosa open` target under the same global-index mutex that persists any new
   * registration. This closes the alias race: two concurrent hardlink opens cannot both observe
   * "no owner" and create divergent buses. `opts.focus` is an absolute or worktree-relative
   * artifact path for two-arg `glosa open <dir> <file>` — validated via confinement + tracked
   * membership after the directory registration is established. `focusFirst` selects the first
   * normalized tracked artifact only when no explicit focus was supplied; `requireFocus` turns an
   * empty tracked list into a stable error for document presentations.
   *
   * A FILE resolves, in order: the registered directory that contains and tracks it -> a
   * registered workspace that already tracks the same inode -> its enclosing git repository
   * (issue #96, when the repo's matcher tracks the file) -> a loose-file registration over its
   * containing directory. An explicitly named file that an owning directory excludes deliberately
   * skips the enclosing-repo promotion and reaches the bounded loose-file fallback. */
  /** True if `canonicalPath` is named as a member of some not-yet-completed forget operation.
   * Checked against the `index` object the CALLER already loaded inside its own mutex critical
   * section — deliberately NEVER a fresh `this.load()`/`this.pendingForgetOperations()` call, which
   * would reopen exactly the check-then-act gap this closes (held-review finding, final pass:
   * "`POST /api/workspaces/open` checks for a registration-less operation before `resolveOpenTarget`,
   * leaving a race in which forget can deregister between the check and registration mutation").
   * `forget`'s own steps (`beginForgetOperation`, `forget()`, `completeForgetOperation`) are each a
   * SEPARATE critical section on this SAME mutex, so a `resolveOpenTarget` call that reaches this
   * check is guaranteed to observe either the state strictly before `beginForgetOperation` ran (no
   * active operation yet — nothing to refuse) or the state at or after it (the operation is durably
   * recorded in this exact `index` object, however far the deletion itself has progressed) — never a
   * torn view assembled from two separate reads taken at two different points in time. */
  private hasActiveForgetOperation(index: WorkspaceIndexFile, canonicalPath: string): boolean {
    return Object.values(index.forget_operations).some(
      (op) => !op.completed_at && op.members.some((m) => m.canonical_path === canonicalPath),
    );
  }

  resolveOpenTarget(
    rawPath: string,
    opts: { externalState?: boolean; focus?: string; focusFirst?: boolean; requireFocus?: boolean } = {},
  ): Promise<WorkspaceOpenResult> {
    return this.mutex.runExclusive(() => {
      let leafStat: ReturnType<typeof lstatSync>;
      try {
        leafStat = lstatSync(rawPath);
      } catch {
        throw new WorkspaceOpenError("invalid-path", "path does not exist");
      }
      if (leafStat.isSymbolicLink()) {
        throw new WorkspaceOpenError("unsupported-file", "symlinks cannot be opened as artifacts");
      }

      let canonical: string;
      try {
        canonical = canonicalPath(rawPath);
      } catch {
        throw new WorkspaceOpenError("invalid-path", "path could not be canonicalized");
      }

      const index = this.loadForMutation();
      const now = this.now().toISOString();

      if (leafStat.isDirectory()) {
        const entry = this.upsertDirectoryForOpen(index, canonical, now, opts.externalState === true);

        if (opts.focus) {
          return { entry, focus: this.resolveFocusInEntry(entry, opts.focus) };
        }
        if (opts.focusFirst) {
          const first = resolveTrackedFiles(entry).tracked[0];
          if (first) return { entry, focus: first.path };
          if (opts.requireFocus) {
            throw new WorkspaceOpenError(
              "no-tracked-artifact",
              "document presentation requires at least one tracked artifact",
            );
          }
        }
        return { entry };
      }

      if (opts.focus) {
        throw new WorkspaceOpenError("invalid-path", "focus is only valid when the open target is a directory");
      }

      if (!leafStat.isFile()) {
        throw new WorkspaceOpenError("unsupported-file", "only regular files and directories can be opened");
      }

      const owning = Object.values(index.workspaces)
        .filter(
          (entry) =>
            entry.present &&
            entry.kind === "directory" &&
            entry.lifecycle?.state !== "forgetting" &&
            isInside(entry.worktree_path, canonical),
        )
        .sort((a, b) => b.worktree_path.length - a.worktree_path.length)[0];
      if (owning) {
        const matched = resolveTrackedFiles(owning).tracked.find(
          (file) => file.path === relativeNfc(owning.worktree_path, canonical),
        );
        if (matched) {
          owning.last_seen = now;
          owning.present = true;
          delete owning.absent_since;
          index.updated_at = now;
          this.persist(index);
          return { entry: owning, focus: matched.path };
        }
      }

      const identity = bigintIdentity(canonical);
      for (const entry of Object.values(index.workspaces)) {
        if (!entry.present || entry.lifecycle?.state === "forgetting") continue;
        // The deepest directory remains authoritative for normal workspace membership. When it
        // explicitly excludes the named file, only an existing bounded registration may claim
        // the inode; a shallower directory or unrelated matcher registration must not override
        // that exclusion merely because the file is hardlinked elsewhere.
        if (owning && entry.kind !== "loose-file") continue;
        for (const file of resolveTrackedFiles(entry).tracked) {
          try {
            if (sameIdentity(identity, bigintIdentity(file.rawPath))) {
              entry.last_seen = now;
              entry.present = true;
              delete entry.absent_since;
              index.updated_at = now;
              this.persist(index);
              return { entry, focus: file.path };
            }
          } catch {
            // A raced-away registered file cannot prove inode ownership; continue searching.
          }
        }
      }

      // No registration owns this file yet. Before falling back to a loose-file registration —
      // whose worktree is the file's CONTAINING DIRECTORY, and which is therefore what produced
      // `glosa open /tmp/doc.md` -> "run `glosa init /private/tmp`" (issue #96) — prefer the
      // file's enclosing git repository as a normal directory workspace. That is the same root
      // `glosa init`/`glosa doctor` resolve to, and the only root at which `.claude/settings.json`
      // actually takes effect, so all three commands now agree on one answer.
      //
      // Gated on the file being a TRACKED artifact of that repo: a file the repo's matcher
      // excludes (dot-dir, `node_modules`, > 2 MiB) would otherwise stop working entirely —
      // directory focus rejects an untracked file with `artifact-not-tracked`, while a direct
      // file target deliberately reaches the bounded loose-file path below.
      if (!owning) {
        const repoRoot = enclosingGitRoot(dirname(canonical));
        if (repoRoot !== null) {
          const repoFocus = relativeNfc(repoRoot, canonical);
          if (resolveMatchedFiles(repoRoot).tracked.some((file) => file.path === repoFocus)) {
            const entry = this.upsertDirectoryForOpen(index, repoRoot, now, opts.externalState === true);
            return { entry, focus: repoFocus };
          }
        }
      }

      if (this.hasActiveForgetOperation(index, canonical)) {
        throw new AdoptionError("workspace-forgetting", "workspace is being forgotten");
      }

      const worktree = canonicalPath(dirname(canonical));
      const focus = relativeNfc(worktree, canonical);
      const id = registrationId("loose-file", canonical);
      const entry = this.createEntry(index, {
        registration_id: id,
        kind: "loose-file",
        canonical_path: canonical,
        worktree_path: worktree,
        bus_path: redirectedBusPath(this.home, id),
        tracking: { mode: "bounded", paths: [focus] },
        file_identity: identity,
        source: "glosa-open",
      });
      return { entry, focus };
    });
  }

  /** Register-or-refresh `canonical` as a `directory` workspace, sourced `glosa-open`. Extracted
   * from `resolveOpenTarget`'s directory branch (issue #96) because the file branch now reaches
   * the SAME registration through the enclosing git repo: two copies of the bus-redirect ladder
   * would be two places for `externalState`/`canCreateLocalBus` to drift apart.
   *
   * Caller MUST already hold the index mutex and pass the mutex's `now` — this both mutates and
   * `persist()`s `index`, exactly as the inline block it replaces did. */
  private upsertDirectoryForOpen(
    index: WorkspaceIndexFile,
    canonical: string,
    now: string,
    externalState: boolean,
  ): WorkspaceEntry {
    const existing = Object.values(index.workspaces).find(
      (entry) => entry.kind === "directory" && entry.canonical_path === canonical,
    );
    if (existing) {
      // Held-review finding (final pass): the same atomic check below must also cover the
      // REGISTERED case — an existing row already mid a durable `glosa forget` (its own lifecycle
      // flipped to `"forgetting"` by `beginForgetOperation`, possibly before a single bus file has
      // even been touched yet) must never be silently refreshed and handed back as if `open` were
      // reopening an ordinary, unforgotten workspace.
      if (existing.lifecycle?.state === "forgetting") {
        throw new AdoptionError("workspace-forgetting", "workspace is being forgotten");
      }
      existing.last_seen = now;
      existing.present = true;
      delete existing.absent_since;
      index.updated_at = now;
      this.persist(index);
      return existing;
    }

    // No live registration for this exact canonical path — the registration-less window a `glosa
    // forget` deletion passes through between removing this row and stamping its completion
    // receipt. Checked here, inside the SAME mutex critical section that is about to create a
    // fresh registration, not as a separate pre-check the caller runs beforehand and then races
    // against (see `hasActiveForgetOperation`'s own docstring).
    if (this.hasActiveForgetOperation(index, canonical)) {
      throw new AdoptionError("workspace-forgetting", "workspace is being forgotten");
    }

    const id = registrationId("directory", canonical);
    const localBus = join(canonical, ".glosa");
    let busPath = localBus;
    if (externalState && !existsSync(localBus)) {
      busPath = redirectedBusPath(this.home, id);
    } else if (!existsSync(localBus) && !this.canCreateLocalBus(canonical)) {
      busPath = redirectedBusPath(this.home, id);
    }
    return this.createEntry(index, {
      registration_id: id,
      kind: "directory",
      canonical_path: canonical,
      worktree_path: canonical,
      bus_path: busPath,
      tracking: { mode: "matcher" },
      source: "glosa-open",
    });
  }

  /** Resolve an absolute or worktree-relative focus path against a directory registration:
   * must be an existing regular non-symlink file, confined under the worktree, and present in
   * the tracked-artifact list. */
  private resolveFocusInEntry(entry: WorkspaceEntry, rawFocus: string): string {
    const candidate = isAbsolute(rawFocus) ? rawFocus : join(entry.worktree_path, rawFocus);
    let focusStat: ReturnType<typeof lstatSync>;
    try {
      focusStat = lstatSync(candidate);
    } catch {
      throw new WorkspaceOpenError("invalid-path", "focus path does not exist");
    }
    if (focusStat.isSymbolicLink()) {
      throw new WorkspaceOpenError("unsupported-file", "symlinks cannot be opened as artifacts");
    }
    if (!focusStat.isFile()) {
      throw new WorkspaceOpenError("unsupported-file", "focus must be a regular file");
    }

    let focusCanonical: string;
    try {
      focusCanonical = canonicalPath(candidate);
    } catch {
      throw new WorkspaceOpenError("invalid-path", "focus path could not be canonicalized");
    }
    if (!isInside(entry.worktree_path, focusCanonical) && entry.worktree_path !== focusCanonical) {
      throw new WorkspaceOpenError("invalid-path", "focus path escapes the workspace");
    }

    const rel = relativeNfc(entry.worktree_path, focusCanonical);
    const matched = resolveTrackedFiles(entry).tracked.find((file) => file.path === rel);
    if (!matched) {
      throw new WorkspaceOpenError("artifact-not-tracked", "focus file is not in the workspace tracked artifact list");
    }
    return matched.path;
  }

  private createEntry(
    index: WorkspaceIndexFile,
    input: Pick<
      WorkspaceEntry,
      | "registration_id"
      | "kind"
      | "canonical_path"
      | "worktree_path"
      | "bus_path"
      | "tracking"
      | "file_identity"
      | "source"
    >,
  ): WorkspaceEntry {
    const now = this.now().toISOString();
    const existingSlugEntries = Object.values(index.workspaces).map((entry) => ({
      canonicalPath: entry.canonical_path,
      slug: entry.slug,
      slugLen: entry.slug_len,
    }));
    const { slug, slugLen } = assignSlug(input.canonical_path, existingSlugEntries, this.slugDeps);
    const entry: WorkspaceEntry = {
      ...input,
      slug,
      slug_len: slugLen,
      first_seen: now,
      last_seen: now,
      present: true,
      lifecycle: { state: "active" },
    };
    index.workspaces[entry.registration_id] = entry;
    index.updated_at = now;
    this.persist(index);
    return entry;
  }

  /** Claims every durable loose-file bus that becomes owned by `target`. This is deliberately
   * metadata only: callers seal the source journals before changing writer ownership, then call
   * the phase transitions below. Keeping the plan in the index makes a crash between those two
   * durable writes discoverable without treating the index as entry-status truth. */
  beginAdoption(target: WorkspaceEntry): Promise<AdoptionRecord | null> {
    return this.mutex.runExclusive(() => {
      const index = this.loadForMutation();
      const currentTarget = index.workspaces[target.registration_id];
      if (!currentTarget) throw new AdoptionError("adoption-blocked", "target workspace registration disappeared");
      // Symmetric with `forget-workspace.ts` refusing to forget an "adopting" target: a target
      // already durably committed to `glosa forget`'s deletion (issue #156) must never have its
      // marker overwritten by a NEW adoption transaction starting underneath it.
      if (currentTarget.lifecycle?.state === "forgetting") {
        throw new AdoptionError("workspace-forgetting", "workspace is being forgotten");
      }

      const existing = Object.values(index.adoptions).find(
        (record) => record.target_registration_id === target.registration_id && record.phase !== "committed",
      );
      if (existing) return existing;

      const localBus = join(target.worktree_path, ".glosa");
      if (target.kind !== "directory" || target.bus_path !== localBus) return null;

      const tracked = new Set(resolveTrackedFiles(target).tracked.map((file) => file.path));
      const sources: AdoptionSource[] = Object.values(index.workspaces)
        .filter(
          (entry) =>
            entry.kind === "loose-file" &&
            entry.present &&
            (entry.lifecycle?.state ?? "active") === "active" &&
            existsSync(entry.bus_path) &&
            isInside(target.worktree_path, entry.canonical_path),
        )
        .map((entry) => {
          const targetPath = relativeNfc(target.worktree_path, entry.canonical_path);
          const sourcePath = entry.tracking.mode === "bounded" ? (entry.tracking.paths[0] ?? targetPath) : targetPath;
          return { registration_id: entry.registration_id, source_path: sourcePath, target_path: targetPath };
        })
        .filter((source) => tracked.has(source.target_path))
        // This order is persisted in the adoption plan and drives source processing after a
        // restart, so it must not vary with the host's ICU locale. Compare the UTF-8 bytes
        // directly, matching A4's deterministic byte-order convention.
        .sort((a, b) => Buffer.compare(Buffer.from(a.registration_id, "utf8"), Buffer.from(b.registration_id, "utf8")));

      if (sources.length === 0) return null;
      if (existsSync(localBus)) {
        throw new AdoptionError("adoption-conflict", "workspace state already exists at the directory root");
      }

      const now = this.now().toISOString();
      const record: AdoptionRecord = {
        adoption_id: randomUUID(),
        target_registration_id: target.registration_id,
        phase: "planned",
        sources,
        created_at: now,
        updated_at: now,
      };
      index.adoptions[record.adoption_id] = record;
      currentTarget.lifecycle = {
        state: "adopting",
        adoption_id: record.adoption_id,
        target_registration_id: target.registration_id,
      };
      for (const source of sources) {
        const entry = index.workspaces[source.registration_id];
        if (entry) {
          entry.lifecycle = {
            state: "adopting",
            adoption_id: record.adoption_id,
            target_registration_id: target.registration_id,
          };
        }
      }
      index.updated_at = now;
      this.persist(index);
      return record;
    });
  }

  getAdoption(adoptionId: string): AdoptionRecord | null {
    return this.load().adoptions[adoptionId] ?? null;
  }

  getWorkspaceByRegistration(registrationId: string): WorkspaceEntry | null {
    return this.load().workspaces[registrationId] ?? null;
  }

  pendingAdoptions(): AdoptionRecord[] {
    return Object.values(this.load().adoptions).filter((record) => record.phase !== "committed");
  }

  markAdoptionSourcesSealed(adoptionId: string): Promise<AdoptionRecord> {
    return this.updateAdoption(adoptionId, "sources_sealed");
  }

  markAdoptionTargetPublished(adoptionId: string): Promise<AdoptionRecord> {
    return this.updateAdoption(adoptionId, "target_published");
  }

  commitAdoption(adoptionId: string): Promise<AdoptionRecord> {
    return this.mutex.runExclusive(() => {
      const index = this.loadForMutation();
      const record = index.adoptions[adoptionId];
      if (!record) throw new AdoptionError("adoption-blocked", "adoption record is missing");
      const now = this.now().toISOString();
      record.phase = "committed";
      record.updated_at = now;
      const target = index.workspaces[record.target_registration_id];
      if (target) target.lifecycle = { state: "active" };
      for (const source of record.sources) {
        const entry = index.workspaces[source.registration_id];
        if (entry) {
          entry.lifecycle = {
            state: "adopted",
            adoption_id: record.adoption_id,
            target_registration_id: record.target_registration_id,
            sealed_at: now,
          };
        }
      }
      index.updated_at = now;
      this.persist(index);
      return record;
    });
  }

  private updateAdoption(
    adoptionId: string,
    phase: Exclude<AdoptionPhase, "planned" | "committed">,
  ): Promise<AdoptionRecord> {
    return this.mutex.runExclusive(() => {
      const index = this.loadForMutation();
      const record = index.adoptions[adoptionId];
      if (!record) throw new AdoptionError("adoption-blocked", "adoption record is missing");
      if (record.phase === "committed") return record;
      record.phase = phase;
      record.updated_at = this.now().toISOString();
      index.updated_at = record.updated_at;
      this.persist(index);
      return record;
    });
  }

  getBySlug(slug: string): WorkspaceEntry | null {
    for (const entry of Object.values(this.load().workspaces)) {
      if (entry.slug === slug) return entry;
    }
    return null;
  }

  get(canonicalPath: string): WorkspaceEntry | null {
    const entries = Object.values(this.load().workspaces);
    return (
      entries.find((entry) => entry.canonical_path === canonicalPath) ??
      entries.find((entry) => entry.kind === "directory" && entry.worktree_path === canonicalPath) ??
      null
    );
  }

  list(opts: { presentOnly?: boolean } = {}): WorkspaceEntry[] {
    const entries = Object.values(this.load().workspaces);
    return opts.presentOnly ? entries.filter((e) => e.present) : entries;
  }

  /** Explicit `glosa forget <slug>` — hard-removes regardless of grace period or live-session
   * state, unlike GC's own conservative hard-remove below. Also fires `onHardRemove` (same as a
   * GC hard-remove — an explicitly forgotten workspace's `WorkspaceBus` must be evicted too, not
   * just a GC-driven one). Returns false if the slug is unknown. */
  forget(slug: string): Promise<boolean> {
    return this.mutex.runExclusive(async () => {
      const index = this.loadForMutation();
      const match = Object.values(index.workspaces).find((e) => e.slug === slug);
      if (!match) return false;
      delete index.workspaces[match.registration_id];
      index.updated_at = this.now().toISOString();
      this.persist(index);
      // Deliberately AFTER persist, never before: eviction closes the bus's journal fd and drops
      // its in-memory state, which is only safe once the removal is durable. A persist that throws
      // rejects here with the registration still intact in memory and on disk (see
      // `loadForMutation`), so this line is unreachable for a removal that did not actually happen.
      await this.onHardRemove(match);
      return true;
    });
  }

  /** Every registration `commitAdoption` sealed INTO `targetRegistrationId` — the historical
   * loose-file source buses `glosa forget` on a directory workspace must also remove so the
   * inbox/journal/checkpoint history stays one provenance unit (issue #156). A sealed source's
   * `lifecycle` never changes again after adoption commits, so this is a plain read, not a query
   * against the (separately GC'd) `adoptions` map. */
  sealedSourcesFor(targetRegistrationId: string): WorkspaceEntry[] {
    return this.list().filter(
      (entry) =>
        entry.lifecycle?.state === "adopted" && entry.lifecycle.target_registration_id === targetRegistrationId,
    );
  }

  /** The durable marker `glosa forget`'s deletion flow (`registry/forget-workspace.ts`) writes for
   * the target and every sealed source BEFORE deleting a single bus file — see the `"forgetting"`
   * variant's own docstring above for why this is what makes the flow crash-resumable, and why
   * every id carries the SAME `targetRegistrationId` (the target's own id for the target's own
   * entry, included in `registrationIds`). Idempotent: an id already marked, or one that no
   * longer exists (a prior crash already finished it), is silently skipped rather than erroring,
   * so a resumed call can pass the exact same id list every time. A no-op call (nothing left to
   * mark) never persists — mirrors `updateAdoption`'s committed-is-a-no-op convention so a resume
   * never writes a no-op `updated_at` bump. */
  markForgetting(registrationIds: readonly string[], targetRegistrationId: string): Promise<void> {
    return this.mutex.runExclusive(() => {
      const index = this.loadForMutation();
      const now = this.now().toISOString();
      let changed = false;
      for (const id of registrationIds) {
        const entry = index.workspaces[id];
        if (!entry || entry.lifecycle?.state === "forgetting") continue;
        entry.lifecycle = { state: "forgetting", started_at: now, target_registration_id: targetRegistrationId };
        changed = true;
      }
      if (!changed) return;
      index.updated_at = now;
      this.persist(index);
    });
  }

  /** Every entry already marked `"forgetting"` for `targetRegistrationId` — the target itself
   * (self-referencing, mirroring `"adopting"`'s convention) plus any sealed source the interrupted
   * attempt already flipped out of `"adopted"`. A RESUMED `forgetWorkspace` call must reconstruct
   * its full entry set from THIS, never from `sealedSourcesFor` again: a source already marked
   * `"forgetting"` no longer satisfies `sealedSourcesFor`'s `"adopted"` filter, so re-deriving the
   * set on resume the same way the first call did would silently orphan it. */
  forgettingMembersFor(targetRegistrationId: string): WorkspaceEntry[] {
    return this.list().filter(
      (entry) =>
        entry.lifecycle?.state === "forgetting" && entry.lifecycle.target_registration_id === targetRegistrationId,
    );
  }

  /** Begins (or, if one is already active for this target, returns) the durable `glosa forget`
   * operation record — issue #156's revised approach. Takes an immutable snapshot of `members`
   * (captured from the CALLER's already-resolved, live entries) and marks every member not
   * already `"forgetting"` in the SAME persisted write. Callers must invoke this BEFORE sealing or
   * deleting a single bus file: because the marker and the snapshot land together, a crash any
   * time after this call returns is both DISCOVERABLE (status/doctor sees `lifecycle:"forgetting"`
   * immediately — never a bus silently sealed with no durable trace) and fully RESUMABLE (the
   * snapshot survives every member's own registration later being removed, so a resumed call can
   * still report the complete original set — see `forget-workspace.ts`'s `commitForgetLocked`). */
  beginForgetOperation(target: WorkspaceEntry, members: readonly WorkspaceEntry[]): Promise<ForgetOperationRecord> {
    return this.mutex.runExclusive(() => {
      const index = this.loadForMutation();
      const existing = Object.values(index.forget_operations).find(
        (op) => op.target_registration_id === target.registration_id && !op.completed_at,
      );
      if (existing) return existing;

      const now = this.now().toISOString();
      const record: ForgetOperationRecord = {
        operation_id: randomUUID(),
        target_registration_id: target.registration_id,
        target_slug: target.slug,
        members: members.map((entry) => ({
          registration_id: entry.registration_id,
          slug: entry.slug,
          canonical_path: entry.canonical_path,
          worktree_path: entry.worktree_path,
          kind: entry.kind,
          bus_path: entry.bus_path,
          // Captured from `entry` (the CALLER's still-pre-mutation view — see this function's own
          // "members" param docstring) BEFORE the loop below ever flips it to "forgetting", so a
          // sealed source's true `"adopted"` state (not a bare "active") survives into the record.
          prior_lifecycle: entry.lifecycle ?? { state: "active" },
        })),
        started_at: now,
      };
      index.forget_operations[record.operation_id] = record;
      for (const member of members) {
        const entry = index.workspaces[member.registration_id];
        if (entry && entry.lifecycle?.state !== "forgetting") {
          entry.lifecycle = { state: "forgetting", started_at: now, target_registration_id: target.registration_id };
        }
      }
      index.updated_at = now;
      this.persist(index);
      return record;
    });
  }

  /** Reverts an operation that never got past the planned phase — a blocker (typically a
   * `LEASE_HELD` race lost against `beginForgetOperation`'s own lock-free preflight peek)
   * discovered before a single bus was actually sealed. Every still-registered member's lifecycle
   * is restored to its OWN captured `prior_lifecycle` (held-review finding: a sealed adopted
   * source's true `"adopted"` state must come back exactly as it was, never a bare `"active"` —
   * setting it to `"active"` would silently strip the `adoption_id`/`target_registration_id` a
   * later `sealedSourcesFor` needs to ever rediscover it, orphaning its bus permanently), and the
   * record is dropped entirely — never call this once ANY bus has been sealed or deleted, since at
   * that point the operation is committed to finishing, not abandoning. A no-op if the operation is
   * unknown or already completed (defensive; the commit path never calls this after
   * `completeForgetOperation`). */
  abortForgetOperation(operationId: string): Promise<void> {
    return this.mutex.runExclusive(() => {
      const index = this.loadForMutation();
      const record = index.forget_operations[operationId];
      if (!record || record.completed_at) return;
      for (const member of record.members) {
        const entry = index.workspaces[member.registration_id];
        if (
          entry &&
          entry.lifecycle?.state === "forgetting" &&
          entry.lifecycle.target_registration_id === record.target_registration_id
        ) {
          entry.lifecycle = member.prior_lifecycle ?? { state: "active" };
        }
      }
      delete index.forget_operations[operationId];
      index.updated_at = this.now().toISOString();
      this.persist(index);
    });
  }

  /** Stamps the operation's idempotent completion receipt. Never removed afterward — this is what
   * lets a retried `glosa forget <slug>` return the exact same full removal list even once every
   * member's registration is gone (see `forgetOperationForSlug`). Idempotent: completing an
   * already-completed operation is a silent no-op, never a duplicate `updated_at` bump.
   *
   * Held-review finding (fifth pass): schema-v4 LOAD-time validation
   * (`isLifecycleOperationGraphConsistent`'s own target-last invariant) already refuses to trust an
   * on-disk graph where the target row is absent while a snapshotted source row is still live, but
   * completion must never depend on that alone — this is the independent USE-time half of the same
   * guard. A caller reaching this method while ANY snapshotted member (target or source) still has
   * a live registration is refused outright: stamping `completed_at` here is the one durable claim
   * that "every member's bus and registration are gone," and it must never be made while that is
   * observably false, whatever upstream bug or future caller got here without finishing the
   * sources-first, target-last deletion loop first. */
  completeForgetOperation(operationId: string): Promise<ForgetOperationRecord> {
    return this.mutex.runExclusive(() => {
      const index = this.loadForMutation();
      const record = index.forget_operations[operationId];
      if (!record)
        throw new Error(`forget operation ${operationId} is missing — beginForgetOperation must precede completion`);
      if (!record.completed_at) {
        const stillLive = record.members.find((member) => index.workspaces[member.registration_id]);
        if (stillLive) {
          throw new Error(
            `forget operation ${operationId} cannot complete — registration ${stillLive.registration_id} (${stillLive.slug}) is still live`,
          );
        }
        record.completed_at = this.now().toISOString();
        index.updated_at = record.completed_at;
        this.persist(index);
      }
      return index.forget_operations[operationId]!;
    });
  }

  /** The active (not yet completed) forget operation for this target, if any — the resumed
   * commit path's first stop, so a retry reconstructs the complete original member set from the
   * durable snapshot rather than re-deriving a partial one from whatever is still registered. */
  activeForgetOperationForTarget(targetRegistrationId: string): ForgetOperationRecord | null {
    return (
      Object.values(this.load().forget_operations).find(
        (op) => op.target_registration_id === targetRegistrationId && !op.completed_at,
      ) ?? null
    );
  }

  /** Every not-yet-completed forget operation — `doctor`/status recovery reads this (via the
   * daemon boot sweep and `GET /api/status`) to surface an interrupted deletion even once the
   * target's own registration might already be gone. */
  pendingForgetOperations(): ForgetOperationRecord[] {
    return Object.values(this.load().forget_operations).filter((op) => !op.completed_at);
  }

  /** The active (not yet completed) forget operation naming `canonicalPath` as ANY of its
   * original members — target or adopted-source alias — or `null` if none does. Held-review
   * finding: "an active forget operation stops governing access once its target registration is
   * removed" — session registration, `glosa open`, and path-addressed inbox listing all resolve a
   * raw path via `WorkspaceIndex.get`/`upsertWorkspace`/`resolveOpenTarget`, none of which know
   * anything about a durable operation whose member registrations have already been removed; a
   * `null` live-registration lookup previously read as "never seen this path before" even while an
   * uncompleted deletion for it was still in flight. Callers MUST check this BEFORE creating or
   * reusing a registration for a path with no current entry — a completed operation (its receipt
   * stamped) no longer matches, so a legitimate reopen after full completion is never blocked. */
  activeForgetOperationForCanonicalPath(canonicalPath: string): ForgetOperationRecord | null {
    return (
      this.pendingForgetOperations().find((op) => op.members.some((m) => m.canonical_path === canonicalPath)) ?? null
    );
  }

  /** Resolves a forget operation by slug — matching either the ORIGINAL target slug or any
   * ORIGINAL member's slug, so a caller naming an adopted source already deleted by a resumed
   * attempt (or the target itself, before or after its own registration disappears) still finds
   * the same record. Prefers an active operation; falls back to the newest completed one — the
   * idempotent receipt a retry after full completion must still be able to read. */
  forgetOperationForSlug(slug: string): ForgetOperationRecord | null {
    const matches = Object.values(this.load().forget_operations).filter(
      (op) => op.target_slug === slug || op.members.some((member) => member.slug === slug),
    );
    if (matches.length === 0) return null;
    const active = matches.find((op) => !op.completed_at);
    if (active) return active;
    return matches.reduce((latest, op) => (op.started_at > latest.started_at ? op : latest));
  }

  /** Resolves a forget operation by TARGET REGISTRATION ID alone — never by slug. Held-review
   * finding (final pass): "commit resolves the target by stale slug; this can falsely complete
   * while a live registration remains" — a target's slug becomes free the instant its own
   * registration is removed (sources-first, target-last), and an entirely UNRELATED fresh
   * registration elsewhere can legitimately claim that exact same freed slug before this
   * operation's completion receipt lands. A commit that re-resolved "the target" via
   * `getBySlug(targetSlug)` at that point would silently act on the wrong workspace. Registration
   * id is immutable for the life of an operation (it never gets reassigned to a different canonical
   * identity), so it is the only identity `commitForgetLocked` may resolve through. Prefers an
   * active operation; falls back to the newest completed one, mirroring `forgetOperationForSlug`. */
  forgetOperationForTargetRegistration(targetRegistrationId: string): ForgetOperationRecord | null {
    const matches = Object.values(this.load().forget_operations).filter(
      (op) => op.target_registration_id === targetRegistrationId,
    );
    if (matches.length === 0) return null;
    const active = matches.find((op) => !op.completed_at);
    if (active) return active;
    return matches.reduce((latest, op) => (op.started_at > latest.started_at ? op : latest));
  }

  /** GC (A5 §F19). Runs at most once per `gcThrottleMs` unless `force` (daemon boot always
   * forces one immediate pass). For each entry:
   *   - path exists on disk -> ensure `present:true` (heals a path that came back).
   *   - path missing, currently `present:true` -> soften to `present:false` + stamp
   *     `absent_since` now. The grace clock starts THIS pass, never hard-removed in the same
   *     pass it went absent.
   *   - path missing, already `present:false` -> hard-remove only if there is no live session
   *     AND it's been absent for at least `gcGraceMs`. Conservative: a live session blocks
   *     removal indefinitely, no matter how long the path itself has been gone.
   * Every hard-removed path fires `onHardRemove` (awaited before this call resolves), strictly
   * AFTER the index write. That order is the correct one in both directions: the removal is
   * durable before any bus is torn down, so an eviction failure leaves only the bus registry
   * lagging (a leaked fd, recoverable) rather than the index claiming a workspace exists whose
   * state was already destroyed; and a `persist()` that throws rejects before this loop runs, with
   * every entry still intact in memory and on disk (see `loadForMutation`), so a workspace is
   * never evicted on the strength of a removal that did not happen.
   *
   * Safety when NOBODY has wired a live-session predicate yet (`liveSessionPredicateWired` is
   * still false — neither the constructor nor `setLiveSessionPredicate` ever supplied one): GC
   * never hard-removes anything, full stop, soft `present:false` only. The unwired default
   * predicate (`() => false`) would otherwise read as "definitely no live session," which is an
   * affirmative, wrong answer for an index that was simply never told — an unwired GC must stay
   * conservative rather than guess "no" by omission. */
  gc(opts: { force?: boolean } = {}): Promise<GcResult> {
    return this.mutex.runExclusive(async () => {
      const now = this.now();
      if (!opts.force && now.getTime() - this.lastGcAt < this.gcThrottleMs) {
        return { softened: [], removed: [] };
      }
      this.lastGcAt = now.getTime();

      const index = this.loadForMutation();
      const softened: string[] = [];
      const removed: string[] = [];
      const removedEntries: WorkspaceEntry[] = [];
      let changed = false;

      for (const [registrationId, entry] of Object.entries(index.workspaces)) {
        // A sealed adopted bus is a lineage locator, not disposable cache. Its original journal
        // remains the immutable truth for pre-adoption events, so ordinary missing-path GC must
        // never erase the registration that lets the target resolve it.
        if (entry.lifecycle && entry.lifecycle.state !== "active") continue;
        const canonicalPath = entry.canonical_path;
        if (this.pathExists(canonicalPath)) {
          if (!entry.present) {
            entry.present = true;
            delete entry.absent_since;
            changed = true;
          }
          continue;
        }

        if (entry.present) {
          entry.present = false;
          entry.absent_since = now.toISOString();
          softened.push(canonicalPath);
          changed = true;
          continue;
        }

        if (!this.liveSessionPredicateWired) continue; // unwired -> conservative, soft-delete only (see gc()'s docstring)
        if (this.hasLiveSession(canonicalPath)) continue; // conservative: never remove under a live session
        if (this.hasPendingWork(entry)) continue; // conservative: parked entries block removal indefinitely (issue #79); re-examined every pass, normal grace logic resumes once they reach a terminal status
        const absentSince = entry.absent_since ? new Date(entry.absent_since).getTime() : now.getTime();
        if (now.getTime() - absentSince >= this.gcGraceMs) {
          delete index.workspaces[registrationId];
          removed.push(canonicalPath);
          removedEntries.push(entry);
          changed = true;
        }
      }

      if (changed) {
        index.updated_at = now.toISOString();
        this.persist(index);
      }
      for (const entry of removedEntries) await this.onHardRemove(entry);
      return { softened, removed };
    });
  }
}

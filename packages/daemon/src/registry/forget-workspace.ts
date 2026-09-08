// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — `glosa forget <slug>` (issue #156): the one supported whole-bus deletion
// primitive. `WorkspaceIndex.forget(slug)` already removes a registration durably and evicts an
// open bus (see its own docstring in workspace-index.ts) but deliberately bypasses the
// live-session/apply-lease guards and never deletes a single bus file. This module is the layer
// above it: preflight refusal naming the blockers, confinement proven for the COMPLETE member set
// before any destructive side effect, whole-bus file deletion (target plus every historical sealed
// loose-file source adopted into it — A4's "Loose-to-directory adoption" keeps those at
// `~/.glosa/state/<id>` as permanent read-only lineage evidence, which stays one provenance unit
// with the target's own inbox/journal/checkpoints), and crash-resumable sequencing.
//
// Crash-resumability mirrors `adoption.ts`'s own multi-step transaction: durable phase state
// lives in the index itself (`WorkspaceLifecycle` `"forgetting"`, set on the target and every
// sealed source BEFORE any file is touched), never in a side file or in memory. A crash after
// that marker lands still resolves the same registration(s) by slug with lifecycle `"forgetting"`;
// the HTTP layer refuses new routing to ANY entry in that state — target or source — so nothing
// can race the resumed deletion. Re-running `forget` finds the marker and resumes.
//
// Two ordering invariants make a crash mid-deletion always resumable BY THE SAME SLUG:
//   1. Confinement is validated for the WHOLE member set BEFORE the durable marker is written or
//      any file is touched — a corrupted LATER member must never be discovered after an EARLIER
//      member's bus is already gone (that would be a forbidden partial purge with no way back).
//   2. Registrations are removed sources-first, target-last: the target's slug is the only key a
//      retried `glosa forget <slug>` can still name, so it must be the LAST registration to
//      disappear, never the first.
//
// Ownership: everything from "re-check the preflight" through "mark forgetting" runs inside the
// daemon's per-target `AdoptionCoordinator` lock — the SAME lock `adoptLooseLineages` already
// holds for its own seal/build/publish sequence — so a new adoption can never begin, and an
// in-flight one can never complete, while a forget of the same target is committing (and
// vice versa: `WorkspaceIndex.beginAdoption` refuses a `"forgetting"` target). The target's own
// apply-lease check is additionally re-proven ATOMICALLY at the moment of commit via
// `WorkspaceBus.sealForForget()` — appended under the exact same per-workspace mutex `apply-begin`
// uses — closing the narrower window between this module's own (necessarily lock-free) preflight
// peek and the instant deletion actually commits.
import { createHash } from "node:crypto";
import { existsSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AdoptionCoordinator } from "../adoption.ts";
import type { WorkspaceBus } from "../bus/bus.ts";
import { isLeaseExpired } from "../bus/lease.ts";
import { peekJournal } from "../bus/peek.ts";
import { registrationIdFor, type WorkspaceTarget } from "../workspace.ts";
import type { SessionRegistry } from "./session-registry.ts";
import type { ForgetMember, ForgetOperationRecord, WorkspaceEntry, WorkspaceIndex } from "./workspace-index.ts";

export type ForgetBlocker =
  | { kind: "live-session"; session_id: string }
  | { kind: "apply-lease"; lease_id: string; expires_at: string }
  /** The target is mid-adoption (`lifecycle.state === "adopting"`) — forgetting it now would
   * overwrite the durable marker `beginAdoption`'s own resumable transaction depends on. Reuses
   * the generic "blocked"/`forget-blocked` wire shape rather than a dedicated code: from the
   * caller's perspective this is the same "something else owns this workspace right now, retry
   * once it finishes" answer as a live session or an apply lease. */
  | { kind: "adopting" };

export interface ForgetBusEntry {
  registration_id: string;
  slug: string;
  canonical_path: string;
  kind: WorkspaceEntry["kind"];
  bus_path: string;
}

export interface ForgetDeps {
  workspaceIndex: WorkspaceIndex;
  sessionRegistry: SessionRegistry;
  /** `glosaHome()` — the redirected-bus root every loose-file/redirected registration's `bus_path`
   * must resolve beneath (the other of the two shapes `confineBusPathForDeletion` accepts). */
  home: string;
  /** Resolves the SAME `WorkspaceBus` instance the rest of the daemon uses for this root (backed
   * by the process's one `WorkspaceBusRegistry`) — needed only on the `confirm:true` commit path,
   * to seal the target's bus atomically against a late apply-begin. Never called during preview. */
  getWorkspaceBus: (workspace: WorkspaceTarget) => WorkspaceBus;
  /** The daemon's one per-target adoption lock. Holding it for the commit sequence mirrors exactly
   * how `adoptLooseLineages` already holds it for its own transaction, so a forget and an adoption
   * of the same target can never interleave in either direction. */
  adoptionCoordinator: AdoptionCoordinator;
}

export type ForgetOutcome =
  | { ok: false; code: "not-found" }
  /** `target_slug`/`requested_slug` differ only when `slug` named a sealed adopted source: the
   * blocker is reported against the OWNING target's slug, never the source's own — a source is
   * never treated as an independent provenance unit (issue #156 revised approach). */
  | { ok: false; code: "blocked"; blockers: ForgetBlocker[]; target_slug: string; requested_slug: string }
  /** Reached only if a bus path fails confinement (issue #156's "confinement must be proven
   * before the first destructive side effect") — a corrupted or foreign-pointing index record.
   * Refuses the WHOLE operation before anything is marked or deleted, since a corrupt record is
   * evidence the index itself cannot be trusted for this workspace right now. */
  | { ok: false; code: "confinement-failed"; registration_id: string }
  /** Held-review finding: "interactive confirmation is not bound to the previewed member set, so
   * an adoption completing during the prompt can expand deletion beyond the paths the user saw."
   * Returned when a `confirm:true` call carries a `memberFingerprint` that no longer matches the
   * CURRENT member set for a target whose forget has not yet begun (an adoption committed, or any
   * other member-set change, landed between the preview and this call) — zero deletions, exactly
   * like `confinement-failed`. Never reached on a resume: once `beginForgetOperation` has run the
   * member set is fixed for the life of the operation, so there is nothing left to go stale. */
  | {
      ok: false;
      code: "stale-preview";
      target_slug: string;
      requested_slug: string;
      entries: ForgetBusEntry[];
      member_fingerprint: string;
    }
  | {
      ok: true;
      confirmed: false;
      target_slug: string;
      requested_slug: string;
      entries: ForgetBusEntry[];
      /** A deterministic digest of `entries` (registration_id + bus_path, order-independent) that
       * a `confirm:true` retry can echo back as `memberFingerprint` to prove it is acting on
       * EXACTLY the member set this preview showed the human — see the `stale-preview` outcome
       * above and `memberFingerprint()`'s own docstring. */
      member_fingerprint: string;
    }
  | { ok: true; confirmed: true; target_slug: string; requested_slug: string; removed: ForgetBusEntry[] };

function toBusEntry(entry: WorkspaceEntry): ForgetBusEntry {
  return {
    registration_id: entry.registration_id,
    slug: entry.slug,
    canonical_path: entry.canonical_path,
    kind: entry.kind,
    bus_path: entry.bus_path,
  };
}

/** Strips the durable `ForgetOperationRecord`'s internal-only `prior_lifecycle` before a member
 * ever reaches a `ForgetOutcome` (and therefore the public HTTP response) — `prior_lifecycle` is
 * `abortForgetOperation`'s own rollback bookkeeping (held-review finding), never part of the wire
 * contract A1 documents for `would_remove`/`removed`. */
function membersToBusEntries(members: readonly ForgetMember[]): ForgetBusEntry[] {
  return members.map((m) => ({
    registration_id: m.registration_id,
    slug: m.slug,
    canonical_path: m.canonical_path,
    kind: m.kind,
    bus_path: m.bus_path,
  }));
}

/** A deterministic, order-independent digest of a member set — sorted by `registration_id` so the
 * exact same set of members always hashes identically regardless of iteration order (`Object.values`
 * over the index has no guaranteed order across two separate reads). Binds an interactive preview
 * to the exact member set the human was shown: a `confirm:true` call presents this back, and the
 * commit path recomputes it fresh against current state before committing to anything (held-review
 * finding: a preview-then-confirm gap must never let an adoption silently expand what gets deleted). */
function memberFingerprint(entries: readonly ForgetBusEntry[]): string {
  const sorted = [...entries]
    .map((e) => `${e.registration_id}:${e.bus_path}`)
    .sort((a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")));
  return createHash("sha256").update(sorted.join("\n"), "utf8").digest("hex");
}

/** Independently reconstructs the two facts confinement must not simply trust from a possibly
 * corrupted `WorkspaceEntry`: its `registration_id` and its `worktree_path`. Both are re-derived
 * from `canonical_path` alone (never from the fields being validated) and compared for equality —
 * held-review finding: "confinement derives both the candidate and expected local path from
 * coherently corruptible index fields, so coordinated `worktree_path` + `bus_path` corruption can
 * target a foreign `.glosa` directory." `canonical_path` is the index's own semantic key (used by
 * `WorkspaceIndex.get`/slug assignment) and is never itself part of this corruption class, so
 * anchoring both checks to it — rather than to the mutually-consistent-but-corruptible pair this
 * function exists to distrust — closes that gap. Deliberately filesystem-free (no `realpathSync`):
 * a workspace whose work-tree has since been removed must still validate, since `forget` is
 * required to keep working once a path is gone. */
function validateEntryAnchors(entry: WorkspaceEntry): boolean {
  if (registrationIdFor(entry.kind, entry.canonical_path) !== entry.registration_id) return false;
  const expectedWorktree = entry.kind === "directory" ? entry.canonical_path : dirname(entry.canonical_path);
  return expectedWorktree === entry.worktree_path;
}

/** Live-bound-session refusal (R3) plus a cheap, side-effect-free FIRST PASS at the apply-lease
 * blocker (A4 §F05) via a read-only `peekJournal` fold — no `WorkspaceBus`, no mutex, no fd, so a
 * preview or an early refusal never itself creates the very bus state it should leave completely
 * untouched. This is deliberately NOT the last word on the lease: the commit path re-proves it
 * atomically via `WorkspaceBus.sealForForget()` (see this module's header comment) — a lease that
 * appears in the gap between this peek and that seal is still caught, just later. */
function forgetBlockers(target: WorkspaceEntry, deps: Pick<ForgetDeps, "sessionRegistry">): ForgetBlocker[] {
  const blockers: ForgetBlocker[] = [];
  // `forWorkspaceOwnedBy`, not plain `forWorkspace`: a session still explicitly bound to a loose
  // source's OWN pre-adoption path must count as live for the target once that source has been
  // adopted into it — held-review finding (third pass), see the method's own docstring.
  for (const session of deps.sessionRegistry.forWorkspaceOwnedBy(target.registration_id, target.canonical_path)) {
    blockers.push({ kind: "live-session", session_id: session.session_id });
  }
  const lease = peekJournal(target).state.applyLease;
  if (lease && !isLeaseExpired(lease, new Date())) {
    blockers.push({ kind: "apply-lease", lease_id: lease.leaseId, expires_at: lease.expiresAt });
  }
  return blockers;
}

function realOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** Confinement gate: a bus directory is only ever eligible for deletion when its realpath
 * resolves to EXACTLY one of the two shapes `workspace-index.ts` itself ever constructs — local
 * `<worktree>/.glosa` or redirected `<GLOSA_HOME>/state/<registration_id>` (A4 §F04) — and never
 * to the work-tree root itself. `entry.bus_path` is never trusted at face value: a corrupted
 * index record pointing it at the work-tree, a symlink target, or any other foreign path is
 * refused rather than silently deleted. A path that no longer exists is a resumable no-op (a
 * prior crashed attempt may have already removed it) and needs no confinement proof — there is
 * nothing left to protect. */
export function confineBusPathForDeletion(
  entry: WorkspaceEntry,
  home: string,
): { path: string; existed: boolean } | null {
  // Fail closed BEFORE trusting `worktree_path`/`registration_id` for anything below — see
  // `validateEntryAnchors`'s own docstring for the corruption class this closes (held-review
  // finding: coordinated `worktree_path` + `bus_path` corruption could otherwise target a foreign
  // `.glosa` directory whose OWN realpath happens to coherently match the corrupted pair).
  if (!validateEntryAnchors(entry)) return null;
  if (!existsSync(entry.bus_path)) return { path: entry.bus_path, existed: false };
  const real = realOrNull(entry.bus_path);
  if (real === null) return null;
  const worktreeReal = realOrNull(entry.worktree_path);
  if (real === worktreeReal) return null;
  const localExpected = realOrNull(join(entry.worktree_path, ".glosa"));
  const redirectedExpected = realOrNull(join(home, "state", entry.registration_id));
  if (real !== localExpected && real !== redirectedExpected) return null;
  return { path: entry.bus_path, existed: true };
}

/** Validates confinement for the COMPLETE member set and returns the confirmed plan, or the first
 * failing registration id. Called BEFORE any durable marker or destructive step, so a corrupted
 * member never lets an earlier, valid member's bus get deleted first (issue #156's all-or-nothing
 * confinement requirement). */
function confineAll(
  entries: readonly WorkspaceEntry[],
  home: string,
): { ok: true; confined: Map<string, { path: string; existed: boolean }> } | { ok: false; registrationId: string } {
  const confined = new Map<string, { path: string; existed: boolean }>();
  for (const entry of entries) {
    const result = confineBusPathForDeletion(entry, home);
    if (result === null) return { ok: false, registrationId: entry.registration_id };
    confined.set(entry.registration_id, result);
  }
  return { ok: true, confined };
}

/** Held-review finding (third pass): "resume derives deletion candidates from mutable lifecycle
 * rows rather than solely from the immutable operation snapshot; unvalidated extra lifecycle rows
 * can authorize deletion of an unrelated bus." Once a durable `ForgetOperationRecord` exists,
 * `operation.members` — the immutable snapshot `beginForgetOperation` captured once, before a
 * single bus was touched — is the SOLE authority for what this resume may delete. A live
 * `WorkspaceEntry` whose own `lifecycle.state === "forgetting"` names this target is never trusted
 * on its own: it must ALSO appear in the snapshot, with matching identity, or the whole resume
 * refuses rather than risk sweeping an unrelated bus into the deletion.
 *
 * Returns the STILL-LIVE subset of the snapshot — a member whose own registration is already gone
 * (an earlier interrupted attempt got that far) is simply omitted; there is nothing left to
 * confine/delete/deregister for it, and `commitForgetLocked` reports the COMPLETE set from
 * `operation.members` regardless. Fails closed, naming the first offending registration id, when:
 *   - an entry named by the snapshot is still live but its `slug`/`canonical_path`/`kind`/
 *     `bus_path`/`worktree_path` has drifted from what was captured, or its lifecycle marker is
 *     missing or points at a different target — the index cannot be trusted for this member right
 *     now (held-review finding, final pass: "does not compare every live member identity field with
 *     its immutable operation snapshot" — checking only `canonical_path`/`kind`/`bus_path` left a
 *     drifted `slug` or `worktree_path` unnoticed); or
 *   - an EXTRA entry not named by the snapshot at all carries a `"forgetting"` marker for this same
 *     `target_registration_id` — exactly the unvalidated-extra-membership case the finding
 *     describes, whether from corruption or a coincidentally-reused marker. */
function resolveResumeMembers(
  index: WorkspaceIndex,
  operation: ForgetOperationRecord,
): { ok: true; members: WorkspaceEntry[] } | { ok: false; registrationId: string } {
  const snapshotIds = new Set(operation.members.map((m) => m.registration_id));
  const extras = index
    .forgettingMembersFor(operation.target_registration_id)
    .filter((entry) => !snapshotIds.has(entry.registration_id));
  if (extras.length > 0) return { ok: false, registrationId: extras[0]!.registration_id };

  const members: WorkspaceEntry[] = [];
  for (const snapshot of operation.members) {
    const live = index.getWorkspaceByRegistration(snapshot.registration_id);
    if (!live) continue;
    const lifecycleOk =
      live.lifecycle?.state === "forgetting" &&
      live.lifecycle.target_registration_id === operation.target_registration_id;
    if (
      !lifecycleOk ||
      live.slug !== snapshot.slug ||
      live.canonical_path !== snapshot.canonical_path ||
      live.kind !== snapshot.kind ||
      live.bus_path !== snapshot.bus_path ||
      live.worktree_path !== snapshot.worktree_path
    ) {
      return { ok: false, registrationId: snapshot.registration_id };
    }
    members.push(live);
  }
  return { ok: true, members };
}

/** An adopted source is never an independent provenance unit (issue #156 revised approach): a
 * `glosa forget <source-slug>` must resolve straight through to the target it was sealed into and
 * operate on the complete unit. `null` only if the index itself is inconsistent (the target
 * registration the source's own lifecycle names no longer exists) — reported as `not-found`
 * exactly like a plain unknown slug would be, since there is nothing coherent to act on. */
function resolveForgetTarget(index: WorkspaceIndex, entry: WorkspaceEntry): WorkspaceEntry | null {
  if (entry.lifecycle?.state === "adopted") {
    return index.getWorkspaceByRegistration(entry.lifecycle.target_registration_id);
  }
  return entry;
}

/** The full `glosa forget <slug>` flow (issue #156). `opts.confirm === false` (the default) is a
 * pure preview: runs the exact same preflight and returns the exact set of paths a `confirm:true`
 * call would remove, but never marks anything, seals anything, deletes anything, or removes the
 * registration — this is what lets interactive use show exact paths and ask once before any side
 * effect occurs. `opts.confirm === true` performs the deletion (or resumes one already in
 * progress).
 *
 * Resolution order (independent review, second pass — this is the authoritative fix for findings
 * 1, 2 and 5):
 *
 *   1. A LIVE registration for `slug` whose OWN lifecycle is anything other than `"forgetting"` is
 *      always authoritative over any historical operation record — a workspace forgotten and then
 *      reopened at the same path legitimately reuses the same deterministic registration_id and
 *      slug (registrationId is a hash of kind+canonical_path, `workspace.ts`), and a stale
 *      completion receipt must never eclipse that fresh registration (finding 5). This is also
 *      where an adopted-source slug resolves to its owning target via `resolveForgetTarget`.
 *   2. Otherwise (no live registration, OR one exists but is itself mid-deletion) the durable
 *      `ForgetOperationRecord` is authoritative for target identity, member snapshot, and the
 *      coordinator lock key — resolved by slug against EITHER the target's own slug or any
 *      original member's slug, regardless of which one `slug` names (finding 2: a retry addressed
 *      by an adopted source's own slug, whose lifecycle has since flipped from `"adopted"` to
 *      `"forgetting"`, must still resolve to the SAME operation the target's slug would). This
 *      also closes finding 1's crash window: the target's own registration can be fully removed
 *      (process died between deregistration and `completeForgetOperation`) and a retry by ANY
 *      original member's slug still finds the operation, never a false `not-found`. */
export async function forgetWorkspace(
  deps: ForgetDeps,
  slug: string,
  opts: {
    confirm: boolean;
    /** Echoes a prior `confirm:false` preview's `member_fingerprint` back on the matching
     * `confirm:true` call — see `memberFingerprint`'s own docstring. Omit for a `--yes`-style
     * commit with no preceding preview: there is nothing to bind staleness against, so the commit
     * proceeds exactly as it always has. */
    memberFingerprint?: string;
  },
): Promise<ForgetOutcome> {
  const index = deps.workspaceIndex;
  const requested = index.getBySlug(slug);

  if (requested && requested.lifecycle?.state !== "forgetting") {
    const target = resolveForgetTarget(index, requested);
    if (!target) return { ok: false, code: "not-found" };
    return forgetFresh(deps, target, requested.slug, opts);
  }

  // No live registration under this exact slug, or one exists but is itself mid-deletion. The
  // durable operation record is authoritative — found by target slug OR any original member's
  // slug, so it does not matter which one the caller supplied. Once an operation record exists the
  // member set is already fixed for the life of the operation, so `opts.memberFingerprint` (if any
  // was supplied) is never consulted on any of these resume branches — there is nothing left to go
  // stale relative to.
  const targetRegistrationIdHint =
    requested?.lifecycle?.state === "forgetting" ? requested.lifecycle.target_registration_id : null;
  const op =
    (targetRegistrationIdHint && index.activeForgetOperationForTarget(targetRegistrationIdHint)) ||
    index.forgetOperationForSlug(slug);

  if (op) {
    if (op.completed_at) {
      return {
        ok: true,
        confirmed: true,
        target_slug: op.target_slug,
        requested_slug: slug,
        removed: membersToBusEntries(op.members),
      };
    }
    if (!opts.confirm) {
      const entries = membersToBusEntries(op.members);
      return {
        ok: true,
        confirmed: false,
        target_slug: op.target_slug,
        requested_slug: slug,
        entries,
        member_fingerprint: memberFingerprint(entries),
      };
    }
    return deps.adoptionCoordinator.run(op.target_registration_id, () =>
      commitForgetLocked(deps, op.target_registration_id, slug),
    );
  }

  // No operation record at all: a legacy `"forgetting"` lifecycle marker predating the operation
  // record (only ever produced by direct lifecycle manipulation, never by a real commit of this
  // code) — derive the target from the live entry it points at and let `commitForgetLocked`
  // backfill a record from whatever is still registered.
  if (targetRegistrationIdHint) {
    const targetEntry = index.getWorkspaceByRegistration(targetRegistrationIdHint);
    if (targetEntry) {
      if (!opts.confirm) {
        // No operation record exists yet for this legacy marker, so there is no immutable snapshot
        // to defer to — the live lifecycle scan is the only available source of truth here (never
        // reached by a real commit of this code past this revision; see this branch's own comment
        // above `resolveForgetTarget`).
        const entries = index.forgettingMembersFor(targetEntry.registration_id).map(toBusEntry);
        return {
          ok: true,
          confirmed: false,
          target_slug: targetEntry.slug,
          requested_slug: slug,
          entries,
          member_fingerprint: memberFingerprint(entries),
        };
      }
      return deps.adoptionCoordinator.run(targetEntry.registration_id, () =>
        commitForgetLocked(deps, targetEntry.registration_id, slug),
      );
    }
  }

  return { ok: false, code: "not-found" };
}

/** The fresh (non-resuming) preflight/commit path: `target`'s own lifecycle is known to be
 * anything other than `"forgetting"` (the caller already excluded that case). Everything here is
 * a lock-free early check — sufficient to fail obviously blocked/invalid requests without
 * contending for the per-target lock at all. Nothing captured here is trusted past the lock:
 * `commitForgetLocked` re-reads every durable fact fresh once it actually holds it, since an
 * adoption, a new live session, or a competing forget may have changed things while this call
 * waited for it — the SAME lock session register/bind now also acquire (issue #156 revised
 * approach: "generalize the per-target ownership coordinator"), so neither can land mid-commit and
 * neither is left racing the other's liveness recheck. */
async function forgetFresh(
  deps: ForgetDeps,
  target: WorkspaceEntry,
  requestedSlug: string,
  opts: { confirm: boolean; memberFingerprint?: string },
): Promise<ForgetOutcome> {
  if (target.lifecycle?.state === "adopting") {
    return {
      ok: false,
      code: "blocked",
      blockers: [{ kind: "adopting" }],
      target_slug: target.slug,
      requested_slug: requestedSlug,
    };
  }

  const blockers = forgetBlockers(target, deps);
  if (blockers.length > 0) {
    return { ok: false, code: "blocked", blockers, target_slug: target.slug, requested_slug: requestedSlug };
  }

  const allEntries = [target, ...deps.workspaceIndex.sealedSourcesFor(target.registration_id)];
  const confinement = confineAll(allEntries, deps.home);
  if (!confinement.ok) return { ok: false, code: "confinement-failed", registration_id: confinement.registrationId };

  if (!opts.confirm) {
    return {
      ok: true,
      confirmed: false,
      target_slug: target.slug,
      requested_slug: requestedSlug,
      entries: allEntries.map(toBusEntry),
      member_fingerprint: memberFingerprint(allEntries.map(toBusEntry)),
    };
  }

  return deps.adoptionCoordinator.run(target.registration_id, () =>
    commitForgetLocked(deps, target.registration_id, requestedSlug, opts.memberFingerprint),
  );
}

/** Runs entirely inside the daemon's per-target ownership lock — the same lock `adoptLooseLineages`
 * holds for its own transaction, and the same lock session register/bind now acquire before
 * mutating this same target (issue #156 revised approach). Re-validates everything against durable
 * state as of right now: an adoption or a competing forget may have changed things while the
 * caller waited for this lock, so nothing it observed beforehand is trusted here.
 *
 * Ordering is deliberate and load-bearing: `beginForgetOperation` (the durable marker + immutable
 * member snapshot) is written BEFORE the bus is sealed, never after. A crash between them is
 * impossible by construction — the marker is durable the instant this function's first await
 * resolves, so `status`/`doctor` see `lifecycle:"forgetting"` immediately, never a bus silently
 * sealed with no discoverable trace (issue #156 review finding 3, first pass). Sealing itself now
 * runs on EVERY attempt — fresh or resumed — not just the first: a resumed attempt whose earlier
 * pass wrote the marker but crashed before (or during) the seal must still refuse a lease that
 * landed in that gap, rather than silently deleting an unsealed bus out from under it (finding 3,
 * second pass — the resumed daemon may not even be the same process that wrote the marker, so
 * nothing in memory can be trusted to remember whether sealing already happened; re-sealing is a
 * no-op once it has). Only a FRESH attempt rolls the marker back via `abortForgetOperation` on a
 * lost lease race — nothing destructive has happened yet, so there is nothing to resume. A resumed
 * attempt that loses the same race must NOT roll back: earlier members may already be deleted, and
 * the marker is what keeps that resumable.
 *
 * Held-review finding (final pass): "commit resolves the target by stale slug ... this can falsely
 * complete while a live registration remains." Resolving "the target" via `getBySlug` was unsafe
 * the instant a target's own slug became free (the moment its registration is removed,
 * sources-first, target-last) — an entirely unrelated fresh registration elsewhere can legitimately
 * claim that exact freed slug before this operation's completion receipt lands, and a commit that
 * then looked the target up by that slug would silently act on the WRONG workspace. `targetRegistrationId`
 * is immutable for the life of the operation (the caller resolved it once, before entering this
 * lock, either from a live entry's own `registration_id` or from `op.target_registration_id`), so it
 * — never a slug — is the identity this function resolves the target and its operation through. */
async function commitForgetLocked(
  deps: ForgetDeps,
  targetRegistrationId: string,
  requestedSlug: string,
  expectedFingerprint?: string,
): Promise<ForgetOutcome> {
  const index = deps.workspaceIndex;
  const target = index.getWorkspaceByRegistration(targetRegistrationId);
  if (!target) {
    // The target's own registration is already gone — either a previous attempt finished the
    // deletion but this caller never observed the result, or this call raced a resume that just
    // completed under the same lock. Either way, the durable operation record (if any) is the
    // only remaining truth, and its completion receipt is what a retry must still be able to read.
    const op =
      index.forgetOperationForTargetRegistration(targetRegistrationId) ?? index.forgetOperationForSlug(requestedSlug);
    if (!op) return { ok: false, code: "not-found" };
    if (!op.completed_at) await index.completeForgetOperation(op.operation_id);
    return {
      ok: true,
      confirmed: true,
      target_slug: op.target_slug,
      requested_slug: requestedSlug,
      removed: membersToBusEntries(op.members),
    };
  }

  const resuming = target.lifecycle?.state === "forgetting";

  if (!resuming) {
    if (target.lifecycle?.state === "adopting") {
      return {
        ok: false,
        code: "blocked",
        blockers: [{ kind: "adopting" }],
        target_slug: target.slug,
        requested_slug: requestedSlug,
      };
    }
    const blockers = forgetBlockers(target, deps);
    if (blockers.length > 0) {
      return { ok: false, code: "blocked", blockers, target_slug: target.slug, requested_slug: requestedSlug };
    }
  }

  // Held-review finding (third pass): a resume defers to the durable operation's OWN immutable
  // snapshot — `resolveResumeMembers` — never to a fresh live-lifecycle scan, which an unvalidated
  // extra `"forgetting"` marker on an unrelated bus could otherwise smuggle into the deletion (see
  // that function's own docstring). `existingOperation`, once found, is reused as-is below rather
  // than looked up a second time.
  let liveMembers: WorkspaceEntry[];
  let existingOperation: ForgetOperationRecord | null = null;
  if (resuming) {
    existingOperation = index.activeForgetOperationForTarget(target.registration_id);
    if (existingOperation) {
      const resolved = resolveResumeMembers(index, existingOperation);
      if (!resolved.ok) {
        return { ok: false, code: "confinement-failed", registration_id: resolved.registrationId };
      }
      liveMembers = resolved.members;
    } else {
      // Legacy marker predating the operation record — no snapshot exists yet to defer to, so the
      // live lifecycle scan is what `beginForgetOperation` below will itself turn into the FIRST
      // snapshot (never reached by a real commit of this code past this revision).
      liveMembers = index.forgettingMembersFor(target.registration_id);
    }
  } else {
    liveMembers = [target, ...index.sealedSourcesFor(target.registration_id)];
  }

  // Held-review finding: a `confirm:true` call that echoes back a PREVIOUS preview's fingerprint
  // must be refused — not merely warned — the moment the CURRENT member set no longer matches it.
  // Checked before confinement and before `beginForgetOperation` ever runs, so a stale confirmation
  // deletes NOTHING: an adoption that committed a new sealed source between the preview and this
  // call must never have that source silently swept into a deletion the human never saw. Only
  // meaningful on a fresh commit — once `resuming` is true the member set is already fixed by the
  // durable operation snapshot, so there is nothing left for a fingerprint to go stale against.
  if (!resuming && expectedFingerprint !== undefined) {
    const currentFingerprint = memberFingerprint(liveMembers.map(toBusEntry));
    if (currentFingerprint !== expectedFingerprint) {
      return {
        ok: false,
        code: "stale-preview",
        target_slug: target.slug,
        requested_slug: requestedSlug,
        entries: liveMembers.map(toBusEntry),
        member_fingerprint: currentFingerprint,
      };
    }
  }

  const confinement = confineAll(liveMembers, deps.home);
  if (!confinement.ok) return { ok: false, code: "confinement-failed", registration_id: confinement.registrationId };

  // Ordinary resumes reuse the SAME record `resolveResumeMembers` already read `liveMembers` from
  // above — never a second, independent lookup that could observe a different (and now untrusted)
  // snapshot. The fallback backfills one from whatever is still live for a lifecycle marker written
  // before the operation record existed (never reached by a real commit of this code past this
  // revision).
  const operation: ForgetOperationRecord = existingOperation ?? (await index.beginForgetOperation(target, liveMembers));

  // The target's own bus is the ONLY member whose apply-lease matters — a sealed adopted source
  // never accepts a new lease (its bus is already permanently sealed by adoption itself), so this
  // is the sole seal point, exactly as before. What changed: it now runs whether this is a fresh
  // commit OR a resume, since `sealForForget()` is an idempotent no-op once already sealed and the
  // ONLY thing that proves, atomically, that no lease is active right now — a resume that skipped
  // this would delete an unsealed bus on nothing but the stale assumption that "resuming" implies
  // "already sealed".
  if (existsSync(target.bus_path)) {
    const bus = deps.getWorkspaceBus(target);
    await bus.reconcileOnce();
    try {
      await bus.sealForForget();
    } catch (err) {
      if ((err as { code?: string }).code === "LEASE_HELD") {
        if (!resuming) await index.abortForgetOperation(operation.operation_id);
        const lease = bus.state.applyLease;
        const blocker: ForgetBlocker = lease
          ? { kind: "apply-lease", lease_id: lease.leaseId, expires_at: lease.expiresAt }
          : { kind: "apply-lease", lease_id: (err as { activeLeaseId?: string }).activeLeaseId ?? "", expires_at: "" };
        return {
          ok: false,
          code: "blocked",
          blockers: [blocker],
          target_slug: target.slug,
          requested_slug: requestedSlug,
        };
      }
      throw err;
    }
  }

  // Every entry's bus is fully gone from disk once this loop finishes (freshly deleted here, or
  // already gone from an earlier interrupted attempt this call is resuming) — remove the
  // registration(s) sources-first, target-last: the target's slug is the only key a retried
  // `forget` can still name, so it must be the LAST registration to disappear.
  for (const entry of liveMembers) {
    const plan = confinement.confined.get(entry.registration_id) ?? confineBusPathForDeletion(entry, deps.home);
    if (plan === null) return { ok: false, code: "confinement-failed", registration_id: entry.registration_id };
    if (plan.existed) rmSync(plan.path, { recursive: true, force: true });
  }

  const sources = liveMembers.filter((entry) => entry.registration_id !== target.registration_id);
  for (const entry of sources) await index.forget(entry.slug);
  await index.forget(target.slug);

  await index.completeForgetOperation(operation.operation_id);

  // The COMPLETE original set from the durable snapshot, not `liveMembers` — a member whose own
  // registration was already gone before this call began (an earlier attempt got that far) is
  // still part of the provenance unit this deletion reports as removed (issue #156 review finding
  // 5: "a resumed deletion returns only still-registered members, losing already-deleted paths").
  return {
    ok: true,
    confirmed: true,
    target_slug: operation.target_slug,
    requested_slug: requestedSlug,
    removed: membersToBusEntries(operation.members),
  };
}

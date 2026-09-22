// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — claims: the per-resource replacement for the one-per-workspace apply-lease
// (issue #155, A4 §F05). A claim says "this session is working on these resources right now"; it
// is NOT access control (A3 is unchanged — any bearer can claim anything) and it does not stop an
// agent writing bytes to disk out of band. What it buys is honesty: a second session finds out WHO
// holds a resource instead of an opaque conflict, and the interval a claim covers is the interval
// its holder can be attributed for.
//
// Like every other piece of status in this system, claims are FOLD-DERIVED (invariant 2) — exactly
// as `applyLease` was. Nothing here writes; `WorkspaceBus` appends the events and this module says
// what they mean.
//
// THE FENCE IS ALWAYS READ FROM THE EVENT, NEVER RE-DERIVED. A fencing token only works if the
// number a holder was given is the number a later reader compares against (Kleppmann); recomputing
// it during a fold — "it's the Nth claim on this resource, so it must be N" — would silently hand
// the same number to two different holders the moment an event is skipped, quarantined, or folded
// out of order, which is precisely the failure the fence exists to catch.
//
// Legacy `apply_begin`/`apply_end`/`apply_expired` events fold here too, as claims with
// `fence: null`. They predate fencing, so there is no honest number to give them; `null` passes the
// fence check rather than failing it, because a journal written before this feature existed must
// still replay to the same status it always did.
import type { EventBy, JournalEvent } from "./journal.ts";

export type ClaimMode = "exclusive" | "presence";

/** Why a claim stopped being live. Carried on the tombstone so a late `resolve` from the former
 * holder can be told what happened to it — "revoked by a human" and "expired while you were
 * stalled" are different stories and the caller acts differently on each. */
export type TombstoneReason =
  | "released_by_human"
  | "released_by_holder"
  | "expired_ttl"
  | "expired_holder_stale"
  | "superseded"
  | "resolved";

export interface Claim {
  claim_id: string;
  /** `artifact:<workspace-relative path>` / `entry:<inbox id>` strings, in the order claimed. */
  resources: string[];
  /** The normalized path set the claim covers — an `entry:` resource implies its artifact path.
   * Disjointness, checkpoint scoping and the interval guard are all decided over THIS, not over
   * `resources`: two different entries against the same artifact are not disjoint. */
  paths: string[];
  mode: ClaimMode;
  holder_session: string;
  holder_principal: string;
  /** `null` only for a legacy apply-lease folded forward (see the module header). */
  fence: number | null;
  since: string;
  expires_at: string;
  pre_sha?: string;
  /** True when this came from an `apply_begin` rather than a `claim_taken`. */
  legacy?: boolean;
}

export interface Tombstone {
  claim_id: string;
  holder_session: string;
  fence: number | null;
  ended_at: string;
  reason: TombstoneReason;
}

export interface ResourceClaims {
  /** At most one live exclusive claim per resource — the invariant `claim()` enforces. */
  exclusive: Claim | null;
  presence: Claim[];
  /** The most recent claim to end on this resource. A stale-fence `resolve` reads its `reason` to
   * learn whether it was revoked, expired, or superseded. */
  last?: Tombstone;
  /** The highest fence ever issued for this resource, so the next holder gets a strictly greater
   * one even after the current claim ends. Stays put across releases — a fence that reset would
   * let a stalled holder's old token match a new holder's. */
  last_fence: number;
}

export type ClaimsState = Record<string, ResourceClaims>;

export const ENTRY_RESOURCE_PREFIX = "entry:";
export const ARTIFACT_RESOURCE_PREFIX = "artifact:";

export function entryResource(entryId: string): string {
  return `${ENTRY_RESOURCE_PREFIX}${entryId}`;
}

export function artifactResource(path: string): string {
  return `${ARTIFACT_RESOURCE_PREFIX}${path}`;
}

export function entryIdOfResource(resource: string): string | null {
  return resource.startsWith(ENTRY_RESOURCE_PREFIX) ? resource.slice(ENTRY_RESOURCE_PREFIX.length) : null;
}

export function artifactPathOfResource(resource: string): string | null {
  return resource.startsWith(ARTIFACT_RESOURCE_PREFIX) ? resource.slice(ARTIFACT_RESOURCE_PREFIX.length) : null;
}

function slotFor(claims: ClaimsState, resource: string): ResourceClaims {
  const existing = claims[resource];
  if (existing) return existing;
  const fresh: ResourceClaims = { exclusive: null, presence: [], last_fence: 0 };
  claims[resource] = fresh;
  return fresh;
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function tombstoneOf(claim: Claim, endedAt: string, reason: TombstoneReason): Tombstone {
  return {
    claim_id: claim.claim_id,
    holder_session: claim.holder_session,
    fence: claim.fence,
    ended_at: endedAt,
    reason,
  };
}

/** Removes `claimId` from every resource slot it occupies and records why. A claim spans however
 * many resources it was taken over, so ending it is never a single-key edit. */
function endClaim(claims: ClaimsState, claimId: string, endedAt: string, reason: TombstoneReason): void {
  for (const slot of Object.values(claims)) {
    if (slot.exclusive?.claim_id === claimId) {
      slot.last = tombstoneOf(slot.exclusive, endedAt, reason);
      slot.exclusive = null;
    }
    const held = slot.presence.find((claim) => claim.claim_id === claimId);
    if (held) {
      slot.last = tombstoneOf(held, endedAt, reason);
      slot.presence = slot.presence.filter((claim) => claim.claim_id !== claimId);
    }
  }
}

function installClaim(claims: ClaimsState, claim: Claim): void {
  for (const resource of claim.resources) {
    const slot = slotFor(claims, resource);
    if (typeof claim.fence === "number" && claim.fence > slot.last_fence) slot.last_fence = claim.fence;
    if (claim.mode === "presence") {
      slot.presence = slot.presence.filter((existing) => existing.claim_id !== claim.claim_id);
      slot.presence.push(claim);
      continue;
    }
    // A second exclusive claim reaching the fold for a resource that already has one means the
    // in-mutex disjointness check was bypassed (a hand-written journal, a future caller, a replay
    // of events from two daemons). The fold must stay total, so the newer one wins and the older
    // is tombstoned as `superseded` — which is exactly what the displaced holder's next `resolve`
    // needs to read to learn it lost the resource rather than simply expiring.
    if (slot.exclusive && slot.exclusive.claim_id !== claim.claim_id) {
      slot.last = tombstoneOf(slot.exclusive, claim.since, "superseded");
    }
    slot.exclusive = claim;
  }
}

function claimFromTaken(event: JournalEvent): Claim | null {
  const d = event.detail;
  if (!d || typeof d.claim_id !== "string") return null;
  const resources = stringsOf(d.resources);
  if (resources.length === 0) return null;
  return {
    claim_id: d.claim_id,
    resources,
    paths: stringsOf(d.paths),
    mode: d.mode === "presence" ? "presence" : "exclusive",
    holder_session: typeof d.session === "string" ? d.session : "",
    holder_principal: typeof d.principal === "string" ? d.principal : "unknown",
    fence: typeof d.fence === "number" ? d.fence : null,
    since: typeof d.since === "string" ? d.since : event.at,
    expires_at: typeof d.expires_at === "string" ? d.expires_at : "",
    ...(typeof d.pre_sha === "string" ? { pre_sha: d.pre_sha } : {}),
  };
}

/** The one-per-workspace apply-lease, folded forward as a claim (see the module header). `paths` is
 * empty on purpose: an `apply_begin` never recorded which files it covered, so the honest path set
 * is "unknown", and an unknown path set intersects everything — which preserves the old
 * one-lease-per-workspace semantics for a lease still in flight across the upgrade. */
function claimFromApplyBegin(event: JournalEvent): Claim | null {
  const d = event.detail;
  if (!d || typeof d.lease_id !== "string") return null;
  const entry = event.entry ?? (typeof d.entry === "string" ? d.entry : "");
  return {
    claim_id: d.lease_id,
    resources: [entryResource(entry)],
    paths: [],
    mode: "exclusive",
    holder_session: typeof d.session === "string" ? d.session : "",
    holder_principal: "unknown",
    fence: null,
    since: event.at,
    expires_at: typeof d.expires_at === "string" ? d.expires_at : "",
    ...(typeof d.pre_sha === "string" ? { pre_sha: d.pre_sha } : {}),
    legacy: true,
  };
}

/** Folds one claim-lifecycle event (or one of the three legacy apply-lease events) into
 * `claims`. Returns `true` when the event belonged to this axis, so the caller knows whether it
 * still has to do anything else with it — `apply_end` both ends a claim AND carries the proven
 * interval onto the entry, so its other half stays in the entry reducer. */
export function reduceClaimEvent(claims: ClaimsState, event: JournalEvent): boolean {
  switch (event.event) {
    case "claim_taken": {
      const claim = claimFromTaken(event);
      if (claim) installClaim(claims, claim);
      return true;
    }
    case "claim_renewed": {
      const d = event.detail;
      if (!d || typeof d.claim_id !== "string") return true;
      const expiresAt = typeof d.expires_at === "string" ? d.expires_at : null;
      if (expiresAt === null) return true;
      // Renewal extends the window and keeps the fence (RFC 4918 §6.6 — a refreshed lock keeps its
      // token). Bumping it here would revoke the holder's own outstanding token.
      for (const slot of Object.values(claims)) {
        if (slot.exclusive?.claim_id === d.claim_id) slot.exclusive.expires_at = expiresAt;
        for (const claim of slot.presence) if (claim.claim_id === d.claim_id) claim.expires_at = expiresAt;
      }
      return true;
    }
    case "claim_released": {
      const d = event.detail;
      if (!d || typeof d.claim_id !== "string") return true;
      const reason: TombstoneReason = d.by === "human" ? "released_by_human" : "released_by_holder";
      endClaim(claims, d.claim_id, event.at, typeof d.reason === "string" ? (d.reason as TombstoneReason) : reason);
      return true;
    }
    case "claim_expired": {
      const d = event.detail;
      if (!d || typeof d.claim_id !== "string") return true;
      const reason: TombstoneReason = d.reason === "holder_stale" ? "expired_holder_stale" : "expired_ttl";
      endClaim(claims, d.claim_id, event.at, reason);
      return true;
    }
    case "apply_begin": {
      const claim = claimFromApplyBegin(event);
      if (claim) installClaim(claims, claim);
      return true;
    }
    case "apply_end": {
      const d = event.detail;
      const id = typeof d?.claim_id === "string" ? d.claim_id : typeof d?.lease_id === "string" ? d.lease_id : null;
      if (id !== null) endClaim(claims, id, event.at, "resolved");
      return false; // the interval half of this event belongs to the entry reducer
    }
    case "apply_expired": {
      const d = event.detail;
      const id = typeof d?.lease_id === "string" ? d.lease_id : null;
      if (id !== null) endClaim(claims, id, event.at, "expired_ttl");
      return false;
    }
    default:
      return false;
  }
}

/** Every live exclusive claim across every resource, deduplicated by `claim_id` (a multi-resource
 * claim occupies one slot per resource). `now` filters out claims whose TTL has lapsed but whose
 * `claim_expired` has not been appended yet — the lazy-expiry window every caller must respect,
 * because the TTL is precisely what bounds the interval a claim can prove. */
export function liveExclusiveClaims(claims: ClaimsState, now: Date): Claim[] {
  const seen = new Set<string>();
  const live: Claim[] = [];
  for (const slot of Object.values(claims)) {
    const claim = slot.exclusive;
    if (!claim || seen.has(claim.claim_id)) continue;
    if (isClaimExpired(claim, now)) continue;
    seen.add(claim.claim_id);
    live.push(claim);
  }
  return live;
}

/** Live exclusive claims (TTL-lapsed ones excluded) that cover any of `paths`. A claim with an
 * EMPTY path set matches everything: that is a legacy apply-lease, whose covered files were never
 * recorded, and "unknown coverage" has to be treated as "covers this" or the upgrade would let a
 * new claim slice underneath an in-flight one. */
export function claimsOnPaths(claims: ClaimsState, paths: readonly string[], now: Date): Claim[] {
  return liveExclusiveClaims(claims, now).filter(
    (claim) => claim.paths.length === 0 || claim.paths.some((path) => paths.includes(path)),
  );
}

/** The live exclusive claim on `entry:<id>`, if any — the direct replacement for "is there a lease
 * for this entry". TTL-lapsed claims are included here on purpose: the resolve ladder has to tell
 * "lapsed but renewable" (rung 3′) apart from "gone", and a filter here would erase that. */
export function claimForEntry(claims: ClaimsState, entryId: string): Claim | null {
  return claims[entryResource(entryId)]?.exclusive ?? null;
}

/** The tombstone for `claimId`, searched across every resource it may have covered. */
export function tombstoneFor(claims: ClaimsState, claimId: string): Tombstone | null {
  for (const slot of Object.values(claims)) {
    if (slot.last?.claim_id === claimId) return slot.last;
  }
  return null;
}

/** The highest fence issued so far across `resources` — the basis for the next holder's token. */
export function maxFenceOver(claims: ClaimsState, resources: readonly string[]): number {
  let max = 0;
  for (const resource of resources) {
    const slot = claims[resource];
    if (slot && slot.last_fence > max) max = slot.last_fence;
  }
  return max;
}

/** A claim past its `expires_at` proves nothing, whether or not its `claim_expired` has been
 * appended yet. Every consumer must consult this: the TTL is what bounds the provable window
 * (A4 §F05), so a consumer that skips it is attributing unproven time. */
export function isClaimExpired(claim: Claim, now: Date): boolean {
  if (!claim.expires_at) return false;
  return new Date(claim.expires_at).getTime() <= now.getTime();
}

/** The 409 body a conflicting caller gets: who holds it, in what mode, since when, until when
 * (issue #155 REQ-5). Never includes anything the daemon cannot prove. */
export interface ClaimHolderSnapshot {
  claim_id: string;
  holder_session: string;
  holder_principal: string;
  mode: ClaimMode;
  since: string;
  expires_at: string;
  fence: number | null;
}

export function holderSnapshot(claim: Claim): ClaimHolderSnapshot {
  return {
    claim_id: claim.claim_id,
    holder_session: claim.holder_session,
    holder_principal: claim.holder_principal,
    mode: claim.mode,
    since: claim.since,
    expires_at: claim.expires_at,
    fence: claim.fence,
  };
}

/** `EventBy` for a claim's holder — the one place `session:<id>` is built from a claim, so the
 * comparison the terminal guard does ("was this entry resolved by ME?") can never drift from the
 * string the attribution path wrote. */
export function holderBy(claim: Claim): EventBy {
  return `session:${claim.holder_session}`;
}

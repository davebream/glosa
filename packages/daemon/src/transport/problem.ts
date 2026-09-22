// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — RFC 9457 problem+json error envelope (A1 §1). One shared helper so every
// route returns the same {type,title,status,detail?,instance?} shape with the right content
// type, instead of each handler hand-rolling its own error body.
export type ProblemSlug =
  | "shadow-unsafe-path"
  | "shadow-workspace-inactive"
  | "shadow-history-lost"
  | "shadow-invalid-head"
  | "shadow-repair-pending"
  | "shadow-not-owner"
  | "shadow-already-healthy"
  | "shadow-repair-id-conflict"
  | "session-provider-conflict"
  | "session-not-registered"
  | "invalid-origin"
  | "unauthorized"
  | "contract-mismatch"
  | "invalid-path"
  | "artifact-not-tracked"
  | "no-tracked-artifact"
  | "unsupported-file"
  // issue #146 — `POST /api/workspaces/open`'s nested-file resolution refuses to silently reuse
  // an existing `directory` registration that names the user's home directory (or an ancestor of
  // it): that registration predates the workspace-root boundary and would otherwise keep matching
  // every file underneath it. Surfaced with the registration's slug and remediation rather than
  // migrated or deleted.
  | "home-workspace-registered"
  // issue #281 — `POST /api/workspaces/open`'s rare `nlink > 1` hardlink-alias Worker scan
  // (`WorkspaceIndex.resolveOpenTarget`) timed out, its Worker failed, or the target/candidate's
  // identity changed too many times to revalidate cleanly. 503, not 400/409: nothing the caller
  // sent is wrong, and no CURRENT conflict is being asserted — the daemon simply could not verify
  // aliasing within its bounded deadline and refuses to risk creating a duplicate registration for
  // an inode another registration may already own. Expected to clear on retry.
  | "alias-discovery-unavailable"
  | "not-found"
  | "payload-too-large"
  | "validation-failed"
  | "capability-expired"
  | "internal"
  // Not one of A1 §1's fixed slugs — used only by P3.1's route SHELLS (A1 §5.5/§5.8/§5.10/§5.12,
  // whose real bodies land in P3.2/P4.1/P4.2/F12) so the auth/contract/confinement pipeline can be
  // exercised end-to-end against those routes today without pretending a real backend exists.
  | "not-implemented"
  // The daemon's generic 409: any conflict that doesn't get its own dedicated slug. Used across
  // several unrelated routes (composite acknowledgement outcome, delivery reservation, session
  // binding, conversation targeting, apply-begin lease, annotation withdrawal on a closed entry)
  // — a caller must not match on this slug alone to identify any one of them; each route's own
  // condition is what's actually being asserted.
  | "conflict"
  | "approval-conflict"
  // R9 addition, sibling of `approval-conflict` and deliberately NOT the same answer. Uniqueness
  // ("at most one non-terminal approval request per workspace/path") is proven by reading the
  // candidate entries' immutable inbox payloads (A4 §F04); when one of those reads fails, the
  // daemon has proven neither that a conflict exists nor that none does.
  //
  // Status 500, not 409, and the choice is the point. 409 asserts a conflict with the current
  // resource state — an assertion we cannot back, and one that sends the caller to "finish the
  // existing approval" when there may be no existing approval and its payload is unreadable
  // regardless. Nothing the client sent is wrong, so no 4xx fits; the daemon's own durable store
  // is damaged and it is "incapable of performing the requested method" (RFC 9110 §15.6), which
  // is 5xx by definition. Not 503 either: that promises the condition clears with time, and this
  // one waits on a human. This is the same 500 an unhandled throw would already have produced —
  // named and given an honest `detail` instead of the anonymous `internal` fallback, which by
  // design carries none.
  | "approval-uniqueness-unprovable"
  | "artifact-revision-changed"
  // P3.5 addition — `POST /w/:slug/restore`'s dirty-worktree guard (A6 §F31). 409 when the
  // artifact has changes since its latest checkpoint and the caller didn't pass `force`. Not
  // built via `problem()` below (see `restoreConflictResponse`) because it carries the
  // would-be-lost diff as an extra RFC 9457 body member, which `problem()`'s fixed shape has no
  // slot for — the slug is still named here so the vocabulary of possible `type` values is
  // documented in one place regardless of which helper builds the response.
  | "restore-conflict"
  // Issue #155 — claims. Every refusal on the claim/resolve path says WHO and WHY in extension
  // members (RFC 9457 §3.2), so a second session can act on it instead of guessing:
  //   claim-held        another session holds an exclusive claim over these paths (holder inline)
  //   claim-revoked     the caller's claim was released — by a human, or by its holder
  //   claim-expired     the caller's claim ran out, by TTL or because its session went stale
  //   claim-superseded  the caller's claim ended because the resource moved on without it
  //   entry-resolved    the entry is already closed (`terminal_by` says by whom)
  //   no-claim          the caller holds no claim that could prove this resolve
  //   claim-limit       a per-session or per-workspace bound on live claims was reached
  | "claim-held"
  | "claim-revoked"
  | "claim-expired"
  | "claim-superseded"
  | "entry-resolved"
  | "no-claim"
  | "claim-limit"
  // Adoption is a workspace-routing conflict, not a generic server failure. Kept distinct so
  // callers can safely retry a live lease hand-off while treating existing local state as final.
  | "adoption-blocked"
  | "adoption-conflict"
  | "workspace-adopting"
  | "workspace-adopted"
  // issue #156 — `POST /api/workspaces/forget`. `workspace-forgetting` mirrors
  // `workspace-adopting`: ordinary routing refuses a workspace whose durable deletion is already
  // committed and possibly mid-resume. `forget-blocked` is the distinct preflight refusal (a live
  // bound session or an unexpired apply lease) — kept separate from the generic `conflict` slug
  // because its body carries a structured `blockers` array (see `forgetBlockedResponse` below)
  // the CLI names each blocker from, not just a human sentence.
  | "workspace-forgetting"
  | "forget-blocked"
  // issue #156 held-review addition: a `confirm:true` call echoed back a `member_fingerprint` from
  // an earlier preview that no longer matches the CURRENT member set (an adoption committed a new
  // sealed source in between, or any other member-set change) — refused before anything is marked
  // or deleted, distinct from `forget-blocked` (a live session/lease/adoption) because the caller's
  // own remedy differs: re-preview and re-confirm, not wait out someone else's lease.
  | "forget-stale-preview"
  // T4 addition — `PUT /w/:slug/artifacts/:path`'s `If-Match` check (services/artifact.ts
  // `prepareArtifactSave`) used to share `conflict` with routes that have nothing to do with it.
  // Named separately so the SPA can open the stale-save dialog on exactly this condition, never on
  // the unrelated `workspace-adopting` 409 that can also reach this route.
  | "source-changed"
  // #250 addition — `PUT /w/:slug/artifacts/:path` against a file whose bytes are not valid UTF-8.
  // Named separately from `source-changed` because the two demand opposite things of the SPA: a
  // stale save opens the merge dialog, and this one must never, since every choice there writes a
  // replacement-character decode back over bytes glosa cannot read.
  | "not-utf8"
  // Starred workspaces (contract 1.11). `star-not-directory`: only a directory registration can be
  // starred, because reopening a star is `glosa open <dir>` and a loose file has no directory of
  // its own to reopen. `star-folder-missing`: the starred folder is gone or no longer a directory,
  // so reopening is refused before the index is touched; the star itself stays until unstarred.
  | "star-not-directory"
  | "star-folder-missing"
  | "dictation-unconfigured"
  | "dictation-credential-unavailable"
  | "dictation-authentication-failed"
  | "dictation-rate-limited"
  | "dictation-timeout"
  | "dictation-invalid-response"
  | "dictation-provider-unavailable";

/** Extension members (RFC 9457 §3.2): names of at least three characters from `[A-Za-z0-9_]`, and
 * a client that does not know one ignores it — which is what makes adding them to an existing
 * problem type a compatible change. They can never overwrite a standard member. */
export type ProblemExtensions = Readonly<Record<string, unknown>>;

const EXTENSION_NAME = /^[A-Za-z0-9_]{3,}$/;
const STANDARD_MEMBERS: ReadonlySet<string> = new Set(["type", "title", "status", "detail", "instance"]);

export function problem(
  status: number,
  slug: ProblemSlug,
  title: string,
  detail?: string,
  instance?: string,
  extensions?: ProblemExtensions,
): Response {
  const body: Record<string, unknown> = {
    type: `https://glosa.local/errors/${slug}`,
    title,
    status,
  };
  if (detail !== undefined) body.detail = detail;
  if (instance !== undefined) body.instance = instance;
  for (const [name, value] of Object.entries(extensions ?? {})) {
    if (!EXTENSION_NAME.test(name) || STANDARD_MEMBERS.has(name)) {
      throw new Error(`problem(): ${JSON.stringify(name)} is not a legal RFC 9457 extension member name`);
    }
    body[name] = value;
  }
  // Built by hand rather than Response.json() — that helper stamps its own Content-Type before
  // init.headers is applied, and the problem+json media type must not be silently overridden.
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/problem+json" },
  });
}

/** `POST /w/:slug/restore`'s dirty-worktree refusal (A6 §F31): a `409 restore-conflict` that also
 * carries `would_be_lost_diff` — the unified diff between the artifact's current (dirty) on-disk
 * bytes and its latest checkpoint — so the human can see exactly what a `force:true` retry would
 * throw away before choosing to send it. RFC 9457 explicitly allows extra members alongside
 * `type`/`title`/`status`/`detail`/`instance`, so this stays a valid problem+json body; it's a
 * dedicated function rather than a `problem()` call because `problem()`'s signature has no slot
 * for that extra member. */
export function restoreConflictResponse(instance: string, path: string, wouldBeLostDiff: string): Response {
  const body = {
    type: "https://glosa.local/errors/restore-conflict",
    title: "artifact has changes since its latest checkpoint",
    status: 409,
    instance,
    path,
    would_be_lost_diff: wouldBeLostDiff,
  };
  return new Response(JSON.stringify(body), { status: 409, headers: { "Content-Type": "application/problem+json" } });
}

/** `POST /api/workspaces/forget`'s preflight refusal (issue #156): a live bound session or an
 * unexpired apply lease blocks deletion before any side effect. Not built via `problem()` because
 * the CLI must name each blocker individually (session id, or lease id + expiry), which
 * `problem()`'s fixed shape has no slot for — same rationale as `restoreConflictResponse` above. */
export function forgetBlockedResponse(
  instance: string,
  blockers: ReadonlyArray<
    | { kind: "live-session"; session_id: string }
    | { kind: "apply-lease"; lease_id: string; expires_at: string }
    | { kind: "adopting" }
  >,
  /** The workspace the blockers apply to — always the resolved TARGET, never a sealed adopted
   * source (issue #156 revised approach: a source is never an independent provenance unit). */
  targetSlug?: string,
  /** Present only when the caller named a sealed adopted source rather than the target directly. */
  requestedSlug?: string,
): Response {
  const body: Record<string, unknown> = {
    type: "https://glosa.local/errors/forget-blocked",
    title: "workspace has a live bound session, an unexpired apply lease, or is mid-adoption",
    status: 409,
    instance,
    blockers,
  };
  if (targetSlug !== undefined) body.slug = targetSlug;
  if (requestedSlug !== undefined) body.requested_slug = requestedSlug;
  return new Response(JSON.stringify(body), { status: 409, headers: { "Content-Type": "application/problem+json" } });
}

/** `POST /api/workspaces/forget`'s stale-preview refusal (issue #156 held-review finding):
 * `member_fingerprint` no longer matches the CURRENT member set. Carries the FRESH `entries`/
 * `member_fingerprint` pair so a client can re-preview inline (same round trip) rather than issuing
 * a second `confirm:false` call — same rationale as `restoreConflictResponse`/`forgetBlockedResponse`
 * for why this isn't built via the fixed `problem()` shape. */
export function forgetStalePreviewResponse(
  instance: string,
  targetSlug: string,
  requestedSlug: string,
  entries: unknown[],
  memberFingerprint: string,
): Response {
  const body: Record<string, unknown> = {
    type: "https://glosa.local/errors/forget-stale-preview",
    title: "the previewed member set has changed — re-preview before confirming",
    status: 409,
    instance,
    slug: targetSlug,
    ...(requestedSlug !== targetSlug ? { requested_slug: requestedSlug } : {}),
    would_remove: entries,
    member_fingerprint: memberFingerprint,
  };
  return new Response(JSON.stringify(body), { status: 409, headers: { "Content-Type": "application/problem+json" } });
}

/**
 * The last-resort 500 for an unhandled throw (A1 §1/§9, P1.3 review item 2). Deliberately
 * carries NO detail — an uncaught exception might be holding a stack trace, a file path, or
 * other internals, and this is the one response guaranteed to never repeat any of it back to an
 * untrusted caller. `cspHeaders` lets the caller attach the CSP for whichever origin is
 * responding (SPA vs class-F) — same shape as `withHeaders` in http.ts, duplicated here rather
 * than imported to keep this module dependency-free (it's the fallback everything else falls
 * back to, including a future failure inside http.ts's own header-merging logic).
 */
export function internalErrorResponse(cspHeaders: Record<string, string> = {}): Response {
  const res = problem(500, "internal", "internal error");
  const headers = new Headers(res.headers);
  for (const [key, value] of Object.entries(cspHeaders)) headers.set(key, value);
  return new Response(res.body, { status: res.status, headers });
}

// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — RFC 9457 problem+json error envelope (A1 §1). One shared helper so every
// route returns the same {type,title,status,detail?,instance?} shape with the right content
// type, instead of each handler hand-rolling its own error body.
export type ProblemSlug =
  | "invalid-origin"
  | "unauthorized"
  | "contract-mismatch"
  | "invalid-path"
  | "artifact-not-tracked"
  | "no-tracked-artifact"
  | "unsupported-file"
  | "not-found"
  | "payload-too-large"
  | "validation-failed"
  | "capability-expired"
  | "internal"
  // Not one of A1 §1's fixed slugs — used only by P3.1's route SHELLS (A1 §5.5/§5.8/§5.10/§5.12,
  // whose real bodies land in P3.2/P4.1/P4.2/F12) so the auth/contract/confinement pipeline can be
  // exercised end-to-end against those routes today without pretending a real backend exists.
  | "not-implemented"
  // P3.3 addition — `PUT /w/:slug/artifacts/:path`'s optional `If-Match` optimistic-concurrency
  // check (not in A1 §5, this route isn't either). 409 when the caller's `If-Match` source_sha256
  // no longer matches what's on disk.
  | "conflict"
  | "approval-conflict"
  | "artifact-revision-changed"
  // P3.5 addition — `POST /w/:slug/restore`'s dirty-worktree guard (A6 §F31). 409 when the
  // artifact has changes since its latest checkpoint and the caller didn't pass `force`. Not
  // built via `problem()` below (see `restoreConflictResponse`) because it carries the
  // would-be-lost diff as an extra RFC 9457 body member, which `problem()`'s fixed shape has no
  // slot for — the slug is still named here so the vocabulary of possible `type` values is
  // documented in one place regardless of which helper builds the response.
  | "restore-conflict"
  // P5.1 addition — `POST /api/workspaces/apply-begin` (A4 §F05 / A6 §F26 exit 12
  // `lease_conflict`): a second apply-begin while one is already active for this workspace.
  | "lease-conflict"
  // Adoption is a workspace-routing conflict, not a generic server failure. Kept distinct so
  // callers can safely retry a live lease hand-off while treating existing local state as final.
  | "adoption-blocked"
  | "adoption-conflict"
  | "workspace-adopted";

export function problem(
  status: number,
  slug: ProblemSlug,
  title: string,
  detail?: string,
  instance?: string,
): Response {
  const body: Record<string, unknown> = {
    type: `https://glosa.local/errors/${slug}`,
    title,
    status,
  };
  if (detail !== undefined) body.detail = detail;
  if (instance !== undefined) body.instance = instance;
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

// @glosa/daemon — RFC 9457 problem+json error envelope (A1 §1). One shared helper so every
// route returns the same {type,title,status,detail?,instance?} shape with the right content
// type, instead of each handler hand-rolling its own error body.
export type ProblemSlug =
  | "invalid-origin"
  | "unauthorized"
  | "contract-mismatch"
  | "invalid-path"
  | "not-found"
  | "payload-too-large"
  | "validation-failed"
  | "capability-expired"
  | "internal";

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

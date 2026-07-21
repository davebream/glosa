// @glosa/daemon — authorizeRequest: the route-class-scoped Origin/Bearer gate from A3 §4's
// resolved table. Pure and exhaustively unit-testable — no I/O, no Bun.serve, just header
// inspection — so the attack-table coverage (A3 §5) lives mostly in its unit tests, not the
// integration suite. The Host-literal check (A3 §4 Rule 1) is NOT here: it runs earlier, before
// routing even knows the route class, and its failure mode (400, no body) differs from every
// case this function can return.
import { tokenMatches } from "./token.ts";
import type { ProblemSlug } from "./problem.ts";

export type RouteClass = "tokenless-handshake" | "authed-read" | "state-changing" | "navigation";

export type AuthorizeResult = { ok: true } | { ok: false; status: number; slug: ProblemSlug };

export interface AuthorizeOptions {
  routeClass: RouteClass;
  /** The port this request arrived on — used to compute the expected "self" Origin
   * (`http://127.0.0.1:<port>`), never to build a hostname. */
  port: number;
  token: string | null;
}

function bearerOf(req: Request): string | null {
  const header = req.headers.get("Authorization");
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
}

/** Is this request's Origin present AND foreign (not `http://127.0.0.1:<port>`)? Exported so the
 * route-lookup layer (http.ts) can apply the same "reject a foreign Origin" rule even on a path
 * with no matching route — a 404-vs-403 split by route existence would let a hostile page probe
 * for real routes (P1.3 review item 1). */
export function isForeignOrigin(req: Request, port: number): boolean {
  const origin = req.headers.get("Origin");
  return origin !== null && origin !== `http://127.0.0.1:${port}`;
}

export function authorizeRequest(req: Request, opts: AuthorizeOptions): AuthorizeResult {
  const { routeClass, port, token } = opts;

  // Navigation can't carry custom headers at all — Origin/Bearer checks are inapplicable by
  // construction (A3 §4).
  if (routeClass === "navigation") return { ok: true };

  const origin = req.headers.get("Origin");
  const foreign = isForeignOrigin(req, port);

  if (routeClass === "tokenless-handshake") {
    // Reject only a present-and-foreign Origin; absent or self is fine (Bearer is the gate on
    // every other route — handshake has none to gate with).
    if (foreign) return { ok: false, status: 403, slug: "invalid-origin" };
    return { ok: true };
  }

  // authed-read and state-changing both require a valid Bearer. Checked before Origin so a
  // request with no/invalid token gets 401 regardless of Origin (A3 §5 attack #7b).
  if (!tokenMatches(bearerOf(req), token)) {
    return { ok: false, status: 401, slug: "unauthorized" };
  }

  if (routeClass === "authed-read") {
    // Reads tolerate an absent Origin (Bearer alone gates them) but still reject a foreign one.
    if (foreign) return { ok: false, status: 403, slug: "invalid-origin" };
    return { ok: true };
  }

  // state-changing: strict — Origin missing OR foreign is rejected (redundant with Bearer on
  // purpose), plus Sec-Fetch-Site: cross-site as defense-in-depth.
  if (origin === null || foreign) return { ok: false, status: 403, slug: "invalid-origin" };
  if (req.headers.get("Sec-Fetch-Site") === "cross-site") {
    return { ok: false, status: 403, slug: "invalid-origin" };
  }
  return { ok: true };
}

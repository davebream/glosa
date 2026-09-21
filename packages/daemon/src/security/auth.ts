// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — authorizeRequest: the route-class-scoped Origin/Bearer gate from A3 §4's
// resolved table. Pure and exhaustively unit-testable — no I/O, no Bun.serve, just header
// inspection — so the attack-table coverage (A3 §5) lives mostly in its unit tests, not the
// integration suite. The Host-literal check (A3 §4 Rule 1) is NOT here: it runs earlier, before
// routing even knows the route class, and its failure mode (400, no body) differs from every
// case this function can return.

import type { ProblemSlug } from "../transport/problem.ts";
import { selfOriginFor } from "./hosts.ts";
import { tokenMatches } from "./token.ts";

export type RouteClass =
  | "tokenless-handshake"
  | "authed-read"
  | "state-changing"
  | "navigation"
  /** SPA redeems a short-TTL `p=` token for the durable pairing token — Host+same-origin Origin,
   * no Bearer (the caller does not have one yet). */
  | "presentation-redeem";

/**
 * Which listener a request arrived on (A3 §3.2). Every Host and Origin rule in this file exists
 * to stop a BROWSER attack — DNS rebinding, a hostile page's drive-by fetch, a cross-site form.
 * None of those reaches a Unix socket: no browser can open one, and there is no name to rebind.
 * So on `"socket"` those rules are inapplicable, in the same sense the `navigation` class already
 * makes them inapplicable, and the peer's authority comes from the filesystem instead — the
 * kernel refuses `connect(2)` from any other uid before a byte is written.
 *
 * `"loopback"` is the TCP listener the SPA uses and keeps every rule exactly as it was.
 */
export type Transport = "loopback" | "socket";

export type AuthorizeResult = { ok: true } | { ok: false; status: number; slug: ProblemSlug };

export interface AuthorizeOptions {
  routeClass: RouteClass;
  /** The port this request arrived on — used with the already-allowlisted `Host` to compute the
   * expected "self" Origin (`http://<host>:<port>`). Unused on the socket transport, which has
   * no port and no meaningful Host. */
  port: number;
  token: string | null;
  /** Defaults to `"loopback"` so every existing caller — and every hand-built test context —
   * keeps the browser-facing rules it has today. Only the socket listener opts out. */
  transport?: Transport;
}

function bearerOf(req: Request): string | null {
  const header = req.headers.get("Authorization");
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
}

/** Is this request's Origin present AND foreign — not `http://<Host>` for an allowlisted Host
 * (A3 §4)? A page on `glosa.localhost` is foreign to a request addressed to `127.0.0.1`, and the
 * reverse. Exported so the
 * route-lookup layer (http.ts) can apply the same "reject a foreign Origin" rule even on a path
 * with no matching route — a 404-vs-403 split by route existence would let a hostile page probe
 * for real routes (P1.3 review item 1). */
export function isForeignOrigin(req: Request, port: number): boolean {
  const origin = req.headers.get("Origin");
  return origin !== null && origin !== selfOriginFor(req.headers.get("Host"), port);
}

export function authorizeRequest(req: Request, opts: AuthorizeOptions): AuthorizeResult {
  const { routeClass, port, token, transport = "loopback" } = opts;

  // Navigation can't carry custom headers at all — Origin/Bearer checks are inapplicable by
  // construction (A3 §4).
  if (routeClass === "navigation") return { ok: true };

  const origin = req.headers.get("Origin");
  // On the socket, treat Origin as absent rather than trusting whatever a client happened to
  // send: the rules below exist to distinguish one browser origin from another, and there is no
  // browser here to distinguish. A client that sets `Origin` must not be able to fail a check
  // that means nothing on this transport, nor to pass one by asserting it.
  const foreign = transport === "socket" ? false : isForeignOrigin(req, port);

  if (routeClass === "tokenless-handshake") {
    // Reject only a present-and-foreign Origin; absent or self is fine (Bearer is the gate on
    // every other route — handshake has none to gate with).
    if (foreign) return { ok: false, status: 403, slug: "invalid-origin" };
    return { ok: true };
  }

  if (routeClass === "presentation-redeem") {
    // Same-origin only: Origin must be present and self. No Bearer — redemption is how the SPA
    // obtains the durable pairing token after a `p=` deep-link.
    if (origin === null || foreign) return { ok: false, status: 403, slug: "invalid-origin" };
    if (req.headers.get("Sec-Fetch-Site") === "cross-site") {
      return { ok: false, status: 403, slug: "invalid-origin" };
    }
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
  //
  // Both of those are CSRF defenses, and CSRF needs a browser to be tricked into making the
  // request. The socket has no browser, so "Origin must be present" would be a ceremony a local
  // client performs against nobody — which is exactly what it is today: every CLI call sets
  // `Origin` to the daemon's own base URL purely to satisfy this line. On the socket the Bearer
  // and the kernel's uid check are the gate.
  if (transport !== "socket") {
    if (origin === null || foreign) return { ok: false, status: 403, slug: "invalid-origin" };
    if (req.headers.get("Sec-Fetch-Site") === "cross-site") {
      return { ok: false, status: 403, slug: "invalid-origin" };
    }
  }
  return { ok: true };
}

// SPDX-License-Identifier: Apache-2.0
// P1.3 — exhaustive unit coverage for authorizeRequest (A3 §4's resolved table). Pure/hermetic:
// no I/O, no Bun.serve, just Request objects. This is where most of A3 §5's attack-table
// coverage lives — the integration suite (http.test.ts) only has to prove the pipeline wires
// this function in correctly, not re-derive every combination.
import { describe, expect, test } from "bun:test";
import { authorizeRequest, principalOf, principalOfRequest } from "../src/security/auth.ts";

const PORT = 4646;
const SELF_ORIGIN = `http://127.0.0.1:${PORT}`;
const FOREIGN_ORIGIN = "http://evil.example.com";
const TOKEN = "s3cr3t-token";

// Every real request reaching authorizeRequest already passed the Host allowlist, and the self
// Origin is derived from that Host — so fixtures carry one, like the wire does.
function req(init: { origin?: string; bearer?: string; secFetchSite?: string; host?: string } = {}): Request {
  const headers = new Headers({ Host: init.host ?? `127.0.0.1:${PORT}` });
  if (init.origin !== undefined) headers.set("Origin", init.origin);
  if (init.bearer !== undefined) headers.set("Authorization", `Bearer ${init.bearer}`);
  if (init.secFetchSite !== undefined) headers.set("Sec-Fetch-Site", init.secFetchSite);
  return new Request("http://127.0.0.1:4646/whatever", { headers });
}

describe("authorizeRequest — tokenless-handshake", () => {
  test("no Origin → allowed", () => {
    expect(authorizeRequest(req(), { routeClass: "tokenless-handshake", port: PORT, token: TOKEN })).toEqual({
      ok: true,
    });
  });

  test("self Origin → allowed", () => {
    const result = authorizeRequest(req({ origin: SELF_ORIGIN }), {
      routeClass: "tokenless-handshake",
      port: PORT,
      token: TOKEN,
    });
    expect(result).toEqual({ ok: true });
  });

  test("foreign Origin → 403 invalid-origin", () => {
    const result = authorizeRequest(req({ origin: FOREIGN_ORIGIN }), {
      routeClass: "tokenless-handshake",
      port: PORT,
      token: TOKEN,
    });
    expect(result).toEqual({ ok: false, status: 403, slug: "invalid-origin" });
  });

  test("no Bearer required — allowed even with a missing token file (null)", () => {
    expect(authorizeRequest(req(), { routeClass: "tokenless-handshake", port: PORT, token: null })).toEqual({
      ok: true,
    });
  });
});

describe("authorizeRequest — authed-read", () => {
  test("missing Bearer → 401, regardless of Origin", () => {
    expect(authorizeRequest(req(), { routeClass: "authed-read", port: PORT, token: TOKEN })).toEqual({
      ok: false,
      status: 401,
      slug: "unauthorized",
    });
    expect(
      authorizeRequest(req({ origin: FOREIGN_ORIGIN }), { routeClass: "authed-read", port: PORT, token: TOKEN }),
    ).toEqual({ ok: false, status: 401, slug: "unauthorized" }); // A3 §5 attack #7b
  });

  test("invalid Bearer → 401", () => {
    const result = authorizeRequest(req({ bearer: "wrong" }), { routeClass: "authed-read", port: PORT, token: TOKEN });
    expect(result).toEqual({ ok: false, status: 401, slug: "unauthorized" });
  });

  test("valid Bearer + no Origin → allowed", () => {
    const result = authorizeRequest(req({ bearer: TOKEN }), { routeClass: "authed-read", port: PORT, token: TOKEN });
    expect(result).toEqual({ ok: true });
  });

  test("valid Bearer + self Origin → allowed", () => {
    const result = authorizeRequest(req({ bearer: TOKEN, origin: SELF_ORIGIN }), {
      routeClass: "authed-read",
      port: PORT,
      token: TOKEN,
    });
    expect(result).toEqual({ ok: true });
  });

  test("valid Bearer + foreign Origin → 403 (foreign always rejected on reads too)", () => {
    const result = authorizeRequest(req({ bearer: TOKEN, origin: FOREIGN_ORIGIN }), {
      routeClass: "authed-read",
      port: PORT,
      token: TOKEN,
    });
    expect(result).toEqual({ ok: false, status: 403, slug: "invalid-origin" });
  });

  test("no token on disk (null) → any Bearer is invalid → 401", () => {
    const result = authorizeRequest(req({ bearer: "anything" }), {
      routeClass: "authed-read",
      port: PORT,
      token: null,
    });
    expect(result).toEqual({ ok: false, status: 401, slug: "unauthorized" });
  });
});

describe("authorizeRequest — state-changing", () => {
  test("missing Bearer → 401", () => {
    const result = authorizeRequest(req({ origin: SELF_ORIGIN }), {
      routeClass: "state-changing",
      port: PORT,
      token: TOKEN,
    });
    expect(result).toEqual({ ok: false, status: 401, slug: "unauthorized" });
  });

  test("valid Bearer + missing Origin → 403 (strict: absent is rejected here, unlike reads)", () => {
    const result = authorizeRequest(req({ bearer: TOKEN }), { routeClass: "state-changing", port: PORT, token: TOKEN });
    expect(result).toEqual({ ok: false, status: 403, slug: "invalid-origin" });
  });

  test("valid Bearer + foreign Origin → 403", () => {
    const result = authorizeRequest(req({ bearer: TOKEN, origin: FOREIGN_ORIGIN }), {
      routeClass: "state-changing",
      port: PORT,
      token: TOKEN,
    });
    expect(result).toEqual({ ok: false, status: 403, slug: "invalid-origin" });
  });

  test("valid Bearer + self Origin + Sec-Fetch-Site: cross-site → 403 (defense-in-depth)", () => {
    const result = authorizeRequest(req({ bearer: TOKEN, origin: SELF_ORIGIN, secFetchSite: "cross-site" }), {
      routeClass: "state-changing",
      port: PORT,
      token: TOKEN,
    });
    expect(result).toEqual({ ok: false, status: 403, slug: "invalid-origin" });
  });

  test("valid Bearer + self Origin + no/same-site Sec-Fetch-Site → allowed", () => {
    expect(
      authorizeRequest(req({ bearer: TOKEN, origin: SELF_ORIGIN }), {
        routeClass: "state-changing",
        port: PORT,
        token: TOKEN,
      }),
    ).toEqual({ ok: true });
    expect(
      authorizeRequest(req({ bearer: TOKEN, origin: SELF_ORIGIN, secFetchSite: "same-origin" }), {
        routeClass: "state-changing",
        port: PORT,
        token: TOKEN,
      }),
    ).toEqual({ ok: true });
  });
});

describe("authorizeRequest — navigation", () => {
  test("always allowed — no Origin/Bearer checks apply", () => {
    expect(authorizeRequest(req(), { routeClass: "navigation", port: PORT, token: TOKEN })).toEqual({ ok: true });
    expect(
      authorizeRequest(req({ origin: FOREIGN_ORIGIN }), { routeClass: "navigation", port: PORT, token: TOKEN }),
    ).toEqual({ ok: true });
    expect(authorizeRequest(req(), { routeClass: "navigation", port: PORT, token: null })).toEqual({ ok: true });
  });
});

describe("authorizeRequest — presentation-redeem", () => {
  test("self Origin, no Bearer → allowed", () => {
    expect(
      authorizeRequest(req({ origin: SELF_ORIGIN }), {
        routeClass: "presentation-redeem",
        port: PORT,
        token: TOKEN,
      }),
    ).toEqual({ ok: true });
  });

  test("missing Origin → 403", () => {
    expect(authorizeRequest(req(), { routeClass: "presentation-redeem", port: PORT, token: TOKEN })).toEqual({
      ok: false,
      status: 403,
      slug: "invalid-origin",
    });
  });

  test("foreign Origin → 403 even with a Bearer", () => {
    expect(
      authorizeRequest(req({ origin: FOREIGN_ORIGIN, bearer: TOKEN }), {
        routeClass: "presentation-redeem",
        port: PORT,
        token: TOKEN,
      }),
    ).toEqual({ ok: false, status: 403, slug: "invalid-origin" });
  });

  test("Sec-Fetch-Site: cross-site → 403", () => {
    expect(
      authorizeRequest(req({ origin: SELF_ORIGIN, secFetchSite: "cross-site" }), {
        routeClass: "presentation-redeem",
        port: PORT,
        token: TOKEN,
      }),
    ).toEqual({ ok: false, status: 403, slug: "invalid-origin" });
  });
});

describe("authorizeRequest — the second allowlisted Host (#159)", () => {
  const LOCALHOST_HOST = `glosa.localhost:${PORT}`;
  const LOCALHOST_ORIGIN = `http://glosa.localhost:${PORT}`;

  test("a page on glosa.localhost is self on a request addressed to glosa.localhost", () => {
    const result = authorizeRequest(req({ host: LOCALHOST_HOST, origin: LOCALHOST_ORIGIN, bearer: TOKEN }), {
      routeClass: "state-changing",
      port: PORT,
      token: TOKEN,
    });
    expect(result).toEqual({ ok: true });
  });

  test("Origin is bound to Host: a glosa.localhost page cannot speak on a 127.0.0.1 request", () => {
    const result = authorizeRequest(req({ origin: LOCALHOST_ORIGIN, bearer: TOKEN }), {
      routeClass: "state-changing",
      port: PORT,
      token: TOKEN,
    });
    expect(result).toEqual({ ok: false, status: 403, slug: "invalid-origin" });
  });

  test("…and the reverse: a 127.0.0.1 page cannot redeem on a glosa.localhost request", () => {
    const result = authorizeRequest(req({ host: LOCALHOST_HOST, origin: SELF_ORIGIN }), {
      routeClass: "presentation-redeem",
      port: PORT,
      token: TOKEN,
    });
    expect(result).toEqual({ ok: false, status: 403, slug: "invalid-origin" });
  });

  test("an unlisted Host yields no self Origin, so even a matching Origin is foreign", () => {
    const result = authorizeRequest(req({ host: `evil.localhost:${PORT}`, origin: `http://evil.localhost:${PORT}` }), {
      routeClass: "tokenless-handshake",
      port: PORT,
      token: TOKEN,
    });
    expect(result).toEqual({ ok: false, status: 403, slug: "invalid-origin" });
  });
});

// Issue #155 REQ-9: the principal is derived from the bearer, stable per token, distinct across
// tokens, and never the bearer itself.
describe("principalOf", () => {
  test("is stable for one token, 14 characters, and never contains the token", () => {
    const a = principalOf("secret-token-one");
    expect(a).toBe(principalOf("secret-token-one"));
    expect(a).toMatch(/^token:[0-9a-f]{8}$/);
    expect(a).toHaveLength(14);
    expect(a).not.toContain("secret");
  });

  test("differs per token", () => {
    expect(principalOf("secret-token-one")).not.toBe(principalOf("secret-token-two"));
  });

  test("is `unknown` when there is no bearer", () => {
    expect(principalOf(null)).toBe("unknown");
    expect(principalOfRequest(new Request("http://127.0.0.1/"))).toBe("unknown");
    expect(principalOfRequest(new Request("http://127.0.0.1/", { headers: { Authorization: "Bearer x-token" } }))).toBe(
      principalOf("x-token"),
    );
  });
});

// SPDX-License-Identifier: Apache-2.0
// P1.3 — exhaustive unit coverage for authorizeRequest (A3 §4's resolved table). Pure/hermetic:
// no I/O, no Bun.serve, just Request objects. This is where most of A3 §5's attack-table
// coverage lives — the integration suite (http.test.ts) only has to prove the pipeline wires
// this function in correctly, not re-derive every combination.
import { describe, expect, test } from "bun:test";
import { authorizeRequest } from "../src/auth.ts";

const PORT = 4646;
const SELF_ORIGIN = `http://127.0.0.1:${PORT}`;
const FOREIGN_ORIGIN = "http://evil.example.com";
const TOKEN = "s3cr3t-token";

function req(init: { origin?: string; bearer?: string; secFetchSite?: string } = {}): Request {
  const headers = new Headers();
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

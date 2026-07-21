// Review follow-up (P4.1 adversarial review) — csp.ts's own docstring claims "one module owns
// both exact strings", but only the class-F CSP had an exact-string assertion anywhere in the
// suite (http.test.ts, over a real subprocess); the SPA/API CSP was only ever `.toContain`-spot-
// checked. This file pins BOTH headers verbatim against A3 §1 (class-F) and A3 §3 (SPA), so the
// "exact string" claim is actually enforced symmetrically.
import { describe, expect, test } from "bun:test";
import { classFCspHeaders, spaCspHeaders } from "../src/csp.ts";

describe("classFCspHeaders — A3 §1 exact string", () => {
  test("matches the spec string verbatim for a given SPA port", () => {
    const headers = classFCspHeaders(4646);
    expect(headers["Content-Security-Policy"]).toBe(
      "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data:; font-src 'self' data:; connect-src 'none'; form-action 'none'; " +
        "frame-ancestors 'self' http://127.0.0.1:4646; base-uri 'none'; object-src 'none'; " +
        "sandbox allow-scripts;",
    );
    expect(headers["Referrer-Policy"]).toBe("no-referrer");
  });

  test("the SPA port is interpolated into frame-ancestors, not hardcoded", () => {
    const headers = classFCspHeaders(9999);
    expect(headers["Content-Security-Policy"]).toContain("frame-ancestors 'self' http://127.0.0.1:9999;");
  });
});

describe("spaCspHeaders — A3 §3 exact string", () => {
  test("matches the spec string verbatim for a given class-F port", () => {
    const headers = spaCspHeaders(4647);
    expect(headers["Content-Security-Policy"]).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data:; font-src 'self'; connect-src 'self'; " +
        "frame-src http://127.0.0.1:4647; frame-ancestors 'none'; base-uri 'none'; " +
        "form-action 'self'; object-src 'none';",
    );
    expect(headers["Referrer-Policy"]).toBe("no-referrer");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
  });

  test("the class-F port is interpolated into frame-src, not hardcoded", () => {
    const headers = spaCspHeaders(1234);
    expect(headers["Content-Security-Policy"]).toContain("frame-src http://127.0.0.1:1234;");
  });
});

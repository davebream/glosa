// @glosa/daemon — CSP header sets for glosa's two origins (A3 §1 class-F, A3 §3 SPA/API). One
// module owns both exact strings so a header value can never drift between the routes that
// attach it — grep here, not in every handler, when the policy needs to change.

/** Attached to every response from the SPA/API listener (GLOSA_PORT). Refuses to ever be
 * framed; only the class-F origin may be embedded as a frame-src. */
export function spaCspHeaders(classFPort: number): Record<string, string> {
  return {
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data:; font-src 'self'; connect-src 'self'; " +
      `frame-src http://127.0.0.1:${classFPort}; frame-ancestors 'none'; base-uri 'none'; ` +
      "form-action 'self'; object-src 'none';",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
}

/** Attached to every response from the class-F listener (GLOSA_CLASSF_PORT). Network-locked
 * (`connect-src`/`form-action 'none'`) and `sandbox allow-scripts` in the header itself — not
 * just the iframe attribute — so even a direct top-level navigation to a capability URL gets an
 * opaque origin with no ambient network access (A3 §1). */
export function classFCspHeaders(spaPort: number): Record<string, string> {
  return {
    "Content-Security-Policy":
      "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data:; font-src 'self' data:; connect-src 'none'; form-action 'none'; " +
      `frame-ancestors 'self' http://127.0.0.1:${spaPort}; base-uri 'none'; object-src 'none'; ` +
      "sandbox allow-scripts;",
    "Referrer-Policy": "no-referrer",
  };
}

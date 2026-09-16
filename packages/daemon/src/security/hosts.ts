// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — the Host allowlist from A3 §4 Rule 1. Exactly two literal names reach the
// SPA/API listener: the loopback IP and `glosa.localhost` (#159). The second is safe only because
// nothing outside the machine can answer for it: browsers resolve `*.localhost` internally and the
// macOS system resolver synthesizes a loopback answer (RFC 6761), so a hostile page has no DNS
// record to re-point. The class-F listener keeps the IP alone.

/** Hostnames the SPA/API listener accepts. The CLI and plugin address the daemon by IP;
 * `glosa open` links browsers to `glosa.localhost`. */
export const SPA_HOSTNAMES = ["127.0.0.1", "glosa.localhost"] as const;

/** The only hostname the class-F listener accepts. Capability URLs are minted against it. */
export const CLASSF_HOSTNAME = "127.0.0.1";

/** Does this request's `Host` header literally equal `<allowed hostname>:<port>`? No case folding,
 * no trailing dot, no subdomains: anything a browser did not send verbatim is a mismatch. */
export function isAllowedHost(host: string | null, port: number, hostnames: readonly string[]): boolean {
  return host !== null && hostnames.some((hostname) => host === `${hostname}:${port}`);
}

/** The `http://<host>` origin a same-origin request to this listener carries, derived from a Host
 * header that already passed the allowlist. Binding Origin to Host (not to "any allowed name")
 * keeps a page on one name from speaking for the other. */
export function selfOriginFor(host: string | null, port: number): string | null {
  return isAllowedHost(host, port, SPA_HOSTNAMES) ? `http://${host}` : null;
}

// @glosa/daemon — wire protocol version. See docs/appendices/A5-daemon-architecture.md §F13.
//
// This is the daemon *lifecycle* handshake version (protocol_version in the lock file and
// GET /api/handshake), not the SPA-facing contract_version from A1 §5.1 — those are two
// separate compatibility checks that happen to share a route; P1.3 owns the SPA contract.
export const PROTOCOL_VERSION = "1.0";

export interface ProtocolVersion {
  major: number;
  minor: number;
}

/** Sentinel for a malformed version string. `protocolCompatible` special-cases this — see
 * below — so it's compatible with nothing, including another malformed version. */
const INVALID_VERSION: ProtocolVersion = { major: -1, minor: -1 };

function isNonNegativeInt(part: string | undefined): part is string {
  return part !== undefined && /^\d+$/.test(part);
}

/** Strict `<major>.<minor>` — exactly two non-negative-integer components. Anything else
 * (empty string, a bare "1", a 3rd "1.2.3" component, non-numeric parts) is malformed and
 * parses to a sentinel that `protocolCompatible` always rejects. */
export function parseProtocolVersion(version: string): ProtocolVersion {
  const parts = version.split(".");
  if (parts.length !== 2) return { ...INVALID_VERSION };
  const [majorRaw, minorRaw] = parts;
  if (!isNonNegativeInt(majorRaw) || !isNonNegativeInt(minorRaw)) return { ...INVALID_VERSION };
  return { major: Number(majorRaw), minor: Number(minorRaw) };
}

/** Same major, client-minor ≤ daemon-minor (A5 §F13 compat rule). A malformed version on
 * either side is compatible with nothing — even a malformed version equal to itself. */
export function protocolCompatible(clientVersion: string, daemonVersion: string): boolean {
  const client = parseProtocolVersion(clientVersion);
  const daemon = parseProtocolVersion(daemonVersion);
  if (client.major < 0 || daemon.major < 0) return false;
  return client.major === daemon.major && client.minor <= daemon.minor;
}

// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — SPA-facing contract-version gate (A1 §3). Deliberately separate from
// protocol.ts's daemon-lifecycle handshake version — see
// protocol.ts's header comment for why the two compatibility checks are kept apart despite the
// coincidence.
import { APP_VERSION } from "./build-id.ts";
import { parseProtocolVersion } from "./protocol.ts";

/** `contract_version` in the handshake body and the version `X-Contract-Version` is compared
 * against. API v1.3 adds artifact-scoped approval requests and revision-bound verdicts without changing
 * daemon lifecycle compatibility, so this is deliberately independent of `PROTOCOL_VERSION`. */
export const CONTRACT_VERSION = "1.3";
export const DAEMON_VERSION = APP_VERSION;

export type ContractCheck = { status: "ok" } | { status: "stale-minor" } | { status: "mismatch" };

/**
 * Per A1 §3, a missing header and an unparseable/partial one (`""`, `"1"`, `"1.0.0"`,
 * `"abc"`, `"2abc"`, `"x.y"` — anything
 * `parseProtocolVersion` can't turn into a real `{major,minor}`) get the SAME lenient treatment —
 * "unknown minor, same major assumed", never rejected on that basis alone. Only a well-formed
 * version whose MAJOR differs from `PROTOCOL_VERSION`'s major is a *proven* breaking mismatch;
 * ambiguity about what the client meant is not grounds to 409 it (A1 §3's stated intent for any
 * non-SPA caller applies just as much to a caller that sent something we can't parse as to one
 * that sent nothing).
 */
export function checkContractVersion(headerValue: string | null): ContractCheck {
  if (headerValue === null) return { status: "ok" };
  const client = parseProtocolVersion(headerValue);
  if (client.major < 0) return { status: "ok" }; // unparseable — lenient, same as missing
  const daemon = parseProtocolVersion(CONTRACT_VERSION);
  if (client.major !== daemon.major) return { status: "mismatch" };
  if (client.minor !== daemon.minor) return { status: "stale-minor" };
  return { status: "ok" };
}

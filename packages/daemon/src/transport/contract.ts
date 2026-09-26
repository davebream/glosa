// SPDX-License-Identifier: Apache-2.0
// @glosa/daemon — SPA-facing contract-version gate (A1 §3). Deliberately separate from
// protocol.ts's daemon-lifecycle handshake version — see
// protocol.ts's header comment for why the two compatibility checks are kept apart despite the
// coincidence.
import { APP_VERSION } from "../lifecycle/build-id.ts";
import { parseProtocolVersion } from "../lifecycle/protocol.ts";

/** `contract_version` in the handshake body and the version `X-Contract-Version` is compared
 * against. API v1.3 adds artifact-scoped approval requests and revision-bound verdicts without changing
 * daemon lifecycle compatibility, so this is deliberately independent of `PROTOCOL_VERSION`.
 * v1.4 (issue #80) additively adds `GET /w/:slug/wiring`, `POST /w/:slug/init`, and the
 * `wiring`/`orphaned_state` fields on `GET /api/status` — N/N-1 safe per A1 §3.
 * v1.5 (issue #95) adds provider-owned connect prompts to each `/api/status` workspace.
 * v1.6 adds workspace-labelled composite drains for unbound ancestor sessions.
 * v1.7 adds recoverable registration/binding and typed unknown-session errors.
 * v1.8 (issue #156) adds `POST /api/workspaces/forget`, the `lifecycle:"forgetting"` field on
 * `GET /api/status` workspace rows, and the `workspace-forgetting`/`forget-blocked` error slugs;
 * the held-review repair additionally adds the preview/commit `member_fingerprint` field and the
 * `forget-stale-preview` error slug on the same route, and a registration-less `status` row for a
 * forget operation whose target registration has already been fully removed — all additive, N/N-1
 * safe per A1 §3.
 * v1.9 (issue #206) adds a terminal `event: superseded` frame on `GET /api/sessions/:id/stream`
 * (written only when `register` displaces the connection; every other close cause stays plain EOF)
 * and the read-only `GET /api/sessions/:id/stream/status` ownership probe — additive, N/N-1 safe
 * per A1 §3.
 * v1.10 (issue #153 Part 2) adds the opt-in held `GET /w/:slug/watch` read over `external_edit`,
 * its two Origin-gated acknowledgement routes (`POST /api/sessions/:id/watch/transport-ack` and
 * `POST /api/sessions/:id/watch/ack`), and the `via:"watch"` delivery-attempt vocabulary member —
 * additive, N/N-1 safe per A1 §3; an N-1 client simply never calls the new routes.
 * v1.11 adds starred workspaces: `GET /api/stars`, `POST /api/stars`, `POST /api/stars/:id/open`
 * and `POST /api/stars/:id/unstar`, the `kind` field on `GET /api/workspaces` rows, and the
 * `star-not-directory`/`star-folder-missing` error slugs — additive, N/N-1 safe per A1 §3.
 * v1.12 (issue #250) adds the always-present `valid_utf8` field on class-R artifact responses and
 * the `not-utf8` error slug on `PUT /w/:slug/artifacts/:path` — additive, N/N-1 safe per A1 §3; an
 * N-1 client that never reads the field simply keeps offering Edit and has its save refused by the
 * daemon instead of by the pane.
 * v1.13 (issue #310) adds `POST /api/workspaces/attention-withdraw`, through which a session takes
 * back its own open question once the call waiting on the answer has been cancelled — additive,
 * N/N-1 safe per A1 §3; an N-1 client simply never calls it, and the question stays open exactly
 * as it does today.
 * v1.14 adds the provider-neutral dictation status and foreground session-grant routes.
 * v1.15 (issue #219) adds the optional `live_updates` diagnosis to `/api/status` workspace rows —
 * additive and N/N-1 safe; an N-1 client ignores it and an N-1 daemon simply omits it.
 * v1.16 (issue #306) adds `push:{connected,transport}` to `/api/status` session rows and the
 * `remedy` sentence to a `lifecycle:"forgetting"` workspace row. `push` carries the same shape
 * `GET /api/sessions/:id/stream/status` already returns, read from `SessionPushRegistry` alone;
 * it is a per-session delivery-transport fact and never feeds the workspace-connection
 * derivation, which stays `workspace_binding` + liveness (A1 §5.2b). `remedy` is present only
 * beside `lifecycle`, so a JSON client can print the resume command the human output already
 * prints instead of composing its own. Additive, N/N-1 safe: an N-1 daemon omits both, and an
 * absent `push` means "cannot say", never "not live".
 *
 * v1.17 (issue #155) adds per-resource claims: `POST/GET /api/workspaces/claims`,
 * `POST /api/workspaces/claims/:id/{renew,release}`, `POST /w/:slug/claims/:id/release`; an optional
 * `fence` on `POST /api/workspaces/resolve` and `replayed:true` on a replayed resolve; `fence`,
 * `expires_at` and `renewed` on apply-begin (a same-session repeat now renews with 200); and the
 * claim problem slugs (`claim-held`, `claim-revoked`, `claim-expired`, `claim-superseded`,
 * `entry-resolved`, `no-claim`, `claim-limit`) carrying their facts as RFC 9457 extension members.
 * apply-begin's conflict moves from `lease-conflict` to `claim-held`; an N-1 CLI that matched only
 * `lease-conflict` falls back to its generic exit 8, and this CLI accepts both.
 *
 * v1.19 (issue #389) makes attention daemon-wide for the desktop shell's Dock badge and
 * notifications: `GET /api/workspaces` rows gain `attention_count` (the attention tray's own
 * `pending_count` for that workspace) and `decision_count` (its chats with a decision waiting on the
 * person); every `GET /w/:slug/stream` also emits `attention_changed {slug}` for any workspace's
 * attention change; `chats_changed` gains `slugs` (and `slug` when exactly one). Additive, N/N-1
 * safe: an N-1 client ignores the fields and the new frame, and an N-1 daemon omits them. */
export const CONTRACT_VERSION = "1.19";
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

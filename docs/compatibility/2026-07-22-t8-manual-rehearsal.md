# T8 manual compatibility rehearsal — 2026-07-22

## Decision

| Decision | Result | Reason |
|---|---|---|
| T8 result | **FAIL** | The real-session pass found two integration defects, and the private rehearsal did not have an honest source-to-render regeneration command. Required manual scenarios therefore remain incomplete. |
| Overall v1 readiness | **BLOCKED** | T8 is not certified. Token rotation and revocation remain an independent release blocker tracked by issue #20. |

This is a failed rehearsal report, not a compatibility certificate. Issue #19 must remain open until a complete clean rerun passes and the maintainer signs off.

## Rehearsal boundary

The rehearsal used an ignored private workspace containing maintainer-selected source and rendered artifacts under neutral filenames. The session started from a different working directory and was explicitly bound to the artifact workspace. No private artifact, transcript, pairing token, canonical path, or private metadata is included here.

The run used generic `WorkspaceMetadataDescriptor` v1 only. No external integration package or workflow logic was installed in glosa.

## Environment

| Component | Observed value |
|---|---|
| macOS | 26.2, build 25C56 |
| Architecture | arm64 |
| Bun | 1.2.7 |
| Git | 2.52.0 |
| glosa | 0.1.0-alpha.0 |
| glosa build ID after fixes | `0.1.0-alpha.0-6a38eab4e7396b11` |
| API contract | 1.1 |
| Workspace metadata contract | 1 |
| Claude Code | 2.1.217 |
| Session model reported by Claude Code | Sonnet 5 with high effort · Claude Max |
| Browser | Google Chrome 150.0.7871.181 |

## Deterministic gate

The manual pass began only after the deterministic gate was green. After the two integration defects found by the rehearsal were fixed, the complete gate was run again from the post-fix behavior tree.

| Command | Actual result |
|---|---|
| `bun run typecheck` | PASS |
| `bun test` — run 1 | PASS — 1,150 tests, 0 failures, 10,589 expectations across 108 files |
| `bun test` — run 2 | PASS — 1,150 tests, 0 failures, 10,589 expectations across 108 files |
| `bun run audit:licenses` | PASS |
| `bun run package:check` | PASS — package smoke checked 104 files |

## Expected and actual results

| Scenario | Expected | Actual | Result |
|---|---|---|---|
| Metadata registration and restart | Descriptor validates before persistence, survives restart, rehydrates the adapter, and refreshes clients. | Descriptor v1 registered two neutral artifacts, survived daemon restart, and restored the declared class, order, derived-from edge, and manifest component. | PASS |
| Explicit session binding | A real session started elsewhere binds to the artifact workspace without cwd guessing. | Claude Code SessionStart registered the session; `glosa session bind` then reported the artifact workspace as its explicit binding. | PASS |
| Verbatim class-F resolution | A verbatim chunk resolves to its exact source range and is delivered actionably. | The annotation resolved to one exact source range in the declared source artifact. The journal recorded `entry_created`, then `delivery_attempt{via:userprompt,outcome:presented,reason:initial}`. | PASS for resolution and delivery |
| Verbatim apply and regeneration | The session takes an apply lease, edits source, resolves the lease, and glosa observes the regenerated rendered artifact with session attribution. | No real private renderer command was available. The session correctly refused to hand-edit the rendered artifact or fabricate provenance. No source or rendered file was changed. | **FAIL** |
| Transformed class-F annotation | A transformed chunk becomes descriptor-derived pipeline feedback and does not edit source. | Not run after the verbatim scenario blocked the pass. | NOT RUN |
| Parked annotation drain | An entry created without a live session drains after later registration and explicit binding. | Not run. | NOT RUN |
| Human editor provenance | A browser edit creates immutable `human_edit`, a journal transition, and a `human` shadow checkpoint. | Not run. | NOT RUN |
| Attention badge and tray | Badge and inline tray expose honest state; keyboard flow reaches `seen → done`; `request-review --wait` receives a structured review outcome. | Not run. | NOT RUN |
| Conversation mirror and terminal fallback | The live transcript mirrors; unavailable mirror states fail softly; fallback delivery remains actionable. | The real session received the annotation through the UserPromptSubmit fallback. The SPA mirror and fail-soft UI were not fully observed. | PARTIAL |
| Optional Channels | Attempt activation; if unavailable, accept only when a hook or MCP fallback succeeds and is audited. | Claude Code reported the development Channel unavailable. UserPromptSubmit fallback succeeded and its presentation attempt was journaled. | PASS for required fallback; Channel unavailable |
| Browser class-F sandbox/CSP | A local inert probe renders through the separate origin without external egress. | Initial browser opening failed before iframe creation because capability minting returned `403 invalid-origin`. The code fix was verified by HTTP and deterministic security tests, but the browser scenario was not completed end to end in this run. | **FAIL** |

## Defects found and mitigations

### 1. Browser capability mint returned `403 invalid-origin`

Capability issuance was implemented as a state-changing `GET`. A normal same-origin browser GET does not reliably include an `Origin` header, while glosa correctly requires that header on state-changing routes. The real SPA therefore failed before it could create the class-F iframe.

Mitigation implemented in this branch:

- changed capability issuance to `POST /w/:slug/capability/:artifactPath`;
- kept missing and foreign origins rejected;
- updated the SPA data-access call, daemon route, API appendix, and focused tests;
- verified a real loopback mint returned HTTP 200 after restart;
- reran the complete security and package gates successfully.

A clean browser rerun is still required; deterministic and HTTP verification do not replace human observation of the iframe, sandbox, bridge, selection, and inert probe.

### 2. MCP session binding could fail after a long model turn

The registry lease expires after 60 seconds without a hook boundary. A real MCP invocation proved that the session was active, but `glosa_session_bind` attempted the bind before refreshing the existing lease and received `unknown or not-live session`.

Mitigation implemented in this branch:

- the MCP bind tool now heartbeats the already-registered session before binding;
- unknown session IDs remain unknown, so an MCP caller cannot recreate state lost across a daemon restart;
- the ordinary CLI still refuses stale sessions and cannot resurrect an ended agent;
- focused MCP tests and typecheck pass.

### 3. No honest private regeneration command

The rehearsal metadata declared the source/render relationship, but the private workspace did not include a real command capable of regenerating the rendered artifact from the source. Editing both files by hand would have fabricated pipeline behavior and invalidated provenance evidence.

Required mitigation for the next run: the maintainer must select either the real private renderer command or an approved deterministic private transformer before the session starts. The command and expected output relationship remain private; this report records only whether regeneration occurred.

### 4. Development restart invalidated live session state

Fixing defect 1 restarted the isolated daemon. Session bindings are intentionally session-scoped and not persisted, so the active Claude Code session was no longer registered. Its later Stop hook failed softly with a 404 rather than inventing a session.

Required mitigation for the next run: freeze the candidate build before starting the clean rehearsal. If a restart is deliberately exercised, allow the external integration to re-register before continuing.

## Channel and fallback status

| Transport | Status | Evidence |
|---|---|---|
| Claude Code Channel | Unavailable | Activation was attempted and Claude Code reported that the development Channel was unavailable. |
| UserPromptSubmit hook | PASS | Journal recorded a presented delivery attempt for the verbatim annotation. |
| MCP pull | Available, not the presenting transport | Pull returned no duplicate after UserPromptSubmit had already reserved and presented the entry. |

The unavailable Channel is acceptable for compatibility only because the audited hook fallback succeeded. It does not turn the overall rehearsal into a pass.

## Sanitization check

- Private rehearsal files remained under ignored local state.
- No source/rendered content, transcript, token, session identifier, or canonical private path is included in this report.
- The candidate implementation contains only generic metadata, adapter, session, attention, and transport contracts.
- No external runtime call, telemetry path, or terminal-multiplexer coupling was added to glosa.

## Required clean rerun

The next attempt must use a frozen build and a preselected private regeneration command, then complete every NOT RUN or PARTIAL row above. It must also re-observe the fixed class-F browser flow in a real browser and exercise the full attention `seen → done` path with `request-review --wait`.

## Maintainer review and sign-off

**Status: pending.**

The agent has not signed on the maintainer's behalf. The maintainer must review the rendered report and supply an explicit name/date/result after a complete passing rerun. Until then, this report remains a failed rehearsal record and is not a v1 approval.

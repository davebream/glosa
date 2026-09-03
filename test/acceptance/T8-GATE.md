# T8 compatibility gate

T8 has two ordered parts: deterministic suites, then a maintainer-reviewed manual rehearsal. A red
deterministic gate aborts the manual pass. Passing T8 certifies glosa's generic compatibility contract;
overall v1 readiness may remain blocked by an independent release issue.

## 1. Deterministic gate

Run from the repository root:

```bash
bun run typecheck
bun run test:acceptance
bun test
bun test
bun run audit:licenses
bun run package:check
```

`bun run test:acceptance` runs the acceptance suites and nothing else. It is the acceptance bar;
a green full `bun test` is not. Both full runs must still pass — the second catches order
dependence and state leakage that a subset run cannot see.

### 1.1 The named suites

`docs/requirements.md` §5 names seven mandatory deterministic suites. `AGENTS.md` summarizes the
same gate but lists six, omitting `delivery`; where the two disagree, `requirements.md` governs,
so `delivery` is in the gate.

| Suite | Requirement clause (`docs/requirements.md` §5) |
|---|---|
| `fault` | storage/fault (kill daemon at each write step → one legal recovered state) |
| `concurrency` | concurrency |
| `delivery` | delivery (channels on/off, asyncRewake rearm, boundary, parked/resumed) |
| `security` | browser security (the A3 §5 attacks) |
| `anchor` | anchor corpus (Polish combining chars, md markup, duplicate quotes, stale hashes, transformed HTML) |
| `transcript` | transcript suite |
| `explicit-binding-topology` | explicit-binding topology (agent cwd differs from the artifact workspace and routing still succeeds) |

### 1.2 Suite membership

Membership is declared once, in `scripts/acceptance-suites.ts`, which is what the runner executes.
The table below is a copy for reading, and `test/acceptance/gate-membership.test.ts` keeps it
honest: it fails if a listed file stops existing, if a named suite empties out, or if this table
and the runner disagree by so much as one path. A renamed suite breaks the gate loudly instead of
dropping out of it.

| Suite | File |
|---|---|
| `fault` | `packages/daemon/test/bus/journal.test.ts` |
| `fault` | `packages/daemon/test/bus/inbox.test.ts` |
| `fault` | `packages/daemon/test/bus/replay.test.ts` |
| `fault` | `packages/daemon/test/bus/lifecycle.test.ts` |
| `fault` | `packages/daemon/test/bus/reconcile-fault.test.ts` |
| `fault` | `packages/daemon/test/bus/reconcile-fault-lease.test.ts` |
| `fault` | `packages/daemon/test/bus/real-daemon-fault.test.ts` |
| `concurrency` | `packages/daemon/test/bus/concurrency.test.ts` |
| `concurrency` | `packages/daemon/test/bus/mutex.test.ts` |
| `concurrency` | `packages/daemon/test/bus/approval-uniqueness.test.ts` |
| `concurrency` | `packages/daemon/test/concurrency-real-subprocess.test.ts` |
| `concurrency` | `packages/daemon/test/git/lease.test.ts` |
| `delivery` | `packages/daemon/test/bus/delivery-reservation.test.ts` |
| `delivery` | `packages/daemon/test/delivery/presentation.test.ts` |
| `delivery` | `packages/daemon/test/agent-provider/push-registry.test.ts` |
| `delivery` | `packages/providers/claude-code/test/provider.test.ts` |
| `delivery` | `packages/providers/claude-code/test/rewake.test.ts` |
| `delivery` | `packages/providers/claude-code/test/delivery-journal.test.ts` |
| `delivery` | `packages/providers/codex/test/provider.test.ts` |
| `delivery` | `test/agent-provider-conformance.test.ts` |
| `security` | `test/acceptance/security-attack-matrix.test.ts` |
| `security` | `packages/daemon/test/auth.test.ts` |
| `security` | `packages/daemon/test/csp.test.ts` |
| `security` | `packages/daemon/test/confine-path.test.ts` |
| `security` | `packages/daemon/test/matcher/symlinks.test.ts` |
| `security` | `packages/daemon/test/presentation-token.test.ts` |
| `security` | `packages/daemon/test/token-lifecycle.test.ts` |
| `security` | `test/acceptance/browser-security-real-engine.test.ts` |
| `anchor` | `packages/daemon/test/anchoring/class-f.test.ts` |
| `anchor` | `packages/daemon/test/anchoring/class-r-basic.test.ts` |
| `anchor` | `packages/daemon/test/anchoring/class-r-never-feedback.test.ts` |
| `anchor` | `packages/daemon/test/anchoring/duplicates.test.ts` |
| `anchor` | `packages/daemon/test/anchoring/markup-boundaries.test.ts` |
| `anchor` | `packages/daemon/test/anchoring/nfc-nfd.test.ts` |
| `anchor` | `packages/daemon/test/anchoring/stale-hashes.test.ts` |
| `anchor` | `packages/daemon/test/anchoring/totality.test.ts` |
| `anchor` | `packages/daemon/test/anchoring/whitespace-fold.test.ts` |
| `transcript` | `packages/daemon/test/transcript/normalize.test.ts` |
| `transcript` | `packages/daemon/test/transcript/stream.test.ts` |
| `transcript` | `packages/spa/test/conversation.test.ts` |
| `explicit-binding-topology` | `packages/daemon/test/adapters/adapter-topology.test.ts` |
| `explicit-binding-topology` | `packages/daemon/test/registry/session-registry.test.ts` |
| `explicit-binding-topology` | `packages/daemon/test/sessions-routes.test.ts` |
| `explicit-binding-topology` | `packages/daemon/test/provider-topology-real-subprocess.test.ts` |

### 1.3 Fidelity layers and residual manual boundaries

The deterministic gate now crosses the three process boundaries that previously existed only in
the manual rehearsal: a real production daemon process is killed through an injected composition
seam and restarted, a real Chromium engine enforces the class-F CSP, and the production Codex
provider participates in cross-directory routing over real HTTP. The attended rehearsal remains
mandatory for live vendor sessions, Safari/browser interaction, and private real artifacts. This
section states both layers so neither is mistaken for the other.

| Suite | What §5 asks for | What the deterministic gate proves |
|---|---|---|
| `fault` | daemon killed at each write step, one legal recovered state | exhaustive byte-offset journal truncation plus a real production daemon process, using an injected composition seam, SIGKILLed/restarted at five boundaries from inbox temp fsync through `entry_created` journal fsync |
| `security` | the A3 §5 browser attacks | attacks #1/#2 run in installed Chromium against production class-F serving and prove opaque storage, `connect-src`/`img-src` violations, plus zero loopback fetch/WebSocket/image/form requests; the remaining attacks retain their function/socket tests |
| `explicit-binding-topology` | agent cwd differs from the artifact workspace and routing still succeeds | a real daemon with the production Codex provider queues from a different cwd, is SIGKILLed/restarted, re-registers/binds, then Stop drains and acknowledges the durable message |

**`fault`.** The byte sweep remains exhaustive within its torn-journal model. The real-process layer
uses an explicit injected composition dependency available only to its test daemon entrypoint; the
packaged CLI exposes no fault flag, environment switch, route, or config. It covers temp-file fsync,
immutable link publication, directory durability, journal write, and journal fsync, then proves a
fresh daemon reclaims the stale lock, reconciles to zero-or-one legal entry, removes inert temp state,
and accepts another durable write. These are five representative durability checkpoints, not every
syscall or byte offset. SIGKILL is not a machine power cut, so it cannot prove kernel page cache
survival, and this focused layer does not kill system Git inside every possible shadow-repo syscall.
The exhaustive byte/lease and shadow-git suites remain the complementary deterministic evidence.

**`security`.** Attacks #4 (symlink escape), #5 (leading-dash and control-character paths), #6
(injected HTML) and #7(a)(b) (foreign-origin handshake, missing Bearer) exercise real functions
against a real filesystem or real `Request` objects. Attacks #1/#2 additionally launch an installed
Chromium ≥111 with a throwaway profile against the production class-F listener; removing the CSP
sandbox makes that test fail because storage becomes available. The gate fails clearly if no
supported Chromium is installed; it never silently skips or downloads one. Safari remains a
supported runtime browser, but Safari execution and interaction-heavy #3/#7(c)/#7(d) framing checks
remain attended rehearsal evidence. For attack #2, Chromium reports `connect-src` and `img-src`
violations. The remote form is attempted and reaches neither loopback nor navigation: the CSP
`sandbox` omits `allow-forms`, so Chromium blocks it before evaluating `form-action` and emits no
`form-action` violation event; the test separately asserts the production header still contains
`form-action 'none'` as defense in depth. Attack #8 combines real HTTP token lifecycle coverage with
the SPA's tab-storage behavior.

**`explicit-binding-topology`.** The lower-level in-process adapter test remains because it isolates
the routing decision. The real-process layer composes the actual `CodexProvider` in the normal daemon,
crosses localhost HTTP, binds an agent cwd unrelated to the artifact workspace, persists the
provider's `gate/attempted` result, kills the daemon before presentation, and proves Stop presents
the exact message after restart. It is a controlled provider integration test, not a live Codex
session. Real Claude/Codex hook hosts, models, Channels negotiation, credentials, and conversation
UI remain explicit attended rehearsal work; the deterministic test never invokes a vendor CLI or
network and never installs hooks/MCP.

Beyond the named suites, these coverage groups must hold across the full run:

| Group | Required evidence |
|---|---|
| Storage | fault boundaries, torn journal recovery, immutable inbox, atomic metadata rollback/restart |
| Concurrency | duplicate mutations, simultaneous sessions, journal ordering, parked drain |
| Security | auth/Origin/Host, confinement, symlinks, class-F CSP and local inert probe |
| Metadata | schema/limits/conflicts, adapter hydration, API/CLI/MCP parity, SPA invalidation |
| Anchoring | neutral class-R/F fixtures, verbatim range, transformed feedback, stale/ambiguous cases |
| Attention | delivered→seen→done, action outcomes, `--wait`, badge/tray keyboard and failure recovery |
| Providers | Channels on/off, acknowledgement split, hook/MCP fallback, async rearm, explicit cross-directory binding |
| Transcript | partial/corrupt/unknown events, resume/clear/compact, capped tool results, fail-soft UI |
| Composer | exact-session isolation, idempotent retry/restart, picker, draft recovery, presented-only clearing |

Before the manual pass, scan every tracked file for private producer/domain names and private absolute
paths. Rehearsal data is allowed only under ignored `.context/`; no private rehearsal material or
private historical notes may enter the tracked tree.

## 2. Private rehearsal workspace

Create an ignored workspace below `.context/`. Copy the maintainer-selected source and rendered
artifacts; do not link to or mutate originals. Use neutral filenames in the copy. Add only:

- one private `WorkspaceMetadataDescriptor` v1;
- one manifest v1 with one verbatim and one transformed chunk;
- representative `data-chunk` markers needed to select those regions.

No rehearsal artifact, descriptor, manifest, transcript, token, canonical path, or source text may be
tracked by git or copied into the report.

## 3. Isolated runtime

Use a rehearsal-specific `GLOSA_HOME` below `.context/` and non-default loopback ports. Start the daemon,
then start a real Claude Code session from a working directory different from the artifact workspace.
Register the descriptor and explicitly bind the live session using the public CLI or MCP contract.

Record without secrets:

- macOS version and architecture;
- Bun, Git, glosa version/build id;
- Claude Code version and actual session-reported model;
- browser name/version;
- API contract and metadata descriptor versions.

Attempt optional Channels using the documented activation when available. If activation is unavailable
or rejected, record that result and require a successful Stop/UserPromptSubmit or MCP fallback with
journaled delivery attempts.

## 4. Scenarios

| Scenario | Pass condition |
|---|---|
| Human editor save | immutable `human_edit`, journal-derived state, shadow history attributed `human` |
| Verbatim class F | exact source range, actionable delivery, apply lease, source edit, session attribution, regenerated-render pickup |
| Transformed class F | descriptor-derived pipeline target; no source edit |
| Parked delivery | entry parks without a live binding and drains after registration/bind |
| Attention | badge/tray, seen, action-aware response, structured `request-review --wait` completion |
| Conversation | live mirror; Claude and Codex boundary delivery from different cwd values; restart between queue and presentation; browser clears only after `presented` |
| Delivery | Channel succeeds when available, otherwise audited hook/MCP fallback succeeds |
| Browser security | real browser renders locally; class-F sandbox/CSP blocks only a local inert probe attempt |

The SPA must not auto-switch workspaces or steal focus. The tray must support keyboard open/action,
Escape focus restoration, honest status labels, responsive layout, and response input preservation on a
failed mutation.

## 5. Report and decision

Write `docs/compatibility/YYYY-MM-DD-t8-manual-rehearsal.md` with:

- environment/version table;
- expected versus actual result for every scenario;
- sanitized evidence references and delivery attempts;
- failures, mitigations, and Channel/fallback status;
- separate **T8 result** and **overall v1 readiness** decisions;
- **maintainer sign-off: pending** until the human reviews the rendered report.

Any failed scenario produces a FAIL report and keeps the compatibility issue open. The agent never
signs on the maintainer's behalf. Preview the rendered report for human review before committing it.

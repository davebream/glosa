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

### 1.3 Accepted fidelity gaps

Three of the named suites sit a tier below the letter of `docs/requirements.md` §5. They are
accepted for the alpha, not closed. What covers them is the manual rehearsal in §2–§4, and this
section is the record of that; an accepted gap nobody wrote down is the failure mode this gate
exists to avoid.

| Suite | What §5 asks for | What the deterministic gate proves instead |
|---|---|---|
| `fault` | daemon killed at each write step, one legal recovered state | a real journal truncated at every byte offset of every record, replayed in-process through `reconcileWorkspace`; no process is killed |
| `security` | the A3 §5 browser attacks | four of the eight run against real code; four assert only the CSP string glosa emits, with no user agent present to honor it |
| `explicit-binding-topology` | agent cwd differs from the artifact workspace and routing still succeeds | the production route handler called in-process with real registries and a neutral fixture adapter; no daemon process, no real provider |

**`fault`.** The byte sweep is exhaustive within its model and worth keeping. Its model is a
truncated file, so it cannot see an unflushed page cache, an inbox temp file whose `rename` is
interrupted, or a shadow-git repo left mid-commit. Nothing in `packages/*/src` offers a
fault-injection point, so killing a daemon at a chosen write step is not constructible today
without adding one. Note also that the headers of `packages/daemon/test/bus/reconcile-fault.test.ts`
and `packages/daemon/test/bus/reconcile-fault-lease.test.ts` describe the method as killing the
process at every write boundary. They truncate a file. Trust the code, not the comment.

**`security`.** Attacks #4 (symlink escape), #5 (leading-dash and control-character paths), #6
(injected HTML) and #7(a)(b) (foreign-origin handshake, missing Bearer) exercise real functions
against a real filesystem or real `Request` objects. Attacks #1, #2, #7(c) and #7(d) assert
substrings of a Content-Security-Policy header. Attack #1 is the clearest case: A3 §5 asks for
"assert storage empty + fetch throws", and the test asserts that the CSP string contains
`sandbox allow-scripts`. No test in this repo launches a browser engine — `happy-dom` is a pure-JS
DOM simulator, chosen because the no-build-step, no-compiled-addons invariant rules a real engine
out of `bun test`. That makes the browser half a limit of the deterministic approach rather than
missing work, and it is why the Browser security scenario in §4 is manual. Attack #8's
rotate/revoke half is unimplemented and says so in the test.

**`explicit-binding-topology`.** `packages/daemon/test/adapters/adapter-topology.test.ts` drives
`createApiFetch` with real `WorkspaceIndex`, `SessionRegistry` and `WorkspaceBusRegistry` instances
over three real temporary directories, so the cwd-versus-workspace divergence is genuine and the
routing decision is the production one. The adapter is a domain-neutral fixture rather than
`packages/providers/claude-code` or `packages/providers/codex`, and nothing crosses a socket. The
one binding test that does use a real daemon subprocess, `packages/cli/test/api-integration.test.ts`,
registers with `cwd` equal to the workspace, so it does not exercise the divergence. Real daemon
plus real provider plus divergent cwd exists only in §3–§4.

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

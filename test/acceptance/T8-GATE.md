# T8 compatibility gate

T8 has two ordered parts: deterministic suites, then a maintainer-reviewed manual rehearsal. A red
deterministic gate aborts the manual pass. Passing T8 certifies glosa's generic compatibility contract;
overall v1 readiness may remain blocked by an independent release issue.

## 1. Deterministic gate

Run from the repository root:

```bash
bun run typecheck
bun test
bun test
bun run audit:licenses
bun run package:check
```

Both full test runs must pass. The second run catches order dependence and state leakage.

Required coverage groups:

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

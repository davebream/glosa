# glosa — build plan

Ordered, dependency-respecting task list derived from `requirements.md §5`, split per the appendices.
`⬜` todo · `🔄` in progress · `✅` done+green+committed · `⛔` blocked-needs-Dawid (see OVERNIGHT-LOG).
The orchestrator ticks these as it goes; this file is the source of truth for progress. Each task names
its **governing appendix**, its **acceptance test**, and a **CC (correctness-critical)** flag — CC tasks
get a mandatory adversarial-review + fault-test pass before commit.

> Scaffold is pre-seeded (root `package.json`, `tsconfig`, a green smoke test, empty `packages/*`).
> `bun test` is green from task 1. Don't re-create scaffold; extend it.

## Phase 1 — walking skeleton
- ✅ **P1.1 monorepo scaffold** — flesh out `packages/{daemon,spa,providers/claude-code,providers/codex,adapters/jethro,cli}` with per-package `package.json`/entrypoints; root scripts (`bun test`, typecheck); lefthook or a pre-commit test gate. _Appendix: A6 · Accept: `bun test` + typecheck green across workspaces · CC: no_
- ✅ **P1.2 daemon lifecycle + lock** — detached `glosa __daemon`, `~/.glosa/daemon.lock` `{instance_id,pid,port,protocol_version,…}`, `bind→O_EXCL` CAS, stale-lock reclaim, port discovery, SIGTERM graceful, ignore SIGHUP/SIGINT. _Appendix: A5 §F13 · Accept: two concurrent spawns → exactly one daemon, other exits 0; stale-lock reclaim; port from lock · CC: **yes**_
- ✅ **P1.3 HTTP skeleton + auth** — two listeners (4646 SPA/API, 4647 class-F), `Host` literal check, Bearer on API, route-class Origin table, `/api/handshake` with `X-Contract-Version`, `confinePath()` realpath guard. _Appendix: A1 + A3 §3–4 · Accept: handshake works; the A3 §5 attack suite (Host/Origin/traversal) passes · CC: **yes**_
- ⬜ **P1.4 pairing + SPA shell** — token mint (0600), `#t=` fragment scrub via replaceState → sessionStorage, three handshake screens (down/unpaired/mismatch), empty SPA shell served. _Appendix: A3 §3 + A6 · Accept: E2E pair + load shell; token never in history/localStorage · CC: no_

## Phase 2 — file bus & provenance (the correctness core)
- ⬜ **P2.1 journal-as-truth** — immutable inbox entries (temp→fsync→rename), append-only journal (single O_APPEND fd, short-write loop, fsync-before-ACK), ULID+idem idempotent replay, torn-tail truncate, quarantine, 5-step startup reconcile. _Appendix: A4 §F04 · Accept: kill-at-each-write-boundary fault suite → one legal recovered state; replay twice = identical · CC: **yes**_
- ⬜ **P2.2 picomatch matcher** — one `resolveMatchedFiles()` LIST (NFC, case-sensitive, no symlinks, 2MiB threshold with grow/shrink events) feeding watcher+sidebar+git pathspec. _Appendix: A4 §F20 · Accept: cross-consumer conformance fixtures; threshold-crossing events · CC: no_
- ⬜ **P2.3 shadow-git + apply-lease** — argv-safe git (`--git-dir/--work-tree`, isolated config, `--`), deterministic init + `refs/heads/glosa` baseline, one git mutex/workspace, index-lock reclaim; `apply-begin`/`resolve` pre/post checkpoints → proven `session:<id>` attribution; unproven = `unknown`. _Appendix: A4 §F05/§F21 · Accept: attribution correctness (proven vs unknown), concurrent-checkpoint mutex, idempotent no-op checkpoint · CC: **yes**_
- ⬜ **P2.4 registry + workspace index** — session registry (lease/heartbeat liveness, no PID), global `~/.glosa/workspaces.json` (daemon-only writer, atomic), slug + collision-lengthening; routing precedence (explicit binding > cwd), parked-entry drain. _Appendix: A5 §F19 + A2 §F08 · Accept: two-sessions-one-cwd routing, parked→drain, concurrent registration no-loss · CC: **yes**_
- ⬜ **P2.5 lifecycle state machine** — transition table (A5 §F23), delivery_attempt as a separate axis, per-event single writer, guarded idempotent replay. _Appendix: A5 §F23 · Accept: every legal transition + illegal-ignored on replay; re-nudge doesn't change status · CC: **yes**_

## Phase 3 — API surface & SPA viewers
- ⬜ **P3.1 full HTTP route catalog** — the eleven `/w/<slug>/…` routes, status codes, 1MiB cap, contract-version behavior. _Appendix: A1 · Accept: per-route schema tests + version mismatch → 409 · CC: no_
- ⬜ **P3.2 streaming SSE** — fetch-streaming (not EventSource), journal-offset cursor, `Last-Event-ID` reconnect replay, 15s heartbeat + `idleTimeout:0`. _Appendix: A1 §F17 · Accept: reconnect across daemon restart loses no events · CC: **yes**_
- ⬜ **P3.3 class-R viewer + 3 modes** — markdown-it + `data-line`; Preview/Annotate/Edit; idiomorph morph; annotation → W3C record → POST; edit-in-glosa attributed `human`. _Appendix: A5 §F10 + A6 · Accept: E2E annotate live-updating md (anchors correct, morph preserves scroll); edit attributed human · CC: no_
- ⬜ **P3.4 anchoring resolver** — total `resolve()→source_range|pipeline_feedback|orphaned`; fixed normalization; class-R quote-in-stamped-range else block_range else orphaned (never pipeline_feedback). _Appendix: A5 §F10/§F11 · Accept: anchor corpus (Polish combining, md markup, duplicate quotes, stale hashes) · CC: **yes**_
- ⬜ **P3.5 diff pane + full history** — diff2html; compare any two checkpoints; `restore` with dirty guard (new by:human checkpoint). _Appendix: A6 §F31(3.B) · Accept: DST day-boundary, dirty refusal, restore-then-diff-clean · CC: no_

## Phase 4 — class-F, conversation mirror, providers, adapter
- ⬜ **P4.1 class-F viewer** — separate 4647 origin, directory-scoped capability (600s, multi-request), CSP `sandbox allow-scripts`+`connect-src 'none'`, MessageChannel nonce bridge, source-preserving render; derived-from Edit→source. _Appendix: A3 §1–2 + A1 §7 + A5 §F11 · Accept: full A3 §5 attack suite; real speech-notes fixture renders within tolerance, JS runs, network blocked · CC: **yes**_
- ⬜ **P4.2 conversation viewer** — normalized `TranscriptEvent` (don't parse raw JSONL), partial-line buffer, unknown-event quarantine, resume/clear/compact, tool-result caps; out-of-band composer; fail-soft. _Appendix: A2 §F16 · Accept: fixtures incl. partial/unknown/corrupt → graceful degrade · CC: no_
- ⬜ **P4.3 Claude Code provider** — channels (`--dangerously-load-development-channels server:glosa`) + asyncRewake rearm (per-session lease) + boundary hooks + transcript mirror; `glosa init` hook/MCP merge (ownership manifest, backups, uninstall). _Appendix: A2 + A6 · Accept: each capability delivers; channels-off fallback delivers; asyncRewake rearms ≥3 sequential entries · CC: **yes**_
- ⬜ **P4.4 provider interface + Codex provider** — the `AgentProvider` interface (R7); **first research + pin the Codex hook/gate/transcript contract (T2a)**, then implement gate+boundary+MCP-pull. _Appendix: requirements R7/T2a · Accept: interface satisfied by both providers; Codex contract documented · CC: no (but log the Codex research)_
- ⬜ **P4.5 jethro adapter** — **(SUPERSEDED by P6.1 — do NOT build a jethro-specific package inside glosa; when you reach this task, build the generic fixture-protocol version described in P6.1 instead.)** recognize plugin-data path, session binding from `session_history`, stage ordering, derived-from edge, class-F manifest resolution. _Appendix: requirements R7 · Accept: against fixture copies of the real session + a synthetic post-#314 state + speech-notes fixture · CC: no_

## Phase 5 — CLI, release gate
- ⬜ **P5.1 CLI surface** — `open/init/resolve/apply-begin/request-review/doctor(12 checks)/status` + `--json` + stable exit codes. _Appendix: A6 · Accept: per-command exit-code + `--json` envelope tests · CC: no_
- ⬜ **P5.2 deterministic acceptance suites (the real release gate)** — fault, concurrency, security (A3 §5), anchor corpus, transcript, actual-jethro-topology. _Appendix: requirements §5 T8 · Accept: all suites green · CC: **yes**_
- ⛔ **P5.3 format-sermon companion diffs (HITL)** — BLOCKED-NEEDS-DAWID by construction (touches `~/.claude/skills/format-sermon/` outside the repo, needs human approval). Log it; do NOT edit that skill unattended. Prepare the proposed diffs as a doc for Dawid to review.
- ⛔ **P5.4 manual rehearsal (T8)** — BLOCKED-NEEDS-DAWID (needs a real Claude session + Dawid's eyes). Leave for morning.

## Phase 6 — adapter boundary correction (added 2026-07-21 by Dawid; supersedes P4.5)
- ⬜ **P6.1 generic adapter-registration protocol — NO jethro code in this repo** — glosa exposes a **generic** protocol by which *external* code registers domain facts at runtime (session→artifact binding, derived-from edges, data-path recognition, class-F manifest resolution). Prove it end-to-end with a **neutral in-repo fixture adapter only**, and delete the `packages/adapters/jethro` stub. The **real jethro integration** (plugin-data path, `session_history` binding, sermon-stage edges) is implemented in the **jethro repo** via jethro's own CLI + a hook + skills — it is OUT OF SCOPE for glosa; leave a short handoff note in OVERNIGHT-LOG.md describing the jethro-side work so a jethro issue can be filed in the morning. Dependency arrow points jethro→glosa, never the reverse; enforces invariant #1 (generic core, zero domain in this repo). **This supersedes P4.5.** _Appendix: requirements R7 + A4 (derived-from) + A5 · Accept: fixture adapter registers purely through the public protocol; core runs green with **zero** adapters loaded; no `jethro` identifier anywhere under `packages/daemon` or `packages/spa`; protocol documented · CC: **yes**_

## Notes for the orchestrator
- Do Phase 1 → 6 in order; within a phase, respect intra-task deps. A CC task is not done until its adversarial-review + fault tests pass.
- P5.3/P5.4 are pre-marked ⛔ — never edit the format-sermon skill or run the live rehearsal unattended; surface them for morning.
- If you finish everything unblocked, write the top SUMMARY in OVERNIGHT-LOG.md and let the goal clear.

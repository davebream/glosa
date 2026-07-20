# glosa — orchestrator prompt (for an Opus session)

## How to use
1. `cd ~/code/glosa`, start a **new Opus** Claude Code session.
2. Run the `/goal` line below (scopes the Stop hook to the current phase so the session
   doesn't quit mid-phase, and auto-clears when the phase is done).
3. Paste the **Orchestrator prompt** as your first message.
4. When it stops and reports at the phase boundary, review, then either paste
   "continue: next phase" or adjust. Re-set `/goal` for the new phase if you like.

## /goal line (phase 1)
```
/goal docs/BUILD-PLAN.md exists and is committed, AND every task in its "Phase 1" section is implemented with its acceptance tests written and passing and each committed to main. Not done until Phase 1 tests are green and committed.
```

---

## Orchestrator prompt (paste this)

You are the **orchestrator** for building **glosa** (repo: `~/code/glosa`). You are running on
Opus; you **plan, review, decide, integrate, and commit** — you do NOT hand-write heavy
implementation yourself. **Every substantial implementation or test-writing task is delegated to a
Sonnet subagent** via the Agent tool with `model: sonnet`, scoped tightly. Keep your own context
lean by delegating heavy reads/writes and asking subagents for compact summaries + file lists, not
pasted code.

### The spec is done — read it, don't re-invent it
- **`docs/requirements.md`** is the authoritative build input. Read it fully first.
- **`docs/appendices/A1–A6`** are the normative deep contracts (api, claude-code, security,
  file-bus, daemon, cli). When you implement a subsystem, its appendix IS the spec. **Precedence:
  where `requirements.md` and an appendix disagree, `requirements.md` wins.** When a contract is
  ambiguous, the appendix wins over your own judgment — do not invent; if truly unspecified, note it
  and ask me.
- `docs/decisions.md` explains *why*. `CLAUDE.md` lists the non-negotiable invariants.

### Non-negotiable invariants (a violation is a stop-and-fix)
1. Generic core; domain lives in `packages/adapters/*`, agent specifics in `packages/providers/*`.
   The core runs with zero adapters.
2. The journal is the single source of truth; inbox entries immutable; status by replay; no
   cross-file atomic writes (A4).
3. Honest provenance: `session:<id>` only via a proven apply-lease; glosa-editor writes are `human`;
   everything else `unknown`, never falsely `human` (A4 §F05).
4. **No cmux in the product.** glosa is cmux-decoupled: SPA in any browser over `http://127.0.0.1`;
   delivery via each agent's hooks/MCP (A2/R4). (cmux is fine as YOUR tool — see below — just never
   a glosa dependency.)
5. Local-first, zero telemetry/external runtime calls; class-F egress CSP-blocked; scrub
   `ANTHROPIC_API_KEY` from every spawned child env.
6. The SPA reaches the daemon through ONE data-access module (A6/R6).

### Stack (fixed): Bun + TypeScript, no build step (`bun run` direct), no heavy frontend framework
(server-rendered HTML + vanilla ES modules), macOS-only. Monorepo
`packages/{daemon, spa, providers/claude-code, providers/codex, adapters/jethro, cli}`.

### PHASE 0 — setup & probes (do this yourself, cheaply)
- Probe env: `bun --version` (need ≥1.2.7), `git --version`, `git status`. Confirm `docs/` present.
- Read `docs/requirements.md` in full; skim each appendix's headings so you know where each contract
  lives (don't read all appendices deeply yet — pull the relevant one when a task needs it).
- **cmux is available** as your terminal (`cmux tree` to orient). Use it for real terminal work:
  spawn a dedicated surface to run the dev server or a long test (`cmux new-workspace --name glosa-dev
  --cwd ~/code/glosa --command "..."` or `cmux new-split right --focus false` then `cmux send`), and
  READ output/logs with `cmux read-screen --surface surface:<n> --scrollback`. **Close any surface or
  workspace you spawn once it's no longer needed** (`cmux close-surface --surface surface:<n>`) — leave
  the environment as you found it; never target my own session surface (`cmux identify` first).

### PHASE 1 — plan
- Produce **`docs/BUILD-PLAN.md`**: an ordered, checkbox task list derived from `requirements.md §5`
  (T0–T8), splitting the big ones per the appendices (e.g. T1 → daemon-lifecycle / file-bus+journal /
  registry+workspace-index / API+auth). Group into **Phases** (Phase 1 = T0 scaffold + a walking
  skeleton: daemon singleton + `/api/handshake` + auth skeleton, with tests green). For each task
  record: scope, **governing appendix**, acceptance test, model (`sonnet` default; flag
  correctness-critical tasks — journal/replay, daemon races, security, anchoring, SSE resync — for an
  extra adversarial review pass), and dependencies.
- Optional: sanity-check the plan with a `critic` subagent before committing it.
- Commit `docs/BUILD-PLAN.md`.

### PHASE 2… — build loop (one task at a time, dependency order)
For each task:
1. **Delegate to a Sonnet subagent** (`Agent`, `model: sonnet`): give it the task scope, its
   acceptance test, the path to the ONE governing appendix (not all docs), the relevant invariants,
   and: *"implement the code AND its tests; follow the appendix exactly; return a ≤15-line summary +
   the file list; do NOT commit."* Prefer a `general-purpose` subagent for build.
2. **Review yourself** (Opus judgment): does it honor the appendix and invariants? Are the tests real
   — do they exercise the failure/edge cases the appendix demands (fault injection, concurrency,
   security, anchoring edge cases), not just the happy path? **Green tests are not the bar; the hard
   invariants are.**
3. **Correctness-critical tasks** (journal durability, apply-lease, daemon lifecycle races, the
   security origin/CSP/bridge, anchoring resolution, SSE resync): dispatch a **second Sonnet subagent
   as an adversarial reviewer** (or a `code-reviewer`/`critic` agent) tasked to break it and to add
   the missing fault/security/concurrency tests. Fold in what it finds.
4. **Run the tests** (a cmux surface for anything long-running; plain `bun test` otherwise). Green →
   **commit** straight to `main` (personal repo, direct-to-main) with a clear message, and tick the
   plan checkbox (edit `BUILD-PLAN.md`). Red → send the subagent back with the exact failure; iterate.
5. Next task.

### Checkpoint & stop (respect the /goal scope)
When this phase's tasks are green and committed, **STOP and report**: what was built, test status,
open questions/decisions you need from me, and the exact next phase. **Do not silently roll into the
next phase** — I'll review and kick the next one. If you hit a genuine spec gap or a decision that's
mine (scope, a trade-off the docs don't settle), stop and ask rather than guessing.

### Reuse (lightweight, not full kombajn)
Use individual subagents freely: `general-purpose` (build), `code-reviewer` / `kombajn-dev:critic`
(review/adversarial), `Plan` (if you want a second planning opinion). Do **not** invoke the full
`/implement` autonomous pipeline — you are the loop.

### Discipline reminders
- Heavy work → Sonnet subagents; you orchestrate. One appendix per subagent; compact returns.
- Commit per green increment; keep `BUILD-PLAN.md` checkboxes current as the source of progress.
- Close cmux surfaces you open. Never mention AI/tooling in commit messages.
- The real acceptance bar is T8's deterministic suites (fault/concurrency/security/anchor/topology) —
  build toward those, not toward green happy-path CI.

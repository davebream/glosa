# glosa — overnight orchestrator prompt (for an Opus session)

> **Archived:** This procedure records how the completed v1 build was run. Do not execute or resume
> this loop. Current work comes from accepted GitHub issues linked by [`ROADMAP.md`](../../../ROADMAP.md).

Runs **unattended overnight**. No human is awake — the loop keeps building autonomously, reasons out
its own decisions (via a debate subagent), **logs** everything, never blocks the whole night on one
task, keeps `main` always green, hands off to a fresh session when context fills, and leaves a morning
report. Runs on Claude Max 20x → **Sonnet subagent usage is generous; be lavish with review/
verification subagents.**

## How to launch (order matters)
1. `cd ~/code/glosa`, start a **new Opus** session.
2. **Paste the Orchestrator prompt FIRST** (below). Let it run Phase 0 (probes) and confirm it has read
   the spec + `docs/archive/v1-build/BUILD-PLAN.md` and started the loop.
3. **Then run the `/goal` line** (within the first minute — it'll be busy). Order matters: the `/goal`
   text acts as an immediate directive, so the full prompt must already be in context before you set it.
4. Go to sleep. In the morning read `docs/archive/v1-build/OVERNIGHT-LOG.md` + `git log`.

## /goal line
```
/goal Keep executing docs/archive/v1-build/BUILD-PLAN.md for glosa v1 autonomously in order: every ⬜ task implemented with real (fault/edge, not happy-path) tests passing and committed to main, ✅-ticked, and OVERNIGHT-LOG.md updated. Not done while any unblocked ⬜ task remains. Only clear when every task is ✅ done-green-committed OR ⛔ logged in OVERNIGHT-LOG.md as blocked-needs-Dawid with the reason. Hand off to a fresh session before context exhausts rather than degrading.
```

---

## Orchestrator prompt (paste this)

You are the **overnight orchestrator** building **glosa** (repo: `~/code/glosa`), on Opus,
**unattended — I am asleep.** You plan, review, decide, integrate, commit; you do NOT hand-write heavy
implementation. **Every substantial implementation or test task goes to a Sonnet subagent** (`Agent`,
`model: sonnet`), tightly scoped. Usage is generous — **use review/verification subagents liberally**;
thoroughness beats token thrift tonight because no human catches a bad pass before morning.

### The spec + plan are done — execute, don't re-invent
- **`docs/requirements.md`** = authoritative build input. **`docs/archive/v1-build/BUILD-PLAN.md`** = the reviewed,
  ordered task list (checkboxes) — **your worklist and progress source of truth.** Work its ⬜ tasks in
  order. The scaffold is pre-seeded and `bun test` is already green — extend, don't recreate.
- **`docs/appendices/A1–A6`** = normative deep contracts; the appendix named on a task IS its spec.
  **Precedence: `requirements.md` > appendix > your judgment.** Pull the ONE appendix a task needs;
  don't deep-read all six up front. `docs/decisions.md` = why. `CLAUDE.md` = invariants.

### Non-negotiable invariants (violation = stop-and-fix)
1. Generic core; domain in `packages/adapters/*`, agent specifics in `packages/providers/*`; core runs with zero adapters.
2. Journal is the single source of truth; inbox entries immutable; status by replay; no cross-file atomic writes (A4).
3. Honest provenance: `session:<id>` only via a proven apply-lease; glosa-editor writes `human`; else `unknown`, never falsely `human` (A4 §F05).
4. **No cmux in the product** (SPA in any browser over `http://127.0.0.1`; delivery via each agent's hooks/MCP). cmux is fine as YOUR tool only.
5. Local-first, zero telemetry/external runtime calls; class-F egress CSP-blocked; scrub `ANTHROPIC_API_KEY` from every spawned child env.
6. SPA reaches the daemon through ONE data-access module (A6/R6).

Stack (fixed): Bun + TypeScript, no build step, no heavy frontend framework, macOS-only. Monorepo `packages/{daemon,spa,providers/claude-code,providers/codex,adapters/jethro,cli}`.

### Durable memory (you WILL be compacted — survive it)
`docs/archive/v1-build/BUILD-PLAN.md` (checkboxes) + `docs/archive/v1-build/OVERNIGHT-LOG.md` (running narrative) are your external
memory. After any compaction or whenever unsure: re-read both, then continue from the next ⬜. Never
trust in-context memory over these files. Keep both current — they're how you and I know the state.

### PHASE 0 — probes (do yourself, cheaply)
- `bun --version` (≥1.2.7), `git status`, confirm `bun test` green. Read `requirements.md` fully; read
  `BUILD-PLAN.md`; skim appendix headings. Create `docs/archive/v1-build/OVERNIGHT-LOG.md` (header + start appending).
- **cmux is your terminal** (`cmux tree` to orient; `cmux identify` to learn your own surface — never
  target it). Use a spawned surface for a long-running dev server; prefer plain `bun test` in Bash for
  test gating. **Close surfaces you spawn** when done. (cmux is also how you hand off — see below.)

### THE LOOP — execute BUILD-PLAN.md ⬜ tasks in order
For each task:
1. **Delegate to a Sonnet subagent** (`general-purpose`, `model: sonnet`): task scope + acceptance test
   + path to the ONE governing appendix + relevant invariants + *"implement code AND real tests (the
   failure/edge cases the appendix demands, not happy-path); follow the appendix exactly; return a
   ≤15-line summary + file list; do NOT commit."*
2. **Review yourself** (Opus): honors appendix + invariants? Tests real, not theater?
3. **Adversarial verification** (this is the missing human — be generous): a second Sonnet subagent
   (`code-reviewer` and/or `kombajn-dev:critic`) to try to break it and ADD missing fault/concurrency/
   security/anchoring tests. **Mandatory for every `CC: yes` task**; do it for others when cheap.
4. **Gate on green**: `bun test` (+ `bun run typecheck`). **Commit only if green** → straight to `main`,
   clear message, tick the ✅ box in BUILD-PLAN.md, append an OVERNIGHT-LOG.md entry (task, built, tests,
   any decision + why, files). Red → send the subagent back with the exact failure; iterate.
5. Next ⬜.

### Autonomous decisions (no one is awake)
- **Small/clear calls**: make them yourself, consistent with invariants + appendices, and log under
  "Decisions made" in OVERNIGHT-LOG.md. Don't wait.
- **Genuine decisions the docs don't settle** (a real trade-off, an ambiguous contract, competing
  approaches): **run `kombajn-dev:consult` in debate mode** (it spins up subagents to argue the options
  and returns a reasoned verdict). Adopt the verdict, log the decision + the reasoning. Use this instead
  of a snap guess whenever the choice is non-trivial.
- **Never block the night on one task.** If a task can't go green after ~3 honest attempts, or it needs
  a decision only I can make (irreversible / scope-changing / a real spec contradiction consult can't
  resolve): do NOT spin and do NOT leave `main` broken. Omit its incomplete code (or land it behind a
  clearly-marked `test.skip` with a `// BLOCKED:` note that keeps the suite green), mark it ⛔ in
  BUILD-PLAN.md, log it under "Blocked — needs Dawid" with what you tried, and move to the next unblocked ⬜.
- **`main` always green + runnable.** Never commit red. Never force-push, rewrite history, or delete
  things you didn't create. Frequent small green commits > big risky ones.
- **Pre-marked ⛔ tasks** (format-sermon companion diffs; the manual rehearsal): do NOT do these
  unattended — they touch files outside the repo / need a live Claude session and my eyes. Prepare
  proposals as docs and leave them for morning.

### CONTEXT HANDOFF — hand to a fresh session before you degrade
A single session can't run all night. **Hand off proactively** — trigger when: you get any context/
compaction warning, OR you've completed ~6–8 committed tasks since this session started, OR you notice
your own responses degrading. Don't wait to actually run out. Handoff steps:
1. Make sure BUILD-PLAN.md checkboxes + OVERNIGHT-LOG.md are fully current and committed.
2. Write `.claude/session.md` yourself (the `pause` skill is user-invoke-only, so write it directly): a
   crisp handoff for a fresh instance — branch, last commits, exactly which ⬜ is next, any in-flight
   state, open blockers. (Gitignored; that's fine.)
3. Spawn a fresh session in a new cmux surface and drive it (sanitize sends — cmux `send` treats literal
   `\n`/`\r` as Enter, key is `ctrl+c` not `C-c`):
   ```
   cmux new-split down --focus false            # note the surface:<n> it prints
   cmux send --surface surface:<n> "cd ~/code/glosa && ccs base --dangerously-skip-permissions"
   cmux send-key --surface surface:<n> Enter
   # wait for the session to boot: poll `cmux read-screen --surface surface:<n>` until the prompt is ready
   # arm persistence FIRST (no operator to time it), then bootstrap:
   cmux send --surface surface:<n> "<the /goal line verbatim, single line>"
   cmux send-key --surface surface:<n> Enter
   cmux send --surface surface:<n> "Resume the glosa overnight build. Read docs/archive/v1-build/orchestrator-prompt.md, docs/archive/v1-build/BUILD-PLAN.md, docs/archive/v1-build/OVERNIGHT-LOG.md, and .claude/session.md, then continue the autonomous loop from the next ⬜ task. I am asleep — do not ask me anything; make/log decisions per the prompt."
   cmux send-key --surface surface:<n> Enter
   ```
   (Note: the fresh session gets full instructions from the files it's told to read; the `restore` skill
   is interactive so we don't use it — the one-line bootstrap above is the non-interactive equivalent.)
4. Verify the new session started working (`cmux read-screen` shows it reading files / dispatching), log
   the handoff in OVERNIGHT-LOG.md, then **close YOUR surfaces and stop.** The new session carries on.
   If you cannot confirm the new session took over, do NOT stop — keep working in this session and log
   that the handoff failed (degrade gracefully rather than dropping the baton).

### Morning report
Keep OVERNIGHT-LOG.md as a running narrative: per-task entries, a "Decisions made" section, a "Blocked —
needs Dawid" section, and — when the goal finally clears — a top **SUMMARY** (what's built, overall test
status, what's blocked, recommended next steps).

### Discipline
- Heavy work → Sonnet subagents; you orchestrate. One appendix per subagent; compact returns to stay lean.
- Reuse individual subagents freely (`general-purpose` build, `code-reviewer`/`kombajn-dev:critic` review,
  `kombajn-dev:consult` debate for decisions). Do NOT invoke the `/implement` autonomous pipeline — you are the loop.
- Commit per green increment; BUILD-PLAN.md = progress truth; re-read after compaction. Close cmux
  surfaces you open. Never mention AI/tooling in commit messages.
- Real acceptance bar = the deterministic suites (fault/concurrency/security/anchor/topology), not green
  happy-path CI. Fewer subsystems built *correctly and adversarially verified* beats all of them shallow.
